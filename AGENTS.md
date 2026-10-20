# AGENTS.md

## Architecture
- `public/index.html` — the whole UI (desk board, login, admin, money popup). Vanilla JS, no framework or build step. Talks to `/api/*` via `fetch`.
- `public/audio/money-money-money.mp3` — the popup song.
- `netlify/functions/api.ts` — single function routed at `/api/*`:
  - `GET /api/board?after=<depositId>` (public) — agents plus deposits newer than `after`; the board polls this every 3 s and shows the popup for each new deposit.
  - `POST /api/login` — checks `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars (default admin/admin), returns an HMAC-signed bearer token (12 h).
  - Admin-only (Bearer token): `POST /api/agents`, `DELETE /api/agents/:id`, `POST /api/deposits`, `POST /api/import`, `DELETE /api/data`.
- `db/schema.ts` — Drizzle schema (`agents`, `deposits`). Money stored as integer cents. Migrations live in `netlify/database/migrations/` (generate with `npx drizzle-kit generate --name <name>`; never apply manually).

## Conventions / decisions
- The API returns money as dollars (number); the DB stores cents.
- The admin's own top up shows the popup immediately and advances `lastDepositId` so polling does not repeat it.
- Popups queue if several deposits arrive together; each lasts 15 s or until closed (button / Esc).
- Admin token lives in `sessionStorage`; a 401 sends the admin back to the login screen.
