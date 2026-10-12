/**
 * Academic Affairs Workload Dashboard — Google Apps Script JSON API backend.
 *
 * Deploy: Publish → Deploy as web app → Execute as: Me, Access: Anyone (or
 * domain-limited if available) → copy /exec URL into frontend config.
 *
 * Frontend talks to this API ONLY via fetch() (no google.script.run, no
 * Apps Script-hosted HTML). All validation + calculations happen here.
 *
 * Script Properties (Project Settings → Script Properties):
 *   EDIT_KEY        — shared secret required for any write action
 *   ADMIN_KEY       — secret required for roster/admin + settings actions
 *   TIMEZONE        — default Asia/Manila
 *   WEEK_START_DAY  — default MON (reporting week Mon–Sun; display Mon–Fri)
 *
 * Sheets created automatically on first run via ensureSchema_().
 */

/* ============================== Schema ============================== */

var SCHEMA = {
  TeamMembers: ['member_id', 'display_name', 'role', 'department', 'is_active', 'created_at'],
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
  Settings: ['key', 'value', 'updated_at']
};

var ROSTER = [
  ['M001', 'Michelle Ann F. Pablo', 'Academic Affairs Director', 'Academic Affairs', 'TRUE'],
  ['M002', 'Michelle M. Macatangay', 'Academic Affairs Manager', 'Academic Affairs', 'TRUE'],
  ['M003', 'Divina G. Asuncion', 'Academic Development and Alumni Associate', 'Academic Affairs', 'TRUE'],
  ['M004', 'Kathlyn Kate N. Mauricio', 'Training Development and Extension Associate', 'Academic Affairs', 'TRUE'],
  ['M005', 'Juhayna M. Sultan', 'Research Assistant', 'Academic Affairs', 'TRUE'],
  ['M006', 'Catherine M. Madriaga', 'Administrative Assistant', 'Academic Affairs', 'TRUE'],
  ['M007', 'Jemima P. Sarmiento', 'Laboratory Technician', 'Academic Affairs', 'TRUE'],
  ['M008', 'Piolo B. Bernardino', 'Learning Management Associate', 'Academic Affairs', 'TRUE'],
  ['M009', 'Perly S. Saldivar', 'OVPAA Clerk', 'Academic Affairs', 'TRUE'],
  ['M010', 'Rhea Duremdes', 'Academic Affairs Secretary', 'Academic Affairs', 'TRUE'],
  ['M011', 'Jerome Balbuena', 'Laboratory Custodian', 'Academic Affairs', 'TRUE']
];

var STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Completed', 'Cancelled'];
var TASK_TYPES = ['PLANNED', 'ADDITIONAL'];
var IMPACT_TYPES = ['No Impact', 'Delayed', 'Paused', 'Scope Changed', 'Dependency Affected'];

var DEFAULT_SETTINGS = {
  timezone: 'Asia/Manila',
  week_start_day: 'MON',
  working_days: 'MON,TUE,WED,THU,FRI',
  working_hours_start: '08:00',
  working_hours_end: '17:00',
  require_outcome_on_complete: 'TRUE',
  dashboard_default_view: 'individual'
};

/* ============================== Entry points ============================== */

