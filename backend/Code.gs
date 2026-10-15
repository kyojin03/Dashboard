/**
 * Academic Affairs Workload Dashboard — Google Apps Script JSON API backend (v2).
 *
 * Frontend talks to this API ONLY via fetch(). All validation + calculations
 * happen here. Send POST bodies as Content-Type "text/plain;charset=utf-8"
 * (Apps Script cannot answer CORS preflight requests).
 *
 * ---------------------------------------------------------------------------
 * DEPLOY
 *   1. Project Settings → show appsscript.json and set:
 *        "timeZone": "Asia/Manila", "runtimeVersion": "V8"
 *   2. Deploy → Web app → Execute as: Me, Access: Anyone → copy the /exec URL.
 *   3. Run setup() once, then migrateSheetsToPlainText() once (existing data).
 *   4. Optional: run installWeeklyTrigger() once (Friday 18:00 snapshot).
 *
 * SCRIPT PROPERTIES (Project Settings → Script Properties) — all optional
 *   TIMEZONE          default Asia/Manila (overrides the Settings sheet)
 *   AUTH_MODE         "open" (default) | "google"
 *   GOOGLE_CLIENT_ID  OAuth client ID of the frontend (required if google)
 *   ADMIN_EMAILS      comma-separated admin emails (google mode)
 *   ROSTER_JSON       JSON array of {member_id, display_name, role, department,
 *                     email} used ONLY to seed an empty TeamMembers sheet.
 *                     (Keeps staff names out of source control.)
 *
 * AUTH MODES
 *   open   — owner decision 2026-10-13: anyone with the /exec URL can read AND
 *            write. The actor in audit rows is CLIENT-SUPPLIED and therefore
 *            unverified. Validation, locking, idempotency and history still apply.
 *   google — frontend sends a Google ID token as `idToken` (POST body field, or
 *            GET param). The server verifies it, maps the email to a roster
 *            member (TeamMembers.email), derives the actor itself, lets members
 *            write only their own work, and restricts delete / roster /
 *            settings / snapshots / export to ADMIN_EMAILS.
 *            (First deploy with this code asks to authorize "external requests".)
 * ---------------------------------------------------------------------------
 */

const API_VERSION = '2.1.0';
const SCHEMA_CACHE_KEY = 'schema_ok_v2';
const MEMO_ = {}; // per-execution memo

/* ============================== Schema & constants ============================== */

const SCHEMA = {
  TeamMembers: ['member_id', 'display_name', 'role', 'department', 'is_active', 'created_at', 'email'],
  Tasks: ['task_id', 'title', 'description', 'owner_id', 'task_type', 'requested_by',
    'created_at', 'started_at', 'original_due_at', 'current_due_at', 'completed_at',
    'priority', 'status', 'completion_percent', 'estimated_minutes', 'actual_minutes',
    'blocked_reason', 'impact_reason', 'impact_notes', 'created_by', 'last_updated_at', 'archived_at'],
  DailyUpdates: ['update_id', 'task_id', 'member_id', 'update_date', 'previous_percent',
    'new_percent', 'accomplishment_notes', 'remaining_work', 'blocker_notes', 'created_at'],
  WorkLogs: ['work_log_id', 'task_id', 'member_id', 'work_date', 'start_time', 'end_time',
    'minutes_spent', 'work_category', 'notes', 'created_at'],
  TaskEvents: ['event_id', 'task_id', 'member_id', 'event_type', 'previous_value',
    'new_value', 'reason', 'actor', 'event_timestamp'],
  TaskImpacts: ['impact_id', 'additional_task_id', 'affected_task_id', 'impact_type',
    'estimated_delay_minutes', 'actual_delay_minutes', 'reason', 'evidence_notes',
    'created_by', 'created_at', 'updated_at'],
  WeeklySnapshots: ['snapshot_id', 'week_start', 'week_end', 'member_id', 'planned_task_count',
    'completed_planned_count', 'planned_completion_percent', 'weighted_completion_percent',
    'additional_task_count', 'additional_completed_count', 'additional_effort_minutes',
    'overdue_count', 'blocked_count', 'generated_at'],
  DeletionLog: ['deletion_id', 'task_id', 'deleted_at', 'actor', 'reason', 'task_json',
    'history_json', 'removed_counts'],
  Settings: ['key', 'value', 'updated_at']
};

const STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Completed', 'Cancelled'];
const TASK_TYPES = ['PLANNED', 'ADDITIONAL'];
const IMPACT_TYPES = ['No Impact', 'Delayed', 'Paused', 'Scope Changed', 'Dependency Affected'];
// Must match the values your frontend offers. Add to this list if you use others.
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent', 'Critical'];
const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

const LIMITS = { id: 100, short: 200, title: 200, text: 2000 };

// Columns stored as numbers; every other column is forced to plain text so
// Sheets never auto-converts dates or interprets "=..." as a formula.
const NUMERIC_FIELDS = {
  completion_percent: true, estimated_minutes: true, actual_minutes: true,
  previous_percent: true, new_percent: true, minutes_spent: true,
  estimated_delay_minutes: true, actual_delay_minutes: true,
  planned_task_count: true, completed_planned_count: true,
  planned_completion_percent: true, weighted_completion_percent: true,
  additional_task_count: true, additional_completed_count: true,
  additional_effort_minutes: true, overdue_count: true, blocked_count: true
};
const DATE_ONLY_FIELDS = { update_date: true, work_date: true, week_start: true, week_end: true };
const DUE_FIELDS = { original_due_at: true, current_due_at: true };
const SORT_FIELD = {
  DailyUpdates: 'created_at', WorkLogs: 'created_at', TaskImpacts: 'created_at',
  WeeklySnapshots: 'generated_at', TaskEvents: 'event_timestamp'
};
const DATE_FILTER_FIELD = { DailyUpdates: 'update_date', WorkLogs: 'work_date' };

const DEFAULT_SETTINGS = {
  timezone: 'Asia/Manila',
  week_start_day: 'MON',
  working_days: 'MON,TUE,WED,THU,FRI',
  working_hours_start: '08:00',
  working_hours_end: '17:00',
  require_outcome_on_complete: 'TRUE',
  dashboard_default_view: 'individual'
};

// GET is an allowlist: anything not listed here is POST-only.
const READ_ACTIONS = ['ping', 'initLoad', 'listMembers', 'listTasks', 'listDailyUpdates',
  'listWorkLogs', 'taskHistory', 'listImpacts', 'teamAnalytics', 'weeklyReport',
  'listSnapshots', 'exportCsv', 'getSettings'];
const ADMIN_ONLY = { deleteTask: true, upsertMember: true, saveSettings: true, createSnapshot: true, exportCsv: true };

const UPDATABLE_TASK_FIELDS = ['title', 'description', 'owner_id', 'task_type', 'requested_by',
  'started_at', 'current_due_at', 'completed_at', 'priority', 'status', 'completion_percent',
  'estimated_minutes', 'actual_minutes', 'blocked_reason', 'impact_reason', 'impact_notes'];
// 'original_due_at' is intentionally NOT updatable — the original schedule must
// survive deadline revisions (revisions change current_due_at only).

/* ============================== Entry points ============================== */

function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = String(params.action || 'ping');
  if (READ_ACTIONS.indexOf(action) === -1) {
    return jsonOut({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for this action.' } });
  }
  let payload = {};
  try {
    payload = params.payload ? JSON.parse(params.payload) : {};
  } catch (err) {
    return jsonOut({ ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid payload JSON.' } });
  }
  return respond_(action, payload, params.idToken || null);
}

function doPost(e) {
  const raw = (e && e.postData && e.postData.contents) || '{}';
  if (raw.length > 200000) {
    return jsonOut({ ok: false, error: { code: 'BAD_REQUEST', message: 'Request too large.' } });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    return jsonOut({ ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' } });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonOut({ ok: false, error: { code: 'BAD_REQUEST', message: 'Body must be a JSON object.' } });
  }
  return respond_(String(body.action || 'ping'), body.payload || {}, body.idToken || null);
}

function respond_(action, payload, idToken) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw coded_('BAD_REQUEST', 'payload must be an object.');
    }
    return jsonOut({ ok: true, v: API_VERSION, data: handle_(action, payload, idToken) });
  } catch (err) {
    return jsonOut({ ok: false, v: API_VERSION, error: publicError_(err) });
  }
}

function handle_(action, p, idToken) {
  ensureSchema_();
  const ctx = buildContext_(idToken);
  if (ctx.mode === 'google') {
    p._actor = ctx.actor;       // never trust client-supplied identity
    p.created_by = ctx.actor;
  } else {
    p._actor = clampActor_(p._actor);
  }
  return route_(action, p, ctx);
}

/** One-time setup: run manually from the Apps Script editor. */
function setup() {
  ensureSchemaFull_();
  seedRoster_();
  seedSettings_();
  return 'Setup complete. Now run migrateSheetsToPlainText() once if this sheet already has data.';
}

/** Installs the weekly snapshot trigger (Fridays 18:00 in the project time zone). Idempotent. */
function installWeeklyTrigger() {
  const exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'scheduledWeeklySnapshot';
  });
  if (exists) return 'Trigger already installed.';
  ScriptApp.newTrigger('scheduledWeeklySnapshot').timeBased()
    .onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(18).create();
  return 'Trigger installed.';
}

