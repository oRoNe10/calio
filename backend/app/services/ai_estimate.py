"""
שכבת ה-fallback החכמה: כשOpen Food Facts לא מוצא את המזון (בעיקר עם
מזונות ישראליים/עבריים או מנות מורכבות כמו "חזה עוף עם תבלין שווארמה"),
אנחנו פונים ל-Gemini ומבקשים ממנו להעריך בעצמו את הערכים התזונתיים.
"""
import os
import re
import json
from pathlib import Path
from google import genai

_client: genai.Client | None = None
DEFAULT_MODEL_CANDIDATES = [
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-pro-latest",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
]


def _read_key_from_env_file() -> str | None:
    env_path = Path(__file__).resolve().parents[2] / "myapi.env"
    if not env_path.exists():
        return None

    for raw_line in env_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() == "GEMINI_API_KEY":
            return value.strip().strip('"').strip("'")
    return None


def _get_client() -> genai.Client:
    global _client
    if _client is None:
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            api_key = _read_key_from_env_file()
        if not api_key:
            raise EnvironmentError("GEMINI_API_KEY is not set")
        _client = genai.Client(api_key=api_key)
    return _client


def _is_retryable_model_error(error_text: str) -> bool:
    text = error_text.lower()
    return (
        "resource_exhausted" in text
        or "quota" in text
        or "429" in text
        or "not found" in text
        or "unsupported" in text
    )

def _get_model_candidates() -> list[str]:
    from_env = os.getenv("GEMINI_MODEL_CANDIDATES", "").strip()
    if from_env:
        models = [m.strip() for m in from_env.split(",") if m.strip()]
        if models:
            # הסרת כפילויות תוך שמירה על סדר המודלים
            return list(dict.fromkeys(models))
    
    # החזרת עותק למניעת שינוי של רשימת ה-Default הגלובלית
    return list(DEFAULT_MODEL_CANDIDATES)


async def _generate_content_with_fallback(prompt: str) -> str:
    last_error: Exception | None = None

    for model_name in _get_model_candidates():
        try:
            response = await _get_client().aio.models.generate_content(
                model=model_name,
                contents=prompt,
            )
            return response.text
        except Exception as exc:
            last_error = exc
            if not _is_retryable_model_error(str(exc)):
                raise

    raise RuntimeError(
        f"No available Gemini model from candidates: {_get_model_candidates()}"
    ) from last_error

PROMPT_TEMPLATE = """\
אתה מומחה תזונה. ענה אך ורק ב-JSON תקני, ללא שום טקסט נוסף לפני או אחרי.

המשתמש אכל: "{food_name}", בכמות של {quantity_grams} גרם.

אם שם המזון מכיל שני מרכיבים שונים או יותר עם כמויות מפורשות (כגון "קורנפלקס 60 גרם עם קוטג' 80 גרם"),
חובה להחזיר JSON בפורמט הבא (התעלם מ-{quantity_grams} ובסס על הכמויות שמופיעות בשם):
{{
  "components": [
    {{"food_name": "שם מרכיב ראשון", "quantity_grams": X, "calories": X, "protein_g": X, "fat_g": X, "carbs_g": X}},
    {{"food_name": "שם מרכיב שני", "quantity_grams": X, "calories": X, "protein_g": X, "fat_g": X, "carbs_g": X}}
  ]
}}

אחרת (מרכיב יחיד), תן הערכה עבור הכמות הזו בדיוק (לא ל-100 גרם):
{{
  "food_name": "שם המזון כפי שנכתב",
  "calories": מספר,
  "protein_g": מספר,
  "fat_g": מספר,
  "carbs_g": מספר
}}

המספרים חייבים להיות חיוביים וריאליים.
"""

