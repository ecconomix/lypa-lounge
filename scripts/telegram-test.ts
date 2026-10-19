import { createTelegramClient, type TelegramEnv } from '../worker/telegram.ts'

const destination = process.argv[2]
if (!['group', 'admin'].includes(destination) || process.argv.length !== 3) {
  console.error('Usage: npm run telegram:test -- group|admin')
  process.exitCode = 1
} else {
  const env: TelegramEnv = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_GROUP_CHAT_ID: process.env.TELEGRAM_GROUP_CHAT_ID,
    TELEGRAM_ADMIN_CHAT_ID: process.env.TELEGRAM_ADMIN_CHAT_ID,
  }
  const chatId =
    destination === 'group'
      ? env.TELEGRAM_GROUP_CHAT_ID
      : env.TELEGRAM_ADMIN_CHAT_ID
  try {
    await createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(
      chatId ?? '',
      `Lypa Lounge M4.1: ${destination} delivery test.`,
    )
    console.log(
      `Telegram accepted the ${destination} test message. Check the chat for delivery.`,
    )
  } catch (error) {
    // The client exposes only sanitized errors, never raw fetch errors.
    console.error(
      error instanceof Error ? error.message : 'Telegram test failed',
    )
    process.exitCode = 1
  }
}