/** Installs a 5-minute pre-warm trigger. Idempotent. */
function installKeepWarmTrigger() {
  const exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'keepWarm'; });
  if (exists) return 'Trigger already installed.';
  ScriptApp.newTrigger('keepWarm').timeBased().everyMinutes(5).create();
  return 'Trigger installed.';
}

/**
 * Pre-computes the current-week reports so the first person each morning gets a cache hit.
 * Skips nights and weekends to save trigger quota.
 */
function keepWarm() {
  const hour = Number(Utilities.formatDate(new Date(), tz_(), 'H'));
  if (hour < 7 || hour >= 19 || isoWeekday_(todayKey_()) > 5) return;
  ensureSchema_();
  readAllCached_('TeamMembers');
  readAllCached_('Settings');
  const p = { week_start: todayKey_() };
  cachedReport_('teamAnalytics', p, teamAnalytics_);
  cachedReport_('weeklyReport', p, weeklyReport_);
}

/**
 * Weekly snapshot (idempotent per week+member). Runs for the CURRENT week, except
 * on Monday when it snapshots the week that just ended.
 */
function scheduledWeeklySnapshot() {
  ensureSchema_();
  const today = todayKey_();
  const thisMonday = mondayOf_(today);
  const target = isoWeekday_(today) === 1 ? addDays_(thisMonday, -7) : thisMonday;
  const members = readAll_('TeamMembers');
  withLock_(function () {
    createSnapshot_({ week_start: target, member_id: 'ALL' }, 'system-scheduler');
    members.forEach(function (m) {
      createSnapshot_({ week_start: target, member_id: m.member_id }, 'system-scheduler');
    });
  });
}

/**
 * One-time migration for EXISTING data: converts Sheets-auto-parsed dates back to
 * strings and sets plain-text format on every non-numeric column. Safe to re-run.
 */
function migrateSheetsToPlainText() {
  return withLock_(function () {
    const report = {};
    Object.keys(SCHEMA).forEach(function (name) {
      const sh = sheet_(name);
      const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
      const last = sh.getLastRow();
      const max = sh.getMaxRows();
      let converted = 0;
      header.forEach(function (h, j) {
        if (!h || NUMERIC_FIELDS[h]) return;
        sh.getRange(2, j + 1, Math.max(max - 1, 1), 1).setNumberFormat('@');
        if (last < 2) return;
        const range = sh.getRange(2, j + 1, last - 1, 1);
        const vals = range.getValues().map(function (r) {
          const v = r[0];
          if (v instanceof Date) { converted++; return [fmtCell_(v, h)]; }
          if (typeof v === 'boolean') return [v ? 'TRUE' : 'FALSE'];
          return [v === null || v === undefined ? '' : String(v)];
        });
        range.setValues(vals);
      });
      report[name] = { rows: Math.max(last - 1, 0), dateCellsConverted: converted };
    });
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY);
    return report;
  });
}

/* ============================== Auth ============================== */

function authMode_() {
  return PropertiesService.getScriptProperties().getProperty('AUTH_MODE') === 'google' ? 'google' : 'open';
}

function clampActor_(v) {
  return String(v || 'editor').slice(0, 80);
}

function buildContext_(idToken) {
  if (authMode_() !== 'google') return { mode: 'open', isAdmin: true, memberId: '', actor: '' };
  if (!idToken) throw coded_('UNAUTHENTICATED', 'Sign in required.');
  const info = verifyIdToken_(String(idToken));
  const member = readAllCached_('TeamMembers').filter(function (m) {
    return String(m.email || '').toLowerCase() === info.email && m.is_active !== 'FALSE';
  })[0];
  if (!member) throw coded_('FORBIDDEN', 'Your account is not on the team roster.');
  const admins = String(PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS') || '')
    .toLowerCase().split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return {
    mode: 'google', email: info.email, memberId: String(member.member_id),
    actor: info.email, isAdmin: admins.indexOf(info.email) !== -1
  };
}

function verifyIdToken_(token) {
  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) throw coded_('SERVER_CONFIG', 'GOOGLE_CLIENT_ID is not configured.');
  const cache = CacheService.getScriptCache();
  const key = 'idt_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw coded_('UNAUTHENTICATED', 'Invalid or expired sign-in.');
  const info = JSON.parse(res.getContentText());
  const nowSec = Math.floor(Date.now() / 1000);
  const issOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  const verified = info.email_verified === true || info.email_verified === 'true';
  if (info.aud !== clientId || !issOk || !verified || !info.email || Number(info.exp) <= nowSec) {
    throw coded_('UNAUTHENTICATED', 'Invalid or expired sign-in.');
  }
  const out = { email: String(info.email).toLowerCase(), exp: Number(info.exp) };
  const ttl = Math.min(300, out.exp - nowSec);
  if (ttl > 0) cache.put(key, JSON.stringify(out), ttl);
  return out;
}

function assertOwnsTask_(ctx, taskId) {
  const t = findById_('Tasks', 'task_id', taskId);
  if (!t) throw coded_('NOT_FOUND', 'Task not found.');
  if (String(t.owner_id) !== ctx.memberId) throw coded_('FORBIDDEN', 'You can only change your own tasks.');
}

function authorize_(action, p, ctx) {
  if (ctx.mode !== 'google' || ctx.isAdmin) return;
  if (ADMIN_ONLY[action]) throw coded_('FORBIDDEN', 'Admin only.');
  switch (action) {
    case 'createTask':
      if (p.owner_id && String(p.owner_id) !== ctx.memberId) throw coded_('FORBIDDEN', 'You can only create tasks for yourself.');
      p.owner_id = ctx.memberId;
      break;
    case 'updateTask':
    case 'archiveTask':
    case 'restoreTask':
      assertOwnsTask_(ctx, p.task_id);
      if (p.owner_id !== undefined && String(p.owner_id) !== ctx.memberId) throw coded_('FORBIDDEN', 'Only admins can reassign tasks.');
      break;
    case 'addDailyUpdate':
    case 'addWorkLog':
      assertOwnsTask_(ctx, p.task_id);
      p.member_id = ctx.memberId;
      break;
    case 'upsertImpact':
      assertOwnsTask_(ctx, p.affected_task_id);
      break;
    default:
      break;
  }
}

/* ============================== Router ============================== */

function route_(action, p, ctx) {
  p = p || {};
  authorize_(action, p, ctx);
  const actor = p._actor || 'editor';
  switch (action) {
    case 'ping': return { status: 'ok', time: nowISO_(), version: API_VERSION };
    case 'initLoad': return initLoad_(p, ctx);
    case 'listMembers': return publicMembers_(readAllCached_('TeamMembers'), ctx);
    case 'upsertMember': return withLock_(function () { return upsertMember_(p); });
    case 'listTasks': return queryTasks_(p);
    case 'createTask': return withLock_(function () { return createTask_(p, actor); });
    case 'updateTask': return withLock_(function () { return updateTask_(p, actor); });
    case 'archiveTask': return withLock_(function () { return archiveTask_(p, actor); });
    case 'restoreTask': return withLock_(function () { return restoreTask_(p, actor); });
    case 'deleteTask': return withLock_(function () { return deleteTask_(p, actor); });
    case 'addDailyUpdate': return withLock_(function () { return addDailyUpdate_(p); });
    case 'listDailyUpdates': return querySheet_('DailyUpdates', p);
    case 'addWorkLog': return withLock_(function () { return addWorkLog_(p); });
    case 'listWorkLogs': return querySheet_('WorkLogs', p);
    case 'taskHistory': return taskHistory_(p.task_id);
    case 'upsertImpact': return withLock_(function () { return upsertImpact_(p, actor); });
    case 'listImpacts': return querySheet_('TaskImpacts', p);
    case 'teamAnalytics': return cachedReport_('teamAnalytics', p, teamAnalytics_);
    case 'weeklyReport': return cachedReport_('weeklyReport', p, weeklyReport_);
    case 'createSnapshot': return withLock_(function () { return createSnapshot_(p, actor); });
    case 'listSnapshots': return querySheet_('WeeklySnapshots', p);
    case 'exportCsv': return exportCsv_(p);
    case 'getSettings': return readSettings_();
    case 'saveSettings': return withLock_(function () { return saveSettings_(p); });
    default: throw coded_('UNKNOWN_ACTION', 'Unknown action: ' + action);
  }
}

/* ============================== Sheets helpers ============================== */

function ss_() { return MEMO_.ss || (MEMO_.ss = SpreadsheetApp.getActiveSpreadsheet()); }
function ssTz_() { return MEMO_.ssTz || (MEMO_.ssTz = ss_().getSpreadsheetTimeZone()); }

function sheet_(name) {
  if (MEMO_['sh_' + name]) return MEMO_['sh_' + name];
  const sh = ss_().getSheetByName(name);
  if (!sh) throw coded_('SCHEMA_ERROR', 'Missing sheet: ' + name + '. Run setup().');
  MEMO_['sh_' + name] = sh;
  return sh;
}

function headerMap_(name) {
  if (MEMO_['hm_' + name]) return MEMO_['hm_' + name];
  const sh = sheet_(name);
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const map = {};
  header.forEach(function (h, i) { map[h] = i; });
  SCHEMA[name].forEach(function (h) {
    if (!(h in map)) throw coded_('SCHEMA_ERROR', 'Sheet ' + name + ' is missing column: ' + h);
  });
  return (MEMO_['hm_' + name] = { header: header, map: map });
}

