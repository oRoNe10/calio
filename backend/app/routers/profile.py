"""
Endpoints הקשורים לפרופיל הפיזיולוגי של המשתמש.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..schemas import ProfileCreate, ProfileResult, ProfileSave, ProfileOut
from ..models import UserProfile
from ..database import get_db
from .. import calculations

router = APIRouter(prefix="/profile", tags=["profile"])


@router.post("/calculate", response_model=ProfileResult)
def calculate_profile(profile: ProfileCreate):
    """
    מחשב BMR, TDEE, BMI ויעדי מאקרו - מחזיר תוצאה בלי לשמור לDB.
    לשמירה בDB קרא גם ל-POST /profile/save.
    """
    result = calculations.calculate_full_profile(
        weight_kg=profile.weight_kg,
        height_cm=profile.height_cm,
        age=profile.age,
        sex=profile.sex,
        activity_level=profile.activity_level,
        goal=profile.goal,
    )
    return result


@router.post("/save")
def save_profile(data: ProfileSave, db: Session = Depends(get_db)):
    """שומר/מעדכן פרופיל מלא (קלט + יעדים מחושבים) לDB."""
    profile = db.query(UserProfile).filter(UserProfile.user_id == data.user_id).first()
    fields = [
        "weight_kg", "height_cm", "age", "sex", "activity_level", "goal",
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


@router.get("/{user_id}", response_model=ProfileOut)
def get_profile(user_id: int, db: Session = Depends(get_db)):
    """מחזיר פרופיל שמור מה-DB לפי user_id."""
    profile = db.query(UserProfile).filter(UserProfile.user_id == user_id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="פרופיל לא נמצא")
    return profile

