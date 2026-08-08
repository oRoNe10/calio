# CAL.IO 🥗

מערכת PWA (אפליקציית ווב מתקדמת) למעקב אחר מאזן תזונתי - קלוריות, חלבון ושומן.
המערכת מחשבת עבור המשתמש BMR, BMI, TDEE ויעדים יומיים, ומאפשרת רישום מזון
בצורה חכמה - כותבים "40 גרם חזה עוף" והמערכת מחשבת לבד את הערכים התזונתיים.

## למה PWA ולא אפליקציה רגילה?

PWA = Progressive Web App. המשתמש "מתקין" את CAL.IO ישירות מהדפדפן
(כפתור "הוסף למסך הבית"), בלי חנות אפליקציות בכלל. זה בדיוק מה שביקשת.

## מבנה הפרויקט

```
calio/
├── backend/              # שרת Python (FastAPI)
│   └── app/
│       ├── main.py           # נקודת הכניסה
│       ├── database.py       # חיבור ל-DB
│       ├── models.py         # טבלאות (User, UserProfile, FoodLog)
│       ├── schemas.py        # מבני קלט/פלט ל-API
│       ├── calculations.py   # נוסחאות BMR/BMI/TDEE/מאקרו
│       ├── routers/          # ה-endpoints של ה-API
│       │   ├── profile.py    # חישוב פרופיל פיזיולוגי
│       │   └── food.py       # רישום מזון (ידני + חכם)
│       └── services/
│           └── openfoodfacts.py   # תקשורת עם מאגר המזון החיצוני
│
└── frontend/             # אתר React (PWA)
    └── src/
        ├── App.jsx            # ניתוב בין עמודים
        ├── pages/
        │   ├── Onboarding.jsx # הזנת נתונים פיזיולוגיים ראשונית
        │   └── Dashboard.jsx  # המסך הראשי - הזנת מזון
        └── services/
            └── api.js         # קריאות לשרת ה-Backend
```

## איך מריצים את הפרויקט

### שלב 1: פתיחה ב-VSCode
פתח את תיקיית `calio` כתיקיית עבודה ב-VSCode. ודא ש-GitHub Copilot מותקן ופעיל
(אייקון בפינה למטה, או Extensions -> GitHub Copilot).

### שלב 2: הרצת ה-Backend
```bash
cd backend
python -m venv venv               # יצירת סביבה וירטואלית (פעם אחת)
source venv/bin/activate          # ב-Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```
השרת ירוץ ב- http://localhost:8000
תיעוד אינטראקטיבי (אפשר לבדוק endpoints ישירות מהדפדפן) ב- http://localhost:8000/docs

### שלב 3: הרצת ה-Frontend
בטרמינל חדש (השאר את ה-Backend רץ):
```bash
cd frontend
npm install
npm run dev
```
האתר ירוץ ב- http://localhost:5173

## איך לעבוד עם Copilot על הפרויקט הזה

בכל קובץ יש הערות `TODO (Copilot):` שמסמנות בדיוק מה חסר ומה השלב הבא.
דרך עבודה מומלצת:
1. פתח את הקובץ הרלוונטי
2. סמן את שורת ה-TODO, פתח את Copilot Chat (Ctrl+Shift+I / Cmd+Shift+I)
3. תכתוב לו בדיוק מה אתה רוצה, למשל: "תממש את שמירת הפרופיל בטבלת UserProfile"
4. תבדוק את הקוד שהוא מציע לפני שאתה מקבל אותו

## מה כבר עובד בשלד הזה

✅ חישוב BMR / BMI / TDEE / יעדי מאקרו (כבר ממומש ועובד, `calculations.py`)
✅ חיפוש מזון ב-Open Food Facts + חישוב יחסי לכמות (`services/openfoodfacts.py`)
✅ מבנה טבלאות DB בסיסי (`models.py`)
✅ שני מסכים בסיסיים ב-Frontend (Onboarding + Dashboard)

## מה עוד חסר (השלבים הבאים שלך)

- [ ] מערכת הרשמה/התחברות (authentication) - יש כבר שדה `hashed_password` במודל אבל אין endpoints
- [ ] שמירת הפרופיל וההיסטוריה בפועל ב-DB (כרגע ה-endpoints מחזירים תוצאה בלי לשמור)
- [ ] תצוגת "כמה נשאר לי היום" (יעד מול בפועל) ב-Dashboard
- [ ] cache למזונות שכבר חוזרים ב-Open Food Facts, כדי לא לפנות ל-API בכל פעם
- [ ] עיצוב (כרגע ה-CSS מינימלי בכוונה - זה שלד טכני)
- [ ] אייקונים אמיתיים ל-PWA (`icon-192.png`, `icon-512.png`) בתיקיית `frontend/public`

## טכנולוגיות בפרויקט

| רכיב | טכנולוגיה |
|---|---|
| Backend | Python + FastAPI |
| Database | SQLite (בפיתוח) → PostgreSQL (בפרודקשן) |
| Frontend | React + Vite (כ-PWA) |
| מאגר מזון | Open Food Facts API (חינמי, ללא צורך במפתח) |
