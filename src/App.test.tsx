// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

const date = '2026-10-20'
const booking = {
  id: 'booking-1',
  date,
  startTime: '18:00',
  endTime: '19:00',
  nameOrApartment: 'Квартира 12',
  description: null,
}
let host: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
const response = (reservations: unknown[] = []) =>
  Response.json({ reservations })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}
async function mount() {
  await act(async () => root.render(<App />))
}
function findButton(text: string) {
  const result = [...host.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text),
  )
  if (!result) throw new Error(`Missing button ${text}`)
  return result
}
async function click(button: HTMLButtonElement) {
  await act(async () => button.click())
}
async function change(name: string, value: string) {
  const control = host.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[name="${name}"]`,
  )!
  const prototype =
    control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
      control,
      value,
    )
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    )
  })
}
async function fill() {
  await click(host.querySelectorAll<HTMLButtonElement>('.calendar-day')[2])
  await change('startTime', '18:00')
  await change('endTime', '19:00')
  await change('nameOrApartment', ' Квартира 12 ')
  await change('description', ' Свято ')
}
async function submit() {
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
}
function posts() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
}
function visibility() {
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-17T21:30:00Z')) // Already Oct 18 in Kyiv.
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('availability and calendar', () => {
  it('loads one Kyiv 31-day range and hides fake availability while loading', async () => {
    const pending = deferred<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    await mount()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/availability?from=2026-10-18&to=2026-11-17',
    )
    expect(host.textContent).toContain('Завантажуємо календар')
    expect(host.querySelector('.calendar-day')).toBeNull()
    expect(host.querySelector('form')).toBeNull()
    pending.resolve(response())
    await flush()
    expect(host.querySelectorAll('.calendar-day')).toHaveLength(31)
    expect(host.textContent).toContain('На цей день бронювань немає')
  })
  it('uses API reservations for all three statuses and filters dates without fetching', async () => {
    fetchMock.mockResolvedValueOnce(
      response([
        booking,
        {
          ...booking,
          id: 'full',
          date: '2026-10-21',
          startTime: '08:00',
          endTime: '22:00',
        },
      ]),
    )
    await mount()
    const days = host.querySelectorAll<HTMLButtonElement>('.calendar-day')
    expect(days[0].textContent).toContain('Вільно')
    expect(days[2].textContent).toContain('Частково зайнято')
    expect(days[3].textContent).toContain('Зайнято')
    await click(days[2])
    expect(host.querySelector('.booking-list')?.textContent).toContain(
      'Квартира 12',
    )
    expect(host.querySelector('[name="startTime"]')?.textContent).not.toContain(
      '18:00',
    )
    await click(days[1])
    expect(host.querySelector('.booking-list')?.textContent).not.toContain(
      'Квартира 12',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each(['network', 'malformed', '400', '500'])(
    'offers retry after %s loading failure',
    async (failure) => {
      if (failure === 'network')
        fetchMock.mockRejectedValueOnce(new TypeError('offline'))
      else
        fetchMock.mockResolvedValueOnce(
          failure === 'malformed'
            ? Response.json({ reservations: [{}] })
            : new Response('{}', { status: Number(failure) }),
        )
      await mount()
      expect(host.textContent).toContain('Не вдалося оновити календар')
      expect(host.querySelector('form')).toBeNull()
      await click(findButton('Спробувати ще раз'))
      expect(host.querySelector('form')).not.toBeNull()
    },
  )
})

describe('reservation submissions', () => {
  it('posts normalized JSON with a UUID, guards duplicate submissions, resets form and refreshes without changing date', async () => {
    await mount()
    await fill()
    const pending = deferred<Response>()
    fetchMock
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response([{ ...booking, description: 'Свято' }]))
    await submit()
    await submit()
    expect(posts()).toHaveLength(1)
    expect(findButton('Надсилаємо').disabled).toBe(true)
    const [, init] = posts()[0]
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      'Idempotency-Key': expect.stringMatching(/^[\da-f-]{36}$/),
    })
    expect(JSON.parse(init!.body as string)).toEqual({
      date,
      startTime: '18:00',
      endTime: '19:00',
      nameOrApartment: 'Квартира 12',
      description: 'Свято',
    })
    pending.resolve(Response.json({ reservation: booking }, { status: 201 }))
    await flush()
    expect(host.textContent).toContain('Бронювання успішно створено')
    expect(
      host.querySelector<HTMLInputElement>('[name="nameOrApartment"]')?.value,
    ).toBe('')
    expect(
      host.querySelector<HTMLInputElement>('[name="description"]')?.value,
    ).toBe('')
    expect(
      host.querySelector<HTMLSelectElement>('[name="startTime"]')?.value,
    ).toBe('')
    expect(host.querySelector('[aria-pressed="true"]')?.textContent).toContain(
      '20',
    )
    expect(host.querySelector('.booking-list')?.textContent).toContain(
      'Квартира 12',
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
  it('preserves confirmed success and reservation if the subsequent GET fails, and allows refresh retry', async () => {
    await mount()
    await fill()
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ reservation: booking }, { status: 201 }),
      )
      .mockRejectedValueOnce(new TypeError('offline'))
    await submit()
    expect(host.textContent).toContain('Бронювання успішно створено')
    expect(host.querySelector('.booking-list')?.textContent).toContain(
      'Квартира 12',
    )
    fetchMock.mockResolvedValueOnce(response([booking]))
    await click(findButton('Спробувати ще раз'))
    expect(host.textContent).toContain('Бронювання успішно створено')
    expect(posts()).toHaveLength(1)
  })
  it('refreshes on reservation conflict and clears only times', async () => {
    await mount()
    await fill()
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'RESERVATION_CONFLICT' } },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(response([booking]))
    await submit()
    expect(host.textContent).toContain('цей час щойно забронювали')
    expect(
      host.querySelector<HTMLInputElement>('[name="nameOrApartment"]')?.value,
    ).toBe(' Квартира 12 ')
    expect(
      host.querySelector<HTMLInputElement>('[name="description"]')?.value,
    ).toBe(' Свято ')
    expect(
      host.querySelector<HTMLSelectElement>('[name="startTime"]')?.value,
    ).toBe('')
    expect(
      host.querySelector<HTMLSelectElement>('[name="endTime"]')?.value,
    ).toBe('')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
  it('handles an idempotency conflict separately', async () => {
    await mount()
    await fill()
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: { code: 'IDEMPOTENCY_CONFLICT' } },
        { status: 409 },
      ),
    )
    await submit()
    expect(host.textContent).toContain('Ключ цього запиту вже використано')
    expect(
      host.querySelector<HTMLSelectElement>('[name="startTime"]')?.value,
    ).toBe('18:00')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it.each(['network', '500', 'malformed', 'cancelled'])(
    'retains key and payload after uncertain %s outcome',
    async (kind) => {
      await mount()
      await fill()
      if (kind === 'network')
        fetchMock.mockRejectedValueOnce(new TypeError('lost response'))
      else if (kind === 'cancelled')
        fetchMock.mockRejectedValueOnce(
          new DOMException('cancelled', 'AbortError'),
        )
      else
        fetchMock.mockResolvedValueOnce(
          new Response('{}', { status: kind === '500' ? 500 : 201 }),
        )
      await submit()
      expect(host.textContent).toContain('Бронювання могло зберегтися')
      expect(
        host.querySelector<HTMLInputElement>('[name="nameOrApartment"]')?.value,
      ).toContain('Квартира 12')
      // Even when a visibility refresh discovers the committed row, retry must replay.
      fetchMock.mockResolvedValueOnce(response([booking]))
      await act(async () => visibility())
      fetchMock.mockResolvedValueOnce(
        Response.json({ reservation: booking }, { status: 201 }),
      )
      await click(findButton('Повторити той самий запит'))
      expect(posts()).toHaveLength(2)
      expect(posts()[1][1]?.headers).toEqual(posts()[0][1]?.headers)
      expect(posts()[1][1]?.body).toEqual(posts()[0][1]?.body)
      expect(host.textContent).toContain('Бронювання успішно створено')
    },
  )
  it('replays an uncertain attempt after its day expires without revalidating it', async () => {
    await mount()
    await fill()
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    await submit()
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
    await act(async () => vi.advanceTimersByTime(30_000))
    fetchMock.mockResolvedValueOnce(
      Response.json({ reservation: booking }, { status: 201 }),
    )
    await click(findButton('Повторити той самий запит'))
    expect(posts()[1][1]?.headers).toEqual(posts()[0][1]?.headers)
    expect(posts()[1][1]?.body).toEqual(posts()[0][1]?.body)
    expect(host.textContent).toContain('Бронювання успішно створено')
  })
  it('retains the key when only normalized whitespace changes', async () => {
    await mount()
    await fill()
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    await submit()
    await change('nameOrApartment', 'Квартира 12')
    fetchMock.mockResolvedValueOnce(
      Response.json({ reservation: booking }, { status: 201 }),
    )
    await submit()
    expect(posts()[1][1]?.headers).toEqual(posts()[0][1]?.headers)
  })
  it('generates a new key for changed normalized payload after uncertain failure', async () => {
    await mount()
    await fill()
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    await submit()
    await change('description', 'Інша подія')
    fetchMock.mockResolvedValueOnce(
      Response.json({ reservation: booking }, { status: 201 }),
    )
    await submit()
    expect(posts()[1][1]?.headers).not.toEqual(posts()[0][1]?.headers)
  })
  it('uses a fresh key for a new booking after success', async () => {
    await mount()
    await fill()
    fetchMock.mockResolvedValueOnce(
      Response.json({ reservation: booking }, { status: 201 }),
    )
    await submit()
    await fill()
    fetchMock.mockResolvedValueOnce(
      Response.json({ reservation: booking }, { status: 201 }),
    )
    await submit()
    expect(posts()[1][1]?.headers).not.toEqual(posts()[0][1]?.headers)
  })
})

describe('lifecycle', () => {
  it('refreshes only on visible and deduplicates simultaneous requests', async () => {
    await mount()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => visibility())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const pending = deferred<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    await act(async () => {
      visibility()
      visibility()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(host.querySelector('.calendar')).not.toBeNull()
    pending.resolve(response())
    await flush()
  })
  it('cancels older GETs after a successful POST and ignores late responses', async () => {
    await mount()
    await fill()
    const old = deferred<Response>()
    fetchMock.mockReturnValueOnce(old.promise)
    await act(async () => visibility())
    const signal = fetchMock.mock.calls[1][1]?.signal
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ reservation: booking }, { status: 201 }),
      )
      .mockResolvedValueOnce(response([booking]))
    await submit()
    expect(signal?.aborted).toBe(true)
    old.resolve(response())
    await flush()
    expect(host.querySelector('.booking-list')?.textContent).toContain(
      'Квартира 12',
    )
  })
  it.each([false, true])(
    'rolls the Kyiv range over and preserves valid selection (%s)',
    async (preserve) => {
      await mount()
      if (preserve)
        await click(
          host.querySelectorAll<HTMLButtonElement>('.calendar-day')[2],
        )
      vi.setSystemTime(new Date('2026-10-18T21:00:00Z'))
      await act(async () => vi.advanceTimersByTime(30_000))
      expect(fetchMock.mock.calls[1][0]).toBe(
        '/api/availability?from=2026-10-19&to=2026-11-18',
      )
      expect(
        host.querySelector('[aria-pressed="true"] .calendar-number')
          ?.textContent,
      ).toBe(preserve ? '20' : '19')
      expect(
        host.querySelector('.calendar-day .calendar-number')?.textContent,
      ).toBe('19')
      await act(async () => vi.advanceTimersByTime(60_000))
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )
  it('aborts GET on unmount', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}))
    await mount()
    const signal = fetchMock.mock.calls[0][1]?.signal
    await act(async () => root.unmount())
    expect(signal?.aborted).toBe(true)
    root = createRoot(host)
  })
})
