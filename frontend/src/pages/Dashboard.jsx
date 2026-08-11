import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  describeFood, identifyFoodFromImage,
  initUser, getUserId,
  logFoodToDB, getTodayLog, getWeekLog, removeLogEntry, updateLogEntry, logMealBatch,
  getFavorites, addFavorite, removeFavorite, addFavoriteGroup, removeFavoriteGroup,
  chatFoodAssistant, saveDailyWeight,
} from '../services/api.js'

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
const DAILY_WEIGHT_REMINDER_KEY = 'calio_daily_weight_reminder_enabled'
const DAILY_WEIGHT_PROMPTED_KEY = 'calio_daily_weight_prompted_on'

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

function groupItemsByMealGroup(items) {
  const result = []
  const seenGroups = new Set()

  for (const item of items) {
    if (!item.meal_group_id) {
      result.push({ type: 'single', item })
      continue
    }

    if (seenGroups.has(item.meal_group_id)) continue

    seenGroups.add(item.meal_group_id)
    const components = items.filter((i) => i.meal_group_id === item.meal_group_id)
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

  return result
}

function getTodayKey() {
  const currentDate = new Date()
  currentDate.setMinutes(currentDate.getMinutes() - currentDate.getTimezoneOffset())
  return currentDate.toISOString().slice(0, 10)
}

function getDateKeyWithOffset(daysOffset) {
  const currentDate = new Date()
  currentDate.setDate(currentDate.getDate() + daysOffset)
  currentDate.setMinutes(currentDate.getMinutes() - currentDate.getTimezoneOffset())
  return currentDate.toISOString().slice(0, 10)
}

function formatWeight(weightKg) {
  return `${Number(weightKg).toFixed(1)} ק״ג`
}

function parseWeightValue(value) {
  if (value === null || value === undefined || value === '') return null
  const normalizedValue = Number(value)
  return Number.isFinite(normalizedValue) ? normalizedValue : null
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
  const chatImageInputRef = useRef(null)
  const [loading, setLoading] = useState(false)
  const [loadingStep, setLoadingStep] = useState(0)
  const [loadingIsImage, setLoadingIsImage] = useState(false)
  const [error, setError] = useState(null)
  const [logged, setLogged] = useState([])
  const [favorites, setFavorites] = useState([])
  const [addingFavoriteId, setAddingFavoriteId] = useState(null)
  const [favoritesMenuOpen, setFavoritesMenuOpen] = useState(false)
  const [weekData, setWeekData] = useState([])
  const [weekLoading, setWeekLoading] = useState(false)
  const [weekError, setWeekError] = useState(null)
  const [weekDataReady, setWeekDataReady] = useState(false)
  const [savingFav, setSavingFav] = useState(null)   // id של item שנשמר כרגע
  const [editingItem, setEditingItem] = useState(null)
  const [editValues, setEditValues] = useState({})
  const [editBaseValues, setEditBaseValues] = useState(null)
  const [editSaving, setEditSaving] = useState(false)
  const [deletePrompt, setDeletePrompt] = useState(null)
  const [expandedGroupId, setExpandedGroupId] = useState(null)
  const [favSearch, setFavSearch] = useState('')
  const [loadError, setLoadError] = useState(null)
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatDayKey, setChatDayKey] = useState(getTodayKey)
  const [expandedWeekGroupKey, setExpandedWeekGroupKey] = useState(null)
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('calio_display_name') || '')
  const [chatMessages, setChatMessages] = useState(() => [createWelcomeChatMessage(localStorage.getItem('calio_display_name') || '')])
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsName, setSettingsName] = useState(() => localStorage.getItem('calio_display_name') || '')
  const [dailyWeightReminderEnabled, setDailyWeightReminderEnabled] = useState(() => localStorage.getItem(DAILY_WEIGHT_REMINDER_KEY) === 'true')
  const [settingsDailyWeightReminderEnabled, setSettingsDailyWeightReminderEnabled] = useState(() => localStorage.getItem(DAILY_WEIGHT_REMINDER_KEY) === 'true')
  const [settingsError, setSettingsError] = useState(null)
  const [isDailyWeightPromptOpen, setIsDailyWeightPromptOpen] = useState(false)
  const [dailyWeightInput, setDailyWeightInput] = useState('')
  const [dailyWeightError, setDailyWeightError] = useState(null)
  const [dailyWeightSaving, setDailyWeightSaving] = useState(false)
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
      setWeekDataReady(true)
      setWeekLoading(false)
    }
  }, [])

  useEffect(() => {
    async function init() {
      try {
        const user = await initUser()
        await Promise.all([loadTodayData(user.id), loadWeekData(user.id)])
      } catch {
        // שרת לא זמין - ממשיכים ב-offline mode
      }
    }
    init()

    // רענון נתוני היום כשהמשתמש חוזר לאפליקציה (חשוב בנייד)
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        const uid = getUserId()
        if (uid) loadTodayData(uid)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [loadTodayData, loadWeekData])

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
    if (!loading) { setLoadingStep(0); return }
    const id = setInterval(() => {
      setLoadingStep((s) => Math.min(s + 1, 3))
    }, 1600)
    return () => clearInterval(id)
  }, [loading])

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

  useEffect(() => {
    if (!dailyWeightReminderEnabled) {
      setIsDailyWeightPromptOpen(false)
    }
  }, [dailyWeightReminderEnabled])

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

  const todayKey = getTodayKey()
  const yesterdayKey = getDateKeyWithOffset(-1)
  const todayWeightEntry = useMemo(
    () => weekData.find((day) => day.log_date === todayKey)?.weight_kg ?? null,
    [todayKey, weekData]
  )
  const yesterdayWeightEntry = useMemo(
    () => weekData.find((day) => day.log_date === yesterdayKey)?.weight_kg ?? null,
    [weekData, yesterdayKey]
  )
  const weeklyWeightAverage = useMemo(() => {
    const weightValues = weekData
      .map((day) => Number(day.weight_kg))
      .filter((weight) => Number.isFinite(weight))

    if (weightValues.length === 0) return null

    return weightValues.reduce((sum, weight) => sum + weight, 0) / weightValues.length
  }, [weekData])
  const headerWeightSummary = useMemo(() => {
    if (new Date().getDay() !== 6 || weeklyWeightAverage == null) return null

    return {
      id: 'weekly-average',
      variant: 'neutral',
      label: 'ממוצע שבועי',
      value: formatWeight(weeklyWeightAverage),
    }
  }, [weeklyWeightAverage])

  const headerProgressMessage = useMemo(() => {
    if (!dailyWeightReminderEnabled || !profile) return null

    const goal = profile.goal
    const sex = profile.sex
    const startingWeight = parseWeightValue(profile.weight_kg)
    const targetWeight = parseWeightValue(profile.target_weight_kg)
    const todayWeight = parseWeightValue(todayWeightEntry)
    const yesterdayWeight = parseWeightValue(yesterdayWeightEntry)
    const hasStartingWeight = startingWeight != null
    const hasTargetWeight = targetWeight != null
    const hasTodayWeight = todayWeight != null
    const hasYesterdayWeight = yesterdayWeight != null

    if (!hasTodayWeight) return null

    if (hasTargetWeight) {
      const reachedTarget =
        (goal === 'gain' && todayWeight >= targetWeight) ||
        (goal === 'lose' && todayWeight <= targetWeight)

      if (reachedTarget) {
        return {
          id: 'target-reached',
          variant: 'success',
          label: 'יעד משקל',
          value: 'עברת את משקל היעד כל הכבוד!',
        }
      }
    }

    if (!hasYesterdayWeight) return null

    const movedDailyInRightDirection =
      (goal === 'gain' && todayWeight > yesterdayWeight) ||
      (goal === 'lose' && todayWeight < yesterdayWeight)

    const progressedFromStartingWeight = !hasStartingWeight ||
      (goal === 'gain' && todayWeight >= startingWeight) ||
      (goal === 'lose' && todayWeight <= startingWeight)

    const inRightDirection = movedDailyInRightDirection && progressedFromStartingWeight

    if (!inRightDirection) return null

    return {
      id: 'weight-direction',
      variant: 'success',
      label: 'מגמת משקל',
      value: `${sex === 'female' ? 'את' : 'אתה'} בכיוון הנכון`,
      emoji: '🔥',
    }
  }, [dailyWeightReminderEnabled, profile, todayWeightEntry, yesterdayWeightEntry])

  const headerInsights = [headerWeightSummary, headerProgressMessage].filter(Boolean)

  useEffect(() => {
    if (!dailyWeightReminderEnabled || !profile || !userId || !weekDataReady || weekLoading || weekError) return
    if (todayWeightEntry != null) return
    if (localStorage.getItem(DAILY_WEIGHT_PROMPTED_KEY) === todayKey) return

    localStorage.setItem(DAILY_WEIGHT_PROMPTED_KEY, todayKey)
    setDailyWeightInput(profile.weight_kg ? String(profile.weight_kg) : '')
    setDailyWeightError(null)
    setIsDailyWeightPromptOpen(true)
  }, [dailyWeightReminderEnabled, profile, todayKey, todayWeightEntry, userId, weekDataReady, weekError, weekLoading])

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
    setLoadingIsImage(!!imageFile)
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
    const baseValues = {
      quantity_grams: Number(item.quantity_grams) || 0,
      calories: Number(item.calories) || 0,
      protein_g: Number(item.protein_g) || 0,
      fat_g: Number(item.fat_g) || 0,
      carbs_g: Number(item.carbs_g) || 0,
    }

    setEditingItem(item)
    setEditBaseValues(baseValues)
    setEditValues({
      food_name: item.food_name,
      quantity_grams: item.quantity_grams,
      calories: item.calories,
      protein_g: item.protein_g,
      fat_g: item.fat_g,
      carbs_g: item.carbs_g || 0,
    })
  }

  function formatScaledNumber(value) {
    if (!Number.isFinite(value)) return ''
    const rounded = Math.round(value * 100) / 100
    return String(rounded)
  }

  function handleEditQuantityChange(rawQuantity) {
    const nextQuantity = Number(rawQuantity)

    setEditValues((prev) => {
      if (!editBaseValues || !Number.isFinite(nextQuantity) || nextQuantity < 0 || editBaseValues.quantity_grams <= 0) {
        return { ...prev, quantity_grams: rawQuantity }
      }

      const ratio = nextQuantity / editBaseValues.quantity_grams
      return {
        ...prev,
        quantity_grams: rawQuantity,
        calories: formatScaledNumber(editBaseValues.calories * ratio),
        protein_g: formatScaledNumber(editBaseValues.protein_g * ratio),
        fat_g: formatScaledNumber(editBaseValues.fat_g * ratio),
        carbs_g: formatScaledNumber(editBaseValues.carbs_g * ratio),
      }
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
      setEditBaseValues(null)
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

  const groupedFavorites = useMemo(() => {
    const result = []
    const seenGroups = new Set()
    for (const fav of favorites) {
      if (!fav.favorite_group_id) {
        result.push(fav)
      } else if (!seenGroups.has(fav.favorite_group_id)) {
        seenGroups.add(fav.favorite_group_id)
        const groupItems = favorites.filter((f) => f.favorite_group_id === fav.favorite_group_id)
        const total = groupItems.reduce(
          (acc, c) => ({
            calories: acc.calories + c.calories,
            protein_g: acc.protein_g + c.protein_g,
            fat_g: acc.fat_g + c.fat_g,
            carbs_g: acc.carbs_g + c.carbs_g,
          }),
          { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 }
        )
        result.push({ id: fav.favorite_group_id, favorite_group_id: fav.favorite_group_id, group_name: fav.group_name, components: groupItems, total })
      }
    }
    return result
  }, [favorites])

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

  async function handleToggleGroupFavorite(components, title) {
    if (!userId) return
    setSavingFav(`group_${title}`)
    try {
      const existing = favorites.find((f) => f.favorite_group_id && f.group_name === title)
      if (existing) {
        await removeFavoriteGroup(existing.favorite_group_id)
        setFavorites((prev) => prev.filter((f) => f.favorite_group_id !== existing.favorite_group_id))
      } else {
        const saved = await addFavoriteGroup(userId, title, components.map((c) => ({
          food_name: c.food_name,
          quantity_grams: c.quantity_grams,
          calories: c.calories,
          protein_g: c.protein_g,
          fat_g: c.fat_g,
          carbs_g: c.carbs_g || 0,
        })))
        setFavorites((prev) => [...prev, ...saved])
      }
    } catch { /* silent */ } finally {
      setSavingFav(null)
    }
  }

  // הוספת מועדף לרשימה היומית
  async function handleAddFromFavorite(entry) {
    const key = entry.favorite_group_id ?? entry.id
    setAddingFavoriteId(key)
    try {
      if (entry.favorite_group_id) {
        await addItem({ components: entry.components })
      } else {
        await addItem(entry)
      }
      setFavoritesMenuOpen(false)
    } finally {
      setAddingFavoriteId(null)
    }
  }

  async function handleRemoveFavoriteGroup(favGroupId) {
    try {
      await removeFavoriteGroup(favGroupId)
      setFavorites((prev) => prev.filter((f) => f.favorite_group_id !== favGroupId))
    } catch { /* silent */ }
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
    setSettingsDailyWeightReminderEnabled(dailyWeightReminderEnabled)
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
    localStorage.setItem(DAILY_WEIGHT_REMINDER_KEY, settingsDailyWeightReminderEnabled ? 'true' : 'false')
    const savedProfile = JSON.parse(localStorage.getItem('calio_profile') || 'null')
    if (savedProfile) {
      localStorage.setItem('calio_profile', JSON.stringify({ ...savedProfile, display_name: normalizedName }))
    }
    setDailyWeightReminderEnabled(settingsDailyWeightReminderEnabled)
    setDisplayName(normalizedName)
    setSettingsError(null)
    setIsSettingsOpen(false)
  }

  async function handleSaveDailyWeight(e) {
    e.preventDefault()
    const normalizedWeight = Number(String(dailyWeightInput).replace(',', '.'))

    if (!Number.isFinite(normalizedWeight) || normalizedWeight <= 0) {
      setDailyWeightError('צריך להזין משקל תקין בקילוגרמים.')
      return
    }

    if (!userId) {
      setDailyWeightError('לא הצלחנו לזהות משתמש לשמירת המשקל.')
      return
    }

    setDailyWeightSaving(true)
    setDailyWeightError(null)
    try {
      await saveDailyWeight(userId, normalizedWeight, todayKey)
      const savedProfile = JSON.parse(localStorage.getItem('calio_profile') || 'null')
      if (savedProfile) {
        localStorage.setItem('calio_profile', JSON.stringify({ ...savedProfile, weight_kg: normalizedWeight }))
      }
      await loadWeekData(userId)
      setIsDailyWeightPromptOpen(false)
    } catch (err) {
      setDailyWeightError(err.message || 'לא הצלחנו לשמור את המשקל היומי.')
    } finally {
      setDailyWeightSaving(false)
    }
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

  async function handleChatImageUpload(e) {
    const file = e.target.files?.[0]
    if (!file || chatLoading) return
    if (chatImageInputRef.current) chatImageInputRef.current.value = ''
    ensureChatDayIsCurrent()

    const userMsg = {
      id: crypto.randomUUID(),
      role: 'user',
      content: '📷 שלחתי תמונה של מנה לניתוח',
      meal: null,
      components: null,
    }
    setChatMessages((prev) => [...prev, userMsg])
    setChatLoading(true)

    try {
      const result = await identifyFoodFromImage(file)
      const parts = []
      if (result.meal) {
        parts.push(`זיהיתי: ${result.meal.food_name} (${Math.round(result.meal.quantity_grams)}ג׳) — ${Math.round(result.meal.calories)} קק״ל · חלבון ${Math.round(result.meal.protein_g)}ג׳ · שומן ${Math.round(result.meal.fat_g)}ג׳ · פחמימה ${Math.round(result.meal.carbs_g)}ג׳`)
      } else if (result.components?.length) {
        parts.push(`זיהיתי ארוחה מרוכבת (${result.components.length} רכיבים):`)
        result.components.forEach((c) => parts.push(`• ${c.food_name} ${Math.round(c.quantity_grams)}ג׳ — ${Math.round(c.calories)} קק״ל`))
      } else {
        parts.push('לא הצלחתי לזהות מנה בתמונה. נסה תמונה ברורה יותר.')
      }
      const assistantMsg = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: parts.join('\n'),
        meal: result.meal || null,
        components: result.components || null,
      }
      setChatMessages((prev) => [...prev, assistantMsg])
    } catch (err) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: err.message || 'לא הצלחתי לזהות את המנה בתמונה.',
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
          <div className="app-logo">
            <img src="/calorie_app_logo.png" alt="CAL.IO" />
          </div>
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
            {profile && headerInsights.length > 0 && (
              <div className="dashboard-insights" aria-live="polite">
                {headerInsights.map((insight) => (
                  <div key={insight.id} className={`dashboard-insight-card ${insight.variant === 'success' ? 'success' : ''}`}>
                    <div className="dashboard-insight-label">{insight.label}</div>
                    <div className="dashboard-insight-value">
                      <span>{insight.value}</span>
                      {insight.emoji && <span className="dashboard-insight-emoji" aria-hidden="true">{insight.emoji}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}

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
                    <button
                      type="button"
                      className="plate-preview-remove"
                      aria-label="הסר תמונה"
                      onClick={() => {
                        setImageFile(null)
                        setImagePreview(null)
                        if (cameraInputRef.current) cameraInputRef.current.value = ''
                        const galleryInput = document.getElementById('plate-gallery-input')
                        if (galleryInput) galleryInput.value = ''
                      }}
                    >
                      ✕
                    </button>
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

                <button className="btn btn-primary" type="submit" disabled={loading}>
                  נתחו עבורי
                </button>
              </form>

              {loading && (() => {
                const textSteps = ['קורא את התיאור...', 'מזהה מרכיבים...', 'מחשב ערכים תזונתיים...', 'כמעט מוכן...']
                const imageSteps = ['סורק את התמונה...', 'מזהה מנות...', 'מחשב ערכים תזונתיים...', 'כמעט מוכן...']
                const steps = loadingIsImage ? imageSteps : textSteps
                return (
                  <div className="ai-loading-overlay" role="status" aria-live="polite">
                    <div className="ai-loading-content">
                      <div className="ai-loading-icon">
                        <div className="ai-loading-ring" />
                        <span>{loadingIsImage ? '📸' : '🥪'}</span>
                      </div>
                      <div className="ai-loading-title">מנתח עם בינה מלאכותית</div>
                      <div className="ai-loading-step">{steps[loadingStep]}</div>
                      <div className="ai-loading-progress">
                        <div className="ai-loading-progress-fill" style={{ width: `${(loadingStep + 1) * 25}%` }} />
                      </div>
                      <div className="ai-loading-dots">
                        <span /><span /><span />
                      </div>
                    </div>
                  </div>
                )
              })()}
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
                              onClick={() => handleToggleGroupFavorite(components, title)}
                              disabled={savingFav === `group_${title}`}
                              title={favorites.some((f) => f.favorite_group_id && f.group_name === title) ? 'הסר מארוחות אהובות' : 'שמור ארוחה שלמה למועדפים'}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: favorites.some((f) => f.favorite_group_id && f.group_name === title) ? 'var(--color-warning)' : 'var(--color-icon-muted)', padding: '2px 4px', lineHeight: 1 }}
                            >★</button>
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
                        onClick={() => {
                          setExpandedDay(isOpen ? null : day.log_date)
                          setExpandedWeekGroupKey(null)
                        }}
                      >
                        <div className="week-day-title-wrap">
                          <div className="week-day-title">{getDayLabel(day.log_date)}</div>
                          <div className="week-day-date">{getDayDate(day.log_date)}</div>
                        </div>
                        <div className="week-day-summary">
                          {day.weight_kg != null && <span>{formatWeight(day.weight_kg)}</span>}
                          <span>{Math.round(day.calories)} קק״ל</span>
                          <span>{day.entries} מנות</span>
                          <span className="week-day-chevron">{isOpen ? '▴' : '▾'}</span>
                        </div>
                      </button>

                      {isOpen && (
                        <div className="week-day-content">
                          {day.weight_kg != null && (
                            <div className="week-weight-entry">
                              <div className="week-weight-entry-label">משקל יומי</div>
                              <div className="week-weight-entry-value">{formatWeight(day.weight_kg)}</div>
                            </div>
                          )}
                          {dayItems.length === 0 && day.weight_kg == null && (
                            <div className="week-view-info">לא נרשמו מנות ביום זה.</div>
                          )}
                          {dayItems.length > 0 && (
                            <div className="week-food-list">
                              {groupItemsByMealGroup(dayItems).map((entry, idx) => {
                                if (entry.type === 'single') {
                                  const item = entry.item
                                  return (
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
                                  )
                                }

                                const groupKey = `${day.log_date}_${entry.meal_group_id}`
                                const isGroupOpen = expandedWeekGroupKey === groupKey

                                return (
                                  <div key={groupKey} style={{ borderRadius: 'var(--radius-sm, 8px)', overflow: 'hidden', border: '1px solid var(--color-border)' }}>
                                    <div
                                      className="week-food-item"
                                      style={{ cursor: 'pointer' }}
                                      onClick={() => setExpandedWeekGroupKey(isGroupOpen ? null : groupKey)}
                                    >
                                      <div className="week-food-main">
                                        <div className="week-food-name">🍱 {entry.title}</div>
                                        <div className="week-food-meta">
                                          חלבון {Math.round(entry.total.protein_g)}ג׳ · שומן {Math.round(entry.total.fat_g)}ג׳ · פחמימה {Math.round(entry.total.carbs_g)}ג׳
                                        </div>
                                      </div>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                                        <div className="week-food-calories">{Math.round(entry.total.calories)} קק״ל</div>
                                        <button
                                          type="button"
                                          title="הוסף ארוחה ליומן היום"
                                          onClick={(e) => { e.stopPropagation(); setActiveView('today'); addItem({ components: entry.components }) }}
                                          style={{ background: 'var(--color-muted-bg)', border: '1px solid var(--color-border)', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: 'var(--color-primary)', padding: '3px 8px', whiteSpace: 'nowrap' }}
                                        >
                                          + היום
                                        </button>
                                        <span style={{ color: 'var(--color-icon-muted)', fontSize: 12, padding: '2px 4px' }}>{isGroupOpen ? '▴' : '▾'}</span>
                                      </div>
                                    </div>

                                    {isGroupOpen && (
                                      <div style={{ borderTop: '1px solid var(--color-border)', background: 'var(--color-muted-bg)' }}>
                                        {entry.components.map((comp, compIdx) => (
                                          <div
                                            key={comp.id ?? `${groupKey}-${compIdx}`}
                                            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: compIdx < entry.components.length - 1 ? '1px solid var(--color-border)' : 'none' }}
                                          >
                                            <div style={{ flex: 1 }}>
                                              <div style={{ fontWeight: 600, color: 'var(--color-foreground)', fontSize: 13 }}>{comp.food_name}</div>
                                              <div style={{ color: 'var(--color-muted-text)', fontSize: 11, marginTop: 2 }}>
                                                {Math.round(comp.quantity_grams)}ג׳ · חלבון {Math.round(comp.protein_g)}ג׳ · שומן {Math.round(comp.fat_g)}ג׳ · פחמימה {Math.round(comp.carbs_g)}ג׳
                                              </div>
                                            </div>
                                            <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--color-primary)', flexShrink: 0 }}>
                                              {Math.round(comp.calories)} קק״ל
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
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
              <label className="chat-image-btn" htmlFor="chat-image-input" title="העלה תמונה של מנה" aria-label="העלה תמונה">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="6"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              </label>
              <input
                id="chat-image-input"
                ref={chatImageInputRef}
                type="file"
                accept="image/*"
                className="plate-photo-input"
                onChange={handleChatImageUpload}
                disabled={chatLoading}
              />
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
            {groupedFavorites
              .filter((entry) => !favSearch || (entry.group_name ?? entry.food_name ?? '').includes(favSearch))
              .map((entry) => {
                if (entry.favorite_group_id) {
                  const key = entry.favorite_group_id
                  return (
                    <div key={key} className="favorites-menu-item favorites-menu-item-group">
                      <button
                        type="button"
                        className="favorites-menu-item-add-btn"
                        onClick={() => handleAddFromFavorite(entry)}
                        disabled={addingFavoriteId === key}
                        title="הוסף ארוחה שלמה ליומן"
                      >
                        <div className="favorites-menu-item-name">
                          <span style={{ fontSize: 14, marginLeft: 5 }}>🍱</span>
                          {entry.group_name}
                        </div>
                        <div className="favorites-menu-item-meta">
                          {entry.components.length} מרכיבים · {Math.round(entry.total.calories)} קק״ל · חלבון {Math.round(entry.total.protein_g)}ג׳
                        </div>
                      </button>
                      <button
                        type="button"
                        className="favorites-menu-item-remove"
                        onClick={() => handleRemoveFavoriteGroup(key)}
                        title="הסר מהמועדפים"
                        aria-label="הסר ארוחה מהמועדפים"
                      >✕</button>
                    </div>
                  )
                }
                return (
                  <div key={entry.id} className="favorites-menu-item">
                    <button
                      type="button"
                      className="favorites-menu-item-add-btn"
                      onClick={() => handleAddFromFavorite(entry)}
                      disabled={addingFavoriteId === entry.id}
                      title="הוסף ליומן היומי"
                    >
                      <div className="favorites-menu-item-name">{entry.food_name}</div>
                      <div className="favorites-menu-item-meta">{entry.quantity_grams}ג׳ · {Math.round(entry.calories)} קק״ל</div>
                    </button>
                  </div>
                )
              })}
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

              <div className="settings-toggle-row">
                <div>
                  <div className="settings-label">תזכורת משקל יומית</div>
                  <div className="settings-toggle-hint">אם הפעולה פעילה, תופיע בקשה להזין משקל בפתיחה הראשונה של כל יום.</div>
                </div>

                <label className="switch-toggle" aria-label="הפעלת תזכורת משקל יומית">
                  <input
                    type="checkbox"
                    checked={settingsDailyWeightReminderEnabled}
                    onChange={(e) => setSettingsDailyWeightReminderEnabled(e.target.checked)}
                  />
                  <span className="switch-toggle-slider" />
                </label>
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

      {isDailyWeightPromptOpen && (
        <div className="modal-overlay" onClick={() => setIsDailyWeightPromptOpen(false)}>
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="הזנת משקל יומי"
          >
            <div className="modal-title">מה המשקל שלך היום?</div>
            <div className="daily-weight-modal-subtitle">המשקל יישמר במסך השבוע האחרון וייכנס לממוצע השבועי של שבת.</div>

            <form onSubmit={handleSaveDailyWeight}>
              <div className="form-group">
                <label className="form-label">משקל בקילוגרמים</label>
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  step="0.1"
                  inputMode="decimal"
                  value={dailyWeightInput}
                  onChange={(e) => {
                    setDailyWeightInput(e.target.value)
                    setDailyWeightError(null)
                  }}
                  placeholder="לדוגמה 78.4"
                  autoFocus
                  required
                />
              </div>

              {dailyWeightError && <div className="alert alert-error">{dailyWeightError}</div>}

              <div className="settings-actions-row">
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={dailyWeightSaving}>
                  {dailyWeightSaving ? 'שומר...' : 'שמור משקל'}
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 1, background: 'var(--color-muted-bg)', color: 'var(--color-foreground)' }}
                  onClick={() => setIsDailyWeightPromptOpen(false)}
                  disabled={dailyWeightSaving}
                >
                  אחר כך
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
          onClick={() => {
            setEditingItem(null)
            setEditBaseValues(null)
          }}
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
                  onChange={(e) => handleEditQuantityChange(e.target.value)}
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
                  onClick={() => {
                    setEditingItem(null)
                    setEditBaseValues(null)
                  }}
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
