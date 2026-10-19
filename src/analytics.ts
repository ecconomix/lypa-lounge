/** The site token is a public build-time identifier, never a server secret. */
export function enableWebAnalytics(token: string | undefined): void {
  const value = token?.trim()
  if (!value || !/^[a-f0-9]{32}$/i.test(value)) return
  if (document.querySelector('script[data-cf-beacon]')) return
  const script = document.createElement('script')
  script.defer = true
  script.src = 'https://static.cloudflareinsights.com/beacon.min.js'
  script.dataset.cfBeacon = JSON.stringify({ token: value })
  document.body.append(script)
}