/** Cheap on the hot path (cached flag); does the real work only when needed. */
function ensureSchema_() {
  const cache = CacheService.getScriptCache();
  if (cache.get(SCHEMA_CACHE_KEY)) return;
  ensureSchemaFull_();
  cache.put(SCHEMA_CACHE_KEY, '1', 21600);
}

function ensureSchemaFull_() {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (e) { throw coded_('BUSY', 'Server is busy, please retry in a few seconds.'); }
  try {
    const s = ss_();
    Object.keys(SCHEMA).forEach(function (name) {
      let sh = s.getSheetByName(name);
      if (!sh) {
        sh = s.insertSheet(name);
        sh.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]);
        sh.setFrozenRows(1);
        formatTextCols_(sh, SCHEMA[name], 2, sh.getMaxRows() - 1);
      } else {
        const header = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
        const missing = SCHEMA[name].filter(function (h) { return header.indexOf(h) === -1; });
        if (missing.length) {
          sh.getRange(1, header.length + 1, 1, missing.length).setValues([missing]);
          const full = header.concat(missing);
          formatTextCols_(sh, full, 2, sh.getMaxRows() - 1);
        }
      }
      MEMO_['sh_' + name] = sh;
      delete MEMO_['hm_' + name];
    });
  } finally {
    lock.releaseLock();
  }
}

/** Forces plain-text format on all non-numeric columns for the given row block. */
function formatTextCols_(sh, header, startRow, numRows) {
  if (numRows < 1) return;
  let j = 0;
  while (j < header.length) {
    if (!header[j] || NUMERIC_FIELDS[header[j]]) { j++; continue; }
    let k = j;
    while (k + 1 < header.length && header[k + 1] && !NUMERIC_FIELDS[header[k + 1]]) k++;
    sh.getRange(startRow, j + 1, numRows, k - j + 1).setNumberFormat('@');
    j = k + 1;
  }
}

/** Value → what we store. Text columns always get strings; numeric columns numbers or ''. */
function toCell_(h, v) {
  if (v === undefined || v === null) return '';
  if (NUMERIC_FIELDS[h]) {
    if (v === '') return '';
    const n = Number(v);
    return isFinite(n) ? n : '';
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/** Stored value → what the API returns. Also repairs legacy auto-converted Date cells. */
function fmtCell_(v, h) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    if (DATE_ONLY_FIELDS[h]) return Utilities.formatDate(v, ssTz_(), 'yyyy-MM-dd');
    if (DUE_FIELDS[h] && Utilities.formatDate(v, ssTz_(), 'HH:mm:ss') === '00:00:00') {
      return Utilities.formatDate(v, ssTz_(), 'yyyy-MM-dd');
    }
    return v.toISOString();
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (NUMERIC_FIELDS[h]) {
    if (v === '' || v === null || v === undefined) return '';
    const n = Number(v);
    return isFinite(n) ? n : v;
  }
  return v;
}

function rowToObj_(header, row) {
  const o = {};
  header.forEach(function (h, i) { o[h] = fmtCell_(row[i], h); });
  return o;
}

function readAll_(name) {
  const sh = sheet_(name);
  const hm = headerMap_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, hm.header.length).getValues();
  return vals
    .filter(function (r) { return r.some(function (c) { return c !== '' && c !== null; }); })
    .map(function (r) { return rowToObj_(hm.header, r); });
}

/** Small, rarely-changing sheets only (TeamMembers, Settings). 120 s cache, invalidated on write. */
function readAllCached_(name) {
  const mk = 'rows_' + name;
  if (MEMO_[mk]) return MEMO_[mk];
  const cache = CacheService.getScriptCache();
  const hit = cache.get(mk);
  if (hit) {
    try { return (MEMO_[mk] = JSON.parse(hit)); } catch (e) { /* fall through */ }
  }
  const rows = readAll_(name);
  try {
    const s = JSON.stringify(rows);
    if (s.length < 90000) cache.put(mk, s, 120);
  } catch (e) { /* cache is best-effort */ }
  return (MEMO_[mk] = rows);
}

function invalidateCache_(name) {
  delete MEMO_['rows_' + name];
  if (name === 'Settings') delete MEMO_.tz;
  CacheService.getScriptCache().remove('rows_' + name);
}

function readRow_(name, rowNum) {
  const sh = sheet_(name);
  const hm = headerMap_(name);
  return rowToObj_(hm.header, sh.getRange(rowNum, 1, 1, hm.header.length).getValues()[0]);
}

function findRowNum_(name, idField, idVal) {
  const sh = sheet_(name);
  const hm = headerMap_(name);
  const last = sh.getLastRow();
  if (last < 2 || idVal === undefined || idVal === null || idVal === '') return -1;
  const ids = sh.getRange(2, hm.map[idField] + 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(idVal)) return i + 2;
  }
  return -1;
}

function findById_(name, idField, idVal) {
  const rn = findRowNum_(name, idField, idVal);
  return rn < 0 ? null : readRow_(name, rn);
}

/** All rows where field === val, without reading the whole sheet when few match. */
function readWhere_(name, field, val) {
  if (val === undefined || val === null || val === '') return [];
  const sh = sheet_(name);
  const hm = headerMap_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const found = sh.getRange(2, hm.map[field] + 1, last - 1, 1)
    .createTextFinder(String(val)).matchCase(true).matchEntireCell(true).findAll();
  if (!found.length) return [];
  if (found.length > 40) {
    return readAll_(name).filter(function (r) { return String(r[field]) === String(val); });
  }
  return found.map(function (c) { return readRow_(name, c.getRow()); })
    .filter(function (r) { return String(r[field]) === String(val); });
}

function appendRow_(name, obj) {
  const sh = sheet_(name);
  const hm = headerMap_(name);
  const row = sh.getLastRow() + 1;
  if (row > sh.getMaxRows()) {
    const old = sh.getMaxRows();
    sh.insertRowsAfter(old, 200);
    formatTextCols_(sh, hm.header, old + 1, 200);
  }
  const vals = hm.header.map(function (h) { return toCell_(h, obj[h]); });
  sh.getRange(row, 1, 1, vals.length).setValues([vals]);
}

/** Single-row read-modify-write (one setValues call). The id column is never changed. */
function updateRowById_(name, idField, idVal, patch) {
  const sh = sheet_(name);
  const hm = headerMap_(name);
  const rn = findRowNum_(name, idField, idVal);
  if (rn < 0) throw coded_('NOT_FOUND', idField + ' ' + idVal + ' not found.');
  const range = sh.getRange(rn, 1, 1, hm.header.length);
  const out = range.getValues()[0].map(function (v, i) {
    if (v instanceof Date) return toCell_(hm.header[i], fmtCell_(v, hm.header[i]));
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return v;
  });
  Object.keys(patch).forEach(function (k) {
    if (k in hm.map && k !== idField) out[hm.map[k]] = toCell_(k, patch[k]);
  });
  range.setValues([out]);
  return rn;
}

function deleteRowsById_(name, idField, idVal) {
  const sh = sheet_(name);
  const hm = headerMap_(name);
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const ids = sh.getRange(2, hm.map[idField] + 1, last - 1, 1).getValues();
  let removed = 0;
  for (let i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) === String(idVal)) { sh.deleteRow(i + 2); removed++; }
  }
  return removed;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (e) { throw coded_('BUSY', 'Server is busy, please retry in a few seconds.'); }
  try { return fn(); } finally { bumpVersion_(); lock.releaseLock(); }
}

function uid_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function nowISO_() { return new Date().toISOString(); }

/* ---- Report cache: every write bumps a version, so cached reports are never stale ---- */
function dataVersion_() { return CacheService.getScriptCache().get('dv') || '0'; }
function bumpVersion_() { CacheService.getScriptCache().put('dv', String(Date.now()), 21600); }

/**
 * Caches an expensive report for 5 minutes, keyed by data version + today + week + member.
 * (Edits made by hand directly in the spreadsheet don't bump the version; they show up
 * within 5 minutes or on the next write through the API.)
 */
function cachedReport_(name, p, compute) {
  const cache = CacheService.getScriptCache();
  const key = [name, dataVersion_(), todayKey_(), mondayOf_(p.week_start || new Date()),
    String(p.member_id || 'ALL').slice(0, 40)].join(':');
  const hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* recompute */ } }
  const out = compute(p);
  try {
    const s = JSON.stringify(out);
    if (s.length < 90000) cache.put(key, s, 300);
  } catch (e) { /* cache is best-effort */ }
  return out;
}

function paginate_(rows, p) {
  const limit = Math.min(Math.max(Number(p.limit) || 500, 1), 2000);
  const offset = Math.max(Number(p.offset) || 0, 0);
  const page = rows.slice(offset, offset + limit);
  if (p.withMeta === true || String(p.withMeta) === 'true') {
    return { rows: page, total: rows.length, offset: offset, limit: limit, truncated: offset + page.length < rows.length };
  }
  return page;
}

/** Generic list. Newest first by default (order:"asc" for oldest first). Optional from/to date range. */
function querySheet_(name, p) {
  let rows = readAll_(name);
  Object.keys(p || {}).forEach(function (k) {
    if (k.charAt(0) === '_' || p[k] === undefined || p[k] === '' || p[k] === null) return;
    if (SCHEMA[name].indexOf(k) === -1) return;
    rows = rows.filter(function (r) { return String(r[k]) === String(p[k]); });
  });
  const df = DATE_FILTER_FIELD[name];
  if (df) {
    const from = p.from ? dateKey_(p.from) : '';
    const to = p.to ? dateKey_(p.to) : '';
    rows = rows.filter(function (r) {
      const d = dateKey_(r[df]);
      return (!from || d >= from) && (!to || d <= to);
    });
  }
  const sf = SORT_FIELD[name];
  if (sf) {
    const dir = String(p.order).toLowerCase() === 'asc' ? 1 : -1;
    rows.sort(function (a, b) {
      const x = String(a[sf] || ''), y = String(b[sf] || '');
      return x < y ? -dir : (x > y ? dir : 0);
    });
  }
  return paginate_(rows, p);
}

