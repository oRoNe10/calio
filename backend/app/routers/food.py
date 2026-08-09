"""
Endpoints לרישום מזון - חיפוש, שמירה לDB, מועדפים, יומן יומי/שבועי.
"""
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File
from sqlalchemy.orm import Session
from datetime import date, timedelta
from ..schemas import (
    FoodDescribeRequest, FoodLookupRequest,
    FoodLogCreate, FoodLogUpdate, FoodLogBatch, FoodLogOut, FavoriteMealCreate, FavoriteMealOut,
    FoodChatRequest, FoodChatResponse, FavoriteGroupCreate,
)
from ..models import FoodLog, FavoriteMeal
from ..database import get_db
from ..services import ai_estimate

router = APIRouter(prefix="/food", tags=["food"])


# ── הערכה תזונתית (ללא שמירה) ──────────────────────────────────────────────

@router.post("/lookup")
async def lookup_food(request: FoodLookupRequest):
    """קלט: שם מזון + משקל. מחזיר הערכה תזונתית (לא שומר לDB)."""
    try:
        return await ai_estimate.estimate_food(request.food_name, request.quantity_grams)
    except EnvironmentError:
        raise HTTPException(status_code=503, detail="לא הוגדר GEMINI_API_KEY.")
    except Exception as exc:
        err = str(exc)
        if "RESOURCE_EXHAUSTED" in err or "quota" in err.lower():
            raise HTTPException(status_code=503, detail="חסומה מכסה ב-Gemini API.")
        raise HTTPException(status_code=502, detail=f"לא הצלחנו לאמוד את '{request.food_name}'.")


@router.post("/describe")
async def describe_food(request: FoodDescribeRequest):
    """קלט חופשי כמו 'קוביית שוקולד'. מחזיר הערכה (לא שומר לDB)."""
    try:
        return await ai_estimate.estimate_food_from_description(request.description)
    except EnvironmentError:
        raise HTTPException(status_code=503, detail="לא הוגדר GEMINI_API_KEY.")
    except Exception as exc:
        err = str(exc)
        if "RESOURCE_EXHAUSTED" in err or "quota" in err.lower():
            raise HTTPException(status_code=503, detail="חסומה מכסה ב-Gemini API.")
        raise HTTPException(status_code=502, detail=f"לא הצלחנו להעריך את '{request.description}'.")


@router.post("/chat", response_model=FoodChatResponse)
async def chat_food(request: FoodChatRequest):
    """צ'אט תזונתי חכם: מחזיר תשובת AI + אופציה להוספת מנה ליומן."""
    try:
        history = [msg.model_dump() for msg in request.history]
        return await ai_estimate.chat_with_nutrition_assistant(request.message, history)
    except EnvironmentError:
        raise HTTPException(status_code=503, detail="לא הוגדר GEMINI_API_KEY.")
    except Exception as exc:
        err = str(exc)
        if "RESOURCE_EXHAUSTED" in err or "quota" in err.lower():
            raise HTTPException(status_code=503, detail="חסומה מכסה ב-Gemini API.")
        raise HTTPException(status_code=502, detail="לא הצלחנו לקבל תשובה מהעוזר התזונתי.")


@router.post("/identify-image")
async def identify_image(file: UploadFile = File(...)):
    """מקבל תמונה של מאכל ומחזיר זיהוי + הערכה תזונתית (ללא שמירה לDB)."""
    allowed_types = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}
    mime_type = file.content_type or "image/jpeg"
    if mime_type not in allowed_types:
        raise HTTPException(status_code=415, detail="סוג קובץ לא נתמך. יש להעלות תמונה (JPEG/PNG/WEBP).")

    image_bytes = await file.read()
    if len(image_bytes) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="התמונה גדולה מדי (מקסימום 10MB).")

    try:
        return await ai_estimate.estimate_food_from_image(image_bytes, mime_type)
    except EnvironmentError:
        raise HTTPException(status_code=503, detail="לא הוגדר GEMINI_API_KEY.")
    except Exception as exc:
        err = str(exc)
        if "RESOURCE_EXHAUSTED" in err or "quota" in err.lower():
            raise HTTPException(status_code=503, detail="חסומה מכסה ב-Gemini API.")
        raise HTTPException(status_code=502, detail="לא הצלחנו לזהות את המאכל בתמונה.")


# ── שמירה לDB ────────────────────────────────────────────────────────────────

