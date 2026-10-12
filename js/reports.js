/**
 * Reporting calculations (client-side mirror of the Apps Script backend).
 * Pure functions over { tasks, updates, workLogs, impacts } — no DOM, no fetch.
 * The server remains authoritative; these power instant dashboard rendering.
 * Mirror note: js/metrics.js holds the same formulas as importable ES modules
 * (used by tests); this file is the browser-global copy loaded by index.html.
 * Time-zone handling matches the backend: Asia/Manila calendar dates.
 */
(function () {
  var TIMEZONE = 'Asia/Manila';
  function manilaDay(iso) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
    } catch (e) {
      return String(iso).slice(0, 10);
    }
  }
  function elig(tasks, type) {
    return (tasks || []).filter(function (t) {
      if (!t || t.status === 'Cancelled' || t.archived_at) return false;
      if (type && t.task_type !== type) return false;
      return true;
    });
  }
  function r1(n) {
    if (n === null || n === undefined || !isFinite(Number(n))) return null;
    return Math.round(Number(n) * 10) / 10;
  }
  function inWeek(iso, weekStart) {
    if (!iso) return false;
    var d = String(iso).slice(0, 10);
    var s = new Date(weekStart + 'T00:00:00Z');
    var e = new Date(s); e.setUTCDate(e.getUTCDate() + 6);
    var a = s.toISOString().slice(0, 10), b = e.toISOString().slice(0, 10);
    return d >= a && d <= b;
  }
  function isOverdue(t, nowISO) {
    if (!t || t.status === 'Completed' || t.status === 'Cancelled') return false;
    var due = t.current_due_at || t.original_due_at;
    if (!due) return false;
    var now = nowISO || new Date().toISOString();
    return manilaDay(now) > String(due).slice(0, 10);
  }
  function summarize(tasks, workLogs) {
    var planned = elig(tasks, 'PLANNED');
    var adds = (tasks || []).filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled' && !t.archived_at; });
    var done = planned.filter(function (t) { return t.status === 'Completed'; }).length;
    var num = 0, den = 0, excl = 0;
    planned.forEach(function (t) {
      var est = Number(t.estimated_minutes);
      if (!isFinite(est) || est <= 0) { excl++; return; }
      var pct = Math.min(100, Math.max(0, Number(t.completion_percent) || 0));
      num += est * pct / 100; den += est;
    });
    var ids = {};
    adds.forEach(function (t) { ids[String(t.task_id)] = true; });
    var eff = 0;
    (workLogs || []).forEach(function (l) { if (ids[String(l.task_id)]) eff += Number(l.minutes_spent) || 0; });
    var now = new Date().toISOString();
    return {
      plannedCount: planned.length, plannedCompleted: done,
      plannedCompletion: planned.length ? r1(done / planned.length * 100) : null,
      weightedCompletion: den ? r1(num / den * 100) : null, weightedExcluded: excl,
      additionalCount: adds.length,
      additionalCompleted: adds.filter(function (t) { return t.status === 'Completed'; }).length,
      additionalEffortMinutes: eff,
      overdueCount: elig(tasks).filter(function (t) { return isOverdue(t, now); }).length,
      blockedCount: elig(tasks).filter(function (t) { return t.status === 'Blocked'; }).length
    };
  }
  function turnaround(adds) {
    var list = (adds || []).filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled' && !t.archived_at; });
    var done = list.filter(function (t) { return t.status === 'Completed' && t.completed_at && t.created_at; });
    var ms = done.map(function (t) { return new Date(t.completed_at) - new Date(t.created_at); })
      .filter(function (n) { return isFinite(n) && n >= 0; }).sort(function (a, b) { return a - b; });
    var mean = ms.length ? ms.reduce(function (a, b) { return a + b; }, 0) / ms.length : null;
    var med = ms.length ? (ms.length % 2 ? ms[Math.floor(ms.length / 2)] : (ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2) : null;
    var same = done.filter(function (t) { return manilaDay(t.created_at) === manilaDay(t.completed_at); }).length;
    return {
      total: list.length, completed: done.length, pending: list.length - done.length,
      avgHours: mean !== null ? r1(mean / 3600000) : null,
      medianHours: med !== null ? r1(med / 3600000) : null,
      sameDay: same, sameDayDen: done.length,
      sameDayRate: done.length ? r1(same / done.length * 100) : null
    };
  }
  function fmtPct(v) { return v === null || v === undefined ? '—' : v + '%'; }
  function fmtH(min) {
    if (min === null || min === undefined) return '—';
    var h = Math.floor(min / 60), m = Math.round(min % 60);
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }
  function buildReportText(o) {
    var L = [];
    L.push('WEEKLY ACCOMPLISHMENT REPORT — ' + o.memberName);
    L.push('Reporting period: ' + o.weekStart + ' to ' + o.weekEnd + ' (Asia/Manila, Mon–Sun; working days Mon–Fri).');
    L.push('');
    L.push('Planned tasks: ' + o.planned.length + '; completed: ' + o.planned.filter(function (t) { return t.status === 'Completed'; }).length + '.');
    L.push('Completed this week (' + o.completedThisWeek.length + '):');
    o.completedThisWeek.forEach(function (t) { L.push('  • ' + t.title + ' [' + t.task_type + ']'); });
    L.push('Additional work: ' + o.additional.length + ' received; ' +
      o.additional.filter(function (t) { return t.status === 'Completed'; }).length + ' completed.');
    L.push('Recorded effort: ' + o.effortMinutes + ' minutes (' + r1(o.effortMinutes / 60) + ' hours).');
    L.push('Pending: ' + o.pending.length + '; overdue: ' + o.overdue.length + '; blocked: ' + o.blocked.length + '.');
    o.blocked.forEach(function (t) { L.push('  • BLOCKED: ' + t.title + ' — ' + (t.blocked_reason || 'reason not recorded')); });
    if (o.needsClarification.length) {
      L.push('Tasks requiring clarification (' + o.needsClarification.length + '):');
      o.needsClarification.forEach(function (t) { L.push('  • ' + t.title + ' — no documented reason for incomplete status'); });
    }
    if (o.impacts.length) {
      L.push('Documented workload impacts (' + o.impacts.length + '):');
      o.impacts.forEach(function (i) { L.push('  • ' + i.additional_task_id + ' → ' + i.affected_task_id + ' (' + i.impact_type + '): ' + (i.reason || '')); });
    } else { L.push('No workload-impact links recorded this week.'); }
    L.push('');
    L.push('Next steps: carry forward ' + o.pending.length + ' pending task(s); see remaining_work in daily updates.');
    return L.join('\n');
  }

  window.Reports = { summarize: summarize, turnaround: turnaround, inWeek: inWeek, isOverdue: isOverdue, fmtPct: fmtPct, fmtH: fmtH, buildReportText: buildReportText };
})();