/* ============================== Dates (single source of truth) ============================== */

function tz_() {
  if (MEMO_.tz) return MEMO_.tz;
  let z = '';
  try { z = PropertiesService.getScriptProperties().getProperty('TIMEZONE') || ''; } catch (e) { /* ignore */ }
  if (!z) {
    try {
      const row = readAllCached_('Settings').filter(function (r) { return r.key === 'timezone'; })[0];
      z = (row && row.value) || '';
    } catch (e) { /* ignore */ }
  }
  return (MEMO_.tz = z || DEFAULT_SETTINGS.timezone);
}

/** Any date-ish value → 'yyyy-MM-dd' in the business time zone. Never use raw .slice(0,10) on timestamps. */
function dateKey_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s.slice(0, 10);
  return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd');
}

function todayKey_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }

function parseKey_(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  if (!m) throw coded_('VALIDATION', 'Invalid date: ' + key);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function addDays_(key, n) {
  const d = parseKey_(key);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 1 = Monday … 7 = Sunday */
function isoWeekday_(key) {
  const dow = parseKey_(key).getUTCDay();
  return dow === 0 ? 7 : dow;
}

function mondayOf_(input) {
  const key = dateKey_(input || new Date());
  return addDays_(key, -(isoWeekday_(key) - 1));
}

function weekRange_(weekStart) {
  const start = mondayOf_(weekStart);
  return { start: start, end: addDays_(start, 6) };
}

function inWeek_(v, weekStart) {
  const d = dateKey_(v);
  if (!d) return false;
  const r = weekRange_(weekStart);
  return d >= r.start && d <= r.end;
}

/** Due dates: compare date-only values as dates and timestamps as instants. */
function normDue_(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString();
}

function isDateLike_(v) {
  if (v === '' || v === null || v === undefined) return true;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) && !isNaN(new Date(s).getTime());
}

/** The ONE definition of "belongs to this week" (created, due or completed in-week, or open carry-over). */
function weekScope_(t, r) {
  const c = dateKey_(t.created_at);
  const d = dateKey_(t.current_due_at || t.original_due_at);
  const done = dateKey_(t.completed_at);
  const open = t.status !== 'Completed' && t.status !== 'Cancelled';
  return (c >= r.start && c <= r.end) || (d >= r.start && d <= r.end) ||
    (done >= r.start && done <= r.end) || (!!c && c < r.start && open);
}

/* ============================== Seed & settings ============================== */

function seedRoster_() {
  if (readAll_('TeamMembers').length) return { seeded: 0, note: 'Roster already populated.' };
  const raw = PropertiesService.getScriptProperties().getProperty('ROSTER_JSON');
  if (!raw) return { seeded: 0, note: 'No ROSTER_JSON property set; add members via upsertMember.' };
  let list;
  try { list = JSON.parse(raw); } catch (e) { throw coded_('SERVER_CONFIG', 'ROSTER_JSON is not valid JSON.'); }
  const now = nowISO_();
  list.forEach(function (m, i) {
    appendRow_('TeamMembers', {
      member_id: m.member_id || ('M' + ('000' + (i + 1)).slice(-3)),
      display_name: m.display_name, role: m.role || '',
      department: m.department || 'Academic Affairs',
      is_active: 'TRUE', created_at: now, email: String(m.email || '').toLowerCase()
    });
  });
  invalidateCache_('TeamMembers');
  return { seeded: list.length };
}

function seedSettings_() {
  const have = {};
  readAll_('Settings').forEach(function (r) { have[r.key] = true; });
  const now = nowISO_();
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (!have[k]) appendRow_('Settings', { key: k, value: DEFAULT_SETTINGS[k], updated_at: now });
  });
  invalidateCache_('Settings');
}

function readSettings_() {
  const o = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { o[k] = DEFAULT_SETTINGS[k]; });
  readAllCached_('Settings').forEach(function (r) {
    if (r.key && DEFAULT_SETTINGS.hasOwnProperty(r.key)) o[r.key] = r.value;
  });
  o.timezone = tz_();
  // hasEditKey/hasAdminKey kept (always false) so older frontends don't break.
  o.configured = { authMode: authMode_(), hasEditKey: false, hasAdminKey: false };
  return o;
}

function validateSetting_(k, raw) {
  const v = String(raw).trim();
  switch (k) {
    case 'timezone':
      try { Utilities.formatDate(new Date(), v, 'yyyy'); } catch (e) { throw coded_('VALIDATION', 'Unknown time zone: ' + v); }
      return v;
    case 'week_start_day':
      if (v.toUpperCase() !== 'MON') throw coded_('VALIDATION', 'Only a Monday week start is supported.');
      return 'MON';
    case 'working_days': {
      const days = v.toUpperCase().split(',').map(function (s) { return s.trim(); });
      if (!days.length || days.some(function (d) { return WEEKDAYS.indexOf(d) === -1; })) {
        throw coded_('VALIDATION', 'working_days must be a comma list of MON..SUN.');
      }
      return days.join(',');
    }
    case 'working_hours_start':
    case 'working_hours_end':
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw coded_('VALIDATION', k + ' must be HH:mm.');
      return v;
    case 'require_outcome_on_complete':
      if (['TRUE', 'FALSE'].indexOf(v.toUpperCase()) === -1) throw coded_('VALIDATION', k + ' must be TRUE or FALSE.');
      return v.toUpperCase();
    case 'dashboard_default_view':
      if (!v || v.length > 30) throw coded_('VALIDATION', k + ' is invalid.');
      return v;
    default:
      throw coded_('VALIDATION', 'Unknown setting: ' + k);
  }
}

function saveSettings_(p) {
  const allowed = ['timezone', 'week_start_day', 'working_days', 'working_hours_start',
    'working_hours_end', 'require_outcome_on_complete', 'dashboard_default_view'];
  const clean = {};
  allowed.forEach(function (k) { if (p[k] !== undefined) clean[k] = validateSetting_(k, p[k]); }); // validate ALL first
  const now = nowISO_();
  Object.keys(clean).forEach(function (k) {
    if (findRowNum_('Settings', 'key', k) > 0) updateRowById_('Settings', 'key', k, { value: clean[k], updated_at: now });
    else appendRow_('Settings', { key: k, value: clean[k], updated_at: now });
  });
  invalidateCache_('Settings');
  return readSettings_();
}

/* ============================== Validation ============================== */

function numOrNull_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function numOrBlank_(v) {
  const n = numOrNull_(v);
  return n === null ? '' : n;
}

function assertMaxLen_(obj, fields, max) {
  fields.forEach(function (f) {
    if (obj[f] !== undefined && obj[f] !== null && String(obj[f]).length > max) {
      throw coded_('VALIDATION', f + ' is too long (max ' + max + ' characters).');
    }
  });
}

function validateTask_(t) {
  const errors = [];
  if (!t.title || !String(t.title).trim()) errors.push('Title is required.');
  if (String(t.title || '').length > LIMITS.title) errors.push('Title is too long (max ' + LIMITS.title + ').');
  ['description', 'blocked_reason', 'impact_reason', 'impact_notes'].forEach(function (f) {
    if (String(t[f] || '').length > LIMITS.text) errors.push(f + ' is too long (max ' + LIMITS.text + ').');
  });
  if (String(t.requested_by || '').length > LIMITS.short) errors.push('requested_by is too long.');
  if (t.task_type && TASK_TYPES.indexOf(t.task_type) === -1) errors.push('task_type must be PLANNED or ADDITIONAL.');
  if (t.status && STATUSES.indexOf(t.status) === -1) errors.push('Invalid status: ' + t.status + '.');
  if (t.priority && PRIORITIES.indexOf(t.priority) === -1) errors.push('Invalid priority: ' + t.priority + '.');
  ['started_at', 'original_due_at', 'current_due_at', 'completed_at'].forEach(function (f) {
    if (!isDateLike_(t[f])) errors.push(f + ' is not a valid date.');
  });
  const pct = numOrNull_(t.completion_percent);
  if (t.completion_percent !== undefined && t.completion_percent !== '' && (pct === null || pct < 0 || pct > 100)) {
    errors.push('completion_percent must be between 0 and 100.');
  }
  if (t.status === 'Completed') {
    if (pct !== 100) errors.push('Completed tasks must have completion_percent = 100.');
    if (!t.completed_at) errors.push('Completed tasks must have completed_at.');
  }
  if (t.status !== 'Completed' && pct === 100 && t.status !== 'Cancelled') {
    errors.push('Only Completed tasks may have 100% completion.');
  }
  if (t.status === 'Cancelled' && t.completed_at) errors.push('Cancelled tasks must not have completed_at.');
  ['estimated_minutes', 'actual_minutes'].forEach(function (f) {
    if (t[f] !== undefined && t[f] !== null && t[f] !== '') {
      const n = Number(t[f]);
      if (!isFinite(n) || n < 0) errors.push(f + ' must be a non-negative number.');
    }
  });
  if (errors.length) throw coded_('VALIDATION', errors.join(' '));
}

