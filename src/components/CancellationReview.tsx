import { useEffect, useRef, useState } from 'react'
import {
  AdminError,
  fetchCancellationRequests,
  reviewCancellation,
  type PendingCancellation,
} from '../api/admin'

export default function CancellationReview({
  onUnauthorized,
  onChanged,
  refreshKey = 0,
}: {
  onUnauthorized: () => void
  onChanged?: () => void
  refreshKey?: number
}) {
  const [requests, setRequests] = useState<PendingCancellation[]>([])
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [revision, setRevision] = useState(0)
  const busy = useRef(false)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void fetchCancellationRequests(controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) {
          setRequests(rows)
          setError('')
        }
      })
      .catch((failure) => {
        if (controller.signal.aborted) return
        if (failure instanceof AdminError && failure.status === 401)
          onUnauthorized()
        else setError('Не вдалося завантажити запити. Спробуйте ще раз.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [revision, refreshKey, onUnauthorized])

  async function review(
    row: PendingCancellation,
    action: 'approve' | 'reject',
  ) {
    if (busy.current) return
    if (
      action === 'approve' &&
      !window.confirm(
        `Схвалити скасування бронювання ${row.date}, ${row.startTime}–${row.endTime} (${row.nameOrApartment})?`,
      )
    )
      return
    busy.current = true
    setProcessing(true)
    setError('')
    setSuccess('')
    try {
      await reviewCancellation(row.id, action)
      if (!mounted.current) return
      setRequests((rows) => rows.filter((item) => item.id !== row.id))
      setSuccess(
        action === 'approve'
          ? 'Скасування схвалено. Час звільнено.'
          : 'Запит відхилено. Бронювання залишається активним.',
      )
      onChanged?.()
      setLoading(true)
      setRevision((value) => value + 1)
    } catch (failure) {
      if (!mounted.current) return
      if (failure instanceof AdminError && failure.status === 401)
        onUnauthorized()
      else if (
        failure instanceof AdminError &&
        [404, 409].includes(failure.status)
      ) {
        setError(
          'Запит уже оброблено або його неможливо обробити. Оновіть список.',
        )
      } else
        setError(
          'Не вдалося обробити запит. Перевірте з’єднання та повторіть ту саму дію.',
        )
    } finally {
      busy.current = false
      if (mounted.current) setProcessing(false)
    }
  }

  return (
    <section
      className="booking-form admin-reviews"
      aria-labelledby="reviews-heading"
    >
      <h2 id="reviews-heading">Запити на скасування</h2>
      {success && (
        <p className="booking-form-success" role="status">
          {success}
        </p>
      )}
      {error && (
        <p className="booking-form-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={loading || processing}
        onClick={() => {
          setLoading(true)
          setRevision((value) => value + 1)
        }}
      >
        Оновити список
      </button>
      {loading ? (
        <p role="status">Завантажуємо запити…</p>
      ) : !error && requests.length === 0 ? (
        <p>Немає запитів на скасування.</p>
      ) : null}
      <ul className="admin-review-list">
        {requests.map((row) => (
          <li key={row.id}>
            <h3>
              {row.date} · {row.startTime}–{row.endTime}
            </h3>
            <p>
              <strong>Ім’я або квартира:</strong> {row.nameOrApartment}
            </p>
            <p className="admin-review-reason">
              <strong>Пояснення:</strong> {row.reason}
            </p>
            <p>
              Запит створено:{' '}
              {new Intl.DateTimeFormat('uk-UA', {
                timeZone: 'Europe/Kyiv',
                dateStyle: 'short',
                timeStyle: 'short',
              }).format(row.createdAt * 1000)}
            </p>
            <div className="admin-review-actions">
              <button
                type="button"
                disabled={processing || loading}
                onClick={() => void review(row, 'approve')}
              >
                Схвалити
              </button>
              <button
                type="button"
                disabled={processing || loading}
                onClick={() => void review(row, 'reject')}
              >
                Відхилити
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
