# Deployment Guide

## A. Google Sheets + Apps Script backend

1. **Create the database.** New Google Sheet → name it (e.g. `AA Workload DB`). Note: the script uses the *bound* spreadsheet (`getActiveSpreadsheet()`), so paste the code into that file's Apps Script project.
2. **Install the backend.** Extensions → Apps Script → replace `Code.gs` with `backend/Code.gs`. If the project shows `appsscript.json`, replace it with `backend/appsscript.json` (Project Settings → check "Show appsscript.json").
3. **Script Properties** (Project Settings → Script Properties). Optional:
   | Key | Value | Notes |
   |---|---|---|
   | `TIMEZONE` | `Asia/Manila` | Optional; code default is Asia/Manila |
   | `WEEK_START_DAY` | `MON` | Optional; reporting week Mon–Sun |
   (`EDIT_KEY` / `ADMIN_KEY` are no longer enforced since 2026-10-13; leftover values are ignored. Restrict "Who has access" instead if writes must be limited.)
4. **Initialize.** In the editor's function dropdown select `setup` → Run → authorize. This creates `TeamMembers, Tasks, DailyUpdates, WorkLogs, TaskEvents, TaskImpacts, WeeklySnapshots, Settings`, seeds the 11-member roster and default settings. Re-running is safe (no duplicates: roster seeding skips when populated; headers migrate by adding missing columns).
5. **Deploy.** Deploy → New deployment → type **Web app** → Execute as: **Me** → Who has access: **Anyone** (use domain-restricted access if your Workspace plan offers it) → Deploy → copy the `/exec` URL.
6. **Update the API without breaking clients.** Deploy → Manage deployments → Edit (new version). The `/exec` URL stays stable.
7. **Backend change 2026-10-13 (unreported default + weighted exclusion).** After pulling the latest `backend/Code.gs`, deploy a **new version** of the existing deployment (same `/exec` URL — no frontend change needed). Until redeployed, new tasks default to 0% (reported-zero interpretation) and weighted completion counts them at 0. No sheet migration needed: no columns added; `ensureSchema_()` is additive-only and `setup()` never deletes data.
8. **Weekly snapshot trigger (optional but recommended).** In Apps Script: Triggers → Add trigger → function `scheduledWeeklySnapshot` → time-driven → every Monday ~06:00 Asia/Manila. The function is **idempotent**: it updates the existing snapshot for the same `week_start + member_id` instead of creating duplicates.

## B. GitHub Pages frontend

1. Push this repo to GitHub (`main` branch).
2. Repo Settings → Pages → Source: **GitHub Actions**. The bundled workflow deploys the repo root (which contains `index.html` + `.nojekyll`).
3. Project-site base paths work out of the box (all asset URLs are relative: `./css/…`, `./js/…`).
4. **No API configuration needed.** The deployed `/exec` URL is fixed in `js/config.js`, so the site opens directly in LIVE MODE. Override only if the deployment changes via the `?api=` query parameter.
5. No keys to distribute — saving is open. If writes must be limited, restrict the deployment's "Who has access" setting instead.

## C. Verification checklist

- [ ] `?action=ping` on the `/exec` URL returns `{"ok":true,…}`.
- [ ] Frontend opens directly in LIVE MODE with no setup prompt; killing the network shows an error banner with Retry (never demo data).
- [ ] Create a test task → update to 100% with outcome note → history shows events.
- [ ] Weekly report generates; CSV export downloads; print preview is clean.
- [ ] `npm test` passes (113/113).
- [ ] Live banner shows after connecting; server failures show an error banner with Retry (never silent demo fallback).
