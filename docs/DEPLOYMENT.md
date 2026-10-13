# Deployment Guide

## A. Google Sheets + Apps Script backend

1. **Create the database.** New Google Sheet → name it (e.g. `AA Workload DB`). Note: the script uses the *bound* spreadsheet (`getActiveSpreadsheet()`), so paste the code into that file's Apps Script project.
2. **Install the backend.** Extensions → Apps Script → replace `Code.gs` with `backend/Code.gs`. If the project shows `appsscript.json`, replace it with `backend/appsscript.json` (Project Settings → check "Show appsscript.json").
3. **Script Properties** (Project Settings → Script Properties). Required:
   | Key | Value | Notes |
   |---|---|---|
   | `EDIT_KEY` | long random string | Required for every write action |
   | `ADMIN_KEY` | different long random string | Required for roster + settings |
   | `TIMEZONE` | `Asia/Manila` | Optional; code default is Asia/Manila |
   | `WEEK_START_DAY` | `MON` | Optional; reporting week Mon–Sun |
   Generate with e.g. `openssl rand -base64 32`. Never commit these values.
4. **Initialize.** In the editor's function dropdown select `setup` → Run → authorize. This creates `TeamMembers, Tasks, DailyUpdates, WorkLogs, TaskEvents, TaskImpacts, WeeklySnapshots, Settings`, seeds the 11-member roster and default settings. Re-running is safe (no duplicates: roster seeding skips when populated; headers migrate by adding missing columns).
5. **Deploy.** Deploy → New deployment → type **Web app** → Execute as: **Me** → Who has access: **Anyone** (use domain-restricted access if your Workspace plan offers it) → Deploy → copy the `/exec` URL.
6. **Update the API without breaking clients.** Deploy → Manage deployments → Edit (new version). The `/exec` URL stays stable.
7. **Backend change 2026-10-13 (unreported default + weighted exclusion).** After pulling the latest `backend/Code.gs`, deploy a **new version** of the existing deployment (same `/exec` URL — no frontend change needed). Until redeployed, new tasks default to 0% (reported-zero interpretation) and weighted completion counts them at 0. No sheet migration needed: no columns added; `ensureSchema_()` is additive-only and `setup()` never deletes data.
8. **Weekly snapshot trigger (optional but recommended).** In Apps Script: Triggers → Add trigger → function `scheduledWeeklySnapshot` → time-driven → every Monday ~06:00 Asia/Manila. The function is **idempotent**: it updates the existing snapshot for the same `week_start + member_id` instead of creating duplicates.

## B. GitHub Pages frontend

1. Push this repo to GitHub (`main` branch).
2. Repo Settings → Pages → Source: **GitHub Actions**. The bundled workflow deploys the repo root (which contains `index.html` + `.nojekyll`).
3. Project-site base paths work out of the box (all asset URLs are relative: `./css/…`, `./js/…`).
4. **Configure the API URL** (no secrets in source): open the live site → Config → paste the `/exec` URL → Save & connect. Resolution order: `?api=` query param → `localStorage aa_api_base` → `APP_CONFIG.API_BASE_URL` default. To bake in a default, a maintainer edits `js/config.js` (URL only — never keys).
5. Share keys **out of band** (password manager / sealed envelope). Staff enter them in Config; they live in `sessionStorage` (this tab only) and are sent with write requests.

## C. Verification checklist

- [ ] `?action=ping` on the `/exec` URL returns `{"ok":true,…}`.
- [ ] Frontend Config → Test connection → "Connection OK".
- [ ] Create a test task → update to 100% with outcome note → history shows events.
- [ ] Weekly report generates; CSV export downloads; print preview is clean.
- [ ] `npm test` passes (47/47).
- [ ] Demo banner shows in demo mode; live banner shows after connecting; server failures show an error banner (never silent local fallback).
