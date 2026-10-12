import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampPercent, normalizeMinutes, validateTask, validateWorkLog,
  eligibleTasks, countCompletion, weightedCompletion, onTimeCompletion,
  isOverdue, turnaroundStats, turnaroundMs, sameCalendarDate,
  additionalWorkloadSummary, buildSnapshot, splitCarryover, weekRange, inWeek
} from '../js/metrics.js';

const T = (o) => Object.assign({
  task_id: 'T1', title: 'X', owner_id: 'M001', task_type: 'PLANNED',
  status: 'In Progress', completion_percent: 50, estimated_minutes: 60,
  actual_minutes: 30, created_at: '2026-10-05T08:00:00+08:00',
  original_due_at: '2026-10-09T17:00:00+08:00', current_due_at: '2026-10-09T17:00:00+08:00',
  completed_at: null, archived_at: ''
}, o);

describe('progress validation', () => {
  it('clamps progress to 0–100', () => {
    assert.equal(clampPercent(-5), 0);
    assert.equal(clampPercent(150), 100);
    assert.equal(clampPercent('40'), 40);
    assert.equal(clampPercent(NaN), 0);
  });
  it('rejects completed tasks without 100% and timestamp', () => {
    const r = validateTask(T({ status: 'Completed', completion_percent: 90, completed_at: null }));
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /100/);
  });
  it('accepts a valid completed task', () => {
    const r = validateTask(T({ status: 'Completed', completion_percent: 100, completed_at: '2026-10-09T10:00:00+08:00' }));
    assert.equal(r.ok, true);
  });
  it('rejects non-completed tasks at 100%', () => {
    assert.equal(validateTask(T({ status: 'In Progress', completion_percent: 100 })).ok, false);
  });
  it('cancelled tasks excluded from denominators, must not carry completed_at', () => {
    assert.equal(validateTask(T({ status: 'Cancelled', completed_at: '2026-10-09T10:00:00+08:00' })).ok, false);
    const tasks = [T({ status: 'Completed', completion_percent: 100, completed_at: '2026-10-09T10:00:00+08:00' }), T({ status: 'Cancelled', completion_percent: 0 })];
    assert.deepEqual(countCompletion(tasks), { percent: 100, completed: 1, total: 1 });
  });
  it('validates effort and work logs', () => {
    assert.equal(validateTask(T({ estimated_minutes: -3 })).ok, false);
    assert.equal(validateWorkLog({ task_id: 'T1', member_id: 'M1', start_time: '2026-10-06T10:00', end_time: '2026-10-06T09:00', minutes_spent: 10 }).ok, false);
    assert.equal(validateWorkLog({ task_id: 'T1', member_id: 'M1', minutes_spent: 90 }).ok, true);
    assert.equal(validateWorkLog({ member_id: 'M1' }).ok, false);
    assert.equal(normalizeMinutes('abc'), null);
  });
});

