type Transition =
  | 'reservation.created'
  | 'cancellation.requested'
  | 'cancellation.approved'
  | 'cancellation.rejected'
  | 'technical_block.created'
  | 'technical_block.removed'

export type NotificationType =
  'reservation_created' | 'cancellation_requested' | 'reservation_cancelled'

type LogEvent =
  | { event: Transition; outcome: 'success' }
  | { event: 'reservation.conflict'; outcome: 'conflict' }
  | { event: 'database.error' | 'api.unexpected_error'; outcome: 'failure' }
  | {
      event: 'telegram.sent'
      outcome: 'success'
      notificationType: NotificationType
    }
  | {
      event: 'telegram.failed'
      outcome: 'failure'
      notificationType: NotificationType
      reason: 'delivery' | 'scheduling'
    }
  | {
      event: 'telegram.skipped'
      outcome: 'skipped'
      notificationType: NotificationType
      reason: 'missing_configuration' | 'missing_context'
    }

/** Closed fields only; never pass request data or caught errors here. */
export function logEvent(entry: LogEvent): void {
  try {
    // Reconstruct explicitly: even an accidental extra property cannot be logged.
    const safe = {
      event: entry.event,
      outcome: entry.outcome,
      ...('notificationType' in entry
        ? { notificationType: entry.notificationType }
        : {}),
      ...('reason' in entry ? { reason: entry.reason } : {}),
    }
    const level =
      entry.outcome === 'failure'
        ? 'error'
        : entry.outcome === 'conflict' || entry.outcome === 'skipped'
          ? 'warn'
          : 'info'
    console[level](safe)
  } catch {
    // Logging must never affect a response, committed write or notification.
  }
}
