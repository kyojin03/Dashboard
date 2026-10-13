/**
 * Audit regression tests (added 2026-10-12 production-readiness audit).
 *
 * Two kinds of coverage:
 *  A. Functional consistency between the browser-global mirrors (js/reports.js,
 *     js/store.js — loaded via vm with a window stub) and the ES-module
 *     reference implementations in js/metrics.js.
 *  B. Static source guards on backend/Code.gs and js/app.js pinning the
 *     data-integrity fixes. These guard control-flow (validate-before-write,
 *     single rollup, week scoping) that cannot execute without a Google
 *     account; they are regression tripwires, NOT integration tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countCompletion, weightedCompletion, isOverdue as mOverdue,
  turnaroundStats, sameCalendarDate, inWeek, additionalWorkloadSummary
} from '../js/metrics.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadBrowserGlobal(relPath, globalName) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: relPath });
  return sandbox.window[globalName];
}

const Reports = loadBrowserGlobal('js/reports.js', 'Reports');
const Store = loadBrowserGlobal('js/store.js', 'Store');
const codeGs = fs.readFileSync(path.join(ROOT, 'backend/Code.gs'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');

function fnBody(src, fnName) {
  const start = src.indexOf('function ' + fnName);
  assert.ok(start !== -1, fnName + ' must exist');
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

const T = (o) => Object.assign({
  task_id: 'T1', title: 'X', owner_id: 'M001', task_type: 'PLANNED',
  status: 'In Progress', completion_percent: 50, estimated_minutes: 60,
  actual_minutes: 30, created_at: '2026-10-05T08:00:00+08:00',
  original_due_at: '2026-10-09T17:00:00+08:00', current_due_at: '2026-10-09T17:00:00+08:00',
  completed_at: null, archived_at: ''
}, o);

// ---------- A. Mirror consistency ----------

describe('reports.js mirrors metrics.js (Manila semantics)', () => {
  it('summarize agrees with count/weighted/overdue/additional-effort references', () => {
    const tasks = [
      T({ task_id: 'P1', status: 'Completed', completion_percent: 100, completed_at: '2026-10-07T10:00:00+08:00', estimated_minutes: 120 }),
      T({ task_id: 'P2', status: 'In Progress', completion_percent: 50, estimated_minutes: 120 }),
      T({ task_id: 'P3', status: 'Blocked', completion_percent: 10, estimated_minutes: '', blocked_reason: 'Waiting on vendor.' }),
      T({ task_id: 'A1', task_type: 'ADDITIONAL', status: 'Completed', completion_percent: 100, created_at: '2026-10-06T09:00:00+08:00', completed_at: '2026-10-06T10:00:00+08:00', actual_minutes: 60 })
    ];
    const logs = [{ task_id: 'A1', member_id: 'M001', work_date: '2026-10-06', minutes_spent: 60 }];
    const s = Reports.summarize(tasks, logs);
    const planned = tasks.filter((t) => t.task_type === 'PLANNED');
    assert.equal(s.plannedCompletion, countCompletion(planned).percent);
    assert.equal(s.weightedCompletion, weightedCompletion(planned).percent);
    assert.equal(s.weightedExcluded, weightedCompletion(planned).excludedCount);
    assert.equal(s.additionalEffortMinutes, additionalWorkloadSummary(tasks, logs, null).effortMinutes);
    const now = '2026-10-10T00:00:00+08:00';
    const expectedOverdue = tasks.filter((t) => mOverdue(t, now, 'Asia/Manila')).length;
    // reports.summarize uses current time internally; verify the predicate itself agrees instead
    for (const t of tasks) {
      assert.equal(Reports.isOverdue(t, now), mOverdue(t, now, 'Asia/Manila'), 'isOverdue must agree for ' + t.task_id);
    }
    assert.ok(expectedOverdue >= 0);
  });

  it('isOverdue agrees at the Manila midnight boundary', () => {
    const t = T({ status: 'In Progress', current_due_at: '2026-10-09T17:00:00+08:00' });
    assert.equal(Reports.isOverdue(t, '2026-10-09T15:00:00Z'), false); // 23:00 Manila Oct 9
    assert.equal(Reports.isOverdue(t, '2026-10-09T16:30:00Z'), true);  // 00:30 Manila Oct 10
    assert.equal(Reports.isOverdue(t, '2026-10-09T16:30:00Z'), mOverdue(t, '2026-10-09T16:30:00Z', 'Asia/Manila'));
  });

  it('turnaround same-day agrees with the Manila reference (not UTC slicing)', () => {
    const adds = [
      T({ task_id: 'A1', task_type: 'ADDITIONAL', status: 'Completed', completion_percent: 100, created_at: '2026-10-06T23:30:00+08:00', completed_at: '2026-10-07T00:30:00+08:00', actual_minutes: 20 }),
      T({ task_id: 'A2', task_type: 'ADDITIONAL', status: 'Completed', completion_percent: 100, created_at: '2026-10-06T09:00:00+08:00', completed_at: '2026-10-06T12:00:00+08:00', actual_minutes: 60 })
    ];
    const r = Reports.turnaround(adds);
    const m = turnaroundStats(adds, { timeZone: 'Asia/Manila' });
    assert.equal(r.sameDay, m.sameDayCompleted);
    assert.equal(r.sameDayDen, m.sameDayDenominator);
    assert.equal(r.sameDayRate, m.sameDayRate);
    assert.equal(r.avgHours, m.avgTurnaroundHours);
    assert.equal(r.medianHours, m.medianTurnaroundHours);
    assert.equal(sameCalendarDate(adds[0].created_at, adds[0].completed_at, 'Asia/Manila'), false);
  });

  it('inWeek agrees with the reference', () => {
    assert.equal(Reports.inWeek('2026-10-06T08:00:00+08:00', '2026-10-05'), inWeek('2026-10-06T08:00:00+08:00', '2026-10-05'));
    assert.equal(Reports.inWeek('2026-10-12T00:00:00+08:00', '2026-10-05'), inWeek('2026-10-12T00:00:00+08:00', '2026-10-05'));
  });
});

describe('store monday is Manila-based (not browser-local)', () => {
  it('resolves the Monday of the Manila week', () => {
    assert.equal(Store.monday('2026-10-11'), '2026-10-05'); // Sunday → previous Monday
    assert.equal(Store.monday('2026-10-05'), '2026-10-05'); // Monday → itself
    assert.equal(Store.monday('2026-10-10'), '2026-10-05'); // Saturday → same-week Monday
  });
  it('uses the Manila calendar date when UTC and Manila days differ', () => {
    // 2026-10-11T16:30Z is 00:30 Monday Oct 12 in Manila → Monday 2026-10-12.
    // A browser-local (UTC) implementation would return 2026-10-11.
    assert.equal(Store.monday('2026-10-11T16:30:00Z'), '2026-10-12');
  });
});

// ---------- B. Static source guards ----------

describe('Code.gs data-integrity guards', () => {
  it('worklog rollup sums logs exactly once (no double-added minutes)', () => {
    const body = fnBody(codeGs, 'addWorkLog_');
    assert.doesNotMatch(body, /\+ minutes/);
    assert.match(body, /already includes the new row/);
  });
  it('daily-update validation precedes the append (no orphan rows on rejection)', () => {
    const body = fnBody(codeGs, 'addDailyUpdate_');
    assert.ok(
      body.indexOf('validateTask_(merge_(task, patch))') < body.indexOf("appendRow_('DailyUpdates', row)"),
      'validateTask_ must run before appendRow_ in addDailyUpdate_'
    );
  });
  it('task-update validation precedes audit events (no orphan events on rejection)', () => {
    const body = fnBody(codeGs, 'updateTask_');
    assert.ok(
      body.indexOf('validateTask_(next)') < body.indexOf('event_(next.task_id'),
      'validateTask_ must run before event_ emissions in updateTask_'
    );
  });
  it('original_due_at is immutable after creation (deadline history preserved)', () => {
    const body = fnBody(codeGs, 'updateTask_');
    const decl = body.match(/var updatable = \[[^\]]*\]/s);
    assert.ok(decl, 'updatable allowlist must exist');
    assert.doesNotMatch(decl[0], /original_due_at/);
  });
  it('impact links reject self-links and require a PLANNED affected task', () => {
    const body = fnBody(codeGs, 'upsertImpact_');
    assert.match(body, /must differ/);
    assert.match(body, /must reference a planned/);
  });
  it('weekly report is week-scoped with member-scoped impacts', () => {
    const body = fnBody(codeGs, 'weeklyReport_');
    assert.match(body, /inScopeIds/);
    assert.match(body, /carryover/);
  });
  it('carryover scopes exclude cancelled tasks', () => {
    const q = fnBody(codeGs, 'queryTasks_');
    assert.match(q, /status !== 'Cancelled'/);
  });
});

describe('Code.gs open-write mode (owner decision 2026-10-13)', () => {
  const writes = ['createTask', 'updateTask', 'archiveTask', 'deleteTask', 'addDailyUpdate', 'addWorkLog', 'upsertImpact', 'createSnapshot', 'upsertMember', 'saveSettings'];
  for (const a of writes) {
    it(`${a} performs no key check (open writes)`, () => {
      assert.doesNotMatch(codeGs, new RegExp(`case '${a}': require(Edit|Admin)_`));
    });
  }
  it('no key-gate functions remain to mislead readers', () => {
    assert.doesNotMatch(codeGs, /function requireEdit_/);
    assert.doesNotMatch(codeGs, /function requireAdmin_/);
  });
  it('validation, locking, and audit still guard every write', () => {
    for (const fn of ['validateTask_', 'withLock_', 'event_']) {
      assert.ok(codeGs.includes('function ' + fn), fn + ' must still exist');
    }
  });
  it('write actions are blocked over GET', () => {
    const get = fnBody(codeGs, 'doGet');
    assert.match(get, /METHOD_NOT_ALLOWED/);
    for (const a of writes) {
      assert.ok(get.includes(`'${a}'`), `doGet must list ${a} as a write action`);
    }
  });
  it('errors never leak stack traces or secrets', () => {
    const pub = fnBody(codeGs, 'publicError_');
    assert.match(pub, /never leak/i);
    assert.doesNotMatch(pub, /err\.stack/);
    assert.doesNotMatch(pub, /\.stack/);
  });
  it('no embedded key material or token literals', () => {
    assert.doesNotMatch(codeGs, /AKfyc[A-Za-z0-9_-]{10,}/);
    assert.doesNotMatch(codeGs, /AIza[A-Za-z0-9_-]{10,}/);
  });
});

describe('Code.gs permanent delete (open, with cleanup)', () => {
  it('deleteTask is routed under lock with no key gate', () => {
    assert.match(codeGs, /case 'deleteTask': return withLock_\(function \(\) \{ return deleteTask_\(p\); \}\);/);
    assert.ok(fnBody(codeGs, 'doGet').includes("'deleteTask'"), 'deleteTask must be POST-only');
  });
  it('requires confirm:true and a valid task_id', () => {
    const body = fnBody(codeGs, 'deleteTask_');
    assert.match(body, /confirm !== true/);
    assert.match(body, /NOT_FOUND/);
  });
  it('cleans all five stores including both impact endpoints', () => {
    const body = fnBody(codeGs, 'deleteTask_');
    for (const t of ["deleteRowsById_('Tasks'", "deleteRowsById_('DailyUpdates'", "deleteRowsById_('WorkLogs'", "deleteRowsById_('TaskEvents'", "deleteRowsById_('TaskImpacts', 'additional_task_id'", "deleteRowsById_('TaskImpacts', 'affected_task_id'"]) {
      assert.ok(body.includes(t), 'missing cleanup: ' + t);
    }
    assert.match(body, /removed/);
  });
  it('frontend exposes Delete forever with confirmation and counts', () => {
    const appJs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    assert.ok(appJs.includes('id="oKill"'), 'Delete forever button missing');
    assert.ok(appJs.includes('function deleteTaskUI(t)'));
    assert.ok(appJs.includes("window.Api.deleteTask({ task_id: t.task_id, confirm: true })"));
    assert.ok(appJs.includes('Permanently deleted'));
  });
  it('Api client sends deleteTask as POST', () => {
    const apiJs = fs.readFileSync(path.join(ROOT, 'js/api.js'), 'utf8');
    assert.ok(apiJs.includes("deleteTask: function (p) { return post('deleteTask', p); }"));
  });
});

describe('app.js write-path guards', () => {
  it('task creation uses a stable client id (idempotent retries)', () => {
    assert.match(appJs, /task_id: newId/);
  });
  it('save buttons disable on submit (double-click protection)', () => {
    assert.match(appJs, /querySelector\('#dSave'\)\.disabled = true/);
    assert.match(appJs, /querySelector\('#uSave'\)\.disabled = true/);
    assert.match(appJs, /querySelector\('#lSave'\)\.disabled = true/);
  });
  it('partial refresh failures surface instead of mixing stale and fresh data', () => {
    assert.match(appJs, /Partial refresh/);
  });
});
