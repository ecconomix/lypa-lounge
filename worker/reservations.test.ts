import { readFile } from 'node:fs/promises'
import { URL as NodeURL } from 'node:url'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { getPlatformProxy, type PlatformProxy } from 'wrangler'
import worker from './index.ts'

let platform: PlatformProxy<Env> | undefined
let env: Env
const payload = {
  date: '2026-10-20',
  startTime: '18:00',
  endTime: '20:00',
  nameOrApartment: 'Квартира 12',
  description: 'День народження',
}
const invalid = {
  error: { code: 'INVALID_RESERVATION', message: 'Invalid reservation data' },
}
const conflict = {
  error: {
    code: 'RESERVATION_CONFLICT',
    message: 'Selected time is no longer available',
  },
}
const keyConflict = {
  error: {
    code: 'IDEMPOTENCY_CONFLICT',
    message: 'Idempotency key was already used',
  },
}

beforeAll(async () => {
  platform = await getPlatformProxy<Env>({
    persist: false,
    remoteBindings: false,
  })
  env = platform.env
  const migration = await readFile(
    new NodeURL('../migrations/0001_create_reservations.sql', import.meta.url),
    'utf8',
  )
  for (const sql of migration
    .replace(/--[^\n]*/g, '')
    .split(';')
    .filter((part) => part.trim()))
    await env.DB.prepare(sql).run()
})
afterAll(async () => {
  await platform?.dispose()
})
beforeEach(async () => {
  vi.useRealTimers()
  // Spy only on Date; fake timers would interfere with local D1's runtime.
  vi.setSystemTime(new Date('2026-10-18T09:00:00Z'))
  await env.DB.prepare('DELETE FROM reservations').run()
})
afterAll(() => {
  vi.useRealTimers()
})

function request(
  body: unknown = payload,
  key = crypto.randomUUID(),
  headers: Record<string, string> = {},
  bindings = env,
) {
  return worker.fetch(
    new Request('http://localhost/api/reservations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    bindings,
  )
}
async function count() {
  return (await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM reservations',
  ).first<{ count: number }>())!.count
}

test('creates persistent public reservation, UUID, active status and UTC audit timestamps; availability reflects it', async () => {
  const key = crypto.randomUUID()
  const response = await request(payload, key)
  expect(response.status).toBe(201)
  const { reservation } = (await response.json()) as {
    reservation: { id: string }
  }
  expect(reservation).toEqual({ ...payload, id: expect.any(String) })
  expect(reservation.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(reservation.id).not.toBe(key)
  expect(
    await env.DB.prepare(
      'SELECT status, idempotency_key, created_at, updated_at FROM reservations',
    ).first(),
  ).toEqual({
    status: 'active',
    idempotency_key: key,
    created_at: 1792314000,
    updated_at: 1792314000,
  })
  const available = await worker.fetch(
    new Request(
      'http://localhost/api/availability?from=2026-10-20&to=2026-10-20',
    ),
    env,
  )
  expect(await available.json()).toEqual({ reservations: [reservation] })
})

const invalidBodies: [string, unknown][] = [
  ['null', null],
  ['array', []],
  ['primitive', 'text'],
  ['empty object', {}],
  ...['date', 'startTime', 'endTime', 'nameOrApartment'].map(
    (field): [string, unknown] => [
      `missing ${field}`,
      Object.fromEntries(
        Object.entries(payload).filter(([key]) => key !== field),
      ),
    ],
  ),
  ...['date', 'startTime', 'endTime', 'nameOrApartment', 'description'].flatMap(
    (field): [string, unknown][] =>
      [null, 12, true, [], {}].map((value) => [
        `invalid type ${field}: ${JSON.stringify(value)}`,
        { ...payload, [field]: value },
      ]),
  ),
  ['unknown field', { ...payload, status: 'cancelled' }],
  ...[
    '2026-02-30',
    '2026-02-29',
    '2026-13-01',
    '2026-00-01',
    '2026-10-00',
    '2026-1-20',
    '2026-10-20T00:00:00Z',
    '2026-10-17',
    '2026-11-18',
    ' 2026-10-20',
  ].map((date): [string, unknown] => [`date ${date}`, { ...payload, date }]),
  ...['7:00', '18:15', '18:01', '24:00', '07:30', '18:00:00'].map(
    (startTime): [string, unknown] => [
      `time ${startTime}`,
      { ...payload, startTime },
    ],
  ),
  ['short duration', { ...payload, endTime: '18:15' }],
  ['equal times', { ...payload, endTime: '18:00' }],
  ['reversed', { ...payload, endTime: '17:00' }],
  ['after closing', { ...payload, endTime: '22:30' }],
  ['cross midnight', { ...payload, endTime: '08:00' }],
  ['blank name', { ...payload, nameOrApartment: ' \n ' }],
  ['long name', { ...payload, nameOrApartment: 'a'.repeat(101) }],
  ['long description', { ...payload, description: 'a'.repeat(1001) }],
]
for (const [name, body] of invalidBodies)
  test(`rejects ${name}`, async () => {
    const response = await request(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(invalid)
    expect(await count()).toBe(0)
  })

test('trims text, accepts exact limits and normalizes missing/blank description', async () => {
  const response = await request({
    ...payload,
    nameOrApartment: ` ${'a'.repeat(100)} `,
    description: ` ${'b'.repeat(1000)} `,
  })
  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    reservation: {
      ...payload,
      id: expect.any(String),
      nameOrApartment: 'a'.repeat(100),
      description: 'b'.repeat(1000),
    },
  })
  for (const description of [undefined, ' \n ']) {
    const result = await request({
      ...payload,
      date: description === undefined ? '2026-10-21' : '2026-10-22',
      description,
    })
    expect(result.status).toBe(201)
    expect(
      ((await result.json()) as { reservation: { description: null } })
        .reservation.description,
    ).toBe(null)
  }
})

