import { availability } from './availability.ts'
import { reservations } from './reservations.ts'

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const { pathname } = new URL(request.url)

      if (pathname === '/api/reservations') {
        return await reservations(request, env.DB)
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
