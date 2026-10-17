interface ReservationInput {
  date: string
  startTime: string
  endTime: string
  nameOrApartment: string
  description: string | null
}

interface Reservation extends ReservationInput {
  id: string
}

const publicColumns = `id, date, start_time AS startTime, end_time AS endTime,
                       name_or_apartment AS nameOrApartment, description`
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const nameLimit = 100
const descriptionLimit = 1000

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status })
}

function normalize(body: unknown): ReservationInput | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const fields = body as Record<string, unknown>
  if (
    Object.keys(fields).some(
      (key) =>
        ![
          'date',
          'startTime',
          'endTime',
          'nameOrApartment',
          'description',
        ].includes(key),
    )
  )
    return null
  const { date, startTime, endTime, nameOrApartment, description } = fields
  if (
    typeof date !== 'string' ||
    typeof startTime !== 'string' ||
    typeof endTime !== 'string' ||
    typeof nameOrApartment !== 'string' ||
    (description !== undefined && typeof description !== 'string')
  )
    return null
  const name = nameOrApartment.trim()
  const details = description?.trim() || null
  if (
    !name ||
    name.length > nameLimit ||
    (details?.length ?? 0) > descriptionLimit
  )
    return null
  // Keep machine-readable date/time values strict; trim only free text.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const calendarDate = new Date(`${date}T00:00:00Z`)
  if (
    !Number.isFinite(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== date ||
    date < '0001-01-01'
  )
    return null
  if (
    ![startTime, endTime].every((value) =>
      /^(?:[01]\d|2[0-3]):[03]0$/.test(value),
    )
  )
    return null
  if (startTime < '08:00' || endTime > '22:00' || endTime <= startTime)
    return null
  return {
    date,
    startTime,
    endTime,
    nameOrApartment: name,
    description: details,
  }
}

function bookable(input: ReservationInput, now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)!.value
  const today = `${part('year')}-${part('month')}-${part('day')}`
  // UTC is used only as a calendar-day counter, never to interpret booking times.
  const last = new Date(`${today}T00:00:00Z`)
  last.setUTCDate(last.getUTCDate() + 30)
  if (input.date < today || input.date > last.toISOString().slice(0, 10))
    return false
  if (input.date !== today) return true
  const currentMilliseconds =
    ((Number(part('hour')) * 60 + Number(part('minute'))) * 60 +
      Number(part('second'))) *
      1000 +
    now.getUTCMilliseconds()
  const [hour, minute] = input.startTime.split(':').map(Number)
  return (hour * 60 + minute) * 60_000 >= currentMilliseconds
}

function replay(existing: Reservation, input: ReservationInput): Response {
  if (
    (Object.keys(input) as (keyof ReservationInput)[]).some(
      (key) => existing[key] !== input[key],
    )
  ) {
    return jsonError(
      'IDEMPOTENCY_CONFLICT',
      'Idempotency key was already used',
      409,
    )
  }
  return Response.json({ reservation: existing }, { status: 201 })
}

export async function reservations(
  request: Request,
  db: D1Database,
): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json(
      { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } },
      { status: 405, headers: { Allow: 'POST' } },
    )
  }
  if (
    request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  ) {
    return jsonError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type must be application/json',
      415,
    )
  }
  const invalid = () =>
    jsonError('INVALID_RESERVATION', 'Invalid reservation data', 400)
  const key = request.headers.get('Idempotency-Key')
  if (!key || !uuid.test(key)) return invalid()
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return invalid()
  }
  const input = normalize(body)
  if (!input) return invalid()

  try {
    const lookup = db
      .prepare(
        `SELECT ${publicColumns} FROM reservations WHERE idempotency_key = ?`,
      )
      .bind(key.toLowerCase())
    // Replay before time-sensitive checks: a consumed key survives expiry/cancellation.
    const existing = await lookup.first<Reservation>()
    if (existing) return replay(existing, input)
    const now = new Date()
    if (!bookable(input, now)) return invalid()
    const timestamp = Math.floor(now.getTime() / 1000)
    // One conditional write checks overlap and inserts atomically. Only the key's
    // unique constraint is ignored; other constraint failures remain unexpected.
    // Batch the follow-up read in the same transaction to resolve concurrent keys.
    const [, result] = await db.batch<Reservation>([
      db
        .prepare(
          `INSERT INTO reservations
        (id, date, start_time, end_time, name_or_apartment, description, status, idempotency_key, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM reservations WHERE date = ? AND status = 'active'
          AND start_time < ? AND end_time > ?
        )
        ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          input.date,
          input.startTime,
          input.endTime,
          input.nameOrApartment,
          input.description,
          key.toLowerCase(),
          timestamp,
          timestamp,
          input.date,
          input.endTime,
          input.startTime,
        ),
      lookup,
    ])
    if (result.results[0]) return replay(result.results[0], input)
    return jsonError(
      'RESERVATION_CONFLICT',
      'Selected time is no longer available',
      409,
    )
  } catch (error) {
    console.error('Worker request failed', error)
    return jsonError('INTERNAL_ERROR', 'Internal server error', 500)
  }
}
