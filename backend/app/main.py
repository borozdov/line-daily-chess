from __future__ import annotations

import json
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, time as dt_time, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any
from uuid import UUID, uuid4

import chess
import jwt
from fastapi import Depends, FastAPI, Header, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from psycopg import errors
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


BASE_DIR = Path(__file__).resolve().parent
SEED_PATH = BASE_DIR / "seed_puzzles.json"


class Settings:
    database_url = os.getenv("DATABASE_URL", "postgresql://line:line@localhost:5432/line")
    jwt_secret = os.getenv("JWT_SECRET", "dev-line-secret-change-before-production")
    share_secret = os.getenv("SHARE_SECRET") or jwt_secret
    jwt_algorithm = "HS256"
    launch_date = date.fromisoformat(os.getenv("LAUNCH_DATE", "2026-05-17"))
    max_inaccuracies = int(os.getenv("MAX_INACCURACIES", "0"))
    cors_origins = [
        origin.strip()
        for origin in os.getenv(
            "CORS_ORIGINS",
            "http://localhost:3000,http://127.0.0.1:3000,http://localhost:8080",
        ).split(",")
        if origin.strip()
    ]


settings = Settings()
pool: ConnectionPool | None = None


class SessionOut(BaseModel):
    guest_id: UUID
    token: str
    display_name: str | None = None


class ProfileOut(BaseModel):
    guest_id: UUID
    display_name: str | None = None


class ProfileIn(BaseModel):
    display_name: str = Field(min_length=2, max_length=24)


class DailyOut(BaseModel):
    daily_id: int
    external_id: str
    date: date
    fen: str
    board_orientation: str
    rating: int
    rating_deviation: int
    popularity: int
    nb_plays: int
    themes: list[str]
    opening_tags: list[str]
    status: str
    ply_index: int
    marks: list[str]
    lives_remaining: int
    locked_until: datetime | None
    expires_at_utc: datetime


class MoveIn(BaseModel):
    move: str = Field(min_length=4, max_length=5, pattern=r"^[a-h][1-8][a-h][1-8][qrbn]?$")


class MoveOut(BaseModel):
    move_status: str
    session_status: str
    fen: str
    ply_index: int
    marks: list[str]
    lives_remaining: int
    user_move_san: str | None = None
    system_move_uci: str | None = None
    system_move_san: str | None = None
    locked_until: datetime | None = None
    message: str


class PuzzleHistoryItem(BaseModel):
    daily_id: int
    date: date
    rating: int
    status: str
    moves_played: int
    correct_moves: int
    marks: list[str]


class UserStatsOut(BaseModel):
    attempted: int
    solved: int
    failed: int
    skipped: int
    current_streak: int
    best_streak: int
    last_failed_date: date | None
    total_moves: int
    correct_moves: int
    average_rating: int | None
    average_solved_rating: int | None
    hardest_solved: PuzzleHistoryItem | None
    easiest_solved: PuzzleHistoryItem | None
    solved_tasks: list[PuzzleHistoryItem]
    history: list[PuzzleHistoryItem]


class LeaderboardEntryOut(BaseModel):
    rank: int
    guest_id: UUID
    display_name: str
    solved: int
    failed: int
    skipped: int
    current_streak: int
    best_streak: int
    total_moves: int
    achievements: int
    average_solved_rating: int | None


class LeaderboardOut(BaseModel):
    entries: list[LeaderboardEntryOut]


class RankOut(BaseModel):
    rank: int | None
    total: int


class ShareLinkOut(BaseModel):
    path: str
    token: str
    status: str
    stats: UserStatsOut
    display_name: str
    rank: int | None


class ShareResultOut(BaseModel):
    status: str
    stats: UserStatsOut
    issued_at: int
    display_name: str
    rank: int | None


def db() -> ConnectionPool:
    if pool is None:
        raise RuntimeError("Database pool is not initialized")
    return pool


def utc_today() -> date:
    return datetime.now(timezone.utc).date()


