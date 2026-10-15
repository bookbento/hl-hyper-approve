import { createRoot } from 'react-dom/client'
import { Suspense } from 'react'
import './index.css'
import './lib/api' // axios interceptors + GET cache must be installed before any page fetches
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <Suspense fallback={<div className="flex h-screen items-center justify-center">Loading…</div>}>
    <App />
  </Suspense>
)
