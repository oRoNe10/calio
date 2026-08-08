"""
ניהול משתמשים על-בסיס device_id - ללא צורך בהרשמה/סיסמה.
כל מכשיר מקבל UUID ייחודי ב-localStorage ומזוהה דרכו.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..database import get_db
from ..models import User, UserProfile, FoodLog, FavoriteMeal
from ..schemas import DeviceUserOut

router = APIRouter(prefix="/user", tags=["user"])


@router.get("/device/{device_id}", response_model=DeviceUserOut)
def get_or_create_device_user(device_id: str, db: Session = Depends(get_db)):
    """
    מחזיר משתמש קיים לפי device_id, או יוצר חדש אם לא קיים.
    הפרונטאנד שומר את ה-device_id ב-localStorage וקורא לנקודה זו בטעינה.
    """
    user = db.query(User).filter(User.device_id == device_id).first()
    if not user:
        user = User(
            device_id=device_id,
            email=f"device_{device_id}@calio.local",
            hashed_password="",
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


@router.delete("/{user_id}", status_code=204)
def delete_user_account(user_id: int, db: Session = Depends(get_db)):
    """מוחק את המשתמש וכל הנתונים שלו (פרופיל, יומן, מועדפים)."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="משתמש לא נמצא")
    db.query(FoodLog).filter(FoodLog.user_id == user_id).delete()
    db.query(FavoriteMeal).filter(FavoriteMeal.user_id == user_id).delete()
    db.query(UserProfile).filter(UserProfile.user_id == user_id).delete()
    db.delete(user)
    db.commit()
