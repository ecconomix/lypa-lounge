import { useEffect, useState } from 'react'
import Calendar from './components/Calendar'
import BookingList from './components/BookingList'
import { createMockReservations } from './data/mockReservations'
import { createDateRange, getKyivToday } from './utils/calendar'
import './App.css'

function App() {
  const [today, setToday] = useState(() => getKyivToday())
  const [selectedDate, setSelectedDate] = useState(today)
  const reservations = createMockReservations(today)

  useEffect(() => {
    const refreshToday = () => {
      if (document.visibilityState !== 'visible') return

      const nextToday = getKyivToday()
      if (nextToday === today) return

      const availableDates = createDateRange(nextToday)
      setToday(nextToday)
      setSelectedDate((selected) =>
        availableDates.includes(selected) ? selected : nextToday,
      )
    }

    document.addEventListener('visibilitychange', refreshToday)
    window.addEventListener('focus', refreshToday)
    return () => {
      document.removeEventListener('visibilitychange', refreshToday)
      window.removeEventListener('focus', refreshToday)
    }
  }, [today])

  return (
    <main className="app">
      <header className="app-header">
        <h1>Липа Lounge</h1>
        <p>Бронювання спільної відпочинкової зони</p>
      </header>
      <Calendar
        startDate={today}
        selectedDate={selectedDate}
        onSelect={setSelectedDate}
        reservations={reservations}
      />
      <BookingList selectedDate={selectedDate} reservations={reservations} />
    </main>
  )
}

export default App
