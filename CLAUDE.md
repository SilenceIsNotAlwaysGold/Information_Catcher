# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LittleCrawler / Pulse** — three concerns in one repo:
1. **Crawler engine** (`src/`, `main.py`) — async Playwright-based scraper for XHS, XHY, Zhihu
2. **Pulse API** (`api/`) — FastAPI monitoring/publishing backend
3. **Pulse Dashboard** (`web/`) — Next.js 14 static SPA served by FastAPI

Default credentials: `admin` / `admin123`

---

## Development Commands

### Python backend

```bash
# Install dependencies
uv sync

# Start full service (API + compiled frontend) at http://127.0.0.1:8080
uv run uvicorn api.main:app --port 8080 --reload

# Start API only (no frontend, useful during frontend dev)
API_ONLY=1 uv run uvicorn api.main:app --port 8080 --reload

# Run crawler manually
uv run python main.py --platform xhs --type search
uv run python main.py --help

# Init SQLite database
uv run python main.py --init-db sqlite
```

### Frontend

```bash
cd web

# Dev server at http://127.0.0.1:3000 (proxies API to :8080)
npm run dev

# Production build — outputs to api/ui/ (served statically by FastAPI)
npm run build

# Lint
npm run lint
```

### Type checking / tests

```bash
# Run all tests
uv run pytest

# Run a single test file
uv run pytest tests/path/to/test_file.py

# Type check
uv run mypy .
```

---

## Architecture

### Backend layer separation

| Layer | Path | Responsibility |
|-------|------|---------------|
| Crawler engine | `src/platforms/{xhs,xhy,zhihu}/` | Playwright-based public scraping |
| FastAPI routers | `api/routers/` | HTTP + WebSocket endpoints |
| Business services | `api/services/` | Auth, scheduler, monitor DB, notifiers |
| Monitor fetchers | `api/services/platforms/{xhs,douyin,mp}/` | Periodic detail-page fetching for Pulse monitoring |

**Important distinction**: `src/platforms/` is the standalone crawler. `api/services/platforms/` is the separate monitor fetcher used by APScheduler jobs — they are different codebases for different purposes.

### Databases

Two SQLite files, never mixed:
- `database/users.db` — user accounts, JWT secret; accessed via synchronous `sqlite3` in `api/services/auth_service.py`
- `database/monitor.db` — posts, snapshots, alerts, accounts, settings; accessed via async `aiosqlite` in `api/services/monitor_db.py`

### Platform abstraction (monitor side)

`api/services/platforms/base.py` defines the `Platform` ABC with three core methods:
- `resolve_url(raw_url)` — parse a user-pasted URL into a post metadata dict
- `fetch_detail(post, account=None)` — fetch metrics; `account=None` uses anonymous channel
- `search_trending(keyword, account, min_likes)` — optional, raises `NotImplementedError` if unsupported

Registered in `api/services/platforms/__init__.py`. To add a platform: implement `Platform`, add to `_REGISTRY`.

### Scheduler jobs (APScheduler, `api/services/scheduler.py`)

| Job | Trigger | Description |
|-----|---------|-------------|
| `run_monitor` | every N min (default 30) | Check all active monitored posts, send alerts |
| `run_trending_monitor` | every N min | Keyword search + store hot posts |
| `run_own_comments_check` | every N min | Pull comments for posts bound to an account |
| `run_creator_check` | every 6h | Subscribe to creator new posts |
| `run_live_check` | every 5 min | Douyin live room online count |
| `run_cookie_health_check` | every 6h (cron) | Validate all account cookies |
| `run_daily_report` | daily at configured time | Per-user × per-group daily stats |

All intervals and settings are persisted in `monitor_settings` table and hot-reloaded via `scheduler.reschedule()`.

### Multi-tenant model

Each user (`users.db`) owns:
- Their own `wecom_webhook_url` / `feishu_webhook_url` for alert delivery
- Monitor posts tagged with `user_id`
- Alert rules scoped to groups, which fall back to per-user then global settings

Admin users can see all posts/alerts across tenants.

### Frontend (Next.js 14)

- **Static export** (`output: 'export'`) — `npm run build` copies output to `api/ui/`, which FastAPI serves
- **No SSR** — all data fetching is client-side via SWR (`web/src/lib/useApi.ts`)
- **API base URL** — always relative (`/api/...`), no env config needed
- **SWR shared cache** — `web/src/lib/useApi.ts` exports `usePosts`, `useAccounts`, `useGroups`, `useAlerts`, `useLives`; the dashboard layout pre-warms all five on mount to avoid per-page loading flashes
- **Auth** — JWT stored in `localStorage`, sent as `Authorization: Bearer <token>`, 401 redirects to `/login`
- **UI library** — NextUI v2 + Tailwind CSS + lucide-react icons

### Frontend development workflow

During frontend dev: run `API_ONLY=1 uv run uvicorn api.main:app --port 8080 --reload` alongside `cd web && npm run dev`. The Next.js dev server at `:3000` calls the API at `:8080` directly (CORS is open in dev). After `npm run build`, the compiled output lands in `api/ui/` and FastAPI serves everything from `:8080`.