DESCRIPTION_PROMPT_TEMPLATE = """\
אתה מומחה תזונה. ענה אך ורק ב-JSON תקני, ללא שום טקסט נוסף לפני או אחרי.

הארוחה שהוכנסה: "{description}"

חוק מספר 1 - מנה עם מספר מרכיבים:
אם הארוחה מציינת שני מרכיבים שונים או יותר (שמות מזון שונים עם כמויות),
חובה להחזיר JSON בפורמט הבא:
{{
  "components": [
    {{"food_name": "שם מרכיב ראשון", "quantity_grams": X, "calories": X, "protein_g": X, "fat_g": X, "carbs_g": X}},
    {{"food_name": "שם מרכיב שני", "quantity_grams": X, "calories": X, "protein_g": X, "fat_g": X, "carbs_g": X}}
  ]
}}

דוגמה לקלט: "קורנפלקס 60 גרם עם קוטג' 80 גרם"
דוגמה לפלט:
{{
  "components": [
    {{"food_name": "קורנפלקס", "quantity_grams": 60, "calories": 226, "protein_g": 5, "fat_g": 1, "carbs_g": 49}},
    {{"food_name": "קוטג'", "quantity_grams": 80, "calories": 72, "protein_g": 9, "fat_g": 2, "carbs_g": 4}}
  ]
}}

חוק מספר 2 - מרכיב יחיד:
אם יש רק מרכיב אחד בלבד, החזר:
{{
  "food_name": "שם המאכל לאחר נרמול",
  "quantity_grams": X,
  "calories": X,
  "protein_g": X,
  "fat_g": X,
  "carbs_g": X
}}

כל המספרים חייבים להיות חיוביים וריאליים.
"""

CHAT_PROMPT_TEMPLATE = """\
אתה תזונאי דיגיטלי ידידותי. ענה בעברית קצרה וברורה בלבד.

היסטוריית שיחה (אופציונלית):
{history_text}

הודעת המשתמש החדשה:
"{message}"

החזר אך ורק JSON תקני בפורמט הבא:
{{
    "reply": "תשובה קצרה ומעשית למשתמש",
    "meal": {{"food_name": "...", "quantity_grams": X, "calories": X, "protein_g": X, "fat_g": X, "carbs_g": X}} או null,
    "components": [
        {{"food_name": "...", "quantity_grams": X, "calories": X, "protein_g": X, "fat_g": X, "carbs_g": X}}
    ] או null
}}

חוקים:
1) תמיד מלא "reply" בטקסט שימושי.
2) אם המשתמש תיאר מנה אחת ברורה - החזר אותה ב-meal.
3) אם המשתמש תיאר כמה רכיבים - החזר אותם ב-components.
4) אם אין מספיק מידע מספרי למנה - השאר meal/components בתור null.
5) כל הערכים המספריים חייבים להיות חיוביים וריאליים.
"""


def _parse_model_json(raw_text: str) -> dict:
    cleaned = raw_text.strip().replace("```json", "").replace("```", "").strip()
    return json.loads(cleaned)


# מזהה תבנית: "שם מאכל X גרם" (עברית ואנגלית)
_INGREDIENT_PATTERN = re.compile(
    r"([\u05d0-\u05ffa-zA-Z'][\u05d0-\u05ff\w' -]*?)\s+(\d+(?:\.\d+)?)\s*(?:גרם|ג'|gram|g)\b",
    re.IGNORECASE | re.UNICODE,
)
# מילות חיבור שצריך להסיר מתחילת ומסוף שמות מרכיבים
_CONNECTOR = re.compile(
    r"^[\s]*(עם|ו|and|with|plus|\+|,)\s*|\s*(עם|ו|and|with|plus|\+|,)\s*$",
    re.IGNORECASE | re.UNICODE,
)

def _extract_ingredients(text: str) -> list[tuple[str, float]] | None:
    """מחלץ מרכיבים עם כמויות מטקסט. מחזיר רשימה אם יש 2+ מרכיבים, אחרת None."""
    matches = _INGREDIENT_PATTERN.findall(text)
    cleaned = []
    for name, grams in matches:
        name = _CONNECTOR.sub("", name.strip()).strip()
        if name:
            cleaned.append((name, float(grams)))
    return cleaned if len(cleaned) >= 2 else None


IMAGE_PROMPT = """\
אתה מומחה תזונה. ענה אך ורק ב-JSON תקני, ללא שום טקסט נוסף לפני או אחרי.

זהה את המאכל/ים בתמונה ותן הערכה תזונתית ריאלית.

אם בתמונה יש שני מרכיבים שונים או יותר (לדוגמה: קערת דגנים עם חלב/קוטג', צלחת עם עוף ואורז, וכו'),
חובה להחזיר JSON בפורמט הבא:
{{
  "components": [
    {{"food_name": "שם מרכיב ראשון", "quantity_grams": X, "calories": X, "protein_g": X, "fat_g": X, "carbs_g": X}},
    {{"food_name": "שם מרכיב שני", "quantity_grams": X, "calories": X, "protein_g": X, "fat_g": X, "carbs_g": X}}
  ]
}}

אם יש רק מרכיב אחד בלבד, החזר:
{{
  "food_name": "שם המאכל",
  "quantity_grams": X,
  "calories": X,
  "protein_g": X,
  "fat_g": X,
  "carbs_g": X
}}

כל המספרים חייבים להיות חיוביים.
"""


