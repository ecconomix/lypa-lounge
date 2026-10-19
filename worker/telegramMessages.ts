export interface BookingNotification {
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

function notificationLink(
  origin: string | undefined,
  path: string,
  label: string,
): string | undefined {
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
    return `<a href="${escapeTelegramHtml(new URL(path, url).href)}">${label}</a>`
  } catch {
    return undefined
  }
}

/** Pure message formatting, independent of Telegram delivery and D1. */
export function formatBookingNotification(
  booking: BookingNotification,
  publicOrigin?: string,
): string {
  const lines = [
    '<b>🌿 Липа Lounge | Нове бронювання</b>',
    '',
    `📅 <b>Дата:</b> ${escapeTelegramHtml(formatDate(booking.date))}`,
    `🕒 <b>Час:</b> ${escapeTelegramHtml(booking.startTime)}–${escapeTelegramHtml(booking.endTime)}`,
    `👤 <b>Ім’я / квартира:</b> ${escapeTelegramHtml(booking.nameOrApartment)}`,
  ]
  const link = notificationLink(publicOrigin, '/', 'Відкрити календар')
  if (link) lines.push('', `📆 ${link}`)
  return lines.join('\n')
}

function formatDate(date: string): string {
  // The validated booking date is a civil date, not an absolute timestamp.
  return new Intl.DateTimeFormat('uk-UA', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`))
}

export type CancellationNotification = Pick<
  BookingNotification,
  'date' | 'startTime' | 'endTime'
>
export interface CancellationRequestNotification extends BookingNotification {
  reason: string
}

export function formatCancellationRequestNotification(
  request: CancellationRequestNotification,
  publicOrigin?: string,
): string {
  const lines = [
    '<b>🌿 Липа Lounge | Запит на скасування</b>',
    '',
    `📅 <b>Дата:</b> ${escapeTelegramHtml(formatDate(request.date))}`,
    `🕒 <b>Час:</b> ${escapeTelegramHtml(request.startTime)}–${escapeTelegramHtml(request.endTime)}`,
    `👤 <b>Ім’я / квартира:</b> ${escapeTelegramHtml(request.nameOrApartment)}`,
    `📝 <b>Причина:</b> ${escapeTelegramHtml(request.reason)}`,
  ]
  const link = notificationLink(publicOrigin, '/admin', 'Переглянути запити')
  if (link) lines.push('', `🔐 ${link}`)
  return lines.join('\n')
}

export function formatCancellationNotification(
  reservation: CancellationNotification,
  publicOrigin?: string,
): string {
  const lines = [
    '<b>🌿 Липа Lounge | Бронювання скасовано</b>',
    '',
    `📅 <b>Дата:</b> ${escapeTelegramHtml(formatDate(reservation.date))}`,
    `🕒 <b>Час:</b> ${escapeTelegramHtml(reservation.startTime)}–${escapeTelegramHtml(reservation.endTime)}`,
    '',
    '✅ Цей час знову доступний для бронювання.',
  ]
  const link = notificationLink(publicOrigin, '/', 'Відкрити календар')
  if (link) lines.push('', `📆 ${link}`)
  return lines.join('\n')
}
