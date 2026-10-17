import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Reservation } from '../types/reservation'
import {
  CLOSING_TIME,
  getDailyAvailability,
  OPENING_TIME,
} from '../utils/availability'
import {
  calendarDate,
  createDateRange,
  formatPeriod,
  fullDateFormatter,
  weekdayFormatter,
} from '../utils/calendar'
import './Calendar.css'

type CalendarProps = {
  startDate: string
  selectedDate: string
  onSelect: (date: string) => void
  reservations: readonly Reservation[]
}

const availabilityLabels = {
  AVAILABLE: 'Вільно',
  PARTIALLY_BOOKED: 'Частково зайнято',
  FULLY_BOOKED: 'Зайнято',
}

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'instant'
    : 'smooth'
}

export default function Calendar({
  startDate,
  selectedDate,
  onSelect,
  reservations,
}: CalendarProps) {
  const dates = useMemo(() => createDateRange(startDate), [startDate])
  const viewportRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({
    first: 0,
    last: 0,
    atStart: true,
    atEnd: false,
  })

  useEffect(() => {
    const viewport = viewportRef.current!
    const updateView = () => {
      const cards = Array.from(
        viewport.querySelectorAll<HTMLButtonElement>('.calendar-day'),
      )
      const left = viewport.scrollLeft
      const right = left + viewport.clientWidth
      const origin = cards[0].offsetLeft
      const visible = cards.flatMap((card, index) =>
        card.offsetLeft - origin + card.offsetWidth > left + 1 &&
        card.offsetLeft - origin < right - 1
          ? [index]
          : [],
      )
      setView({
        first: visible[0] ?? 0,
        last: visible.at(-1) ?? 0,
        atStart: left <= 1,
        atEnd: right >= viewport.scrollWidth - 1,
      })
    }
    updateView()
    const observer = new ResizeObserver(updateView)
    observer.observe(viewport)
    viewport.addEventListener('scroll', updateView, { passive: true })
    return () => {
      observer.disconnect()
      viewport.removeEventListener('scroll', updateView)
    }
  }, [dates])

  const navigate = (direction: number) => {
    const viewport = viewportRef.current!
    const cards = viewport.querySelectorAll<HTMLButtonElement>('.calendar-day')
    const stride = cards[1].offsetLeft - cards[0].offsetLeft
    viewport.scrollTo({
      left: Math.max(
        0,
        Math.min(
          viewport.scrollWidth - viewport.clientWidth,
          viewport.scrollLeft + direction * stride * 7,
        ),
      ),
      behavior: scrollBehavior(),
    })
  }

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = Math.min(index + 1, dates.length - 1)
        break
      case 'ArrowLeft':
        nextIndex = Math.max(index - 1, 0)
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = dates.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const viewport = viewportRef.current!
    const cards = viewport.querySelectorAll<HTMLButtonElement>('.calendar-day')
    const target = cards[nextIndex]
    target.focus({ preventScroll: true })
    const left = target.offsetLeft - cards[0].offsetLeft
    if (
      left < viewport.scrollLeft ||
      left + target.offsetWidth > viewport.scrollLeft + viewport.clientWidth
    ) {
      viewport.scrollTo({ left, behavior: scrollBehavior() })
    }
  }

  return (
    <section className="calendar" aria-labelledby="calendar-title">
      <h2 id="calendar-title" className="calendar-title">
        Оберіть дату
      </h2>
      <div className="calendar-toolbar">
        <p className="calendar-period" aria-live="polite" aria-atomic="true">
          {formatPeriod(dates[view.first], dates[view.last])}
        </p>
        <div className="calendar-navigation">
          <button
            type="button"
            className="calendar-arrow"
            aria-label="Попередні 7 днів"
            aria-controls="calendar-days"
            disabled={view.atStart}
            onClick={() => navigate(-1)}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M19 12H5m6-6-6 6 6 6" />
            </svg>
          </button>
          <button
            type="button"
            className="calendar-arrow"
            aria-label="Наступні 7 днів"
            aria-controls="calendar-days"
            disabled={view.atEnd}
            onClick={() => navigate(1)}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M5 12h14m-6-6 6 6-6 6" />
            </svg>
          </button>
        </div>
      </div>
      <div id="calendar-help" className="calendar-help">
        <p> Доступні дати на 30 днів уперед. </p>
        <p>
          Години роботи: {OPENING_TIME}–{CLOSING_TIME}.
        </p>
        <span className="visually-hidden">
          На клавіатурі: стрілки вліво та вправо переміщують фокус, Home — на
          сьогодні, End — на останню дату. Enter або пробіл обирають дату.
        </span>
      </div>
      <div
        id="calendar-days"
        className="calendar-days"
        ref={viewportRef}
        role="group"
        aria-label="Доступні дати"
        aria-describedby="calendar-help"
      >
        {dates.map((date, index) => {
          const availability = getDailyAvailability(date, reservations)
          const statusLabel = availabilityLabels[availability]
          return (
            <button
              key={date}
              type="button"
              className="calendar-day"
              aria-pressed={selectedDate === date}
              tabIndex={selectedDate === date ? 0 : -1}
              onKeyDown={(event) => handleKeyDown(event, index)}
              onClick={() => onSelect(date)}
            >
              <span className="calendar-weekday">
                {weekdayFormatter.format(calendarDate(date))}
              </span>
              <span className="calendar-number">
                {calendarDate(date).getUTCDate()}
              </span>
              <span className="calendar-today">
                {index === 0 ? 'Сьогодні' : '\u00a0'}
              </span>
              <span
                className="calendar-availability"
                data-status={availability}
              >
                <span className="calendar-status-dot" aria-hidden="true" />
                {statusLabel}
              </span>
              <span className="visually-hidden">
                {fullDateFormatter.format(calendarDate(date))}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
