import type { Reservation } from '../types/reservation'
import { calendarDate, fullDateFormatter } from '../utils/calendar'
import './BookingList.css'

type BookingListProps = {
  selectedDate: string
  reservations: readonly Reservation[]
}

export default function BookingList({
  selectedDate,
  reservations,
}: BookingListProps) {
  const bookings = reservations
    .filter((reservation) => reservation.date === selectedDate)
    .sort(
      (a, b) =>
        a.startTime.localeCompare(b.startTime) ||
        a.endTime.localeCompare(b.endTime),
    )

  return (
    <section
      className="booking-list"
      aria-labelledby="booking-list-title"
      aria-live="polite"
      aria-atomic="true"
    >
      <h2 id="booking-list-title">Бронювання на обрану дату</h2>
      <p className="booking-list-date">
        <time dateTime={selectedDate}>
          {fullDateFormatter.format(calendarDate(selectedDate))}
        </time>
      </p>
      {bookings.length === 0 ? (
        <p className="booking-list-empty">На цей день бронювань немає.</p>
      ) : (
        <ul className="booking-list-items">
          {bookings.map((booking) => (
            <li key={booking.id} className="booking">
              <div className="booking-details">
                <p className="booking-time">
                  <time dateTime={booking.startTime}>{booking.startTime}</time>
                  {' – '}
                  <time dateTime={booking.endTime}>{booking.endTime}</time>
                </p>
                {booking.nameOrApartment?.trim() && (
                  <p className="booking-owner">{booking.nameOrApartment}</p>
                )}
                {booking.description && (
                  <p className="booking-description">{booking.description}</p>
                )}
              </div>
              <span className="booking-status">Зайнято</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