async def estimate_food_from_image(image_bytes: bytes, mime_type: str) -> dict:
    """מקבל bytes של תמונה ומחזיר זיהוי + ערכים תזונתיים דרך Gemini Vision."""
    from google.genai import types as genai_types

    last_error: Exception | None = None
    for model_name in _get_model_candidates():
        try:
            response = await _get_client().aio.models.generate_content(
                model=model_name,
                contents=[
                    genai_types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
                    IMAGE_PROMPT,
                ],
            )
            data = _parse_model_json(response.text)
            break
        except Exception as exc:
            last_error = exc
            if not _is_retryable_model_error(str(exc)):
                raise
    else:
        raise RuntimeError(
            f"No available Gemini model from candidates: {_get_model_candidates()}"
        ) from last_error

    # תגובת מרכיבים מרובים
    if "components" in data:
        components = []
        for comp in data["components"]:
            components.append({
                "food_name": comp["food_name"],
                "quantity_grams": float(comp["quantity_grams"]),
                "calories": float(comp["calories"]),
                "protein_g": float(comp["protein_g"]),
                "fat_g": float(comp["fat_g"]),
                "carbs_g": float(comp.get("carbs_g", 0)),
                "source": "ai_image",
            })
        return {"components": components}

    required_fields = {"food_name", "quantity_grams", "calories", "protein_g", "fat_g", "carbs_g"}
    missing = required_fields - data.keys()
    if missing:
        raise ValueError(f"Gemini response missing fields: {missing}")

    data["quantity_grams"] = float(data["quantity_grams"])
    data["calories"] = float(data["calories"])
    data["protein_g"] = float(data["protein_g"])
    data["fat_g"] = float(data["fat_g"])
    data["carbs_g"] = float(data["carbs_g"])
    data["source"] = "ai_image"
    return data


async def estimate_food(food_name: str, quantity_grams: float) -> dict:
    """
    שולח בקשה ל-Gemini ומחזיר הערכה תזונתית עבור הכמות שצוינה.
    אם food_name מכיל מרכיבים מרובים עם כמויות, מחזיר {"components": [...]}.
    """
    # אם שם המזון מכיל מרכיבים מרובים, נחלץ אותם ישירות
    ingredients = _extract_ingredients(food_name)
    if ingredients:
        components = []
        for name, grams in ingredients:
            item = await _estimate_single_food(name, grams)
            components.append(item)
        return {"components": components}

    return await _estimate_single_food(food_name, quantity_grams)


async def _estimate_single_food(food_name: str, quantity_grams: float) -> dict:
    """הערכה תזונתית למרכיב בודד."""
    prompt = PROMPT_TEMPLATE.format(food_name=food_name, quantity_grams=quantity_grams)
    raw_text = await _generate_content_with_fallback(prompt)
    data = _parse_model_json(raw_text)

    # תמיכה בתשובת מרכיבים מרובים (כשהמשתמש הכניס כמה מרכיבים בשדה שם המזון)
    if "components" in data:
        components = []
        for comp in data["components"]:
            components.append({
                "food_name": comp["food_name"],
                "quantity_grams": float(comp["quantity_grams"]),
                "calories": float(comp["calories"]),
                "protein_g": float(comp["protein_g"]),
                "fat_g": float(comp["fat_g"]),
                "carbs_g": float(comp.get("carbs_g", 0)),
                "source": "ai_estimate",
            })
        return {"components": components}

    required_fields = {"calories", "protein_g", "fat_g", "carbs_g"}
    missing = required_fields - data.keys()
    if missing:
        raise ValueError(f"Gemini response missing fields: {missing}")

    data["calories"] = float(data["calories"])
    data["protein_g"] = float(data["protein_g"])
    data["fat_g"] = float(data["fat_g"])
    data["carbs_g"] = float(data.get("carbs_g", 0))

    if data["calories"] <= 0 and (data["protein_g"] + data["fat_g"] + data["carbs_g"]) <= 0:
        raise ValueError("Gemini returned empty nutrition estimate")

    data["food_name"] = food_name
    data["quantity_grams"] = quantity_grams
    data["source"] = "ai_estimate"
    return data


