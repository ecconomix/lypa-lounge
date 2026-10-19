import type { Reservation } from '../types/reservation'
import { calendarDate, createDateRange } from '../utils/calendar'

export type BookingPayload = Omit<
  Reservation,
  'id' | 'nameOrApartment' | 'isTechnicalBlock'
> & {
  nameOrApartment: string
}

export class ApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function reservation(value: unknown): Reservation {
  if (!object(value)) throw new ApiError(0, 'MALFORMED_RESPONSE')
  const { id, date, startTime, endTime, nameOrApartment, description } = value
  const validTime = (time: unknown): time is string =>
    typeof time === 'string' &&
    /^(?:0[89]|1\d|2[01]):(?:00|30)$|^22:00$/.test(time)
  if (
    typeof id !== 'string' ||
    !id ||
    typeof date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(calendarDate(date).getTime()) ||
    calendarDate(date).toISOString().slice(0, 10) !== date ||
    !validTime(startTime) ||
    !validTime(endTime) ||
    startTime >= endTime ||
    typeof nameOrApartment !== 'string' ||
    !nameOrApartment.trim() ||
    nameOrApartment.length > 100 ||
    !(
      description === null ||
      description === undefined ||
      typeof description === 'string'
    ) ||
    (typeof description === 'string' && description.length > 1000)
  )
    throw new ApiError(0, 'MALFORMED_RESPONSE')
  if (
    value.isTechnicalBlock !== undefined &&
    typeof value.isTechnicalBlock !== 'boolean'
  )
    throw new ApiError(0, 'MALFORMED_RESPONSE')
  return {
    ...(value.isTechnicalBlock === true ? { isTechnicalBlock: true } : {}),
    id,
    date,
    startTime,
    endTime,
    nameOrApartment,
    description: description ?? undefined,
  }
}

async function body(
  response: Response,
  expectedStatus: number,
): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new ApiError(response.status, 'MALFORMED_RESPONSE')
  }
  if (response.status !== expectedStatus) {
    throw new ApiError(
      response.status,
      object(value) &&
        object(value.error) &&
        typeof value.error.code === 'string'
        ? value.error.code
        : 'HTTP_ERROR',
    )
  }
  if (!object(value)) throw new ApiError(response.status, 'MALFORMED_RESPONSE')
  return value
}

export async function fetchAvailability(
  from: string,
  signal: AbortSignal,
): Promise<Reservation[]> {
  const to = createDateRange(from).at(-1)!
  const response = await fetch(
    `/api/availability?${new URLSearchParams({ from, to })}`,
    { signal, cache: 'no-store' },
  )
  const value = await body(response, 200)
  if (!Array.isArray(value.reservations))
    throw new ApiError(200, 'MALFORMED_RESPONSE')
  const reservations = value.reservations.map(reservation)
  if (
    reservations.some((entry) => entry.date < from || entry.date > to) ||
    new Set(reservations.map((entry) => entry.id)).size !== reservations.length
  ) {
    throw new ApiError(200, 'MALFORMED_RESPONSE')
  }
  return reservations
}

export async function createReservation(
  payload: BookingPayload,
  key: string,
): Promise<Reservation> {
  const response = await fetch('/api/reservations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(payload),
  })
  return reservation((await body(response, 201)).reservation)
}

export async function requestCancellation(
  id: string,
  reason: string,
): Promise<void> {
  const response = await fetch(
    `/api/reservations/${encodeURIComponent(id)}/cancellation-requests`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason.trim() }),
    },
  )
  if ((await body(response, 201)).status !== 'pending')
    throw new ApiError(201, 'MALFORMED_RESPONSE')
}
