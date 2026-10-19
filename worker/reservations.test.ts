import { readFile } from 'node:fs/promises'
import { URL as NodeURL } from 'node:url'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from 'vitest'
import { getPlatformProxy, type PlatformProxy } from 'wrangler'
import worker from './index.ts'
import { reservations } from './reservations.ts'
import type { TelegramEnv } from './telegram.ts'

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
afterEach(() => vi.unstubAllGlobals())

function request(
  body: unknown = payload,
  key = crypto.randomUUID(),
  headers: Record<string, string> = {},
  bindings: Env & TelegramEnv = env,
  context?: Pick<ExecutionContext, 'waitUntil'>,
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
    context,
  )
}
async function count() {
  return (await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM reservations',
  ).first<{ count: number }>())!.count
}

function notifications() {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
  const tasks: Promise<unknown>[] = []
  const context = {
    waitUntil: vi.fn((task: Promise<unknown>) => {
      tasks.push(task)
    }),
  }
  const bindings = {
    ...env,
    TELEGRAM_BOT_TOKEN: 'test-only-token',
    TELEGRAM_GROUP_CHAT_ID: 'test-only-group',
  }
  const book = (body: unknown = payload, key = crypto.randomUUID()) =>
    request(body, key, {}, bindings, context)
  return { fetchMock, tasks, context, bindings, book }
}

test('committed booking schedules exactly one concise Ukrainian plain-text notification', async () => {
  const { fetchMock, tasks, context, book } = notifications()
  let finish!: (response: Response) => void
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
  )
  const response = await book({
    ...payload,
    nameOrApartment: ` ${payload.nameOrApartment} `,
  })
  // The API succeeds and the row is committed while Telegram is still pending.
  expect(response.status).toBe(201)
  expect(await count()).toBe(1)
  expect(context.waitUntil).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    'https://api.telegram.org/bottest-only-token/sendMessage',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: 'test-only-group',
        text: 'Нове бронювання альтанки\n20.10.2026, 18:00–20:00\nКвартира 12',
      }),
      redirect: 'manual',
    },
  )
  finish(Response.json({ ok: true }))
  await Promise.all(tasks)
})

test('sequential and concurrent idempotent replays send only once, including cancelled/expired retries', async () => {
  const { fetchMock, tasks, book } = notifications()
  const key = crypto.randomUUID()
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => book(payload, key)),
  )
  expect(responses.map((response) => response.status)).toEqual(
    Array(8).fill(201),
  )
  expect((await book(payload, key)).status).toBe(201)
  await env.DB.prepare("UPDATE reservations SET status = 'cancelled'").run()
  vi.setSystemTime(new Date('2027-01-01T00:00:00Z'))
  expect((await book(payload, key)).status).toBe(201)
  await Promise.all(tasks)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(await count()).toBe(1)
})

