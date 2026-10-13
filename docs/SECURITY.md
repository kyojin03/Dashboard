# Security & Access-Control Documentation

## Access model (as implemented — OPEN-WRITE MODE since 2026-10-13)

> **Owner decision:** all key requirements were removed so anyone with the link can add and edit freely. Anyone with the `/exec` URL or the site URL can read **and** write every record. Do not use this for sensitive data.

| Capability | Control |
|---|---|
| View individual dashboard (member selector) | Open — **view filter only, not authentication** |
| View team dashboard | Open — read-only view, same data |
| Create/update tasks, daily updates, work logs, impacts, snapshots | **Open** — no key asked, no key checked |
| Roster add/edit, settings save | **Open** — no key asked, no key checked |
| Audit | Every create/update/reassign/deadline-change/completion-change/archive writes to `TaskEvents` with actor + reason |

No secrets exist in the frontend. GET is read-only: write actions over GET return `METHOD_NOT_ALLOWED`. API errors return `{code, message}` only — stack traces and configuration are never leaked. Validation, locking, idempotency, and audit history still apply to every write.

## What was removed (2026-10-13, on owner request)

- `EDIT_KEY` / `ADMIN_KEY` enforcement deleted from `backend/Code.gs` (functions removed; validation/locking/audit untouched).
- The write-time key dialog deleted from `js/app.js`; write gates pass through after the connectivity check.
- No key material was ever in source, and none was added or exposed by this change (verified by scan + tests).

## Key transport and storage (superseded 2026-10-13 — kept for history)

Prior design held keys in page-lifetime memory and sent them in the HTTPS POST body. That entire mechanism is removed: the dialog, the memory holder usage, and both server checks are gone, so there is nothing to transport or store. The XSS posture note still applies generally: all server- and user-supplied strings are HTML-escaped at render (`esc()` in `js/app.js`), and no `innerHTML` path injects raw data.

## Limitations stated explicitly

1. **No access control on writes.** Anyone with the site or API URL can add, edit, archive, or reassign any record, including other members' tasks and the roster. Selecting a name proves nothing and restricts nothing. Mitigations that remain: full audit log (`TaskEvents` records actor + reason), reason required for deadline changes and progress reductions, duplicate-submission guards (`task_id`/`update_id`/`work_log_id` uniqueness + same task/day/percent guard), and Google Sheets version history as the only undo.
2. **No true identity without organizational authentication.** A safer option is documented below. Until adopted, treat reports as *unattributed team records* and restrict the web-app access setting as tightly as the Workspace plan allows (domain-only if available) — that is now the only available boundary.
3. **Anonymous web-app access** (required for public GitHub Pages without Google sign-in) means network-level anonymity. Do not use this for highly sensitive data.

## Safer implementation option (recommended migration)

- Front the API with Google Workspace authentication: deploy the web app with access "Anyone within domain" and read `Session.getActiveUser().getEmail()` server-side; map emails → `member_id` in a private `UserBindings` sheet; authorize writes by binding instead of shared key. Alternatively, migrate the API to Cloud Run + Google Identity (OAuth 2.0) with per-user IAM.
- Then: keep the member selector as a *scope* control but record `actor = authenticated email` in `TaskEvents`, enforce "members edit own tasks unless supervisor role", and move admin to an allowlisted email set instead of `ADMIN_KEY`.

## Operational rules

- The `EDIT_KEY` / `ADMIN_KEY` Script Properties are now unused and can be deleted; leaving them set changes nothing.
- Never silently fall back to localStorage when the server fails — the app shows an explicit error and keeps the last good state in memory only.
- Confirm destructive actions in UI: archival preserves history (rows flagged, not deleted); **Delete forever** (task detail dialog) permanently removes the task plus its updates, logs, and impact links after a confirmation prompt — snapshots intentionally keep old totals, and Sheets version history is the only undo.
- Reads, writes, and CSV exports are all open; the only access boundary left is the web-app "Who has access" setting plus URL obscurity. Prefer domain-restricted access when the Workspace plan allows it, and do not use this for highly sensitive data.
