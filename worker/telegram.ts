/** Server-only secrets supplied by .dev.vars or Cloudflare Secrets. */
export interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_GROUP_CHAT_ID?: string
  TELEGRAM_ADMIN_CHAT_ID?: string
}

export function createTelegramClient(token: string | undefined) {
  return {
    async sendMessage(
      chatId: string,
      text: string,
      options?: { parseMode: 'HTML' },
    ): Promise<void> {
      if (!token?.trim() || !chatId.trim()) {
        throw new Error('Telegram bot token and chat ID are required')
      }

      let response: Response
      try {
        response = await fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text,
              ...(options ? { parse_mode: options.parseMode } : {}),
            }),
            // Workers supports manual/follow, not error. Reject 3xx below
            // without following redirects to another destination.
            redirect: 'manual',
          },
        )
      } catch {
        // Fetch errors can contain the token-bearing URL. Never propagate them.
        throw new Error('Telegram sendMessage network request failed')
      }

      if (!response.ok) {
        throw new Error(`Telegram sendMessage failed (HTTP ${response.status})`)
      }

      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new Error('Telegram sendMessage returned invalid JSON')
      }
      if (
        typeof body !== 'object' ||
        body === null ||
        !('ok' in body) ||
        body.ok !== true
      ) {
        // Do not propagate arbitrary Telegram descriptions or response bodies.
        throw new Error('Telegram sendMessage API request failed')
      }
    },
  }
}
