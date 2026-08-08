import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Onboarding from './pages/Onboarding.jsx'
import Dashboard from './pages/Dashboard.jsx'

function AnimatedRoutes({ hasCompletedSetup, theme, onThemeToggle }) {
  const location = useLocation()

  return (
    <div key={location.pathname} className="page-transition">
      <Routes location={location}>
        <Route
          path="/"
          element={hasCompletedSetup ? <Navigate to="/dashboard" replace /> : <Onboarding theme={theme} onThemeToggle={onThemeToggle} />}
        />
        <Route path="/profile" element={<Onboarding allowEdit theme={theme} onThemeToggle={onThemeToggle} />} />
        <Route path="/dashboard" element={<Dashboard theme={theme} onThemeToggle={onThemeToggle} />} />
      </Routes>
    </div>
  )
}

/**
 * זרימת המשתמש ב-CAL.IO:
 * 1. Onboarding - הזנת נתונים פיזיולוגיים (פעם אחת, בשימוש הראשוני)
 * 2. Dashboard - המסך הראשי: יעדי קלוריות יומיים + הזנת מזון
 */
function App() {
  const [theme, setTheme] = useState(() => {
    const savedTheme = localStorage.getItem('calio_theme')
    return savedTheme === 'dark' ? 'dark' : 'light'
  })

  const hasSavedProfile = Boolean(localStorage.getItem('calio_profile'))
  const hasDisplayName = Boolean(localStorage.getItem('calio_display_name'))
  const hasCompletedSetup = hasSavedProfile && hasDisplayName

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('calio_theme', theme)
  }, [theme])

  useEffect(() => {
    const rootElement = document.getElementById('root')
    if (!rootElement) return

    let hideTimer = null

    function handleAnyScroll() {
      document.documentElement.classList.add('is-scrolling')
      if (hideTimer) {
        window.clearTimeout(hideTimer)
      }
      hideTimer = window.setTimeout(() => {
        document.documentElement.classList.remove('is-scrolling')
      }, 900)
    }

    rootElement.addEventListener('scroll', handleAnyScroll, { capture: true, passive: true })

    return () => {
      rootElement.removeEventListener('scroll', handleAnyScroll, true)
      if (hideTimer) {
        window.clearTimeout(hideTimer)
      }
      document.documentElement.classList.remove('is-scrolling')
    }
  }, [])

  function handleThemeToggle() {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))
  }

  return (
    <BrowserRouter>
      <AnimatedRoutes
        hasCompletedSetup={hasCompletedSetup}
        theme={theme}
        onThemeToggle={handleThemeToggle}
      />
    </BrowserRouter>
  )
}

export default App
