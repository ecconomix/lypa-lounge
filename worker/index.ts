import { logEvent, type NotificationType } from './logging.ts'
import { admin, type AdminEnv } from './admin.ts'
import { availability } from './availability.ts'
import { reservations } from './reservations.ts'
import { cancellationRequests } from './cancellationRequests.ts'
import { createTelegramClient, type TelegramEnv } from './telegram.ts'
import {
  formatBookingNotification,
  formatCancellationNotification,
  formatCancellationRequestNotification,
} from './telegramMessages.ts'

export default {
  async fetch(
    request: Request,
    env: Omit<Env, keyof AdminEnv> & AdminEnv & TelegramEnv,
    ctx?: Pick<ExecutionContext, 'waitUntil'>,
  ): Promise<Response> {
    try {
      const { pathname } = new URL(request.url)
      const notify = (
        notificationType: NotificationType,
        chatId: string | undefined,
        text: () => string,
      ) => {
        if (!env.TELEGRAM_BOT_TOKEN?.trim() || !chatId?.trim()) {
          logEvent({
            event: 'telegram.skipped',
            outcome: 'skipped',
            notificationType,
            reason: 'missing_configuration',
          })
          return
        }
        if (!ctx) {
          logEvent({
            event: 'telegram.skipped',
            outcome: 'skipped',
            notificationType,
            reason: 'missing_context',
          })
          return
        }
        try {
          const task = createTelegramClient(env.TELEGRAM_BOT_TOKEN)
            .sendMessage(chatId, text(), { parseMode: 'HTML' })
            .then(() => {
              logEvent({
                event: 'telegram.sent',
                outcome: 'success',
                notificationType,
              })
            })
            .catch(() => {
              logEvent({
                event: 'telegram.failed',
                outcome: 'failure',
                notificationType,
                reason: 'delivery',
              })
            })
          ctx.waitUntil(task)
        } catch {
          logEvent({
            event: 'telegram.failed',
            outcome: 'failure',
            notificationType,
            reason: 'scheduling',
          })
        }
      }

      if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
        return await admin(request, env, (reservation) => {
          notify('reservation_cancelled', env.TELEGRAM_GROUP_CHAT_ID, () =>
            formatCancellationNotification(reservation, env.ADMIN_ORIGIN),
          )
        })
      }

      if (pathname === '/api/reservations') {
        return await reservations(request, env.DB, 'booking', (booking) => {
          notify('reservation_created', env.TELEGRAM_GROUP_CHAT_ID, () =>
            formatBookingNotification(booking, env.ADMIN_ORIGIN),
          )
        })
      }

      const cancellation =
        /^\/api\/reservations\/([^/]+)\/cancellation-requests$/.exec(pathname)
      if (cancellation) {
        return await cancellationRequests(
          request,
          env.DB,
          cancellation[1],
          (created) => {
            notify('cancellation_requested', env.TELEGRAM_ADMIN_CHAT_ID, () =>
              formatCancellationRequestNotification(created, env.ADMIN_ORIGIN),
            )
          },
        )
      }

      if (pathname === '/api/availability') {
        return await availability(request, env.DB)
      }

      if (pathname === '/api/health') {
        if (request.method !== 'GET') {
          return Response.json(
            { error: 'Method not allowed' },
            { status: 405, headers: { Allow: 'GET' } },
          )
        }

        try {
          await env.DB.prepare('SELECT 1').first()
        } catch {
          logEvent({ event: 'database.error', outcome: 'failure' })
          return Response.json(
            { error: 'Internal server error' },
            { status: 500 },
          )
        }
        return Response.json({ status: 'ok' })
      }

      return Response.json({ error: 'Not found' }, { status: 404 })
    } catch {
      logEvent({ event: 'api.unexpected_error', outcome: 'failure' })
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  },
} satisfies ExportedHandler<Env>
