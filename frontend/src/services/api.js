/**
 * כל הקריאות ל-Backend של CAL.IO במקום אחד.
 *
 * VITE_API_URL:
 *  - פיתוח: מוגדר ב-frontend/.env (למשל http://localhost:8001)
 *  - פרודקשן: להגדיר ב-.env.production או במשתני הסביבה של פלטפורמת הדיפלוימנט
 *    (Vercel/Netlify וכו') לכתובת הפומבית של ה-backend.
 * אם לא הוגדר בכלל, ננסה לפנות ל-origin של הדף עצמו (יעבוד רק אם ה-frontend
 * וה-backend מוגשים מאותו host).
 */
const BASE_URL = (import.meta.env.VITE_API_URL || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '')

const IMAGE_MAX_SIDE = 1280
const IMAGE_QUALITY = 0.8

async function optimizeImageForUpload(file) {
  // If the browser does not support canvas/image decode APIs, fall back to original file.
  if (typeof window === 'undefined' || typeof createImageBitmap !== 'function') {
    return file
  }

  try {
    const bitmap = await createImageBitmap(file)
    const { width, height } = bitmap
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(width, height))
    const targetWidth = Math.max(1, Math.round(width * scale))
    const targetHeight = Math.max(1, Math.round(height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return file

    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight)

    const preferredType = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    const blob = await new Promise((resolve) => {
      canvas.toBlob((result) => resolve(result), preferredType, IMAGE_QUALITY)
    })

    if (!blob) return file
    if (blob.size >= file.size) return file

    return new File([blob], file.name, { type: blob.type || file.type, lastModified: file.lastModified })
  } catch {
    return file
  }
}

// ── Device user (זיהוי ללא הרשמה) ──────────────────────────────────────────

function getDeviceId() {
  let id = localStorage.getItem('calio_device_id')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('calio_device_id', id)
  }
  return id
}

/** יוצר / מחזיר את המשתמש לפי device_id, שומר user_id ב-localStorage. */
export async function initUser() {
  const deviceId = getDeviceId()
  const response = await fetch(`${BASE_URL}/user/device/${deviceId}`)
  if (!response.ok) throw new Error('שגיאה באתחול המשתמש')
  const user = await response.json()
  localStorage.setItem('calio_user_id', String(user.id))
  return user
}

export function getUserId() {
  return localStorage.getItem('calio_user_id')
}

// ── פרופיל ──────────────────────────────────────────────────────────────────

export async function calculateProfile(profileData) {
  const response = await fetch(`${BASE_URL}/profile/calculate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profileData),
  })
  if (!response.ok) throw new Error('שגיאה בחישוב הפרופיל')
  return response.json()
}

/** שומר את הפרופיל המלא (נתוני קלט + תוצאות) לDB. */
export async function saveProfileToDB(userId, profileInput, profileResult) {
  const response = await fetch(`${BASE_URL}/profile/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: Number(userId), ...profileInput, ...profileResult }),
  })
  if (!response.ok) throw new Error('שגיאה בשמירת הפרופיל')
  return response.json()
}

/** טוען פרופיל שמור מה-DB. מחזיר null אם אין. */
export async function loadProfileFromDB(userId) {
  const response = await fetch(`${BASE_URL}/profile/${userId}`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error('שגיאה בטעינת פרופיל')
  return response.json()
}

// ── מזון ────────────────────────────────────────────────────────────────────

export async function lookupFood(foodName, quantityGrams) {
  const response = await fetch(`${BASE_URL}/food/lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ food_name: foodName, quantity_grams: quantityGrams }),
  })
  if (!response.ok) throw new Error('לא נמצא מזון מתאים')
  return response.json()
}

export async function describeFood(description) {
  const payload = JSON.stringify({ description })

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetch(`${BASE_URL}/food/describe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })

    if (response.ok) return response.json()

    const err = await response.json().catch(() => ({}))
    const detail = err.detail || 'לא הצלחנו להעריך את המנה'
    const isTransient = response.status === 503

    if (isTransient && attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, 700))
      continue
    }

    throw new Error(detail)
  }

  throw new Error('לא הצלחנו להעריך את המנה')
}

