"""
Endpoints הקשורים לפרופיל הפיזיולוגי של המשתמש.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from datetime import date
from ..schemas import ProfileCreate, ProfileResult, ProfileSave, ProfileOut
from ..schemas import DailyWeightUpsert, DailyWeightOut
from ..models import UserProfile, DailyWeight
from ..database import get_db
from .. import calculations

router = APIRouter(prefix="/profile", tags=["profile"])


@router.post("/calculate", response_model=ProfileResult)
def calculate_profile(profile: ProfileCreate):
    """
    מחשב BMR, TDEE, BMI ויעדי מאקרו - מחזיר תוצאה בלי לשמור לDB.
    לשמירה בDB קרא גם ל-POST /profile/save.
    """
    try:
        result = calculations.calculate_full_profile(
            weight_kg=profile.weight_kg,
            height_cm=profile.height_cm,
            age=profile.age,
            sex=profile.sex,
            activity_level=profile.activity_level,
            goal=profile.goal,
            target_weight_kg=profile.target_weight_kg,
            weekly_weight_change_kg=profile.weekly_weight_change_kg,
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/save")
def save_profile(data: ProfileSave, db: Session = Depends(get_db)):
    """שומר/מעדכן פרופיל מלא (קלט + יעדים מחושבים) לDB."""
    try:
        calculations.validate_target_weight_for_goal(data.weight_kg, data.goal, data.target_weight_kg)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    profile = db.query(UserProfile).filter(UserProfile.user_id == data.user_id).first()
    fields = [
        "weight_kg", "height_cm", "age", "sex", "activity_level", "goal",
        "target_weight_kg", "weekly_weight_change_kg",
        "bmr", "tdee", "bmi", "target_calories", "target_protein_g",
        "target_fat_g", "target_carbs_g",
    ]
    if profile:
        for f in fields:
            setattr(profile, f, getattr(data, f))
    else:
        profile = UserProfile(**{f: getattr(data, f) for f in fields}, user_id=data.user_id)
        db.add(profile)
    db.commit()
    return {"status": "saved"}


@router.post("/daily-weight", response_model=DailyWeightOut)
def upsert_daily_weight(payload: DailyWeightUpsert, db: Session = Depends(get_db)):
    """שומר או מעדכן משקל יומי עבור המשתמש בתאריך המבוקש."""
    target_date = payload.log_date or date.today()

    record = (
        db.query(DailyWeight)
        .filter(DailyWeight.user_id == payload.user_id, DailyWeight.log_date == target_date)
        .first()
    )

    if record:
        record.weight_kg = payload.weight_kg
    else:
        record = DailyWeight(
            user_id=payload.user_id,
            weight_kg=payload.weight_kg,
            log_date=target_date,
        )
        db.add(record)

    db.commit()
    db.refresh(record)
    return record


@router.get("/{user_id}", response_model=ProfileOut)
def get_profile(user_id: int, db: Session = Depends(get_db)):
    """מחזיר פרופיל שמור מה-DB לפי user_id."""
    profile = db.query(UserProfile).filter(UserProfile.user_id == user_id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="פרופיל לא נמצא")
    return profile

