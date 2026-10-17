import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createReservation, fetchAvailability } from './reservations'
import { createDateRange, getKyivToday } from '../utils/calendar'

const booking = {
  id: 'one',
  date: '2026-10-20',
  startTime: '18:00',
  endTime: '19:00',
  nameOrApartment: 'Квартира 1',
  description: null,
}
afterEach(() => vi.unstubAllGlobals())
function availability(value: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(value)))
  return fetchAvailability('2026-10-18', new AbortController().signal)
}

describe('API boundary', () => {
  it('maps nullable descriptions to the existing frontend shape', async () => {
    await expect(availability({ reservations: [booking] })).resolves.toEqual([
      { ...booking, description: undefined },
    ])
  })
  it('maps populated descriptions', async () => {
    await expect(
      availability({ reservations: [{ ...booking, description: 'Свято' }] }),
    ).resolves.toEqual([{ ...booking, description: 'Свято' }])
  })
  it.each([
    null,
    [],
    {},
    { reservations: null },
    { reservations: [{}] },
    { reservations: [{ ...booking, date: '2026-02-30' }] },
    { reservations: [{ ...booking, date: '2027-01-01' }] },
    { reservations: [{ ...booking, startTime: '18:15' }] },
    { reservations: [{ ...booking, endTime: '18:00' }] },
    { reservations: [{ ...booking, nameOrApartment: 1 }] },
    { reservations: [{ ...booking, description: {} }] },
    { reservations: [booking, booking] },
  ])('rejects malformed availability %#', async (value) => {
    await expect(availability(value)).rejects.toBeInstanceOf(ApiError)
  })
  it('rejects invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{')))
    await expect(
      fetchAvailability('2026-10-18', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
  it.each([400, 409, 500])('retains HTTP %s and API code', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { code: 'EXAMPLE' } }, { status }),
        ),
    )
    await expect(
      createReservation(
        { ...booking, description: undefined },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ status, code: 'EXAMPLE' })
  })
  it('passes GET cancellation through to native fetch', async () => {
    const controller = new AbortController()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ reservations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchAvailability('2026-10-18', controller.signal)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      signal: controller.signal,
      cache: 'no-store',
    })
  })
})

describe('Kyiv ranges', () => {
  it.each([
    ['2026-10-24T21:30:00Z', '2026-10-25', '2026-11-24'],
    ['2026-03-28T22:30:00Z', '2026-03-29', '2026-04-28'],
    ['2026-12-31T22:30:00Z', '2027-01-01', '2027-01-31'],
  ])(
    'uses civil days across DST and year boundaries: %s',
    (instant, from, to) => {
      expect(getKyivToday(new Date(instant))).toBe(from)
      const range = createDateRange(from)
      expect(range).toHaveLength(31)
      expect(range.at(-1)).toBe(to)
    },
  )
})
