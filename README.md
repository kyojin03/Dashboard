# Academic Affairs — Workload, Task Completion & Extra Work Analytics Dashboard

Internal workload tracking and analytics for the Academic Affairs team. Answers:
**"What was originally assigned, what additional work was performed, what was completed, and what explains the remaining workload?"**

Architecture: **GitHub Pages frontend → Google Apps Script JSON API → Google Sheets.**

- Frontend: `index.html` + `css/` + `js/` (no framework, no `google.script.run`, `fetch()` only)
- Backend: `backend/Code.gs` (Apps Script, deployed as `/exec`)
- Database: Google Sheets (8 sheets, stable headers, position-independent reads)
- Tests: `npm test` — 105 tests, all passing (Node 24: 19 formula/validation + 28 audit regression + 7 personal-dashboard + 18 weekly-process + 10 API-client + 11 UI-wiring + 12 startup-config tests)

## Repository layout

| Path | Purpose |
|---|---|
| `index.html` | Single-page app (My Week, Additional Tasks, Team Overview, Weekly Reports) |
| `css/styles.css` | Institutional responsive theme |
| `js/config.js` | API URL resolution (`?api=` → localStorage → default), session-only keys |
| `js/api.js` | API client — UI/API separation, consistent `{ok,data}` envelope |
| `js/metrics.js` | Shared business logic + formulas (mirrored in `Code.gs`) |
| `js/reports.js` | Client-side reporting calculations |
| `js/store.js` | State + explicit labeled Demo mode (never mixes with production) |
| `js/app.js` | UI rendering and workflows |
| `backend/Code.gs` | Full JSON API: roster, tasks, updates, logs, history, impacts, analytics, reports, snapshots, CSV export |
| `backend/appsscript.json` | Manifest (Asia/Manila, V8) |
| `tests/metrics.test.mjs` | Automated tests (formulas, validation, timezone, carryover, turnaround, snapshots, access) |
| `sample-data/sample-data.json` | Clearly separated sample data (evaluation only) |
| `docs/` | Deployment, security/access-control, and metric definitions |
| `.github/workflows/pages.yml` | GitHub Pages deploy workflow |

## Quick start (5 minutes)

### 1. Backend — Sheets + Apps Script
1. Create a new Google Sheet (e.g. "AA Workload DB").
2. Extensions → Apps Script → delete default file → paste `backend/Code.gs` → copy `backend/appsscript.json` into manifest (Project Settings → show manifest).
3. Project Settings → **Script Properties**, add:
   - `EDIT_KEY` — shared secret required for all write actions (generate a long random string)
   - `ADMIN_KEY` — separate secret for roster/settings (different from `EDIT_KEY`)
   - `TIMEZONE` — `Asia/Manila` (optional, defaults apply)
4. In editor, run `setup()` once (creates all 8 sheets, seeds the 11-member roster + settings). Authorize when prompted.
5. Deploy → New deployment → Web app → Execute as: **Me**, Access: **Anyone** (or domain-limited if available) → copy the `/exec` URL.

### 2. Frontend — GitHub Pages
1. Push this repo to GitHub. Pages workflow (`.github/workflows/pages.yml`) deploys on push to `main`.
2. Settings → Pages → Source: **GitHub Actions**.
3. Open the site — it connects to the live API automatically (the `/exec` URL is fixed in `js/config.js`; override via `?api=` only if the deployment changes). Distribute edit/admin keys to authorized staff **out of band** (never commit them); staff enter a key once per tab when saving.

### 3. Weekly workflow (minimal entry)
Member selector → week → add planned tasks (title is enough) → record additional tasks with time + Yes/No effect on plan → enter one % per planned task at week's end (blank = not yet reported, excluded from the average) with optional incomplete reasons (required only when a cause is attributed, with a link for additional-work causes) → review → Submit Weekly Accomplishment (freezes the week's snapshot; earlier weeks never change) → report/CSV/print. No daily updates or time logs required for planned tasks.

