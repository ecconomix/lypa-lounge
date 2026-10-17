import AdminPage from './components/AdminPage'
import Calendar from './components/Calendar'
import BookingList from './components/BookingList'
import BookingForm from './components/BookingForm'
import { useAvailability } from './hooks/useAvailability'
import './App.css'

function BookingPage() {
  const {
    today,
    selectedDate,
    setSelectedDate,
    reservations,
    ready,
    loading,
    error,
    refresh,
    onCreated,
  } = useAvailability()

  return (
    <main className="app">
      <header className="app-header">
        <h1>Липа Lounge</h1>
        <p>Бронювання спільної зони відпочинку</p>
      </header>
      <div className="availability-feedback" aria-live="polite">
        {loading && (
          <p role="status">
            {ready ? 'Оновлюємо календар…' : 'Завантажуємо календар…'}
          </p>
        )}
        {error && (
          <p role="alert">
            Не вдалося оновити календар. Перевірте з’єднання.{' '}
            <button type="button" onClick={() => void refresh()}>
              Спробувати ще раз
            </button>
          </p>
        )}
      </div>
      {ready && (
        <>
          <Calendar
            startDate={today}
            selectedDate={selectedDate}
            onSelect={setSelectedDate}
            reservations={reservations}
          />
          <BookingList
            selectedDate={selectedDate}
            reservations={reservations}
          />
        </>
      )}
      <BookingForm
        selectedDate={selectedDate}
        reservations={reservations}
        availabilityReady={ready}
        onBookingCreated={onCreated}
        onConflict={() => void refresh(true)}
      />
    </main>
  )
}

function App() {
  return /^\/admin\/?$/.test(window.location.pathname) ? (
    <AdminPage />
  ) : (
    <BookingPage />
  )
}

export default App
