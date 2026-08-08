"""
זהו "הראש" של CAL.IO - המקום שבו המערכת הופכת שם מזון + כמות בגרמים
לערכים תזונתיים מדויקים.

זרימת העבודה:
1. המשתמש מקליד "חזה עוף מבושל" + 40 גרם
2. אנחנו שולחים חיפוש ל-Open Food Facts
3. לוקחים את התוצאה הכי רלוונטית (100 גרם כברירת מחדל אצלם)
4. מחשבים יחסית לכמות שהמשתמש הזין

Copilot Tip: כרגע זה קורא ל-API בכל בקשה. בהמשך כדאי להוסיף cache
(למשל טבלת FoodCache ב-DB) כדי לא לשלוח בקשה חוזרת לאותו מזון.
"""
import httpx

BASE_URL = "https://world.openfoodfacts.org/cgi/search.pl"
HEADERS = {"User-Agent": "CAL.IO - Calorie Tracking App - Version 0.1"}


async def search_food(food_name: str) -> dict | None:
    """
    מחפש מזון לפי שם חופשי ומחזיר את התוצאה הראשונה עם נתונים תזונתיים תקינים.
    מחזיר None אם לא נמצא כלום מתאים.
    """
    params = {
        "search_terms": food_name,
        "search_simple": 1,
        "action": "process",
        "json": 1,
        "page_size": 5,
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(BASE_URL, params=params, headers=HEADERS)
        response.raise_for_status()
        data = response.json()

    products = data.get("products", [])

    for product in products:
        nutriments = product.get("nutriments", {})
        # מוודאים שיש לפחות ערך קלוריות - אחרת הרשומה לא שימושית
        if "energy-kcal_100g" in nutriments:
            return {
                "name": product.get("product_name", food_name),
                "calories_per_100g": nutriments.get("energy-kcal_100g", 0),
                "protein_per_100g": nutriments.get("proteins_100g", 0),
                "fat_per_100g": nutriments.get("fat_100g", 0),
                "carbs_per_100g": nutriments.get("carbohydrates_100g", 0),
            }

    return None


def calculate_for_quantity(food_data: dict, quantity_grams: float) -> dict:
    """ממיר ערכים ל-100 גרם לערכים לפי הכמות שהמשתמש בפועל אכל."""
    factor = quantity_grams / 100
    return {
        "food_name": food_data["name"],
        "quantity_grams": quantity_grams,
        "calories": round(food_data["calories_per_100g"] * factor, 1),
        "protein_g": round(food_data["protein_per_100g"] * factor, 1),
        "fat_g": round(food_data["fat_per_100g"] * factor, 1),
        "carbs_g": round(food_data["carbs_per_100g"] * factor, 1),
    }