function event_(taskId, memberId, type, prev, next, reason, actor) {
  appendRow_('TaskEvents', {
    event_id: uid_('EV'), task_id: taskId, member_id: memberId || '', event_type: type,
    previous_value: prev !== undefined && prev !== null ? String(prev) : '',
    new_value: next !== undefined && next !== null ? String(next) : '',
    reason: String(reason || '').slice(0, LIMITS.text), actor: actor || '', event_timestamp: nowISO_()
  });
}

function activeMember_(memberId, label) {
  const m = memberId ? findById_('TeamMembers', 'member_id', memberId) : null;
  if (!m) throw coded_('VALIDATION', 'Valid ' + (label || 'member_id') + ' (roster member) is required.');
  if (m.is_active === 'FALSE') throw coded_('VALIDATION', 'Member ' + m.display_name + ' is inactive.');
  return m;
}

function requiresOutcome_() {
  return String(readSettings_().require_outcome_on_complete).toUpperCase() === 'TRUE';
}

/* ============================== Members ============================== */

function publicMembers_(rows, ctx) {
  const showEmail = ctx && ctx.mode === 'google' && ctx.isAdmin;
  return rows.map(function (m) {
    const o = merge_(m, {});
    if (!showEmail) delete o.email;
    return o;
  });
}

function upsertMember_(p) {
  assertMaxLen_(p, ['display_name', 'role', 'department'], LIMITS.short);
  if (!p.display_name || !String(p.display_name).trim()) throw coded_('VALIDATION', 'display_name is required.');
  const now = nowISO_();
  let email;
  if (p.email !== undefined) {
    email = String(p.email).trim().toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw coded_('VALIDATION', 'Invalid email.');
    if (email && readAll_('TeamMembers').some(function (m) {
      return String(m.member_id) !== String(p.member_id) && String(m.email || '').toLowerCase() === email;
    })) throw coded_('DUPLICATE', 'That email is already assigned to another member.');
  }
  const boolish = function (v) { return v === true || String(v).toLowerCase() === 'true' ? 'TRUE' : 'FALSE'; };
  if (p.member_id && findById_('TeamMembers', 'member_id', p.member_id)) {
    const patch = {
      display_name: String(p.display_name).trim(), role: p.role || '',
      department: p.department || 'Academic Affairs'
    };
    if (p.is_active !== undefined) patch.is_active = boolish(p.is_active);
    if (email !== undefined) patch.email = email;
    updateRowById_('TeamMembers', 'member_id', p.member_id, patch);
    event_('', p.member_id, 'member_updated', '', p.display_name, p.reason || '', p._actor || 'admin');
    invalidateCache_('TeamMembers');
    return findById_('TeamMembers', 'member_id', p.member_id);
  }
  const row = {
    member_id: p.member_id || uid_('M'), display_name: String(p.display_name).trim(), role: p.role || '',
    department: p.department || 'Academic Affairs',
    is_active: p.is_active === undefined ? 'TRUE' : boolish(p.is_active),
    created_at: now, email: email || ''
  };
  appendRow_('TeamMembers', row);
  invalidateCache_('TeamMembers');
  return row;
}

/* ============================== Tasks ============================== */

function createTask_(p, actor) {
  const now = nowISO_();
  const t = {
    task_id: p.task_id || uid_('T'),
    title: String(p.title || '').trim(),
    description: p.description || '',
    owner_id: p.owner_id || '',
    task_type: p.task_type || 'PLANNED',
    requested_by: p.requested_by || '',
    created_at: p.created_at || now,
    started_at: p.started_at || '',
    original_due_at: p.original_due_at || p.current_due_at || '',
    current_due_at: p.current_due_at || p.original_due_at || '',
    completed_at: p.completed_at || '',
    priority: p.priority || 'Medium',
    status: p.status || 'Not Started',
    // Unreported ⟺ completion_percent is '' (never silently 0%). Averages and
    // weighted calculations exclude unreported tasks and disclose the count.
    completion_percent: numOrBlank_(p.completion_percent),
    estimated_minutes: numOrBlank_(p.estimated_minutes),
    actual_minutes: numOrBlank_(p.actual_minutes),
    blocked_reason: p.blocked_reason || '',
    impact_reason: p.impact_reason || '',
    impact_notes: p.impact_notes || '',
    created_by: p.created_by || actor || '',
    last_updated_at: now,
    archived_at: ''
  };
  if (!/^[A-Za-z0-9_\-]{1,100}$/.test(t.task_id)) throw coded_('VALIDATION', 'task_id may contain only letters, digits, _ and -.');
  if (t.status === 'Completed') {
    if (t.completion_percent === '') t.completion_percent = 100;
    if (!t.completed_at) t.completed_at = now;
  }
  activeMember_(t.owner_id, 'owner_id');
  if (findRowNum_('Tasks', 'task_id', t.task_id) > 0) throw coded_('DUPLICATE', 'task_id already exists (duplicate submission).');
  validateTask_(t);
  if (t.status === 'Completed' && requiresOutcome_() && !p.outcome_note && !t.impact_notes) {
    throw coded_('VALIDATION', 'Completing a task requires an outcome/accomplishment note.');
  }
  appendRow_('Tasks', t);
  event_(t.task_id, t.owner_id, 'created', '', t.status, p.reason || '', actor);
  if (t.status === 'Completed' && p.outcome_note) {
    appendRow_('DailyUpdates', {
      update_id: uid_('U'), task_id: t.task_id, member_id: t.owner_id, update_date: todayKey_(),
      previous_percent: '', new_percent: 100, accomplishment_notes: String(p.outcome_note).slice(0, LIMITS.text),
      remaining_work: '', blocker_notes: '', created_at: now
    });
  }
  return t;
}

function updateTask_(p, actor) {
  if (!p.task_id) throw coded_('VALIDATION', 'task_id is required.');
  const cur = findById_('Tasks', 'task_id', p.task_id);
  if (!cur) throw coded_('NOT_FOUND', 'Task not found.');
  if (cur.archived_at) throw coded_('VALIDATION', 'Archived tasks cannot be edited. Use restoreTask first.');
  // Optional optimistic concurrency: send the last_updated_at you loaded.
  if (p.expected_updated_at && String(p.expected_updated_at) !== String(cur.last_updated_at)) {
    throw coded_('CONFLICT', 'This task was changed by someone else. Reload and try again.');
  }
  const now = nowISO_();
  const next = merge_(cur, {});
  UPDATABLE_TASK_FIELDS.forEach(function (k) { if (p[k] !== undefined) next[k] = p[k]; });
  const reason = String(p.reason || '').slice(0, LIMITS.text);

  const ownerChanged = String(cur.owner_id) !== String(next.owner_id);
  if (ownerChanged) activeMember_(next.owner_id, 'owner_id');
  const dueChanged = normDue_(cur.current_due_at) !== normDue_(next.current_due_at);
  if (dueChanged && !reason) throw coded_('VALIDATION', 'A reason is required when changing the deadline.');

  const becameCompleted = next.status === 'Completed' && cur.status !== 'Completed';
  const reopened = cur.status === 'Completed' && next.status !== 'Completed' && next.status !== 'Cancelled';
  const cancelled = next.status === 'Cancelled' && cur.status !== 'Cancelled';

  if (becameCompleted) {
    if (!next.completed_at) next.completed_at = now;
    next.completion_percent = 100;
    if (requiresOutcome_() && !p.outcome_note && !next.impact_notes) {
      throw coded_('VALIDATION', 'Completing a task requires an outcome/accomplishment note (outcome_note).');
    }
  }
  if (reopened) {
    if (!reason) throw coded_('VALIDATION', 'A reason is required to reopen a completed task.');
    if (Number(next.completion_percent) === 100 && p.completion_percent === undefined) {
      throw coded_('VALIDATION', 'Reopening requires a completion_percent below 100.');
    }
    next.completed_at = '';
  }
  if (cancelled) next.completed_at = '';
  next.last_updated_at = now;

  // Validate BEFORE writing anything: a rejected update leaves no partial state.
  validateTask_(next);

  const patch = { last_updated_at: now };
  UPDATABLE_TASK_FIELDS.forEach(function (k) { patch[k] = next[k]; });
  updateRowById_('Tasks', 'task_id', next.task_id, patch);

  if (ownerChanged) event_(next.task_id, next.owner_id, 'reassigned', cur.owner_id, next.owner_id, reason, actor);
  if (dueChanged) event_(next.task_id, next.owner_id, 'deadline_changed', cur.current_due_at, next.current_due_at, reason, actor);
  if (String(cur.completion_percent) !== String(next.completion_percent) || cur.status !== next.status) {
    event_(next.task_id, next.owner_id, 'progress_changed',
      cur.status + ' ' + cur.completion_percent + '%', next.status + ' ' + next.completion_percent + '%', reason, actor);
  }
  if (becameCompleted) {
    if (p.outcome_note) {
      appendRow_('DailyUpdates', {
        update_id: uid_('U'), task_id: next.task_id, member_id: next.owner_id, update_date: todayKey_(),
        previous_percent: cur.completion_percent, new_percent: 100,
        accomplishment_notes: String(p.outcome_note).slice(0, LIMITS.text),
        remaining_work: '', blocker_notes: '', created_at: now
      });
    }
    event_(next.task_id, next.owner_id, 'completed', cur.status, 'Completed', reason, actor);
  }
  if (reopened) event_(next.task_id, next.owner_id, 'reopened', 'Completed', next.status, reason, actor);
  if (cancelled) event_(next.task_id, next.owner_id, 'cancelled', cur.status, 'Cancelled', reason, actor);
  return next;
}