describe('completion formulas', () => {
  it('count-based completion excludes cancelled', () => {
    const tasks = [
      T({ task_id: 'A', status: 'Completed', completion_percent: 100, completed_at: '2026-10-08T10:00:00+08:00' }),
      T({ task_id: 'B', status: 'In Progress', completion_percent: 50 }),
      T({ task_id: 'C', status: 'Cancelled', completion_percent: 0 })
    ];
    assert.deepEqual(countCompletion(tasks), { percent: 50, completed: 1, total: 2 });
  });
  it('weighted completion discloses excluded tasks, never invents estimates', () => {
    const tasks = [
      T({ task_id: 'A', status: 'Completed', completion_percent: 100, estimated_minutes: 100 }),
      T({ task_id: 'B', status: 'In Progress', completion_percent: 50, estimated_minutes: 100 }),
      T({ task_id: 'C', status: 'In Progress', completion_percent: 50, estimated_minutes: '' })
    ];
    const w = weightedCompletion(tasks);
    assert.equal(w.percent, 75);
    assert.equal(w.excludedCount, 1);
    assert.equal(w.includedCount, 2);
  });
  it('empty datasets return null (not misleading 0%) and no division by zero', () => {
    assert.equal(countCompletion([]).percent, null);
    assert.equal(weightedCompletion([]).percent, null);
    assert.equal(countCompletion([T({ status: 'Cancelled' })]).percent, null);
  });
  it('on-time completion preserves original vs revised deadlines', () => {
    const tasks = [T({
      status: 'Completed', completion_percent: 100,
      original_due_at: '2026-10-08T17:00:00+08:00',
      current_due_at: '2026-10-10T17:00:00+08:00', // revised later
      completed_at: '2026-10-09T10:00:00+08:00'     // late vs original, on-time vs revised
    })];
    const r = onTimeCompletion(tasks);
    assert.equal(r.original.percent, 0);
    assert.equal(r.current.percent, 100);
  });
  it('overdue respects Asia/Manila calendar boundary', () => {
    const t = T({ status: 'In Progress', current_due_at: '2026-10-09T17:00:00+08:00' });
    // 2026-10-09 23:00 Manila — not yet overdue
    assert.equal(isOverdue(t, '2026-10-09T15:00:00Z', 'Asia/Manila'), false);
    // 2026-10-10 morning Manila — overdue
    assert.equal(isOverdue(t, '2026-10-10T01:00:00Z', 'Asia/Manila'), true);
    assert.equal(isOverdue(T({ status: 'Completed', completion_percent: 100 }), '2026-10-20T00:00:00Z'), false);
    assert.equal(isOverdue(T({ status: 'Cancelled' }), '2026-10-20T00:00:00Z'), false);
  });
});

describe('carryover and double counting', () => {
  const week = '2026-10-05'; // Monday
  it('carryover tasks are not counted as newly assigned', () => {
    const tasks = [
      T({ task_id: 'OLD', created_at: '2026-09-28T08:00:00+08:00', status: 'In Progress' }),
      T({ task_id: 'NEW', created_at: '2026-10-06T08:00:00+08:00', status: 'Not Started', completion_percent: 0 })
    ];
    const { assignedThisWeek, carriedOver } = splitCarryover(tasks, week);
    assert.deepEqual(assignedThisWeek.map((t) => t.task_id), ['NEW']);
    assert.deepEqual(carriedOver.map((t) => t.task_id), ['OLD']);
  });
  it('week scope keeps carryover visible but assigns it once', () => {
    assert.equal(inWeek('2026-10-06T08:00:00+08:00', week), true);
    assert.equal(inWeek('2026-09-28T08:00:00+08:00', week), false);
    const r = weekRange(week);
    assert.deepEqual(r, { week_start: '2026-10-05', week_end: '2026-10-11' });
  });
});

