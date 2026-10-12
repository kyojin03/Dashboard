/**
 * Shared business logic — Academic Affairs Workload Dashboard.
 * Pure functions with NO DOM / fetch dependencies so the same formulas
 * can run in the browser AND be mirrored in Google Apps Script (Code.gs).
 * All time-zone handling defaults to Asia/Manila but accepts an IANA zone.
 *
 * Conventions:
 *  - completion_percent is 0..100 (clamped)
 *  - estimated_minutes / actual_minutes are non-negative integers or null
 *  - status ∈ Not Started | In Progress | Blocked | Completed | Cancelled
 *  - task_type ∈ PLANNED | ADDITIONAL
 *  - Dates are ISO-8601 strings; null when unknown.
 */

export const STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Completed', 'Cancelled'];
export const TASK_TYPES = ['PLANNED', 'ADDITIONAL'];
export const IMPACT_TYPES = ['No Impact', 'Delayed', 'Paused', 'Scope Changed', 'Dependency Affected'];
export const DEFAULT_TIMEZONE = 'Asia/Manila';

/** Clamp progress to 0–100 and coerce to a finite number. */
export function clampPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n * 100) / 100;
}

/** Non-negative finite minutes or null when missing/invalid. */
export function normalizeMinutes(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

export function round1(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return null;
  return Math.round(Number(n) * 10) / 10;
}

/**
 * Validate a task object. Returns { ok, errors[] }.
 * Mirrors server-side validation in Code.gs::validateTask_.
 */
export function validateTask(t, opts = {}) {
  const errors = [];
  const requireOutcomeOnComplete = opts.requireOutcomeOnComplete !== false;
  if (!t || typeof t !== 'object') return { ok: false, errors: ['Task must be an object.'] };
  if (!t.title || !String(t.title).trim()) errors.push('Title is required.');
  if (t.task_type && !TASK_TYPES.includes(t.task_type)) errors.push('task_type must be PLANNED or ADDITIONAL.');
  if (t.status && !STATUSES.includes(t.status)) errors.push(`Invalid status: ${t.status}.`);
  const pct = t.completion_percent;
  if (pct !== undefined && pct !== null) {
    const n = Number(pct);
    if (!Number.isFinite(n) || n < 0 || n > 100) errors.push('completion_percent must be between 0 and 100.');
  }
  // Status / percent combinations
  if (t.status === 'Completed' && Number(t.completion_percent) !== 100) {
    errors.push('Completed tasks must have completion_percent = 100.');
  }
  if (t.status === 'Completed' && !t.completed_at) {
    errors.push('Completed tasks must have completed_at timestamp.');
  }
  if (t.status !== 'Completed' && Number(t.completion_percent) === 100 && t.status !== 'Cancelled') {
    errors.push('Only Completed tasks may have 100% completion (or Cancel the task).');
  }
  if (t.status === 'Cancelled' && t.completed_at) {
    errors.push('Cancelled tasks must not have completed_at.');
  }
  for (const f of ['estimated_minutes', 'actual_minutes']) {
    if (t[f] !== undefined && t[f] !== null && t[f] !== '') {
      const n = Number(t[f]);
      if (!Number.isFinite(n) || n < 0) errors.push(`${f} must be a non-negative number.`);
    }
  }
  if (requireOutcomeOnComplete && t.status === 'Completed') {
    const note = (t.impact_notes || t.description || '') + '|' + (opts.outcomeNote || '');
    if (!opts.outcomeNote && !t._outcomeNote) {
      // Caller can pass outcomeNote explicitly; Tasks sheet stores outcome in
      // DailyUpdates.accomplishment_notes, so frontend must supply one.
      // We only warn here — server enforces when configured.
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Eligible tasks exclude Cancelled. Optionally filter by type. */
export function eligibleTasks(tasks, taskType = null) {
  return (tasks || []).filter((t) => {
    if (!t || t.status === 'Cancelled') return false;
    if (t.archived_at) return false;
    if (taskType && t.task_type !== taskType) return false;
    return true;
  });
}

/**
 * Count-based completion: completed eligible / total eligible * 100.
 * Returns { percent|null, completed, total } — percent null when total=0.
 */
export function countCompletion(tasks) {
  const elig = eligibleTasks(tasks);
  const total = elig.length;
  if (total === 0) return { percent: null, completed: 0, total: 0 };
  const completed = elig.filter((t) => t.status === 'Completed').length;
  return { percent: round1((completed / total) * 100), completed, total };
}

/**
 * Effort-weighted completion: SUM(est * pct/100)/SUM(est)*100.
 * Excludes tasks without positive estimates; reports excludedCount.
 */
export function weightedCompletion(tasks) {
  const elig = eligibleTasks(tasks);
  let num = 0;
  let den = 0;
  let excludedCount = 0;
  for (const t of elig) {
    const est = Number(t.estimated_minutes);
    if (!Number.isFinite(est) || est <= 0) {
      excludedCount++;
      continue;
    }
    num += est * (clampPercent(t.completion_percent) / 100);
    den += est;
  }
  if (den === 0) return { percent: null, excludedCount, includedCount: 0 };
  return { percent: round1((num / den) * 100), excludedCount, includedCount: elig.length - excludedCount };
}

/** Monday-based week key helpers (ISO date strings YYYY-MM-DD). */
export function mondayOf(dateStr, timeZone = DEFAULT_TIMEZONE) {
  const d = new Date(dateStr.length <= 10 ? dateStr + 'T12:00:00' : dateStr);
  // Work in the target zone by using locale parts
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const local = new Date(parts + 'T12:00:00Z');
  const day = new Date(dateStr.length <= 10 ? dateStr + 'T12:00:00Z' : new Date(dateStr).toISOString());
  // Simpler robust approach: use Manila wall-clock via Intl weekday
  const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(d);
  const offset = { Sun: 6, Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5 }[wd] ?? 0;
  const base = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  // Fallback straightforward: compute from UTC date minus offset
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Use Intl-derived offset
  utc.setUTCDate(utc.getUTCDate() - offset);
  return utc.toISOString().slice(0, 10);
}

export function weekRange(weekStartISO) {
  const s = new Date(weekStartISO + 'T00:00:00Z');
  const e = new Date(s);
  e.setUTCDate(e.getUTCDate() + 6);
  return { week_start: s.toISOString().slice(0, 10), week_end: e.toISOString().slice(0, 10) };
}

export function inWeek(dateISO, weekStartISO) {
  if (!dateISO) return false;
  const day = String(dateISO).slice(0, 10);
  const { week_start, week_end } = weekRange(weekStartISO);
  return day >= week_start && day <= week_end;
}

/**
 * Split tasks for a reporting week:
 *  - assignedThisWeek: created_at in week
 *  - carriedOver: created before week AND not completed/cancelled before week
 */
export function splitCarryover(tasks, weekStartISO) {
  const { week_start } = weekRange(weekStartISO);
  const assignedThisWeek = [];
  const carriedOver = [];
  for (const t of tasks || []) {
    const created = String(t.created_at || '').slice(0, 10);
    if (created && created >= week_start && inWeek(t.created_at, weekStartISO)) assignedThisWeek.push(t);
    else if (created && created < week_start) carriedOver.push(t);
    else if (!created) carriedOver.push(t); // missing timestamp → flag, treat as carryover, never double count
  }
  return { assignedThisWeek, carriedOver };
}

/** A task is overdue when not completed/cancelled and current due date passed (zone-aware calendar date). */
export function isOverdue(task, nowISO = new Date().toISOString(), timeZone = DEFAULT_TIMEZONE) {
  if (!task || task.status === 'Completed' || task.status === 'Cancelled') return false;
  const due = task.current_due_at || task.original_due_at;
  if (!due) return false;
  const dueDay = String(due).slice(0, 10);
  const nowDay = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(nowISO));
  return nowDay > dueDay;
}

/**
 * On-time completion: % of eligible tasks completed by ORIGINAL deadline,
 * plus % completed by CURRENT (approved) deadline. Preserves both.
 */
export function onTimeCompletion(tasks) {
  const elig = eligibleTasks(tasks).filter((t) => t.status === 'Completed' && t.completed_at);
  const withOriginal = elig.filter((t) => t.original_due_at);
  const onTimeOriginal = withOriginal.filter((t) => String(t.completed_at).slice(0, 10) <= String(t.original_due_at).slice(0, 10));
  const withCurrent = elig.filter((t) => t.current_due_at || t.original_due_at);
  const onTimeCurrent = withCurrent.filter((t) => {
    const due = t.current_due_at || t.original_due_at;
    return String(t.completed_at).slice(0, 10) <= String(due).slice(0, 10);
  });
  const pct = (a, b) => (b === 0 ? null : round1((a / b) * 100));
  return {
    original: { percent: pct(onTimeOriginal.length, withOriginal.length), onTime: onTimeOriginal.length, total: withOriginal.length },
    current: { percent: pct(onTimeCurrent.length, withCurrent.length), onTime: onTimeCurrent.length, total: withCurrent.length },
  };
}

// ---------- Additional-task turnaround ----------

function msBetween(a, b) {
  if (!a || !b) return null;
  const x = new Date(a).getTime();
  const y = new Date(b).getTime();
  if (!Number.isFinite(x) || !Number.isFinite(y) || y < x) return null;
  return y - x;
}

/** Elapsed turnaround per additional task (ms) or null when timestamps missing. */
export function turnaroundMs(task) {
  if (!task || task.task_type !== 'ADDITIONAL') return null;
  if (!task.created_at || !task.completed_at) return null;
  return msBetween(task.created_at, task.completed_at);
}

/** Same calendar-date test in a zone (YYYY-MM-DD compare). */
export function sameCalendarDate(aISO, bISO, timeZone = DEFAULT_TIMEZONE) {
  if (!aISO || !bISO) return false;
  const f = (v) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(v));
  try {
    return f(aISO) === f(bISO);
  } catch {
    return String(aISO).slice(0, 10) === String(bISO).slice(0, 10);
  }
}

function median(sortedNums) {
  if (!sortedNums.length) return null;
  const m = Math.floor(sortedNums.length / 2);
  if (sortedNums.length % 2 === 1) return sortedNums[m];
  return (sortedNums[m - 1] + sortedNums[m]) / 2;
}

function mean(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Turnaround analytics over additional tasks in scope.
 * - avg/median over COMPLETED tasks with valid timestamps (flag incompleteData)
 * - sameDayRate: completed-on-receipt-date / completed-with-timestamps
 * - pendingAgingDays: per pending task age in days
 * - receivedPerDay / completedPerDay maps
 */
export function turnaroundStats(additionalTasks, opts = {}) {
  const timeZone = opts.timeZone || DEFAULT_TIMEZONE;
  const now = opts.nowISO || new Date().toISOString();
  const list = (additionalTasks || []).filter((t) => t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled' && !t.archived_at);
  const completed = list.filter((t) => t.status === 'Completed' && t.completed_at);
  const withTimes = completed
    .map((t) => ({ t, ms: turnaroundMs(t) }))
    .filter((x) => x.ms !== null);
  const incompleteData = completed.length - withTimes.length;
  const msVals = withTimes.map((x) => x.ms).sort((a, b) => a - b);
  const sameDay = withTimes.filter((x) => sameCalendarDate(x.t.created_at, x.t.completed_at, timeZone)).length;
  const pending = list.filter((t) => t.status !== 'Completed');
  const aging = pending.map((t) => {
    const ms = msBetween(t.created_at || t.current_due_at || now, now);
    return { task_id: t.task_id, title: t.title, ageDays: ms === null ? null : round1(ms / 86400000), created_at: t.created_at, status: t.status };
  });
  const byDay = (arr, field) => {
    const m = {};
    for (const t of arr) {
      if (!t[field]) continue;
      const d = String(t[field]).slice(0, 10);
      m[d] = (m[d] || 0) + 1;
    }
    return m;
  };
  const efforts = completed.map((t) => Number(t.actual_minutes)).filter((n) => Number.isFinite(n) && n >= 0);
  return {
    total: list.length,
    completed: completed.length,
    pending: pending.length,
    avgTurnaroundMs: msVals.length ? mean(msVals) : null,
    medianTurnaroundMs: msVals.length ? median(msVals) : null,
    avgTurnaroundHours: msVals.length ? round1(mean(msVals) / 3600000) : null,
    medianTurnaroundHours: msVals.length ? round1(median(msVals) / 3600000) : null,
    sameDayCompleted: sameDay,
    sameDayDenominator: withTimes.length,
    sameDayRate: withTimes.length ? round1((sameDay / withTimes.length) * 100) : null,
    incompleteData,
    receivedPerDay: byDay(list, 'created_at'),
    completedPerDay: byDay(completed, 'completed_at'),
    pendingAging: aging,
    avgEffortMinutes: efforts.length ? round1(mean(efforts)) : null,
    effortSampleSize: efforts.length,
  };
}

/** Additional-workload summary for a period (caller pre-filters by week if needed). */
export function additionalWorkloadSummary(tasks, workLogs, weekStartISO = null) {
  const inScope = (iso) => (weekStartISO ? inWeek(iso, weekStartISO) : true);
  const adds = (tasks || []).filter((t) => t.task_type === 'ADDITIONAL' && !t.archived_at && t.status !== 'Cancelled');
  const received = adds.filter((t) => inScope(t.created_at));
  const completed = adds.filter((t) => t.status === 'Completed' && t.completed_at && inScope(t.completed_at));
  const carried = weekStartISO ? adds.filter((t) => String(t.created_at || '').slice(0, 10) < weekRange(weekStartISO).week_start && t.status !== 'Completed') : [];
  const logs = (workLogs || []).filter((l) => inScope(l.work_date || l.created_at));
  const addIds = new Set(received.map((t) => t.task_id).concat(adds.map((t) => t.task_id)));
  const effort = logs.filter((l) => addIds.has(l.task_id)).reduce((s, l) => s + (Number(l.minutes_spent) || 0), 0);
  return {
    receivedCount: received.length,
    completedCount: completed.length,
    carriedOverCount: carried.length,
    pendingCount: adds.filter((t) => t.status !== 'Completed').length,
    effortMinutes: effort,
  };
}

/** Validate a work-log entry (no negative time, end after start). */
export function validateWorkLog(l) {
  const errors = [];
  if (!l.task_id) errors.push('task_id is required.');
  if (!l.member_id) errors.push('member_id is required.');
  if (l.start_time && l.end_time) {
    const a = new Date(l.start_time).getTime();
    const b = new Date(l.end_time).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) errors.push('Invalid start/end time.');
    else if (b < a) errors.push('end_time must not be before start_time.');
  }
  const m = Number(l.minutes_spent);
  if (l.minutes_spent !== undefined && l.minutes_spent !== null && l.minutes_spent !== '') {
    if (!Number.isFinite(m) || m < 0 || m > 1440) errors.push('minutes_spent must be between 0 and 1440.');
  }
  return { ok: errors.length === 0, errors };
}

/** Weekly snapshot builder — pure, deterministic. */
export function buildSnapshot({ weekStartISO, memberId, tasks, workLogs, nowISO, timeZone }) {
  const tz = timeZone || DEFAULT_TIMEZONE;
  const now = nowISO || new Date().toISOString();
  const mine = (tasks || []).filter((t) => !memberId || t.owner_id === memberId);
  const planned = mine.filter((t) => t.task_type === 'PLANNED');
  const adds = mine.filter((t) => t.task_type === 'ADDITIONAL');
  const cc = countCompletion(planned);
  const wc = weightedCompletion(planned);
  const add = additionalWorkloadSummary(mine, (workLogs || []).filter((l) => !memberId || l.member_id === memberId), weekStartISO);
  const overdue = mine.filter((t) => isOverdue(t, now, tz)).length;
  const blocked = eligibleTasks(mine).filter((t) => t.status === 'Blocked').length;
  return {
    week_start: weekRange(weekStartISO).week_start,
    week_end: weekRange(weekStartISO).week_end,
    member_id: memberId || 'ALL',
    planned_task_count: cc.total,
    completed_planned_count: cc.completed,
    planned_completion_percent: cc.percent,
    weighted_completion_percent: wc.percent,
    additional_task_count: add.receivedCount,
    additional_completed_count: add.completedCount,
    additional_effort_minutes: add.effortMinutes,
    overdue_count: overdue,
    blocked_count: blocked,
    generated_at: now,
  };
}

export function msToHours(ms) {
  if (ms === null || ms === undefined) return null;
  return round1(ms / 3600000);
}
