import { createRoot } from 'react-dom/client'
import { Suspense } from 'react'
// Prompt, same family as malinmarket (self-hosted; each file is split by unicode-range,
// so the browser only downloads the Thai/Latin subsets it actually renders).
// malin uses 300–600; 700 is loaded too because the existing pages use font-bold.
import '@fontsource/prompt/300.css'
import '@fontsource/prompt/400.css'
import '@fontsource/prompt/500.css'
import '@fontsource/prompt/600.css'
import '@fontsource/prompt/700.css'
import './index.css'
import './lib/api' // axios interceptors + GET cache must be installed before any page fetches
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <Suspense fallback={<div className="flex h-screen items-center justify-center">Loading…</div>}>
    <App />
  </Suspense>
)
