import type { Reservation } from '../types/reservation'
import { createDateRange } from '../utils/calendar'

export function createMockReservations(today: string): Reservation[] {
  const dates = createDateRange(today)

  // Today stays empty; the next days demonstrate partial, full, and overlapping bookings.
  // Times are local wall-clock times in Europe/Kyiv.
  return [
    {
      id: 'partial-evening',
      date: dates[1],
      startTime: '18:00',
      endTime: '20:00',
    },
    {
      id: 'partial-morning',
      date: dates[1],
      startTime: '09:00',
      endTime: '11:00',
      description: 'Настільні ігри',
    },
    {
      id: 'partial-midday',
      date: dates[1],
      startTime: '11:00',
      endTime: '13:00',
      description: 'Зустріч сусідів',
    },
    {
      id: 'full-afternoon',
      date: dates[2],
      startTime: '14:00',
      endTime: '22:00',
    },
    {
      id: 'full-morning',
      date: dates[2],
      startTime: '08:00',
      endTime: '14:00',
      description: 'Спільний сніданок',
    },
    {
      id: 'overlap-morning',
      date: dates[3],
      startTime: '08:00',
      endTime: '18:00',
    },
    {
      id: 'overlap-afternoon',
      date: dates[3],
      startTime: '10:00',
      endTime: '20:00',
      description: 'День відпочинку',
    },
  ]
}
