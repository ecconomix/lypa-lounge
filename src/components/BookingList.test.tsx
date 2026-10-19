// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import BookingList from './BookingList'

test('public technical blocks display occupied time without a cancellation request form', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <BookingList
          selectedDate="2026-10-20"
          onRefresh={() => {}}
          reservations={[
            {
              id: 'block',
              date: '2026-10-20',
              startTime: '12:00',
              endTime: '14:00',
              nameOrApartment: 'Технічне блокування',
              isTechnicalBlock: true,
            },
          ]}
        />,
      ),
    )
    expect(host.textContent).toContain('Технічне блокування')
    expect(host.textContent).toContain('Зайнято')
    expect(host.querySelector('button')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})
