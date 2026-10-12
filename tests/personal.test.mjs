/**
 * Personal-dashboard tests (added for the My Dashboard simplification).
 * Pins member-scoped filtering and the on-time analytics used by the
 * personal view, plus agreement between js/reports.js (browser global,
 * loaded via vm) and js/metrics.js (module reference).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  onTimeCompletion as mOnTime, turnaroundStats, countCompletion
} from '../js/metrics.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadReports() {
  const src = fs.readFileSync(path.join(ROOT, 'js/reports.js'), 'utf8');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'js/reports.js' });
  return sandbox.window.Reports;
}
const Reports = loadReports();

const T = (o) => Object.assign({
  task_id: 'T1', title: 'X', owner_id: 'M001', task_type: 'PLANNED',
  status: 'In Progress', completion_percent: 50, estimated_minutes: 60,
  actual_minutes: 30, created_at: '2026-10-05T08:00:00+08:00',
  original_due_at: '2026-10-09T17:00:00+08:00', current_due_at: '2026-10-09T17:00:00+08:00',
  completed_at: null, archived_at: ''
}, o);

// The personal dashboard scopes exactly like this before summarizing.
const scopeToMember = (tasks, memberId) => tasks.filter((t) => !t.archived_at && t.owner_id === memberId);

describe('member-scoped personal analytics', () => {
  const tasks = [
    T({ task_id: 'P1', owner_id: 'M001', status: 'Completed', completion_percent: 100, completed_at: '2026-10-07T10:00:00+08:00', estimated_minutes: 120, actual_minutes: 100 }),
    T({ task_id: 'P2', owner_id: 'M001', status: 'In Progress', completion_percent: 40, estimated_minutes: 120, actual_minutes: 50 }),
    T({ task_id: 'A1', owner_id: 'M001', task_type: 'ADDITIONAL', status: 'Completed', completion_percent: 100, created_at: '2026-10-06T09:00:00+08:00', completed_at: '2026-10-06T11:00:00+08:00', actual_minutes: 90 }),
    T({ task_id: 'P9', owner_id: 'M002', status: 'Completed', completion_percent: 100, completed_at: '2026-10-07T10:00:00+08:00', estimated_minutes: 600, actual_minutes: 600 }),
    T({ task_id: 'P8', owner_id: 'M002', status: 'Blocked', completion_percent: 10, blocked_reason: 'Waiting on registrar.' })
  ];
  const logs = [
    { task_id: 'A1', member_id: 'M001', work_date: '2026-10-06', minutes_spent: 90 },
    { task_id: 'P1', member_id: 'M001', work_date: '2026-10-07', minutes_spent: 100 }
  ];

  it("a member's summary never includes another member's tasks", () => {
    const mine = scopeToMember(tasks, 'M001');
    const s = Reports.summarize(mine, logs.filter((l) => l.member_id === 'M001'));
    assert.equal(s.plannedCount, 2);
    assert.equal(s.plannedCompleted, 1);
    assert.equal(s.plannedCompletion, 50);
    assert.equal(s.additionalCount, 1);
    assert.equal(s.additionalEffortMinutes, 90); // M002's 600m effort excluded
    assert.equal(s.blockedCount, 0); // M002's blocked task excluded
  });

  it('team aggregate equals the sum of member scopes (no double counting)', () => {
    const all = tasks.filter((t) => !t.archived_at);
    const sAll = Reports.summarize(all, logs);
    const s1 = Reports.summarize(scopeToMember(tasks, 'M001'), logs.filter((l) => l.member_id === 'M001'));
    const s2 = Reports.summarize(scopeToMember(tasks, 'M002'), []);
    assert.equal(sAll.plannedCount, s1.plannedCount + s2.plannedCount);
    assert.equal(sAll.plannedCompleted, s1.plannedCompleted + s2.plannedCompleted);
    assert.equal(sAll.additionalEffortMinutes, s1.additionalEffortMinutes + s2.additionalEffortMinutes);
  });

  it('on-time completion matches the reference across revisions and gaps', () => {
    const mine = [
      T({ task_id: 'O1', status: 'Completed', completion_percent: 100, original_due_at: '2026-10-08T17:00:00+08:00', current_due_at: '2026-10-10T17:00:00+08:00', completed_at: '2026-10-09T10:00:00+08:00' }),
      T({ task_id: 'O2', status: 'Completed', completion_percent: 100, original_due_at: '2026-10-08T17:00:00+08:00', current_due_at: '2026-10-08T17:00:00+08:00', completed_at: '2026-10-07T10:00:00+08:00' }),
      T({ task_id: 'O3', status: 'Completed', completion_percent: 100, original_due_at: '', current_due_at: '', completed_at: '2026-10-07T10:00:00+08:00' }),
      T({ task_id: 'O4', status: 'Cancelled', completion_percent: 0 })
    ];
    const r = Reports.onTimeCompletion(mine);
    const m = mOnTime(mine);
    // Reports runs inside a vm context (different Object.prototype), so
    // compare structurally via JSON rather than deepStrictEqual.
    assert.deepEqual(JSON.parse(JSON.stringify(r)), m);
    assert.equal(r.original.percent, 50); // 1 of 2 with original deadlines
    assert.equal(r.current.percent, 100); // 2 of 2 by approved deadlines
    assert.equal(r.original.total, 2); // task without deadline excluded, counted nowhere
  });

  it('on-time is null (not 0%) when nothing is completed or dated', () => {
    const r = Reports.onTimeCompletion([T({ status: 'In Progress', completion_percent: 20 })]);
    assert.equal(r.original.percent, null);
    assert.equal(r.current.percent, null);
  });

  it('per-member turnaround matches the reference and shows denominators', () => {
    const adds = scopeToMember(tasks, 'M001').filter((t) => t.task_type === 'ADDITIONAL');
    const r = Reports.turnaround(adds);
    const m = turnaroundStats(adds, { timeZone: 'Asia/Manila' });
    assert.equal(r.sameDay, m.sameDayCompleted);
    assert.equal(r.sameDayDen, m.sameDayDenominator);
    assert.equal(r.medianHours, m.medianTurnaroundHours);
    assert.equal(Reports.turnaround([]).medianHours, null);
  });

  it('report text flags unexplained pending work instead of inventing reasons', () => {
    const ctx = {
      memberName: 'M001', weekStart: '2026-10-05', weekEnd: '2026-10-11',
      planned: [T({ task_id: 'P2' })], additional: [],
      completedThisWeek: [], pending: [T({ task_id: 'P2' })],
      overdue: [], blocked: [],
      needsClarification: [T({ task_id: 'P2', title: 'Unexplained task' })],
      effortMinutes: 50, impacts: []
    };
    const text = Reports.buildReportText(ctx);
    assert.match(text, /requiring clarification/);
    assert.match(text, /Unexplained task/);
    assert.doesNotMatch(text, /because|due to.*delay/i);
  });

  it('completion rate is presented with its denominator, never alone', () => {
    const mine = scopeToMember(tasks, 'M001').filter((t) => t.task_type === 'PLANNED');
    const c = countCompletion(mine);
    assert.equal(c.completed, 1);
    assert.equal(c.total, 2);
    assert.equal(c.percent, 50);
  });
});
