import { afterEach, expect, test, vi } from 'vitest'
import { createTelegramClient } from './telegram.ts'

const token = 'test-only-token'
const chatId = 'test-only-chat-id'
const client = createTelegramClient(token)
afterEach(() => vi.unstubAllGlobals())

test('sends plain text as JSON and accepts Telegram success', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(Response.json({ ok: true, result: { message_id: 1 } }))
  vi.stubGlobal('fetch', fetchMock)
  await expect(
    client.sendMessage(chatId, 'Привіт <b>світе</b>'),
  ).resolves.toBeUndefined()
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: 'Привіт <b>світе</b>' }),
      redirect: 'manual',
    },
  )
})

test('reports HTTP errors without exposing response content', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(token, { status: 403 })),
  )
  await expect(client.sendMessage(chatId, 'Test')).rejects.toThrow(
    'Telegram sendMessage failed (HTTP 403)',
  )
})

test.each([301, 302, 307, 308])(
  'rejects HTTP %i redirects without following or exposing the destination',
  async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status,
        headers: { Location: `https://example.invalid/${token}` },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(client.sendMessage(chatId, 'Test')).rejects.toThrow(
      `Telegram sendMessage failed (HTTP ${status})`,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual')
  },
)

test.each([{ ok: false, description: token }, {}, null, { ok: 'true' }])(
  'rejects API failures and malformed envelopes: %j',
  async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)))
    await expect(client.sendMessage(chatId, 'Test')).rejects.toThrow(
      'Telegram sendMessage API request failed',
    )
  },
)

test('rejects invalid JSON', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not JSON')))
  await expect(client.sendMessage(chatId, 'Test')).rejects.toThrow(
    'Telegram sendMessage returned invalid JSON',
  )
})

test('replaces network errors without leaking the token-bearing URL or cause', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockRejectedValue(
        new Error(`Failed https://api.telegram.org/bot${token}/sendMessage`),
      ),
  )
  const error = await client
    .sendMessage(chatId, 'Test')
    .catch((error: unknown) => error)
  expect(error).toEqual(
    new Error('Telegram sendMessage network request failed'),
  )
  expect(error).not.toHaveProperty('cause')
})

test.each([
  [undefined, chatId],
  ['', chatId],
  [token, ''],
])(
  'rejects missing configuration before fetching',
  async (botToken, destination) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      createTelegramClient(botToken).sendMessage(destination!, 'Test'),
    ).rejects.toThrow('Telegram bot token and chat ID are required')
    expect(fetchMock).not.toHaveBeenCalled()
  },
)
