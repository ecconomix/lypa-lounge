import { logEvent } from './logging.ts'
import type { CancellationNotification } from './telegramMessages.ts'
import { reservations } from './reservations.ts'

function reply(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', Vary: 'Cookie' },
  })
}

/** Only called behind requireAdmin, including its shared CSRF guard. */
export async function bookingControls(
  request: Request,
  db: D1Database,
  onCancelled?: (reservation: CancellationNotification) => void,
): Promise<Response> {
  const path = new URL(request.url).pathname
  const route =
    /^\/api\/admin\/(reservations|blocks)(?:\/([^/]+)(\/cancel)?)?$/.exec(path)!
  const [, collection, id, cancel] = route
  const kind = collection === 'blocks' ? 'block' : 'booking'
  if (id && (kind === 'block' ? !!cancel : !cancel))
    return reply(404, { error: 'Not found' })
  const allowed =
    !id && kind === 'block'
      ? ['GET', 'POST']
      : [!id ? 'GET' : kind === 'block' ? 'DELETE' : 'POST']
  if (!allowed.includes(request.method)) {
    const response = reply(405, { error: 'Method not allowed' })
    response.headers.set('Allow', allowed.join(', '))
    return response
  }
  try {
    if (!id && request.method === 'GET') {
      const { results } = await db
        .prepare(
          `SELECT id, date, start_time AS startTime,
        end_time AS endTime, name_or_apartment AS nameOrApartment,
        description, created_at AS createdAt FROM reservations
        WHERE status = 'active' AND kind = ? ORDER BY date, start_time, id`,
        )
        .bind(kind)
        .all()
      return reply(200, { [collection]: results })
    }
    if (!id) {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return reply(400, { error: 'Invalid block' })
      }
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return reply(400, { error: 'Invalid block' })
      const fields = body as Record<string, unknown>
      if (
        Object.keys(fields).some(
          (key) => !['date', 'startTime', 'endTime', 'reason'].includes(key),
        )
      )
        return reply(400, { error: 'Invalid block' })
      // Reuse booking normalization, Kyiv horizon, idempotency, and the exact same
      // conditional insert. The kind is a trusted argument, never public input.
      const response = await reservations(
        new Request(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify({
            date: fields.date,
            startTime: fields.startTime,
            endTime: fields.endTime,
            nameOrApartment: 'Технічне блокування',
            description: fields.reason,
          }),
        }),
        db,
        'block',
      )
      response.headers.set('Cache-Control', 'no-store')
      response.headers.set('Vary', 'Cookie')
      return response
    }
    const now = Math.floor(Date.now() / 1000)
    const statements = [
      db
        .prepare(
          `UPDATE reservations SET status = 'cancelled',
      updated_at = max(updated_at, ?) WHERE id = ? AND kind = ? AND status = 'active'`,
        )
        .bind(now, id, kind),
    ]
    if (kind === 'booking')
      statements.push(
        db
          .prepare(
            `UPDATE cancellation_requests
      SET status = 'approved', reviewed_at = max(created_at, ?)
      WHERE reservation_id = ? AND status = 'pending' AND EXISTS (
        SELECT 1 FROM reservations WHERE id = ? AND kind = 'booking' AND status = 'cancelled'
      )`,
          )
          .bind(now, id, id),
      )
    statements.push(
      db
        .prepare(
          `SELECT id, status, date, start_time AS startTime, end_time AS endTime
          FROM reservations WHERE id = ? AND kind = ?`,
        )
        .bind(id, kind),
    )
    // Transaction also serializes public cancellation requests and admin reviews.
    // Repeats leave timestamps, original payload, and consumed keys unchanged.
    const results = await db.batch<
      CancellationNotification & { id: string; status: string }
    >(statements)
    if (kind === 'block' && results[0].meta.changes === 1) {
      logEvent({ event: 'technical_block.removed', outcome: 'success' })
    }
    if (kind === 'booking' && results[1].meta.changes === 1) {
      logEvent({ event: 'cancellation.approved', outcome: 'success' })
    }
    const row = results.at(-1)!.results[0]
    if (row && kind === 'booking' && results[0].meta.changes === 1) {
      try {
        onCancelled?.({
          date: row.date,
          startTime: row.startTime,
          endTime: row.endTime,
        })
      } catch {
        logEvent({
          event: 'telegram.failed',
          outcome: 'failure',
          notificationType: 'reservation_cancelled',
          reason: 'scheduling',
        })
      }
    }
    return row
      ? reply(200, { reservation: { id: row.id, status: row.status } })
      : reply(404, { error: 'Not found' })
  } catch {
    logEvent({ event: 'database.error', outcome: 'failure' })
    return reply(500, { error: 'Booking controls unavailable' })
  }
}