function doGet(e) {
  var params = (e && e.parameter) || {};
  var action = params.action || 'ping';
  // GET is read-only: block write actions over GET
  var WRITE_ACTIONS = ['createTask', 'updateTask', 'archiveTask', 'addDailyUpdate', 'addWorkLog',
    'upsertImpact', 'upsertMember', 'createSnapshot', 'saveSettings'];
  if (WRITE_ACTIONS.indexOf(action) !== -1) {
    return jsonOut({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for write actions.' } });
  }
  try {
    var data = route_(action, params.payload ? JSON.parse(params.payload) : {}, null);
    return jsonOut({ ok: true, data: data });
  } catch (err) {
    return jsonOut({ ok: false, error: publicError_(err) });
  }
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOut({ ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' } });
  }
  try {
    var data = route_(body.action || 'ping', body.payload || {}, body.key || null, body.adminKey || null);
    return jsonOut({ ok: true, data: data });
  } catch (err) {
    return jsonOut({ ok: false, error: publicError_(err) });
  }
}

/** One-time setup: run manually from the Apps Script editor. */
function setup() {
  ensureSchema_();
  seedRoster_();
  seedSettings_();
  return 'Setup complete: sheets, roster, and settings initialized.';
}

/** Safe weekly snapshot trigger (idempotent per week+member). Install as weekly time trigger. */
function scheduledWeeklySnapshot() {
  ensureSchema_();
  var monday = mondayOf_(new Date());
  var members = readAll_('TeamMembers');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    createSnapshot_({ week_start: monday, member_id: 'ALL' }, 'system-scheduler');
    for (var i = 0; i < members.length; i++) {
      createSnapshot_({ week_start: monday, member_id: members[i].member_id }, 'system-scheduler');
    }
  } finally {
    lock.releaseLock();
  }
}

/* ============================== Router ============================== */

function route_(action, p, key, adminKey) {
  p = p || {};
  ensureSchema_();
  switch (action) {
    case 'ping': return { status: 'ok', time: new Date().toISOString(), sheets: Object.keys(SCHEMA) };
    case 'initLoad': return initLoad_(p);
    case 'listMembers': return readAll_('TeamMembers');
    case 'upsertMember': requireAdmin_(adminKey); return withLock_(function () { return upsertMember_(p); });
    case 'listTasks': return queryTasks_(p);
    case 'createTask': requireEdit_(key); return withLock_(function () { return createTask_(p, p._actor || 'editor'); });
    case 'updateTask': requireEdit_(key); return withLock_(function () { return updateTask_(p, p._actor || 'editor'); });
    case 'archiveTask': requireEdit_(key); return withLock_(function () { return archiveTask_(p, p._actor || 'editor'); });
    case 'addDailyUpdate': requireEdit_(key); return withLock_(function () { return addDailyUpdate_(p); });
    case 'listDailyUpdates': return querySheet_('DailyUpdates', p);
    case 'addWorkLog': requireEdit_(key); return withLock_(function () { return addWorkLog_(p); });
    case 'listWorkLogs': return querySheet_('WorkLogs', p);
    case 'taskHistory': return taskHistory_(p.task_id);
    case 'upsertImpact': requireEdit_(key); return withLock_(function () { return upsertImpact_(p, p._actor || 'editor'); });
    case 'listImpacts': return querySheet_('TaskImpacts', p);
    case 'teamAnalytics': return teamAnalytics_(p);
    case 'weeklyReport': return weeklyReport_(p);
    case 'createSnapshot': requireEdit_(key); return withLock_(function () { return createSnapshot_(p, p._actor || 'editor'); });
    case 'listSnapshots': return querySheet_('WeeklySnapshots', p);
    case 'exportCsv': return exportCsv_(p);
    case 'getSettings': return readSettings_();
    case 'saveSettings': requireAdmin_(adminKey); return withLock_(function () { return saveSettings_(p); });
    default: throw coded_('UNKNOWN_ACTION', 'Unknown action: ' + action);
  }
}

/* ============================== Auth ============================== */

function props_() { return PropertiesService.getScriptProperties(); }

function requireEdit_(key) {
  var expected = props_().getProperty('EDIT_KEY');
  if (!expected) throw coded_('NOT_CONFIGURED', 'EDIT_KEY is not configured. Ask an administrator to set Script Properties.');
  if (key !== expected) throw coded_('FORBIDDEN', 'Invalid edit key.');
}

function requireAdmin_(adminKey) {
  var expected = props_().getProperty('ADMIN_KEY');
  if (!expected) throw coded_('NOT_CONFIGURED', 'ADMIN_KEY is not configured. Ask an administrator to set Script Properties.');
  if (adminKey !== expected) throw coded_('FORBIDDEN', 'Invalid admin key.');
}

/* ============================== Sheets helpers ============================== */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function ensureSchema_() {
  var s = ss_();
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = s.getSheetByName(name);
    if (!sh) {
      sh = s.insertSheet(name);
      sh.appendRow(SCHEMA[name]);
      sh.setFrozenRows(1);
    } else {
      // Header validation + forward migration: add missing columns, never reorder silently
      var header = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
      var expected = SCHEMA[name];
      var missing = expected.filter(function (h) { return header.indexOf(h) === -1; });
      if (missing.length) {
        sh.getRange(1, header.length + 1, 1, missing.length).setValues([missing]);
      }
    }
  });
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw coded_('SCHEMA_ERROR', 'Missing sheet: ' + name + '. Run setup().');
  return sh;
}

function headerMap_(name) {
  var sh = sheet_(name);
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var map = {};
  header.forEach(function (h, i) { map[h] = i; });
  // Validate required headers exist (position-independent)
  SCHEMA[name].forEach(function (h) {
    if (!(h in map)) throw coded_('SCHEMA_ERROR', 'Sheet ' + name + ' is missing column: ' + h);
  });
  return { header: header, map: map };
}

function readAll_(name) {
  var sh = sheet_(name);
  var hm = headerMap_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, hm.header.length).getValues();
  return vals
    .filter(function (r) { return r.some(function (c) { return c !== '' && c !== null; }); })
    .map(function (r) {
      var o = {};
      hm.header.forEach(function (h, i) { o[h] = fmtCell_(r[i]); });
      return o;
    });
}

function fmtCell_(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return v;
}

function appendRow_(name, obj) {
  var sh = sheet_(name);
  var hm = headerMap_(name);
  var row = hm.header.map(function (h) { return obj[h] !== undefined && obj[h] !== null ? obj[h] : ''; });
  sh.appendRow(row);
}

function updateRowById_(name, idField, idVal, patch) {
  var sh = sheet_(name);
  var hm = headerMap_(name);
  var last = sh.getLastRow();
  if (last < 2) throw coded_('NOT_FOUND', idField + ' ' + idVal + ' not found.');
  var col = hm.map[idField] + 1;
  var ids = sh.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(idVal)) {
      var rowNum = i + 2;
      Object.keys(patch).forEach(function (k) {
        if (k in hm.map) sh.getRange(rowNum, hm.map[k] + 1).setValue(patch[k]);
      });
      return rowNum;
    }
  }
  throw coded_('NOT_FOUND', idField + ' ' + idVal + ' not found.');
}

function findById_(name, idField, idVal) {
  var rows = readAll_(name);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][idField]) === String(idVal)) return rows[i];
  }
  return null;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function uid_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function nowISO_() { return new Date().toISOString(); }

function querySheet_(name, p) {
  var rows = readAll_(name);
  Object.keys(p || {}).forEach(function (k) {
    if (k.charAt(0) === '_' || p[k] === undefined || p[k] === '' || p[k] === null) return;
    if (SCHEMA[name].indexOf(k) === -1) return;
    rows = rows.filter(function (r) { return String(r[k]) === String(p[k]); });
  });
  var limit = Math.min(Number((p || {}).limit) || 500, 2000);
  return rows.slice(0, limit);
}

/* ============================== Seed ============================== */

function seedRoster_() {
  var existing = readAll_('TeamMembers');
  if (existing.length) return { seeded: 0, note: 'Roster already populated.' };
  var now = nowISO_();
  ROSTER.forEach(function (r) {
    appendRow_('TeamMembers', {
      member_id: r[0], display_name: r[1], role: r[2], department: r[3],
      is_active: r[4], created_at: now
    });
  });
  return { seeded: ROSTER.length };
}

