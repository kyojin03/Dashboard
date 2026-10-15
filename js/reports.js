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
    var d = dayKey(iso);
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
    return manilaDay(now) > dayKey(due);
  }
  function summarize(tasks, workLogs) {
    var planned = elig(tasks, 'PLANNED');
    var adds = (tasks || []).filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled' && !t.archived_at; });
    var done = planned.filter(function (t) { return t.status === 'Completed'; }).length;
    var num = 0, den = 0, excl = 0;
    planned.forEach(function (t) {
      var est = Number(t.estimated_minutes);
      if (!isFinite(est) || est <= 0) { excl++; return; }
      if (t.completion_percent === '' || t.completion_percent === null || t.completion_percent === undefined) { excl++; return; } // unreported: excluded, disclosed
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
  // Average accomplishment % across eligible PLANNED tasks (arithmetic mean
  // of REPORTED completion_percent). Unreported ('') tasks are EXCLUDED from
  // the mean and disclosed via `unreported` — never silently counted as 0%.
  // Returns { percent|null, count, reported, unreported }.
  function averageAccomplishment(tasks) {
    var planned = elig(tasks, 'PLANNED');
    var sum = 0, reported = 0, unreported = 0;
    planned.forEach(function (t) {
      if (t.completion_percent === '' || t.completion_percent === null || t.completion_percent === undefined) { unreported++; return; }
      sum += Math.min(100, Math.max(0, Number(t.completion_percent) || 0));
      reported++;
    });
    return { percent: reported ? r1(sum / reported) : null, count: planned.length, reported: reported, unreported: unreported };
  }
  // Total time on ADDITIONAL tasks from recorded task durations only
  // (actual_minutes). Planned-task effort never included. Tasks without a
  // recorded duration are counted in withoutTime, never invented.
  function additionalTimeMinutes(tasks) {
    var adds = (tasks || []).filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled' && !t.archived_at; });
    var total = 0, withTime = 0, withoutTime = 0;
    adds.forEach(function (t) {
      var has = t.actual_minutes !== '' && t.actual_minutes !== null && t.actual_minutes !== undefined;
      var m = Number(t.actual_minutes);
      if (has && isFinite(m) && m >= 0) { total += m; withTime++; }
      else withoutTime++;
    });
    return { totalMinutes: total, taskCount: adds.length, withTime: withTime, withoutTime: withoutTime };
  }
  // Week scope shared by every view: created, due, or completed in the week,
  // plus open carryover from earlier weeks. Single implementation so the
  // check-in, pickers, team view, and reports can never disagree.
  /** Manila calendar date for ANY input (date-only passes through). */
  function dayKey(v) {
    if (v === null || v === undefined || v === '') return '';
    var s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return manilaDay(v);
  }
  function todayKey() { return manilaDay(new Date().toISOString()); }
  function scopeWeek(tasks, weekStart) {
    var s = new Date(weekStart + 'T00:00:00Z');
    var e = new Date(s); e.setUTCDate(e.getUTCDate() + 6);
    var start = s.toISOString().slice(0, 10), end = e.toISOString().slice(0, 10);
    return (tasks || []).filter(function (t) {
      if (!t || t.archived_at) return false;
      return inWeek(t.created_at, weekStart) || inWeek(t.current_due_at || t.original_due_at, weekStart) ||
        inWeek(t.completed_at, weekStart) ||
        (dayKey(t.created_at) && dayKey(t.created_at) < weekStart && t.status !== 'Completed' && t.status !== 'Cancelled');
    });
  }

  // Incomplete reasons offered in the Friday check-in. 'none' = no reason
  // given yet (allowed); any other choice requires an explanation, and
  // 'additional' additionally requires the linked additional task.
  var CHECKIN_REASONS = ['none', 'additional', 'waiting', 'time', 'technical', 'other'];
  var CHECKIN_REASON_LABELS = {
    none: 'No reason given yet', additional: 'Additional task or urgent assignment',
    waiting: 'Waiting for information, approval, or another person',
    time: 'Insufficient time or competing priorities',
    technical: 'Technical or operational issue', other: 'Other reason'
  };

  // Pure validation for one check-in row. pct is null when unreported.
  // Returns { ok, errors[], unreported }.
  function validateCheckinRow(r) {
    var errors = [];
    if (r.pct === null || r.pct === undefined) return { ok: true, errors: errors, unreported: true };
    if (!isFinite(r.pct) || r.pct < 0 || r.pct > 100) return { ok: false, errors: ['Enter a percentage from 0 to 100.'], unreported: false };
    if (r.pct === 100) {
      if (!r.alreadyCompleted && !(r.outcomeNote && String(r.outcomeNote).trim())) {
        errors.push('Add what was delivered to mark 100% complete.');
      }
      return { ok: errors.length === 0, errors: errors, unreported: false };
    }
    var reason = r.reason || 'none';
    if (reason !== 'none') {
      if (!(r.explanation && String(r.explanation).trim())) errors.push('Explain the delay briefly.');
      if (reason === 'additional' && !r.linkedId) errors.push('Link the additional task that affected this plan.');
    }
    return { ok: errors.length === 0, errors: errors, unreported: false };
  }

  // Pure validation for an additional→planned impact link. Rejects self-links,
  // wrong task types, and cross-week relationships (both ends must be in the
  // reporting week's scope). Returns { ok, errors[] }.
  function validateImpactLink(additionalTask, plannedTask, weekStart) {
    var errors = [];
    if (!additionalTask || !plannedTask) return { ok: false, errors: ['Both tasks are required.'] };
    if (String(additionalTask.task_id) === String(plannedTask.task_id)) return { ok: false, errors: ['A task cannot affect itself.'] };
    if (additionalTask.task_type !== 'ADDITIONAL') errors.push('The affecting task must be an additional task.');
    if (plannedTask.task_type !== 'PLANNED') errors.push('The affected task must be a planned task.');
    var inScope = function (t) {
      return inWeek(t.created_at, weekStart) || inWeek(t.current_due_at || t.original_due_at, weekStart) ||
        inWeek(t.completed_at, weekStart) ||
        (dayKey(t.created_at || '') && dayKey(t.created_at || '') < weekStart && t.status !== 'Completed' && t.status !== 'Cancelled');
    };
    if (!inScope(additionalTask)) errors.push('The additional task is outside this reporting week.');
    if (!inScope(plannedTask)) errors.push('The planned task is outside this reporting week.');
    return { ok: errors.length === 0, errors: errors };
  }
  // Documented impact links only — never inferred. Counts byType plus the
  // recorded reasons for display in reports.
  function summarizeImpacts(impacts) {
    var list = impacts || [];
    var byType = {};
    var reasons = [];
    list.forEach(function (i) {
      byType[i.impact_type || 'Unspecified'] = (byType[i.impact_type || 'Unspecified'] || 0) + 1;
      if (i.reason || i.evidence_notes) {
        reasons.push({ additional_task_id: i.additional_task_id, affected_task_id: i.affected_task_id, impact_type: i.impact_type, reason: i.reason || '', evidence_notes: i.evidence_notes || '' });
      }
    });
    return { count: list.length, byType: byType, reasons: reasons };
  }
  function fmtH(min) {
    if (min === null || min === undefined) return '—';
    var h = Math.floor(min / 60), m = Math.round(min % 60);
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }
  // On-time completion, mirroring js/metrics.js onTimeCompletion and the
  // backend: % completed by ORIGINAL deadline and by CURRENT (approved)
  // deadline. Cancelled/archived excluded; tasks without a deadline are
  // excluded from that denominator (counted, not hidden).
  function onTimeCompletion(tasks) {
    var done = elig(tasks).filter(function (t) { return t.status === 'Completed' && t.completed_at; });
    function pct(a, b) { return b ? r1(a / b * 100) : null; }
    var withOrig = done.filter(function (t) { return t.original_due_at; });
    var onOrig = withOrig.filter(function (t) { return dayKey(t.completed_at) <= dayKey(t.original_due_at); });
    var withCur = done.filter(function (t) { return t.current_due_at || t.original_due_at; });
    var onCur = withCur.filter(function (t) {
      var d = t.current_due_at || t.original_due_at;
      return dayKey(t.completed_at) <= dayKey(d);
    });
    return {
      original: { percent: pct(onOrig.length, withOrig.length), onTime: onOrig.length, total: withOrig.length },
      current: { percent: pct(onCur.length, withCur.length), onTime: onCur.length, total: withCur.length }
    };
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

  // Client-side CSV for any in-scope task list (same columns as the server
  // export, so demo and live downloads match). Pure and unit-tested.
  function buildTeamCsv(tasks) {
    var head = ['task_id', 'title', 'owner_id', 'task_type', 'status', 'completion_percent', 'priority', 'original_due_at', 'current_due_at', 'completed_at', 'estimated_minutes', 'actual_minutes', 'blocked_reason'];
    var esc2 = function (v) {
      var s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [head.join(',')].concat((tasks || []).map(function (t) {
      return head.map(function (h) { return esc2(t[h]); }).join(',');
    })).join('\n');
  }

  // Pure optimistic-apply used by instant saves AND the demo path alike:
  // returns a NEW task array with the given %/status updates applied.
  // Callers refresh from the server afterwards (success confirms, failure
  // rolls back to server truth).
  function applyPercentUpdates(tasks, updates, nowISO) {
    var byId = {};
    (updates || []).forEach(function (u) { byId[String(u.task_id)] = u; });
  return (tasks || []).map(function (t) {
    var u = byId[String(t.task_id)];
    if (!u) return t;
    var wasCompleted = t.status === 'Completed';
    var n = {};
    for (var k in t) n[k] = t[k];
    n.completion_percent = u.completion_percent;
    if (u.status) n.status = u.status;
    if (u.status === 'Completed') n.completed_at = nowISO;
    if (wasCompleted && u.completion_percent < 100) n.completed_at = '';
      n.last_updated_at = nowISO;
      if (u.impact_reason !== undefined) n.impact_reason = u.impact_reason;
      if (u.impact_notes !== undefined) n.impact_notes = u.impact_notes;
      return n;
    });
  }
  window.Reports = { summarize: summarize, turnaround: turnaround, onTimeCompletion: onTimeCompletion, averageAccomplishment: averageAccomplishment, additionalTimeMinutes: additionalTimeMinutes, summarizeImpacts: summarizeImpacts, scopeWeek: scopeWeek, validateCheckinRow: validateCheckinRow, validateImpactLink: validateImpactLink, CHECKIN_REASONS: CHECKIN_REASONS, CHECKIN_REASON_LABELS: CHECKIN_REASON_LABELS, dayKey: dayKey, todayKey: todayKey, buildTeamCsv: buildTeamCsv, applyPercentUpdates: applyPercentUpdates, inWeek: inWeek, isOverdue: isOverdue, fmtPct: fmtPct, fmtH: fmtH, buildReportText: buildReportText };
})();
