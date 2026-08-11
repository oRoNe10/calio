import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { calculateProfile, saveProfileToDB, initUser, loadProfileFromDB, getUserId } from '../services/api.js'

function StyledSelect({ name, value, options, onChange, placeholder }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  const selected = options.find((opt) => opt.value === value)

  useEffect(() => {
    function handleOutsideClick(event) {
      if (!wrapRef.current?.contains(event.target)) {
        setOpen(false)
      }
    }

    if (open) {
      document.addEventListener('mousedown', handleOutsideClick)
    }

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
    }
  }, [open])

  return (
    <div className="styled-select" ref={wrapRef}>
      <button
        type="button"
        className={`styled-select-trigger ${open ? 'open' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{selected?.label || placeholder}</span>
        <span className="styled-select-caret">▾</span>
      </button>

      {open && (
        <div className="styled-select-menu" role="listbox" aria-label={name}>
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`styled-select-option ${value === opt.value ? 'active' : ''}`}
              onClick={() => {
                onChange(name, opt.value)
                setOpen(false)
              }}
              role="option"
              aria-selected={value === opt.value}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Onboarding({ allowEdit = false, theme = 'light', onThemeToggle }) {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const [formError, setFormError] = useState(null)
  const [form, setForm] = useState({
    display_name: '',
    weight_kg: '',
    target_weight_kg: '',
    weekly_weight_change_kg: '0',
    height_cm: '',
    age: '',
    sex: 'male',
    activity_level: 'moderate',
    goal: 'maintain',
  })

  // אתחול משתמש וטעינת פרופיל קיים מה-DB
  useEffect(() => {
    async function init() {
      try {
        const user = await initUser()
        const saved = await loadProfileFromDB(user.id)
        const savedDisplayName = localStorage.getItem('calio_display_name') || ''
        if (saved) {
          // מילוי הטופס בנתונים הקיימים
          setForm({
            display_name: savedDisplayName,
            weight_kg: String(saved.weight_kg),
            target_weight_kg: saved.target_weight_kg != null ? String(saved.target_weight_kg) : '',
            weekly_weight_change_kg: saved.weekly_weight_change_kg != null ? String(saved.weekly_weight_change_kg) : '0',
            height_cm: String(saved.height_cm),
            age: String(saved.age),
            sex: saved.sex,
            activity_level: saved.activity_level,
            goal: saved.goal,
          })
          // שמירה ב-localStorage לשימוש ב-Dashboard
          localStorage.setItem('calio_profile', JSON.stringify({ ...saved, display_name: savedDisplayName }))
          if (!allowEdit && savedDisplayName.trim()) {
            navigate('/dashboard', { replace: true })
            return
          }
        } else if (savedDisplayName.trim()) {
          setForm((prev) => ({ ...prev, display_name: savedDisplayName }))
        }
      } catch {
        // אם אין חיבור לשרת - ממשיכים בלי פרופיל שמור
      } finally {
        setInitializing(false)
      }
    }
    init()
  }, [allowEdit, navigate])

  function handleChange(e) {
    setFormError(null)
    setForm({ ...form, [e.target.name]: e.target.value })
  }

  function handleSelectChange(name, value) {
    setFormError(null)
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  function validateTargetWeightForGoal(goal, currentWeight, targetWeight) {
    if (targetWeight == null) return null

    if (goal === 'gain' && targetWeight < currentWeight) {
      return 'במטרת עלייה, משקל היעד לא יכול להיות קטן מהמשקל הנוכחי.'
    }

    if (goal === 'lose' && targetWeight > currentWeight) {
      return 'במטרת ירידה, משקל היעד לא יכול להיות גדול מהמשקל הנוכחי.'
    }

    return null
  }

  async function handleSubmit(e) {
    e.preventDefault()
    try {
      const displayName = form.display_name.trim()
      const restForm = { ...form }
      delete restForm.display_name
      const currentWeight = Number(form.weight_kg)
      const targetWeight = form.target_weight_kg === '' ? null : Number(form.target_weight_kg)
      const targetWeightError = validateTargetWeightForGoal(form.goal, currentWeight, targetWeight)

      if (targetWeightError) {
        setFormError(targetWeightError)
        return
      }

      setLoading(true)
      setFormError(null)
      const profileInput = {
        ...restForm,
        weight_kg: currentWeight,
        target_weight_kg: targetWeight,
        weekly_weight_change_kg: Number(form.weekly_weight_change_kg) > 0 ? Number(form.weekly_weight_change_kg) : null,
        height_cm: Number(form.height_cm),
        age: Number(form.age),
      }
      const result = await calculateProfile(profileInput)
      localStorage.setItem('calio_display_name', displayName)
      // שמירה ב-localStorage לשימוש מהיר ב-Dashboard
      localStorage.setItem('calio_profile', JSON.stringify({ ...profileInput, ...result, display_name: displayName }))
      // שמירה לDB כדי שלא יצטרך להכניס שוב
      const userId = getUserId()
      if (userId) {
        await saveProfileToDB(userId, profileInput, result)
      }
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setFormError(err.message || 'לא הצלחנו לשמור את הפרופיל כרגע.')
    } finally {
      setLoading(false)
    }
  }

  if (initializing) {
    return (
      <div className="app-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div style={{ color: 'var(--color-muted-text)', fontSize: 15 }}>טוען...</div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      {/* Hero */}
      <div className="onboarding-hero">
        {onThemeToggle && (
          <button
            type="button"
            onClick={onThemeToggle}
            className="onboarding-theme-toggle"
            aria-label="החלף מצב תצוגה"
          >
            {theme === 'light' ? '🌙 מצב כהה' : '☀️ מצב בהיר'}
          </button>
        )}
        <div style={{ fontSize: 48, marginBottom: 12 }}>🥗</div>
        <div className="onboarding-hero-title">
          CAL<span>.IO</span>
        </div>
        <p className="onboarding-hero-sub">
          עוקב תזונה חכם — נחשב את היעדים היומיים שלך תוך שניות
        </p>
      </div>

      {/* Form */}
      <div className="onboarding-body">
        <div className="card">
          <div className="section-title" style={{ marginBottom: 20 }}>
            <div className="section-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
            </div>
            הפרטים שלי
          </div>

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">השם שלי</label>
              <input
                className="form-input"
                name="display_name"
                type="text"
                value={form.display_name}
                onChange={handleChange}
                placeholder="איך קוראים לך?"
                minLength={2}
                maxLength={40}
                required
              />
            </div>

            <div className="form-row" style={{ marginBottom: 16 }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">משקל (ק״ג)</label>
                <input
                  className="form-input"
                  name="weight_kg"
                  type="number"
                  min="30"
                  max="300"
                  value={form.weight_kg}
                  onChange={handleChange}
                  placeholder="70"
                  required
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">גובה (ס״מ)</label>
                <input
                  className="form-input"
                  name="height_cm"
                  type="number"
                  min="100"
                  max="250"
                  value={form.height_cm}
                  onChange={handleChange}
                  placeholder="170"
                  required
                />
              </div>
            </div>

            <div className="form-row" style={{ marginBottom: 16 }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">גיל</label>
                <input
                  className="form-input"
                  name="age"
                  type="number"
                  min="10"
                  max="120"
                  value={form.age}
                  onChange={handleChange}
                  placeholder="25"
                  required
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">מין</label>
                <StyledSelect
                  name="sex"
                  value={form.sex}
                  onChange={handleSelectChange}
                  placeholder="בחר מין"
                  options={[
                    { value: 'male', label: 'זכר' },
                    { value: 'female', label: 'נקבה' },
                  ]}
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">רמת פעילות גופנית</label>
              <StyledSelect
                name="activity_level"
                value={form.activity_level}
                onChange={handleSelectChange}
                placeholder="בחר רמת פעילות"
                options={[
                  { value: 'sedentary', label: 'כמעט ללא פעילות' },
                  { value: 'light', label: 'קלה (1–3 פעמים בשבוע)' },
                  { value: 'moderate', label: 'בינונית (3–5 פעמים בשבוע)' },
                  { value: 'active', label: 'גבוהה (6–7 פעמים בשבוע)' },
                  { value: 'very_active', label: 'גבוהה מאוד + עבודה פיזית' },
                ]}
              />
            </div>

            <div className="form-group">
              <label className="form-label">משקל יעד (אופציונלי)</label>
              <input
                className="form-input"
                name="target_weight_kg"
                type="number"
                min="30"
                max="300"
                step="0.1"
                value={form.target_weight_kg}
                onChange={handleChange}
                placeholder="למשל 65"
              />
            </div>

            <div className="form-group">
              <label className="form-label">קצב שינוי משקל בשבוע (אופציונלי)</label>
              <div className="profile-slider-card">
                <input
                  className="profile-range-input"
                  name="weekly_weight_change_kg"
                  type="range"
                  min="0"
                  max="3"
                  step="0.1"
                  value={form.weekly_weight_change_kg}
                  onChange={handleChange}
                />
                <div className="profile-slider-meta">
                  <span>0 ק״ג</span>
                  <strong>{Number(form.weekly_weight_change_kg).toFixed(1)} ק״ג לשבוע</strong>
                  <span>3 ק״ג</span>
                </div>
                <div className="profile-slider-hint">
                  אם הוגדר גם משקל יעד, המחשבון יתאים את יעד הקלוריות לקצב שבחרת. אם תשאיר 0 או בלי יעד משקל, החישוב הרגיל יישאר כמו היום.
                </div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">המטרה שלי</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                {[
                  { val: 'lose', label: 'ירידה', icon: '📉' },
                  { val: 'maintain', label: 'שמירה', icon: '⚖️' },
                  { val: 'gain', label: 'עלייה', icon: '📈' },
                ].map(({ val, label, icon }) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setForm({ ...form, goal: val })}
                    style={{
                      padding: '10px 8px',
                      borderRadius: 'var(--radius)',
                      border: `2px solid ${form.goal === val ? 'var(--color-primary)' : 'var(--color-border)'}`,
                      background: form.goal === val ? 'var(--color-primary-light)' : 'var(--color-muted-bg)',
                      color: form.goal === val ? 'var(--color-primary)' : 'var(--color-muted-text)',
                      fontFamily: 'var(--font-body)',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'all 150ms ease',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 4,
                      width: '100%',
                    }}
                  >
                    <span style={{ fontSize: 20 }}>{icon}</span>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {formError && <div className="alert alert-error">{formError}</div>}

            <button
              className="btn btn-accent"
              type="submit"
              disabled={loading}
              style={{ marginTop: 8 }}
            >
              {loading ? 'מחשב...' : 'חשב את היעדים שלי →'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

export default Onboarding
