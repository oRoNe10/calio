"""
טבלאות מסד הנתונים.
"""
from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, Date
from sqlalchemy.orm import relationship
from datetime import datetime, date, timezone
from .database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    device_id = Column(String, unique=True, index=True, nullable=True)
    created_at = Column(DateTime, default=_utcnow)

    profile = relationship("UserProfile", back_populates="user", uselist=False)
    food_logs = relationship("FoodLog", back_populates="user")
    favorites = relationship("FavoriteMeal", back_populates="user")


class UserProfile(Base):
    """נתונים פיזיולוגיים + יעדים מחושבים - נשמרים ב-DB כדי לא לבקש שוב."""
    __tablename__ = "user_profiles"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), unique=True)

    weight_kg = Column(Float, nullable=False)
    height_cm = Column(Float, nullable=False)
    age = Column(Integer, nullable=False)
    sex = Column(String, nullable=False)
    activity_level = Column(String, default="moderate")
    goal = Column(String, default="maintain")

    # יעדים מחושבים - נשמרים כדי לטעון מהר בלי לחשב מחדש
    bmr = Column(Float, nullable=True)
    tdee = Column(Float, nullable=True)
    bmi = Column(Float, nullable=True)
    target_calories = Column(Float, nullable=True)
    target_protein_g = Column(Float, nullable=True)
    target_fat_g = Column(Float, nullable=True)
    target_carbs_g = Column(Float, nullable=True)

    user = relationship("User", back_populates="profile")


class FoodLog(Base):
    """רשומה של פריט מזון שהמשתמש אכל. log_date מאפשר סינון לפי יום."""
    __tablename__ = "food_logs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))

    food_name = Column(String, nullable=False)
    quantity_grams = Column(Float, nullable=False)

    calories = Column(Float, nullable=False)
    protein_g = Column(Float, nullable=False)
    fat_g = Column(Float, nullable=False)
    carbs_g = Column(Float, default=0)

    source = Column(String, default="manual")
    logged_at = Column(DateTime, default=_utcnow)
    log_date = Column(Date, default=date.today)  # לסינון יומי - האיפוס ב-12 בלילה אוטומטי
    meal_group_id = Column(String, nullable=True, index=True)  # מקשר מרכיבים של אותה ארוחה

    user = relationship("User", back_populates="food_logs")


class FavoriteMeal(Base):
    """מנה אהובה - מסומנת בכוכב ע"י המשתמש, נשמרת לשימוש חוזר מהיר."""
    __tablename__ = "favorite_meals"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))

    food_name = Column(String, nullable=False)
    quantity_grams = Column(Float, nullable=False)
    calories = Column(Float, nullable=False)
    protein_g = Column(Float, nullable=False)
    fat_g = Column(Float, nullable=False)
    carbs_g = Column(Float, default=0)
    source = Column(String, default="manual")
    created_at = Column(DateTime, default=_utcnow)

    user = relationship("User", back_populates="favorites")
