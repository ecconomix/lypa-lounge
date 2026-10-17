import type { Reservation } from '../types/reservation'
import {
  CLOSING_TIME,
  hasBookingConflict,
  OPENING_TIME,
  toMinutes,
} from './availability'
import { createDateRange, getKyivToday } from './calendar'

const TIME_STEP = 30
const opening = toMinutes(OPENING_TIME)
const closing = toMinutes(CLOSING_TIME)

function formatTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

const timeOptions = Array.from(
  { length: (closing - opening) / TIME_STEP + 1 },
  (_, index) => formatTime(opening + index * TIME_STEP),
)

export function isBookableDate(date: string, now: Date): boolean {
  return createDateRange(getKyivToday(now)).includes(date)
}

function earliestStart(date: string, now: Date): number {
  if (date !== getKyivToday(now)) return opening

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const hours = Number(parts.find((part) => part.type === 'hour')!.value)
  const minutes = Number(parts.find((part) => part.type === 'minute')!.value)

  // Always advance to a strictly future boundary, even at exactly HH:00/HH:30.
  return Math.max(
    opening,
    (Math.floor((hours * 60 + minutes) / TIME_STEP) + 1) * TIME_STEP,
  )
}

export function getAvailableStartTimes(
  date: string,
  reservations: readonly Reservation[],
  now: Date,
): string[] {
  if (!isBookableDate(date, now)) return []

  const earliest = earliestStart(date, now)
  return timeOptions.filter(
    (time, index) =>
      toMinutes(time) >= earliest &&
      index < timeOptions.length - 1 &&
      !hasBookingConflict(date, time, timeOptions[index + 1], reservations),
  )
}

export function getAvailableEndTimes(
  date: string,
  startTime: string,
  reservations: readonly Reservation[],
): string[] {
  if (!startTime) return []

  return timeOptions.filter(
    (time) =>
      toMinutes(time) > toMinutes(startTime) &&
      !hasBookingConflict(date, startTime, time, reservations),
  )
}

export type BookingError = {
  field: 'date' | 'times' | 'name'
  message: string
}

export function validateBooking(
  date: string,
  startTime: string,
  endTime: string,
  nameOrApartment: string,
  reservations: readonly Reservation[],
  now: Date,
): BookingError | null {
  if (!isBookableDate(date, now)) {
    return {
      field: 'date',
      message: 'Оберіть дату від сьогодні до 30 днів уперед у календарі.',
    }
  }
  if (!startTime || !endTime) {
    return { field: 'times', message: 'Оберіть час початку та завершення.' }
  }
  if (!timeOptions.includes(startTime) || !timeOptions.includes(endTime)) {
    return {
      field: 'times',
      message: 'Оберіть час від 08:00 до 22:00 з кроком 30 хвилин.',
    }
  }
  if (toMinutes(endTime) - toMinutes(startTime) < TIME_STEP) {
    return {
      field: 'times',
      message:
        'Час завершення має бути щонайменше на 30 хвилин пізніше початку.',
    }
  }
  if (toMinutes(startTime) < earliestStart(date, now)) {
    return {
      field: 'times',
      message: 'Неможливо забронювати час, який уже минув.',
    }
  }
  if (hasBookingConflict(date, startTime, endTime, reservations)) {
    return {
      field: 'times',
      message: 'Цей час уже зайнятий. Оберіть інший.',
    }
  }
  if (!nameOrApartment.trim()) {
    return { field: 'name', message: 'Вкажіть ім’я або номер квартири.' }
  }
  return null
}
