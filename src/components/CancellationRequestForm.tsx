import { useId, useRef, useState, type SubmitEvent } from 'react'
import { ApiError, requestCancellation } from '../api/reservations'
import './CancellationRequestForm.css'

type Props = { reservationId: string; onRefresh: () => void }

export default function CancellationRequestForm({
  reservationId,
  onRefresh,
}: Props) {
  const id = useId()
  const busy = useRef(false)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy.current || done) return
    const reason = String(
      new FormData(event.currentTarget).get('reason') ?? '',
    ).trim()
    if (
      reason.length < 10 ||
      reason.length > 1000 ||
      !/[\p{L}\p{N}]/u.test(reason) ||
      reason.includes('\0')
    ) {
      setMessage(
        'Вкажіть, хто ви та чому просите скасувати бронювання (10–1000 символів).',
      )
      return
    }
    busy.current = true
    setPending(true)
    setMessage('')
    try {
      await requestCancellation(reservationId, reason)
      setDone(true)
      onRefresh()
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setMessage(
          'Запит уже очікує розгляду або бронювання більше не підлягає скасуванню.',
        )
        onRefresh()
      } else if (error instanceof ApiError && error.status === 404) {
        setMessage('Бронювання не знайдено. Оновіть календар.')
      } else if (error instanceof ApiError && error.code === 'INVALID_REASON') {
        setMessage(
          'Вкажіть, хто ви та чому просите скасувати бронювання (10–1000 символів).',
        )
      } else {
        setMessage(
          'Не вдалося підтвердити надсилання. Перевірте з’єднання та спробуйте ще раз. Повторний запит не буде створено, якщо попередній очікує розгляду.',
        )
      }
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  return (
    <div className="cancellation-request">
      {done ? (
        <p role="status">
          Запит надіслано адміністратору. Бронювання залишається активним, а час
          — зайнятим до схвалення адміністратором.
        </p>
      ) : (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(!open)}
            disabled={pending}
          >
            Запросити скасування
          </button>
          {open && (
            <form id={id} onSubmit={submit} noValidate>
              <label htmlFor={`${id}-reason`}>Пояснення</label>
              <p id={`${id}-help`}>
                Вкажіть, хто ви (ім’я або квартиру) та причину скасування.
                10–1000 символів. Пояснення побачить адміністратор. Бронювання
                залишається активним, а час — зайнятим до схвалення
                адміністратором.
              </p>
              <textarea
                id={`${id}-reason`}
                name="reason"
                required
                rows={4}
                maxLength={1000}
                disabled={pending}
                aria-describedby={`${id}-help`}
              />
              {message && <p role="alert">{message}</p>}
              <button type="submit" disabled={pending}>
                {pending ? 'Надсилаємо…' : 'Надіслати запит'}
              </button>
            </form>
          )}
        </>
      )}
    </div>
  )
}
