/**
 * Weekly-process tests (actual reporting flow: plan → % check-in → additional
 * Q&A → submit/freeze). Pins weekly separation, average accomplishment,
 * additional-time totals, Yes/No impact documentation, and historical
 * stability of prior weeks. Compares js/reports.js (vm-loaded browser
 * global) with js/metrics.js (module reference) via JSON normalization
 * (vm objects carry a different prototype).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  averageAccomplishment as mAvg, additionalTimeMinutes as mTime,
  summarizeImpacts as mImp, splitCarryover, inWeek, buildSnapshot,
  validateCheckinRow as mValidateRow, validateImpactLink as mValidateLink,
  scopeWeek as mScope, dayKey as mDay, todayKey as mToday,
  buildTeamCsv as mCsv, applyPercentUpdates as mApply
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
const norm = (o) => JSON.parse(JSON.stringify(o));

const T = (o) => Object.assign({
  task_id: 'T1', title: 'X', owner_id: 'M001', task_type: 'PLANNED',
  status: 'In Progress', completion_percent: 50, estimated_minutes: '',
  actual_minutes: '', created_at: '2026-10-12T08:00:00+08:00',
  original_due_at: '2026-10-16T17:00:00+08:00', current_due_at: '2026-10-16T17:00:00+08:00',
  completed_at: null, archived_at: ''
}, o);

const WEEK_A = '2026-10-12'; // Monday
const WEEK_B = '2026-10-19'; // next Monday

describe('weekly separation', () => {
  it("a week-A task is not counted as newly assigned in week B", () => {
    const tasks = [T({ task_id: 'A1', created_at: '2026-10-13T08:00:00+08:00' })];
    const b = splitCarryover(tasks, WEEK_B);
    assert.deepEqual(b.assignedThisWeek, []);
    assert.deepEqual(b.carriedOver.map((t) => t.task_id), ['A1']);
  });
  it('open carryover stays visible but completed work does not carry over', () => {
    const tasks = [
      T({ task_id: 'OPEN', created_at: '2026-10-13T08:00:00+08:00', status: 'In Progress', completion_percent: 40 }),
      T({ task_id: 'DONE', created_at: '2026-10-13T08:00:00+08:00', status: 'Completed', completion_percent: 100, completed_at: '2026-10-15T10:00:00+08:00' })
    ];
    const b = splitCarryover(tasks, WEEK_B);
    assert.deepEqual(b.carriedOver.map((t) => t.task_id).sort(), ['DONE', 'OPEN']);
    // Week-B "new" scope contains neither; DONE is history, OPEN is carryover.
    assert.equal(inWeek(tasks[0].created_at, WEEK_B), false);
    assert.equal(inWeek('2026-10-20T08:00:00+08:00', WEEK_B), true);
  });
});

describe('average accomplishment percentage', () => {
  it('is the mean of reported % with cancelled excluded, clearly counted', () => {
    const tasks = [
      T({ task_id: 'P1', completion_percent: 100 }),
      T({ task_id: 'P2', completion_percent: 50 }),
      T({ task_id: 'P3', completion_percent: 0 }),
      T({ task_id: 'X1', status: 'Cancelled', completion_percent: 0 })
    ];
    const r = Reports.averageAccomplishment(tasks);
    assert.deepEqual(norm(r), { percent: 50, count: 3, reported: 3, unreported: 0 });
    assert.deepEqual(norm(r), mAvg(tasks));
  });
  it('stays separate from additional-task counts', () => {
    const tasks = [
      T({ task_id: 'P1', completion_percent: 100 }),
      T({ task_id: 'A1', task_type: 'ADDITIONAL', status: 'Completed', completion_percent: 100, actual_minutes: 600 })
    ];
    assert.deepEqual(norm(Reports.averageAccomplishment(tasks)), { percent: 100, count: 1, reported: 1, unreported: 0 });
  });
  it('is null (not 0%) with no planned tasks', () => {
    assert.equal(Reports.averageAccomplishment([]).percent, null);
    assert.equal(Reports.averageAccomplishment([T({ status: 'Cancelled' })]).percent, null);
  });
});

describe('additional-task time totals', () => {
  it('sums recorded additional durations only, ignoring planned effort', () => {
    const tasks = [
      T({ task_id: 'A1', task_type: 'ADDITIONAL', actual_minutes: 90 }),
      T({ task_id: 'A2', task_type: 'ADDITIONAL', actual_minutes: 30 }),
      T({ task_id: 'A3', task_type: 'ADDITIONAL', actual_minutes: '' }), // time not recorded
      T({ task_id: 'P1', actual_minutes: 9999 }) // planned effort must not leak in
    ];
    const r = Reports.additionalTimeMinutes(tasks);
    assert.deepEqual(norm(r), { totalMinutes: 120, taskCount: 3, withTime: 2, withoutTime: 1 });
    assert.deepEqual(norm(r), mTime(tasks));
  });
});

describe('Yes/No impact documentation', () => {
  it('records links with reasons only when the member answers Yes', () => {
    const yesImpacts = [{
      impact_id: 'I1', additional_task_id: 'A1', affected_task_id: 'P1',
      impact_type: 'Delayed', reason: 'Urgent request took Tuesday', evidence_notes: ''
    }];
    const r = Reports.summarizeImpacts(yesImpacts);
    assert.equal(r.count, 1);
    assert.deepEqual(norm(r.byType), { Delayed: 1 });
    assert.equal(r.reasons[0].reason, 'Urgent request took Tuesday');
    assert.deepEqual(norm(r), mImp(yesImpacts));
    // "No" means no link rows exist at all — nothing to infer from.
    assert.deepEqual(norm(Reports.summarizeImpacts([])), { count: 0, byType: {}, reasons: [] });
  });
  it('never derives delay from hours alone', () => {
    const tasks = [T({ task_id: 'A1', task_type: 'ADDITIONAL', actual_minutes: 480 })];
    assert.equal(Reports.additionalTimeMinutes(tasks).totalMinutes, 480);
    assert.equal(Reports.summarizeImpacts([]).count, 0); // hours present, impacts absent
  });
});

describe('historical report stability', () => {
  const weekATasks = [
    T({ task_id: 'P1', task_type: 'PLANNED', status: 'Completed', completion_percent: 100, completed_at: '2026-10-15T10:00:00+08:00', estimated_minutes: 120 }),
    T({ task_id: 'P2', task_type: 'PLANNED', status: 'In Progress', completion_percent: 40, estimated_minutes: 120 })
  ];
  const logs = [];
  it('rebuilding week A after week B starts gives identical results', () => {
    const before = buildSnapshot({ weekStartISO: WEEK_A, memberId: 'M001', tasks: weekATasks, workLogs: logs, nowISO: '2026-10-18T00:00:00+08:00', timeZone: 'Asia/Manila' });
    const later = weekATasks.concat([T({ task_id: 'NEWB', created_at: '2026-10-20T08:00:00+08:00', original_due_at: '2026-10-23T17:00:00+08:00', current_due_at: '2026-10-23T17:00:00+08:00', status: 'Not Started', completion_percent: 0 })]);
    // Week-A scope must exclude the week-B task:
    const aScope = later.filter((t) => inWeek(t.created_at, WEEK_A) || inWeek(t.current_due_at, WEEK_A) || inWeek(t.completed_at, WEEK_A));
    const after = buildSnapshot({ weekStartISO: WEEK_A, memberId: 'M001', tasks: aScope, workLogs: logs, nowISO: '2026-10-25T00:00:00+08:00', timeZone: 'Asia/Manila' });
    assert.deepEqual({ ...after, generated_at: before.generated_at }, before);
  });
  it('snapshots are keyed per week so weeks never overwrite each other', () => {
    const a = buildSnapshot({ weekStartISO: WEEK_A, memberId: 'M001', tasks: weekATasks, workLogs: logs, nowISO: '2026-10-18T00:00:00+08:00', timeZone: 'Asia/Manila' });
    const b = buildSnapshot({ weekStartISO: WEEK_B, memberId: 'M001', tasks: weekATasks, workLogs: logs, nowISO: '2026-10-25T00:00:00+08:00', timeZone: 'Asia/Manila' });
    assert.equal(a.week_start, '2026-10-12');
    assert.equal(b.week_start, '2026-10-19');
    assert.notEqual(a.week_start, b.week_start);
  });
});

describe('unreported vs reported-zero percentages', () => {
  it('excludes unreported tasks from the average and discloses them', () => {
    const tasks = [
      T({ task_id: 'P1', completion_percent: 80 }),
      T({ task_id: 'P2', completion_percent: '' }), // not yet reported
      T({ task_id: 'P3', completion_percent: 0 }) // explicitly reported zero
    ];
    const r = Reports.averageAccomplishment(tasks);
    assert.deepEqual(norm(r), { percent: 40, count: 3, reported: 2, unreported: 1 });
    assert.deepEqual(norm(r), mAvg(tasks));
  });
  it('accepts any value 0–100 and rejects anything outside', () => {
    for (const pct of [0, 25, 37.5, 62, 75, 99.9]) {
      assert.equal(Reports.validateCheckinRow({ pct }).ok, true, pct + ' must be valid');
      assert.equal(mValidateRow({ pct }).ok, true);
    }
    // 100% is valid only with an outcome (or when already completed) —
    // the completion rule, not a range rule.
    assert.equal(Reports.validateCheckinRow({ pct: 100, outcomeNote: 'Delivered.' }).ok, true);
    assert.equal(Reports.validateCheckinRow({ pct: 100, alreadyCompleted: true }).ok, true);
    assert.equal(Reports.validateCheckinRow({ pct: 100 }).ok, false);
    for (const pct of [-1, 101, NaN, Infinity]) {
      assert.equal(Reports.validateCheckinRow({ pct }).ok, false, String(pct) + ' must be rejected');
    }
    assert.deepEqual(norm(Reports.validateCheckinRow({ pct: null })), norm(mValidateRow({ pct: null })));
    assert.equal(Reports.validateCheckinRow({ pct: null }).unreported, true);
  });
});

describe('incomplete-reason workflow', () => {
  it('100% needs an outcome unless already completed; nothing else needs a reason', () => {
    assert.equal(Reports.validateCheckinRow({ pct: 100, alreadyCompleted: false, outcomeNote: '' }).ok, false);
    assert.equal(Reports.validateCheckinRow({ pct: 100, alreadyCompleted: false, outcomeNote: 'Delivered X' }).ok, true);
    assert.equal(Reports.validateCheckinRow({ pct: 100, alreadyCompleted: true, outcomeNote: '' }).ok, true);
    assert.equal(Reports.validateCheckinRow({ pct: 75, reason: 'none' }).ok, true);
  });
  it('a chosen cause requires an explanation; additional also requires the link', () => {
    assert.equal(Reports.validateCheckinRow({ pct: 50, reason: 'waiting', explanation: '' }).ok, false);
    assert.equal(Reports.validateCheckinRow({ pct: 50, reason: 'waiting', explanation: 'Waiting on registrar.' }).ok, true);
    assert.equal(Reports.validateCheckinRow({ pct: 50, reason: 'additional', linkedId: '', explanation: 'Busy.' }).ok, false);
    assert.equal(Reports.validateCheckinRow({ pct: 50, reason: 'additional', linkedId: 'A1', explanation: '' }).ok, false);
    assert.equal(Reports.validateCheckinRow({ pct: 50, reason: 'additional', linkedId: 'A1', explanation: 'Urgent request took Tuesday.' }).ok, true);
    assert.deepEqual(
      norm(Reports.validateCheckinRow({ pct: 50, reason: 'technical', explanation: 'No power.' })),
      norm(mValidateRow({ pct: 50, reason: 'technical', explanation: 'No power.' })));
  });
});

describe('impact-link integrity (no invented or cross-week links)', () => {
  const planned = T({ task_id: 'P1', created_at: '2026-10-13T08:00:00+08:00' });
  const add = T({ task_id: 'A1', task_type: 'ADDITIONAL', created_at: '2026-10-14T08:00:00+08:00' });
  it('accepts a same-week additional→planned link', () => {
    assert.equal(Reports.validateImpactLink(add, planned, WEEK_A).ok, true);
    assert.deepEqual(norm(Reports.validateImpactLink(add, planned, WEEK_A)), norm(mValidateLink(add, planned, WEEK_A)));
  });
  it('rejects self-links, wrong types, and cross-week relationships', () => {
    assert.equal(Reports.validateImpactLink(add, add, WEEK_A).ok, false);
    assert.equal(Reports.validateImpactLink(planned, planned, WEEK_A).ok, false);
    assert.equal(Reports.validateImpactLink(planned, add, WEEK_A).ok, false);
    const otherWeek = T({ task_id: 'AX', task_type: 'ADDITIONAL', created_at: '2026-10-20T08:00:00+08:00', current_due_at: '2026-10-21T08:00:00+08:00' });
    const r = Reports.validateImpactLink(otherWeek, planned, WEEK_A);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /outside this reporting week/);
  });
  it('the shared week scope agrees across implementations', () => {
    const tasks = [
      planned, add,
      T({ task_id: 'OLD', created_at: '2026-10-01T08:00:00+08:00', current_due_at: '2026-10-02T08:00:00+08:00', status: 'Completed', completion_percent: 100, completed_at: '2026-10-02T08:00:00+08:00' }),
      T({ task_id: 'CARRY', created_at: '2026-10-01T08:00:00+08:00', current_due_at: '2026-10-02T08:00:00+08:00', status: 'In Progress', completion_percent: 30 })
    ];
    assert.deepEqual(Reports.scopeWeek(tasks, WEEK_A).map((t) => t.task_id).sort(), ['A1', 'CARRY', 'P1']);
    assert.deepEqual(mScope(tasks, WEEK_A).map((t) => t.task_id).sort(), ['A1', 'CARRY', 'P1']);
  });
});

describe('Manila day keys (never raw-slice timestamps)', () => {
  it('converts instants in Asia/Manila, passes date-only through', () => {
    // 2026-10-11T16:30Z is 00:30 Oct 12 in Manila — raw slicing says Oct 11.
    assert.equal(Reports.dayKey('2026-10-11T16:30:00Z'), '2026-10-12');
    assert.equal(mDay('2026-10-11T16:30:00Z'), '2026-10-12');
    assert.equal(Reports.dayKey('2026-10-12'), '2026-10-12');
    assert.equal(Reports.dayKey(''), '');
    assert.equal(Reports.dayKey(null), '');
    assert.equal(Reports.todayKey(), mToday());
    assert.match(Reports.todayKey(), /^\d{4}-\d{2}-\d{2}$/);
  });
  it('on-time judgment uses Manila dates on both sides', () => {
    const done = (completed, due) => ({
      task_id: 'X', title: 'X', owner_id: 'M1', task_type: 'PLANNED', status: 'Completed',
      completion_percent: 100, completed_at: completed, original_due_at: due, current_due_at: due,
      created_at: '2026-10-12T08:00:00+08:00', archived_at: ''
    });
    // Completed 00:30 Manila Oct 13 against an Oct-13 Manila deadline: on time.
    const tasks = [done('2026-10-12T16:30:00Z', '2026-10-13')];
    assert.equal(Reports.onTimeCompletion(tasks).original.percent, 100);
  });
});

describe('team CSV builder (demo and live downloads match)', () => {
  const tasks = [
    { task_id: 'T1', title: 'Plan, "quoted"', owner_id: 'M1', task_type: 'PLANNED', status: 'In Progress', completion_percent: 50, priority: 'Critical', original_due_at: '2026-10-16', current_due_at: '', completed_at: '', estimated_minutes: '', actual_minutes: '', blocked_reason: '' }
  ];
  it('emits the server column set with CSV quoting', () => {
    const csv = Reports.buildTeamCsv(tasks);
    const lines = csv.split('\n');
    assert.equal(lines[0].split(',')[0], 'task_id');
    assert.ok(lines[0].includes('blocked_reason'));
    assert.match(lines[1], /"Plan, ""quoted"""/);
    assert.deepEqual(norm(Reports.buildTeamCsv(tasks)), norm(mCsv(tasks)));
  });
});

describe('optimistic apply helper (instant UI, server confirms)', () => {
  const base = [
    { task_id: 'P1', completion_percent: 40, status: 'In Progress', completed_at: '', last_updated_at: 'old' },
    { task_id: 'P2', completion_percent: 0, status: 'Not Started', completed_at: '', last_updated_at: 'old' }
  ];
  it('applies %/status immutably and stamps completion', () => {
    const out = Reports.applyPercentUpdates(base, [
      { task_id: 'P1', completion_percent: 100, status: 'Completed' },
      { task_id: 'P2', completion_percent: 20, status: 'In Progress' }
    ], 'NOW');
    assert.equal(out[0].completion_percent, 100);
    assert.equal(out[0].status, 'Completed');
    assert.equal(out[0].completed_at, 'NOW');
    assert.equal(out[1].completion_percent, 20);
    assert.equal(base[0].completion_percent, 40, 'input array must not be mutated');
    assert.deepEqual(norm(out), norm(mApply(base, [
      { task_id: 'P1', completion_percent: 100, status: 'Completed' },
      { task_id: 'P2', completion_percent: 20, status: 'In Progress' }
    ], 'NOW')));
  });
  it('clears completed_at when reopening below 100', () => {
    const out = Reports.applyPercentUpdates(
      [{ task_id: 'P1', completion_percent: 100, status: 'Completed', completed_at: 'OLD', last_updated_at: 'old' }],
      [{ task_id: 'P1', completion_percent: 60, status: 'In Progress' }], 'NOW');
    assert.equal(out[0].completed_at, '');
  });
});
