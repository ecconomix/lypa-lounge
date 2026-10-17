import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { getPlatformProxy } from 'wrangler'
import worker from '../worker/index.ts'

let platform
let env

before(async () => {
  // Ephemeral, local D1: never touches development data or remote bindings.
  platform = await getPlatformProxy({ persist: false, remoteBindings: false })
  env = platform.env
  const migration = await readFile(
    new URL('../migrations/0001_create_reservations.sql', import.meta.url),
    'utf8',
  )
  for (const sql of migration
    .replace(/--[^\n]*/g, '')
    .split(';')
    .filter((part) => part.trim())) {
    await env.DB.prepare(sql).run()
  }
  // Deliberately insert out of order, with rows outside both range boundaries.
  const rows = [
    ['last', '2026-11-17', '20:00', '21:00', 'active', null],
    ['late', '2026-10-20', '18:00', '21:00', 'active', 'День народження'],
    ['cancelled', '2026-10-20', '08:00', '09:00', 'cancelled', null],
    ['after', '2026-11-18', '12:00', '15:00', 'active', null],
    ['first', '2026-10-18', '12:00', '15:00', 'active', null],
    ['early', '2026-10-20', '12:00', '15:00', 'active', null],
    ['before', '2026-10-17', '12:00', '15:00', 'active', null],
  ]
  for (const [id, date, start, end, status, description] of rows) {
    await env.DB.prepare(
      `INSERT INTO reservations
       (id, date, start_time, end_time, status, description, name_or_apartment, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        date,
        start,
        end,
        status,
        description,
        'Квартира 12',
        `secret-${id}`,
      )
      .run()
  }
})

after(async () => {
  await platform?.dispose()
})

function request(query, method = 'GET', bindings = env) {
  return worker.fetch(
    new Request(`http://localhost/api/availability${query}`, { method }),
    bindings,
  )
}

const invalidError = {
  error: { code: 'INVALID_DATE_RANGE', message: 'Invalid date range' },
}

test('31-day range includes boundaries, sorts active rows, and exposes only public fields', async () => {
  const response = await request('?from=2026-10-18&to=2026-11-17')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('Content-Type'), /application\/json/)
  const { reservations } = await response.json()
  assert.deepEqual(
    reservations.map(({ id }) => id),
    ['first', 'early', 'late', 'last'],
  )
  for (const reservation of reservations) {
    assert.deepEqual(Object.keys(reservation).sort(), [
      'date',
      'description',
      'endTime',
      'id',
      'nameOrApartment',
      'startTime',
    ])
  }
  assert.deepEqual(reservations[2], {
    id: 'late',
    date: '2026-10-20',
    startTime: '18:00',
    endTime: '21:00',
    nameOrApartment: 'Квартира 12',
    description: 'День народження',
  })
  assert.equal(reservations[0].description, null)
})

test('single-day range returns that day only', async () => {
  const response = await request('?from=2026-10-20&to=2026-10-20')
  assert.equal(response.status, 200)
  assert.deepEqual(
    (await response.json()).reservations.map(({ id }) => id),
    ['early', 'late'],
  )
})

for (const [from, to] of [
  ['2020-01-01', '2020-01-31'], // Past dates are allowed.
  ['2026-03-15', '2026-04-14'], // Spring DST transition.
  ['2027-10-01', '2027-10-31'], // Autumn DST transition.
  ['2028-02-01', '2028-03-02'], // Leap day.
  ['2000-02-29', '2000-02-29'], // Leap century.
  ['2026-12-20', '2027-01-19'], // Year boundary.
]) {
  test(`valid empty range ${from} through ${to}`, async () => {
    const response = await request(`?from=${from}&to=${to}`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { reservations: [] })
  })
}

for (const query of [
  '',
  '?to=2026-10-19',
  '?from=2026-10-19',
  '?from=&to=2026-10-19',
  '?from=2026-10-19&to=',
  '?from=2026-1-01&to=2026-01-02',
  '?from=2026-10-18T00:00:00Z&to=2026-10-19',
  '?from=2026-02-30&to=2026-03-01',
  '?from=2026-02-28&to=2026-02-29',
  '?from=1900-02-29&to=1900-03-01',
  '?from=2026-00-01&to=2026-01-01',
  '?from=2026-13-01&to=2026-13-01',
  '?from=2026-10-00&to=2026-10-01',
  '?from=2026-10-20&to=2026-10-19',
  '?from=2026-10-18&to=2026-11-18',
  '?from=2026-03-15&to=2026-04-15',
  '?from=2026-10-01&to=2026-11-01',
  '?from=2026-10-18&from=2026-10-18&to=2026-10-19',
  '?from=2026-10-18&to=2026-10-19&to=2026-10-19',
  '?from=2026-10-18&to=2026-10-19&extra=1',
  '?from=2026-10-18&unexpected=2026-10-19',
  '?from=2026-10-18%27%20OR%201=1--&to=2026-10-19',
]) {
  test(`rejects invalid query: ${query || '(missing parameters)'}`, async () => {
    const response = await request(query, 'GET', {
      DB: {
        prepare() {
          assert.fail('Invalid requests must not query D1')
        },
      },
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), invalidError)
  })
}

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
  test(`rejects ${method} with Allow header`, async () => {
    const response = await request('?from=2026-10-18&to=2026-10-19', method)
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('Allow'), 'GET')
    assert.deepEqual(await response.json(), {
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
    })
  })
}

test('database failures are logged and return a generic structured error', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  // An actual local D1 error: the table does not exist.
  const brokenDb = {
    prepare() {
      return env.DB.prepare('SELECT * FROM missing_table')
    },
  }
  const response = await request('?from=2026-10-18&to=2026-10-19', 'GET', {
    DB: brokenDb,
  })
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), {
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  })
  assert.equal(log.mock.callCount(), 1)
})

test('health and unknown path behavior remains unchanged', async (t) => {
  const response = await worker.fetch(
    new Request('http://localhost/api/health'),
    env,
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'ok' })

  const post = await worker.fetch(
    new Request('http://localhost/api/health', { method: 'POST' }),
    env,
  )
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('Allow'), 'GET')
  assert.deepEqual(await post.json(), { error: 'Method not allowed' })

  t.mock.method(console, 'error', () => {})
  const failed = await worker.fetch(
    new Request('http://localhost/api/health'),
    {
      DB: {
        prepare: () => {
          throw new Error('database unavailable')
        },
      },
    },
  )
  assert.equal(failed.status, 500)
  assert.deepEqual(await failed.json(), { error: 'Internal server error' })

  const unknown = await worker.fetch(
    new Request('http://localhost/api/unknown'),
    env,
  )
  assert.equal(unknown.status, 404)
  assert.deepEqual(await unknown.json(), { error: 'Not found' })
})
