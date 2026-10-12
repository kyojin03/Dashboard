# Security & Access-Control Documentation

## Access model (as implemented)

| Capability | Control |
|---|---|
| View individual dashboard (member selector) | Open — **view filter only, not authentication** |
| View team dashboard | Open — read-only |
| Create/update tasks, daily updates, work logs, impacts, snapshots | Requires `EDIT_KEY` (sent per-request, verified server-side; stored in `sessionStorage`, never in source) |
| Roster add/edit, settings save | Requires separate `ADMIN_KEY` |
| Audit | Every create/update/reassign/deadline-change/completion-change/archive writes to `TaskEvents` with actor + reason |

Edit and admin keys are compared against **Script Properties** on the server. The frontend never contains secrets. GET is read-only: write actions over GET return `METHOD_NOT_ALLOWED`. API errors return `{code, message}` only — stack traces and configuration are never leaked.

## Key transport and storage (audit 2026-10-12, verified in source)

- Keys travel in the **HTTPS POST body** to `script.google.com` (`js/api.js` uses `Content-Type: text/plain` to avoid CORS preflights; transport encryption comes from TLS). They are never placed in URLs, so they do not land in server logs or browser history.
- Keys are held in **`sessionStorage` (this tab only)**, never `localStorage`, and never written into source, workflow files, or sample config (verified by repo scan — only property *names* appear in docs/code).
- Any script running on the page can read `sessionStorage`, so the XSS posture matters: all server- and user-supplied strings are HTML-escaped at render (`esc()` in `js/app.js`; verified on banners, tables, dialogs, history, and report preview), and no `innerHTML` path injects raw data. There is no evaluated user input.
- The edit key is **not identity**: it authorizes the device/tab, not the person. Member selection never elevates privilege — every mutating action re-checks the key server-side (`tests/audit.test.mjs` pins per-action enforcement), and `TaskEvents` records the claimed actor for later review, not proof of authorship.

## Limitations stated explicitly

1. **A shared edit key is not identity verification.** Anyone who learns the key can submit edits as any member. Selecting a name proves nothing about who is typing. Mitigations in place: keys never in source, session-only storage, separate admin key, full audit log, reason required for deadline changes and progress reductions, duplicate-submission guards (`task_id`/`update_id`/`work_log_id` uniqueness + same task/day/percent guard).
2. **No true identity without organizational authentication.** A safer option is documented below. Until adopted, treat reports as *staff-attested records*, rotate keys when staff change, and restrict the web-app access setting as tightly as the Workspace plan allows (domain-only if available).
3. **Anonymous web-app access** (required for public GitHub Pages without Google sign-in) means network-level anonymity; authorization rests entirely on the keys. Do not use this for highly sensitive data.

## Safer implementation option (recommended migration)

- Front the API with Google Workspace authentication: deploy the web app with access "Anyone within domain" and read `Session.getActiveUser().getEmail()` server-side; map emails → `member_id` in a private `UserBindings` sheet; authorize writes by binding instead of shared key. Alternatively, migrate the API to Cloud Run + Google Identity (OAuth 2.0) with per-user IAM.
- Then: keep the member selector as a *scope* control but record `actor = authenticated email` in `TaskEvents`, enforce "members edit own tasks unless supervisor role", and move admin to an allowlisted email set instead of `ADMIN_KEY`.

## Operational rules

- Never expose edit/admin keys in URLs, screenshots, or repos. Rotate both if leaked (Script Properties → edit → redeploy not required).
- Never silently fall back to localStorage when the server fails — the app shows an explicit error and keeps the last good state in memory only.
- Confirm destructive actions (archive) in UI; archival preserves history (rows are flagged, not deleted).
- Reads and CSV exports are intentionally open (internal read-only dashboard); the access boundary is the unlisted `/exec` URL plus the key gates on writes. Prefer domain-restricted web-app access when the Workspace plan allows it, and do not use this for highly sensitive data.
