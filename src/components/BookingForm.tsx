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
import './BookingForm.css'

type BookingFormProps = {
  selectedDate: string
  reservations: readonly Reservation[]
  onBookingCreated: (reservation: Reservation) => void
}

export default function BookingForm({
  selectedDate,
  reservations,
  onBookingCreated,
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

  // Reset only date-dependent state before rendering a newly selected day.
  if (times.date !== selectedDate) {
    setTimes({ date: selectedDate, start: '', end: '' })
    setError(null)
    setSuccess(false)
  }

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
    if (submitting.current) return

    const submissionTime = new Date()
    // Validate the original selection so an expired slot gets a useful error.
    const validationError = validateBooking(
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

    submitting.current = true
    try {
      onBookingCreated({
        id: crypto.randomUUID(),
        date: selectedDate,
        startTime: times.start,
        endTime: times.end,
        nameOrApartment: nameOrApartment.trim(),
        description: description.trim() || undefined,
      })
      setTimes({ date: selectedDate, start: '', end: '' })
      setSuccess(true)
    } finally {
      // Hold the guard until React has processed this synchronous submission.
      queueMicrotask(() => {
        submitting.current = false
      })
    }
  }

  const clearFeedback = () => {
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
          <p className="booking-form-success">Бронювання успішно створено.</p>
        )}
      </div>
      <div id="booking-form-error" role="alert" aria-atomic="true">
        {error && error.field !== 'name' && (
          <p className="booking-form-error">{error.message}</p>
        )}
      </div>
      {!dateAllowed ? (
        <p className="booking-form-empty">
          Оберіть дату від сьогодні до 30 днів уперед у календарі.
        </p>
      ) : startTimes.length === 0 ? (
        <p className="booking-form-empty">
          На цей день немає вільного часу для бронювання.
        </p>
      ) : (
        <form noValidate onSubmit={handleSubmit} onChange={clearFeedback}>
          <p id="booking-form-help" className="booking-form-help">
            Години роботи: 08:00–22:00. Мінімальна тривалість — 30 хвилин. Поля
            з * обов’язкові.
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
              value={nameOrApartment}
              aria-invalid={error?.field === 'name'}
              aria-describedby={
                error?.field === 'name' ? 'booking-form-name-error' : undefined
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
              value={description}
              aria-describedby="booking-form-description-help"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <p id="booking-form-description-help" className="booking-form-help">
            Необов’язково.
          </p>
          <button type="submit">Забронювати</button>
        </form>
      )}
    </section>
  )
}