function archiveTask_(p, actor) {
  if (!p.task_id) throw coded_('VALIDATION', 'task_id is required.');
  const cur = findById_('Tasks', 'task_id', p.task_id);
  if (!cur) throw coded_('NOT_FOUND', 'Task not found.');
  if (cur.archived_at) return { task_id: p.task_id, archived_at: cur.archived_at };
  const patch = { archived_at: nowISO_(), last_updated_at: nowISO_() };
  updateRowById_('Tasks', 'task_id', p.task_id, patch);
  event_(p.task_id, cur.owner_id, 'archived', '', '', p.reason || '', actor);
  return { task_id: p.task_id, archived_at: patch.archived_at };
}

function restoreTask_(p, actor) {
  if (!p.task_id) throw coded_('VALIDATION', 'task_id is required.');
  const cur = findById_('Tasks', 'task_id', p.task_id);
  if (!cur) throw coded_('NOT_FOUND', 'Task not found.');
  if (!cur.archived_at) return { task_id: p.task_id, archived_at: '' };
  updateRowById_('Tasks', 'task_id', p.task_id, { archived_at: '', last_updated_at: nowISO_() });
  event_(p.task_id, cur.owner_id, 'restored', cur.archived_at, '', p.reason || '', actor);
  return { task_id: p.task_id, archived_at: '' };
}

/**
 * Permanent delete. Requires confirm:true. A tombstone (task + full history as
 * JSON, actor, time) is written to DeletionLog FIRST, then children are removed,
 * and the task row last — so a timeout mid-way can simply be retried.
 * WeeklySnapshots are frozen history and are left untouched.
 */
function deleteTask_(p, actor) {
  if (!p.task_id) throw coded_('VALIDATION', 'task_id is required.');
  if (p.confirm !== true) throw coded_('VALIDATION', 'Pass confirm:true to permanently delete a task and its history.');
  const cur = findById_('Tasks', 'task_id', p.task_id);
  if (!cur) throw coded_('NOT_FOUND', 'Task not found.');
  const cut = function (o) { return JSON.stringify(o).slice(0, 45000); };
  const history = {
    events: readWhere_('TaskEvents', 'task_id', p.task_id),
    updates: readWhere_('DailyUpdates', 'task_id', p.task_id),
    workLogs: readWhere_('WorkLogs', 'task_id', p.task_id),
    impacts: readWhere_('TaskImpacts', 'additional_task_id', p.task_id)
      .concat(readWhere_('TaskImpacts', 'affected_task_id', p.task_id))
  };
  appendRow_('DeletionLog', {
    deletion_id: uid_('DEL'), task_id: p.task_id, deleted_at: nowISO_(), actor: actor || '',
    reason: String(p.reason || '').slice(0, LIMITS.text), task_json: cut(cur), history_json: cut(history),
    removed_counts: JSON.stringify({
      updates: history.updates.length, logs: history.workLogs.length,
      events: history.events.length, impacts: history.impacts.length
    })
  });
  const removed = { tasks: 0, updates: 0, logs: 0, events: 0, impacts: 0 };
  removed.updates = deleteRowsById_('DailyUpdates', 'task_id', p.task_id);
  removed.logs = deleteRowsById_('WorkLogs', 'task_id', p.task_id);
  removed.events = deleteRowsById_('TaskEvents', 'task_id', p.task_id);
  removed.impacts = deleteRowsById_('TaskImpacts', 'additional_task_id', p.task_id) +
    deleteRowsById_('TaskImpacts', 'affected_task_id', p.task_id);
  removed.tasks = deleteRowsById_('Tasks', 'task_id', p.task_id);
  return { task_id: p.task_id, removed: removed };
}

function queryTasks_(p) {
  let rows = readAll_('Tasks');
  if (!(p.includeArchived === true || String(p.includeArchived) === 'true')) {
    rows = rows.filter(function (t) { return !t.archived_at; });
  }
  ['owner_id', 'task_type', 'status', 'priority'].forEach(function (k) {
    if (p[k]) rows = rows.filter(function (t) { return String(t[k]) === String(p[k]); });
  });
  if (p.week_start) {
    const r = weekRange_(p.week_start);
    rows = rows.filter(function (t) { return weekScope_(t, r); });
  }
  if (p.q) {
    const q = String(p.q).toLowerCase();
    rows = rows.filter(function (t) {
      return String(t.title + ' ' + t.description).toLowerCase().indexOf(q) !== -1;
    });
  }
  rows.sort(function (a, b) {
    const x = String(a.created_at), y = String(b.created_at);
    return x < y ? 1 : (x > y ? -1 : 0);
  });
  return paginate_(rows, p);
}

/* ============================== Daily updates & work logs ============================== */

function addDailyUpdate_(p) {
  if (!p.task_id || !p.member_id) throw coded_('VALIDATION', 'task_id and member_id are required.');
  assertMaxLen_(p, ['accomplishment_notes', 'remaining_work', 'blocker_notes', 'reason'], LIMITS.text);
  activeMember_(p.member_id);
  const task = findById_('Tasks', 'task_id', p.task_id);
  if (!task) throw coded_('NOT_FOUND', 'Task not found.');
  if (task.archived_at) throw coded_('VALIDATION', 'Cannot update an archived task.');
  if (task.status === 'Cancelled') throw coded_('VALIDATION', 'Cannot update a cancelled task.');
  const prevPct = numOrNull_(task.completion_percent);
  const newPct = p.new_percent !== undefined ? Number(p.new_percent) : (prevPct === null ? 0 : prevPct);
  if (!isFinite(newPct) || newPct < 0 || newPct > 100) throw coded_('VALIDATION', 'new_percent must be 0–100.');
  if (prevPct !== null && newPct < prevPct && !p.reason) throw coded_('VALIDATION', 'Reducing progress requires a reason.');
  if (!isDateLike_(p.update_date)) throw coded_('VALIDATION', 'update_date is not a valid date.');
  const day = p.update_date ? dateKey_(p.update_date) : todayKey_();

  // Duplicate guard: same task+member+date+new_percent
  const dup = readWhere_('DailyUpdates', 'task_id', p.task_id).filter(function (u) {
    return String(u.member_id) === String(p.member_id) && dateKey_(u.update_date) === day && Number(u.new_percent) === newPct;
  });
  if (dup.length && !p.allowDuplicate) throw coded_('DUPLICATE', 'An identical update for this task/day already exists.');

  const row = {
    update_id: p.update_id || uid_('U'), task_id: p.task_id, member_id: p.member_id,
    update_date: day, previous_percent: task.completion_percent, new_percent: newPct,
    accomplishment_notes: p.accomplishment_notes || '', remaining_work: p.remaining_work || '',
    blocker_notes: p.blocker_notes || '', created_at: nowISO_()
  };
  if (findRowNum_('DailyUpdates', 'update_id', row.update_id) > 0) throw coded_('DUPLICATE', 'update_id already exists.');

  const now = nowISO_();
  const patch = { completion_percent: newPct, last_updated_at: now };
  if (newPct > 0 && !task.started_at) patch.started_at = now;
  if (p.blocker_notes) patch.blocked_reason = p.blocker_notes;
  const completing = newPct === 100 && task.status !== 'Completed';
  if (newPct === 100) {
    patch.status = 'Completed';
    if (!task.completed_at) patch.completed_at = now;
    if (!row.accomplishment_notes && requiresOutcome_()) {
      throw coded_('VALIDATION', 'Reaching 100% requires accomplishment_notes.');
    }
  } else if (task.status === 'Completed') {
    patch.status = 'In Progress';
    patch.completed_at = '';
  } else if (task.status === 'Not Started' && newPct > 0) {
    patch.status = 'In Progress';
  }
  // Validate FIRST so a rejected update leaves no orphan DailyUpdate row.
  validateTask_(merge_(task, patch));
  appendRow_('DailyUpdates', row);
  updateRowById_('Tasks', 'task_id', p.task_id, patch);
  const actor = p._actor || p.member_id;
  event_(p.task_id, p.member_id, 'progress_changed', String(task.completion_percent) + '%', String(newPct) + '%', p.reason || '', actor);
  if (completing) event_(p.task_id, p.member_id, 'completed', task.status, 'Completed', p.reason || '', actor);
  return row;
}

