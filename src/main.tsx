import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { enableWebAnalytics } from './analytics.ts'

if (import.meta.env.PROD) {
  enableWebAnalytics(import.meta.env.VITE_CLOUDFLARE_WEB_ANALYTICS_TOKEN)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
