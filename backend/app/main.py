"""
CAL.IO - Backend API
נקודת הכניסה הראשית של השרת.

איך מריצים:
    cd backend
    pip install -r requirements.txt
    uvicorn app.main:app --reload

אחרי ההרצה, תיעוד אינטראקטיבי אוטומטי זמין ב:
    http://localhost:8000/docs
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import os

# טוען משתני סביבה מקובץ myapi.env (שם לא סטנדרטי - חייבים לציין במפורש)
load_dotenv(os.path.join(os.path.dirname(__file__), "..", "myapi.env"))

from .database import Base, engine
from .routers import profile, food, users
from sqlalchemy import text

# יוצר את טבלאות ה-DB אם הן עוד לא קיימות
Base.metadata.create_all(bind=engine)

# מיגרציה: הוספת עמודות חדשות לטבלאות קיימות (SQLite לא תומך ב-ALTER TABLE ADD IF NOT EXISTS)
with engine.connect() as _conn:
    for _stmt in [
        "ALTER TABLE food_logs ADD COLUMN meal_group_id VARCHAR",
    ]:
        try:
            _conn.execute(text(_stmt))
            _conn.commit()
        except Exception:
            pass  # העמודה כבר קיימת

app = FastAPI(
    title="CAL.IO API",
    description="מערכת למעקב אחר מאזן תזונתי - קלוריות, חלבון ושומן",
    version="0.2.0",
)

# CORS: בפיתוח - כל localhost. בפרודקשן - להגדיר CORS_ORIGINS ב-env (מופרד בפסיקים).
# דוגמה: CORS_ORIGINS=https://calio.vercel.app,https://calio.example.com
_cors_origins_env = os.getenv("CORS_ORIGINS", "").strip()
_allowed_origins = [o.strip() for o in _cors_origins_env.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_origin_regex=None if _allowed_origins else r"http://localhost:\d+|http://127\.0\.0\.1:\d+",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(users.router)
app.include_router(profile.router)
app.include_router(food.router)


@app.get("/")
def root():
    return {"message": "CAL.IO API is running"}
