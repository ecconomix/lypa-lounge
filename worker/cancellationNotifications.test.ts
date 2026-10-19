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

let platform: PlatformProxy<Env>
let env: Parameters<typeof worker.fetch>[1]
let cookie: string
const origin = 'https://lounge.example'
const reason = '<b>Приватна причина & "плани"</b>'
const name = '<i>Квартира & "12"</i>'
let tasks: Promise<unknown>[]
let fetchMock: ReturnType<typeof vi.fn>
let context: {
  waitUntil: ReturnType<typeof vi.fn<(task: Promise<unknown>) => void>>
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
    TELEGRAM_BOT_TOKEN: 'test-only-token',
    TELEGRAM_ADMIN_CHAT_ID: 'test-only-admin',
    TELEGRAM_GROUP_CHAT_ID: 'test-only-group',
  }
  for (const file of [
    '0001_create_reservations.sql',
    '0002_admin_auth.sql',
    '0003_cancellation_requests.sql',
    '0004_reservation_kind.sql',
  ]) {
    const migration = await readFile(
      new NodeURL(`../migrations/${file}`, import.meta.url),
      'utf8',
    )
    for (const sql of migration
      .replace(/--[^\n]*/g, '')
      .split(';')
      .filter((part) => part.trim()))
      await env.DB.prepare(sql).run()
  }
  const response = await worker.fetch(
    new Request(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    }),
    env,
  )
  cookie = response.headers.get('Set-Cookie')!.split(';')[0]
})
afterAll(async () => {
  await platform?.dispose()
})
beforeEach(async () => {
  vi.setSystemTime(new Date('2026-10-19T09:00:00Z'))
  tasks = []
  context = {
    waitUntil: vi.fn((task: Promise<unknown>) => {
      tasks.push(task)
    }),
  }
  fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM cancellation_requests'),
    env.DB.prepare('DELETE FROM reservations'),
    env.DB.prepare(
      `INSERT INTO reservations
      (id, date, start_time, end_time, name_or_apartment, description, idempotency_key, created_at, updated_at)
      VALUES ('booking', '2026-10-20', '12:00', '14:00', ?, 'private-description', 'consumed-key', 100, 100)`,
    ).bind(name),
  ])
})
afterEach(async () => {
  await Promise.all(tasks)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function call(
  path: string,
  body: unknown = {},
  bindings = env,
  headers: Record<string, string> = {},
) {
  return worker.fetch(
    new Request(`${origin}/api/${path}`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: cookie,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    bindings,
    context,
  )
}
const create = (bindings = env, body: unknown = { reason }) =>
  call('reservations/booking/cancellation-requests', body, bindings)
const cancel = (bindings = env, headers: Record<string, string> = {}) =>
  call('admin/reservations/booking/cancel', {}, bindings, headers)
const review = (
  action = 'approve',
  bindings = env,
  headers: Record<string, string> = {},
) => call(`admin/cancellation-requests/review/${action}`, {}, bindings, headers)
async function pending() {
  await env.DB.prepare(
    `INSERT INTO cancellation_requests (id, reservation_id, reason, created_at)
    VALUES ('review', 'booking', ?, 101)`,
  )
    .bind(reason)
    .run()
}
async function state() {
  return {
    booking: await env.DB.prepare('SELECT * FROM reservations').first(),
    request: await env.DB.prepare(
      'SELECT * FROM cancellation_requests',
    ).first(),
  }
}
function messages() {
  return fetchMock.mock.calls.map(
    (args) =>
      JSON.parse(args[1].body) as {
        chat_id: string
        text: string
        parse_mode: string
      },
  )
}
function expectGroupNotification() {
  expect(context.waitUntil).toHaveBeenCalledTimes(1)
  expect(messages()).toEqual([
    {
      chat_id: 'test-only-group',
      parse_mode: 'HTML',
      text: expect.any(String),
    },
  ])
  const text = messages()[0].text
  expect(text).toContain('вівторок, 20 жовтня 2026 р.')
  expect(text).toContain('12:00–14:00')
  expect(text).toContain('Цей час знову доступний для бронювання.')
  expect(text).toContain(
    '<a href="https://lounge.example/">Відкрити календар</a>',
  )
  expect(text).not.toMatch(
    /Приватна|Причина|Квартира|private-description|booking|review|consumed-key/,
  )
}

test('new request commits before nonblocking admin delivery, escapes private content and preserves API shape', async () => {
  let finish!: (response: Response) => void
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
  )
  try {
    const response = await create(env, { reason: `  ${reason}  ` })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ status: 'pending' })
    expect((await state()).request).toMatchObject({ reason, status: 'pending' })
    expect((await state()).booking?.status).toBe('active')
    expect(context.waitUntil).toHaveBeenCalledTimes(1)
    expect(messages()).toEqual([
      {
        chat_id: 'test-only-admin',
        parse_mode: 'HTML',
        text: expect.any(String),
      },
    ])
    expect(messages()[0].text).toContain('вівторок, 20 жовтня 2026 р.')
    expect(messages()[0].text).toContain('12:00–14:00')
    expect(messages()[0].text).toContain(
      '&lt;i&gt;Квартира &amp; &quot;12&quot;&lt;/i&gt;',
    )
    expect(messages()[0].text).toContain(
      '&lt;b&gt;Приватна причина &amp; &quot;плани&quot;&lt;/b&gt;',
    )
    expect(messages()[0].text).toContain(
      '<a href="https://lounge.example/admin">Переглянути запити</a>',
    )
  } finally {
    finish?.(Response.json({ ok: true }))
  }
})
test('concurrent and repeated requests schedule one private notification', async () => {
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => create()),
  )
  expect(responses.filter((r) => r.status === 201)).toHaveLength(1)
  expect(responses.filter((r) => r.status === 409)).toHaveLength(11)
  expect((await create()).status).toBe(409)
  expect(messages()).toHaveLength(1)
  expect(messages()[0].chat_id).toBe('test-only-admin')
  expect(context.waitUntil).toHaveBeenCalledTimes(1)
})
for (const path of ['approval', 'direct'] as const) {
  test(`${path} cancellation notifies group once, even with concurrent and repeated calls`, async () => {
    if (path === 'approval') await pending()
    const operation = path === 'approval' ? () => review() : () => cancel()
    const responses = await Promise.all(Array.from({ length: 12 }, operation))
    expect(responses.every((r) => r.status === 200)).toBe(true)
    const firstBody = await responses[0].json()
    expect(firstBody).toEqual(
      path === 'approval'
        ? {
            request: {
              id: 'review',
              status: 'approved',
              reviewedAt: expect.any(Number),
            },
          }
        : { reservation: { id: 'booking', status: 'cancelled' } },
    )
    expect(await (await operation()).json()).toEqual(firstBody)
    expect((await state()).booking?.status).toBe('cancelled')
    expectGroupNotification()
  })
}
test.each(['approve-first', 'direct-first', 'concurrent'])(
  'approval and direct cancellation share one transition: %s',
  async (order) => {
    await pending()
    if (order === 'concurrent') {
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) => (i % 2 ? review() : cancel())),
      )
      expect(responses.every((r) => r.status === 200)).toBe(true)
    } else if (order === 'approve-first') {
      expect((await review()).status).toBe(200)
      expect((await cancel()).status).toBe(200)
    } else {
      expect((await cancel()).status).toBe(200)
      expect((await review()).status).toBe(200)
    }
    expect((await state()).request?.status).toBe('approved')
    expectGroupNotification()
  },
)
test('rejection and conflicting approval notify nobody; a fresh request after rejection can notify admin', async () => {
  await pending()
  expect((await review('reject')).status).toBe(200)
  expect((await review('reject')).status).toBe(200)
  expect((await review()).status).toBe(409)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(context.waitUntil).not.toHaveBeenCalled()
  expect((await state()).booking?.status).toBe('active')
  expect((await create()).status).toBe(201)
  expect(messages().map((m) => m.chat_id)).toEqual(['test-only-admin'])
})
test('competing approval and rejection only notify if a cancellation wins', async () => {
  await pending()
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => review(i % 2 ? 'approve' : 'reject')),
  )
  const approved = (await state()).request?.status === 'approved'
  expect(messages()).toHaveLength(approved ? 1 : 0)
  if (approved) expectGroupNotification()
})
test('invalid, missing, ineligible and conflicting requests never notify', async () => {
  expect((await create(env, { reason: 'short' })).status).toBe(400)
  expect(
    (await call('reservations/missing/cancellation-requests', { reason }))
      .status,
  ).toBe(404)
  expect(
    (await call('admin/cancellation-requests/missing/approve')).status,
  ).toBe(404)
  expect((await call('admin/reservations/missing/cancel')).status).toBe(404)
  await pending()
  expect((await create()).status).toBe(409)
  await env.DB.prepare("UPDATE reservations SET status = 'cancelled'").run()
  expect((await create()).status).toBe(409)
  expect((await review()).status).toBe(409)
  await env.DB.prepare(
    "UPDATE reservations SET status = 'active', date = '2026-10-18'",
  ).run()
  expect((await create()).status).toBe(409)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(context.waitUntil).not.toHaveBeenCalled()
})
test('block removal sends no cancellation notification', async () => {
  await env.DB.prepare("UPDATE reservations SET kind = 'block'").run()
  const response = await worker.fetch(
    new Request(`${origin}/api/admin/blocks/booking`, {
      method: 'DELETE',
      headers: {
        Origin: origin,
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }),
    env,
    context,
  )
  expect(response.status).toBe(200)
  expect(fetchMock).not.toHaveBeenCalled()
})
test('authorization and CSRF guards prevent both cancellation paths and notifications', async () => {
  await pending()
  const before = await state()
  for (const operation of [
    review,
    (_action: string, bindings: typeof env, headers: Record<string, string>) =>
      cancel(bindings, headers),
  ]) {
    expect((await operation('approve', env, { Cookie: '' })).status).toBe(401)
    expect(
      (await operation('approve', env, { Origin: 'https://attacker.example' }))
        .status,
    ).toBe(403)
    expect(
      (await operation('approve', env, { 'Content-Type': 'text/plain' }))
        .status,
    ).toBe(415)
  }
  expect(await state()).toEqual(before)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(context.waitUntil).not.toHaveBeenCalled()
})
for (const path of ['request', 'approval', 'direct'] as const) {
  const operation = (bindings = env) =>
    path === 'request'
      ? create(bindings)
      : path === 'approval'
        ? review('approve', bindings)
        : cancel(bindings)
  test.each(['network', 'api', 'scheduling'])(
    `${path}: %s failure preserves committed state and safe logs`,
    async (failure) => {
      if (path === 'approval') await pending()
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      if (failure === 'network')
        fetchMock.mockRejectedValue(
          new Error(`${env.TELEGRAM_BOT_TOKEN} ${reason}`),
        )
      if (failure === 'api')
        fetchMock.mockResolvedValue(
          Response.json({ ok: false, description: reason }),
        )
      if (failure === 'scheduling')
        context.waitUntil.mockImplementation(() => {
          throw new Error(reason)
        })
      const response = await operation()
      expect(response.status).toBe(path === 'request' ? 201 : 200)
      await Promise.all(tasks)
      expect((await state()).booking?.status).toBe(
        path === 'request' ? 'active' : 'cancelled',
      )
      if (path !== 'direct')
        expect((await state()).request?.status).toBe(
          path === 'request' ? 'pending' : 'approved',
        )
      expect(log.mock.calls).toEqual([
        [
          {
            event: 'telegram.failed',
            outcome: 'failure',
            notificationType:
              path === 'request'
                ? 'cancellation_requested'
                : 'reservation_cancelled',
            reason: failure === 'scheduling' ? 'scheduling' : 'delivery',
          },
        ],
      ])
      await operation()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )
  test.each(['token', 'destination', 'blank'])(
    `${path}: missing %s configuration skips delivery`,
    async (missing) => {
      if (path === 'approval') await pending()
      const destination =
        path === 'request' ? 'TELEGRAM_ADMIN_CHAT_ID' : 'TELEGRAM_GROUP_CHAT_ID'
      const bindings = {
        ...env,
        ...(missing === 'token'
          ? { TELEGRAM_BOT_TOKEN: undefined }
          : { [destination]: missing === 'blank' ? '  ' : undefined }),
      }
      expect((await operation(bindings)).status).toBe(
        path === 'request' ? 201 : 200,
      )
      expect(fetchMock).not.toHaveBeenCalled()
      expect(context.waitUntil).not.toHaveBeenCalled()
    },
  )
  test(`${path}: transaction failure never schedules delivery`, async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    if (path === 'approval') await pending()
    const before = await state()
    const bindings = {
      ...env,
      DB: {
        prepare: env.DB.prepare.bind(env.DB),
        batch: vi.fn().mockRejectedValue(new Error(reason)),
      } as unknown as D1Database,
    }
    expect((await operation(bindings)).status).toBe(500)
    expect(info).not.toHaveBeenCalled()
    expect(await state()).toEqual(before)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(context.waitUntil).not.toHaveBeenCalled()
  })
}
test('failed cancellation transaction rolls back review and never notifies', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  await pending()
  await env.DB.prepare(
    `CREATE TRIGGER fail_cancel BEFORE UPDATE OF status ON reservations
    BEGIN SELECT RAISE(ABORT, 'test failure'); END`,
  ).run()
  const before = await state()
  try {
    expect((await review()).status).toBe(500)
    expect((await cancel()).status).toBe(500)
    expect(info).not.toHaveBeenCalled()
    expect(await state()).toEqual(before)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(context.waitUntil).not.toHaveBeenCalled()
  } finally {
    await env.DB.prepare('DROP TRIGGER fail_cancel').run()
  }
})

