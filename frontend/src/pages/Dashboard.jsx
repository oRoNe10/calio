import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  describeFood, identifyFoodFromImage,
  initUser, getUserId,
  logFoodToDB, getTodayLog, getWeekLog, removeLogEntry, updateLogEntry, logMealBatch,
  getFavorites, addFavorite, removeFavorite,
  chatFoodAssistant,
} from '../services/api.js'

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']

function buildMealGroupTitle(components) {
  const names = [...new Set(
    components
      .map((c) => (c.food_name || '').trim())
      .filter(Boolean)
  )]

  if (names.length === 0) return `ארוחה · ${components.length} מרכיבים`

  const maxNames = 3
  const visible = names.slice(0, maxNames)
  const extraCount = names.length - visible.length
  const suffix = extraCount > 0 ? ` + ${extraCount} נוספים` : ''
  return `${visible.join(' + ')}${suffix}`
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10)
}

function createWelcomeChatMessage(displayName) {
  const normalizedName = (displayName || '').trim()
  const intro = normalizedName
    ? `היי ${normalizedName}, אני כאן לעזור לך עם רעיונות למנות, כמויות וערכים תזונתיים. אפשר גם להוסיף מנה ישר ליומן.`
    : 'היי, אני כאן לעזור עם רעיונות למנות, כמויות וערכים תזונתיים. אפשר גם להוסיף מנה ישר ליומן.'

  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: intro,
    meal: null,
    components: null,
  }
}

