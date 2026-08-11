"""
כל הנוסחאות הפיזיולוגיות של CAL.IO במקום אחד.
Copilot Tip: אם תרצה נוסחת BMR אחרת (למשל Harris-Benedict), תוכל להוסיף
פונקציה נוספת כאן ולתת למשתמש לבחור בין השתיים.
"""

ACTIVITY_MULTIPLIERS = {
    "sedentary": 1.2,      # כמעט ללא פעילות גופנית
    "light": 1.375,        # אימון קל 1-3 פעמים בשבוע
    "moderate": 1.55,      # אימון בינוני 3-5 פעמים בשבוע
    "active": 1.725,       # אימון קשה 6-7 פעמים בשבוע
    "very_active": 1.9,    # אימון קשה מאוד + עבודה פיזית
}

GOAL_CALORIE_ADJUSTMENT = {
    "lose": -0.20,      # גירעון של 20% מה-TDEE
    "maintain": 0.0,
    "gain": 0.15,       # עודף של 15% מה-TDEE
}

CALORIES_PER_KG = 7700


def validate_target_weight_for_goal(
    weight_kg: float,
    goal: str,
    target_weight_kg: float | None,
) -> None:
    """מוודא שמשקל היעד תואם לכיוון המטרה, אם הוזן בכלל."""
    if target_weight_kg is None:
        return

    if goal == "gain" and target_weight_kg < weight_kg:
        raise ValueError("במטרת עלייה, משקל היעד לא יכול להיות קטן מהמשקל הנוכחי.")

    if goal == "lose" and target_weight_kg > weight_kg:
        raise ValueError("במטרת ירידה, משקל היעד לא יכול להיות גדול מהמשקל הנוכחי.")


def calculate_bmr(weight_kg: float, height_cm: float, age: int, sex: str) -> float:
    """
    נוסחת Mifflin-St Jeor - הנוסחה המדויקת והנפוצה ביותר כיום לחישוב BMR
    (קצב חילוף החומרים הבסיסי - כמה קלוריות הגוף שורף במנוחה מוחלטת).
    """
    base = 10 * weight_kg + 6.25 * height_cm - 5 * age
    if sex.lower() == "male":
        return base + 5
    return base - 161


def calculate_bmi(weight_kg: float, height_cm: float) -> float:
    """מדד מסת גוף - משקל(ק"ג) חלקי גובה בריבוע (במטרים)."""
    height_m = height_cm / 100
    return round(weight_kg / (height_m ** 2), 1)


def calculate_tdee(bmr: float, activity_level: str) -> float:
    """סה"כ הוצאה קלורית יומית = BMR כפול מקדם פעילות."""
    multiplier = ACTIVITY_MULTIPLIERS.get(activity_level, 1.55)
    return bmr * multiplier


def calculate_macros(target_calories: float, weight_kg: float) -> dict:
    """
    חלוקת היעד הקלורי היומי לחלבון/שומן/פחמימה.
    חלבון: 2 גרם לכל ק"ג משקל גוף (מומלץ למי שמתאמן ורוצה לשמר/לבנות שריר)
    שומן: 25% מסך הקלוריות
    פחמימה: כל השאר
    """
    protein_g = weight_kg * 2
    protein_cal = protein_g * 4

    fat_cal = target_calories * 0.25
    fat_g = fat_cal / 9

    carbs_cal = target_calories - protein_cal - fat_cal
    carbs_g = max(carbs_cal / 4, 0)

    return {
        "protein_g": round(protein_g, 1),
        "fat_g": round(fat_g, 1),
        "carbs_g": round(carbs_g, 1),
    }


def calculate_goal_based_calories(
    tdee: float,
    goal: str,
    weight_kg: float,
    target_weight_kg: float | None,
    weekly_weight_change_kg: float | None,
) -> float:
    """מחשב יעד קלורי לפי מטרה כללית או לפי יעד משקל+קצב שבועי אם סופקו."""
    has_target_weight = target_weight_kg is not None
    has_weekly_change = weekly_weight_change_kg is not None and weekly_weight_change_kg > 0

    if has_target_weight and has_weekly_change:
        remaining_change_kg = target_weight_kg - weight_kg
        if abs(remaining_change_kg) < 0.05:
            return tdee

        effective_weekly_change = min(abs(remaining_change_kg), weekly_weight_change_kg)
        daily_calorie_delta = (effective_weekly_change * CALORIES_PER_KG) / 7
        return tdee + (daily_calorie_delta if remaining_change_kg > 0 else -daily_calorie_delta)

    adjustment = GOAL_CALORIE_ADJUSTMENT.get(goal, 0.0)
    return tdee * (1 + adjustment)


def calculate_full_profile(weight_kg: float, height_cm: float, age: int,
                            sex: str, activity_level: str, goal: str,
                            target_weight_kg: float | None = None,
                            weekly_weight_change_kg: float | None = None) -> dict:
    """הפונקציה המרכזית - מקבלת נתונים פיזיולוגיים ומחזירה את כל היעדים היומיים."""
    validate_target_weight_for_goal(weight_kg, goal, target_weight_kg)

    bmr = calculate_bmr(weight_kg, height_cm, age, sex)
    bmi = calculate_bmi(weight_kg, height_cm)
    tdee = calculate_tdee(bmr, activity_level)

    target_calories = calculate_goal_based_calories(
        tdee=tdee,
        goal=goal,
        weight_kg=weight_kg,
        target_weight_kg=target_weight_kg,
        weekly_weight_change_kg=weekly_weight_change_kg,
    )

    macros = calculate_macros(target_calories, weight_kg)

    return {
        "bmr": round(bmr, 1),
        "tdee": round(tdee, 1),
        "bmi": bmi,
        "target_calories": round(target_calories, 1),
        "target_protein_g": macros["protein_g"],
        "target_fat_g": macros["fat_g"],
        "target_carbs_g": macros["carbs_g"],
    }