## Team roster (seeded by `setup()`)
Michelle Ann F. Pablo (Director) · Michelle M. Macatangay (Manager) · Divina G. Asuncion · Kathlyn Kate N. Mauricio · Juhayna M. Sultan · Catherine M. Madriaga · Jemima P. Sarmiento · Piolo B. Bernardino · Perly S. Saldivar · Rhea Duremdes · Jerome Balbuena. Roster is editable via Team admin (admin key required). No duties are pre-invented — users add actual assignments.

## Access model (summary)
- **Member selector = view filter, not authentication.** Individual vs team dashboards only change scope.
- **Live first:** the deployed `/exec` URL is fixed in `js/config.js`, so the app opens directly in LIVE MODE. Connection failures show an error with Retry — sample data is never shown automatically (the demo engine has no interface entry).
- **Writes** require the edit key, asked at write time and kept in tab memory only (cleared on refresh, never in localStorage/sessionStorage); verified server-side against Script Properties.
- **Roster changes** (Team Overview, admin key) under the same handling.
- **Preferences** (member, view) persist locally; the week always defaults to current.
- **Read-only** works without any key. Full audit trail in `TaskEvents`. See `docs/SECURITY.md` for limitations (no true identity without organizational SSO) and the safer SSO-migration path.

## Metric definitions (summary)
Count completion = completed eligible ÷ total eligible × 100 (cancelled excluded, planned/additional separate). Weighted = Σ(est × % ÷ 100) ÷ Σ(est) × 100 (tasks without positive estimates excluded and counted). On-time vs original and vs current deadlines (both preserved). Overdue = past current deadline, not completed/cancelled, Asia/Manila date. Same-day = completed on receipt date ÷ completed with timestamps (+ pending count shown). See `docs/METRICS.md` for the full contract.

## Testing
`npm test` — covers validation, completed/cancelled handling, count/weighted/on-time, deadlines + revisions, timezone boundaries, turnaround/aging/same-day, missing data, duplicate guards, history preservation, impacts, snapshots, access boundaries, empty-data/division-by-zero, plus audit regressions: reports.js↔metrics.js mirror consistency, Manila week-start, validate-before-write ordering, single worklog rollup, week-scoped reports, and per-action key enforcement, plus personal-dashboard tests: member-scope isolation, no double counting across members, per-member on-time/turnaround agreement, and clarification flagging, plus weekly-process tests: week separation, average accomplishment, additional-time totals, Yes/No impact documentation, and prior-week report stability, plus startup tests: default live URL, override priority, memory-only keys, preference persistence, and no-demo-fallback guards. Synthetic data only. **Verified: 105/105 pass.**

## What is implemented vs. what remains
- ✅ Data model (8 sheets), backend API (20 actions), locking + idempotency, audit events
- ✅ Task CRUD, daily updates (history-preserving), work logs, impact links, history view, archive
- ✅ Individual + team dashboards, filters, turnaround + workload analytics, data-quality flags
- ✅ Weekly report (personal + team), CSV export, print/PDF layout, idempotent snapshots
- ✅ Direct live startup with Retry on failure (no silent demo fallback), loading/error/success states
- ✅ Audit fixes 2026-10-12: worklog rollup single-count, validate-before-write (no orphan rows/events), `original_due_at` immutable after creation, impact self-link/planned-only enforcement, week-scoped weekly reports, Manila overdue/same-day/week-start in all frontend paths, stable client task ids + double-submit guards, partial-refresh warnings
- ⚠️ **Not verified in this environment:** live Apps Script deployment + real Sheets round-trip (requires Google account + deployment step above); scheduled snapshot trigger (configure per `docs/DEPLOYMENT.md`); organizational SSO (documented migration path in `docs/SECURITY.md`)
- ❌ No individual account registration (by design); no Excel export (CSV + print provided)

## Known limitations
- Shared edit/admin keys are not identity; anyone with the key can edit (keys are server-verified secrets, never in source, but rotate if leaked).
- Working-time turnaround excludes no nights/weekends automatically — elapsed time is reported; waiting periods only when logged.
- Never deploy to production or overwrite live data without explicit approval.
