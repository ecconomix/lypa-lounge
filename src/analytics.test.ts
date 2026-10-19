// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest'
import { enableWebAnalytics } from './analytics.ts'

afterEach(() => document.body.replaceChildren())

test('absent, blank or malformed tokens do not load any beacon', () => {
  for (const token of [undefined, '', '  ', 'invalid', '<script>']) {
    enableWebAnalytics(token)
  }
  expect(document.querySelector('script')).toBeNull()
})

test('loads the official beacon once with only the public token', () => {
  const token = 'a'.repeat(32)
  enableWebAnalytics(` ${token} `)
  enableWebAnalytics(token)
  const scripts = document.querySelectorAll('script')
  expect(scripts).toHaveLength(1)
  expect(scripts[0].src).toBe(
    'https://static.cloudflareinsights.com/beacon.min.js',
  )
  expect(scripts[0].defer).toBe(true)
  expect(JSON.parse(scripts[0].dataset.cfBeacon!)).toEqual({ token })
})
