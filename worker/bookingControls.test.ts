import { readFile } from 'node:fs/promises'
import { URL as NodeURL } from 'node:url'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { getPlatformProxy, type PlatformProxy } from 'wrangler'
import worker from './index.ts'

let platform: PlatformProxy<Env>
let env: Parameters<typeof worker.fetch>[1]
let cookie: string
const origin = 'https://lounge.example'
const payload = {
  date: '2026-10-20',
  startTime: '12:00',
  endTime: '14:00',
  reason: 'Private maintenance',
}
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
  const response = await call('login', 'POST', { password: env.ADMIN_PASSWORD })
  cookie = response.headers.get('Set-Cookie')!.split(';')[0]
})
afterAll(async () => {
  await platform?.dispose()
})
beforeEach(async () => {
  vi.setSystemTime(new Date('2026-10-19T09:00:00Z'))
  await env.DB.batch([
    env.DB.prepare('DELETE FROM cancellation_requests'),
    env.DB.prepare('DELETE FROM reservations'),
  ])
})
function call(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return worker.fetch(
    new Request(`${origin}/api/admin/${path}`, {
      method,
      headers: {
        Cookie: cookie ?? '',
        Origin: origin,
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        ...headers,
      },
      ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
    }),
    env,
  )
}
async function book() {
  return worker.fetch(
    new Request(`${origin}/api/reservations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        date: payload.date,
        startTime: payload.startTime,
        endTime: payload.endTime,
        nameOrApartment: 'Квартира 12',
        description: 'Обід',
      }),
    }),
    env,
  )
}
async function publicRows() {
  return (await (
    await worker.fetch(
      new Request(
        `${origin}/api/availability?from=${payload.date}&to=${payload.date}`,
      ),
      env,
    )
  ).json()) as {
    reservations: {
      id: string
      description: string | null
      nameOrApartment: string
    }[]
  }
}
async function state() {
  return (await env.DB.prepare('SELECT * FROM reservations ORDER BY id').all())
    .results
}

test('all controls require authentication and shared mutation CSRF checks', async () => {
  for (const [path, method] of [
    ['reservations', 'GET'],
    ['reservations/id/cancel', 'POST'],
    ['blocks', 'GET'],
    ['blocks', 'POST'],
    ['blocks/id', 'DELETE'],
  ]) {
    expect((await call(path, method, payload, { Cookie: '' })).status).toBe(401)
    if (method !== 'GET') {
      expect(
        (
          await call(path, method, payload, {
            Origin: 'https://attacker.example',
          })
        ).status,
      ).toBe(403)
      expect(
        (await call(path, method, payload, { 'Content-Type': 'text/plain' }))
          .status,
      ).toBe(415)
    }
  }
  expect(await state()).toHaveLength(0)
})
test('lists active bookings; manual cancellation resolves pending request and safely repeats', async () => {
  const created = await book()
  const { reservation } = (await created.json()) as {
    reservation: { id: string }
  }
  await env.DB.prepare(
    "INSERT INTO cancellation_requests (id, reservation_id, reason) VALUES ('pending', ?, 'Змінилися плани')",
  )
    .bind(reservation.id)
    .run()
  const list = await call('reservations')
  expect(list.headers.get('Cache-Control')).toBe('no-store')
  expect(await list.json()).toMatchObject({
    reservations: [
      {
        id: reservation.id,
        nameOrApartment: 'Квартира 12',
        description: 'Обід',
      },
    ],
  })
  expect(
    (await call(`reservations/${reservation.id}/cancel`, 'POST')).status,
  ).toBe(200)
  expect(
    await env.DB.prepare(
      'SELECT status, reviewed_at FROM cancellation_requests',
    ).first(),
  ).toEqual({ status: 'approved', reviewed_at: expect.any(Number) })
  const after = await state()
  expect(after[0].status).toBe('cancelled')
  expect(
    (await call(`reservations/${reservation.id}/cancel`, 'POST')).status,
  ).toBe(200)
  expect(await state()).toEqual(after)
  expect((await publicRows()).reservations).toHaveLength(0)
  expect(await (await call('reservations')).json()).toEqual({
    reservations: [],
  })
  expect((await call('reservations/missing/cancel', 'POST')).status).toBe(404)
  expect((await book()).status).toBe(201)
})
test('block lifecycle preserves history, hides reason, arbitrates overlaps and replays original keys', async () => {
  const key = crypto.randomUUID()
  const response = await call('blocks', 'POST', payload, {
    'Idempotency-Key': key,
  })
  expect(response.status).toBe(201)
  const { reservation } = (await response.json()) as {
    reservation: { id: string }
  }
  expect(await (await call('blocks')).json()).toMatchObject({
    blocks: [
      {
        id: reservation.id,
        description: payload.reason,
        createdAt: expect.any(Number),
      },
    ],
  })
  expect(await (await call('reservations')).json()).toEqual({
    reservations: [],
  })
  expect((await publicRows()).reservations).toEqual([
    {
      id: reservation.id,
      date: payload.date,
      startTime: '12:00',
      endTime: '14:00',
      nameOrApartment: 'Технічне блокування',
      description: null,
      isTechnicalBlock: true,
    },
  ])
  expect((await book()).status).toBe(409)
  expect((await call('blocks', 'POST', payload)).status).toBe(409)
  expect(
    (await call(`reservations/${reservation.id}/cancel`, 'POST')).status,
  ).toBe(404)
  const cancellation = await worker.fetch(
    new Request(
      `${origin}/api/reservations/${reservation.id}/cancellation-requests`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Змінилися плани' }),
      },
    ),
    env,
  )
  expect(cancellation.status).toBe(409)
  expect((await call(`blocks/${reservation.id}`, 'DELETE')).status).toBe(200)
  const after = await state()
  expect(after[0]).toMatchObject({
    kind: 'block',
    status: 'cancelled',
    description: payload.reason,
    idempotency_key: key,
  })
  expect((await call(`blocks/${reservation.id}`, 'DELETE')).status).toBe(200)
  expect(
    (await call('blocks', 'POST', payload, { 'Idempotency-Key': key })).status,
  ).toBe(201)
  expect(await state()).toEqual(after)
  expect((await publicRows()).reservations).toHaveLength(0)
  expect((await book()).status).toBe(201)
  expect((await call('blocks/missing', 'DELETE')).status).toBe(404)
})
test('invalid ranges and dates use booking rules; adjacent blocks are allowed', async () => {
  for (const patch of [
    { endTime: '12:00' },
    { startTime: '12:15' },
    { startTime: '07:30' },
    { endTime: '22:30' },
    { date: '2026-02-30' },
    { date: '2026-11-20' },
    { date: '2026-10-18' },
    { reason: 'x'.repeat(1001) },
  ])
    expect(
      (await call('blocks', 'POST', { ...payload, ...patch })).status,
    ).toBe(400)
  expect(await state()).toHaveLength(0)
  expect((await book()).status).toBe(201)
  expect((await call('blocks', 'POST', payload)).status).toBe(409)
  expect(
    (
      await call('blocks', 'POST', {
        ...payload,
        startTime: '14:00',
        endTime: '14:30',
      })
    ).status,
  ).toBe(201)
})
test('concurrent public bookings and blocks produce exactly one occupied interval', async () => {
  const responses = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      i % 2 ? book() : call('blocks', 'POST', payload),
    ),
  )
  expect(responses.filter((response) => response.status === 201)).toHaveLength(
    1,
  )
  expect(responses.filter((response) => response.status === 409)).toHaveLength(
    15,
  )
  expect(await state()).toHaveLength(1)
  expect((await publicRows()).reservations).toHaveLength(1)
})
test('manual cancellation rolls back if pending request resolution fails', async () => {
  const { reservation } = (await (await book()).json()) as {
    reservation: { id: string }
  }
  await env.DB.prepare(
    "INSERT INTO cancellation_requests (id,reservation_id,reason) VALUES ('pending',?,'Змінилися плани')",
  )
    .bind(reservation.id)
    .run()
  await env.DB.prepare(
    "CREATE TRIGGER fail_review BEFORE UPDATE ON cancellation_requests BEGIN SELECT RAISE(ABORT, 'private'); END",
  ).run()
  const before = await state()
  try {
    expect(
      (await call(`reservations/${reservation.id}/cancel`, 'POST')).status,
    ).toBe(500)
    expect(await state()).toEqual(before)
    expect(
      (await env.DB.prepare('SELECT status FROM cancellation_requests').first())
        ?.status,
    ).toBe('pending')
  } finally {
    await env.DB.prepare('DROP TRIGGER fail_review').run()
  }
})

test('manual cancellation races with reviews and public requests without leaving pending requests', async () => {
  for (const action of ['approve', 'reject', 'new-request']) {
    const startTime =
      action === 'approve' ? '08:00' : action === 'reject' ? '09:00' : '10:00'
    const response = await worker.fetch(
      new Request(`${origin}/api/reservations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          date: payload.date,
          startTime,
          endTime: startTime.replace(':00', ':30'),
          nameOrApartment: 'Квартира 12',
        }),
      }),
      env,
    )
    const { reservation } = (await response.json()) as {
      reservation: { id: string }
    }
    if (action !== 'new-request')
      await env.DB.prepare(
        'INSERT INTO cancellation_requests (id,reservation_id,reason) VALUES (?,?,?)',
      )
        .bind(action, reservation.id, 'Змінилися плани')
        .run()
    await Promise.all([
      call(`reservations/${reservation.id}/cancel`, 'POST'),
      action === 'new-request'
        ? worker.fetch(
            new Request(
              `${origin}/api/reservations/${reservation.id}/cancellation-requests`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: 'Змінилися плани' }),
              },
            ),
            env,
          )
        : call(`cancellation-requests/${action}/${action}`, 'POST'),
    ])
    expect(
      (
        await env.DB.prepare('SELECT status FROM reservations WHERE id = ?')
          .bind(reservation.id)
          .first()
      )?.status,
    ).toBe('cancelled')
    expect(
      await env.DB.prepare(
        "SELECT id FROM cancellation_requests WHERE reservation_id = ? AND status = 'pending'",
      )
        .bind(reservation.id)
        .all(),
    ).toMatchObject({ results: [] })
  }
})

test('concurrent technical block creation/removal logs each committed transition once', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const key = crypto.randomUUID()
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      call('blocks', 'POST', payload, { 'Idempotency-Key': key }),
    ),
  )
  expect(responses.every((r) => r.status === 201)).toBe(true)
  const { reservation } = (await responses[0].json()) as {
    reservation: { id: string }
  }
  const removed = await Promise.all(
    Array.from({ length: 8 }, () => call(`blocks/${reservation.id}`, 'DELETE')),
  )
  expect(removed.every((r) => r.status === 200)).toBe(true)
  expect(info.mock.calls).toEqual([
    [{ event: 'technical_block.created', outcome: 'success' }],
    [{ event: 'technical_block.removed', outcome: 'success' }],
  ])
  expect((await state())[0].status).toBe('cancelled')
})
