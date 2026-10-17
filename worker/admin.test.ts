import { readFile } from 'node:fs/promises'
import { URL as NodeURL } from 'node:url'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { getPlatformProxy, type PlatformProxy } from 'wrangler'
import worker from './index.ts'
import { requireAdmin, type AdminEnv } from './admin.ts'

let platform: PlatformProxy<Env>
let env: AdminEnv
const origin = 'https://lounge.example'
const password = 'test-only-long-admin-password'
beforeAll(async () => {
  platform = await getPlatformProxy<Env>({
    persist: false,
    remoteBindings: false,
  })
  env = { ...platform.env, ADMIN_PASSWORD: password, ADMIN_ORIGIN: origin }
  for (const file of ['0001_create_reservations.sql', '0002_admin_auth.sql']) {
    const migration = await readFile(
      new NodeURL(`../migrations/${file}`, import.meta.url),
      'utf8',
    )
    for (const sql of migration
      .replace(/--[^\n]*/g, '')
      .split(';')
      .filter((sql) => sql.trim()))
      await env.DB.prepare(sql).run()
  }
})
beforeEach(async () => {
  vi.useRealTimers()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions'),
    env.DB.prepare('DELETE FROM admin_login_limits'),
  ])
})
afterAll(async () => {
  vi.useRealTimers()
  await platform?.dispose()
})
function request(
  action: string,
  options: {
    body?: unknown
    cookie?: string
    headers?: Record<string, string>
    method?: string
  } = {},
) {
  const method = options.method ?? (action === 'session' ? 'GET' : 'POST')
  return worker.fetch(
    new Request(`${origin}/api/admin/${action}`, {
      method,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: options.cookie ?? '',
        ...options.headers,
      },
      ...(!['GET', 'HEAD'].includes(method) && {
        body: JSON.stringify(options.body ?? { password }),
      }),
    }),
    env,
  )
}
async function login() {
  const response = await request('login')
  expect(response.status).toBe(200)
  return response.headers.get('Set-Cookie')!.split(';')[0]
}
test('successful login stores only a hash, restores session and sets seven-day private cookie', async () => {
  const response = await request('login')
  expect(response.status).toBe(200)
  const cookie = response.headers.get('Set-Cookie')!
  expect(cookie).toMatch(/^lypa_admin=[a-f0-9]{64};/)
  for (const attribute of [
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/api/admin',
    'Max-Age=604800',
  ])
    expect(cookie).toContain(attribute)
  expect(cookie).not.toContain('Domain=')
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const body = (await response.json()) as { expiresAt: number }
  const row = await env.DB.prepare('SELECT * FROM admin_sessions').first<{
    token_hash: string
    expires_at: number
  }>()
  expect(row?.token_hash).toHaveLength(64)
  expect(cookie).not.toContain(row!.token_hash)
  expect(row?.expires_at).toBe(body.expiresAt)
  const session = await request('session', { cookie: cookie.split(';')[0] })
  expect(await session.json()).toEqual({
    authenticated: true,
    expiresAt: body.expiresAt,
  })
})
test('incorrect, missing and malformed passwords return identical generic errors', async () => {
  for (const body of [
    { password: 'incorrect' },
    {},
    { password: null },
    { password: '' },
  ]) {
    const response = await request('login', { body })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
    expect(response.headers.has('Set-Cookie')).toBe(false)
  }
})
test('persistent per-IP cap admits only five concurrent attempts and resets after window', async () => {
  const responses = await Promise.all(
    Array.from({ length: 12 }, () =>
      request('login', { body: { password: 'wrong' } }),
    ),
  )
  expect(responses.filter((r) => r.status === 401)).toHaveLength(5)
  expect(responses.filter((r) => r.status === 429)).toHaveLength(7)
  expect((await request('login')).status).toBe(429)
  vi.setSystemTime(Date.now() + 901_000)
  expect((await request('login')).status).toBe(200)
})
test('global cap limits distributed attempts', async () => {
  for (let i = 0; i < 30; i++)
    expect(
      (
        await request('login', {
          body: {},
          headers: { 'CF-Connecting-IP': `192.0.2.${i}` },
        })
      ).status,
    ).toBe(401)
  const response = await request('login', {
    headers: { 'CF-Connecting-IP': '192.0.2.200' },
  })
  expect(response.status).toBe(429)
  expect(response.headers.get('Retry-After')).toBe('900')
})
test('missing, invalid, unknown and expired sessions all deny access', async () => {
  for (const cookie of [
    '',
    'lypa_admin=invalid',
    `lypa_admin=${'a'.repeat(64)}`,
  ]) {
    const response = await request('session', { cookie })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  }
  const cookie = await login()
  const row = await env.DB.prepare(
    'SELECT expires_at FROM admin_sessions',
  ).first<{ expires_at: number }>()
  vi.setSystemTime(row!.expires_at * 1000)
  expect((await request('session', { cookie })).status).toBe(401)
})
test('logout revokes server session, clears cookie and is idempotent', async () => {
  const cookie = await login()
  for (const value of [cookie, cookie, '', `lypa_admin=${'b'.repeat(64)}`]) {
    const response = await request('logout', { cookie: value })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ authenticated: false })
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0')
  }
  expect((await request('session', { cookie })).status).toBe(401)
  expect(
    await env.DB.prepare('SELECT * FROM admin_sessions').first(),
  ).toBeNull()
})
test('CSRF and content type checks protect login, logout and reusable mutation guard', async () => {
  const cookie = await login()
  for (const action of ['login', 'logout']) {
    for (const Origin of ['', 'null', 'https://attacker.example'])
      expect(
        (await request(action, { cookie, headers: { Origin } })).status,
      ).toBe(403)
    for (const type of ['', 'text/plain', 'application/x-www-form-urlencoded'])
      expect(
        (await request(action, { cookie, headers: { 'Content-Type': type } }))
          .status,
      ).toBe(415)
  }
  expect((await request('session', { cookie })).status).toBe(200)
  const mutation = new Request(`${origin}/api/admin/future`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example', Cookie: cookie },
  })
  expect((await requireAdmin(mutation, env))?.status).toBe(403)
  expect((await request('future', { method: 'POST', body: {} })).status).toBe(
    401,
  )
})
test('rotation revokes previous cookie and unknown admin APIs require authentication', async () => {
  const cookie = await login()
  expect((await request('login', { cookie })).status).toBe(200)
  expect((await request('session', { cookie })).status).toBe(401)
  expect((await request('future', { method: 'GET' })).status).toBe(401)
})
test('configuration fails closed, local cookies allow HTTP only on loopback', async () => {
  const req = () => new Request(`${origin}/api/admin/session`)
  expect(
    (
      await worker.fetch(req(), {
        ...env,
        ADMIN_PASSWORD: undefined,
      } as typeof env)
    ).status,
  ).toBe(503)
  expect(
    (
      await worker.fetch(req(), {
        ...env,
        ADMIN_ORIGIN: 'http://lounge.example',
      } as typeof env)
    ).status,
  ).toBe(503)
  const response = await worker.fetch(
    new Request('http://localhost:8787/api/admin/login', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
    }),
    { ...env, ADMIN_ORIGIN: 'http://localhost:5173' } as typeof env,
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('Set-Cookie')).not.toContain('Secure')
})