function addWorkLog_(p) {
  if (!p.task_id || !p.member_id) throw coded_('VALIDATION', 'task_id and member_id are required.');
  assertMaxLen_(p, ['notes', 'work_category'], LIMITS.text);
  activeMember_(p.member_id);
  const task = findById_('Tasks', 'task_id', p.task_id);
  if (!task) throw coded_('NOT_FOUND', 'Task not found.');
  if (task.archived_at) throw coded_('VALIDATION', 'Cannot log work on an archived task.');
  if (!isDateLike_(p.work_date)) throw coded_('VALIDATION', 'work_date is not a valid date.');
  let minutes = numOrNull_(p.minutes_spent);
  if (p.start_time && p.end_time) {
    const a = new Date(p.start_time).getTime();
    const b = new Date(p.end_time).getTime();
    if (!isFinite(a) || !isFinite(b)) throw coded_('VALIDATION', 'Invalid start/end time.');
    if (b < a) throw coded_('VALIDATION', 'end_time must not be before start_time.');
    if (minutes === null) minutes = Math.round((b - a) / 60000);
  }
  if (minutes === null || minutes < 0 || minutes > 1440) {
    throw coded_('VALIDATION', 'minutes_spent must be 0–1440 (or provide start/end times).');
  }
  const row = {
    work_log_id: p.work_log_id || uid_('W'), task_id: p.task_id, member_id: p.member_id,
    work_date: p.work_date ? dateKey_(p.work_date) : todayKey_(), start_time: p.start_time || '',
    end_time: p.end_time || '', minutes_spent: minutes, work_category: p.work_category || '',
    notes: p.notes || '', created_at: nowISO_()
  };
  if (findRowNum_('WorkLogs', 'work_log_id', row.work_log_id) > 0) {
    throw coded_('DUPLICATE', 'work_log_id already exists (duplicate submission).');
  }
  appendRow_('WorkLogs', row);
  // Tasks.actual_minutes is DERIVED: always the sum of this task's work logs.
  const total = readWhere_('WorkLogs', 'task_id', p.task_id)
    .reduce(function (s, l) { return s + (Number(l.minutes_spent) || 0); }, 0);
  updateRowById_('Tasks', 'task_id', p.task_id, { actual_minutes: total, last_updated_at: nowISO_() });
  return row;
}

function taskHistory_(taskId) {
  if (!taskId) throw coded_('VALIDATION', 'task_id is required.');
  const task = findById_('Tasks', 'task_id', taskId);
  if (!task) throw coded_('NOT_FOUND', 'Task not found.');
  const events = readWhere_('TaskEvents', 'task_id', taskId);
  const updates = readWhere_('DailyUpdates', 'task_id', taskId);
  const logs = readWhere_('WorkLogs', 'task_id', taskId);
  const impacts = readWhere_('TaskImpacts', 'additional_task_id', taskId)
    .concat(readWhere_('TaskImpacts', 'affected_task_id', taskId));
  events.sort(function (a, b) { return String(a.event_timestamp) < String(b.event_timestamp) ? -1 : 1; });
  updates.sort(function (a, b) { return String(a.update_date) < String(b.update_date) ? -1 : 1; });
  return { task: task, events: events, updates: updates, workLogs: logs, impacts: impacts };
}

/* ============================== Impacts ============================== */

function upsertImpact_(p, actor) {
  if (!p.additional_task_id || !p.affected_task_id) throw coded_('VALIDATION', 'additional_task_id and affected_task_id are required.');
  if (String(p.additional_task_id) === String(p.affected_task_id)) {
    throw coded_('VALIDATION', 'A task cannot impact itself: additional_task_id and affected_task_id must differ.');
  }
  assertMaxLen_(p, ['reason', 'evidence_notes'], LIMITS.text);
  const add = findById_('Tasks', 'task_id', p.additional_task_id);
  const aff = findById_('Tasks', 'task_id', p.affected_task_id);
  if (!add || !aff) throw coded_('NOT_FOUND', 'Linked task not found.');
  if (add.task_type !== 'ADDITIONAL') throw coded_('VALIDATION', 'additional_task_id must reference a task of type ADDITIONAL.');
  if (aff.task_type !== 'PLANNED') throw coded_('VALIDATION', 'affected_task_id must reference a planned (original) task.');
  const type = p.impact_type || 'Delayed';
  if (IMPACT_TYPES.indexOf(type) === -1) throw coded_('VALIDATION', 'Invalid impact_type.');
  const now = nowISO_();
  const fields = {
    impact_type: type, estimated_delay_minutes: numOrBlank_(p.estimated_delay_minutes),
    actual_delay_minutes: numOrBlank_(p.actual_delay_minutes),
    reason: p.reason || '', evidence_notes: p.evidence_notes || '', updated_at: now
  };
  // Upsert by id, or by the (additional, affected) pair so a link is never duplicated.
  let existing = p.impact_id ? findById_('TaskImpacts', 'impact_id', p.impact_id) : null;
  if (!existing) {
    existing = readWhere_('TaskImpacts', 'additional_task_id', p.additional_task_id)
      .filter(function (i) { return String(i.affected_task_id) === String(p.affected_task_id); })[0] || null;
  }
  if (existing) {
    updateRowById_('TaskImpacts', 'impact_id', existing.impact_id, fields);
    event_(p.affected_task_id, aff.owner_id, 'impact_updated', existing.impact_type, type, p.reason || '', actor);
    return findById_('TaskImpacts', 'impact_id', existing.impact_id);
  }
  const row = merge_(fields, {
    impact_id: uid_('I'), additional_task_id: p.additional_task_id, affected_task_id: p.affected_task_id,
    created_by: p.created_by || actor || '', created_at: now
  });
  appendRow_('TaskImpacts', row);
  event_(p.affected_task_id, aff.owner_id, 'impact_linked', '', p.additional_task_id + ' → ' + type, p.reason || '', actor);
  return row;
}

/* ============================== Analytics & reports ============================== */

function isOverdue_(t) {
  if (!t || t.status === 'Completed' || t.status === 'Cancelled') return false;
  const due = dateKey_(t.current_due_at || t.original_due_at);
  return !!due && due < todayKey_();
}

function eligible_(tasks, type) {
  return tasks.filter(function (t) {
    if (!t || t.status === 'Cancelled' || t.archived_at) return false;
    if (type && t.task_type !== type) return false;
    return true;
  });
}

function r1_(n) {
  if (n === null || n === undefined || !isFinite(Number(n))) return null;
  return Math.round(Number(n) * 10) / 10;
}

function summarize_(tasks, workLogs) {
  const elig = eligible_(tasks, null);
  const planned = eligible_(tasks, 'PLANNED');
  const adds = tasks.filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled' && !t.archived_at; });
  const completedPlanned = planned.filter(function (t) { return t.status === 'Completed'; }).length;
  const cc = planned.length ? r1_(completedPlanned / planned.length * 100) : null;
  let num = 0, den = 0, excl = 0;
  planned.forEach(function (t) {
    const est = Number(t.estimated_minutes);
    if (!isFinite(est) || est <= 0) { excl++; return; }
    if (t.completion_percent === '' || t.completion_percent === null || t.completion_percent === undefined) { excl++; return; } // unreported: excluded, disclosed
    const pct = Math.min(100, Math.max(0, Number(t.completion_percent) || 0));
    num += est * pct / 100; den += est;
  });
  let addEffort = 0;
  const addIds = {};
  adds.forEach(function (t) { addIds[String(t.task_id)] = true; });
  (workLogs || []).forEach(function (l) { if (addIds[String(l.task_id)]) addEffort += Number(l.minutes_spent) || 0; });
  return {
    plannedCount: planned.length,
    plannedCompleted: completedPlanned,
    plannedCompletion: cc,
    weightedCompletion: den ? r1_(num / den * 100) : null,
    weightedExcluded: excl,
    additionalCount: adds.length,
    additionalCompleted: adds.filter(function (t) { return t.status === 'Completed'; }).length,
    additionalEffortMinutes: addEffort,
    overdueCount: elig.filter(isOverdue_).length,
    blockedCount: elig.filter(function (t) { return t.status === 'Blocked'; }).length
  };
}

