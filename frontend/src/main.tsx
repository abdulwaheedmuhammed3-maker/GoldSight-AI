import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './layout-fixes.css'

// Cache only the app shell; live market data must always be fetched fresh.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error('GoldSight service worker registration failed:', error)
    })
  })
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
)