test('invalid input, overlap and idempotency conflicts do not notify', async () => {
  const { fetchMock, tasks, book } = notifications()
  const key = crypto.randomUUID()
  expect((await book({}, key)).status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect((await book(payload, key)).status).toBe(201)
  await Promise.all(tasks)
  fetchMock.mockClear()
  expect((await book()).status).toBe(409)
  expect(
    (await book({ ...payload, nameOrApartment: 'Other' }, key)).status,
  ).toBe(409)
  expect(fetchMock).not.toHaveBeenCalled()
})

test('administrative block does not invoke booking notifications even with a callback', async () => {
  const { fetchMock } = notifications()
  const onCreated = vi.fn()
  const response = await reservations(
    new Request('http://localhost/api/admin/blocks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(payload),
    }),
    env.DB,
    'block',
    onCreated,
  )
  expect(response.status).toBe(201)
  expect(await env.DB.prepare('SELECT kind FROM reservations').first()).toEqual(
    { kind: 'block' },
  )
  expect(onCreated).not.toHaveBeenCalled()
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each([
  { TELEGRAM_BOT_TOKEN: undefined },
  { TELEGRAM_GROUP_CHAT_ID: undefined },
  { TELEGRAM_BOT_TOKEN: ' ' },
  { TELEGRAM_GROUP_CHAT_ID: ' ' },
])('missing Telegram configuration preserves booking: %j', async (missing) => {
  const { fetchMock, context, bindings } = notifications()
  const response = await request(
    payload,
    crypto.randomUUID(),
    {},
    { ...bindings, ...missing },
    context,
  )
  expect(response.status).toBe(201)
  expect(await count()).toBe(1)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(context.waitUntil).not.toHaveBeenCalled()
})

test.each(['network', 'http', 'api'])(
  'Telegram %s failure preserves booking and logs only a fixed message',
  async (failure) => {
    const { fetchMock, tasks, book } = notifications()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sensitive =
      'test-only-token test-only-group Квартира 12 День народження'
    if (failure === 'network') fetchMock.mockRejectedValue(new Error(sensitive))
    else
      fetchMock.mockResolvedValue(
        failure === 'http'
          ? new Response(sensitive, { status: 403 })
          : Response.json({ ok: false, description: sensitive }),
      )
    const key = crypto.randomUUID()
    const response = await book(payload, key)
    expect(response.status).toBe(201)
    const body = await response.json()
    await expect(Promise.all(tasks)).resolves.toEqual([undefined])
    expect(await count()).toBe(1)
    expect(log.mock.calls).toEqual([
      [
        'Telegram booking notification failed',
        failure === 'http'
          ? 'HTTP 403'
          : failure === 'network'
            ? 'network'
            : 'delivery error',
      ],
    ])
    expect(await (await book(payload, key)).json()).toEqual(body)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  },
)

test('notification scheduling failure preserves committed booking', async () => {
  const { bindings, context, tasks } = notifications()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  context.waitUntil.mockImplementation(() => {
    throw new Error('sensitive scheduling error')
  })
  expect(
    (await request(payload, crypto.randomUUID(), {}, bindings, context)).status,
  ).toBe(201)
  expect(await count()).toBe(1)
  await Promise.all(tasks)
  expect(log.mock.calls).toEqual([['Booking notification scheduling failed']])
})

interface StoredReservation {
  id: string
  date: string
  startTime: string
  endTime: string
  nameOrApartment: string
  description: string | null
  status: 'active' | 'cancelled'
  key: string
  createdAt: number
  updatedAt: number
}

// Compare actual committed rows with every success and with availability.
// Promise.all exercises contention; assertions never depend on execution order.
async function verifyConcurrentState(
  responses: Response[],
  keys: string[],
  expectedConflict = conflict,
) {
  const { results: rows } = await env.DB.prepare(
    `SELECT id, date, start_time AS startTime, end_time AS endTime,
            name_or_apartment AS nameOrApartment, description, status,
            idempotency_key AS key, created_at AS createdAt, updated_at AS updatedAt
     FROM reservations ORDER BY date, start_time`,
  ).all<StoredReservation>()
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
  expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
  const active = rows.filter((row) => row.status === 'active')
  const publicRow = ({
    id,
    date,
    startTime,
    endTime,
    nameOrApartment,
    description,
  }: StoredReservation) => ({
    id,
    date,
    startTime,
    endTime,
    nameOrApartment,
    description,
  })
  for (const [index, row] of active.entries()) {
    expect(row.startTime >= '08:00' && row.endTime <= '22:00').toBe(true)
    expect(row.startTime < row.endTime).toBe(true)
    expect(row.startTime).toMatch(/^\d{2}:[03]0$/)
    expect(row.endTime).toMatch(/^\d{2}:[03]0$/)
    expect(row.nameOrApartment.trim().length).toBeGreaterThan(0)
    expect(row.createdAt).toBe(1792314000)
    expect(row.updatedAt).toBe(row.createdAt)
    for (const other of active.slice(index + 1)) {
      if (row.date === other.date)
        expect(
          row.startTime < other.endTime && row.endTime > other.startTime,
        ).toBe(false)
    }
  }
  const successfulIds = new Set<string>()
  for (const [index, response] of responses.entries()) {
    expect([201, 409]).toContain(response.status)
    const body = await response.clone().json()
    const stored = rows.find((row) => row.key === keys[index])
    if (response.status === 201) {
      expect(stored).toBeDefined()
      expect(body).toEqual({ reservation: publicRow(stored!) })
      successfulIds.add(stored!.id)
    } else {
      expect(body).toEqual(expectedConflict)
      if (expectedConflict === conflict) expect(stored).toBeUndefined()
    }
  }
  // No partial/unreported inserts, even when many requests share one key.
  expect(active.map((row) => row.id).sort()).toEqual([...successfulIds].sort())
  const availability = await worker.fetch(
    new Request(
      'http://localhost/api/availability?from=2026-10-18&to=2026-11-17',
    ),
    env,
  )
  expect(availability.status).toBe(200)
  expect(await availability.json()).toEqual({
    reservations: active.map(publicRow),
  })
  return rows
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
  ['2026-03-01T22:00:00Z', '2026-04-01', '08:00', 201],
  ['2026-03-01T22:00:00Z', '2026-04-02', '08:00', 400],
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
  const bodies = await Promise.all(
    responses.map((response) => response.clone().json()),
  )
  expect(
    bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0])),
  ).toBe(true)
  expect(await count()).toBe(1)
  await verifyConcurrentState(responses, Array(8).fill(key))
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
    await responses
      .find((response) => response.status === 409)!
      .clone()
      .json(),
  ).toEqual(keyConflict)
  expect(await count()).toBe(1)
  await verifyConcurrentState(responses, [key, key], keyConflict)
})
test('concurrent same interval from 20 different users creates one active row', async () => {
  const keys = Array.from({ length: 20 }, () => crypto.randomUUID())
  const responses = await Promise.all(
    keys.map((key, index) =>
      request(
        {
          ...payload,
          nameOrApartment: `Квартира ${index + 1}`,
        },
        key,
      ),
    ),
  )
  expect(responses.filter((response) => response.status === 201)).toHaveLength(
    1,
  )
  expect(responses.filter((response) => response.status === 409)).toHaveLength(
    19,
  )
  expect(await count()).toBe(1)
  await verifyConcurrentState(responses, keys)
})

