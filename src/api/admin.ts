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

export interface PendingCancellation {
  id: string
  reservationId: string
  date: string
  startTime: string
  endTime: string
  nameOrApartment: string
  reason: string
  createdAt: number
}

export async function fetchCancellationRequests(
  signal: AbortSignal,
): Promise<PendingCancellation[]> {
  const response = await fetch('/api/admin/cancellation-requests', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new AdminError(response.status)
  const body: unknown = await response.json()
  if (
    !body ||
    typeof body !== 'object' ||
    !('requests' in body) ||
    !Array.isArray(body.requests)
  )
    throw new Error('Invalid review response')
  return body.requests.map((value: unknown) => {
    if (!value || typeof value !== 'object')
      throw new Error('Invalid review response')
    const row = value as Record<string, unknown>
    if (
      ![
        'id',
        'reservationId',
        'date',
        'startTime',
        'endTime',
        'nameOrApartment',
        'reason',
      ].every((key) => typeof row[key] === 'string') ||
      typeof row.createdAt !== 'number' ||
      !Number.isFinite(row.createdAt)
    )
      throw new Error('Invalid review response')
    return row as unknown as PendingCancellation
  })
}

export async function reviewCancellation(
  id: string,
  action: 'approve' | 'reject',
): Promise<void> {
  const response = await fetch(
    `/api/admin/cancellation-requests/${encodeURIComponent(id)}/${action}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  )
  if (!response.ok) throw new AdminError(response.status)
  const body: unknown = await response.json()
  const review =
    body && typeof body === 'object' && 'request' in body ? body.request : null
  if (
    !review ||
    typeof review !== 'object' ||
    !('id' in review) ||
    review.id !== id ||
    !('status' in review) ||
    review.status !== (action === 'approve' ? 'approved' : 'rejected')
  )
    throw new Error('Invalid review response')
}
