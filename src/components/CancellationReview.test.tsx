// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import CancellationReview from './CancellationReview'

let host: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
const unauthorized = vi.fn()
const row = {
  id: 'request',
  reservationId: 'booking',
  date: '2026-10-20',
  startTime: '12:00',
  endTime: '14:00',
  nameOrApartment: 'Квартира 12',
  reason: 'Змінилися плани',
  createdAt: 1792400400,
}
const list = () => Response.json({ requests: [row] })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fetchMock = vi.fn<typeof fetch>().mockResolvedValue(list())
  vi.stubGlobal('fetch', fetchMock)
  unauthorized.mockReset()
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
    root.render(<CancellationReview onUnauthorized={unauthorized} />),
  )
}
async function click(label: string) {
  await act(async () => {
    Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === label)!
      .click()
  })
}
test('loads pending requests and displays reservation details and explanation', async () => {
  let resolve!: (response: Response) => void
  fetchMock.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    }),
  )
  await mount()
  expect(host.textContent).toContain('Завантажуємо')
  await act(async () => resolve(list()))
  for (const text of [
    row.date,
    row.startTime,
    row.endTime,
    row.nameOrApartment,
    row.reason,
    'Запит створено',
  ])
    expect(host.textContent).toContain(text)
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/admin/cancellation-requests',
    expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }),
  )
})
test('empty pending list', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ requests: [] }))
  await mount()
  expect(host.textContent).toContain('Немає запитів')
})
for (const action of ['approve', 'reject'] as const) {
  test(`${action} confirms when needed, disables actions, removes processed request and refreshes`, async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await mount()
    const label = action === 'approve' ? 'Схвалити' : 'Відхилити'
    if (action === 'approve') {
      await click(label)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      confirm.mockReturnValue(true)
    }
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
    fetchMock.mockResolvedValueOnce(Response.json({ requests: [] }))
    await act(async () =>
      resolve(
        Response.json({
          request: {
            id: row.id,
            status: action === 'approve' ? 'approved' : 'rejected',
            reviewedAt: 1792400401,
          },
        }),
      ),
    )
    expect(confirm).toHaveBeenCalledTimes(action === 'approve' ? 2 : 0)
    expect(fetchMock.mock.calls[1]).toEqual([
      `/api/admin/cancellation-requests/request/${action}`,
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      }),
    ])
    expect(host.textContent).toContain(
      action === 'approve' ? 'Час звільнено' : 'залишається активним',
    )
    expect(host.textContent).not.toContain(row.reason)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
}
test('failed list can be retried; mutation failure retains the request', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('offline'))
  await mount()
  expect(host.textContent).toContain('Не вдалося завантажити')
  await click('Оновити список')
  fetchMock.mockResolvedValueOnce(Response.json({}, { status: 409 }))
  await click('Відхилити')
  expect(host.textContent).toContain('Запит уже оброблено')
  expect(host.textContent).toContain(row.reason)
  fetchMock.mockRejectedValueOnce(new TypeError('offline'))
  await click('Відхилити')
  expect(host.textContent).toContain('повторіть ту саму дію')
})
test('confirmed success survives a failed refresh', async () => {
  await mount()
  fetchMock.mockResolvedValueOnce(
    Response.json({ request: { id: row.id, status: 'rejected' } }),
  )
  fetchMock.mockRejectedValueOnce(new TypeError('offline'))
  await click('Відхилити')
  expect(host.textContent).toContain('Запит відхилено')
  expect(host.textContent).toContain('Не вдалося завантажити')
  expect(host.textContent).not.toContain(row.reason)
})
test('expired sessions return to login', async () => {
  await mount()
  fetchMock.mockResolvedValueOnce(Response.json({}, { status: 401 }))
  await click('Відхилити')
  expect(unauthorized).toHaveBeenCalledOnce()
})
