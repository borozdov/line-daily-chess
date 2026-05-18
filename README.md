# Линия

Standalone web app for a daily chess puzzle with server-side move validation.

## Stack

- Frontend: Vite, React, TypeScript, chess.js, react-chessboard
- Backend: FastAPI, python-chess, JWT guest sessions
- Database: PostgreSQL
- Delivery: Docker Compose with API, DB, and Nginx web container
- PWA: manifest, icon, service worker

## Local Development

Install frontend dependencies:

```bash
npm install
```

Start PostgreSQL and API:

```bash
docker compose up db api
```

Start Vite:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Full Container Run

```bash
docker compose up --build
```

Open `http://localhost:8080`.

## Data

The production seed lives in `backend/app/seed_puzzles.json`: 90 daily puzzles generated from the local Lichess puzzle CSV.

The source file is the official Lichess puzzle database:

- Page: https://database.lichess.org/#puzzles
- Direct download: https://database.lichess.org/lichess_db_puzzle.csv.zst

The raw CSV is intentionally not committed to Git because it is large. Download and unpack it next to this repository:

```bash
curl -L -o ../lichess_db_puzzle.csv.zst https://database.lichess.org/lichess_db_puzzle.csv.zst
zstd -d --force ../lichess_db_puzzle.csv.zst -o ../lichess_db_puzzle.csv
```

On macOS, install `zstd` first if needed:

```bash
brew install zstd
```

Regenerate it from `../lichess_db_puzzle.csv`:

```bash
npm run seed
```

The seed generator currently selects rated puzzles with these filters:

- rating 2000-3000
- popularity at least 92
- rating deviation at most 90
- at least 1000 plays
- solution lengths of 4, 6, 8, or 10 UCI moves
- no one-move puzzles
- varied tactical themes and rating buckets

Lichess puzzle rows store `FEN` before the opponent move. The seed generator applies the first UCI move and stores `initial_fen`, so the frontend receives the position where the user starts solving.

## API

- `GET /api/session` creates or refreshes an anonymous guest JWT.
- `GET /api/daily` returns the current puzzle state for the guest.
- `POST /api/move` validates a UCI move on the backend and applies the system reply when the move is correct.
- `GET /api/health` returns API health.

Wrong legal moves are treated as `Blunder` by default because `MAX_INACCURACIES=0`.
