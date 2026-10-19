import { readFile } from 'node:fs/promises'
import { URL as NodeURL } from 'node:url'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { getPlatformProxy, type PlatformProxy } from 'wrangler'
import worker from './index.ts'

let platform: PlatformProxy<Env> | undefined
let env: Env
const id = '10ca629f-e02b-4231-946d-2acb68cfe951'
const reason = 'Я з квартири 12, змінилися плани.'
beforeAll(async () => {
  platform = await getPlatformProxy<Env>({
    persist: false,
    remoteBindings: false,
  })
  env = platform.env
  for (const name of [
    '0001_create_reservations.sql',
    '0002_admin_auth.sql',
    '0003_cancellation_requests.sql',
  ]) {
    const migration = await readFile(
      new NodeURL(`../migrations/${name}`, import.meta.url),
      'utf8',
    )
    for (const sql of migration
      .replace(/--[^\n]*/g, '')
      .split(';')
      .filter((part) => part.trim()))
      await env.DB.prepare(sql).run()
  }
})
afterAll(async () => {
  vi.useRealTimers()
  await platform?.dispose()
})
beforeEach(async () => {
  vi.useRealTimers()
  vi.setSystemTime(new Date('2026-10-19T09:00:00Z')) // 12:00 Kyiv
  await env.DB.prepare('DELETE FROM cancellation_requests').run()
  await env.DB.prepare('DELETE FROM reservations').run()
  await env.DB.prepare(
    `INSERT INTO reservations (id,date,start_time,end_time,name_or_apartment,idempotency_key)
    VALUES (?, '2026-10-19', '12:00', '14:00', 'Квартира 12', 'private-key')`,
  )
    .bind(id)
    .run()
})
function request(
  body: unknown = { reason },
  reservationId = id,
  method = 'POST',
  contentType = 'application/json',
  bindings = env,
) {
  return worker.fetch(
    new Request(
      `http://localhost/api/reservations/${reservationId}/cancellation-requests`,
      {
        method,
        headers: { 'Content-Type': contentType },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      },
    ),
    bindings,
  )
}
const availability = () =>
  worker
    .fetch(
      new Request(
        'http://localhost/api/availability?from=2026-10-19&to=2026-10-19',
      ),
      env,
    )
    .then((r) => r.json())

test('stores a trimmed private request with UTC timestamps; reservation and availability stay unchanged', async () => {
  const before = await env.DB.prepare('SELECT * FROM reservations').all()
  const available = await availability()
  const response = await request({ reason: `  ${reason}\n ` })
  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({ status: 'pending' })
  expect(
    await env.DB.prepare('SELECT * FROM cancellation_requests').first(),
  ).toEqual({
    id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    reservation_id: id,
    reason,
    status: 'pending',
    created_at: Math.floor(Date.now() / 1000),
    reviewed_at: null,
  })
  expect(await env.DB.prepare('SELECT * FROM reservations').all()).toEqual(
    before,
  )
  expect(await availability()).toEqual(available)
  const booking = await worker.fetch(
    new Request('http://localhost/api/reservations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        date: '2026-10-19',
        startTime: '12:00',
        endTime: '14:00',
        nameOrApartment: 'Інший',
      }),
    }),
    env,
  )
  expect(booking.status).toBe(409)
})

for (const body of [
  {},
  null,
  [],
  { reason: null },
  { reason: ' \n ' },
  { reason: 'коротко' },
  { reason: '..........' },
  { reason: 'a'.repeat(1001) },
  { reason: '😀'.repeat(501) },
  { reason, status: 'approved' },
  { reason: `${reason}\0` },
])
  test(`rejects invalid explanation ${JSON.stringify(body).slice(0, 60)}`, async () => {
    const response = await request(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_REASON' },
    })
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM cancellation_requests',
        ).first()
      )?.n,
    ).toBe(0)
  })

test('accepts exact trimmed text limits', async () => {
  expect((await request({ reason: ` ${'a'.repeat(1000)} ` })).status).toBe(201)
})