function seedSettings_() {
  var rows = readAll_('Settings');
  var have = {};
  rows.forEach(function (r) { have[r.key] = true; });
  var now = nowISO_();
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (!have[k]) appendRow_('Settings', { key: k, value: DEFAULT_SETTINGS[k], updated_at: now });
  });
}

function readSettings_() {
  var rows = readAll_('Settings');
  var o = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { o[k] = DEFAULT_SETTINGS[k]; });
  rows.forEach(function (r) { if (r.key) o[r.key] = r.value; });
  var p = props_();
  o.timezone = p.getProperty('TIMEZONE') || o.timezone;
  o.configured = { hasEditKey: !!p.getProperty('EDIT_KEY'), hasAdminKey: !!p.getProperty('ADMIN_KEY') };
  return o;
}

function saveSettings_(p) {
  var allowed = ['timezone', 'week_start_day', 'working_days', 'working_hours_start',
    'working_hours_end', 'require_outcome_on_complete', 'dashboard_default_view'];
  allowed.forEach(function (k) {
    if (p[k] !== undefined) {
      var ex = findByKey_('Settings', k);
      if (ex) updateRowById_('Settings', 'key', k, { value: String(p[k]), updated_at: nowISO_() });
      else appendRow_('Settings', { key: k, value: String(p[k]), updated_at: nowISO_() });
    }
  });
  return readSettings_();
}

function findByKey_(name, keyVal) {
  var rows = readAll_(name);
  for (var i = 0; i < rows.length; i++) if (rows[i].key === keyVal) return rows[i];
  return null;
}

/* ============================== Validation ============================== */

function numOrNull_(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function validateTask_(t) {
  var errors = [];
  if (!t.title || !String(t.title).trim()) errors.push('Title is required.');
  if (t.task_type && TASK_TYPES.indexOf(t.task_type) === -1) errors.push('task_type must be PLANNED or ADDITIONAL.');
  if (t.status && STATUSES.indexOf(t.status) === -1) errors.push('Invalid status: ' + t.status + '.');
  var pct = numOrNull_(t.completion_percent);
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
      var n = Number(t[f]);
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
    reason: reason || '', actor: actor || '', event_timestamp: nowISO_()
  });
}

/* ============================== Tasks ============================== */

function upsertMember_(p) {
  if (!p.display_name || !String(p.display_name).trim()) throw coded_('VALIDATION', 'display_name is required.');
  var now = nowISO_();
  if (p.member_id && findById_('TeamMembers', 'member_id', p.member_id)) {
    var patch = {
      display_name: p.display_name, role: p.role || '', department: p.department || 'Academic Affairs',
      is_active: p.is_active !== undefined ? (p.is_active ? 'TRUE' : 'FALSE') : 'TRUE'
    };
    updateRowById_('TeamMembers', 'member_id', p.member_id, patch);
    event_( '', p.member_id, 'member_updated', '', p.display_name, p.reason || '', p._actor || 'admin');
    return findById_('TeamMembers', 'member_id', p.member_id);
  }
  var row = {
    member_id: p.member_id || uid_('M'), display_name: p.display_name, role: p.role || '',
    department: p.department || 'Academic Affairs', is_active: 'TRUE', created_at: now
  };
  appendRow_('TeamMembers', row);
  return row;
}

function createTask_(p, actor) {
  var now = nowISO_();
  var t = {
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
    completion_percent: p.completion_percent !== undefined ? Number(p.completion_percent) : 0,
    estimated_minutes: p.estimated_minutes !== undefined && p.estimated_minutes !== '' ? Number(p.estimated_minutes) : '',
    actual_minutes: p.actual_minutes !== undefined && p.actual_minutes !== '' ? Number(p.actual_minutes) : '',
    blocked_reason: p.blocked_reason || '',
    impact_reason: p.impact_reason || '',
    impact_notes: p.impact_notes || '',
    created_by: p.created_by || actor || '',
    last_updated_at: now,
    archived_at: ''
  };
  if (!t.owner_id || !findById_('TeamMembers', 'member_id', t.owner_id)) {
    throw coded_('VALIDATION', 'Valid owner_id (roster member) is required.');
  }
  if (findById_('Tasks', 'task_id', t.task_id)) throw coded_('DUPLICATE', 'task_id already exists (duplicate submission).');
  validateTask_(t);
  if (t.status === 'Completed') {
    var settings = readSettings_();
    if (String(settings.require_outcome_on_complete).toUpperCase() === 'TRUE' && !p.outcome_note && !t.impact_notes) {
      throw coded_('VALIDATION', 'Completing a task requires an outcome/accomplishment note.');
    }
  }
  appendRow_('Tasks', t);
  event_(t.task_id, t.owner_id, 'created', '', t.status, p.reason || '', actor);
  return t;
}

