// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import BookingControls from './BookingControls'

let host: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
const unauthorized = vi.fn()
const changed = vi.fn()
const booking = {
  id: 'booking',
  date: '2026-10-20',
  startTime: '12:00',
  endTime: '14:00',
  nameOrApartment: 'Квартира 12',
  description: 'Обід',
  createdAt: 100,
}
const block = { ...booking, id: 'block', description: 'Прибирання' }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  unauthorized.mockReset()
  changed.mockReset()
  fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      Response.json(
        url === '/api/admin/reservations'
          ? { reservations: [booking] }
          : { blocks: [block] },
      ),
    )
  vi.stubGlobal('fetch', fetchMock)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
async function mount() {
  await act(async () =>
    root.render(
      <BookingControls
        onUnauthorized={unauthorized}
        onChanged={changed}
        refreshKey={0}
      />,
    ),
  )
}
async function click(label: string) {
  await act(async () => {
    Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === label)!
      .click()
  })
}
async function submit() {
  await act(async () => {
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

test('lists reservation and internal block details', async () => {
  await mount()
  for (const text of [
    booking.date,
    booking.startTime,
    booking.endTime,
    booking.nameOrApartment,
    booking.description,
    block.description,
  ])
    expect(host.textContent).toContain(text)
})
for (const [label, path, method] of [
  ['Скасувати бронювання', 'reservations/booking/cancel', 'POST'],
  ['Прибрати блокування', 'blocks/block', 'DELETE'],
]) {
  test(`${label} confirms, disables submissions and refreshes related sections`, async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await mount()
    await click(label)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    confirm.mockReturnValue(true)
    let resolve!: (response: Response) => void
    fetchMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    await click(label)
    expect(
      Array.from(host.querySelectorAll('button')).every(
        (button) => button.disabled,
      ),
    ).toBe(true)
    await act(async () =>
      resolve(
        Response.json({ reservation: { id: 'booking', status: 'cancelled' } }),
      ),
    )
    expect(fetchMock.mock.calls[2]).toEqual([
      `/api/admin/${path}`,
      expect.objectContaining({
        method,
        body: '{}',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      }),
    ])
    expect(host.textContent).toContain('Час звільнено')
    expect(changed).toHaveBeenCalledOnce()
  })
}
test('creates a block with an optional reason and retains its UUID on uncertain retry', async () => {
  await mount()
  const input = host.querySelector<HTMLInputElement>('[name="date"]')!
  input.value = '2026-10-20'
  host.querySelector<HTMLTextAreaElement>('textarea')!.value = ' Прибирання '
  fetchMock.mockRejectedValueOnce(new TypeError('offline'))
  await submit()
  expect(host.textContent).toContain('повторіть ту саму дію')
  fetchMock.mockResolvedValueOnce(Response.json({}, { status: 201 }))
  await submit()
  const first = fetchMock.mock.calls[2]
  expect(first).toEqual([
    '/api/admin/blocks',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        date: '2026-10-20',
        startTime: '08:00',
        endTime: '08:30',
        reason: 'Прибирання',
      }),
    }),
  ])
  expect(fetchMock.mock.calls[3][1]?.headers).toEqual(first[1]?.headers)
  expect(host.textContent).toContain('блокування створено')
  expect(changed).toHaveBeenCalledOnce()
})
test('loading, failed list recovery, invalid range and session expiration', async () => {
  let resolve!: (response: Response) => void
  fetchMock.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    }),
  )
  await mount()
  expect(host.textContent).toContain('Завантажуємо')
  await act(async () => resolve(Response.json({}, { status: 500 })))
  expect(host.textContent).toContain('Не вдалося завантажити')
  await click('Оновити бронювання та блокування')
  host.querySelector<HTMLSelectElement>('[name="endTime"]')!.value = '08:30'
  host.querySelector<HTMLSelectElement>('[name="startTime"]')!.value = '09:00'
  await submit()
  expect(host.textContent).toContain('завершення має бути пізніше')
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  fetchMock.mockResolvedValueOnce(Response.json({}, { status: 401 }))
  await click('Скасувати бронювання')
  expect(unauthorized).toHaveBeenCalledOnce()
})
test('confirmed creation survives a failed refresh', async () => {
  await mount()
  fetchMock.mockResolvedValueOnce(Response.json({}, { status: 201 }))
  await submit()
  fetchMock.mockRejectedValue(new TypeError('offline'))
  await act(async () =>
    root.render(
      <BookingControls
        onUnauthorized={unauthorized}
        onChanged={changed}
        refreshKey={1}
      />,
    ),
  )
  expect(host.textContent).toContain('блокування створено')
  expect(host.textContent).toContain('Не вдалося завантажити')
})
