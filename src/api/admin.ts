export class AdminError extends Error {
  status: number
  constructor(status: number) {
    super('Admin request failed')
    this.status = status
  }
}

export async function adminRequest(
  action: 'session' | 'login' | 'logout',
  password?: string,
): Promise<{ authenticated: boolean; expiresAt?: number }> {
  const response = await fetch(`/api/admin/${action}`, {
    method: action === 'session' ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    ...(action !== 'session' && {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action === 'login' ? { password } : {}),
    }),
  })
  if (!response.ok) throw new AdminError(response.status)
  const body: unknown = await response.json()
  if (
    !body ||
    typeof body !== 'object' ||
    !('authenticated' in body) ||
    typeof body.authenticated !== 'boolean'
  )
    throw new Error('Invalid admin response')
  if (
    body.authenticated &&
    (!('expiresAt' in body) ||
      typeof body.expiresAt !== 'number' ||
      !Number.isFinite(body.expiresAt))
  )
    throw new Error('Invalid admin response')
  return body as { authenticated: boolean; expiresAt?: number }
}
