interface BookingNotification {
  date: string
  startTime: string
  endTime: string
  nameOrApartment: string
}

/** Escape text and quoted attribute values for Telegram HTML messages. */
export function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function calendarLink(origin: string | undefined): string | undefined {
  if (!origin) return undefined
  try {
    const url = new URL(origin)
    // ADMIN_ORIGIN is the existing exact public frontend origin. Never derive
    // notification links from request headers or link to local development.
    if (
      url.protocol !== 'https:' ||
      url.origin !== origin ||
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
      return undefined
    return `📆 <a href="${escapeTelegramHtml(url.href)}">Відкрити календар</a>`
  } catch {
    return undefined
  }
}

/** Pure message formatting, independent of Telegram delivery and D1. */
export function formatBookingNotification(
  booking: BookingNotification,
  publicOrigin?: string,
): string {
  // The validated booking date is a civil date, not an absolute timestamp.
  const date = new Intl.DateTimeFormat('uk-UA', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${booking.date}T00:00:00Z`))
  const lines = [
    '<b>🌿 Липа Lounge | Нове бронювання</b>',
    '',
    `📅 <b>Дата:</b> ${escapeTelegramHtml(date)}`,
    `🕒 <b>Час:</b> ${escapeTelegramHtml(booking.startTime)}–${escapeTelegramHtml(booking.endTime)}`,
    `👤 <b>Ім’я / квартира:</b> ${escapeTelegramHtml(booking.nameOrApartment)}`,
  ]
  const link = calendarLink(publicOrigin)
  if (link) lines.push('', link)
  return lines.join('\n')
}
