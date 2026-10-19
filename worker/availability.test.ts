import { readFile } from 'node:fs/promises'
import { URL as NodeURL } from 'node:url'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { getPlatformProxy, type PlatformProxy } from 'wrangler'
import worker from './index.ts'

interface AvailabilityResponse {
  reservations: {
    id: string
    date: string
    startTime: string
    endTime: string
    nameOrApartment: string
    description: string | null
  }[]
}

let platform: PlatformProxy<Env> | undefined
let env: Env

beforeAll(async () => {
  // Ephemeral, local D1: never touches development data or remote bindings.
  platform = await getPlatformProxy<Env>({
    persist: false,
    remoteBindings: false,
  })
  env = platform.env
  const migration =
    (await readFile(
      new NodeURL(
        '../migrations/0001_create_reservations.sql',
        import.meta.url,
      ),
      'utf8',
    )) +
    (await readFile(
      new NodeURL('../migrations/0004_reservation_kind.sql', import.meta.url),
      'utf8',
    ))
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

afterAll(async () => {
  await platform?.dispose()
})

function request(
  query: string,
  method = 'GET',
  bindings: Pick<Env, 'DB'> = env,
) {
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
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toMatch(/application\/json/)
  const { reservations } = (await response.json()) as AvailabilityResponse
  expect(reservations.map(({ id }) => id)).toEqual([
    'first',
    'early',
    'late',
    'last',
  ])
  for (const reservation of reservations) {
    expect(Object.keys(reservation).sort()).toEqual([
      'date',
      'description',
      'endTime',
      'id',
      'nameOrApartment',
      'startTime',
    ])
  }
  expect(reservations[2]).toEqual({
    id: 'late',
    date: '2026-10-20',
    startTime: '18:00',
    endTime: '21:00',
    nameOrApartment: 'Квартира 12',
    description: 'День народження',
  })
  expect(reservations[0].description).toBe(null)
})

test('single-day range returns that day only', async () => {
  const response = await request('?from=2026-10-20&to=2026-10-20')
  expect(response.status).toBe(200)
  const { reservations } = (await response.json()) as AvailabilityResponse
  expect(reservations.map(({ id }) => id)).toEqual(['early', 'late'])
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
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ reservations: [] })
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
    const prepare = vi.fn<D1Database['prepare']>(() => {
      throw new Error('Invalid requests must not query D1')
    })
    const response = await request(query, 'GET', {
      DB: { prepare } as unknown as D1Database,
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(invalidError)
  })
}

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
  test(`rejects ${method} with Allow header`, async () => {
    const response = await request('?from=2026-10-18&to=2026-10-19', method)
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('GET')
    expect(await response.json()).toEqual({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
    })
  })
}

test('database failures are logged and return a generic structured error', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  // An actual local D1 error: the table does not exist.
  // Wrap the binding: runtime proxy methods cannot be replaced with spies.
  const brokenStatement = env.DB.prepare('SELECT * FROM missing_table')
  const prepare = vi
    .fn<D1Database['prepare']>()
    .mockReturnValue(brokenStatement)
  const response = await request('?from=2026-10-18&to=2026-10-19', 'GET', {
    DB: { prepare } as unknown as D1Database,
  })
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  })
  expect(log).toHaveBeenCalledTimes(1)
})

test('health and unknown path behavior remains unchanged', async () => {
  const response = await worker.fetch(
    new Request('http://localhost/api/health'),
    env,
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'ok' })

  const post = await worker.fetch(
    new Request('http://localhost/api/health', { method: 'POST' }),
    env,
  )
  expect(post.status).toBe(405)
  expect(post.headers.get('Allow')).toBe('GET')
  expect(await post.json()).toEqual({ error: 'Method not allowed' })

  vi.spyOn(console, 'error').mockImplementation(() => {})
  const prepare = vi.fn<D1Database['prepare']>(() => {
    throw new Error('database unavailable')
  })
  const failed = await worker.fetch(
    new Request('http://localhost/api/health'),
    { DB: { prepare } as unknown as D1Database },
  )
  expect(failed.status).toBe(500)
  expect(await failed.json()).toEqual({ error: 'Internal server error' })

  const unknown = await worker.fetch(
    new Request('http://localhost/api/unknown'),
    env,
  )
  expect(unknown.status).toBe(404)
  expect(await unknown.json()).toEqual({ error: 'Not found' })
})
