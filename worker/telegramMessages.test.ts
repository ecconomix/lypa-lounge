import { expect, test } from 'vitest'
import {
  escapeTelegramHtml,
  formatBookingNotification,
} from './telegramMessages.ts'

const booking = {
  date: '2026-10-20',
  startTime: '18:00',
  endTime: '20:00',
  nameOrApartment: 'Квартира 12',
}

test('formats a concise Ukrainian HTML booking message', () => {
  expect(formatBookingNotification(booking)).toBe(
    '<b>🌿 Липа Lounge | Нове бронювання</b>\n\n' +
      '📅 <b>Дата:</b> вівторок, 20 жовтня 2026 р.\n' +
      '🕒 <b>Час:</b> 18:00–20:00\n' +
      '👤 <b>Ім’я / квартира:</b> Квартира 12',
  )
})

test('escapes HTML text and attribute characters without trusting existing entities', () => {
  expect(escapeTelegramHtml(`<>&"' &lt;`)).toBe(
    '&lt;&gt;&amp;&quot;&#39; &amp;lt;',
  )
  const message = formatBookingNotification({
    ...booking,
    nameOrApartment: `<a href="https://example.invalid">Олена & '12'</a>`,
  })
  expect(message).toContain(
    '&lt;a href=&quot;https://example.invalid&quot;&gt;Олена &amp; &#39;12&#39;&lt;/a&gt;',
  )
  expect(message).not.toContain('<a ')
})

test('never includes private or internal booking fields', () => {
  const input = {
    ...booking,
    description: 'private-description',
    id: 'internal-id',
    idempotencyKey: 'consumed-key',
  }
  const message = formatBookingNotification(input)
  for (const value of [input.description, input.id, input.idempotencyKey])
    expect(message).not.toContain(value)
})

test.each([
  ['2026-03-29', 'неділя, 29 березня 2026 р.'],
  ['2026-10-25', 'неділя, 25 жовтня 2026 р.'],
  ['2027-01-01', 'пʼятниця, 1 січня 2027 р.'],
])(
  'preserves civil date and weekday at date/time boundaries: %s',
  (date, expected) => {
    expect(formatBookingNotification({ ...booking, date })).toContain(expected)
  },
)

test('links to the configured public frontend calendar', () => {
  expect(
    formatBookingNotification(booking, 'https://lounge.example').endsWith(
      '\n\n📆 <a href="https://lounge.example/">Відкрити календар</a>',
    ),
  ).toBe(true)
})

test.each([
  undefined,
  '',
  'not a URL',
  'javascript:alert(1)',
  'http://localhost:5173',
  'https://localhost',
  'https://127.0.0.1',
  'https://[::1]',
  'http://lounge.example',
  'https://user:password@lounge.example',
  'https://lounge.example/admin',
  'https://lounge.example?secret=value',
  'https://lounge.example#fragment',
  'https://lounge.example/" onclick="alert(1)',
])(
  'omits the calendar link for absent, local or invalid public origins: %s',
  (origin) => {
    expect(formatBookingNotification(booking, origin)).not.toContain('<a ')
  },
)
