import type { CancellationNotification } from './telegramMessages.ts'
import { bookingControls } from './bookingControls.ts'
import { cancellationReview } from './cancellationReview.ts'

/** Secrets are supplied by Wrangler, never by Vite or public configuration. */
export interface AdminEnv {
  DB: D1Database
  ADMIN_PASSWORD?: string
  ADMIN_ORIGIN?: string
}

const lifetime = 7 * 24 * 60 * 60
const windowSeconds = 15 * 60
const cookieName = 'lypa_admin'
const encoder = new TextEncoder()

function reply(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', Vary: 'Cookie' },
  })
}
const denied = () => reply(401, { error: 'Authentication required' })

function configuredOrigin(env: AdminEnv): URL | null {
  try {
    const url = new URL(env.ADMIN_ORIGIN ?? '')
    if (url.origin !== env.ADMIN_ORIGIN) return null
    if (
      url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      )
    )
      return null
    return url
  } catch {
    return null
  }
}

/** Call before every future state-changing admin operation, including login. */
export function validateAdminMutation(
  request: Request,
  env: AdminEnv,
): Response | null {
  if (request.headers.get('Origin') !== configuredOrigin(env)?.origin)
    return reply(403, { error: 'Request not allowed' })
  if (
    request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return reply(415, { error: 'Content-Type must be application/json' })
  return null
}

function cookie(token: string, secure: boolean, maxAge = lifetime): string {
  return `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function sessionToken(request: Request): string | null {
  const values = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName}=`))
  if (values.length !== 1) return null
  const token = values[0].slice(cookieName.length + 1)
  return /^[0-9a-f]{64}$/.test(token) ? token : null
}

/** Reuse for all future protected routes. Mutations also receive CSRF checks. */
export async function requireAdmin(
  request: Request,
  env: AdminEnv,
): Promise<Response | null> {
  if (!['GET', 'HEAD'].includes(request.method)) {
    const invalid = validateAdminMutation(request, env)
    if (invalid) return invalid
  }
  const token = sessionToken(request)
  if (!token) return denied()
  const session = await env.DB.prepare(
    'SELECT expires_at FROM admin_sessions WHERE token_hash = ? AND expires_at > ?',
  )
    .bind(await hash(token), Math.floor(Date.now() / 1000))
    .first()
  return session ? null : denied()
}

async function consumeAttempt(
  db: D1Database,
  ip: string,
  now: number,
): Promise<boolean> {
  // Expire stale buckets and never persist raw IP addresses. Both limits are consumed
  // atomically, before verification, so concurrent requests cannot exceed a cap.
  const buckets = [
    ['global', 30],
    [`ip:${await hash(ip)}`, 5],
  ] as const
  const results = await db.batch([
    db
      .prepare('DELETE FROM admin_login_limits WHERE expires_at <= ?')
      .bind(now),
    ...buckets.map(([bucket, limit]) =>
      db
        .prepare(
          `
      INSERT INTO admin_login_limits (bucket, attempts, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1
      WHERE attempts < ? RETURNING attempts
    `,
        )
        .bind(bucket, now + windowSeconds, limit),
    ),
  ])
  return results.slice(1).every((result) => result.results.length === 1)
}

async function verifyPassword(
  password: string,
  expected: string,
): Promise<boolean> {
  // Native HMAC verification avoids JS string comparisons and length-dependent
  // comparisons. The ephemeral key is never stored; the password stays a secret.
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(expected),
  )
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(password))
}

