// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'

let host: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
const authenticated = () =>
  Response.json({
    authenticated: true,
    expiresAt: Math.floor(Date.now() / 1000) + 604800,
  })
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.history.replaceState({}, '', '/admin')
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      url === '/api/admin/reservations'
        ? Response.json({ reservations: [] })
        : url === '/api/admin/blocks'
          ? Response.json({ blocks: [] })
          : url === '/api/admin/cancellation-requests'
            ? Response.json({ requests: [] })
            : Response.json({}, { status: 401 }),
    )
  vi.stubGlobal('fetch', fetchMock)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  window.history.replaceState({}, '', '/')
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
async function mount() {
  await act(async () => root.render(<App />))
}
async function submit() {
  await act(async () => {
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}
function fill() {
  host.querySelector('input')!.value = 'test-only-password'
}
test('admin route restores session, logs in and logs out using cookies with booking controls', async () => {
  await mount()
  expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/session')
  fill()
  fetchMock.mockResolvedValueOnce(authenticated())
  await submit()
  expect(host.textContent).toContain('Запити на скасування')
  expect(host.querySelector('input[type="password"]')).toBeNull()
  expect(fetchMock.mock.calls[1]).toEqual([
    '/api/admin/login',
    expect.objectContaining({
      credentials: 'same-origin',
      body: JSON.stringify({ password: 'test-only-password' }),
    }),
  ])
  fetchMock.mockResolvedValueOnce(Response.json({ authenticated: false }))
  await submit()
  expect(host.querySelector('input')?.type).toBe('password')
  expect(host.querySelector('input')?.value).toBe('')
  expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/admin/logout')
  expect(localStorage.length).toBe(0)
  expect(sessionStorage.length).toBe(0)
})
test('restores authenticated state on reload and expires at server deadline', async () => {
  fetchMock.mockResolvedValueOnce(authenticated())
  await mount()
  expect(host.textContent).toContain('Вийти')
  await act(async () => vi.advanceTimersByTime(604800000))
  expect(host.textContent).toContain('Сесію завершено')
  expect(host.querySelector('input')).not.toBeNull()
})
test('shows Ukrainian incorrect-password and rate-limit errors and clears password', async () => {
  await mount()
  fill()
  await submit()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Перевірте пароль',
  )
  expect(host.querySelector('input')?.value).toBe('')
  fill()
  fetchMock.mockResolvedValueOnce(Response.json({}, { status: 429 }))
  await submit()
  expect(host.textContent).toContain('Забагато спроб')
})
test('loading disables duplicate submissions; failed logout preserves controls for retry', async () => {
  await mount()
  fill()
  let resolve!: (response: Response) => void
  fetchMock.mockReturnValueOnce(
    new Promise<Response>((done) => {
      resolve = done
    }),
  )
  await submit()
  expect(host.querySelector('button')?.disabled).toBe(true)
  expect(host.querySelector('input')?.disabled).toBe(true)
  await submit()
  expect(fetchMock).toHaveBeenCalledTimes(2)
  await act(async () => resolve(authenticated()))
  fetchMock.mockRejectedValueOnce(new TypeError('offline'))
  await submit()
  expect(host.textContent).toContain('Не вдалося виконати дію')
  expect(host.textContent).toContain('Вийти')
})
test('visible-tab return detects revocation and session-check failure offers recovery', async () => {
  fetchMock.mockResolvedValueOnce(authenticated())
  await mount()
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(host.querySelector('input')).not.toBeNull()
  fetchMock.mockRejectedValueOnce(new TypeError('offline'))
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(host.textContent).toContain('Оновіть сторінку')
})
