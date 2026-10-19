import type { CancellationNotification } from './telegramMessages.ts'

function reply(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', Vary: 'Cookie' },
  })
}

/** Called only after the shared admin authentication and mutation guards. */
export async function cancellationReview(
  request: Request,
  db: D1Database,
  id?: string,
  action?: string,
  onCancelled?: (reservation: CancellationNotification) => void,
): Promise<Response> {
  const method = id ? 'POST' : 'GET'
  if (request.method !== method) {
    const response = reply(405, { error: 'Method not allowed' })
    response.headers.set('Allow', method)
    return response
  }
  try {
    if (!id) {
      const { results } = await db
        .prepare(
          `
        SELECT c.id, c.reservation_id AS reservationId, c.reason,
          c.created_at AS createdAt, r.date, r.start_time AS startTime,
          r.end_time AS endTime, r.name_or_apartment AS nameOrApartment
        FROM cancellation_requests c JOIN reservations r ON r.id = c.reservation_id
        WHERE c.status = 'pending' ORDER BY c.created_at, c.id
      `,
        )
        .all()
      return reply(200, { requests: results })
    }
    const status = action === 'approve' ? 'approved' : 'rejected'
    const now = Math.floor(Date.now() / 1000)
    // D1 batches are transactions. The conditional first write arbitrates reviews;
    // changes() links reservation cancellation to that write, never to a replay.
    const statements = [
      db
        .prepare(
          `UPDATE cancellation_requests
        SET status = ?, reviewed_at = max(created_at, ?)
        WHERE id = ? AND status = 'pending' AND EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.id = cancellation_requests.reservation_id AND r.status = 'active'
        )`,
        )
        .bind(status, now, id),
    ]
    if (status === 'approved')
      statements.push(
        db
          .prepare(
            `UPDATE reservations SET status = 'cancelled', updated_at = max(updated_at, ?)
        WHERE changes() = 1 AND status = 'active' AND id = (
          SELECT reservation_id FROM cancellation_requests WHERE id = ? AND status = 'approved'
        )`,
          )
          .bind(now, id),
      )
    statements.push(
      db
        .prepare(
          `SELECT c.id, c.status, c.reviewed_at AS reviewedAt,
        r.date, r.start_time AS startTime, r.end_time AS endTime
      FROM cancellation_requests c JOIN reservations r ON r.id = c.reservation_id
      WHERE c.id = ?`,
        )
        .bind(id),
    )
    const results = await db.batch<
      CancellationNotification & {
        id: string
        status: string
        reviewedAt: number | null
      }
    >(statements)
    const review = results.at(-1)!.results[0]
    if (!review) return reply(404, { error: 'Cancellation request not found' })
    if (review.status !== status)
      return reply(409, { error: 'Cancellation request cannot be processed' })
    // The reservation UPDATE, rather than the review status, proves an actual
    // cancellation. D1 serializes this batch against direct admin cancellations.
    if (status === 'approved' && results[1].meta.changes === 1) {
      try {
        onCancelled?.({
          date: review.date,
          startTime: review.startTime,
          endTime: review.endTime,
        })
      } catch {
        console.error('Cancellation notification scheduling failed')
      }
    }
    return reply(200, {
      request: {
        id: review.id,
        status: review.status,
        reviewedAt: review.reviewedAt,
      },
    })
  } catch {
    // Review explanations and database details must remain private.
    return reply(500, { error: 'Cancellation review unavailable' })
  }
}