test('cancellation request logs once for concurrent writes and only after commit', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  await Promise.all(Array.from({ length: 8 }, () => create()))
  await Promise.all(tasks)
  expect((await state()).request?.status).toBe('pending')
  expect(info.mock.calls).toEqual([
    [{ event: 'cancellation.requested', outcome: 'success' }],
    [
      {
        event: 'telegram.sent',
        outcome: 'success',
        notificationType: 'cancellation_requested',
      },
    ],
  ])
})

test.each(['approve', 'reject'] as const)(
  'concurrent %s logs exactly the committed review and no private fields',
  async (action) => {
    await pending()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await Promise.all(Array.from({ length: 12 }, () => review(action)))
    await review(action)
    await Promise.all(tasks)
    expect((await state()).request?.status).toBe(
      action === 'approve' ? 'approved' : 'rejected',
    )
    expect(info.mock.calls).toEqual([
      [
        {
          event:
            action === 'approve'
              ? 'cancellation.approved'
              : 'cancellation.rejected',
          outcome: 'success',
        },
      ],
      ...(action === 'approve'
        ? [
            [
              {
                event: 'telegram.sent',
                outcome: 'success',
                notificationType: 'reservation_cancelled',
              },
            ],
          ]
        : []),
    ])
  },
)

test('direct cancellation and approval racing log one approval transition', async () => {
  await pending()
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => (i % 2 ? review() : cancel())),
  )
  await Promise.all(tasks)
  expect((await state()).request?.status).toBe('approved')
  expect(info.mock.calls).toEqual([
    [{ event: 'cancellation.approved', outcome: 'success' }],
    [
      {
        event: 'telegram.sent',
        outcome: 'success',
        notificationType: 'reservation_cancelled',
      },
    ],
  ])
})

test('logging failures preserve cancellation writes and Telegram delivery', async () => {
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {
      throw new Error('console unavailable')
    })
  }
  expect((await create()).status).toBe(201)
  const id = (await state()).request!.id
  expect((await call(`admin/cancellation-requests/${id}/approve`)).status).toBe(
    200,
  )
  await Promise.all(tasks)
  expect((await state()).booking?.status).toBe('cancelled')
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