@router.post("/log", response_model=FoodLogOut)
def log_food(entry: FoodLogCreate, db: Session = Depends(get_db)):
    """שומר מנה לDB תחת המשתמש הנתון. log_date מוגדר לתאריך היום."""
    record = FoodLog(
        user_id=entry.user_id,
        food_name=entry.food_name,
        quantity_grams=entry.quantity_grams,
        calories=entry.calories,
        protein_g=entry.protein_g,
        fat_g=entry.fat_g,
        carbs_g=entry.carbs_g,
        source=entry.source,
        meal_group_id=entry.meal_group_id,
        log_date=date.today(),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


@router.post("/log/batch", response_model=list[FoodLogOut])
def log_food_batch(batch: FoodLogBatch, db: Session = Depends(get_db)):
    """שומר מנה מרוכבת (כמה מרכיבים) לDB עם אותו meal_group_id."""
    records = []
    for comp in batch.components:
        record = FoodLog(
            user_id=batch.user_id,
            food_name=comp.food_name,
            quantity_grams=comp.quantity_grams,
            calories=comp.calories,
            protein_g=comp.protein_g,
            fat_g=comp.fat_g,
            carbs_g=comp.carbs_g,
            source=batch.source,
            meal_group_id=batch.meal_group_id,
            log_date=date.today(),
        )
        db.add(record)
        records.append(record)
    db.commit()
    for r in records:
        db.refresh(r)
    return records


@router.put("/log/{log_id}", response_model=FoodLogOut)
def update_log(log_id: int, data: FoodLogUpdate, db: Session = Depends(get_db)):
    """מעדכן ערכים של מנה קיימת ביומן."""
    record = db.query(FoodLog).filter(FoodLog.id == log_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="רשומה לא נמצאה")
    record.food_name = data.food_name
    record.quantity_grams = data.quantity_grams
    record.calories = data.calories
    record.protein_g = data.protein_g
    record.fat_g = data.fat_g
    record.carbs_g = data.carbs_g
    db.commit()
    db.refresh(record)
    return record


@router.delete("/log/{log_id}")
def delete_log(log_id: int, db: Session = Depends(get_db)):
    """מוחק רשומת מזון מהיומן."""
    record = db.query(FoodLog).filter(FoodLog.id == log_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="רשומה לא נמצאה")
    db.delete(record)
    db.commit()
    return {"status": "deleted"}


# ── יומן יומי ─────────────────────────────────────────────────────────────────

@router.get("/today/{user_id}")
def get_today_log(user_id: int, db: Session = Depends(get_db)):
    """מחזיר את כל המנות שנרשמו היום עבור המשתמש."""
    today = date.today()
    items = (
        db.query(FoodLog)
        .filter(FoodLog.user_id == user_id, FoodLog.log_date == today)
        .order_by(FoodLog.logged_at)
        .all()
    )
    return items


# ── יומן שבועי ────────────────────────────────────────────────────────────────

@router.get("/week/{user_id}")
def get_week_log(user_id: int, db: Session = Depends(get_db)):
    """
    מחזיר סיכום ל-7 הימים האחרונים (כולל היום).
    האיפוס הקלורי מתבצע אוטומטית - כל יום מסונן לפי log_date.
    """
    today = date.today()
    week_start = today - timedelta(days=6)

    items = (
        db.query(FoodLog)
        .filter(FoodLog.user_id == user_id, FoodLog.log_date >= week_start)
        .order_by(FoodLog.log_date, FoodLog.logged_at)
        .all()
    )

    # קיבוץ לפי תאריך
    by_date: dict[date, list] = {}
    for d in range(7):
        day = week_start + timedelta(days=d)
        by_date[day] = []
    for item in items:
        by_date[item.log_date].append(item)

    result = []
    for day, day_items in by_date.items():
        result.append({
            "log_date": day.isoformat(),
            "calories": sum(i.calories for i in day_items),
            "protein_g": sum(i.protein_g for i in day_items),
            "fat_g": sum(i.fat_g for i in day_items),
            "carbs_g": sum(i.carbs_g for i in day_items),
            "entries": len(day_items),
            "items": day_items,
        })
    return result


# ── מועדפים ───────────────────────────────────────────────────────────────────

@router.get("/favorites/{user_id}", response_model=list[FavoriteMealOut])
def get_favorites(user_id: int, db: Session = Depends(get_db)):
    """מחזיר את רשימת המנות האהובות של המשתמש."""
    return db.query(FavoriteMeal).filter(FavoriteMeal.user_id == user_id).all()


@router.post("/favorites", response_model=FavoriteMealOut)
def add_favorite(entry: FavoriteMealCreate, db: Session = Depends(get_db)):
    """מוסיף מנה לרשימת המועדפים."""
    # מניעת כפילויות לפי שם + כמות
    existing = (
        db.query(FavoriteMeal)
        .filter(
            FavoriteMeal.user_id == entry.user_id,
            FavoriteMeal.food_name == entry.food_name,
            FavoriteMeal.quantity_grams == entry.quantity_grams,
        )
        .first()
    )
    if existing:
        return existing
    fav = FavoriteMeal(**entry.model_dump())
    db.add(fav)
    db.commit()
    db.refresh(fav)
    return fav


@router.delete("/favorites/{favorite_id}")
def remove_favorite(favorite_id: int, db: Session = Depends(get_db)):
    """מסיר מנה מהמועדפים."""
    fav = db.query(FavoriteMeal).filter(FavoriteMeal.id == favorite_id).first()
    if not fav:
        raise HTTPException(status_code=404, detail="מועדף לא נמצא")
    db.delete(fav)
    db.commit()
    return {"status": "removed"}


@router.post("/favorites/group", response_model=list[FavoriteMealOut])
def add_favorite_group(entry: FavoriteGroupCreate, db: Session = Depends(get_db)):
    """שומר ארוחה מרוכבת כמועדף — כל מרכיב נשמר עם favorite_group_id משותף."""
    import uuid
    group_id = str(uuid.uuid4())
    saved = []
    for comp in entry.components:
        fav = FavoriteMeal(
            user_id=entry.user_id,
            food_name=comp.food_name,
            quantity_grams=comp.quantity_grams,
            calories=comp.calories,
            protein_g=comp.protein_g,
            fat_g=comp.fat_g,
            carbs_g=comp.carbs_g,
            source="ai",
            favorite_group_id=group_id,
            group_name=entry.group_name,
        )
        db.add(fav)
        saved.append(fav)
    db.commit()
    for fav in saved:
        db.refresh(fav)
    return saved


@router.delete("/favorites/group/{fav_group_id}")
def remove_favorite_group(fav_group_id: str, db: Session = Depends(get_db)):
    """מסיר את כל מרכיבי ארוחה מרוכבת מהמועדפים לפי favorite_group_id."""
    rows = db.query(FavoriteMeal).filter(FavoriteMeal.favorite_group_id == fav_group_id).all()
    for row in rows:
        db.delete(row)
    db.commit()
    return {"status": "removed", "count": len(rows)}