async def estimate_food_from_description(description: str) -> dict:
    """
    מקבל תיאור חופשי של מנה ומחזיר ערכים תזונתיים.
    אם מזוהים כמה מרכיבים עם כמויות (regex), מחזיר {"components": [...]}.
    """
    # זיהוי מרכיבים מרובים בצד השרת (לא מסתמכים על פורמט AI)
    ingredients = _extract_ingredients(description)
    if ingredients:
        components = []
        for name, grams in ingredients:
            item = await estimate_food(name, grams)
            # estimate_food מחזיר פריט בודד במקרה זה (כל מרכיב הוא פשוט)
            if "components" not in item:
                item["source"] = "ai_estimate_description"
                components.append(item)
        if components:
            return {"components": components}

    # מרכיב יחיד - שימוש בפרומפט רגיל
    prompt = DESCRIPTION_PROMPT_TEMPLATE.format(description=description)
    raw_text = await _generate_content_with_fallback(prompt)
    data = _parse_model_json(raw_text)

    # fallback: אם ה-AI החזיר components בכל זאת
    if "components" in data:
        components = []
        for comp in data["components"]:
            components.append({
                "food_name": comp["food_name"],
                "quantity_grams": float(comp["quantity_grams"]),
                "calories": float(comp["calories"]),
                "protein_g": float(comp["protein_g"]),
                "fat_g": float(comp["fat_g"]),
                "carbs_g": float(comp.get("carbs_g", 0)),
                "source": "ai_estimate_description",
            })
        return {"components": components}

    required_fields = {"quantity_grams", "calories", "protein_g", "fat_g", "carbs_g"}
    missing = required_fields - data.keys()
    if missing:
        raise ValueError(f"Gemini response missing fields: {missing}")

    data["food_name"] = data.get("food_name", description)
    data["quantity_grams"] = float(data["quantity_grams"])
    data["calories"] = float(data["calories"])
    data["protein_g"] = float(data["protein_g"])
    data["fat_g"] = float(data["fat_g"])
    data["carbs_g"] = float(data["carbs_g"])

    if data["quantity_grams"] <= 0:
        raise ValueError("Gemini returned non-positive quantity_grams")
    if data["calories"] <= 0 and (data["protein_g"] + data["fat_g"] + data["carbs_g"]) <= 0:
        raise ValueError("Gemini returned empty nutrition estimate")

    data["source"] = "ai_estimate_description"
    return data


def _normalize_meal_entry(raw: dict, source: str) -> dict:
    return {
        "food_name": str(raw["food_name"]),
        "quantity_grams": float(raw["quantity_grams"]),
        "calories": float(raw["calories"]),
        "protein_g": float(raw["protein_g"]),
        "fat_g": float(raw["fat_g"]),
        "carbs_g": float(raw.get("carbs_g", 0)),
        "source": source,
    }


async def chat_with_nutrition_assistant(message: str, history: list[dict] | None = None) -> dict:
    """
    מחזיר תשובת צ'אט תזונתית + אופציונלית מנה בודדת/מרובת רכיבים להוספה ליומן.
    """
    history = history or []
    history_tail = history[-8:]
    history_lines = []
    for msg in history_tail:
        role = "משתמש" if str(msg.get("role", "user")) == "user" else "עוזר"
        content = str(msg.get("content", "")).strip()
        if content:
            history_lines.append(f"{role}: {content}")
    history_text = "\n".join(history_lines) if history_lines else "(אין היסטוריה)"

    prompt = CHAT_PROMPT_TEMPLATE.format(history_text=history_text, message=message)
    raw_text = await _generate_content_with_fallback(prompt)
    data = _parse_model_json(raw_text)

    reply = str(data.get("reply", "")).strip()
    if not reply:
        raise ValueError("Gemini response missing reply")

    meal = None
    components = None

    if isinstance(data.get("components"), list) and data["components"]:
        components = [_normalize_meal_entry(comp, "ai_chat") for comp in data["components"]]
    elif isinstance(data.get("meal"), dict):
        meal = _normalize_meal_entry(data["meal"], "ai_chat")

    return {
        "reply": reply,
        "meal": meal,
        "components": components,
    }