test('concurrent partially overlapping intervals have one unspecified winner', async () => {
  const intervals = [
    ['18:00', '20:00'],
    ['19:00', '21:00'],
    ['17:30', '19:30'],
  ]
  const keys = intervals.map(() => crypto.randomUUID())
  const responses = await Promise.all(
    intervals.map(([startTime, endTime], index) =>
      request({ ...payload, startTime, endTime }, keys[index]),
    ),
  )
  expect(responses.map((response) => response.status).sort()).toEqual([
    201, 409, 409,
  ])
  expect(await verifyConcurrentState(responses, keys)).toHaveLength(1)
})

test('concurrent adjacent intervals all succeed without false conflicts', async () => {
  const intervals = [
    ['18:00', '19:00'],
    ['19:00', '20:00'],
    ['20:00', '21:00'],
  ]
  const keys = intervals.map(() => crypto.randomUUID())
  const responses = await Promise.all(
    intervals.map(([startTime, endTime], index) =>
      request({ ...payload, startTime, endTime }, keys[index]),
    ),
  )
  expect(responses.map((response) => response.status)).toEqual([201, 201, 201])
  expect(await verifyConcurrentState(responses, keys)).toHaveLength(3)
})

test('concurrent full-day bookings on independent dates all succeed', async () => {
  // Today, tomorrow and the inclusive 30-day limit, spanning autumn DST.
  const dates = ['2026-10-18', '2026-10-19', '2026-11-17']
  const keys = dates.map(() => crypto.randomUUID())
  const responses = await Promise.all(
    dates.map((date, index) =>
      request(
        {
          ...payload,
          date,
          startTime: date === '2026-10-18' ? '12:00' : '08:00',
          endTime: '22:00',
        },
        keys[index],
      ),
    ),
  )
  expect(responses.map((response) => response.status)).toEqual([201, 201, 201])
  expect(await verifyConcurrentState(responses, keys)).toHaveLength(3)
})

test('concurrent bookings ignore cancelled intervals and retain consumed keys', async () => {
  const cancelledKey = crypto.randomUUID()
  expect((await request(payload, cancelledKey)).status).toBe(201)
  await env.DB.prepare("UPDATE reservations SET status = 'cancelled'").run()
  const keys = Array.from({ length: 8 }, () => crypto.randomUUID())
  const responses = await Promise.all(keys.map((key) => request(payload, key)))
  expect(responses.map((response) => response.status).sort()).toEqual([
    201,
    ...Array(7).fill(409),
  ])
  const rows = await verifyConcurrentState(responses, keys)
  expect(rows).toHaveLength(2)
  expect(rows.find((row) => row.key === cancelledKey)?.status).toBe('cancelled')
  const replay = await request(payload, cancelledKey)
  expect(replay.status).toBe(201)
  expect(
    ((await replay.json()) as { reservation: { id: string } }).reservation.id,
  ).toBe(rows.find((row) => row.key === cancelledKey)!.id)
  expect(await count()).toBe(2)
})

test('concurrent stress: 50 mixed intervals preserve database and availability invariants', async () => {
  const intervals = [
    ['08:00', '10:00'],
    ['09:30', '11:30'],
    ['10:00', '12:00'],
    ['12:00', '12:30'],
    ['12:30', '13:00'],
    ['14:00', '17:00'],
    ['16:30', '18:00'],
    ['18:00', '20:00'],
    ['19:00', '21:00'],
    ['20:00', '22:00'],
  ]
  const keys = Array.from({ length: 50 }, () => crypto.randomUUID())
  const responses = await Promise.all(
    keys.map((key, index) => {
      const [startTime, endTime] = intervals[index % intervals.length]
      return request(
        {
          ...payload,
          startTime,
          endTime,
          nameOrApartment: `Квартира ${(index % 24) + 1}`,
        },
        key,
      )
    }),
  )
  const rows = await verifyConcurrentState(responses, keys)
  expect(rows.length).toBeGreaterThan(1)
  expect(rows.length).toBeLessThanOrEqual(intervals.length)
  expect(responses.some((response) => response.status === 409)).toBe(true)
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
    expect(await count()).toBe(0)
  })

test('actual D1 write failure returns a safe 500 without consuming the key', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const key = crypto.randomUUID()
  await env.DB.prepare(
    `CREATE TRIGGER reject_test_insert BEFORE INSERT ON reservations
    BEGIN SELECT RAISE(ABORT, 'secret database detail'); END`,
  ).run()
  try {
    const response = await request(payload, key)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    })
    expect(log).toHaveBeenCalledTimes(1)
    expect(await count()).toBe(0)
  } finally {
    await env.DB.prepare('DROP TRIGGER reject_test_insert').run()
  }
  expect((await request(payload, key)).status).toBe(201)
  expect(await count()).toBe(1)
})