function updateTask_(p, actor) {
  if (!p.task_id) throw coded_('VALIDATION', 'task_id is required.');
  var cur = findById_('Tasks', 'task_id', p.task_id);
  if (!cur) throw coded_('NOT_FOUND', 'Task not found.');
  if (cur.archived_at) throw coded_('VALIDATION', 'Archived tasks cannot be edited. Restore first.');
  var next = {};
  Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
  var updatable = ['title', 'description', 'owner_id', 'task_type', 'requested_by', 'started_at',
    'current_due_at', 'completed_at', 'priority', 'status',
    'completion_percent', 'estimated_minutes', 'actual_minutes', 'blocked_reason',
    'impact_reason', 'impact_notes'];
  // NOTE: 'original_due_at' is intentionally NOT updatable — the original schedule
  // record must survive deadline revisions (revisions change current_due_at only).
  updatable.forEach(function (k) { if (p[k] !== undefined) next[k] = p[k]; });
  next.last_updated_at = nowISO_();
  var reason = p.reason || '';
  // New-owner validity is checked before any write.
  if (String(cur.owner_id) !== String(next.owner_id)) {
    if (!next.owner_id || !findById_('TeamMembers', 'member_id', next.owner_id)) {
      throw coded_('VALIDATION', 'New owner_id must be a valid roster member.');
    }
  }
  if (String(cur.current_due_at) !== String(next.current_due_at) && !reason) {
    throw coded_('VALIDATION', 'A reason is required when changing the deadline.');
  }
  if (next.status === 'Completed' && cur.status !== 'Completed') {
    if (!next.completed_at) next.completed_at = nowISO_();
    next.completion_percent = 100;
    var settings = readSettings_();
    if (String(settings.require_outcome_on_complete).toUpperCase() === 'TRUE' && !p.outcome_note && !next.impact_notes && !p.impact_notes) {
      throw coded_('VALIDATION', 'Completing a task requires an outcome/accomplishment note (outcome_note).');
    }
  }
  if (next.status === 'Cancelled' && cur.status !== 'Cancelled') {
    next.completed_at = '';
  }
  // Validate BEFORE emitting audit events or writing rows: a rejected update
  // must not leave orphan TaskEvents/DailyUpdates behind.
  validateTask_(next);
  // Track lifecycle events (only reached when the update is valid).
  if (String(cur.owner_id) !== String(next.owner_id)) {
    event_(next.task_id, next.owner_id, 'reassigned', cur.owner_id, next.owner_id, reason, actor);
  }
  if (String(cur.current_due_at) !== String(next.current_due_at)) {
    event_(next.task_id, next.owner_id, 'deadline_changed', cur.current_due_at, next.current_due_at, reason, actor);
  }
  if (String(cur.completion_percent) !== String(next.completion_percent) || cur.status !== next.status) {
    event_(next.task_id, next.owner_id, 'progress_changed',
      cur.status + ' ' + cur.completion_percent + '%', next.status + ' ' + next.completion_percent + '%', reason, actor);
  }
  if (next.status === 'Completed' && cur.status !== 'Completed') {
    if (p.outcome_note) {
      appendRow_('DailyUpdates', {
        update_id: uid_('U'), task_id: next.task_id, member_id: next.owner_id,
        update_date: nowISO_().slice(0, 10), previous_percent: cur.completion_percent,
        new_percent: 100, accomplishment_notes: String(p.outcome_note),
        remaining_work: '', blocker_notes: '', created_at: nowISO_()
      });
    }
    event_(next.task_id, next.owner_id, 'completed', cur.status, 'Completed', reason, actor);
  }
  if (next.status === 'Cancelled' && cur.status !== 'Cancelled') {
    event_(next.task_id, next.owner_id, 'cancelled', cur.status, 'Cancelled', reason, actor);
  }
  updateRowById_('Tasks', 'task_id', next.task_id, next);
  return next;
}

function archiveTask_(p, actor) {
  if (!p.task_id) throw coded_('VALIDATION', 'task_id is required.');
  var cur = findById_('Tasks', 'task_id', p.task_id);
  if (!cur) throw coded_('NOT_FOUND', 'Task not found.');
  var patch = { archived_at: nowISO_(), last_updated_at: nowISO_() };
  updateRowById_('Tasks', 'task_id', p.task_id, patch);
  event_(p.task_id, cur.owner_id, 'archived', '', '', p.reason || '', actor);
  return { task_id: p.task_id, archived_at: patch.archived_at };
}

function queryTasks_(p) {
  var rows = readAll_('Tasks');
  var includeArchived = String(p.includeArchived) === 'true';
  if (!includeArchived) rows = rows.filter(function (t) { return !t.archived_at; });
  ['owner_id', 'task_type', 'status', 'priority'].forEach(function (k) {
    if (p[k]) rows = rows.filter(function (t) { return String(t[k]) === String(p[k]); });
  });
  if (p.week_start) {
    var r = weekRange_(p.week_start);
    rows = rows.filter(function (t) {
      var c = String(t.created_at || '').slice(0, 10);
      var d = String(t.current_due_at || t.original_due_at || '').slice(0, 10);
      var done = String(t.completed_at || '').slice(0, 10);
      return (c >= r.start && c <= r.end) || (d >= r.start && d <= r.end) || (done >= r.start && done <= r.end) ||
        (!t.completed_at && !t.archived_at && t.status !== 'Cancelled' && c && c < r.start); // carryover kept visible
    });
  }
  if (p.q) {
    var q = String(p.q).toLowerCase();
    rows = rows.filter(function (t) {
      return String(t.title + ' ' + t.description).toLowerCase().indexOf(q) !== -1;
    });
  }
  rows.sort(function (a, b) { return String(a.created_at) < String(b.created_at) ? 1 : -1; });
  return rows.slice(0, Math.min(Number(p.limit) || 500, 2000));
}

/* ============================== Daily updates & work logs ============================== */