test('UTF-16 minimum allows supplementary characters without a database mismatch', async () => {
  expect((await request({ reason: '😀😀😀😀ab' })).status).toBe(201)
})

test('missing reservation returns only predictable error', async () => {
  const response = await request({ reason }, 'unknown-id')
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({
    error: { code: 'RESERVATION_NOT_FOUND', message: 'Reservation not found' },
  })
})
for (const sql of [
  "UPDATE reservations SET status = 'cancelled'",
  "UPDATE reservations SET date = '2026-10-18'",
  "UPDATE reservations SET start_time = '10:00', end_time = '12:00'",
])
  test(`rejects ineligible reservation: ${sql}`, async () => {
    await env.DB.prepare(sql).run()
    expect((await request()).status).toBe(409)
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM cancellation_requests',
        ).first()
      )?.n,
    ).toBe(0)
  })
test('Kyiv end-time boundary and DST are respected', async () => {
  await env.DB.prepare("UPDATE reservations SET date = '2026-10-25'").run()
  vi.setSystemTime(new Date('2026-10-25T12:00:00Z')) // 14:00 Kyiv after DST
  expect((await request()).status).toBe(409)
  vi.setSystemTime(new Date('2026-10-25T11:59:59Z'))
  expect((await request()).status).toBe(201)
})
test('duplicates and twenty competing requests create exactly one pending request', async () => {
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => request()),
  )
  expect(responses.filter((r) => r.status === 201)).toHaveLength(1)
  expect(responses.filter((r) => r.status === 409)).toHaveLength(19)
  expect((await request()).status).toBe(409)
  expect(
    (
      await env.DB.prepare(
        'SELECT count(*) AS n FROM cancellation_requests',
      ).first()
    )?.n,
  ).toBe(1)
})
test('database enforces pending uniqueness, reference, text, status and review timestamps while preserving history', async () => {
  await request()
  const insert = (
    reservationId: string,
    explanation: string,
    status: string,
    reviewed: number | null,
  ) =>
    env.DB.prepare(
      `INSERT INTO cancellation_requests (id,reservation_id,reason,status,created_at,reviewed_at) VALUES (?,?,?,?,100,?)`,
    )
      .bind(crypto.randomUUID(), reservationId, explanation, status, reviewed)
      .run()
  await expect(insert(id, reason, 'pending', null)).rejects.toThrow()
  await expect(insert('missing', reason, 'rejected', 101)).rejects.toThrow()
  for (const [text, status, reviewed] of [
    [' ', 'rejected', 101],
    ['a'.repeat(1001), 'rejected', 101],
    [reason, 'other', 101],
    [reason, 'approved', null],
    [reason, 'rejected', 99],
    [reason, 'pending', 101],
  ] as const)
    await expect(insert(id, text, status, reviewed)).rejects.toThrow()
  await expect(
    env.DB.prepare('DELETE FROM reservations').run(),
  ).rejects.toThrow()
  await env.DB.prepare(
    "UPDATE cancellation_requests SET status = 'rejected', reviewed_at = created_at",
  ).run()
  expect((await request()).status).toBe(201)
  expect(
    (
      await env.DB.prepare(
        'SELECT count(*) AS n FROM cancellation_requests',
      ).first()
    )?.n,
  ).toBe(2)
})
test('method/content type/malformed JSON and database failures return safe errors', async () => {
  const method = await request(undefined, id, 'GET')
  expect(method.status).toBe(405)
  expect(method.headers.get('Allow')).toBe('POST')
  expect((await request({ reason }, id, 'POST', 'text/plain')).status).toBe(415)
  expect(
    (
      await worker.fetch(
        new Request(
          `http://localhost/api/reservations/${id}/cancellation-requests`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{',
          },
        ),
        env,
      )
    ).status,
  ).toBe(400)
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: vi.fn().mockRejectedValueOnce(new Error('private DB details')),
  } as unknown as D1Database
  const response = await request({ reason }, id, 'POST', 'application/json', {
    ...env,
    DB: db,
  })
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  })
})