function turnaround_(tasks) {
  const list = tasks.filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled' && !t.archived_at; });
  const completed = list.filter(function (t) { return t.status === 'Completed' && t.completed_at && t.created_at; });
  const ms = completed.map(function (t) { return new Date(t.completed_at).getTime() - new Date(t.created_at).getTime(); })
    .filter(function (n) { return isFinite(n) && n >= 0; }).sort(function (a, b) { return a - b; });
  const mean = ms.length ? ms.reduce(function (a, b) { return a + b; }, 0) / ms.length : null;
  const med = ms.length ? (ms.length % 2 ? ms[Math.floor(ms.length / 2)] : (ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2) : null;
  const sameDay = completed.filter(function (t) { return dateKey_(t.created_at) === dateKey_(t.completed_at); }).length;
  return {
    total: list.length, completed: completed.length, pending: list.length - completed.length,
    avgTurnaroundHours: mean !== null ? r1_(mean / 3600000) : null,
    medianTurnaroundHours: med !== null ? r1_(med / 3600000) : null,
    sameDayCompleted: sameDay, sameDayDenominator: completed.length,
    sameDayRate: completed.length ? r1_(sameDay / completed.length * 100) : null,
    incompleteData: list.filter(function (t) { return t.status === 'Completed' && (!t.created_at || !t.completed_at); }).length
  };
}

function initLoad_(p, ctx) {
  const res = queryTasks_(merge_(p || {}, { withMeta: true }));
  return {
    members: publicMembers_(readAllCached_('TeamMembers'), ctx),
    settings: readSettings_(),
    tasks: res.rows, tasksTotal: res.total, tasksTruncated: res.truncated
  };
}

function teamAnalytics_(p) {
  const r = weekRange_(p.week_start || new Date());
  let tasks = readAll_('Tasks').filter(function (t) { return !t.archived_at; });
  let logs = readAll_('WorkLogs');
  const members = readAllCached_('TeamMembers');
  if (p.member_id && p.member_id !== 'ALL') {
    tasks = tasks.filter(function (t) { return String(t.owner_id) === String(p.member_id); });
    logs = logs.filter(function (l) { return String(l.member_id) === String(p.member_id); });
  }
  const weekTasks = tasks.filter(function (t) { return weekScope_(t, r); });
  const weekLogs = logs.filter(function (l) { return inWeek_(l.work_date || l.created_at, r.start); });
  const byMember = members.map(function (m) {
    const mt = weekTasks.filter(function (t) { return String(t.owner_id) === String(m.member_id); });
    const ml = weekLogs.filter(function (l) { return String(l.member_id) === String(m.member_id); });
    return { member_id: m.member_id, display_name: m.display_name, role: m.role, summary: summarize_(mt, ml) };
  });
  // Includes tasks with an unreported ('') percent: Number('') === 0, which is the point.
  const missingUpdates = weekTasks.filter(function (t) {
    return t.status !== 'Completed' && t.status !== 'Cancelled' && !t.actual_minutes && Number(t.completion_percent) === 0;
  }).map(function (t) { return { task_id: t.task_id, title: t.title, owner_id: t.owner_id }; });
  return {
    week_start: r.start, week_end: r.end, summary: summarize_(weekTasks, weekLogs),
    turnaround: turnaround_(weekTasks), byMember: byMember,
    impactCount: Math.max(sheet_('TaskImpacts').getLastRow() - 1, 0), missingUpdates: missingUpdates, taskCount: weekTasks.length
  };
}

function weeklyReport_(p) {
  const r = weekRange_(p.week_start || new Date());
  const memberId = p.member_id || 'ALL';
  let allTasks = readAll_('Tasks').filter(function (t) { return !t.archived_at && weekScope_(t, r); });
  let updates = readAll_('DailyUpdates').filter(function (u) { return inWeek_(u.update_date, r.start); });
  let logs = readAll_('WorkLogs').filter(function (l) { return inWeek_(l.work_date || l.created_at, r.start); });
  const members = readAllCached_('TeamMembers');
  if (memberId !== 'ALL') {
    allTasks = allTasks.filter(function (t) { return String(t.owner_id) === String(memberId); });
    updates = updates.filter(function (u) { return String(u.member_id) === String(memberId); });
    logs = logs.filter(function (l) { return String(l.member_id) === String(memberId); });
  }
  const inScopeIds = {};
  allTasks.forEach(function (t) { inScopeIds[String(t.task_id)] = true; });
  const impacts = readAll_('TaskImpacts').filter(function (i) {
    return inScopeIds[String(i.additional_task_id)] || inScopeIds[String(i.affected_task_id)];
  });
  const planned = allTasks.filter(function (t) { return t.task_type === 'PLANNED' && t.status !== 'Cancelled'; });
  const adds = allTasks.filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled'; });
  const completed = allTasks.filter(function (t) { return t.status === 'Completed' && t.completed_at && inWeek_(t.completed_at, r.start); });
  const pending = allTasks.filter(function (t) { return t.status !== 'Completed' && t.status !== 'Cancelled'; });
  const overdue = pending.filter(isOverdue_);
  const blocked = allTasks.filter(function (t) { return t.status === 'Blocked'; });
  const noExplanation = pending.filter(function (t) { return !t.blocked_reason && !t.impact_reason && !t.impact_notes; });
  const memberName = memberId === 'ALL' ? 'Academic Affairs Team' :
    ((members.filter(function (m) { return String(m.member_id) === String(memberId); })[0] || {}).display_name || memberId);
  let eff = 0;
  logs.forEach(function (l) { eff += Number(l.minutes_spent) || 0; });

  const lines = [];
  lines.push('WEEKLY ACCOMPLISHMENT REPORT — ' + memberName);
  lines.push('Reporting period: ' + r.start + ' to ' + r.end + ' (' + tz_() + ', Mon–Sun; working days Mon–Fri).');
  lines.push('');
  lines.push('Planned tasks: ' + planned.length + '; completed overall: ' +
    planned.filter(function (t) { return t.status === 'Completed'; }).length + '.');
  lines.push('Completed this week (' + completed.length + '):');
  completed.forEach(function (t) { lines.push('  • ' + t.title + ' [' + t.task_type + ']'); });
  lines.push('Additional work received: ' + adds.length + '; completed: ' +
    adds.filter(function (t) { return t.status === 'Completed'; }).length + '.');
  lines.push('Recorded effort this week: ' + eff + ' minutes (' + r1_(eff / 60) + ' hours).');
  lines.push('Pending: ' + pending.length + '; overdue: ' + overdue.length + '; blocked: ' + blocked.length + '.');
  blocked.forEach(function (t) { lines.push('  • BLOCKED: ' + t.title + ' — ' + (t.blocked_reason || 'reason not recorded')); });
  if (noExplanation.length) {
    lines.push('Tasks requiring clarification (' + noExplanation.length + '):');
    noExplanation.forEach(function (t) { lines.push('  • ' + t.title + ' — no documented reason for incomplete status'); });
  }
  if (impacts.length) {
    lines.push('Documented workload impacts: ' + impacts.length + ' link(s) between additional and planned work.');
    impacts.forEach(function (i) {
      lines.push('  • ' + i.additional_task_id + ' → ' + i.affected_task_id + ' (' + i.impact_type + '): ' + (i.reason || 'see evidence notes'));
    });
  } else {
    lines.push('No workload-impact links recorded this week.');
  }
  lines.push('');
  lines.push('Next steps: carry forward ' + pending.length + ' pending task(s); see task list for remaining work.');
  const text = lines.join('\n');
  return {
    week_start: r.start, week_end: r.end, member_id: memberId, member_name: memberName,
    text: text, markdown: text,
    counts: {
      planned: planned.length, additional: adds.length, completedThisWeek: completed.length,
      pending: pending.length, overdue: overdue.length, blocked: blocked.length,
      needingClarification: noExplanation.length, effortMinutes: eff
    },
    summary: summarize_(allTasks, logs),
    updates: updates, workLogs: logs, impacts: impacts,
    tasks: { planned: planned, additional: adds, completed: completed, pending: pending, overdue: overdue, blocked: blocked },
    generated_at: nowISO_()
  };
}

function createSnapshot_(p, actor) {
  const r = weekRange_(p.week_start || new Date());
  const memberId = p.member_id || 'ALL';
  let tasks = readAll_('Tasks').filter(function (t) { return !t.archived_at; });
  let logs = readAll_('WorkLogs');
  if (memberId !== 'ALL') {
    tasks = tasks.filter(function (t) { return String(t.owner_id) === String(memberId); });
    logs = logs.filter(function (l) { return String(l.member_id) === String(memberId); });
  }
  const existing = readWhere_('WeeklySnapshots', 'member_id', memberId).filter(function (s) {
    return dateKey_(s.week_start) === r.start;
  });
  const weekTasks = tasks.filter(function (t) { return weekScope_(t, r); });
  const weekLogs = logs.filter(function (l) { return inWeek_(l.work_date || l.created_at, r.start); });
  const s = summarize_(weekTasks, weekLogs);
  const planned = eligible_(weekTasks, 'PLANNED');
  const adds = weekTasks.filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled'; });
  const row = {
    snapshot_id: existing.length ? existing[0].snapshot_id : uid_('S'),
    week_start: r.start, week_end: r.end, member_id: memberId,
    planned_task_count: planned.length,
    completed_planned_count: planned.filter(function (t) { return t.status === 'Completed'; }).length,
    planned_completion_percent: s.plannedCompletion !== null ? s.plannedCompletion : '',
    weighted_completion_percent: s.weightedCompletion !== null ? s.weightedCompletion : '',
    additional_task_count: adds.filter(function (t) { return inWeek_(t.created_at, r.start); }).length,
    additional_completed_count: adds.filter(function (t) { return t.status === 'Completed' && inWeek_(t.completed_at, r.start); }).length,
    additional_effort_minutes: s.additionalEffortMinutes,
    overdue_count: s.overdueCount, blocked_count: s.blockedCount, generated_at: nowISO_()
  };
  if (existing.length) {
    updateRowById_('WeeklySnapshots', 'snapshot_id', row.snapshot_id, row);
    event_('', memberId, 'snapshot_regenerated', '', r.start, '', actor);
  } else {
    appendRow_('WeeklySnapshots', row);
    event_('', memberId, 'snapshot_created', '', r.start, '', actor);
  }
  return row;
}

function exportCsv_(p) {
  const name = p.sheet || 'Tasks';
  if (!SCHEMA[name]) throw coded_('VALIDATION', 'Unknown sheet for export: ' + name);
  const rows = readAll_(name);
  const header = SCHEMA[name];
  const esc = function (v) {
    let s = v === null || v === undefined ? '' : String(v);
    // Neutralise spreadsheet formula injection when the CSV is opened in Excel/Sheets.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [header.map(esc).join(',')];
  rows.forEach(function (r) { out.push(header.map(function (h) { return esc(r[h]); }).join(',')); });
  return { sheet: name, rowCount: rows.length, csv: out.join('\n') };
}

/* ============================== Responses ============================== */

function merge_(a, b) {
  const o = {};
  Object.keys(a).forEach(function (k) { o[k] = a[k]; });
  Object.keys(b).forEach(function (k) { o[k] = b[k]; });
  return o;
}

function coded_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function publicError_(err) {
  const code = (err && err.code) || 'INTERNAL';
  let msg = (err && err.message) || 'Unexpected server error.';
  if (code === 'INTERNAL') {
    console.error(err && err.stack ? err.stack : String(err)); // visible in Apps Script execution logs only
    msg = 'Unexpected server error. Check the Apps Script execution logs.';
  }
  return { code: code, message: msg };
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
