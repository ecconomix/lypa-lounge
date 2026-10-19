import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Reservation } from '../types/reservation'
import {
  getAvailableEndTimes,
  getAvailableStartTimes,
  isBookableDate,
  validateBooking,
} from '../utils/booking'
import type { BookingError } from '../utils/booking'
import { calendarDate, fullDateFormatter } from '../utils/calendar'
import { ApiError, createReservation } from '../api/reservations'
import type { BookingPayload } from '../api/reservations'
import './BookingForm.css'

type BookingFormProps = {
  selectedDate: string
  reservations: readonly Reservation[]
  onBookingCreated: (reservation: Reservation) => void
  onConflict: () => void
  availabilityReady: boolean
}

export default function BookingForm({
  selectedDate,
  reservations,
  onBookingCreated,
  onConflict,
  availabilityReady,
}: BookingFormProps) {
  const [times, setTimes] = useState({
    date: selectedDate,
    start: '',
    end: '',
  })
  const [nameOrApartment, setNameOrApartment] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<BookingError | null>(null)
  const [success, setSuccess] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const submitting = useRef(false)
  const [pending, setPending] = useState(false)
  const attempt = useRef<{ payload: BookingPayload; key: string } | null>(null)
  const [uncertain, setUncertain] = useState(false)

  const send = async (payload: BookingPayload) => {
    if (submitting.current) return
    submitting.current = true
    setPending(true)
    setError(null)
    if (
      !attempt.current ||
      JSON.stringify(attempt.current.payload) !== JSON.stringify(payload)
    ) {
      attempt.current = { payload, key: crypto.randomUUID() }
    }
    try {
      const reservation = await createReservation(payload, attempt.current.key)
      attempt.current = null
      setUncertain(false)
      setTimes((current) => ({ ...current, start: '', end: '' }))
      setNameOrApartment('')
      setDescription('')
      setSuccess(true)
      onBookingCreated(reservation)
    } catch (failure) {
      const known =
        failure instanceof ApiError &&
        failure.status >= 400 &&
        failure.status < 500
      setUncertain(!known)
      let message =
        'Не вдалося отримати підтвердження. Бронювання могло зберегтися. Повторіть той самий запит кнопкою нижче.'
      if (known) {
        attempt.current = null
        if (failure.status === 409 && failure.code === 'RESERVATION_CONFLICT') {
          setTimes((current) => ({ ...current, start: '', end: '' }))
          onConflict()
          message =
            'На жаль, цей час щойно забронювали. Оновлюємо календар — оберіть інший вільний час.'
        } else if (failure.code === 'IDEMPOTENCY_CONFLICT') {
          message =
            'Ключ цього запиту вже використано. Перевірте календар перед новим бронюванням.'
        } else {
          message =
            'Не вдалося створити бронювання. Перевірте введені дані та спробуйте ще раз.'
        }
      }
      setError({ field: 'times', message })
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  // Reset only date-dependent state before rendering a newly selected day.
  if (times.date !== selectedDate) {
    setTimes({ date: selectedDate, start: '', end: '' })
    setError(null)
  }

  useEffect(() => {
    if (!success) return
    const timeout = window.setTimeout(() => setSuccess(false), 5000)
    return () => window.clearTimeout(timeout)
  }, [success])

  useEffect(() => {
    const refreshTime = () => setNow(new Date())
    const interval = window.setInterval(refreshTime, 30_000)
    window.addEventListener('focus', refreshTime)
    document.addEventListener('visibilitychange', refreshTime)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshTime)
      document.removeEventListener('visibilitychange', refreshTime)
    }
  }, [])

  const startTimes = getAvailableStartTimes(selectedDate, reservations, now)
  const startTime = startTimes.includes(times.start) ? times.start : ''
  const endTimes = getAvailableEndTimes(selectedDate, startTime, reservations)
  const endTime = endTimes.includes(times.end) ? times.end : ''
  const dateAllowed = isBookableDate(selectedDate, now)

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting.current || !availabilityReady) return

    const submissionTime = new Date()
    // Validate the original selection so an expired slot gets a useful error.
    const sameAttempt =
      attempt.current &&
      JSON.stringify(attempt.current.payload) ===
        JSON.stringify({
          date: selectedDate,
          startTime: times.start,
          endTime: times.end,
          nameOrApartment: nameOrApartment.trim(),
          description: description.trim() || undefined,
        })
    const validationError = sameAttempt
      ? null
      : validateBooking(
          selectedDate,
          times.start,
          times.end,
          nameOrApartment,
          reservations,
          submissionTime,
        )
    setNow(submissionTime)
    setError(validationError)
    setSuccess(false)
    if (validationError) {
      const fieldName =
        validationError.field === 'name'
          ? 'nameOrApartment'
          : !times.start || validationError.field === 'date'
            ? 'startTime'
            : 'endTime'
      const control = event.currentTarget.elements.namedItem(fieldName)
      if (control instanceof HTMLElement) control.focus()
      return
    }

    void send({
      date: selectedDate,
      startTime: times.start,
      endTime: times.end,
      nameOrApartment: nameOrApartment.trim(),
      description: description.trim() || undefined,
    })
  }

  const clearFeedback = () => {
    setUncertain(false)
    setError(null)
    setSuccess(false)
  }

  return (
    <section className="booking-form" aria-labelledby="booking-form-title">
      <h2 id="booking-form-title">
        Забронювати на обрану дату
        <time className="booking-form-date" dateTime={selectedDate}>
          {fullDateFormatter.format(calendarDate(selectedDate))}
        </time>
      </h2>
      <div role="status" aria-atomic="true">
        {success && (
          <div className="booking-form-success">
            <span>Бронювання успішно створено.</span>
            <button
              type="button"
              className="booking-form-dismiss"
              aria-label="Закрити повідомлення про успішне бронювання"
              onClick={() => setSuccess(false)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        )}
      </div>
      <div id="booking-form-error" role="alert" aria-atomic="true">
        {error && error.field !== 'name' && (
          <p className="booking-form-error">{error.message}</p>
        )}
      </div>
      {uncertain && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (attempt.current) void send(attempt.current.payload)
          }}
        >
          {pending ? 'Надсилаємо…' : 'Повторити той самий запит'}
        </button>
      )}
      {!availabilityReady ? (
        <p className="booking-form-empty">
          Бронювання буде доступне після завантаження календаря.
        </p>
      ) : !dateAllowed ? (
        <p className="booking-form-empty">
          Оберіть дату від сьогодні до 30 днів уперед у календарі.
        </p>
      ) : startTimes.length === 0 ? (
        <p className="booking-form-empty">
          На цей день немає вільного часу для бронювання.
        </p>
      ) : (
        <form noValidate onSubmit={handleSubmit} onChange={clearFeedback}>
          <fieldset disabled={pending}>
            <p id="booking-form-help" className="booking-form-help">
              Години роботи: 08:00–22:00. Мінімальна тривалість — 30 хвилин.
              Поля з * обов’язкові.
            </p>
            <div className="booking-form-times">
              <label>
                Час початку *
                <select
                  name="startTime"
                  required
                  value={startTime}
                  aria-describedby="booking-form-help booking-form-error"
                  aria-invalid={error?.field === 'times'}
                  onChange={(event) =>
                    setTimes({
                      date: selectedDate,
                      start: event.target.value,
                      end: '',
                    })
                  }
                >
                  <option value="">Оберіть час</option>
                  {startTimes.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Час завершення *
                <select
                  name="endTime"
                  required
                  disabled={!startTime}
                  value={endTime}
                  aria-describedby="booking-form-help booking-form-error"
                  aria-invalid={error?.field === 'times'}
                  onChange={(event) =>
                    setTimes({ ...times, end: event.target.value })
                  }
                >
                  <option value="">Оберіть час</option>
                  {endTimes.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Ім’я або номер квартири *
              <input
                name="nameOrApartment"
                type="text"
                required
                maxLength={100}
                value={nameOrApartment}
                aria-invalid={error?.field === 'name'}
                aria-describedby={
                  error?.field === 'name'
                    ? 'booking-form-name-error'
                    : undefined
                }
                onChange={(event) => setNameOrApartment(event.target.value)}
              />
            </label>
            {error?.field === 'name' && (
              <p
                id="booking-form-name-error"
                className="booking-form-field-error"
                role="alert"
              >
                {error.message}
              </p>
            )}
            <label>
              Опис події
              <input
                name="description"
                type="text"
                maxLength={1000}
                value={description}
                aria-describedby="booking-form-description-help"
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <p id="booking-form-description-help" className="booking-form-help">
              Необов’язково.
            </p>
            <button type="submit" disabled={pending}>
              {pending ? 'Надсилаємо…' : 'Забронювати'}
            </button>
          </fieldset>
        </form>
      )}
    </section>
  )
}