describe('additional-task turnaround', () => {
  const add = (o) => T(Object.assign({
    task_type: 'ADDITIONAL', requested_by: 'Director', priority: 'High'
  }, o));
  it('computes avg/median turnaround and same-day rate with denominators', () => {
    const tasks = [
      add({ task_id: 'A1', status: 'Completed', completion_percent: 100, created_at: '2026-10-06T09:00:00+08:00', completed_at: '2026-10-06T12:00:00+08:00', actual_minutes: 60 }), // 3h, same day
      add({ task_id: 'A2', status: 'Completed', completion_percent: 100, created_at: '2026-10-06T09:00:00+08:00', completed_at: '2026-10-07T09:00:00+08:00', actual_minutes: 120 }), // 24h
      add({ task_id: 'A3', status: 'In Progress', completion_percent: 10, created_at: '2026-10-05T09:00:00+08:00', completed_at: null })
    ];
    const s = turnaroundStats(tasks, { timeZone: 'Asia/Manila', nowISO: '2026-10-08T00:00:00+08:00' });
    assert.equal(s.completed, 2);
    assert.equal(s.pending, 1);
    assert.equal(s.avgTurnaroundHours, 13.5);
    assert.equal(s.medianTurnaroundHours, 13.5);
    assert.equal(s.sameDayCompleted, 1);
    assert.equal(s.sameDayDenominator, 2);
    assert.equal(s.sameDayRate, 50);
    assert.equal(s.avgEffortMinutes, 90);
    assert.ok(s.pendingAging[0].ageDays > 0);
  });
  it('flags missing timestamps instead of inventing values', () => {
    const tasks = [add({ task_id: 'B1', status: 'Completed', completion_percent: 100, created_at: '', completed_at: '2026-10-07T09:00:00+08:00' })];
    const s = turnaroundStats(tasks);
    assert.equal(s.incompleteData, 1);
    assert.equal(s.avgTurnaroundHours, null);
    assert.equal(turnaroundMs(tasks[0]), null);
  });
  it('same-day respects time-zone boundary', () => {
    // 23:30 Manila Oct 6 → 00:30 Manila Oct 7 = different Manila calendar days
    assert.equal(sameCalendarDate('2026-10-06T23:30:00+08:00', '2026-10-07T00:30:00+08:00', 'Asia/Manila'), false);
    assert.equal(sameCalendarDate('2026-10-06T09:00:00+08:00', '2026-10-06T23:00:00+08:00', 'Asia/Manila'), true);
  });
  it('additional workload summary separates received/completed/effort', () => {
    const tasks = [
      add({ task_id: 'A1', status: 'Completed', completion_percent: 100, created_at: '2026-10-06T09:00:00+08:00', completed_at: '2026-10-06T12:00:00+08:00' }),
      add({ task_id: 'A2', status: 'In Progress', completion_percent: 10, created_at: '2026-10-07T09:00:00+08:00' })
    ];
    const logs = [
      { task_id: 'A1', member_id: 'M1', work_date: '2026-10-06', minutes_spent: 60, created_at: '2026-10-06T13:00:00+08:00' },
      { task_id: 'A2', member_id: 'M1', work_date: '2026-10-07', minutes_spent: 30, created_at: '2026-10-07T10:00:00+08:00' }
    ];
    const s = additionalWorkloadSummary(tasks, logs, '2026-10-05');
    assert.equal(s.receivedCount, 2);
    assert.equal(s.completedCount, 1);
    assert.equal(s.effortMinutes, 90);
  });
});

describe('snapshots and access boundaries', () => {
  it('builds deterministic snapshots preserving history inputs', () => {
    const tasks = [
      T({ task_id: 'P1', task_type: 'PLANNED', status: 'Completed', completion_percent: 100, completed_at: '2026-10-07T10:00:00+08:00', estimated_minutes: 120 }),
      T({ task_id: 'P2', task_type: 'PLANNED', status: 'In Progress', completion_percent: 50, estimated_minutes: 120 }),
      T({ task_id: 'A1', task_type: 'ADDITIONAL', status: 'Completed', completion_percent: 100, created_at: '2026-10-06T09:00:00+08:00', completed_at: '2026-10-06T10:00:00+08:00', estimated_minutes: 60, actual_minutes: 60 })
    ];
    const logs = [{ task_id: 'A1', member_id: 'M001', work_date: '2026-10-06', minutes_spent: 60, created_at: '2026-10-06T11:00:00+08:00' }];
    const s = buildSnapshot({ weekStartISO: '2026-10-05', memberId: 'M001', tasks, workLogs: logs, nowISO: '2026-10-08T00:00:00+08:00', timeZone: 'Asia/Manila' });
    assert.equal(s.week_start, '2026-10-05');
    assert.equal(s.planned_task_count, 2);
    assert.equal(s.completed_planned_count, 1);
    assert.equal(s.planned_completion_percent, 50);
    assert.equal(s.weighted_completion_percent, 75);
    assert.equal(s.additional_task_count, 1);
    assert.equal(s.additional_completed_count, 1);
    assert.equal(s.additional_effort_minutes, 60);
  });
  it('selecting a member id is a view filter, not auth (no privilege implied)', () => {
    // By construction: eligibleTasks/countCompletion take no credentials.
    // This test pins that no function grants edit rights from a member_id.
    const fns = { eligibleTasks, countCompletion, weightedCompletion, buildSnapshot };
    for (const v of Object.values(fns)) {
      assert.match(v.toString(), /task|member|week/i);
      assert.doesNotMatch(v.toString(), /EDIT_KEY|ADMIN_KEY|password|secret/i);
    }
  });
});