def next_utc_midnight(day: date | None = None) -> datetime:
    base = day or utc_today()
    return datetime.combine(base + timedelta(days=1), dt_time.min, tzinfo=timezone.utc)


def create_token(guest_id: UUID) -> str:
    payload = {
        "sub": str(guest_id),
        "typ": "guest",
        "iat": int(datetime.now(timezone.utc).timestamp()),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def history_item_from_row(row: dict[str, Any]) -> PuzzleHistoryItem:
    return PuzzleHistoryItem(
        daily_id=row["daily_id"],
        date=row["puzzle_date"],
        rating=row["rating"],
        status=row["status"],
        moves_played=row["moves_played"],
        correct_moves=row["correct_moves"],
        marks=list(row["marks"]),
    )


def current_streak(history: list[PuzzleHistoryItem]) -> int:
    closed = [item for item in history if item.status in {"solved", "failed"}]
    if not closed or closed[0].status != "solved":
        return 0

    expected_date = closed[0].date
    streak = 0
    for item in closed:
        if item.date != expected_date or item.status != "solved":
            break
        streak += 1
        expected_date -= timedelta(days=1)
    return streak


def best_streak(history: list[PuzzleHistoryItem]) -> int:
    best = 0
    active = 0
    previous_date: date | None = None

    for item in sorted(history, key=lambda entry: entry.date):
        if item.status != "solved":
            active = 0
            previous_date = item.date
            continue

        if previous_date is not None and item.date == previous_date + timedelta(days=1):
            active += 1
        else:
            active = 1

        best = max(best, active)
        previous_date = item.date

    return best


def build_user_stats(conn: Any, guest_id: UUID) -> UserStatsOut:
    session = conn.execute(
        "SELECT created_at::date AS created_date FROM guest_sessions WHERE guest_id = %s",
        (guest_id,),
    ).fetchone()
    first_day = max(settings.launch_date, session["created_date"] if session else utc_today())
    today = utc_today()
    last_closed_day = today - timedelta(days=1)
    if first_day <= last_closed_day:
        active_days = (last_closed_day - first_day).days + 1
        touched_dates = conn.execute(
            """
            SELECT DISTINCT puzzle_date
            FROM attempts
            WHERE guest_id = %s
              AND puzzle_date BETWEEN %s AND %s
            """,
            (guest_id, first_day, last_closed_day),
        ).fetchall()
        skipped = max(0, active_days - len(touched_dates))
    else:
        skipped = 0

    rows = conn.execute(
        """
        SELECT
          a.puzzle_date,
          a.status,
          a.marks,
          p.daily_id,
          p.rating,
          COALESCE(events.moves_played, 0)::int AS moves_played,
          COALESCE(events.correct_moves, 0)::int AS correct_moves
        FROM attempts a
        JOIN puzzles p ON p.id = a.puzzle_id
        LEFT JOIN (
          SELECT
            attempt_id,
            count(*)::int AS moves_played,
            count(*) FILTER (WHERE move_status = 'Brilliant')::int AS correct_moves
          FROM move_events
          GROUP BY attempt_id
        ) events ON events.attempt_id = a.id
        WHERE a.guest_id = %s
          AND a.status IN ('solved', 'failed')
        ORDER BY a.puzzle_date DESC
        """,
        (guest_id,),
    ).fetchall()

    history = [history_item_from_row(row) for row in rows]
    solved_tasks = [item for item in history if item.status == "solved"]
    failed_tasks = [item for item in history if item.status == "failed"]
    attempted = len(history)
    total_moves = sum(item.moves_played for item in history)
    correct_moves = sum(item.correct_moves for item in history)

    return UserStatsOut(
        attempted=attempted,
        solved=len(solved_tasks),
        failed=len(failed_tasks),
        skipped=skipped,
        current_streak=current_streak(history),
        best_streak=best_streak(history),
        last_failed_date=failed_tasks[0].date if failed_tasks else None,
        total_moves=total_moves,
        correct_moves=correct_moves,
        average_rating=round(sum(item.rating for item in history) / attempted) if attempted else None,
        average_solved_rating=round(sum(item.rating for item in solved_tasks) / len(solved_tasks)) if solved_tasks else None,
        hardest_solved=max(solved_tasks, key=lambda item: item.rating) if solved_tasks else None,
        easiest_solved=min(solved_tasks, key=lambda item: item.rating) if solved_tasks else None,
        solved_tasks=solved_tasks[:50],
        history=history[:50],
    )


def achievement_count(stats: UserStatsOut, rank: int | None) -> int:
    checks = [
        stats.solved >= 1,
        stats.solved >= 5,
        stats.solved >= 10,
        stats.failed >= 1,
        stats.failed >= 3,
        stats.failed >= 10,
        stats.total_moves >= 10,
        stats.total_moves >= 50,
        stats.total_moves >= 100,
        bool(rank and rank <= 10),
        bool(rank and rank <= 5),
        bool(rank and rank == 1),
    ]
    return sum(1 for unlocked in checks if unlocked)


def build_leaderboard(conn: Any, limit: int | None = 20) -> LeaderboardOut:
    players = conn.execute(
        """
        SELECT guest_id, display_name
        FROM guest_sessions
        ORDER BY created_at ASC
        """
    ).fetchall()

    entries: list[dict[str, Any]] = []
    for player in players:
        stats = build_user_stats(conn, player["guest_id"])
        if stats.attempted == 0:
            continue
        entries.append(
            {
                "guest_id": player["guest_id"],
                "display_name": public_display_name(player["guest_id"], player["display_name"]),
                "stats": stats,
            }
        )

    entries.sort(
        key=lambda entry: (
            entry["stats"].solved,
            entry["stats"].current_streak,
            entry["stats"].best_streak,
            entry["stats"].average_solved_rating or 0,
            -entry["stats"].failed,
        ),
        reverse=True,
    )

    return LeaderboardOut(
        entries=[
            LeaderboardEntryOut(
                rank=index + 1,
                guest_id=entry["guest_id"],
                display_name=entry["display_name"],
                solved=entry["stats"].solved,
                failed=entry["stats"].failed,
                skipped=entry["stats"].skipped,
                current_streak=entry["stats"].current_streak,
                best_streak=entry["stats"].best_streak,
                total_moves=entry["stats"].total_moves,
                achievements=achievement_count(entry["stats"], index + 1),
                average_solved_rating=entry["stats"].average_solved_rating,
            )
            for index, entry in enumerate(entries if limit is None else entries[:limit])
        ]
    )


def player_rank(conn: Any, guest_id: UUID) -> RankOut:
    leaderboard = build_leaderboard(conn, limit=None)
    for entry in leaderboard.entries:
        if entry.guest_id == guest_id:
            return RankOut(rank=entry.rank, total=len(leaderboard.entries))
    return RankOut(rank=None, total=len(leaderboard.entries))


def create_share_token(guest_id: UUID, attempt: dict[str, Any], display_name: str, rank: int | None) -> str:
    payload = {
        "typ": "share",
        "guest_id": str(guest_id),
        "date": attempt["puzzle_date"].isoformat(),
        "status": attempt["status"],
        "display_name": display_name,
        "rank": rank,
        "iat": int(datetime.now(timezone.utc).timestamp()),
    }
    return jwt.encode(payload, settings.share_secret, algorithm=settings.jwt_algorithm)


def decode_share_token(token: str) -> dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.share_secret, algorithms=[settings.jwt_algorithm])
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share link is invalid") from exc

    if payload.get("typ") != "share":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share link is invalid")

    try:
        issued_at = int(payload["iat"])
        date.fromisoformat(payload["date"])
        display_name = str(payload.get("display_name") or "Игрок")
        rank_payload = payload.get("rank")
        rank = int(rank_payload) if rank_payload is not None else None
        guest_id = UUID(payload["guest_id"]) if payload.get("guest_id") else None
        stats_payload = UserStatsOut.model_validate(payload["stats"]) if payload.get("stats") else None
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share link is invalid") from exc

    if payload.get("status") not in {"solved", "failed"}:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share link is invalid")

    return {
        "status": payload["status"],
        "stats": stats_payload,
        "issued_at": issued_at,
        "display_name": display_name,
        "rank": rank,
        "guest_id": guest_id,
    }