test('malformed JSON and unsupported content types are safe', async () => {
  const malformed = await worker.fetch(
    new Request('http://localhost/api/reservations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: '{',
    }),
    env,
  )
  expect(malformed.status).toBe(400)
  expect(await malformed.json()).toEqual(invalid)
  for (const contentType of ['', 'text/plain', 'application/jsonp'])
    expect(
      (
        await request(payload, crypto.randomUUID(), {
          'Content-Type': contentType,
        })
      ).status,
    ).toBe(415)
  expect(
    (
      await request(payload, crypto.randomUUID(), {
        'Content-Type': 'Application/JSON; charset=utf-8',
      })
    ).status,
  ).toBe(201)
})
for (const key of ['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000'])
  test(`rejects key ${key}`, async () => {
    expect((await request(payload, key)).status).toBe(400)
  })
test('requires idempotency header', async () => {
  const response = await worker.fetch(
    new Request('http://localhost/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    env,
  )
  expect(response.status).toBe(400)
})

for (const [now, date, startTime, status] of [
  ['2026-10-18T09:00:00.000Z', '2026-10-18', '12:00', 201],
  ['2026-10-18T09:00:00.001Z', '2026-10-18', '12:00', 400],
  ['2026-10-18T09:00:01Z', '2026-10-18', '12:00', 400],
  ['2026-10-18T09:01:00Z', '2026-10-18', '12:30', 201],
  ['2026-10-18T20:59:59Z', '2026-10-18', '21:30', 400],
  ['2026-10-18T21:00:00Z', '2026-10-19', '08:00', 201],
  ['2026-10-18T21:00:00Z', '2026-10-18', '18:00', 400],
  ['2026-03-28T22:30:00Z', '2026-03-29', '08:00', 201],
  ['2026-03-29T05:00:00Z', '2026-03-29', '08:00', 201],
  ['2026-03-29T05:00:01Z', '2026-03-29', '08:00', 400],
  ['2026-10-25T06:00:00Z', '2026-10-25', '08:00', 201],
  ['2026-10-25T06:00:01Z', '2026-10-25', '08:00', 400],
  ['2026-12-31T22:00:00Z', '2027-01-31', '08:00', 201],
  ['2026-12-31T22:00:00Z', '2027-02-01', '08:00', 400],
] as const)
  test(`Kyiv clock ${now}: ${date} ${startTime} => ${status}`, async () => {
    vi.setSystemTime(new Date(now))
    expect(
      (await request({ ...payload, date, startTime, endTime: '22:00' })).status,
    ).toBe(status)
  })
for (const date of ['2026-10-18', '2026-11-17'])
  test(`inclusive date boundary ${date}`, async () => {
    expect((await request({ ...payload, date })).status).toBe(201)
  })
test('full day and minimum duration are valid', async () => {
  expect(
    (await request({ ...payload, startTime: '08:00', endTime: '22:00' }))
      .status,
  ).toBe(201)
  expect(
    (await request({ ...payload, date: '2026-10-21', endTime: '18:30' }))
      .status,
  ).toBe(201)
})

for (const [startTime, endTime, status] of [
  ['18:00', '20:00', 409],
  ['17:00', '19:00', 409],
  ['19:00', '21:00', 409],
  ['18:30', '19:00', 409],
  ['08:00', '22:00', 409],
  ['08:00', '18:00', 201],
  ['20:00', '22:00', 201],
] as const)
  test(`interval ${startTime}-${endTime} => ${status}`, async () => {
    expect((await request()).status).toBe(201)
    const response = await request({ ...payload, startTime, endTime })
    expect(response.status).toBe(status)
    if (status === 409) expect(await response.json()).toEqual(conflict)
  })
test('cancelled and different-date reservations do not block', async () => {
  await request()
  expect((await request({ ...payload, date: '2026-10-21' })).status).toBe(201)
  await env.DB.prepare("UPDATE reservations SET status = 'cancelled'").run()
  expect((await request()).status).toBe(201)
})
test('identical normalized retry returns original, even cancelled and expired', async () => {
  const key = crypto.randomUUID()
  const first = await (await request(payload, key)).json()
  expect(
    await (
      await request(
        { ...payload, nameOrApartment: ` ${payload.nameOrApartment} ` },
        key.toUpperCase(),
      )
    ).json(),
  ).toEqual(first)
  await env.DB.prepare("UPDATE reservations SET status = 'cancelled'").run()
  vi.setSystemTime(new Date('2027-01-01T00:00:00Z'))
  const retry = await request(payload, key)
  expect(retry.status).toBe(201)
  expect(await retry.json()).toEqual(first)
  expect(await count()).toBe(1)
})
for (const change of [
  { date: '2026-10-21' },
  { startTime: '18:30' },
  { endTime: '21:00' },
  { nameOrApartment: 'Other' },
  { description: 'Other' },
])
  test(`same key different payload ${JSON.stringify(change)}`, async () => {
    const key = crypto.randomUUID()
    await request(payload, key)
    await env.DB.prepare("UPDATE reservations SET status = 'cancelled'").run()
    const response = await request({ ...payload, ...change }, key)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(keyConflict)
    expect(await count()).toBe(1)
  })
test('concurrent identical keys create one row', async () => {
  const key = crypto.randomUUID()
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => request(payload, key)),
  )
  expect(responses.map((response) => response.status)).toEqual(
    Array(8).fill(201),
  )
  const bodies = await Promise.all(responses.map((response) => response.json()))
  expect(
    bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0])),
  ).toBe(true)
  expect(await count()).toBe(1)
})
test('concurrent different payloads sharing key resolve to one winner', async () => {
  const key = crypto.randomUUID()
  const responses = await Promise.all([
    request(payload, key),
    request({ ...payload, startTime: '20:00', endTime: '22:00' }, key),
  ])
  expect(responses.map((response) => response.status).sort()).toEqual([
    201, 409,
  ])
  expect(
    await responses.find((response) => response.status === 409)!.json(),
  ).toEqual(keyConflict)
  expect(await count()).toBe(1)
})
test('concurrent overlapping requests with distinct keys create one row', async () => {
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => request()),
  )
  expect(responses.filter((response) => response.status === 201)).toHaveLength(
    1,
  )
  expect(responses.filter((response) => response.status === 409)).toHaveLength(
    7,
  )
  expect(await count()).toBe(1)
})
test('failed conflict does not consume a key', async () => {
  await request()
  const key = crypto.randomUUID()
  expect((await request(payload, key)).status).toBe(409)
  expect(
    (await request({ ...payload, startTime: '20:00', endTime: '22:00' }, key))
      .status,
  ).toBe(201)
})
for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
  test(`unsupported ${method}`, async () => {
    const response = await worker.fetch(
      new Request('http://localhost/api/reservations', { method }),
      env,
    )
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('POST')
    expect(await response.json()).toEqual({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
    })
  })
for (const stage of ['lookup', 'write'])
  test(`database ${stage} failure logs and returns generic error`, async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('secret SQL stack')
    const db =
      stage === 'lookup'
        ? {
            prepare: vi.fn(() => {
              throw failure
            }),
          }
        : {
            prepare: env.DB.prepare.bind(env.DB),
            batch: vi.fn(() => {
              throw failure
            }),
          }
    const response = await request(
      payload,
      crypto.randomUUID(),
      {},
      { DB: db as unknown as D1Database },
    )
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    })
    expect(log).toHaveBeenCalledWith('Worker request failed', failure)
  })
