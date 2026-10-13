# Metric Definitions & Formulas

All formulas are implemented identically in `js/metrics.js` (frontend/tests) and `backend/Code.gs` (authoritative server). Rounding: one decimal (`round1`). Empty denominators yield `null`, displayed as `—` (never a misleading 0%).

Implementation mirror note (audit 2026-10-12): `js/metrics.js` is the importable ES-module reference used by tests; `js/reports.js` is the browser-global copy actually loaded by `index.html`; `backend/Code.gs` is authoritative. `tests/audit.test.mjs` pins cross-implementation agreement on summarize, overdue, same-day turnaround, and week scope. Keep all three in sync when changing a formula.

## Eligibility
Eligible = not `Cancelled`, not archived. Planned and additional are always measurable separately (`task_type` filter). Statuses: `Not Started, In Progress, Blocked, Completed, Cancelled`.

## A. Count-based completion
`completed eligible ÷ total eligible × 100`. Cancelled excluded from both numerator and denominator; reported separately (visible via status filter). Weekly scope distinguishes **assigned this week** (`created_at` in week) from **carried over** (created before week, still open) — carryover stays visible but is never counted as newly assigned, and a task is never counted twice in one denominator.

## A2. Average planned-task accomplishment (primary Friday metric)
Mean of **reported** percentages across eligible planned tasks: `Σ reported % ÷ number reported`. Each included task contributes equally. Unreported tasks (`completion_percent` empty) are **excluded and disclosed** ("average across 4 reported of 5 planned · 1 not yet reported") — never silently 0%. Reported 0% IS included as zero. No planned tasks (or none reported) → `—`, never division by zero. Cancelled/archived excluded.

## A3. Reported vs unreported (2026-10-13 change)
New tasks default to empty (unreported) until the Friday check-in writes an explicit 0–100. Rows created before this change keep stored `0` (treated as reported zero). Weighted completion likewise excludes unreported tasks from numerator and denominator and counts them as excluded. Requires an Apps Script redeploy (new version, same `/exec` URL) to take effect.
## B. Effort-weighted completion
`Σ(estimated_minutes × completion_percent ÷ 100) ÷ Σ(estimated_minutes) × 100`. Tasks without a valid positive estimate are **excluded and the excluded count is disclosed** in the UI and API. Estimates are never invented.

## C. On-time completion
Two numbers, both preserved: `% completed by original_due_at` and `% completed by current_due_at` (approved revision). Deadline changes require a recorded reason and are audited; the original date is never overwritten.

## D. Overdue
Not `Completed`/`Cancelled` AND `current_due_at` (else `original_due_at`) calendar date < today in the configured zone (default `Asia/Manila`). Tasks with no deadline are never called overdue; they appear under data-quality flags.

## E. Additional workload
Received in period, completed in period, carried over, actual effort (sum of linked `WorkLogs.minutes_spent`), pending + per-task age in days. Task counts are never presented as effort.

## F. Turnaround (additional tasks only)
Per task: received (`created_at`), started (`started_at` when known), completed (`completed_at`), elapsed ms, actual effort, priority, requester, status.
- Average / median over **completed tasks with valid timestamps** (hours, 1-decimal).
- Same-day rate = completed-on-receipt-calendar-date ÷ completed-with-timestamps, **with both numbers shown** plus the pending count.
- Received/completed per day maps; pending aging list; average actual effort per completed task with sample size.
- Missing timestamps → `incompleteData` flag; elapsed and working-time views where start/end or logs exist. Nights/weekends/waiting are not silently counted as active work.

## G2. Friday incomplete reasons (2026-10-13)
Reason choices: none (default, allowed) · additional task · waiting · insufficient time · technical · other. Any chosen cause requires a short explanation; `additional` additionally requires the linked additional task (same reporting week, validated both client- and server-side) and an effect choice (delayed / less time / prevented). Storage: category label → `Tasks.impact_reason`, explanation → `Tasks.impact_notes`, links → `TaskImpacts` rows (created only on explicit Yes). 100% tasks take no incomplete reason. Hours alone never create a link.
## G. Impacts
`TaskImpacts` links one `ADDITIONAL` task → one affected planned task with `impact_type` (`No Impact, Delayed, Paused, Scope Changed, Dependency Affected`), estimated/actual delay minutes, reason, and evidence notes. **Actual delay is recorded, never auto-derived from additional-task duration.** The weekly impact summary lists delayed/paused originals, linked additional tasks, actual effort, recorded delays, items awaiting clarification, and recurring-interruption patterns — without inferring causation from correlation.

## I. Weekly report scope
The weekly report (like team analytics) counts only tasks **created, due, or completed in the reporting week, plus open carryover** — never all-time totals. Impacts shown are those touching in-scope tasks (member reports further narrow to that member's tasks). Updates, work logs, and completed-this-week lists are week-filtered. This prevents prior weeks' volume from inflating "received this week".
## H. Snapshots
`buildSnapshot` / `createSnapshot_` store frozen weekly results per `week_start + member_id`. Regeneration **updates the identified snapshot** (idempotent), never duplicates. History tables (`DailyUpdates`, `TaskEvents`, `WorkLogs`) are append-only; progress edits add rows rather than rewriting the past.
