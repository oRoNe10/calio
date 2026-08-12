"""
חיבור למסד הנתונים.
בפיתוח משתמשים ב-SQLite (קובץ מקומי, בלי צורך בהתקנת שרת DB).
כשעוברים לפרודקשן - פשוט מחליפים את DATABASE_URL ל-PostgreSQL, למשל:
postgresql://user:password@localhost:5432/calio
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
import os
from pathlib import Path


def _is_placeholder_database_url(raw_url: str) -> bool:
    normalized = raw_url.strip()
    if not normalized:
        return True

    placeholders = (
        "USER:PASSWORD@HOST",
        "/DBNAME",
        "your_user",
        "your_password",
        "your_host",
    )
    lowered = normalized.lower()
    return any(token.lower() in lowered for token in placeholders)


def _normalize_database_url(raw_url: str) -> str:
    """Convert common Postgres URL formats to SQLAlchemy+psycopg format."""
    if raw_url.startswith("postgres://"):
        raw_url = "postgresql+psycopg://" + raw_url[len("postgres://"):]
    elif raw_url.startswith("postgresql://"):
        raw_url = "postgresql+psycopg://" + raw_url[len("postgresql://"):]

    # Neon and other managed Postgres providers require SSL.
    if raw_url.startswith("postgresql+psycopg://") and "sslmode=" not in raw_url:
        raw_url = f"{raw_url}{'&' if '?' in raw_url else '?'}sslmode=require"

    return raw_url

# Always use one stable local DB file under backend/, regardless of where uvicorn is launched.
DEFAULT_SQLITE_PATH = Path(__file__).resolve().parents[1] / "calio.db"
ENV_DATABASE_URL = os.getenv("DATABASE_URL", "")
RAW_DATABASE_URL = ENV_DATABASE_URL if not _is_placeholder_database_url(ENV_DATABASE_URL) else f"sqlite:///{DEFAULT_SQLITE_PATH.as_posix()}"
DATABASE_URL = _normalize_database_url(RAW_DATABASE_URL)

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine_kwargs = {"connect_args": connect_args}

if DATABASE_URL.startswith("postgresql+psycopg://"):
    # Keep pooled Postgres connections healthy on managed providers.
    engine_kwargs.update(
        pool_pre_ping=True,
        pool_recycle=int(os.getenv("DB_POOL_RECYCLE_SECONDS", "300")),
    )
    engine_kwargs["connect_args"] = {
        **connect_args,
        "connect_timeout": int(os.getenv("DB_CONNECT_TIMEOUT_SECONDS", "10")),
    }

engine = create_engine(DATABASE_URL, **engine_kwargs)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """Dependency שמזריקים ל-endpoints של FastAPI כדי לקבל session פתוח לDB."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