def read_bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None
    return token


def decode_guest_id(authorization: str | None) -> UUID | None:
    token = read_bearer_token(authorization)
    if not token:
        return None
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        return UUID(payload["sub"])
    except Exception:
        return None


def require_guest_id(
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> UUID:
    guest_id = decode_guest_id(authorization)
    if guest_id is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing or invalid token")
    return guest_id


def create_schema() -> None:
    assert pool is not None
    with pool.connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS guest_sessions (
              guest_id UUID PRIMARY KEY,
              display_name TEXT,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS puzzles (
              id SERIAL PRIMARY KEY,
              day_index INTEGER UNIQUE NOT NULL,
              daily_id INTEGER UNIQUE NOT NULL,
              external_id TEXT UNIQUE NOT NULL,
              source_fen TEXT NOT NULL,
              initial_fen TEXT NOT NULL,
              first_move_uci TEXT NOT NULL,
              solution_uci TEXT[] NOT NULL,
              rating INTEGER NOT NULL,
              rating_deviation INTEGER NOT NULL,
              popularity INTEGER NOT NULL,
              nb_plays INTEGER NOT NULL,
              themes TEXT[] NOT NULL DEFAULT '{}',
              game_url TEXT NOT NULL,
              opening_tags TEXT[] NOT NULL DEFAULT '{}',
              created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS attempts (
              id UUID PRIMARY KEY,
              guest_id UUID NOT NULL REFERENCES guest_sessions(guest_id),
              puzzle_id INTEGER NOT NULL REFERENCES puzzles(id),
              puzzle_date DATE NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('playing', 'solved', 'failed')),
              current_fen TEXT NOT NULL,
              ply_index INTEGER NOT NULL DEFAULT 0,
              lives_remaining INTEGER NOT NULL DEFAULT 0,
              marks TEXT[] NOT NULL DEFAULT '{}',
              locked_until TIMESTAMPTZ,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              UNIQUE (guest_id, puzzle_date)
            );

            CREATE TABLE IF NOT EXISTS move_events (
              id UUID PRIMARY KEY,
              attempt_id UUID NOT NULL REFERENCES attempts(id),
              expected_uci TEXT,
              received_uci TEXT NOT NULL,
              move_status TEXT NOT NULL,
              user_move_san TEXT,
              fen_after TEXT NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            """
        )
        conn.execute("ALTER TABLE guest_sessions ADD COLUMN IF NOT EXISTS display_name TEXT")
        conn.execute(
            """
            WITH ranked_names AS (
              SELECT
                gs.guest_id,
                row_number() OVER (
                  PARTITION BY lower(gs.display_name)
                  ORDER BY COALESCE(attempt_counts.attempts, 0) DESC, gs.created_at ASC, gs.guest_id ASC
                ) AS rank
              FROM guest_sessions gs
              LEFT JOIN (
                SELECT guest_id, count(*)::int AS attempts
                FROM attempts
                GROUP BY guest_id
              ) attempt_counts ON attempt_counts.guest_id = gs.guest_id
              WHERE gs.display_name IS NOT NULL
            )
            UPDATE guest_sessions
            SET display_name = NULL
            WHERE guest_id IN (
              SELECT guest_id
              FROM ranked_names
              WHERE rank > 1
            )
            """
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS guest_sessions_display_name_unique
            ON guest_sessions (lower(display_name))
            WHERE display_name IS NOT NULL
            """
        )
        conn.commit()


def seed_puzzles() -> None:
    assert pool is not None
    with pool.connection() as conn:
        count = conn.execute("SELECT count(*) AS count FROM puzzles").fetchone()["count"]
        if count:
            return

        seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        for item in seed:
            conn.execute(
                """
                INSERT INTO puzzles (
                  day_index, daily_id, external_id, source_fen, initial_fen, first_move_uci,
                  solution_uci, rating, rating_deviation, popularity, nb_plays, themes, game_url, opening_tags
                )
                VALUES (
                  %(day_index)s, %(daily_id)s, %(external_id)s, %(source_fen)s, %(initial_fen)s, %(first_move_uci)s,
                  %(solution_uci)s, %(rating)s, %(rating_deviation)s, %(popularity)s, %(nb_plays)s, %(themes)s,
                  %(game_url)s, %(opening_tags)s
                )
                ON CONFLICT (external_id) DO NOTHING
                """,
                item,
            )
        conn.commit()


def connect_with_retry() -> ConnectionPool:
    last_error: Exception | None = None
    for _ in range(30):
        try:
            candidate = ConnectionPool(
                settings.database_url,
                kwargs={"row_factory": dict_row},
                min_size=1,
                max_size=10,
                open=True,
            )
            with candidate.connection() as conn:
                conn.execute("SELECT 1")
            return candidate
        except Exception as exc:
            last_error = exc
            time.sleep(1)
    raise RuntimeError(f"Database is unavailable: {last_error}") from last_error


@asynccontextmanager
async def lifespan(_: FastAPI):
    global pool
    pool = connect_with_retry()
    create_schema()
    seed_puzzles()
    yield
    pool.close()


app = FastAPI(title="Line Daily Chess API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def ensure_session(guest_id: UUID | None = None) -> UUID:
    target = guest_id or uuid4()
    with db().connection() as conn:
        row = conn.execute(
            """
            INSERT INTO guest_sessions (guest_id)
            VALUES (%s)
            ON CONFLICT (guest_id)
            DO UPDATE SET last_seen_at = now()
            RETURNING guest_id
            """,
            (target,),
        ).fetchone()
        conn.commit()
        return row["guest_id"]


def public_display_name(guest_id: UUID, display_name: str | None) -> str:
    if display_name:
        return display_name
    return f"Игрок {str(guest_id)[:4].upper()}"


def clean_display_name(display_name: str) -> str:
    cleaned = " ".join(display_name.strip().split())
    if not re.fullmatch(r"[\wА-Яа-яЁё -]{2,24}", cleaned):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Nick can contain 2-24 letters, digits, spaces, hyphens or underscores",
        )
    return cleaned


def puzzle_for_day(conn: Any, target_date: date) -> dict[str, Any]:
    count = conn.execute("SELECT count(*) AS count FROM puzzles").fetchone()["count"]
    if not count:
        raise HTTPException(status_code=503, detail="Puzzle database is empty")

    day_offset = (target_date - settings.launch_date).days % count
    row = conn.execute(
        "SELECT * FROM puzzles WHERE day_index = %s",
        (day_offset,),
    ).fetchone()
    if row is None:
        row = conn.execute(
            "SELECT * FROM puzzles ORDER BY day_index ASC OFFSET %s LIMIT 1",
            (day_offset,),
        ).fetchone()
    return row


def ensure_attempt(conn: Any, guest_id: UUID, puzzle: dict[str, Any], target_date: date) -> dict[str, Any]:
    attempt = conn.execute(
        "SELECT * FROM attempts WHERE guest_id = %s AND puzzle_date = %s",
        (guest_id, target_date),
    ).fetchone()
    if attempt:
        return attempt

    attempt_id = uuid4()
    return conn.execute(
        """
        INSERT INTO attempts (
          id, guest_id, puzzle_id, puzzle_date, status, current_fen,
          ply_index, lives_remaining, marks
        )
        VALUES (%s, %s, %s, %s, 'playing', %s, 0, %s, '{}')
        RETURNING *
        """,
        (
            attempt_id,
            guest_id,
            puzzle["id"],
            target_date,
            puzzle["initial_fen"],
            settings.max_inaccuracies,
        ),
    ).fetchone()


def public_daily(puzzle: dict[str, Any], attempt: dict[str, Any], target_date: date) -> DailyOut:
    active_color = puzzle["initial_fen"].split()[1]
    return DailyOut(
        daily_id=puzzle["daily_id"],
        external_id=puzzle["external_id"],
        date=target_date,
        fen=attempt["current_fen"],
        board_orientation="white" if active_color == "w" else "black",
        rating=puzzle["rating"],
        rating_deviation=puzzle["rating_deviation"],
        popularity=puzzle["popularity"],
        nb_plays=puzzle["nb_plays"],
        themes=list(puzzle["themes"]),
        opening_tags=list(puzzle["opening_tags"]),
        status=attempt["status"],
        ply_index=attempt["ply_index"],
        marks=list(attempt["marks"]),
        lives_remaining=attempt["lives_remaining"],
        locked_until=attempt["locked_until"],
        expires_at_utc=next_utc_midnight(target_date),
    )


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/session", response_model=SessionOut)
def session(
    response: Response,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> SessionOut:
    existing_guest_id = decode_guest_id(authorization)
    guest_id = ensure_session(existing_guest_id)
    token = create_token(guest_id)
    with db().connection() as conn:
        row = conn.execute(
            "SELECT display_name FROM guest_sessions WHERE guest_id = %s",
            (guest_id,),
        ).fetchone()
    response.set_cookie(
        "line_token",
        token,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=60 * 60 * 24 * 365,
    )
    return SessionOut(guest_id=guest_id, token=token, display_name=row["display_name"] if row else None)


@app.get("/api/profile", response_model=ProfileOut)
def profile(guest_id: Annotated[UUID, Depends(require_guest_id)]) -> ProfileOut:
    with db().connection() as conn:
        row = conn.execute(
            "SELECT guest_id, display_name FROM guest_sessions WHERE guest_id = %s",
            (guest_id,),
        ).fetchone()
        if row is None:
            guest_id = ensure_session(guest_id)
            row = {"guest_id": guest_id, "display_name": None}
        return ProfileOut(guest_id=row["guest_id"], display_name=row["display_name"])


@app.patch("/api/profile", response_model=ProfileOut)
def update_profile(payload: ProfileIn, guest_id: Annotated[UUID, Depends(require_guest_id)]) -> ProfileOut:
    display_name = clean_display_name(payload.display_name)
    try:
        with db().connection() as conn:
            with conn.transaction():
                existing = conn.execute(
                    """
                    SELECT guest_id, display_name
                    FROM guest_sessions
                    WHERE guest_id = %s
                    FOR UPDATE
                    """,
                    (guest_id,),
                ).fetchone()

                if existing is None:
                    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

                if existing["display_name"]:
                    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Nick is already set")

                duplicate = conn.execute(
                    """
                    SELECT 1
                    FROM guest_sessions
                    WHERE lower(display_name) = lower(%s)
                      AND guest_id <> %s
                    LIMIT 1
                    """,
                    (display_name, guest_id),
                ).fetchone()

                if duplicate:
                    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Nick is already taken")

                row = conn.execute(
                    """
                    UPDATE guest_sessions
                    SET display_name = %s,
                        last_seen_at = now()
                    WHERE guest_id = %s
                    RETURNING guest_id, display_name
                    """,
                    (display_name, guest_id),
                ).fetchone()
                return ProfileOut(guest_id=row["guest_id"], display_name=row["display_name"])
    except errors.UniqueViolation as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Nick is already taken") from exc


@app.get("/api/daily", response_model=DailyOut)
def daily(guest_id: Annotated[UUID, Depends(require_guest_id)]) -> DailyOut:
    target_date = utc_today()
    with db().connection() as conn:
        puzzle = puzzle_for_day(conn, target_date)
        attempt = ensure_attempt(conn, guest_id, puzzle, target_date)
        conn.commit()
        return public_daily(puzzle, attempt, target_date)


@app.get("/api/stats", response_model=UserStatsOut)
def stats(guest_id: Annotated[UUID, Depends(require_guest_id)]) -> UserStatsOut:
    with db().connection() as conn:
        return build_user_stats(conn, guest_id)


@app.get("/api/leaderboard", response_model=LeaderboardOut)
def leaderboard() -> LeaderboardOut:
    with db().connection() as conn:
        return build_leaderboard(conn)


@app.get("/api/rank", response_model=RankOut)
def rank(guest_id: Annotated[UUID, Depends(require_guest_id)]) -> RankOut:
    with db().connection() as conn:
        return player_rank(conn, guest_id)


@app.get("/api/share", response_model=ShareLinkOut)
def share_link(guest_id: Annotated[UUID, Depends(require_guest_id)]) -> ShareLinkOut:
    target_date = utc_today()
    with db().connection() as conn:
        attempt = conn.execute(
            """
            SELECT * FROM attempts
            WHERE guest_id = %s AND puzzle_date = %s
            """,
            (guest_id, target_date),
        ).fetchone()

        if attempt is None or attempt["status"] == "playing":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Share link is available only after the line is closed",
            )

        stats_payload = build_user_stats(conn, guest_id)
        profile_row = conn.execute(
            "SELECT display_name FROM guest_sessions WHERE guest_id = %s",
            (guest_id,),
        ).fetchone()
        display_name = public_display_name(guest_id, profile_row["display_name"] if profile_row else None)
        rank_payload = player_rank(conn, guest_id).rank
        token = create_share_token(guest_id, attempt, display_name, rank_payload)
        return ShareLinkOut(
            path=f"/stats/{token}",
            token=token,
            status=attempt["status"],
            stats=stats_payload,
            display_name=display_name,
            rank=rank_payload,
        )


@app.get("/api/share/{token}", response_model=ShareResultOut)
def share_result(token: str) -> ShareResultOut:
    payload = decode_share_token(token)
    stats_payload = payload["stats"]
    rank_payload = payload["rank"]
    display_name = payload["display_name"]
    guest_id = payload["guest_id"]

    if guest_id is not None:
        with db().connection() as conn:
            stats_payload = build_user_stats(conn, guest_id)
            rank_payload = player_rank(conn, guest_id).rank
            profile_row = conn.execute(
                "SELECT display_name FROM guest_sessions WHERE guest_id = %s",
                (guest_id,),
            ).fetchone()
            display_name = public_display_name(guest_id, profile_row["display_name"] if profile_row else display_name)

    return ShareResultOut(
        status=payload["status"],
        stats=stats_payload,
        issued_at=payload["issued_at"],
        display_name=display_name,
        rank=rank_payload,
    )


@app.post("/api/move", response_model=MoveOut)
def move(payload: MoveIn, guest_id: Annotated[UUID, Depends(require_guest_id)]) -> MoveOut:
    target_date = utc_today()

    with db().connection() as conn:
        with conn.transaction():
            puzzle = puzzle_for_day(conn, target_date)
            attempt = conn.execute(
                """
                SELECT * FROM attempts
                WHERE guest_id = %s AND puzzle_date = %s
                FOR UPDATE
                """,
                (guest_id, target_date),
            ).fetchone()
            if attempt is None:
                attempt = ensure_attempt(conn, guest_id, puzzle, target_date)

            if attempt["status"] != "playing":
                return MoveOut(
                    move_status="Locked",
                    session_status=attempt["status"],
                    fen=attempt["current_fen"],
                    ply_index=attempt["ply_index"],
                    marks=list(attempt["marks"]),
                    lives_remaining=attempt["lives_remaining"],
                    locked_until=attempt["locked_until"],
                    message="Daily line is already closed.",
                )

            solution = list(puzzle["solution_uci"])
            ply_index = attempt["ply_index"]
            expected = solution[ply_index]
            board = chess.Board(attempt["current_fen"])

            try:
                user_move = chess.Move.from_uci(payload.move)
            except ValueError as exc:
                raise HTTPException(status_code=422, detail="Invalid UCI move") from exc

            if user_move not in board.legal_moves:
                raise HTTPException(status_code=409, detail="Illegal move for current position")

            user_san = board.san(user_move)
            marks = list(attempt["marks"])

            if user_move.uci() != expected:
                board.push(user_move)
                if attempt["lives_remaining"] > 0:
                    marks.append("inaccuracy")
                    updated = conn.execute(
                        """
                        UPDATE attempts
                        SET lives_remaining = lives_remaining - 1,
                            marks = %s,
                            updated_at = now()
                        WHERE id = %s
                        RETURNING *
                        """,
                        (marks, attempt["id"]),
                    ).fetchone()
                    conn.execute(
                        """
                        INSERT INTO move_events (id, attempt_id, expected_uci, received_uci, move_status, user_move_san, fen_after)
                        VALUES (%s, %s, %s, %s, 'Inaccuracy', %s, %s)
                        """,
                        (uuid4(), attempt["id"], expected, payload.move, user_san, attempt["current_fen"]),
                    )
                    return MoveOut(
                        move_status="Inaccuracy",
                        session_status=updated["status"],
                        fen=updated["current_fen"],
                        ply_index=updated["ply_index"],
                        marks=list(updated["marks"]),
                        lives_remaining=updated["lives_remaining"],
                        user_move_san=user_san,
                        locked_until=updated["locked_until"],
                        message="Move rejected. Position restored.",
                    )

                marks.append("blunder")
                locked_until = next_utc_midnight(target_date)
                updated = conn.execute(
                    """
                    UPDATE attempts
                    SET status = 'failed',
                        current_fen = %s,
                        marks = %s,
                        locked_until = %s,
                        updated_at = now()
                    WHERE id = %s
                    RETURNING *
                    """,
                    (board.fen(), marks, locked_until, attempt["id"]),
                ).fetchone()
                conn.execute(
                    """
                    INSERT INTO move_events (id, attempt_id, expected_uci, received_uci, move_status, user_move_san, fen_after)
                    VALUES (%s, %s, %s, %s, 'Blunder', %s, %s)
                    """,
                    (uuid4(), attempt["id"], expected, payload.move, user_san, board.fen()),
                )
                return MoveOut(
                    move_status="Blunder",
                    session_status=updated["status"],
                    fen=updated["current_fen"],
                    ply_index=updated["ply_index"],
                    marks=list(updated["marks"]),
                    lives_remaining=updated["lives_remaining"],
                    user_move_san=user_san,
                    locked_until=updated["locked_until"],
                    message="Line failed. Next puzzle opens at 00:00 UTC.",
                )

            board.push(user_move)
            marks.append("brilliant")
            ply_index += 1
            system_move_uci = None
            system_move_san = None
            next_status = "solved" if ply_index >= len(solution) else "playing"

            if next_status == "playing":
                system_move_uci = solution[ply_index]
                system_move = chess.Move.from_uci(system_move_uci)
                if system_move not in board.legal_moves:
                    raise HTTPException(status_code=500, detail="Seed puzzle contains illegal system move")
                system_move_san = board.san(system_move)
                board.push(system_move)
                ply_index += 1
                next_status = "solved" if ply_index >= len(solution) else "playing"

            updated = conn.execute(
                """
                UPDATE attempts
                SET status = %s,
                    current_fen = %s,
                    ply_index = %s,
                    marks = %s,
                    updated_at = now()
                WHERE id = %s
                RETURNING *
                """,
                (next_status, board.fen(), ply_index, marks, attempt["id"]),
            ).fetchone()
            conn.execute(
                """
                INSERT INTO move_events (id, attempt_id, expected_uci, received_uci, move_status, user_move_san, fen_after)
                VALUES (%s, %s, %s, %s, 'Brilliant', %s, %s)
                """,
                (uuid4(), attempt["id"], expected, payload.move, user_san, board.fen()),
            )

            return MoveOut(
                move_status="Solved" if next_status == "solved" else "Brilliant",
                session_status=updated["status"],
                fen=updated["current_fen"],
                ply_index=updated["ply_index"],
                marks=list(updated["marks"]),
                lives_remaining=updated["lives_remaining"],
                user_move_san=user_san,
                system_move_uci=system_move_uci,
                system_move_san=system_move_san,
                locked_until=updated["locked_until"],
                message="Line complete." if next_status == "solved" else "Correct. System move applied.",
            )