test('malformed and oversized login bodies fail safely without creating sessions', async () => {
  for (const body of ['{', JSON.stringify({ password: 'x'.repeat(4096) })]) {
    const response = await worker.fetch(
      new Request(`${origin}/api/admin/login`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body,
      }),
      env,
    )
    expect(response.status).toBe(401)
    expect(response.headers.has('Set-Cookie')).toBe(false)
  }
  expect(
    await env.DB.prepare('SELECT * FROM admin_sessions').first(),
  ).toBeNull()
})

test('rejects insecure production transport and unsupported endpoint methods', async () => {
  const response = await worker.fetch(
    new Request('http://lounge.example/api/admin/session'),
    env,
  )
  expect(response.status).toBe(403)
  for (const [action, method, allowed] of [
    ['login', 'GET', 'POST'],
    ['logout', 'GET', 'POST'],
    ['session', 'POST', 'GET'],
  ]) {
    const response = await request(action, { method })
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe(allowed)
  }
})

test('database failures do not expose or log authentication inputs', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const db = {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: vi.fn().mockRejectedValue(new Error(`sensitive ${password}`)),
  } as unknown as D1Database
  const response = await worker.fetch(
    new Request(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
    { ...env, DB: db },
  )
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ error: 'Authentication unavailable' })
  expect(log).not.toHaveBeenCalled()
})
