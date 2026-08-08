"""
סכמות Pydantic - מגדירות איך נראה כל בקשה ותשובה ב-API.
"""
from pydantic import BaseModel, EmailStr, Field
from datetime import datetime, date
from typing import Optional, List


# ---------- משתמש (device-based) ----------
class DeviceUserOut(BaseModel):
    id: int
    device_id: Optional[str] = None

    class Config:
        from_attributes = True


# ---------- משתמש רגיל ----------
class UserCreate(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: int
    email: EmailStr

    class Config:
        from_attributes = True


# ---------- פרופיל פיזיולוגי ----------
class ProfileCreate(BaseModel):
    weight_kg: float
    height_cm: float
    age: int
    sex: str  # "male" | "female"
    activity_level: str = "moderate"
    goal: str = "maintain"  # "lose" | "maintain" | "gain"


class ProfileResult(BaseModel):
    """התוצאה שמוחזרת למשתמש אחרי חישוב BMR/TDEE/מאקרו."""
    bmr: float
    tdee: float
    bmi: float
    target_calories: float
    target_protein_g: float
    target_fat_g: float
    target_carbs_g: float


class ProfileSave(BaseModel):
    """שמירת פרופיל מלא (קלט + תוצאות) לDB."""
    user_id: int
    weight_kg: float
    height_cm: float
    age: int
    sex: str
    activity_level: str = "moderate"
    goal: str = "maintain"
    bmr: float
    tdee: float
    bmi: float
    target_calories: float
    target_protein_g: float
    target_fat_g: float
    target_carbs_g: float


class ProfileOut(BaseModel):
    """פרופיל שנטען מה-DB."""
    weight_kg: float
    height_cm: float
    age: int
    sex: str
    activity_level: str
    goal: str
    bmr: Optional[float] = None
    tdee: Optional[float] = None
    bmi: Optional[float] = None
    target_calories: Optional[float] = None
    target_protein_g: Optional[float] = None
    target_fat_g: Optional[float] = None
    target_carbs_g: Optional[float] = None

    class Config:
        from_attributes = True


# ---------- רישום מזון ----------
class FoodLogManual(BaseModel):
    """כשהמשתמש מזין ידנית קלוריות/חלבון/שומן."""
    food_name: str
    quantity_grams: float
    calories: float
    protein_g: float
    fat_g: float
    carbs_g: float = 0


class FoodLookupRequest(BaseModel):
    food_name: str
    quantity_grams: float


class FoodDescribeRequest(BaseModel):
    description: str


class ChatMessage(BaseModel):
    role: str
    content: str


class FoodChatRequest(BaseModel):
    message: str
    history: List[ChatMessage] = Field(default_factory=list)


class FoodChatResponse(BaseModel):
    reply: str
    meal: Optional[FoodLogManual] = None
    components: Optional[List[FoodLogManual]] = None


class FoodLogCreate(BaseModel):
    """שמירת מנה לDB עם user_id."""
    user_id: int
    food_name: str
    quantity_grams: float
    calories: float
    protein_g: float
    fat_g: float
    carbs_g: float = 0
    source: str = "manual"
    meal_group_id: Optional[str] = None


class FoodLogBatch(BaseModel):
    """רישום מנה מרוכבת עם מרכיבים מרובים."""
    user_id: int
    meal_group_id: str
    source: str = "ai"
    components: List[FoodLogManual]

class FoodLogUpdate(BaseModel):
    """עדכון ידני של ערכי מנה קיימת."""
    food_name: str
    quantity_grams: float
    calories: float
    protein_g: float
    fat_g: float
    carbs_g: float = 0


class FoodLogOut(BaseModel):
    id: int
    food_name: str
    quantity_grams: float
    calories: float
    protein_g: float
    fat_g: float
    carbs_g: float
    source: str
    logged_at: datetime
    log_date: Optional[date] = None
    meal_group_id: Optional[str] = None

    class Config:
        from_attributes = True


# ---------- מועדפים ----------
class FavoriteMealCreate(BaseModel):
    user_id: int
    food_name: str
    quantity_grams: float
    calories: float
    protein_g: float
    fat_g: float
    carbs_g: float = 0
    source: str = "manual"


class FavoriteMealOut(BaseModel):
    id: int
    food_name: str
    quantity_grams: float
    calories: float
    protein_g: float
    fat_g: float
    carbs_g: float
    source: str

    class Config:
        from_attributes = True


# ---------- סיכום יומי/שבועי ----------
class DaySummary(BaseModel):
    log_date: str
    calories: float
    protein_g: float
    fat_g: float
    carbs_g: float
    entries: int
    items: List[FoodLogOut] = []
