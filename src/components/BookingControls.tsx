import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  AdminError,
  fetchBookingControls,
  mutateBookingControl,
  type AdminReservation,
  type BlockPayload,
} from '../api/admin'
import { createDateRange, getKyivToday } from '../utils/calendar'

const times = Array.from(
  { length: 29 },
  (_, i) =>
    `${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
)

export default function BookingControls({
  onUnauthorized,
  onChanged,
  refreshKey,
}: {
  onUnauthorized: () => void
  onChanged: () => void
  refreshKey: number
}) {
  const [data, setData] = useState<{
    reservations: AdminReservation[]
    blocks: AdminReservation[]
  }>({ reservations: [], blocks: [] })
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [success, setSuccess] = useState('')
  const [revision, setRevision] = useState(0)
  const busy = useRef(false)
  const mounted = useRef(false)
  // Keep uncertain creations tied to their original UUID and normalized payload.
  const retry = useRef<{ payload: BlockPayload; key: string } | null>(null)
  const today = getKyivToday(new Date())
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void fetchBookingControls(controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) {
          setData(rows)
          setLoadError('')
        }
      })
      .catch((failure) => {
        if (controller.signal.aborted) return
        if (failure instanceof AdminError && failure.status === 401)
          onUnauthorized()
        else setLoadError('Не вдалося завантажити списки. Спробуйте ще раз.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [revision, refreshKey, onUnauthorized])

  async function mutate(
    path: string,
    method: 'POST' | 'DELETE',
    payload?: BlockPayload,
    form?: HTMLFormElement,
  ) {
    if (busy.current) return
    busy.current = true
    setProcessing(true)
    setError('')
    setSuccess('')
    let key: string | undefined
    if (payload) {
      if (
        !retry.current ||
        JSON.stringify(retry.current.payload) !== JSON.stringify(payload)
      )
        retry.current = { payload, key: crypto.randomUUID() }
      key = retry.current.key
    }
    try {
      await mutateBookingControl(path, method, payload, key)
      if (!mounted.current) return
      if (payload) {
        retry.current = null
        form?.reset()
      } else {
        const id = decodeURIComponent(path.split('/')[1])
        setData((rows) => ({
          reservations: rows.reservations.filter((row) => row.id !== id),
          blocks: rows.blocks.filter((row) => row.id !== id),
        }))
      }
      setSuccess(payload ? 'Технічне блокування створено.' : 'Час звільнено.')
      setLoading(true)
      onChanged()
    } catch (failure) {
      if (!mounted.current) return
      if (failure instanceof AdminError && failure.status === 401)
        onUnauthorized()
      else if (failure instanceof AdminError && failure.status === 409) {
        setError('Цей час уже зайнятий. Оновлюємо списки.')
        setRevision((value) => value + 1)
      } else if (failure instanceof AdminError && failure.status === 400) {
        setError(
          'Перевірте дату та час: від сьогодні до 30 днів уперед, 08:00–22:00, крок 30 хвилин, без минулого часу. Причина — до 1000 символів.',
        )
      } else
        setError(
          'Не вдалося виконати дію. Перевірте з’єднання та повторіть ту саму дію.',
        )
    } finally {
      busy.current = false
      if (mounted.current) setProcessing(false)
    }
  }
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    const payload = {
      date: String(fields.get('date')),
      startTime: String(fields.get('startTime')),
      endTime: String(fields.get('endTime')),
      reason: String(fields.get('reason')).trim(),
    }
    if (payload.endTime <= payload.startTime) {
      setError('Час завершення має бути пізніше початку.')
      return
    }
    void mutate('blocks', 'POST', payload, form)
  }
  const disabled = loading || processing
  function list(rows: AdminReservation[], block: boolean) {
    return (
      <ul className="admin-review-list">
        {rows.map((row) => (
          <li key={row.id}>
            <h3>
              {row.date} · {row.startTime}–{row.endTime}
            </h3>
            {!block && (
              <p>
                <strong>Ім’я або квартира:</strong> {row.nameOrApartment}
              </p>
            )}
            {row.description && (
              <p className="admin-review-reason">{row.description}</p>
            )}
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                if (
                  window.confirm(
                    `${block ? 'Прибрати блокування' : 'Скасувати бронювання'} ${row.date}, ${row.startTime}–${row.endTime}?`,
                  )
                )
                  void mutate(
                    `${block ? 'blocks' : 'reservations'}/${encodeURIComponent(row.id)}${block ? '' : '/cancel'}`,
                    block ? 'DELETE' : 'POST',
                  )
              }}
            >
              {block ? 'Прибрати блокування' : 'Скасувати бронювання'}
            </button>
          </li>
        ))}
      </ul>
    )
  }
  return (
    <section
      className="booking-form admin-reviews"
      aria-label="Керування бронюваннями"
    >
      {success && (
        <p role="status" className="booking-form-success">
          {success}
        </p>
      )}
      {loadError && (
        <p role="alert" className="booking-form-error">
          {loadError}
        </p>
      )}
      {error && (
        <p role="alert" className="booking-form-error">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setLoading(true)
          setRevision((value) => value + 1)
        }}
      >
        Оновити бронювання та блокування
      </button>
      {loading && <p role="status">Завантажуємо списки…</p>}
      <h2>Бронювання</h2>
      {!loading && !error && !loadError && !data.reservations.length && (
        <p>Немає активних бронювань.</p>
      )}
      {list(data.reservations, false)}
      <h2>Технічні блокування</h2>
      <form onSubmit={create}>
        <fieldset disabled={disabled} className="admin-block-fields">
          <legend>Нове блокування</legend>
          <label>
            Дата
            <input
              name="date"
              type="date"
              min={today}
              max={createDateRange(today).at(-1)}
              defaultValue={today}
              required
            />
          </label>
          <label>
            Початок
            <select name="startTime" defaultValue="08:00">
              {times.slice(0, -1).map((time) => (
                <option key={time}>{time}</option>
              ))}
            </select>
          </label>
          <label>
            Завершення
            <select name="endTime" defaultValue="08:30">
              {times.slice(1).map((time) => (
                <option key={time}>{time}</option>
              ))}
            </select>
          </label>
          <label>
            Внутрішня причина (необов’язково)
            <textarea name="reason" maxLength={1000} />
          </label>
          <button type="submit" disabled={disabled}>
            Створити блокування
          </button>
        </fieldset>
      </form>
      {!loading && !error && !loadError && !data.blocks.length && (
        <p>Немає активних блокувань.</p>
      )}
      {list(data.blocks, true)}
    </section>
  )
}
