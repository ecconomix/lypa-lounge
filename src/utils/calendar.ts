export const DAYS_AHEAD = 30

export function getKyivToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)!.value

  return `${part('year')}-${part('month')}-${part('day')}`
}

// These dates represent calendar days, not instants. UTC noon is a stable
// carrier for arithmetic and formatting, independent of the device's DST.
export function calendarDate(value: string): Date {
  return new Date(`${value}T12:00:00Z`)
}

export function createDateRange(start: string): string[] {
  return Array.from({ length: DAYS_AHEAD + 1 }, (_, offset) => {
    const date = calendarDate(start)
    date.setUTCDate(date.getUTCDate() + offset)
    return date.toISOString().slice(0, 10)
  })
}

export const weekdayFormatter = new Intl.DateTimeFormat('uk-UA', {
  weekday: 'short',
  timeZone: 'UTC',
})

export const fullDateFormatter = new Intl.DateTimeFormat('uk-UA', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

const monthFormatter = new Intl.DateTimeFormat('uk-UA', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

export function formatPeriod(first: string, last: string): string {
  const firstMonth = monthFormatter.format(calendarDate(first))
  return first.slice(0, 7) === last.slice(0, 7)
    ? firstMonth
    : `${firstMonth} — ${monthFormatter.format(calendarDate(last))}`
}
