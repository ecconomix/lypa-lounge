import { admin, type AdminEnv } from './admin.ts'
import { availability } from './availability.ts'
import { reservations } from './reservations.ts'
import { cancellationRequests } from './cancellationRequests.ts'
import { createTelegramClient, type TelegramEnv } from './telegram.ts'

export default {
  async fetch(
    request: Request,
    env: Env & AdminEnv & TelegramEnv,
    ctx?: Pick<ExecutionContext, 'waitUntil'>,
  ): Promise<Response> {
    try {
      const { pathname } = new URL(request.url)

      if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
        return await admin(request, env)
      }

      if (pathname === '/api/reservations') {
        return await reservations(request, env.DB, 'booking', (booking) => {
          if (
            !ctx ||
            !env.TELEGRAM_BOT_TOKEN?.trim() ||
            !env.TELEGRAM_GROUP_CHAT_ID?.trim()
          )
            return
          const date = booking.date.split('-').reverse().join('.')
          const notification = createTelegramClient(env.TELEGRAM_BOT_TOKEN)
            .sendMessage(
              env.TELEGRAM_GROUP_CHAT_ID,
              `Нове бронювання альтанки\n${date}, ${booking.startTime}–${booking.endTime} (Київ)\n${booking.nameOrApartment}`,
            )
            .catch(() => {
              // Never log errors, credentials, destinations or booking data.
              console.error('Telegram booking notification failed')
            })
          ctx.waitUntil(notification)
        })
      }

      const cancellation =
        /^\/api\/reservations\/([^/]+)\/cancellation-requests$/.exec(pathname)
      if (cancellation) {
        return await cancellationRequests(request, env.DB, cancellation[1])
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

        await env.DB.prepare('SELECT 1').first()
        return Response.json({ status: 'ok' })
      }

      return Response.json({ error: 'Not found' }, { status: 404 })
    } catch (error) {
      console.error('Worker request failed', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  },
} satisfies ExportedHandler<Env>
