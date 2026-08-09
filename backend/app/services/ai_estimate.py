"""
שכבת ה-fallback החכמה: כשOpen Food Facts לא מוצא את המזון (בעיקר עם
מזונות ישראליים/עבריים או מנות מורכבות כמו "חזה עוף עם תבלין שווארמה"),
אנחנו פונים ל-Gemini ומבקשים ממנו להעריך בעצמו את הערכים התזונתיים.
"""
import os
import re
import json
import copy
import hashlib
import asyncio
from pathlib import Path
from io import BytesIO
from collections import OrderedDict
from google import genai

_client: genai.Client | None = None
DEFAULT_MODEL_CANDIDATES = [
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-pro-latest",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
]

_image_response_cache: OrderedDict[str, dict] = OrderedDict()


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


def _get_timeout_seconds() -> float:
    raw = os.getenv("GEMINI_TIMEOUT_SECONDS", "25").strip()
    try:
        value = float(raw)
        return value if value > 0 else 25.0
    except Exception:
        return 25.0


def _get_image_cache_size() -> int:
    raw = os.getenv("GEMINI_IMAGE_CACHE_SIZE", "128").strip()
    try:
        value = int(raw)
        return value if value > 0 else 128
    except Exception:
        return 128


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


def _get_image_model_candidates() -> list[str]:
    from_env = os.getenv("GEMINI_IMAGE_MODEL_CANDIDATES", "").strip()
    if from_env:
        models = [m.strip() for m in from_env.split(",") if m.strip()]
        if models:
            return list(dict.fromkeys(models))

    return _get_model_candidates()


def _cache_get(cache_key: str) -> dict | None:
    item = _image_response_cache.get(cache_key)
    if item is None:
        return None
    _image_response_cache.move_to_end(cache_key)
    return copy.deepcopy(item)


def _cache_set(cache_key: str, payload: dict) -> None:
    _image_response_cache[cache_key] = copy.deepcopy(payload)
    _image_response_cache.move_to_end(cache_key)
    max_size = _get_image_cache_size()
    while len(_image_response_cache) > max_size:
        _image_response_cache.popitem(last=False)


def _optimize_image_bytes(image_bytes: bytes, mime_type: str) -> tuple[bytes, str]:
    """Compress and resize image before sending to Gemini to reduce request latency."""
    try:
        from PIL import Image
    except Exception:
        return image_bytes, mime_type

    max_side_raw = os.getenv("GEMINI_IMAGE_MAX_SIDE", "1280").strip()
    jpeg_quality_raw = os.getenv("GEMINI_IMAGE_JPEG_QUALITY", "80").strip()
    try:
        max_side = max(512, int(max_side_raw))
    except Exception:
        max_side = 1280
    try:
        jpeg_quality = min(95, max(40, int(jpeg_quality_raw)))
    except Exception:
        jpeg_quality = 80

    try:
        img = Image.open(BytesIO(image_bytes))
        img.load()
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")

        img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)

        out = BytesIO()
        save_format = "PNG" if mime_type == "image/png" else "JPEG"
        save_mime = "image/png" if save_format == "PNG" else "image/jpeg"

        if save_format == "PNG":
            img.save(out, format=save_format, optimize=True)
        else:
            img.save(out, format=save_format, quality=jpeg_quality, optimize=True, progressive=True)

        optimized = out.getvalue()
        if optimized and len(optimized) < len(image_bytes):
            return optimized, save_mime
    except Exception:
        return image_bytes, mime_type

    return image_bytes, mime_type


