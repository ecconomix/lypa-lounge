// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import BookingList from './BookingList'

let host: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
const refresh = vi.fn()
const reason = 'Я з квартири 12, змінилися плани.'
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchMock)
  refresh.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root.render(
      <BookingList
        selectedDate="2026-10-20"
        reservations={[
          {
            id: 'booking-1',
            date: '2026-10-20',
            startTime: '18:00',
            endTime: '20:00',
            nameOrApartment: 'Квартира 12',
          },
        ]}
        onRefresh={refresh}
      />,
    ),
  )
  await act(async () => host.querySelector('button')!.click())
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
async function submit(text = reason) {
  host.querySelector('textarea')!.value = text
  await act(async () => {
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}
test('requires meaningful explanation with Ukrainian feedback', async () => {
  expect(host.textContent).toContain('Вкажіть, хто ви')
  expect(host.querySelector('textarea')?.required).toBe(true)
  for (const text of ['', ' \n ', 'коротко', '..........']) {
    await submit(text)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      '10–1000',
    )
  }
  expect(fetchMock).not.toHaveBeenCalled()
})
test('locks repeated submissions, sends trimmed reason, confirms active booking and refreshes', async () => {
  let resolve!: (response: Response) => void
  fetchMock.mockReturnValueOnce(
    new Promise<Response>((done) => {
      resolve = done
    }),
  )
  await submit(` ${reason} `)
  expect(host.querySelector('textarea')?.disabled).toBe(true)
  expect(host.textContent).toContain('Надсилаємо…')
  await submit()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/reservations/booking-1/cancellation-requests',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  )
  await act(async () =>
    resolve(Response.json({ status: 'pending' }, { status: 201 })),
  )
  expect(host.textContent).toContain('Запит надіслано адміністратору')
  expect(host.textContent).toContain('Бронювання залишається активним')
  expect(host.textContent).toContain('Зайнято')
  expect(host.querySelector('form')).toBeNull()
  expect(refresh).toHaveBeenCalledTimes(1)
})
test('uncertain failure preserves explanation for retry and duplicate response explains review', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('offline'))
  await submit()
  expect(host.querySelector('textarea')?.value).toBe(reason)
  expect(host.textContent).toContain('Не вдалося підтвердити надсилання')
  fetchMock.mockResolvedValueOnce(
    Response.json(
      { error: { code: 'CANCELLATION_REQUEST_CONFLICT' } },
      { status: 409 },
    ),
  )
  await submit()
  expect(host.textContent).toContain('Запит уже очікує розгляду')
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(host.textContent).toContain('Зайнято')
})
test('missing booking displays Ukrainian error', async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json(
      { error: { code: 'RESERVATION_NOT_FOUND' } },
      { status: 404 },
    ),
  )
  await submit()
  expect(host.textContent).toContain('Бронювання не знайдено')
})
