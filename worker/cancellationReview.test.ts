import { readFile } from 'node:fs/promises'
import { URL as NodeURL } from 'node:url'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { getPlatformProxy, type PlatformProxy } from 'wrangler'
import worker from './index.ts'
import type { AdminEnv } from './admin.ts'

let platform: PlatformProxy<Env>
let env: Env & AdminEnv
let cookie: string
const origin = 'https://lounge.example'
beforeAll(async () => {
  platform = await getPlatformProxy<Env>({
    persist: false,
    remoteBindings: false,
  })
  env = {
    ...platform.env,
    ADMIN_PASSWORD: 'test-only-long-admin-password',
    ADMIN_ORIGIN: origin,
  }
  for (const name of [
    '0001_create_reservations.sql',
    '0002_admin_auth.sql',
    '0003_cancellation_requests.sql',
    '0004_reservation_kind.sql',
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
  const login = await worker.fetch(
    new Request(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    }),
    env,
  )
  cookie = login.headers.get('Set-Cookie')!.split(';')[0]
})
afterAll(async () => {
  await platform?.dispose()
})
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM cancellation_requests'),
    env.DB.prepare('DELETE FROM reservations'),
    env.DB.prepare(`INSERT INTO reservations
      (id,date,start_time,end_time,name_or_apartment,idempotency_key,created_at,updated_at)
      VALUES ('booking','2026-10-20','12:00','14:00','Квартира 12','original-key',100,100)`),
    env.DB
      .prepare(`INSERT INTO cancellation_requests (id,reservation_id,reason,created_at)
      VALUES ('review','booking','Змінилися плани',101)`),
  ])
})
function request(
  action = '',
  options: {
    cookie?: string
    headers?: Record<string, string>
    method?: string
  } = {},
  bindings = env,
) {
  return worker.fetch(
    new Request(
      `${origin}/api/admin/cancellation-requests${action ? `/${action}` : ''}`,
      {
        method: options.method ?? (action ? 'POST' : 'GET'),
        headers: {
          Cookie: options.cookie ?? cookie,
          Origin: origin,
          'Content-Type': 'application/json',
          ...options.headers,
        },
        ...(action && options.method !== 'GET' ? { body: '{}' } : {}),
      },
    ),
    bindings,
  )
}
async function state() {
  return {
    review: await env.DB.prepare('SELECT * FROM cancellation_requests').first(),
    booking: await env.DB.prepare('SELECT * FROM reservations').first(),
  }
}
async function available() {
  const response = await worker.fetch(
    new Request(`${origin}/api/availability?from=2026-10-20&to=2026-10-20`),
    env,
  )
  return (await response.json()) as { reservations: unknown[] }
}
test('authenticated listing includes booking fields and private explanation; public availability does not', async () => {
  const response = await request()
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(await response.json()).toEqual({
    requests: [
      {
        id: 'review',
        reservationId: 'booking',
        reason: 'Змінилися плани',
        createdAt: 101,
        date: '2026-10-20',
        startTime: '12:00',
        endTime: '14:00',
        nameOrApartment: 'Квартира 12',
      },
    ],
  })
  expect(JSON.stringify(await available())).not.toMatch(
    /reason|review|createdAt|original-key/,
  )
})
test('all review routes require authentication; mutations enforce origin and content type', async () => {
  const before = await state()
  for (const action of ['', 'review/approve', 'review/reject'])
    expect((await request(action, { cookie: '' })).status).toBe(401)
  for (const action of ['review/approve', 'review/reject']) {
    for (const Origin of ['', 'null', 'https://attacker.example'])
      expect((await request(action, { headers: { Origin } })).status).toBe(403)
    expect(
      (await request(action, { headers: { 'Content-Type': 'text/plain' } }))
        .status,
    ).toBe(415)
    expect((await request(action, { method: 'GET' })).status).toBe(405)
  }
  expect((await request('', { method: 'POST' })).status).toBe(405)
  expect(await state()).toEqual(before)
})
for (const action of ['approve', 'reject'] as const) {
  test(`${action} updates only expected fields, refreshes pending list and is an immutable replay`, async () => {
    const before = await state()
    const response = await request(`review/${action}`)
    expect(response.status).toBe(200)
    const result = await response.json()
    const after = await state()
    expect(after.review).toEqual({
      ...before.review,
      status: action === 'approve' ? 'approved' : 'rejected',
      reviewed_at: expect.any(Number),
    })
    expect(after.booking).toEqual(
      action === 'approve'
        ? {
            ...before.booking,
            status: 'cancelled',
            updated_at: expect.any(Number),
          }
        : before.booking,
    )
    expect((await available()).reservations).toHaveLength(
      action === 'approve' ? 0 : 1,
    )
    expect(await (await request()).json()).toEqual({ requests: [] })
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    expect(await (await request(`review/${action}`)).json()).toEqual(result)
    expect(await state()).toEqual(after)
    expect(
      (await request(`review/${action === 'approve' ? 'reject' : 'approve'}`))
        .status,
    ).toBe(409)
    expect(await state()).toEqual(after)
  })
}
test('competing approve/reject operations resolve to one consistent, permanent decision', async () => {
  const actions = Array.from({ length: 20 }, (_, i) =>
    i % 2 ? 'approve' : 'reject',
  )
  const responses = await Promise.all(
    actions.map((action) => request(`review/${action}`)),
  )
  const after = await state()
  const approved = after.review?.status === 'approved'
  expect(['approved', 'rejected']).toContain(after.review?.status)
  expect(after.booking?.status).toBe(approved ? 'cancelled' : 'active')
  expect(after.review?.reviewed_at).toEqual(expect.any(Number))
  responses.forEach((response, i) =>
    expect(response.status).toBe(
      actions[i] === (approved ? 'approve' : 'reject') ? 200 : 409,
    ),
  )
})
test('missing and ineligible requests cause no writes', async () => {
  expect((await request('missing/approve')).status).toBe(404)
  expect((await request('missing/reject')).status).toBe(404)
  await env.DB.prepare("UPDATE reservations SET status = 'cancelled'").run()
  const before = await state()
  for (const action of ['approve', 'reject'])
    expect((await request(`review/${action}`)).status).toBe(409)
  expect(await state()).toEqual(before)
})
test('failure of reservation update rolls back the review decision', async () => {
  await env.DB.prepare(
    `CREATE TRIGGER fail_cancel BEFORE UPDATE OF status ON reservations
    BEGIN SELECT RAISE(ABORT, 'test failure'); END`,
  ).run()
  const before = await state()
  try {
    expect((await request('review/approve')).status).toBe(500)
    expect(await state()).toEqual(before)
  } finally {
    await env.DB.prepare('DROP TRIGGER fail_cancel').run()
  }
})
test('database failures return safe private errors', async () => {
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: vi.fn().mockRejectedValue(new Error('private explanation')),
  } as unknown as D1Database
  const response = await request('review/approve', {}, { ...env, DB: db })
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({
    error: 'Cancellation review unavailable',
  })
})

for (const action of ['approve', 'reject'] as const) {
  test(`${action} controls subsequent atomic booking conflicts while preserving consumed keys`, async () => {
    const originalKey = crypto.randomUUID()
    await env.DB.prepare('UPDATE reservations SET idempotency_key = ?')
      .bind(originalKey)
      .run()
    await request(`review/${action}`)
    const after = await state()
    const book = (key: string, name = 'Квартира 12') =>
      worker.fetch(
        new Request(`${origin}/api/reservations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
          },
          body: JSON.stringify({
            date: '2026-10-20',
            startTime: '12:00',
            endTime: '14:00',
            nameOrApartment: name,
          }),
        }),
        env,
      )
    // Reservation validation uses new Date(), so freeze the civil clock too.
    vi.setSystemTime(new Date('2026-10-19T09:00:00Z'))
    try {
      expect((await book(originalKey)).status).toBe(201)
      expect((await book(originalKey, 'Інше ім’я')).status).toBe(409)
      expect(await state()).toEqual(after)
      expect((await book(crypto.randomUUID(), 'Інша квартира')).status).toBe(
        action === 'approve' ? 201 : 409,
      )
    } finally {
      vi.useRealTimers()
    }
  })
}
