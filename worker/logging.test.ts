import { expect, test, vi } from 'vitest'
import { logEvent } from './logging.ts'
import worker from './index.ts'

test('projects only explicit safe fields even if extra private data is supplied', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const entry = {
    event: 'reservation.created' as const,
    outcome: 'success' as const,
    name: 'private resident',
    apartment: '12',
    description: 'private description',
    reasonPrivate: 'private cancellation reason',
    password: 'private password',
    token: 'private bot/session token',
    chatId: 'private chat',
    authorization: 'private auth',
    cookie: 'private cookie',
    body: { private: true },
    record: { private: true },
    url: 'https://example.invalid/?private=value',
    ip: '192.0.2.1',
    reservationId: 'private booking id',
    requestId: 'private request id',
    key: 'private key',
  }
  logEvent(entry)
  expect(info.mock.calls).toEqual([
    [{ event: 'reservation.created', outcome: 'success' }],
  ])
})

test('uses native severity levels without propagating logging failures', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {
    throw new Error('console')
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
    throw new Error('console')
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {
    throw new Error('console')
  })
  expect(() =>
    logEvent({ event: 'reservation.created', outcome: 'success' }),
  ).not.toThrow()
  expect(() =>
    logEvent({ event: 'reservation.conflict', outcome: 'conflict' }),
  ).not.toThrow()
  expect(() =>
    logEvent({ event: 'database.error', outcome: 'failure' }),
  ).not.toThrow()
  expect(info).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledTimes(1)
  expect(error).toHaveBeenCalledTimes(1)
})

test('unexpected routing failures preserve generic responses without logging caught details', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const request = new Request('https://example.invalid/api/health')
  Object.defineProperty(request, 'url', {
    get() {
      throw new Error('private URL, cookie and credentials')
    },
  })
  const response = await worker.fetch(request, { DB: {} as D1Database })
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ error: 'Internal server error' })
  expect(error.mock.calls).toEqual([
    [{ event: 'api.unexpected_error', outcome: 'failure' }],
  ])
})
