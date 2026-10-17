import type { Reservation } from '../types/reservation'

export type Availability = 'AVAILABLE' | 'PARTIALLY_BOOKED' | 'FULLY_BOOKED'

export const OPENING_TIME = '08:00'
export const CLOSING_TIME = '22:00'

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

export function getDailyAvailability(
  date: string,
  reservations: readonly Reservation[],
): Availability {
  const opening = toMinutes(OPENING_TIME)
  const closing = toMinutes(CLOSING_TIME)
  const intervals = reservations
    .filter((reservation) => reservation.date === date)
    .map((reservation) => ({
      start: Math.max(opening, toMinutes(reservation.startTime)),
      end: Math.min(closing, toMinutes(reservation.endTime)),
    }))
    .filter(({ start, end }) => end > start)
    .sort((a, b) => a.start - b.start)

  let occupiedMinutes = 0
  let occupiedUntil = opening

  // Only count the uncovered part of each interval, merging overlaps and adjacency.
  for (const { start, end } of intervals) {
    occupiedMinutes += Math.max(0, end - Math.max(start, occupiedUntil))
    occupiedUntil = Math.max(occupiedUntil, end)
  }

  if (occupiedMinutes === 0) return 'AVAILABLE'
  return occupiedMinutes === closing - opening
    ? 'FULLY_BOOKED'
    : 'PARTIALLY_BOOKED'
}
