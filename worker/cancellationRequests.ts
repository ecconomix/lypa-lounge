function error(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status })
}

export async function cancellationRequests(
  request: Request,
  db: D1Database,
  reservationId: string,
): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json(
      { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } },
      { status: 405, headers: { Allow: 'POST' } },
    )
  }
  if (
    request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return error(
      'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type must be application/json',
      415,
    )

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return error(
      'INVALID_REASON',
      'Explanation must contain 10–1000 characters',
      400,
    )
  }
  const fields =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  const reason = typeof fields?.reason === 'string' ? fields.reason.trim() : ''
  if (
    !fields ||
    Object.keys(fields).some((key) => key !== 'reason') ||
    reason.length < 10 ||
    reason.length > 1000 ||
    !/[\p{L}\p{N}]/u.test(reason) ||
    reason.includes('\0')
  )
    return error(
      'INVALID_REASON',
      'Explanation must contain 10–1000 characters',
      400,
    )

  try {
    const now = new Date()
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Kyiv',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((value) => value.type === type)!.value
    const today = `${part('year')}-${part('month')}-${part('day')}`
    const time = `${part('hour')}:${part('minute')}`
    // Public IDs identify a booking, never authorize cancellation. Eligibility and
    // insertion are one write; the partial unique index arbitrates concurrent POSTs.
    const [insert, lookup] = await db.batch([
      db
        .prepare(
          `INSERT INTO cancellation_requests (id, reservation_id, reason, created_at)
        SELECT ?, id, ?, ? FROM reservations
        WHERE id = ? AND kind = 'booking' AND status = 'active' AND (date > ? OR (date = ? AND end_time > ?))
        ON CONFLICT(reservation_id) WHERE status = 'pending' DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          reason,
          Math.floor(now.getTime() / 1000),
          reservationId,
          today,
          today,
          time,
        ),
      db
        .prepare('SELECT id FROM reservations WHERE id = ?')
        .bind(reservationId),
    ])
    if (insert.meta.changes === 1)
      return Response.json({ status: 'pending' }, { status: 201 })
    if (!lookup.results.length)
      return error('RESERVATION_NOT_FOUND', 'Reservation not found', 404)
    // One generic conflict avoids disclosing existing request or review details.
    return error(
      'CANCELLATION_REQUEST_CONFLICT',
      'Request already pending or reservation is ineligible',
      409,
    )
  } catch {
    // Do not log explanations or private request data.
    return error('INTERNAL_ERROR', 'Internal server error', 500)
  }
}