function addDailyUpdate_(p) {
  if (!p.task_id || !p.member_id) throw coded_('VALIDATION', 'task_id and member_id are required.');
  var task = findById_('Tasks', 'task_id', p.task_id);
  if (!task) throw coded_('NOT_FOUND', 'Task not found.');
  if (task.archived_at) throw coded_('VALIDATION', 'Cannot update an archived task.');
  var newPct = p.new_percent !== undefined ? Number(p.new_percent) : Number(task.completion_percent);
  if (!isFinite(newPct) || newPct < 0 || newPct > 100) throw coded_('VALIDATION', 'new_percent must be 0–100.');
  if (newPct < Number(task.completion_percent || 0) && !p.reason) {
    throw coded_('VALIDATION', 'Reducing progress requires a reason.');
  }
  // Duplicate guard: same task+member+date+new_percent
  var day = (p.update_date || nowISO_()).slice(0, 10);
  var existing = readAll_('DailyUpdates').filter(function (u) {
    return String(u.task_id) === String(p.task_id) && String(u.member_id) === String(p.member_id) &&
      String(u.update_date).slice(0, 10) === day && Number(u.new_percent) === newPct;
  });
  if (existing.length && !p.allowDuplicate) throw coded_('DUPLICATE', 'An identical update for this task/day already exists.');
  var row = {
    update_id: p.update_id || uid_('U'), task_id: p.task_id, member_id: p.member_id,
    update_date: day, previous_percent: task.completion_percent, new_percent: newPct,
    accomplishment_notes: p.accomplishment_notes || '', remaining_work: p.remaining_work || '',
    blocker_notes: p.blocker_notes || '', created_at: nowISO_()
  };
  if (findById_('DailyUpdates', 'update_id', row.update_id)) throw coded_('DUPLICATE', 'update_id already exists.');
  // Advance task progress (history preserved in DailyUpdates).
  // Validate FIRST so a rejected update leaves no orphan DailyUpdate row (no partial writes).
  var patch = { completion_percent: newPct, last_updated_at: nowISO_() };
  if (newPct > 0 && !task.started_at) patch.started_at = nowISO_();
  if (p.blocker_notes) patch.blocked_reason = p.blocker_notes;
  if (newPct === 100) {
    patch.status = 'Completed';
    patch.completed_at = nowISO_();
    if (!row.accomplishment_notes) {
      var settings = readSettings_();
      if (String(settings.require_outcome_on_complete).toUpperCase() === 'TRUE') {
        throw coded_('VALIDATION', 'Reaching 100% requires accomplishment_notes.');
      }
    }
  } else if (task.status === 'Completed' && newPct < 100) {
    patch.status = 'In Progress';
    patch.completed_at = '';
  } else if (task.status === 'Not Started' && newPct > 0) {
    patch.status = 'In Progress';
  }
  validateTask_(merge_(task, patch));
  appendRow_('DailyUpdates', row);
  updateRowById_('Tasks', 'task_id', p.task_id, patch);
  event_(p.task_id, p.member_id, 'progress_changed', String(task.completion_percent) + '%', String(newPct) + '%', p.reason || '', p._actor || p.member_id);
  return row;
}

function addWorkLog_(p) {
  if (!p.task_id || !p.member_id) throw coded_('VALIDATION', 'task_id and member_id are required.');
  var task = findById_('Tasks', 'task_id', p.task_id);
  if (!task) throw coded_('NOT_FOUND', 'Task not found.');
  var minutes = numOrNull_(p.minutes_spent);
  if (p.start_time && p.end_time) {
    var a = new Date(p.start_time).getTime();
    var b = new Date(p.end_time).getTime();
    if (!isFinite(a) || !isFinite(b)) throw coded_('VALIDATION', 'Invalid start/end time.');
    if (b < a) throw coded_('VALIDATION', 'end_time must not be before start_time.');
    if (minutes === null) minutes = Math.round((b - a) / 60000);
  }
  if (minutes === null || minutes < 0 || minutes > 1440) throw coded_('VALIDATION', 'minutes_spent must be 0–1440 (or provide start/end times).');
  var row = {
    work_log_id: p.work_log_id || uid_('W'), task_id: p.task_id, member_id: p.member_id,
    work_date: (p.work_date || nowISO_()).slice(0, 10), start_time: p.start_time || '',
    end_time: p.end_time || '', minutes_spent: minutes, work_category: p.work_category || '',
    notes: p.notes || '', created_at: nowISO_()
  };
  if (findById_('WorkLogs', 'work_log_id', row.work_log_id)) throw coded_('DUPLICATE', 'work_log_id already exists (duplicate submission).');
  appendRow_('WorkLogs', row);
  // Roll actual effort onto the task (sum of logs). appendRow_ is synchronous,
  // so readAll_ already includes the new row — sum it exactly once.
  var logs = readAll_('WorkLogs').filter(function (l) { return String(l.task_id) === String(p.task_id); });
  var total = logs.reduce(function (s, l) { return s + (Number(l.minutes_spent) || 0); }, 0);
  updateRowById_('Tasks', 'task_id', p.task_id, { actual_minutes: total, last_updated_at: nowISO_() });
  return row;
}

function taskHistory_(taskId) {
  if (!taskId) throw coded_('VALIDATION', 'task_id is required.');
  var task = findById_('Tasks', 'task_id', taskId);
  if (!task) throw coded_('NOT_FOUND', 'Task not found.');
  var events = readAll_('TaskEvents').filter(function (e) { return String(e.task_id) === String(taskId); });
  var updates = readAll_('DailyUpdates').filter(function (u) { return String(u.task_id) === String(taskId); });
  var logs = readAll_('WorkLogs').filter(function (l) { return String(l.task_id) === String(taskId); });
  var impacts = readAll_('TaskImpacts').filter(function (i) {
    return String(i.additional_task_id) === String(taskId) || String(i.affected_task_id) === String(taskId);
  });
  events.sort(function (a, b) { return String(a.event_timestamp) < String(b.event_timestamp) ? -1 : 1; });
  updates.sort(function (a, b) { return String(a.update_date) < String(b.update_date) ? -1 : 1; });
  return { task: task, events: events, updates: updates, workLogs: logs, impacts: impacts };
}

/* ============================== Impacts ============================== */