export async function chatFoodAssistant(message, history = []) {
  const response = await fetch(`${BASE_URL}/food/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || 'לא הצלחנו לקבל תשובה מהצ׳אט')
  }
  return response.json()
}

/** שולח תמונה של מאכל ומקבל זיהוי + ערכים תזונתיים. */
export async function identifyFoodFromImage(file) {
  const optimized = await optimizeImageForUpload(file)
  const formData = new FormData()
  formData.append('file', optimized)
  const response = await fetch(`${BASE_URL}/food/identify-image`, {
    method: 'POST',
    body: formData,
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || 'לא הצלחנו לזהות את המאכל בתמונה')
  }
  return response.json()
}

/** שומר מנה לDB (לאחר שכבר חישבנו את הערכים). מחזיר רשומה עם id. */
export async function logFoodToDB(userId, foodData) {
  const response = await fetch(`${BASE_URL}/food/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: Number(userId), ...foodData }),
  })
  if (!response.ok) throw new Error('שגיאה בשמירת המנה')
  return response.json()
}

/** מוחק רשומה מהיומן לפי id. */
export async function removeLogEntry(logId) {
  const response = await fetch(`${BASE_URL}/food/log/${logId}`, { method: 'DELETE' })
  if (!response.ok) throw new Error('שגיאה במחיקת רשומה')
}

/** מעדכן ערכי מנה קיימת לפי id. */
export async function updateLogEntry(logId, data) {
  const response = await fetch(`${BASE_URL}/food/log/${logId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error('שגיאה בעדכון המנה')
  return response.json()
}

/** שומר מנה מרוכבת (כמה מרכיבים) לDB תחת אותו meal_group_id. */
export async function logMealBatch(userId, components, mealGroupId) {
  const response = await fetch(`${BASE_URL}/food/log/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: Number(userId),
      meal_group_id: mealGroupId,
      source: 'ai',
      components,
    }),
  })
  if (!response.ok) throw new Error('שגיאה בשמירת המנה המרוכבת')
  return response.json()
}

// ── יומן ────────────────────────────────────────────────────────────────────

/** מחזיר את כל המנות של היום. אוטומטית "מתאפס" בכל יום חדש. */
export async function getTodayLog(userId) {
  const response = await fetch(`${BASE_URL}/food/today/${userId}`)
  if (!response.ok) throw new Error('שגיאה בטעינת יומן היום')
  return response.json()
}

/** מחזיר סיכום 7 ימים אחורה (כולל היום). */
export async function getWeekLog(userId) {
  const response = await fetch(`${BASE_URL}/food/week/${userId}`)
  if (!response.ok) throw new Error('שגיאה בטעינת היסטוריה שבועית')
  return response.json()
}

// ── מועדפים ─────────────────────────────────────────────────────────────────

export async function getFavorites(userId) {
  const response = await fetch(`${BASE_URL}/food/favorites/${userId}`)
  if (!response.ok) throw new Error('שגיאה בטעינת מועדפים')
  return response.json()
}

export async function addFavorite(userId, mealData) {
  const response = await fetch(`${BASE_URL}/food/favorites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: Number(userId), ...mealData }),
  })
  if (!response.ok) throw new Error('שגיאה בהוספה למועדפים')
  return response.json()
}

export async function removeFavorite(favoriteId) {
  const response = await fetch(`${BASE_URL}/food/favorites/${favoriteId}`, { method: 'DELETE' })
  if (!response.ok) throw new Error('שגיאה בהסרה ממועדפים')
}

export async function addFavoriteGroup(userId, groupName, components) {
  const response = await fetch(`${BASE_URL}/food/favorites/group`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: Number(userId), group_name: groupName, components }),
  })
  if (!response.ok) throw new Error('שגיאה בשמירת ארוחה מורכבת למועדפים')
  return response.json()
}

export async function removeFavoriteGroup(favGroupId) {
  const response = await fetch(`${BASE_URL}/food/favorites/group/${favGroupId}`, { method: 'DELETE' })
  if (!response.ok) throw new Error('שגיאה בהסרת ארוחה מורכבת ממועדפים')
}

export async function deleteUserAccount(userId) {
  const response = await fetch(`${BASE_URL}/user/${userId}`, { method: 'DELETE' })
  if (!response.ok) throw new Error('שגיאה במחיקת החשבון')
}

