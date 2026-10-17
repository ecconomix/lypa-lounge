import { useState } from 'react'
import Calendar from './components/Calendar'
import { getKyivToday } from './utils/calendar'
import './App.css'

function App() {
  const [today] = useState(() => getKyivToday())
  const [selectedDate, setSelectedDate] = useState(today)

  return (
    <main className="app">
      <header className="app-header">
        <h1>Липа Lounge</h1>
        <p>Бронювання спільної альтанки</p>
      </header>
      <Calendar startDate={today} selectedDate={selectedDate} onSelect={setSelectedDate} />
    </main>
  )
}

export default App