function upsertImpact_(p, actor) {
  if (!p.additional_task_id || !p.affected_task_id) throw coded_('VALIDATION', 'additional_task_id and affected_task_id are required.');
  if (String(p.additional_task_id) === String(p.affected_task_id)) throw coded_('VALIDATION', 'A task cannot impact itself: additional_task_id and affected_task_id must differ.');
  var add = findById_('Tasks', 'task_id', p.additional_task_id);
  var aff = findById_('Tasks', 'task_id', p.affected_task_id);
  if (!add || !aff) throw coded_('NOT_FOUND', 'Linked task not found.');
  if (add.task_type !== 'ADDITIONAL') throw coded_('VALIDATION', 'additional_task_id must reference a task of type ADDITIONAL.');
  if (aff.task_type !== 'PLANNED') throw coded_('VALIDATION', 'affected_task_id must reference a planned (original) task.');
  var type = p.impact_type || 'Delayed';
  if (IMPACT_TYPES.indexOf(type) === -1) throw coded_('VALIDATION', 'Invalid impact_type.');
  var now = nowISO_();
  if (p.impact_id && findById_('TaskImpacts', 'impact_id', p.impact_id)) {
    var patch = {
      impact_type: type, estimated_delay_minutes: numOrNull_(p.estimated_delay_minutes) !== null ? numOrNull_(p.estimated_delay_minutes) : '',
      actual_delay_minutes: numOrNull_(p.actual_delay_minutes) !== null ? numOrNull_(p.actual_delay_minutes) : '',
      reason: p.reason || '', evidence_notes: p.evidence_notes || '', updated_at: now
    };
    updateRowById_('TaskImpacts', 'impact_id', p.impact_id, patch);
    return findById_('TaskImpacts', 'impact_id', p.impact_id);
  }
  var row = {
    impact_id: uid_('I'), additional_task_id: p.additional_task_id, affected_task_id: p.affected_task_id,
    impact_type: type, estimated_delay_minutes: numOrNull_(p.estimated_delay_minutes) !== null ? numOrNull_(p.estimated_delay_minutes) : '',
    actual_delay_minutes: numOrNull_(p.actual_delay_minutes) !== null ? numOrNull_(p.actual_delay_minutes) : '',
    reason: p.reason || '', evidence_notes: p.evidence_notes || '',
    created_by: p.created_by || actor || '', created_at: now, updated_at: now
  };
  appendRow_('TaskImpacts', row);
  event_(p.affected_task_id, aff.owner_id, 'impact_linked', '', p.additional_task_id + ' → ' + type, p.reason || '', actor);
  return row;
}

/* ============================== Analytics & reports ============================== */

function tz_() {
  try { return props_().getProperty('TIMEZONE') || DEFAULT_SETTINGS.timezone; } catch (e) { return 'Asia/Manila'; }
}

function mondayOf_(d) {
  var tz = tz_();
  var s = Utilities.formatDate(new Date(d), tz, 'yyyy-MM-dd');
  var dt = new Date(s + 'T12:00:00Z');
  var wd = Number(Utilities.formatDate(new Date(d), tz, 'u')); // 1=Mon..7=Sun
  dt.setUTCDate(dt.getUTCDate() - (wd - 1));
  return dt.toISOString().slice(0, 10);
}

function weekRange_(weekStart) {
  var s = new Date(weekStart.slice(0, 10) + 'T00:00:00Z');
  var e = new Date(s);
  e.setUTCDate(e.getUTCDate() + 6);
  return { start: s.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10) };
}

function inWeek_(iso, weekStart) {
  if (!iso) return false;
  var d = String(iso).slice(0, 10);
  var r = weekRange_(weekStart);
  return d >= r.start && d <= r.end;
}

function isOverdue_(t, nowISO) {
  if (!t || t.status === 'Completed' || t.status === 'Cancelled') return false;
  var due = t.current_due_at || t.original_due_at;
  if (!due) return false;
  var tz = tz_();
  var nowDay = Utilities.formatDate(new Date(nowISO), tz, 'yyyy-MM-dd');
  return String(due).slice(0, 10) < nowDay;
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
  var elig = eligible_(tasks, null);
  var planned = eligible_(tasks, 'PLANNED');
  var adds = tasks.filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled' && !t.archived_at; });
  var cc = planned.length ? r1_(planned.filter(function (t) { return t.status === 'Completed'; }).length / planned.length * 100) : null;
  var num = 0, den = 0, excl = 0;
  planned.forEach(function (t) {
    var est = Number(t.estimated_minutes);
    if (!isFinite(est) || est <= 0) { excl++; return; }
    var pct = Math.min(100, Math.max(0, Number(t.completion_percent) || 0));
    num += est * pct / 100; den += est;
  });
  var addEffort = 0;
  var addIds = {};
  adds.forEach(function (t) { addIds[String(t.task_id)] = true; });
  (workLogs || []).forEach(function (l) { if (addIds[String(l.task_id)]) addEffort += Number(l.minutes_spent) || 0; });
  var now = nowISO_();
  return {
    plannedCount: planned.length,
    plannedCompleted: planned.filter(function (t) { return t.status === 'Completed'; }).length,
    plannedCompletion: cc,
    weightedCompletion: den ? r1_(num / den * 100) : null,
    weightedExcluded: excl,
    additionalCount: adds.length,
    additionalCompleted: adds.filter(function (t) { return t.status === 'Completed'; }).length,
    additionalEffortMinutes: addEffort,
    overdueCount: elig.filter(function (t) { return isOverdue_(t, now); }).length,
    blockedCount: elig.filter(function (t) { return t.status === 'Blocked'; }).length
  };
}