async def _generate_content_with_fallback(prompt: str) -> str:
    last_error: Exception | None = None

    for model_name in _get_model_candidates():
        try:
            response = await asyncio.wait_for(
                _get_client().aio.models.generate_content(
                    model=model_name,
                    contents=prompt,
                ),
                timeout=_get_timeout_seconds(),
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


_NUMBER = r"(\d+(?:[\.,]\d+)?)"
_CALORIES_PATTERN = re.compile(rf"{_NUMBER}\s*(?:קלוריות|קלוריה|kcal|cal)", re.IGNORECASE | re.UNICODE)
_PROTEIN_PATTERN = re.compile(rf"{_NUMBER}\s*(?:חלבון|protein)", re.IGNORECASE | re.UNICODE)
_FAT_PATTERN = re.compile(rf"{_NUMBER}\s*(?:שומן|fat)", re.IGNORECASE | re.UNICODE)
_CARBS_PATTERN = re.compile(rf"{_NUMBER}\s*(?:פחמימות|פחמימה|carbs?|carbohydrates?)", re.IGNORECASE | re.UNICODE)
_QUANTITY_PATTERN = re.compile(rf"{_NUMBER}\s*(?:גרם|ג'|g|מ\"ל|מל|ml)", re.IGNORECASE | re.UNICODE)
_LINE_QTY_PATTERN = re.compile(
    rf"^\s*{_NUMBER}\s*(כפיות|כפית|כפות|כף|גרם|ג'|g|מ\"ל|מל|ml)\s+(.+?)\s*$",
    re.IGNORECASE | re.UNICODE,
)


def _to_float_token(value: str) -> float:
    return float(value.replace(",", "."))


def _extract_inline_nutrition(description: str) -> dict | None:
    """Extract nutrition values directly from text like '110 קלוריות 21 חלבון'."""
    calories_match = _CALORIES_PATTERN.search(description)
    protein_match = _PROTEIN_PATTERN.search(description)
    fat_match = _FAT_PATTERN.search(description)
    carbs_match = _CARBS_PATTERN.search(description)

    if not calories_match:
        return None

    protein = _to_float_token(protein_match.group(1)) if protein_match else 0.0
    fat = _to_float_token(fat_match.group(1)) if fat_match else 0.0
    carbs = _to_float_token(carbs_match.group(1)) if carbs_match else 0.0
    calories = _to_float_token(calories_match.group(1))

    # Require at least one macro to avoid accidental parsing from unrelated text.
    if protein <= 0 and fat <= 0 and carbs <= 0:
        return None

    qty_matches = [_to_float_token(m.group(1)) for m in _QUANTITY_PATTERN.finditer(description)]
    quantity_grams = max(qty_matches) if qty_matches else 100.0

    food_name = description.split(":", 1)[0].strip() or description.strip()
    return {
        "food_name": food_name,
        "quantity_grams": quantity_grams,
        "calories": calories,
        "protein_g": protein,
        "fat_g": fat,
        "carbs_g": carbs,
        "source": "description_inline",
    }


def _unit_to_grams(value: float, unit: str) -> float:
    unit = unit.strip().lower()
    if unit in {"גרם", "ג'", "g"}:
        return value
    if unit in {"מ\"ל", "מל", "ml"}:
        return value
    if unit in {"כפית", "כפיות"}:
        return value * 5.0
    if unit in {"כף", "כפות"}:
        return value * 15.0
    return value


def _extract_multiline_description_components(description: str) -> list[dict]:
    """Extract component candidates from line-based descriptions like shakes with ingredients."""
    normalized = description.replace("\r\n", "\n")

    # תמיכה גם במקרה שבו המשתמש מדביק הכל בשורה אחת.
    if "\n" not in normalized:
        normalized = re.sub(
            rf"\s+(?={_NUMBER}\s*(?:כפיות|כפית|כפות|כף|גרם|ג'|g|מ\"ל|מל|ml)\s+)",
            "\n",
            normalized,
        )

    lines = [ln.strip() for ln in normalized.splitlines() if ln.strip()]
    if len(lines) < 2:
        return []

    # Ignore a title line like "שייק חלבון:"
    if ":" in lines[0] and not any(ch.isdigit() for ch in lines[0]):
        lines = lines[1:]

    components: list[dict] = []
    for line in lines:
        # Pattern: "אבקת חלבון : 110 קלוריות 21 חלבון"
        if ":" in line:
            name, details = line.split(":", 1)
            name = name.strip().split(":")[-1].strip()
            details = details.strip()
            if name:
                parsed = _extract_inline_nutrition(f"{name}: {details}")
                if parsed:
                    components.append(parsed)
                    continue

        # Pattern: "2 כפיות חמאת בוטנים" / "100 מ\"ל חלב"
        match = _LINE_QTY_PATTERN.match(line)
        if match:
            value = _to_float_token(match.group(1))
            unit = match.group(2)
            name = match.group(3).strip()
            if name:
                components.append({
                    "food_name": name,
                    "quantity_grams": _unit_to_grams(value, unit),
                    "calories": None,
                    "protein_g": None,
                    "fat_g": None,
                    "carbs_g": None,
                    "source": "description_component",
                })

    return components if len(components) >= 2 else []


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

    image_bytes, mime_type = _optimize_image_bytes(image_bytes, mime_type)
    cache_key = hashlib.sha256(mime_type.encode("utf-8") + b"|" + image_bytes).hexdigest()
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    last_error: Exception | None = None
    for model_name in _get_image_model_candidates():
        try:
            response = await asyncio.wait_for(
                _get_client().aio.models.generate_content(
                    model=model_name,
                    contents=[
                        genai_types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
                        IMAGE_PROMPT,
                    ],
                ),
                timeout=_get_timeout_seconds(),
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
        result = {"components": components}
        _cache_set(cache_key, result)
        return result

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
    _cache_set(cache_key, data)
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
    # זיהוי תיאור רב-שורות של כמה רכיבים (למשל שייק עם רכיבים בכפיות/מ"ל)
    multiline_components = _extract_multiline_description_components(description)
    if multiline_components:
        resolved_components: list[dict] = []
        estimate_jobs = [
            _estimate_single_food(comp["food_name"], comp["quantity_grams"])
            for comp in multiline_components
            if comp["calories"] is None
        ]
        estimate_results = await asyncio.gather(*estimate_jobs, return_exceptions=True) if estimate_jobs else []

        result_index = 0
        for comp in multiline_components:
            if comp["calories"] is not None:
                comp["source"] = "description_inline"
                resolved_components.append(comp)
                continue

            result = estimate_results[result_index]
            result_index += 1
            if isinstance(result, Exception):
                continue
            if isinstance(result, dict) and "components" not in result:
                result["source"] = "ai_estimate_description"
                resolved_components.append(result)

        if len(resolved_components) >= 2:
            return {"components": resolved_components}

    # זיהוי מרכיבים מרובים בצד השרת (לא מסתמכים על פורמט AI)
    ingredients = _extract_ingredients(description)
    if ingredients:
        components = []
        estimate_results = await asyncio.gather(
            *[estimate_food(name, grams) for name, grams in ingredients],
            return_exceptions=True,
        )
        for item in estimate_results:
            if isinstance(item, Exception):
                continue
            # estimate_food מחזיר פריט בודד במקרה זה (כל מרכיב הוא פשוט)
            if "components" not in item:
                item["source"] = "ai_estimate_description"
                components.append(item)
        if components:
            return {"components": components}

    # אם המשתמש סיפק ערכים תזונתיים בטקסט, נחזיר אותם מיד בלי קריאת Gemini.
    inline = _extract_inline_nutrition(description)
    if inline is not None:
        return inline

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