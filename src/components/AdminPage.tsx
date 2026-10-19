import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { AdminError, adminRequest } from '../api/admin'
import CancellationReview from './CancellationReview'
import './BookingForm.css'
import './AdminPage.css'

export default function AdminPage() {
  const [session, setSession] = useState<{ expiresAt?: number } | null>(null)
  const [checking, setChecking] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const password = useRef<HTMLInputElement>(null)
  const generation = useRef(0)

  useEffect(() => {
    let active = true
    async function restore() {
      if (document.visibilityState === 'hidden' || busy.current) return
      const current = ++generation.current
      setChecking(true)
      try {
        const result = await adminRequest('session')
        if (active && current === generation.current) {
          setSession(
            result.authenticated ? { expiresAt: result.expiresAt } : null,
          )
          setError('')
        }
      } catch (failure) {
        if (active && current === generation.current) {
          setSession(null)
          setError(
            failure instanceof AdminError && failure.status === 401
              ? ''
              : 'Не вдалося перевірити сесію. Оновіть сторінку, щоб спробувати ще раз.',
          )
        }
      } finally {
        if (active && current === generation.current) setChecking(false)
      }
    }
    void restore()
    const visible = () => void restore()
    document.addEventListener('visibilitychange', visible)
    return () => {
      active = false
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])

  useEffect(() => {
    if (!session?.expiresAt) return
    const timeout = window.setTimeout(
      () => {
        setSession(null)
        setError('Сесію завершено. Увійдіть ще раз.')
      },
      Math.max(0, session.expiresAt * 1000 - Date.now()),
    )
    return () => window.clearTimeout(timeout)
  }, [session])

  const unauthorized = useCallback(() => {
    setSession(null)
    setError('Сесію завершено. Увійдіть ще раз.')
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy.current) return
    busy.current = true
    ++generation.current
    setPending(true)
    setError('')
    const action = session ? 'logout' : 'login'
    const value = password.current?.value
    try {
      const result = await adminRequest(action, value)
      setSession(result.authenticated ? { expiresAt: result.expiresAt } : null)
    } catch (failure) {
      if (
        action === 'login' &&
        failure instanceof AdminError &&
        failure.status === 401
      )
        setError('Не вдалося увійти. Перевірте пароль.')
      else if (failure instanceof AdminError && failure.status === 429)
        setError('Забагато спроб входу. Спробуйте через 15 хвилин.')
      else if (failure instanceof AdminError && failure.status === 401) {
        setSession(null)
        setError('Сесію завершено. Увійдіть ще раз.')
      } else
        setError(
          'Не вдалося виконати дію. Перевірте з’єднання та спробуйте ще раз.',
        )
    } finally {
      if (password.current) password.current.value = ''
      busy.current = false
      setPending(false)
      setChecking(false)
    }
  }

  return (
    <main className="app">
      <header className="app-header">
        <h1>Адміністрування</h1>
        <p>Липа Lounge</p>
      </header>
      <section
        className="booking-form admin-panel"
        aria-label="Доступ адміністратора"
      >
        {checking ? (
          <p role="status">Перевіряємо сесію…</p>
        ) : (
          <>
            {error && (
              <p className="booking-form-error" role="alert">
                {error}
              </p>
            )}
            <form onSubmit={(event) => void submit(event)}>
              {!session && (
                <label>
                  Пароль адміністратора
                  <input
                    ref={password}
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    maxLength={1024}
                    required
                    disabled={pending}
                  />
                </label>
              )}
              <button type="submit" disabled={pending}>
                {pending ? 'Зачекайте…' : session ? 'Вийти' : 'Увійти'}
              </button>
            </form>
          </>
        )}
      </section>
      {!checking && session && (
        <CancellationReview onUnauthorized={unauthorized} />
      )}
      <p>
        <a href="/">До бронювань</a>
      </p>
    </main>
  )
}
