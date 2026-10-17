import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchAvailability } from '../api/reservations'
import type { Reservation } from '../types/reservation'
import { createDateRange, getKyivToday } from '../utils/calendar'

export function useAvailability() {
  const [today, setToday] = useState(getKyivToday)
  const [selectedDate, setSelectedDate] = useState(today)
  const [snapshot, setSnapshot] = useState<{
    from: string
    reservations: Reservation[]
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const request = useRef<{
    from: string
    controller: AbortController
    promise: Promise<void>
  } | null>(null)

  const refresh = useCallback((force = false) => {
    const from = getKyivToday()
    setToday(from)
    setSelectedDate((selected) =>
      createDateRange(from).includes(selected) ? selected : from,
    )
    if (!force && request.current?.from === from) return request.current.promise
    request.current?.controller.abort()
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    const promise = fetchAvailability(from, controller.signal)
      .then((reservations) => {
        if (!controller.signal.aborted) setSnapshot({ from, reservations })
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          request.current = null
          setLoading(false)
        }
      })
    request.current = { from, controller, promise }
    return promise
  }, [])

  useEffect(() => {
    // Start the external request on mount; subsequent updates follow its response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    // Clock check only: GET runs at day rollover, never on an interval otherwise.
    let clockDay = getKyivToday()
    const timer = window.setInterval(() => {
      const next = getKyivToday()
      if (next !== clockDay) {
        clockDay = next
        void refresh()
      }
    }, 30_000)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      request.current?.controller.abort()
      request.current = null
    }
  }, [refresh])

  const onCreated = (reservation: Reservation) => {
    setSnapshot(
      (current) =>
        current && {
          ...current,
          reservations: [
            ...current.reservations.filter(
              (entry) => entry.id !== reservation.id,
            ),
            reservation,
          ],
        },
    )
    void refresh(true)
  }

  const ready = snapshot?.from === today
  return {
    today,
    selectedDate,
    setSelectedDate,
    reservations: ready ? snapshot.reservations : [],
    ready,
    loading,
    error,
    refresh,
    onCreated,
  }
}