function MacroCard({ label, current, target, colorClass, unit = 'גרם' }) {
  const pct = target ? Math.min(100, Math.round((current / target) * 100)) : 0
  return (
    <div className={`macro-card ${colorClass}`}>
      <div className="macro-label">{label}</div>
      <div className="macro-value">
        {Math.round(current)}
        <small> {unit === 'קק״ל' ? 'קק״ל' : 'ג׳'}</small>
      </div>
      {target && (
        <>
          <div className="macro-goal">מתוך {target} {unit === 'קק״ל' ? 'קק״ל' : 'גרם'}</div>
          <div className="progress-bar-wrap">
            <div
              className={`progress-bar-fill ${colorClass}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </>
      )}
    </div>
  )
}

function Dashboard({ theme = 'light', onThemeToggle }) {
  const navigate = useNavigate()
  const [activeView, setActiveView] = useState('today')
  const [isGoalsOpen, setIsGoalsOpen] = useState(false)
  const [expandedDay, setExpandedDay] = useState(null)
  const [description, setDescription] = useState('')
  const [imagePreview, setImagePreview] = useState(null)
  const [imageFile, setImageFile] = useState(null)
  const cameraInputRef = useRef(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [logged, setLogged] = useState([])
  const [favorites, setFavorites] = useState([])
  const [addingFavoriteId, setAddingFavoriteId] = useState(null)
  const [favoritesMenuOpen, setFavoritesMenuOpen] = useState(false)
  const [weekData, setWeekData] = useState([])
  const [weekLoading, setWeekLoading] = useState(false)
  const [weekError, setWeekError] = useState(null)
  const [savingFav, setSavingFav] = useState(null)   // id של item שנשמר כרגע
  const [editingItem, setEditingItem] = useState(null)
  const [editValues, setEditValues] = useState({})
  const [editSaving, setEditSaving] = useState(false)
  const [deletePrompt, setDeletePrompt] = useState(null)
  const [expandedGroupId, setExpandedGroupId] = useState(null)
  const [favSearch, setFavSearch] = useState('')
  const [loadError, setLoadError] = useState(null)
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatDayKey, setChatDayKey] = useState(getTodayKey)
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('calio_display_name') || '')
  const [chatMessages, setChatMessages] = useState(() => [createWelcomeChatMessage(localStorage.getItem('calio_display_name') || '')])
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsName, setSettingsName] = useState(() => localStorage.getItem('calio_display_name') || '')
  const [settingsError, setSettingsError] = useState(null)
  const chatListRef = useRef(null)

  const profile = JSON.parse(localStorage.getItem('calio_profile') || 'null')
  const userId = getUserId()

  // טעינת נתונים מה-DB בטעינת הדף
  const loadTodayData = useCallback(async (uid) => {
    try {
      const [todayItems, favItems] = await Promise.all([
        getTodayLog(uid),
        getFavorites(uid),
      ])
      setLogged(todayItems)
      setFavorites(favItems)
      setLoadError(null)
    } catch {
      setLoadError('לא הצלחנו לטעון את נתוני היום. בדוק את החיבור לשרת.')
    }
  }, [])

  const loadWeekData = useCallback(async (uid) => {
    setWeekLoading(true)
    setWeekError(null)
    try {
      const data = await getWeekLog(uid)
      setWeekData(data)
    } catch {
      setWeekError('לא הצלחנו לטעון את נתוני השבוע האחרון.')
    } finally {
      setWeekLoading(false)
    }
  }, [])

  useEffect(() => {
    async function init() {
      try {
        const user = await initUser()
        await loadTodayData(user.id)
      } catch {
        // שרת לא זמין - ממשיכים ב-offline mode
      }
    }
    init()
  }, [loadTodayData])

  useEffect(() => {
    if (!expandedDay) return
    const exists = weekData.some((day) => day.log_date === expandedDay)
    if (!exists) {
      setExpandedDay(null)
    }
  }, [expandedDay, weekData])

  useEffect(() => {
    function handleEscape(event) {
      if (event.key === 'Escape') {
        setFavoritesMenuOpen(false)
      }
    }

    if (favoritesMenuOpen) {
      document.addEventListener('keydown', handleEscape)
    }

    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [favoritesMenuOpen])

  useEffect(() => {
    if (activeView !== 'chat') return
    if (!chatListRef.current) return
    chatListRef.current.scrollTop = chatListRef.current.scrollHeight
  }, [activeView, chatMessages, chatLoading])

  const resetChatForNewDay = useCallback(() => {
    setChatMessages([createWelcomeChatMessage(displayName)])
    setChatInput('')
    setChatDayKey(getTodayKey())
  }, [displayName])

  useEffect(() => {
    const storedName = localStorage.getItem('calio_display_name') || ''
    if (storedName !== displayName) {
      setDisplayName(storedName)
      setSettingsName(storedName)
    }
  }, [displayName])

  const ensureChatDayIsCurrent = useCallback(() => {
    const todayKey = getTodayKey()
    if (todayKey !== chatDayKey) {
      resetChatForNewDay()
      return false
    }
    return true
  }, [chatDayKey, resetChatForNewDay])

  useEffect(() => {
    const intervalId = setInterval(() => {
      ensureChatDayIsCurrent()
    }, 60_000)

    return () => clearInterval(intervalId)
  }, [ensureChatDayIsCurrent])

  useEffect(() => {
    setChatMessages([createWelcomeChatMessage(displayName)])
    setChatDayKey(getTodayKey())
  }, [displayName])

  const totals = logged.reduce(
    (acc, item) => ({
      calories: acc.calories + item.calories,
      protein_g: acc.protein_g + item.protein_g,
      fat_g: acc.fat_g + item.fat_g,
      carbs_g: acc.carbs_g + item.carbs_g,
    }),
    { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 }
  )

  // הוספת מנה לרשימה + שמירה לDB
  async function addItem(data) {
    // מנה מרוכבת עם מרכיבים
    if (data.components) {
      const groupId = crypto.randomUUID()
      if (userId) {
        try {
          const saved = await logMealBatch(userId, data.components, groupId)
          setLogged((prev) => [...prev, ...saved])
          await loadWeekData(userId)
          return
        } catch { /* fallback */ }
      }
      setLogged((prev) => [
        ...prev,
        ...data.components.map((c) => ({ ...c, id: Date.now() + Math.random(), meal_group_id: groupId })),
      ])
      return
    }
    // מנה בודדת
    if (userId) {
      try {
        const saved = await logFoodToDB(userId, {
          food_name: data.food_name,
          quantity_grams: data.quantity_grams,
          calories: data.calories,
          protein_g: data.protein_g,
          fat_g: data.fat_g,
          carbs_g: data.carbs_g || 0,
          source: data.source || 'ai',
        })
        setLogged((prev) => [...prev, saved])
        await loadWeekData(userId)
      } catch {
        // fallback: הוספה ל-state בלבד
        setLogged((prev) => [...prev, { ...data, id: Date.now() }])
      }
    } else {
      setLogged((prev) => [...prev, { ...data, id: Date.now() }])
    }
  }

  async function handleDescribe(e) {
    e.preventDefault()
    const trimmedDescription = description.trim()
    if (!trimmedDescription && !imageFile) {
      setError('כתוב מה אכלת או הוסף תמונה של הצלחת.')
      return
    }

    setError(null)
    setLoading(true)
    try {
      const data = imageFile
        ? await identifyFoodFromImage(imageFile)
        : await describeFood(trimmedDescription)
      await addItem(data)
      setDescription('')
      setImageFile(null)
      setImagePreview(null)
      if (cameraInputRef.current) cameraInputRef.current.value = ''
    } catch (err) {
      setError(err.message || 'לא הצלחנו להעריך את המנה הזו. נסה שוב עם תיאור או תמונה ברורים יותר.')
    } finally {
      setLoading(false)
    }
  }

  function handleImageChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setImageFile(file)
    setImagePreview(URL.createObjectURL(file))
    setError(null)
  }

  // מחיקת מנה מהיומן
  async function handleDeleteLog(item) {
    if (item.id && userId) {
      try { await removeLogEntry(item.id) } catch { /* silent */ }
    }
    setLogged((prev) => prev.filter((i) => i !== item))
    if (userId) {
      await loadWeekData(userId)
    }
  }

  function handleRequestDeleteLog(item) {
    setDeletePrompt({
      type: 'item',
      title: 'מחיקת מנה',
      message: `למחוק את "${item.food_name}" מהיומן?`,
      item,
    })
  }

  // פתיחת מודל עריכה
  function handleOpenEdit(item) {
    setEditingItem(item)
    setEditValues({
      food_name: item.food_name,
      quantity_grams: item.quantity_grams,
      calories: item.calories,
      protein_g: item.protein_g,
      fat_g: item.fat_g,
      carbs_g: item.carbs_g || 0,
    })
  }

  // שמירת עריכה
  async function handleSaveEdit(e) {
    e.preventDefault()
    setEditSaving(true)
    try {
      const updated = {
        food_name: editValues.food_name,
        quantity_grams: Number(editValues.quantity_grams),
        calories: Number(editValues.calories),
        protein_g: Number(editValues.protein_g),
        fat_g: Number(editValues.fat_g),
        carbs_g: Number(editValues.carbs_g),
      }
      if (editingItem.id && userId) {
        const saved = await updateLogEntry(editingItem.id, updated)
        setLogged((prev) => prev.map((i) => (i.id === editingItem.id ? saved : i)))
      } else {
        setLogged((prev) => prev.map((i) => (i === editingItem ? { ...i, ...updated } : i)))
      }
      await loadWeekData(userId)
      setEditingItem(null)
    } catch { /* silent */ } finally {
      setEditSaving(false)
    }
  }

  // מחיקת כל מרכיבי קבוצה אחת
  async function handleDeleteGroup(groupId) {
    const groupItems = logged.filter((i) => i.meal_group_id === groupId)
    for (const item of groupItems) {
      if (item.id && userId) {
        try { await removeLogEntry(item.id) } catch { /* silent */ }
      }
    }
    setLogged((prev) => prev.filter((i) => i.meal_group_id !== groupId))
    if (userId) await loadWeekData(userId)
    if (expandedGroupId === groupId) setExpandedGroupId(null)
  }

  function handleRequestDeleteGroup(groupId) {
    setDeletePrompt({
      type: 'group',
      title: 'מחיקת ארוחה מרוכבת',
      message: 'למחוק את כל מרכיבי הארוחה המרוכבת?',
      groupId,
    })
  }

  async function handleConfirmDelete() {
    if (!deletePrompt) return
    const prompt = deletePrompt
    setDeletePrompt(null)

    if (prompt.type === 'group') {
      await handleDeleteGroup(prompt.groupId)
      return
    }

    await handleDeleteLog(prompt.item)
  }

  // קיבוץ רשומות לפי meal_group_id לתצוגה
  const groupedLogged = useMemo(() => {
    const result = []
    const seenGroups = new Set()
    for (const item of logged) {
      if (!item.meal_group_id) {
        result.push({ type: 'single', item })
      } else if (!seenGroups.has(item.meal_group_id)) {
        seenGroups.add(item.meal_group_id)
        const components = logged.filter((i) => i.meal_group_id === item.meal_group_id)
        const total = components.reduce(
          (acc, c) => ({
            calories: acc.calories + c.calories,
            protein_g: acc.protein_g + c.protein_g,
            fat_g: acc.fat_g + c.fat_g,
            carbs_g: acc.carbs_g + c.carbs_g,
          }),
          { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 }
        )
        result.push({
          type: 'group',
          meal_group_id: item.meal_group_id,
          components,
          total,
          title: buildMealGroupTitle(components),
        })
      }
    }
    return result
  }, [logged])

  const editingGroupComponents = useMemo(() => {
    if (!editingItem?.meal_group_id) return []
    return logged.filter((i) => i.meal_group_id === editingItem.meal_group_id)
  }, [logged, editingItem])

  // כוכב - הוספה/הסרה ממועדפים
  async function handleToggleFavorite(item) {
    if (!userId) return
    setSavingFav(item.id ?? item)
    try {
      const isFav = favorites.some(
        (f) => f.food_name === item.food_name && f.quantity_grams === item.quantity_grams
      )
      if (isFav) {
        const fav = favorites.find(
          (f) => f.food_name === item.food_name && f.quantity_grams === item.quantity_grams
        )
        await removeFavorite(fav.id)
        setFavorites((prev) => prev.filter((f) => f.id !== fav.id))
      } else {
        const newFav = await addFavorite(userId, {
          food_name: item.food_name,
          quantity_grams: item.quantity_grams,
          calories: item.calories,
          protein_g: item.protein_g,
          fat_g: item.fat_g,
          carbs_g: item.carbs_g || 0,
          source: item.source || 'ai',
        })
        setFavorites((prev) => [...prev, newFav])
      }
    } catch { /* silent */ } finally {
      setSavingFav(null)
    }
  }

  // הוספת מועדף לרשימה היומית
  async function handleAddFromFavorite(fav) {
    setAddingFavoriteId(fav.id)
    try {
      await addItem(fav)
      setFavoritesMenuOpen(false)
    } finally {
      setAddingFavoriteId(null)
    }
  }

  async function handleSwitchView(view) {
    if (view === 'chat') {
      ensureChatDayIsCurrent()
    }
    setActiveView(view)
    if (view === 'week' && userId) {
      await loadWeekData(userId)
    }
  }

  function handleOpenSettings() {
    setSettingsName(displayName)
    setSettingsError(null)
    setIsSettingsOpen(true)
  }

  function handleSaveSettings(e) {
    e.preventDefault()
    const normalizedName = settingsName.trim()
    if (!normalizedName) {
      setSettingsError('צריך להזין שם כדי להמשיך.')
      return
    }

    localStorage.setItem('calio_display_name', normalizedName)
    const savedProfile = JSON.parse(localStorage.getItem('calio_profile') || 'null')
    if (savedProfile) {
      localStorage.setItem('calio_profile', JSON.stringify({ ...savedProfile, display_name: normalizedName }))
    }
    setDisplayName(normalizedName)
    setSettingsError(null)
    setIsSettingsOpen(false)
  }

  async function handleSendChat(e) {
    e.preventDefault()
    ensureChatDayIsCurrent()
    const message = chatInput.trim()
    if (!message || chatLoading) return

    const userMsg = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      meal: null,
      components: null,
    }

    setChatMessages((prev) => [...prev, userMsg])
    setChatInput('')
    setChatLoading(true)

    try {
      const history = [...chatMessages, userMsg].map((m) => ({ role: m.role, content: m.content }))
      const response = await chatFoodAssistant(message, history)
      const assistantMsg = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response.reply,
        meal: response.meal || null,
        components: response.components || null,
      }
      setChatMessages((prev) => [...prev, assistantMsg])
    } catch (err) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: err.message || 'לא הצלחתי לענות כרגע. נסה לנסח שוב.',
          meal: null,
          components: null,
        },
      ])
    } finally {
      setChatLoading(false)
    }
  }

  async function handleAddFromChat(message) {
    if (!message) return
    if (message.components?.length) {
      await addItem({ components: message.components })
      setActiveView('today')
      return
    }
    if (message.meal) {
      await addItem(message.meal)
      setActiveView('today')
    }
  }

  function isFavorite(item) {
    return favorites.some(
      (f) => f.food_name === item.food_name && f.quantity_grams === item.quantity_grams
    )
  }

  function getDayLabel(dateStr) {
    const d = new Date(dateStr)
    const today = new Date()
    const yesterday = new Date()
    yesterday.setDate(today.getDate() - 1)
    if (d.toDateString() === today.toDateString()) return 'היום'
    if (d.toDateString() === yesterday.toDateString()) return 'אתמול'
    return DAY_NAMES[d.getDay()]
  }

  function getDayDate(dateStr) {
    const d = new Date(dateStr)
    return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })
  }

  const orderedWeekData = [...weekData].sort((a, b) => b.log_date.localeCompare(a.log_date))

  return (
    <div className="app-shell">
      {/* Header */}
      <header className="app-header">
        <div>
          <div className="app-logo">CAL<span>.IO</span></div>
          <div className="app-tagline">עוקב תזונה חכם</div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="header-icon-btn"
            onClick={handleOpenSettings}
            aria-label="הגדרות"
            title="הגדרות"
          >
            ⚙️
          </button>

          <div>
            <button
              type="button"
              className={`header-action-btn favorites-trigger-btn ${favoritesMenuOpen ? 'active' : ''}`}
              onClick={() => setFavoritesMenuOpen((prev) => !prev)}
              aria-haspopup="dialog"
              aria-expanded={favoritesMenuOpen}
              aria-controls="favorites-drawer"
            >
              מנות אהובות
            </button>
          </div>

        </div>
      </header>

      <div className={`page ${activeView === 'chat' ? 'page-chat' : ''}`}>
        {/* שגיאת טעינה */}
        {loadError && (
          <div className="alert alert-error" style={{ margin: '12px 0' }}>
            {loadError}
            <button
              type="button"
              onClick={async () => { if (userId) await loadTodayData(userId) }}
              style={{ marginRight: 10, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', fontSize: 13, color: 'inherit' }}
            >
              נסה שוב
            </button>
          </div>
        )}

        {/* No profile state */}
        {!profile && (
          <div className="welcome-banner">
            <div className="welcome-banner-title">ברוכים הבאים 👋</div>
            <div className="welcome-banner-sub">הגדר את הפרופיל שלך כדי לראות יעדים יומיים</div>
            <button
              className="btn btn-accent"
              onClick={() => navigate('/')}
              style={{ marginTop: 14, width: 'auto', padding: '10px 20px', fontSize: 13 }}
            >
              הגדר פרופיל
            </button>
          </div>
        )}

        {activeView === 'today' && (
          <>
            {/* Macro tracker */}
            {profile && (
              <div className="goals-accordion">
                <button
                  type="button"
                  className="goals-accordion-toggle"
                  onClick={() => setIsGoalsOpen((prev) => !prev)}
                  aria-expanded={isGoalsOpen}
                  aria-controls="daily-goals-panel"
                >
                  <div className="section-title goals-accordion-title">
                    <div className="section-icon">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                      </svg>
                    </div>
                    יעדי היום
                  </div>
                  <span className={`goals-accordion-chevron ${isGoalsOpen ? 'open' : ''}`} aria-hidden="true">⌄</span>
                </button>

                <div
                  id="daily-goals-panel"
                  className={`goals-accordion-content ${isGoalsOpen ? 'open' : ''}`}
                  aria-hidden={!isGoalsOpen}
                >
                  <div className="macro-grid">
                    <MacroCard label="קלוריות" current={totals.calories} target={profile.target_calories} colorClass="calories" unit="קק״ל" />
                    <MacroCard label="חלבון" current={totals.protein_g} target={profile.target_protein_g} colorClass="protein" />
                    <MacroCard label="שומן" current={totals.fat_g} target={profile.target_fat_g} colorClass="fat" />
                    <MacroCard label="פחמימות" current={totals.carbs_g} target={profile.target_carbs_g} colorClass="carbs" />
                  </div>
                </div>
              </div>
            )}

            {/* Food input form */}
            <div className="card">
              <div className="welcome-inline">
                <div className="welcome-inline-title">היי {displayName || 'חבר/ה'} מה תרצה להוסיף?</div>
              </div>

              <div className="food-input-header">
                <div className="section-title" style={{ marginBottom: 0 }}>
                  <div className="section-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                  </div>
                  מה אכלת?
                </div>
              </div>

              {error && <div className="alert alert-error">{error}</div>}

              <form onSubmit={handleDescribe} className="food-free-form">
                <div className="form-group">
                  <label className="form-label">טקסט חופשי</label>
                  <textarea
                    className="form-input form-textarea"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="לדוגמה: אכלתי לצהריים חזה עוף 200 גרם, כוס אורז ובטטה קטנה"
                    rows={3}
                  />
                </div>

                {imagePreview && (
                  <div className="plate-preview-wrap">
                    <img
                      src={imagePreview}
                      alt="תצוגה מקדימה של הצלחת"
                      className="plate-preview-image"
                    />
                  </div>
                )}

                <div className="plate-actions-row">
                  <label className="plate-photo-trigger" htmlFor="plate-camera-input">
                    <span aria-hidden="true">📷</span>
                    צלם עכשיו
                  </label>
                  <input
                    id="plate-camera-input"
                    ref={cameraInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="plate-photo-input"
                    onChange={handleImageChange}
                  />
                  <label className="plate-photo-trigger" htmlFor="plate-gallery-input" style={{ marginRight: 8 }}>
                    <span aria-hidden="true">🖼️</span>
                    מהגלריה
                  </label>
                  <input
                    id="plate-gallery-input"
                    type="file"
                    accept="image/*"
                    className="plate-photo-input"
                    onChange={handleImageChange}
                  />
                  {imageFile && <div className="plate-photo-meta">נבחרה תמונה</div>}
                </div>

                <button className="btn btn-primary" type="submit" disabled={loading} style={{ position: 'relative' }}>
                  {loading ? (
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                      <span style={{ width: 16, height: 16, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
                      מחשב...
                    </span>
                  ) : 'נתחו עבורי'}
                </button>
              </form>
            </div>

            {/* Food log */}
            {logged.length > 0 && (
              <>
                <div className="section-title">
                  <div className="section-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                    </svg>
                  </div>
                  יומן אכילה ({logged.length})
                </div>
                <div className="food-log-list">
                  {groupedLogged.map((entry, i) => {
                    if (entry.type === 'single') {
                      const item = entry.item
                      const fav = isFavorite(item)
                      return (
                        <div key={item.id ?? i} className="food-log-item" style={{ cursor: 'pointer' }} onClick={() => handleOpenEdit(item)}>
                          <div className="food-log-icon">🍽️</div>
                          <div className="food-log-info">
                            <div className="food-log-name">{item.food_name}</div>
                            <div className="food-log-meta">
                              {item.quantity_grams}ג׳ · חלבון {Math.round(item.protein_g)}ג׳ · שומן {Math.round(item.fat_g)}ג׳ · פחמימה {Math.round(item.carbs_g)}ג׳
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                            <div className="food-log-calories">{Math.round(item.calories)}</div>
                            <button
                              onClick={() => handleToggleFavorite(item)}
                              disabled={savingFav === (item.id ?? item)}
                              title={fav ? 'הסר ממועדפים' : 'הוסף למועדפים'}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: fav ? 'var(--color-warning)' : 'var(--color-icon-muted)', padding: '2px 4px', lineHeight: 1 }}
                            >★</button>
                            <button
                              onClick={() => handleRequestDeleteLog(item)}
                              title="מחק מנה"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--color-icon-muted)', padding: '2px 4px', lineHeight: 1 }}
                            >✕</button>
                          </div>
                        </div>
                      )
                    }

                    // קבוצת מרכיבים
                    const { meal_group_id, components, total, title } = entry
                    const isOpen = expandedGroupId === meal_group_id
                    return (
                      <div key={meal_group_id} style={{ borderRadius: 'var(--radius-sm, 8px)', overflow: 'hidden', border: '1px solid var(--color-border)', marginBottom: 4 }}>
                        {/* כותרת הקבוצה */}
                        <div
                          className="food-log-item"
                          style={{ cursor: 'pointer', marginBottom: 0, borderRadius: 0 }}
                          onClick={() => setExpandedGroupId(isOpen ? null : meal_group_id)}
                        >
                          <div className="food-log-icon">🍱</div>
                          <div className="food-log-info">
                            <div className="food-log-name">{title}</div>
                            <div className="food-log-meta">
                              חלבון {Math.round(total.protein_g)}ג׳ · שומן {Math.round(total.fat_g)}ג׳ · פחמימה {Math.round(total.carbs_g)}ג׳
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                            <div className="food-log-calories">{Math.round(total.calories)}</div>
                            <button
                              onClick={() => handleRequestDeleteGroup(meal_group_id)}
                              title="מחק ארוחה"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--color-icon-muted)', padding: '2px 4px', lineHeight: 1 }}
                            >✕</button>
                            <span style={{ color: 'var(--color-icon-muted)', fontSize: 12, padding: '2px 4px' }}>{isOpen ? '▴' : '▾'}</span>
                          </div>
                        </div>
                        {/* מרכיבים מפורטים */}
                        {isOpen && (
                          <div style={{ borderTop: '1px solid var(--color-border)', background: 'var(--color-muted-bg)' }}>
                            {components.map((comp, ci) => (
                              <div
                                key={comp.id ?? ci}
                                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', cursor: 'pointer', borderBottom: ci < components.length - 1 ? '1px solid var(--color-border)' : 'none' }}
                                onClick={() => handleOpenEdit(comp)}
                              >
                                <div style={{ fontSize: 13, flex: 1 }}>
                                  <div style={{ fontWeight: 600, color: 'var(--color-foreground)', fontSize: 13 }}>{comp.food_name}</div>
                                  <div style={{ color: 'var(--color-muted-text)', fontSize: 11, marginTop: 2 }}>
                                    {comp.quantity_grams}ג׳ · חלבון {Math.round(comp.protein_g)}ג׳ · שומן {Math.round(comp.fat_g)}ג׳ · פחמימה {Math.round(comp.carbs_g)}ג׳
                                  </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                                  <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--color-primary)', flexShrink: 0 }}>{Math.round(comp.calories)}</div>
                                  <button
                                    onClick={() => handleToggleFavorite(comp)}
                                    disabled={savingFav === (comp.id ?? comp)}
                                    title={isFavorite(comp) ? 'הסר ממועדפים' : 'הוסף למועדפים'}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: isFavorite(comp) ? 'var(--color-warning)' : 'var(--color-icon-muted)', padding: '2px 4px', lineHeight: 1 }}
                                  >★</button>
                                </div>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleRequestDeleteLog(comp) }}
                                  title="מחק מרכיב"
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--color-icon-muted)', padding: '2px 4px', lineHeight: 1, flexShrink: 0 }}
                                >✕</button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            {logged.length === 0 && (
              <div className="empty-state">
                <div className="empty-state-icon">🥗</div>
                <div className="empty-state-text">עדיין לא רשמת מזון היום</div>
              </div>
            )}
          </>
        )}

        {activeView === 'week' && (
          <div className="card week-view-card">
            <div className="section-title" style={{ marginBottom: 12 }}>
              <div className="section-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
              </div>
              השבוע האחרון
            </div>

            {weekLoading && <div className="week-view-info">טוען נתוני שבוע...</div>}
            {weekError && <div className="alert alert-error">{weekError}</div>}

            {!weekLoading && !weekError && (
              <div className="week-day-list">
                {orderedWeekData.map((day) => {
                  const isOpen = expandedDay === day.log_date
                  const dayItems = day.items || []
                  const isToday = day.log_date === new Date().toISOString().slice(0, 10)
                  return (
                    <div key={day.log_date} className={`week-day-card ${isToday ? 'today' : ''}`}>
                      <button
                        type="button"
                        className="week-day-header"
                        onClick={() => setExpandedDay(isOpen ? null : day.log_date)}
                      >
                        <div className="week-day-title-wrap">
                          <div className="week-day-title">{getDayLabel(day.log_date)}</div>
                          <div className="week-day-date">{getDayDate(day.log_date)}</div>
                        </div>
                        <div className="week-day-summary">
                          <span>{Math.round(day.calories)} קק״ל</span>
                          <span>{day.entries} מנות</span>
                          <span className="week-day-chevron">{isOpen ? '▴' : '▾'}</span>
                        </div>
                      </button>

                      {isOpen && (
                        <div className="week-day-content">
                          {dayItems.length === 0 && (
                            <div className="week-view-info">לא נרשמו מנות ביום זה.</div>
                          )}
                          {dayItems.length > 0 && (
                            <div className="week-food-list">
                              {dayItems.map((item, idx) => (
                                <div key={item.id ?? `${day.log_date}-${idx}`} className="week-food-item">
                                  <div className="week-food-main">
                                    <div className="week-food-name">{item.food_name}</div>
                                    <div className="week-food-meta">
                                      {Math.round(item.quantity_grams)}ג׳ · חלבון {Math.round(item.protein_g)}ג׳ · שומן {Math.round(item.fat_g)}ג׳ · פחמימה {Math.round(item.carbs_g)}ג׳
                                    </div>
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                                    <div className="week-food-calories">{Math.round(item.calories)} קק״ל</div>
                                    <button
                                      type="button"
                                      title="הוסף ליומן היום"
                                      onClick={() => { setActiveView('today'); addItem(item) }}
                                      style={{ background: 'var(--color-muted-bg)', border: '1px solid var(--color-border)', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: 'var(--color-primary)', padding: '3px 8px', whiteSpace: 'nowrap' }}
                                    >
                                      + היום
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}

                {orderedWeekData.length === 0 && (
                  <div className="week-view-info">אין נתונים שמורים עדיין.</div>
                )}
              </div>
            )}
          </div>
        )}

        {activeView === 'chat' && (
          <div className="card chat-card chat-card-fullscreen">
            <div className="section-title" style={{ marginBottom: 12 }}>
              <div className="section-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
              </div>
              צ׳אט תזונתי
            </div>

            <div className="chat-subtitle">היי {displayName || 'חבר/ה'}, שאל על מנות, כמויות ותחליפים. אם זוהתה מנה, אפשר להוסיף אותה ישר ליומן.</div>

            <div className="chat-messages" ref={chatListRef}>
              {chatMessages.map((message) => (
                <div key={message.id} className={`chat-bubble ${message.role === 'user' ? 'user' : 'assistant'}`}>
                  <div className="chat-bubble-text">{message.content}</div>

                  {(message.meal || message.components?.length > 0) && message.role === 'assistant' && (
                    <div className="chat-meal-card">
                      {message.meal && (
                        <div className="chat-meal-lines">
                          <div>{message.meal.food_name} · {Math.round(message.meal.quantity_grams)}ג׳</div>
                          <div>{Math.round(message.meal.calories)} קק״ל · חלבון {Math.round(message.meal.protein_g)}ג׳ · שומן {Math.round(message.meal.fat_g)}ג׳ · פחמימה {Math.round(message.meal.carbs_g)}ג׳</div>
                        </div>
                      )}

                      {message.components?.length > 0 && (
                        <div className="chat-meal-lines">
                          <div>ארוחה מרוכבת ({message.components.length} רכיבים)</div>
                          <div>
                            {message.components.map((c) => `${c.food_name} ${Math.round(c.quantity_grams)}ג׳`).join(' + ')}
                          </div>
                        </div>
                      )}

                      <button
                        type="button"
                        className="chat-add-btn"
                        onClick={() => handleAddFromChat(message)}
                      >
                        הוסף ליומן היומי
                      </button>
                    </div>
                  )}
                </div>
              ))}

              {chatLoading && (
                <div className="chat-bubble assistant">
                  <div className="chat-bubble-text">חושב על תשובה...</div>
                </div>
              )}
            </div>

            <form className="chat-form" onSubmit={handleSendChat}>
              <input
                className="form-input chat-input"
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="לדוגמה: מה עדיף לארוחת ערב אחרי אימון?"
                disabled={chatLoading}
              />
              <button type="submit" className="btn btn-primary chat-send-btn" disabled={chatLoading || !chatInput.trim()}>
                שלח
              </button>
            </form>
          </div>
        )}
      </div>

      <div className={`favorites-drawer-layer ${favoritesMenuOpen ? 'open' : ''}`} aria-hidden={!favoritesMenuOpen}>
        <button
          type="button"
          className="favorites-drawer-backdrop"
          aria-label="סגור רשימת מנות אהובות"
          onClick={() => setFavoritesMenuOpen(false)}
          tabIndex={favoritesMenuOpen ? 0 : -1}
        />
        <aside
          id="favorites-drawer"
          className="favorites-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="רשימת מנות אהובות"
        >
          <div className="favorites-drawer-header">
            <div className="favorites-drawer-title">מנות אהובות</div>
            <button
              type="button"
              className="favorites-drawer-close"
              onClick={() => setFavoritesMenuOpen(false)}
              aria-label="סגור"
            >
              ✕
            </button>
          </div>
          <div className="favorites-drawer-subtitle">לחץ על מנה כדי להוסיף ליומן היומי</div>

          {favorites.length > 4 && (
            <div style={{ padding: '0 16px 10px' }}>
              <input
                className="form-input"
                type="text"
                placeholder="חפש מנה..."
                value={favSearch}
                onChange={(e) => setFavSearch(e.target.value)}
                style={{ fontSize: 13 }}
              />
            </div>
          )}

          <div className="favorites-drawer-list">
            {favorites.length === 0 && (
              <div className="favorites-menu-empty">אין עדיין מנות אהובות</div>
            )}
            {favorites.filter((f) => !favSearch || f.food_name.includes(favSearch)).map((fav) => (
              <button
                key={fav.id}
                type="button"
                className="favorites-menu-item"
                onClick={() => handleAddFromFavorite(fav)}
                disabled={addingFavoriteId === fav.id}
                title="הוסף ליומן היומי"
              >
                <div className="favorites-menu-item-name">{fav.food_name}</div>
                <div className="favorites-menu-item-meta">{fav.quantity_grams}ג׳ · {Math.round(fav.calories)} קק״ל</div>
              </button>
            ))}
          </div>
        </aside>
      </div>

      <nav className="bottom-nav" aria-label="ניווט תחתון">
        <button
          type="button"
          className={`bottom-nav-btn nav-week ${activeView === 'week' ? 'active' : ''}`}
          onClick={() => handleSwitchView('week')}
        >
          <span className="bottom-nav-icon">📅</span>
          שבוע אחרון
        </button>

        <button
          type="button"
          className={`bottom-nav-plus ${activeView === 'today' ? 'active' : ''}`}
          onClick={() => handleSwitchView('today')}
          aria-label="יומן יומי"
        >
          <span>+</span>
        </button>

        <button
          type="button"
          className={`bottom-nav-btn nav-chat ${activeView === 'chat' ? 'active' : ''}`}
          onClick={() => handleSwitchView('chat')}
        >
          <span className="bottom-nav-icon">🤖</span>
          צ׳אט בוט
        </button>
      </nav>

      {isSettingsOpen && (
        <div className="modal-overlay" onClick={() => setIsSettingsOpen(false)}>
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="הגדרות"
          >
            <div className="modal-title">הגדרות אישיות</div>

            <form onSubmit={handleSaveSettings}>
              <div className="form-group">
                <label className="form-label">שם תצוגה</label>
                <input
                  className="form-input"
                  type="text"
                  value={settingsName}
                  onChange={(e) => {
                    setSettingsName(e.target.value)
                    setSettingsError(null)
                  }}
                  placeholder="איך לקרוא לך במערכת"
                  minLength={2}
                  maxLength={40}
                  required
                />
              </div>

              {settingsError && <div className="alert alert-error">{settingsError}</div>}

              <div className="settings-theme-row">
                <span className="settings-label">ערכת נושא</span>
                <button
                  type="button"
                  className="theme-toggle-btn"
                  onClick={onThemeToggle}
                >
                  {theme === 'light' ? '🌙 מעבר לכהה' : '☀️ מעבר לבהיר'}
                </button>
              </div>

              <div className="settings-actions-row">
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>שמור</button>
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 1, background: 'var(--color-muted-bg)', color: 'var(--color-foreground)' }}
                  onClick={() => navigate('/profile')}
                >
                  עריכת פרופיל
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* מודל עריכת מנה */}
      {editingItem && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'var(--overlay-bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '16px',
          }}
          onClick={() => setEditingItem(null)}
        >
          <div
            style={{
              background: 'var(--color-surface)',
              borderRadius: 'var(--radius, 12px)',
              padding: '24px 20px',
              width: '100%',
              maxWidth: 380,
              boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
              direction: 'rtl',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 16 }}>עריכת מנה</div>
            {editingGroupComponents.length > 0 && (
              <div
                style={{
                  marginBottom: 14,
                  padding: '10px 12px',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm, 8px)',
                  background: 'var(--color-muted-bg)',
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--color-muted-text)', marginBottom: 8 }}>מרכיבי הארוחה</div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {editingGroupComponents.map((comp, index) => {
                    const isCurrent = (editingItem.id && comp.id) ? comp.id === editingItem.id : comp === editingItem
                    return (
                      <div
                        key={comp.id ?? `${comp.food_name}-${index}`}
                        style={{
                          fontSize: 12,
                          color: isCurrent ? 'var(--color-primary)' : 'var(--color-muted-text)',
                          fontWeight: isCurrent ? 700 : 500,
                        }}
                      >
                        {comp.food_name} · {Math.round(comp.quantity_grams)}ג׳
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            <form onSubmit={handleSaveEdit}>
              <div className="form-group">
                <label className="form-label">שם המאכל</label>
                <input
                  className="form-input"
                  value={editValues.food_name}
                  onChange={(e) => setEditValues((v) => ({ ...v, food_name: e.target.value }))}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">כמות (גרם)</label>
                <input
                  className="form-input"
                  type="number" min="0" step="any"
                  value={editValues.quantity_grams}
                  onChange={(e) => setEditValues((v) => ({ ...v, quantity_grams: e.target.value }))}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">קלוריות</label>
                <input
                  className="form-input"
                  type="number" min="0" step="any"
                  value={editValues.calories}
                  onChange={(e) => setEditValues((v) => ({ ...v, calories: e.target.value }))}
                  required
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">חלבון (ג׳)</label>
                  <input
                    className="form-input"
                    type="number" min="0" step="any"
                    value={editValues.protein_g}
                    onChange={(e) => setEditValues((v) => ({ ...v, protein_g: e.target.value }))}
                    required
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">שומן (ג׳)</label>
                  <input
                    className="form-input"
                    type="number" min="0" step="any"
                    value={editValues.fat_g}
                    onChange={(e) => setEditValues((v) => ({ ...v, fat_g: e.target.value }))}
                    required
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">פחמימות (ג׳)</label>
                  <input
                    className="form-input"
                    type="number" min="0" step="any"
                    value={editValues.carbs_g}
                    onChange={(e) => setEditValues((v) => ({ ...v, carbs_g: e.target.value }))}
                    required
                  />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
                <button className="btn btn-primary" type="submit" disabled={editSaving} style={{ flex: 1 }}>
                  {editSaving ? 'שומר...' : 'שמור'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingItem(null)}
                  style={{
                    flex: 1, padding: '10px', borderRadius: 'var(--radius-sm, 8px)',
                    border: '1px solid var(--color-border)', background: 'var(--color-muted-bg)',
                    color: 'var(--color-foreground)', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 14,
                  }}
                >
                  ביטול
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deletePrompt && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 1100,
            background: 'var(--overlay-bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '16px',
          }}
          onClick={() => setDeletePrompt(null)}
        >
          <div
            style={{
              background: 'var(--color-surface)',
              borderRadius: 'var(--radius, 12px)',
              padding: '20px',
              width: '100%',
              maxWidth: 360,
              border: '1.5px solid var(--color-border)',
              boxShadow: '0 12px 36px rgba(15, 23, 42, 0.24)',
              direction: 'rtl',
            }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={deletePrompt.title}
          >
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>{deletePrompt.title}</div>
            <div style={{ fontSize: 14, color: 'var(--color-muted-text)', lineHeight: 1.5 }}>{deletePrompt.message}</div>

            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <button
                type="button"
                onClick={() => setDeletePrompt(null)}
                style={{
                  flex: 1, padding: '10px', borderRadius: 'var(--radius-sm, 8px)',
                  border: '1px solid var(--color-border)', background: 'var(--color-muted-bg)',
                  color: 'var(--color-foreground)', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 14,
                }}
              >
                ביטול
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="btn"
                style={{ flex: 1, background: 'var(--color-destructive)', color: '#fff', padding: '10px' }}
              >
                מחק
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Dashboard
