interface PublicReservation {
  id: string
  date: string
  startTime: string
  endTime: string
  nameOrApartment: string
  description: string | null
}

function daysInMonth(year: number, month: number): number {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ]
}

function parseDate(value: string): number[] | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null

  const [year, month, day] = value.split('-').map(Number)
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null
  }
  return [year, month, day]
}

function validRange(params: URLSearchParams): boolean {
  if (
    params.size !== 2 ||
    params.getAll('from').length !== 1 ||
    params.getAll('to').length !== 1
  ) {
    return false
  }

  const from = params.get('from')!
  const to = params.get('to')!
  const start = parseDate(from)
  if (!start || !parseDate(to) || from > to) return false

  // These are Europe/Kyiv civil dates, not instants. Advance calendar days
  // directly so neither daylight-saving transitions nor host timezone matter.
  let [year, month, day] = start
  for (let offset = 0; offset < 31; offset++) {
    if (
      `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` ===
      to
    ) {
      return true
    }
    day++
    if (day > daysInMonth(year, month)) {
      day = 1
      month++
      if (month > 12) {
        month = 1
        year++
      }
    }
  }
  return false
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status })
}

export async function availability(
  request: Request,
  db: D1Database,
): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json(
      { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } },
      { status: 405, headers: { Allow: 'GET' } },
    )
  }

  const params = new URL(request.url).searchParams
  if (!validRange(params)) {
    return jsonError('INVALID_DATE_RANGE', 'Invalid date range', 400)
  }

  try {
    const { results } = await db
      .prepare(
        `SELECT id, date, start_time AS startTime, end_time AS endTime,
                name_or_apartment AS nameOrApartment, description
         FROM reservations
         WHERE date >= ? AND date <= ? AND status = 'active'
         ORDER BY date ASC, start_time ASC`,
      )
      .bind(params.get('from'), params.get('to'))
      .all<PublicReservation>()

    return Response.json({ reservations: results })
  } catch (error) {
    console.error('Worker request failed', error)
    return jsonError('INTERNAL_ERROR', 'Internal server error', 500)
  }
}