function turnaround_(adds, tz) {
  var list = adds.filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled' && !t.archived_at; });
  var completed = list.filter(function (t) { return t.status === 'Completed' && t.completed_at && t.created_at; });
  var ms = completed.map(function (t) { return new Date(t.completed_at).getTime() - new Date(t.created_at).getTime(); })
    .filter(function (n) { return isFinite(n) && n >= 0; }).sort(function (a, b) { return a - b; });
  var mean = ms.length ? ms.reduce(function (a, b) { return a + b; }, 0) / ms.length : null;
  var med = ms.length ? (ms.length % 2 ? ms[Math.floor(ms.length / 2)] : (ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2) : null;
  var sameDay = 0;
  completed.forEach(function (t) {
    try {
      var a = Utilities.formatDate(new Date(t.created_at), tz, 'yyyy-MM-dd');
      var b = Utilities.formatDate(new Date(t.completed_at), tz, 'yyyy-MM-dd');
      if (a === b) sameDay++;
    } catch (e) { if (String(t.created_at).slice(0, 10) === String(t.completed_at).slice(0, 10)) sameDay++; }
  });
  return {
    total: list.length, completed: completed.length, pending: list.length - completed.length,
    avgTurnaroundHours: mean !== null ? r1_(mean / 3600000) : null,
    medianTurnaroundHours: med !== null ? r1_(med / 3600000) : null,
    sameDayCompleted: sameDay, sameDayDenominator: completed.length,
    sameDayRate: completed.length ? r1_(sameDay / completed.length * 100) : null,
    incompleteData: list.filter(function (t) { return t.status === 'Completed' && (!t.created_at || !t.completed_at); }).length
  };
}

function initLoad_(p) {
  var members = readAll_('TeamMembers');
  var settings = readSettings_();
  var tasks = queryTasks_(p || {});
  return { members: members, settings: settings, tasks: tasks };
}

function teamAnalytics_(p) {
  var weekStart = p.week_start || mondayOf_(new Date());
  var r = weekRange_(weekStart);
  var tasks = readAll_('Tasks').filter(function (t) { return !t.archived_at; });
  var logs = readAll_('WorkLogs');
  var members = readAll_('TeamMembers');
  if (p.member_id && p.member_id !== 'ALL') {
    tasks = tasks.filter(function (t) { return String(t.owner_id) === String(p.member_id); });
    logs = logs.filter(function (l) { return String(l.member_id) === String(p.member_id); });
  }
  var weekTasks = tasks.filter(function (t) {
    var c = String(t.created_at || '').slice(0, 10);
    var d = String(t.current_due_at || t.original_due_at || '').slice(0, 10);
    var done = String(t.completed_at || '').slice(0, 10);
    return (c >= r.start && c <= r.end) || (d >= r.start && d <= r.end) || (done >= r.start && done <= r.end) ||
      (c && c < r.start && t.status !== 'Completed' && t.status !== 'Cancelled');
  });
  var weekLogs = logs.filter(function (l) { return inWeek_(l.work_date || l.created_at, weekStart); });
  var summary = summarize_(weekTasks, weekLogs);
  var ta = turnaround_(weekTasks, tz_());
  var byMember = members.map(function (m) {
    var mt = weekTasks.filter(function (t) { return String(t.owner_id) === String(m.member_id); });
    var ml = weekLogs.filter(function (l) { return String(l.member_id) === String(m.member_id); });
    return {
      member_id: m.member_id, display_name: m.display_name, role: m.role,
      summary: summarize_(mt, ml)
    };
  });
  var impacts = readAll_('TaskImpacts');
  var missingUpdates = weekTasks.filter(function (t) {
    return t.status !== 'Completed' && t.status !== 'Cancelled' && !t.actual_minutes && Number(t.completion_percent) === 0;
  }).map(function (t) { return { task_id: t.task_id, title: t.title, owner_id: t.owner_id }; });
  return {
    week_start: r.start, week_end: r.end, summary: summary, turnaround: ta,
    byMember: byMember, impactCount: impacts.length,
    missingUpdates: missingUpdates, taskCount: weekTasks.length
  };
}

function weeklyReport_(p) {
  var weekStart = p.week_start || mondayOf_(new Date());
  var r = weekRange_(weekStart);
  var memberId = p.member_id || 'ALL';
  // Week scope (same predicate as teamAnalytics_): created, due, or completed
  // in the week, plus open carryover from earlier weeks. All-time counts would
  // misstate "received this week", so scope first, then filter by member.
  var allTasks = readAll_('Tasks').filter(function (t) {
    if (t.archived_at) return false;
    var c = String(t.created_at || '').slice(0, 10);
    var d = String(t.current_due_at || t.original_due_at || '').slice(0, 10);
    var done = String(t.completed_at || '').slice(0, 10);
    return (c >= r.start && c <= r.end) || (d >= r.start && d <= r.end) || (done >= r.start && done <= r.end) ||
      (c && c < r.start && t.status !== 'Completed' && t.status !== 'Cancelled');
  });
  var updates = readAll_('DailyUpdates').filter(function (u) { return inWeek_(u.update_date, weekStart); });
  var logs = readAll_('WorkLogs').filter(function (l) { return inWeek_(l.work_date || l.created_at, weekStart); });
  var members = readAll_('TeamMembers');
  if (memberId !== 'ALL') {
    allTasks = allTasks.filter(function (t) { return String(t.owner_id) === String(memberId); });
    updates = updates.filter(function (u) { return String(u.member_id) === String(memberId); });
    logs = logs.filter(function (l) { return String(l.member_id) === String(memberId); });
  }
  // Impacts are scoped to the tasks in this report — a team report shows all
  // linked pairs in scope; a member report shows pairs touching that member's tasks.
  var inScopeIds = {};
  allTasks.forEach(function (t) { inScopeIds[String(t.task_id)] = true; });
  var impacts = readAll_('TaskImpacts').filter(function (i) {
    return inScopeIds[String(i.additional_task_id)] || inScopeIds[String(i.affected_task_id)];
  });
  var planned = allTasks.filter(function (t) { return t.task_type === 'PLANNED' && t.status !== 'Cancelled'; });
  var adds = allTasks.filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled'; });
  var completed = allTasks.filter(function (t) { return t.status === 'Completed' && t.completed_at && inWeek_(t.completed_at, weekStart); });
  var pending = allTasks.filter(function (t) { return t.status !== 'Completed' && t.status !== 'Cancelled'; });
  var overdue = pending.filter(function (t) { return isOverdue_(t, nowISO_()); });
  var blocked = allTasks.filter(function (t) { return t.status === 'Blocked'; });
  var noExplanation = pending.filter(function (t) { return !t.blocked_reason && !t.impact_reason && !t.impact_notes; });
  var memberName = memberId === 'ALL' ? 'Academic Affairs Team' :
    (members.filter(function (m) { return String(m.member_id) === String(memberId); })[0] || {}).display_name || memberId;
  var lines = [];
  lines.push('WEEKLY ACCOMPLISHMENT REPORT — ' + memberName);
  lines.push('Reporting period: ' + r.start + ' to ' + r.end + ' (Asia/Manila, Mon–Sun; working days Mon–Fri).');
  lines.push('');
  lines.push('Planned tasks: ' + planned.length + '; completed overall: ' +
    planned.filter(function (t) { return t.status === 'Completed'; }).length + '.');
  lines.push('Completed this week (' + completed.length + '):');
  completed.forEach(function (t) { lines.push('  • ' + t.title + ' [' + t.task_type + ']'); });
  lines.push('Additional work received: ' + adds.length + '; completed: ' +
    adds.filter(function (t) { return t.status === 'Completed'; }).length + '.');
  var eff = 0;
  logs.forEach(function (l) { eff += Number(l.minutes_spent) || 0; });
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
  var summary = summarize_(allTasks, logs);
  return {
    week_start: r.start, week_end: r.end, member_id: memberId, member_name: memberName,
    text: lines.join('\n'), markdown: lines.join('\n'),
    counts: {
      planned: planned.length, additional: adds.length, completedThisWeek: completed.length,
      pending: pending.length, overdue: overdue.length, blocked: blocked.length,
      needingClarification: noExplanation.length, effortMinutes: eff
    },
    summary: summary,
    updates: updates, workLogs: logs, impacts: impacts,
    tasks: { planned: planned, additional: adds, completed: completed, pending: pending, overdue: overdue, blocked: blocked },
    generated_at: nowISO_()
  };
}

function createSnapshot_(p, actor) {
  var weekStart = (p.week_start || mondayOf_(new Date())).slice(0, 10);
  var r = weekRange_(weekStart);
  var memberId = p.member_id || 'ALL';
  var tasks = readAll_('Tasks').filter(function (t) { return !t.archived_at; });
  var logs = readAll_('WorkLogs');
  if (memberId !== 'ALL') {
    tasks = tasks.filter(function (t) { return String(t.owner_id) === String(memberId); });
    logs = logs.filter(function (l) { return String(l.member_id) === String(memberId); });
  }
  // Idempotent: update existing snapshot for same week+member instead of duplicating
  var existing = readAll_('WeeklySnapshots').filter(function (s) {
    return String(s.week_start).slice(0, 10) === r.start && String(s.member_id) === String(memberId);
  });
  var weekTasks = tasks.filter(function (t) {
    var c = String(t.created_at || '').slice(0, 10);
    return inWeek_(t.created_at, weekStart) || inWeek_(t.current_due_at || t.original_due_at, weekStart) ||
      inWeek_(t.completed_at, weekStart) || (c && c < r.start && t.status !== 'Completed' && t.status !== 'Cancelled');
  });
  var weekLogs = logs.filter(function (l) { return inWeek_(l.work_date || l.created_at, weekStart); });
  var s = summarize_(weekTasks, weekLogs);
  var planned = eligible_(weekTasks, 'PLANNED');
  var adds = weekTasks.filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled'; });
  var row = {
    snapshot_id: existing.length ? existing[0].snapshot_id : uid_('S'),
    week_start: r.start, week_end: r.end, member_id: memberId,
    planned_task_count: planned.length,
    completed_planned_count: planned.filter(function (t) { return t.status === 'Completed'; }).length,
    planned_completion_percent: s.plannedCompletion !== null ? s.plannedCompletion : '',
    weighted_completion_percent: s.weightedCompletion !== null ? s.weightedCompletion : '',
    additional_task_count: adds.filter(function (t) { return inWeek_(t.created_at, weekStart); }).length,
    additional_completed_count: adds.filter(function (t) { return t.status === 'Completed' && inWeek_(t.completed_at, weekStart); }).length,
    additional_effort_minutes: s.additionalEffortMinutes,
    overdue_count: s.overdueCount, blocked_count: s.blockedCount, generated_at: nowISO_()
  };
  if (existing.length) {
    updateRowById_('WeeklySnapshots', 'snapshot_id', row.snapshot_id, row);
    event_('', memberId, 'snapshot_regenerated', '', weekStart, '', actor);
  } else {
    appendRow_('WeeklySnapshots', row);
    event_('', memberId, 'snapshot_created', '', weekStart, '', actor);
  }
  return row;
}

function exportCsv_(p) {
  var name = p.sheet || 'Tasks';
  if (!SCHEMA[name]) throw coded_('VALIDATION', 'Unknown sheet for export: ' + name);
  var rows = readAll_(name);
  var header = SCHEMA[name];
  var esc = function (v) {
    var s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  var out = [header.map(esc).join(',')];
  rows.forEach(function (r) { out.push(header.map(function (h) { return esc(r[h]); }).join(',')); });
  return { sheet: name, rowCount: rows.length, csv: out.join('\n') };
}

/* ============================== Responses ============================== */

function merge_(a, b) {
  var o = {};
  Object.keys(a).forEach(function (k) { o[k] = a[k]; });
  Object.keys(b).forEach(function (k) { o[k] = b[k]; });
  return o;
}

function coded_(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

function publicError_(err) {
  // Never leak stack traces or secrets to the client
  var code = (err && err.code) || 'INTERNAL';
  var msg = (err && err.message) || 'Unexpected server error.';
  if (code === 'INTERNAL') msg = 'Unexpected server error. Check the Apps Script execution logs.';
  return { code: code, message: msg };
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