export async function admin(
  request: Request,
  env: AdminEnv,
  onCancelled?: (reservation: CancellationNotification) => void,
): Promise<Response> {
  // Do not log exception objects here: auth inputs and tokens must stay private.
  try {
    const origin = configuredOrigin(env)
    if (
      !origin ||
      !env.ADMIN_PASSWORD ||
      env.ADMIN_PASSWORD.length < 16 ||
      env.ADMIN_PASSWORD.length > 1024
    )
      return reply(503, { error: 'Authentication unavailable' })
    const url = new URL(request.url)
    const secure = origin.protocol === 'https:' || url.protocol === 'https:'
    if (
      url.protocol !== 'https:' &&
      (origin.protocol === 'https:' ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      return reply(403, { error: 'Request not allowed' })
    const path = url.pathname
    const method = path === '/api/admin/session' ? 'GET' : 'POST'
    if (
      ['/api/admin/login', '/api/admin/logout', '/api/admin/session'].includes(
        path,
      ) &&
      request.method !== method
    ) {
      const response = reply(405, { error: 'Method not allowed' })
      response.headers.set('Allow', method)
      return response
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      const invalid = validateAdminMutation(request, env)
      if (invalid) return invalid
    }
    const now = Math.floor(Date.now() / 1000)
    if (path === '/api/admin/login') {
      // CF-Connecting-IP is provided by Cloudflare at the edge. Missing headers
      // share one local/fallback bucket; forwarded client headers are not trusted.
      if (
        !(await consumeAttempt(
          env.DB,
          request.headers.get('CF-Connecting-IP') ?? 'unknown',
          now,
        ))
      ) {
        const response = reply(429, { error: 'Authentication failed' })
        response.headers.set('Retry-After', String(windowSeconds))
        return response
      }
      // Stream with a hard limit, including requests without Content-Length.
      const reader = request.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 4096) {
            await reader.cancel()
            return denied()
          }
          chunks.push(value)
        }
      }
      let body: unknown
      try {
        body = JSON.parse(await new Blob(chunks).text())
      } catch {
        return denied()
      }
      const password =
        body && typeof body === 'object' && !Array.isArray(body)
          ? (body as Record<string, unknown>).password
          : undefined
      const validInput =
        typeof password === 'string' &&
        password.length > 0 &&
        password.length <= 1024
      const valid = await verifyPassword(
        validInput ? password : '',
        env.ADMIN_PASSWORD,
      )
      if (!validInput || !valid) return denied()
      const token = Array.from(
        crypto.getRandomValues(new Uint8Array(32)),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('')
      const oldToken = sessionToken(request)
      await env.DB.batch([
        env.DB.prepare(
          'DELETE FROM admin_sessions WHERE expires_at <= ? OR token_hash = ?',
        ).bind(now, oldToken ? await hash(oldToken) : ''),
        env.DB.prepare(
          'INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)',
        ).bind(await hash(token), now + lifetime),
      ])
      const response = reply(200, {
        authenticated: true,
        expiresAt: now + lifetime,
      })
      response.headers.set('Set-Cookie', cookie(token, secure))
      return response
    }
    if (path === '/api/admin/logout') {
      const token = sessionToken(request)
      if (token)
        await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?')
          .bind(await hash(token))
          .run()
      // Idempotent, identical result for absent, expired, and valid sessions.
      const response = reply(200, { authenticated: false })
      response.headers.set('Set-Cookie', cookie('', secure, 0))
      return response
    }
    const invalid = await requireAdmin(request, env)
    if (invalid) return invalid
    if (path === '/api/admin/session') {
      const session = await env.DB.prepare(
        'SELECT expires_at FROM admin_sessions WHERE token_hash = ? AND expires_at > ?',
      )
        .bind(await hash(sessionToken(request)!), now)
        .first<{ expires_at: number }>()
      if (!session) return denied()
      return reply(200, { authenticated: true, expiresAt: session.expires_at })
    }
    if (
      /^\/api\/admin\/(reservations|blocks)(?:\/[^/]+(?:\/cancel)?)?$/.test(
        path,
      )
    )
      return await bookingControls(request, env.DB, onCancelled)
    if (path === '/api/admin/cancellation-requests')
      return await cancellationReview(request, env.DB)
    const review =
      /^\/api\/admin\/cancellation-requests\/([^/]+)\/(approve|reject)$/.exec(
        path,
      )
    if (review)
      return await cancellationReview(
        request,
        env.DB,
        review[1],
        review[2],
        onCancelled,
      )
    return reply(404, { error: 'Not found' })
  } catch {
    return reply(500, { error: 'Authentication unavailable' })
  }
}
