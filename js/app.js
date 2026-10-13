/* Main UI — views: My Dashboard (personal), Team Overview (management), Reports, Settings. */
(function () {
  var S = window.Store.state;
  var R = window.Reports;
  var view = 'my';
  var lastReport = '';
  var submitResult = '';

  function $ (id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(msg) {
    var t = $('toasts'); var d = document.createElement('div'); d.textContent = msg;
    t.appendChild(d); setTimeout(function () { d.remove(); }, 4200);
  }
  function setLoading(on, label) {
    S.loading = on;
    $('loading').style.display = on ? 'block' : 'none';
    if (label) $('loading').textContent = label;
  }
  function fail(err) {
    var msg = (err && err.message) || 'Request failed.';
    var code = (err && err.code) || '';
    S.error = (code ? '[' + code + '] ' : '') + msg;
    S.errorKind = window.Api.errorKind ? window.Api.errorKind(err) : '';
    renderBanner();
    toast('Error: ' + msg);
  }

  function memberName(id) {
    var m = S.members.filter(function (x) { return x.member_id === id; })[0];
    return m ? m.display_name : id;
  }
  function scopedTasks() {
    var t = S.tasks.filter(function (x) { return !x.archived_at; });
    if (S.selectedMember !== 'ALL') t = t.filter(function (x) { return x.owner_id === S.selectedMember; });
    return t;
  }
  function weekTasks(tasks) {
    return R.scopeWeek(tasks, S.weekStart);
  }
  function weekLogs() {
    return S.workLogs.filter(function (l) { return R.inWeek(l.work_date || l.created_at, S.weekStart); });
  }

  // ---------- banner / header ----------
  function renderBanner() {
    var b = $('banner');
    var sel = S.selectedMember === 'ALL' ? 'Whole team' : esc(memberName(S.selectedMember));
    var scope = '<br><span class="muted">Viewing: <strong>' + sel + '</strong> · Week starting <strong>' + esc(S.weekStart) + '</strong> (Mon–Sun; working days Mon–Fri, Asia/Manila)</span>';
    if (window.Store.isDemo()) {
      b.className = 'banner demo';
      b.innerHTML = '<strong>DEMO MODE</strong> — labeled sample data for evaluation. Not production data.' + scope;
      return;
    }
    if (S.error) {
      b.className = 'banner error';
      var retry = S.errorKind === 'connection' ? ' <button class="btn small" data-act="retry">Retry</button>' : '';
      var hint = S.errorKind === 'auth' ? ' Your key was rejected or is missing — saving will ask for it.' : '';
      b.innerHTML = '<strong>Live data unavailable.</strong> ' + esc(S.error) + hint + retry + scope;
      return;
    }
    if (!S.connected) {
      b.className = 'banner';
      b.innerHTML = 'Connecting to live data…' + scope;
      return;
    }
    b.className = 'banner';
    b.innerHTML = '<strong>LIVE MODE</strong> — team roster and records load automatically. Saving asks for the edit key (used once, never stored).' + scope;
  }

  // Shown instead of misleading empty states when live data never arrived.
  // Demo data is never rendered as a fallback.
  function offlinePanel() {
    if (window.Store.isDemo() || S.connected) return '';
    return '<div class="panel"><h2>Couldn\'t reach the live records</h2>' +
      '<p>' + esc(S.error || 'The connection failed.') + '</p>' +
      '<div class="row"><button class="btn primary" data-act="retry">Retry</button></div>' +
      '<p class="muted">Sample data is never shown automatically. Use Settings → “Use demo mode” only if you explicitly want labeled sample data.</p></div>';
  }

  function renderMemberOptions() {
    var sel = $('memberSelect');
    sel.innerHTML = '<option value="ALL">Whole team (team overview)</option>' +
      S.members.map(function (m) {
        return '<option value="' + esc(m.member_id) + '"' + (S.selectedMember === m.member_id ? ' selected' : '') + '>' +
          esc(m.display_name) + ' — ' + esc(m.role) + '</option>';
      }).join('');
  }

  // ---------- personal weekly check-in ----------
  // Scope rule: the member sees ONLY their own tasks (owner_id match).
  function weekCards(avg, plannedN, addN, addMin, addNoTime, affectedN) {
    function card(label, val, hint) {
      return '<div class="card"><h3>' + label + '</h3><div class="big">' + val + '</div><div class="hint">' + hint + '</div></div>';
    }
    return '<div class="grid cards">' +
      card('Planned accomplishment', R.fmtPct(avg.percent), 'average across ' + avg.reported + ' reported of ' + avg.count + ' planned' + (avg.unreported ? ' · ' + avg.unreported + ' not yet reported' : '') + '; cancelled excluded') +
      card('Planned tasks', plannedN, 'in this week\'s scope') +
      card('Additional tasks', addN, addNoTime ? addNoTime + ' without recorded time' : 'all durations recorded') +
      card('Additional time', R.fmtH(addMin), 'total of recorded additional-task time only') +
      card('Plans affected', affectedN, 'documented links only — never assumed') +
      '</div><p class="kpi-def">The accomplishment % is a simple average of reported completion — not an efficiency score. Read it alongside additional workload, time spent, and documented impacts.</p>';
  }

  function plannedList(wt) {
    return wt.filter(function (t) { return t.task_type === 'PLANNED' && t.status !== 'Cancelled'; });
  }

  function memberImpacts(memberId) {
    var rel = S.impacts;
    if (memberId !== 'ALL') {
      var ids = {};
      S.tasks.filter(function (t) { return t.owner_id === memberId; }).forEach(function (t) { ids[t.task_id] = true; });
      rel = rel.filter(function (i) { return ids[i.additional_task_id] || ids[i.affected_task_id]; });
    }
    return rel;
  }

  // Reason + link state already on record, so the form opens pre-filled and
  // saving an untouched row writes nothing.
  function existingCheckin(t) {
    var links = S.impacts.filter(function (i) { return String(i.affected_task_id) === String(t.task_id); });
    var labels = R.CHECKIN_REASON_LABELS;
    var reason = 'none', explanation = '';
    if (links.length) {
      reason = 'additional';
      explanation = links[0].reason || links[0].evidence_notes || '';
    } else if (t.impact_reason) {
      reason = 'other';
      for (const k of Object.keys(labels)) { if (labels[k] === t.impact_reason) reason = k; }
      explanation = t.impact_notes || t.blocked_reason || '';
    } else if (t.blocked_reason) {
      reason = 'other';
      explanation = t.blocked_reason;
    }
    return { reason: reason, linkedId: links.length ? links[0].additional_task_id : '', explanation: explanation };
  }

  function taskAffectors(taskId) {
    return S.impacts.filter(function (i) { return String(i.affected_task_id) === String(taskId); });
  }

  function reasonOptions(selected) {
    var L = R.CHECKIN_REASON_LABELS;
    return R.CHECKIN_REASONS.map(function (v) {
      return '<option value="' + v + '"' + (selected === v ? ' selected' : '') + '>' + esc(L[v]) + '</option>';
    }).join('');
  }

  function checkinTable(planned, adds) {
    if (!planned.length) return '<div class="empty">No planned tasks yet this week. Tap “Add Planned Task” below — a title is enough to start.</div>';
    return planned.map(function (t) {
      var reported = !(t.completion_percent === '' || t.completion_percent === null || t.completion_percent === undefined);
      var pct = reported ? Number(t.completion_percent) : 0;
      var due = (t.current_due_at || t.original_due_at || '').slice(0, 10);
      var ex = existingCheckin(t);
      var aff = taskAffectors(t.task_id);
      var recorded = aff.length
        ? '<div class="t-meta">Linked: ' + aff.map(function (i) { return esc(taskTitle(i.additional_task_id)); }).join(', ') + '</div>' : '';
      return '<div class="task" data-task="' + esc(t.task_id) + '">' +
        '<div class="t-title">' + esc(t.title) + '</div>' +
        '<div class="t-meta">' + (due ? 'Due ' + esc(due) + ' · ' : '') + (reported ? esc(t.completion_percent) + '% reported' : 'Not reported yet') + '</div>' +
        '<div class="meter" aria-hidden="true"><div style="width:' + pct + '%"></div></div>' +
        '<div class="t-ctl">' +
        '<label>% done <input id="wPct_' + esc(t.task_id) + '" type="number" min="0" max="100" step="any" value="' + (reported ? esc(t.completion_percent) : '') + '" placeholder="—"></label>' +
        '<label>Outcome (for 100%) <input id="wNote_' + esc(t.task_id) + '" placeholder="What was delivered?" style="min-width:150px"></label>' +
        '<button class="btn small" data-open="' + esc(t.task_id) + '">Details</button>' +
        '</div>' +
        '<div class="t-ctl">' +
        '<label>Why incomplete? <select id="wReason_' + esc(t.task_id) + '" data-rsel="' + esc(t.task_id) + '">' + reasonOptions(ex.reason) + '</select></label>' +
        '<span id="wLinkWrap_' + esc(t.task_id) + '" style="display:' + (ex.reason === 'additional' ? 'inline' : 'none') + '">' +
        '<label>Which additional task? <select id="wLink_' + esc(t.task_id) + '">' +
        '<option value="">Choose…</option>' + adds.map(function (a) {
          return '<option value="' + esc(a.task_id) + '"' + (String(ex.linkedId) === String(a.task_id) ? ' selected' : '') + '>' + esc(a.title) + '</option>';
        }).join('') + '</select></label> ' +
        '<label>How did it affect the plan? <select id="wEffect_' + esc(t.task_id) + '">' +
        '<option value="Delayed">It delayed the task</option>' +
        '<option value="Scope Changed">It left less time for the task</option>' +
        '<option value="Paused">It prevented completion</option>' +
        '</select></label></span>' +
        '</div>' +
        '<div class="t-ctl"><label style="flex:1;min-width:180px">Explanation <input id="wWhy_' + esc(t.task_id) + '" style="width:100%" placeholder="Short explanation (needed when a reason is chosen)" value="' + esc(ex.explanation) + '"></label></div>' +
        recorded +
        '</div>';
    }).join('');
  }

  function additionalCards(adds) {
    if (!adds.length) return '<div class="empty">No additional work recorded this week. If something unexpected comes up, add it here with the time you spent.</div>';
    return adds.map(function (t) {
      var rel = S.impacts.filter(function (i) { return String(i.additional_task_id) === String(t.task_id); });
      var aff = rel.length
        ? rel.map(function (i) { return 'Yes — ' + esc(taskTitle(i.affected_task_id)) + ': ' + esc(i.reason || i.evidence_notes || i.impact_type); }).join(' ')
        : 'No — no impact recorded.';
      var time = (t.actual_minutes === '' || t.actual_minutes === null || t.actual_minutes === undefined)
        ? 'Time not recorded' : R.fmtH(Number(t.actual_minutes));
      var when = (t.created_at || '').slice(0, 10);
      return '<div class="task"><div class="t-title">' + esc(t.title) + '</div>' +
        '<div class="t-meta">' + esc(when || 'This week') + ' · ' + esc(time) + '</div>' +
        '<div class="t-meta">Affected planned work? ' + aff + '</div>' +
        '<div class="t-ctl"><button class="btn small" data-open="' + esc(t.task_id) + '">Details</button></div></div>';
    }).join('');
  }

  function vMy() {
    if (S.selectedMember === 'ALL') {
      return '<div class="panel"><h2>Whose work are you recording?</h2>' +
        '<p>Select your name at the top to open your personal weekly dashboard.</p>' +
        '<p class="muted">Selecting a name only chooses what to view. It does not prove who you are; saving still needs the edit key.</p></div>' +
        '<div class="panel"><h2>How the week works</h2><ol>' +
        '<li>Add your <strong>planned tasks</strong> at the start of the week (title is enough).</li>' +
        '<li>During the week, record <strong>additional tasks</strong> with time spent and whether they affected your plan.</li>' +
        '<li>At week\'s end, enter one <strong>% accomplished</strong> per planned task — nothing else required.</li>' +
        '<li>Press <strong>Submit Weekly Accomplishment</strong> to freeze the week\'s record (earlier weeks never change).</li></ol></div>';
    }
    var m = S.members.filter(function (x) { return x.member_id === S.selectedMember; })[0];
    var wt = weekTasks(scopedTasks());
    var planned = plannedList(wt);
    var adds = wt.filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled'; });
    var avg = R.averageAccomplishment(wt);
    var time = R.additionalTimeMinutes(wt);
    var affectedN = memberImpacts(S.selectedMember).length;
    var h = '<div class="panel"><h2>' + esc(m ? m.display_name : S.selectedMember) + (m ? ' <span class="muted">· ' + esc(m.role) + '</span>' : '') + '</h2>' +
      '<p class="muted">Week of ' + esc(S.weekStart) + ' (Mon–Sun, Asia/Manila). % means deliverable accomplished, not time elapsed.</p></div>';
    h += weekCards(avg, planned.length, adds.length, time.totalMinutes, time.withoutTime, affectedN);
    h += '<div class="panel"><h2>Planned tasks — report % accomplished</h2>' +
      '<p class="muted">At week\'s end, enter one % per task — any value 0–100. Leave blank what you have not measured yet. An outcome note is asked only at 100%.</p>' +
      checkinTable(planned, adds) +
      '<div class="row" style="margin-top:12px"><button class="btn primary" data-act="add-planned">+ Add Planned Task</button>' +
      '<button class="btn" data-act="save-checkin">Save percentages</button></div></div>';
    h += '<div class="panel"><h2>Additional tasks</h2>' +
      '<p class="muted">Work added after the plan, with recorded time and documented effects only.</p>' +
      additionalCards(adds) +
      '<div class="row" style="margin-top:12px"><button class="btn primary" data-act="add-additional">+ Add Additional Task</button></div></div>';
    h += '<div class="panel"><h2>Submit weekly accomplishment</h2>' +
      submitStatusLine() +
      '<p class="muted">Review first, then freeze this week\'s record. Earlier weeks never change; re-submitting updates this week only.</p>' +
      '<div class="row"><button class="btn primary" data-act="submit-weekly">Submit Weekly Accomplishment</button></div>' +
      (submitResult ? '<pre class="report">' + esc(submitResult) + '</pre>' : '') + '</div>';
    h += '<div class="panel"><h2>Documented impacts on planned work</h2><div style="overflow-x:auto">' + impactList() + '</div>' +
      '<div class="row"><button class="btn" data-act="new-impact">+ Link extra work to affected plan</button></div></div>';
    return h;
  }

  function submitStatusLine() {
    var snap = S.snapshots.filter(function (s) {
      return String(s.week_start).slice(0, 10) === S.weekStart && String(s.member_id) === String(S.selectedMember);
    })[0];
    if (snap) return '<p><span class="badge ok">✓ Submitted</span> <span class="muted">Record frozen ' + esc(String(snap.generated_at || '').slice(0, 10)) + '. Re-submitting updates this week only.</span></p>';
    return '<p><span class="badge warn">Not yet submitted</span> <span class="muted">This week\'s record is still open.</span></p>';
  }

  function vAdditional() {
    if (S.selectedMember === 'ALL') {
      return '<div class="panel"><h2>Whose additional work?</h2><p>Select your name at the top first — additional tasks belong to one person and one week.</p></div>';
    }
    var m = S.members.filter(function (x) { return x.member_id === S.selectedMember; })[0];
    var wt = weekTasks(scopedTasks());
    var adds = wt.filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled'; });
    var time = R.additionalTimeMinutes(wt);
    return '<div class="panel hero"><h2>Additional tasks</h2>' +
      '<p class="muted">' + esc(m ? m.display_name : S.selectedMember) + ' · week of ' + esc(S.weekStart) + ' · ' + adds.length + ' recorded · ' + esc(R.fmtH(time.totalMinutes)) + ' total' + (time.withoutTime ? ' · ' + time.withoutTime + ' without recorded time' : '') + '</p></div>' +
      '<div class="panel">' + additionalCards(adds) +
      '<div class="row" style="margin-top:12px"><button class="btn primary" data-act="add-additional">+ Add Additional Task</button></div>' +
      '<p class="muted">Only impacts you document are shown as affecting planned work — hours alone never imply a delay.</p></div>' +
      '<div class="panel"><h2>Documented impacts</h2><div style="overflow-x:auto">' + impactList() + '</div></div>';
  }

  function taskTitle(id) {
    var t = S.tasks.filter(function (x) { return x.task_id === id; })[0];
    return t ? t.title : id;
  }

  function impactList() {
    var rel = S.impacts;
    if (S.selectedMember !== 'ALL') {
      var ids = {};
      S.tasks.filter(function (t) { return t.owner_id === S.selectedMember; }).forEach(function (t) { ids[t.task_id] = true; });
      rel = rel.filter(function (i) { return ids[i.additional_task_id] || ids[i.affected_task_id]; });
    }
    if (!rel.length) return '<p class="muted">No documented workload impacts. Linking additional work to affected planned tasks is how delays get explained with evidence.</p>';
    return '<table><thead><tr><th>Additional task</th><th>Affected planned task</th><th>Impact</th><th>Reason</th></tr></thead><tbody>' +
      rel.map(function (i) {
        return '<tr><td>' + esc(taskTitle(i.additional_task_id)) + '</td><td>' + esc(taskTitle(i.affected_task_id)) + '</td><td>' + esc(i.impact_type) + '</td><td>' + esc(i.reason || '') + ' <span class="muted">' + esc(i.evidence_notes || '') + '</span></td></tr>';
      }).join('') + '</tbody></table>';
  }

  // ---------- team overview (management, read-only) ----------
  // Accomplishment is always shown WITH additional workload — never ranked
  // on raw counts or on one percentage alone.
  function vTeam() {
    var wt = weekTasks(S.tasks.filter(function (t) { return !t.archived_at; }));
    var avgAll = R.averageAccomplishment(wt);
    var timeAll = R.additionalTimeMinutes(wt);
    var impAll = R.summarizeImpacts(memberImpacts('ALL'));
    var h = '<div class="panel"><h2>Team overview <span class="muted">· read-only; members record via My Dashboard</span></h2>' +
      '<p class="muted">Week of ' + esc(S.weekStart) + ' (Mon–Sun, Asia/Manila). Roles differ, so raw task counts are never treated as equal effort.</p></div>';
    h += weekCards(avgAll, avgAll.count, timeAll.taskCount, timeAll.totalMinutes, timeAll.withoutTime, impAll.count);
    h += '<div class="panel"><div class="row"><button class="btn primary" data-act="gen-team-report">Generate concise team report</button></div>' +
      '<p class="muted">Opens in Reports — review before export or printing.</p></div>';
    S.members.forEach(function (m) {
      var mt = wt.filter(function (t) { return t.owner_id === m.member_id; });
      var planned = plannedList(mt);
      var avg = R.averageAccomplishment(mt);
      var time = R.additionalTimeMinutes(mt);
      var adds = mt.filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled'; });
      var imp = memberImpacts(m.member_id);
      h += '<div class="panel"><h2>' + esc(m.display_name) + ' <span class="muted">· ' + esc(m.role) + '</span></h2>';
      h += '<p><strong>Planned average: ' + R.fmtPct(avg.percent) + '</strong> <span class="muted">(mean of reported % across ' + avg.count + ' planned task(s))</span></p>';
      h += planned.length ? '<ul class="clean">' + planned.map(function (t) {
        var pct = (t.completion_percent === '' || t.completion_percent === null || t.completion_percent === undefined) ? 'Not reported' : t.completion_percent + '%';
        var why = '';
        if (Number(t.completion_percent) < 100 || t.completion_percent === '') {
          var aff = taskAffectors(t.task_id);
          var reason = t.impact_reason || (t.blocked_reason ? 'Blocked — ' + t.blocked_reason : '');
          var linked = aff.map(function (i) {
            var add = S.tasks.filter(function (x) { return String(x.task_id) === String(i.additional_task_id); })[0];
            var tm = add && add.actual_minutes !== '' && add.actual_minutes !== null && add.actual_minutes !== undefined ? R.fmtH(Number(add.actual_minutes)) : 'time not recorded';
            return (add ? add.title : i.additional_task_id) + ' (' + tm + '): ' + (i.reason || i.evidence_notes || i.impact_type);
          }).join('; ');
          why = '<br><span class="muted">' +
            (reason ? 'Why incomplete: ' + esc(reason) + (t.impact_notes ? ' — ' + esc(t.impact_notes) : '') : 'No reason given yet.') +
            (linked ? '<br>Affected by: ' + esc(linked) : '') + '</span>';
        }
        return '<li>' + esc(t.title) + ' — <strong>' + esc(pct) + '</strong>' +
          (t.current_due_at ? ' <span class="muted">due ' + esc(String(t.current_due_at).slice(0, 10)) + '</span>' : '') + why +
          ' <button class="btn small" data-open="' + esc(t.task_id) + '">Open</button></li>';
      }).join('') + '</ul>' : '<p class="muted">No planned tasks recorded.</p>';
      h += '<p><strong>Additional: ' + adds.length + ' task(s), ' + R.fmtH(time.totalMinutes) + ' recorded</strong>' +
        (time.withoutTime ? ' <span class="muted">(' + time.withoutTime + ' without recorded time)</span>' : '') + '</p>';
      h += adds.length ? '<ul>' + adds.map(function (t) {
        var links = imp.filter(function (i) { return String(i.additional_task_id) === String(t.task_id); });
        var tm = (t.actual_minutes === '' || t.actual_minutes === null || t.actual_minutes === undefined) ? 'time not recorded' : R.fmtH(Number(t.actual_minutes));
        return '<li>' + esc(t.title) + ' — ' + esc(tm) +
          (links.length
            ? '<br><span class="muted">Affected: ' + links.map(function (i) { return esc(taskTitle(i.affected_task_id)) + ' — ' + esc(i.reason || i.evidence_notes || i.impact_type); }).join('; ') + '</span>'
            : '<br><span class="muted">Reported as not affecting planned work.</span>') + '</li>';
      }).join('') + '</ul>' : '';
      h += '</div>';
    });
    h += '<div class="panel"><h2>Data quality</h2>' + dataQuality(wt) + '</div>';
    return h;
  }

  function dataQuality(wt) {
    var missing = wt.filter(function (t) { return t.status !== 'Completed' && t.status !== 'Cancelled' && !t.blocked_reason && !t.impact_reason && !t.impact_notes && Number(t.completion_percent) < 100; });
    var noEst = wt.filter(function (t) { return (t.estimated_minutes === '' || t.estimated_minutes === null) && t.status !== 'Cancelled'; });
    var noDue = wt.filter(function (t) { return !(t.current_due_at || t.original_due_at) && t.status !== 'Completed' && t.status !== 'Cancelled'; });
    return '<ul><li>' + missing.length + ' incomplete task(s) without a documented reason — flagged as requiring clarification.</li>' +
      '<li>' + noEst.length + ' task(s) without effort estimates — excluded from weighted completion (counted, not hidden).</li>' +
      '<li>' + noDue.length + ' open task(s) without any deadline.</li></ul>';
  }

  function vReports() {
    return '<div class="panel"><h2>Weekly accomplishment report</h2>' +
      '<div class="row"><button class="btn primary" data-act="gen-report">Generate report</button>' +
      '<button class="btn" data-act="export-csv">Export tasks CSV</button>' +
      '<button class="btn" data-act="print">Print / Save PDF</button>' +
      (window.Store.isDemo() || !S.connected ? '' : '<button class="btn" data-act="snapshot">Save snapshot</button>') + '</div>' +
      '<p class="muted">Derived only from stored tasks, daily updates, work logs, and impact records. Incomplete tasks without explanations are flagged as requiring clarification. Review before export.</p>' +
      '<pre class="report" id="reportPre">' + esc(lastReport || 'Press “Generate report” to preview.') + '</pre></div>';
  }

  function vSettings() {
    var api = window.AppConfig.getApiBase();
    return '<div class="panel"><h2>Connection</h2>' +
      '<div class="form"><label class="full">Apps Script /exec URL<input id="cfgApi" value="' + esc(api) + '" placeholder="https://script.google.com/macros/s/…/exec"></label>' +
      '<label>Edit key (this tab’s memory only)<input id="cfgEdit" type="password" placeholder="asked again when saving"></label>' +
      '<label>Admin key (this tab’s memory only)<input id="cfgAdmin" type="password" placeholder="asked again for roster changes"></label></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn primary" data-act="save-config">Save & connect</button>' +
      '<button class="btn" data-act="use-demo">Use demo mode</button>' +
      '<button class="btn" data-act="ping">Test connection</button>' +
      '<button class="btn" data-act="forget-keys">Forget keys</button></div>' +
      '<p class="muted">Keys are kept in this tab’s memory only and cleared on refresh — never stored. Saving asks for a key only when needed. Selecting a name does not identify anyone.</p>' +
      '<p class="muted">Mode: <strong>' + (window.Store.isDemo() ? 'DEMO' : 'LIVE') + '</strong> · API: <span class="mono">' + esc(api || '(not set)') + '</span></p></div>' +
      '<div class="panel"><h2>Team roster (' + S.members.length + ' members)</h2><p class="muted">Roster changes need the admin key (authorized users only).</p>' +
      '<table><thead><tr><th>ID</th><th>Name</th><th>Role</th><th>Active</th></tr></thead><tbody>' +
      S.members.map(function (m) { return '<tr><td class="mono">' + esc(m.member_id) + '</td><td>' + esc(m.display_name) + '</td><td>' + esc(m.role) + '</td><td>' + esc(m.is_active) + '</td></tr>'; }).join('') +
      '</tbody></table><div class="row" style="margin-top:10px"><button class="btn" data-act="add-member">+ Add member (admin)</button></div></div>' +
      '<div class="panel"><h2>Audit history</h2><p class="muted">Creates, updates, reassignments, deadline changes, completions, and archives are recorded server-side. Open any task to see its history.</p></div>';
  }

  // ---------- render ----------
  function render() {
    renderBanner(); renderMemberOptions();
    document.querySelectorAll('.nav button').forEach(function (b) { b.classList.toggle('active', b.dataset.view === view); });
    var el = $('view');
    if (S.loading) { el.innerHTML = '<div class="panel">Loading…</div>'; return; }
    var h = '';
    if (view === 'my') h = vMy();
    else if (view === 'additional') h = vAdditional();
    else if (view === 'team') h = vTeam();
    else if (view === 'reports') h = vReports();
    else if (view === 'settings') h = vSettings();
    else { view = 'my'; h = vMy(); }
    el.innerHTML = offlinePanel() + h;
    bindView();
  }

  function bindView() {
    document.querySelectorAll('[data-open]').forEach(function (b) { b.onclick = function () { openTask(b.dataset.open); }; });
    document.querySelectorAll('[data-act]').forEach(function (b) { b.onclick = function () { act(b.dataset.act); }; });
    // Show the link picker + effect question only when "additional" is chosen.
    document.querySelectorAll('[data-rsel]').forEach(function (sel) {
      sel.onchange = function () {
        var wrap = $('wLinkWrap_' + sel.getAttribute('data-rsel'));
        if (wrap) wrap.style.display = sel.value === 'additional' ? 'inline' : 'none';
      };
    });
  }

  // ---------- actions ----------
  function act(a) {
    if (a === 'add-planned') addPlannedDialog();
    else if (a === 'add-additional') addAdditionalDialog();
    else if (a === 'save-checkin') saveCheckinUI();
    else if (a === 'submit-weekly') submitWeekly();
    else if (a === 'gen-team-report') genTeamReport();
    else if (a === 'new-impact') impactDialog();
    else if (a === 'add-member') memberDialog();
    else if (a === 'gen-report') genReport();
    else if (a === 'export-csv') exportCsv();
    else if (a === 'print') window.print();
    else if (a === 'snapshot') saveSnapshot();
    else if (a === 'save-config') saveConfig();
    else if (a === 'use-demo') { window.Store.enterDemo(); S.error = ''; submitResult = ''; render(); toast('Demo mode enabled.'); }
    else if (a === 'ping') ping();
    else if (a === 'retry') { S.error = ''; S.errorKind = ''; connectLive(); }
    else if (a === 'forget-keys') { window.AppConfig.clearKeys(); render(); toast('Keys cleared from this tab\'s memory.'); }
  }

  // ---------- weekly check-in: slim dialogs, save, submit ----------
  function addPlannedDialog() {
    if (S.selectedMember === 'ALL') { toast('Select your name first.'); return; }
    var dlg = document.createElement('dialog');
    dlg.innerHTML = '<h3 style="margin-top:0">Add planned task</h3>' +
      '<p class="muted">Title is required; deadline and description are optional.</p>' +
      '<div class="form">' +
      '<label class="full">Title*<input id="pTitle" placeholder="What will you deliver?"></label>' +
      '<label>Deadline (optional)<input id="pDue" type="date"></label>' +
      '<label class="full">Brief description (optional)<textarea id="pDesc" rows="2"></textarea></label></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn primary" id="pSave">Add task</button><button class="btn" id="pCancel">Cancel</button></div>';
    document.body.appendChild(dlg); dlg.showModal();
    dlg.querySelector('#pCancel').onclick = function () { dlg.close(); dlg.remove(); };
    dlg.querySelector('#pSave').onclick = function () {
      var title = dlg.querySelector('#pTitle').value.trim();
      if (!title) { toast('Give the task a title.'); return; }
      var due = dlg.querySelector('#pDue').value;
      var p = {
        task_id: window.Store.uid('T'), title: title, description: dlg.querySelector('#pDesc').value,
        owner_id: S.selectedMember, task_type: 'PLANNED', priority: 'Medium', status: 'Not Started',
        completion_percent: 0, current_due_at: due, original_due_at: due
      };
      dlg.querySelector('#pSave').disabled = true; dlg.close(); dlg.remove();
      if (window.Store.isDemo()) {
        S.tasks.unshift(Object.assign({
          created_at: new Date().toISOString(), started_at: '', completed_at: '', estimated_minutes: '',
          actual_minutes: '', requested_by: '', blocked_reason: '', impact_reason: '', impact_notes: '',
          created_by: 'demo', last_updated_at: new Date().toISOString(), archived_at: ''
        }, p));
        render(); toast('Planned task added (demo).');
        return;
      }
      requireLiveKey(function (ok) {
        if (!ok) return;
        setLoading(true, 'Adding…'); render();
        window.Api.createTask(p).then(function () { return refreshLive(); })
          .then(function () { setLoading(false); render(); toast('Planned task added.'); })
          .catch(function (e) { setLoading(false); render(); fail(e); });
      });
    };
  }

  function addAdditionalDialog() {
    if (S.selectedMember === 'ALL') { toast('Select your name first.'); return; }
    var planned = plannedList(weekTasks(scopedTasks()));
    var dlg = document.createElement('dialog');
    dlg.innerHTML = '<h3 style="margin-top:0">Add additional task</h3>' +
      '<p class="muted">Work added after the plan. Time spent is recorded as one total — no detailed tracking needed.</p>' +
      '<div class="form">' +
      '<label class="full">Title*<input id="aTitle" placeholder="What came up?"></label>' +
      '<label>Hours spent<input id="aH" type="number" min="0" value="0"></label>' +
      '<label>Minutes spent<input id="aM" type="number" min="0" max="59" value="0"></label>' +
      '<label class="full">Did this affect your planned work?<select id="aAff"><option value="No">No</option><option value="Yes">Yes</option></select></label>' +
      '<div id="aYesBox" class="full" style="display:none">' +
      '<label>Which planned task(s)?<div id="aPlans">' + (planned.length ? planned.map(function (t) {
        return '<label style="display:block;font-size:14px"><input type="checkbox" value="' + esc(t.task_id) + '"> ' + esc(t.title) + '</label>';
      }).join('') : '<span class="muted">No planned tasks this week.</span>') + '</div></label>' +
      '<label>Impact type<select id="aType"><option value="">Choose…</option>' + ['Delayed', 'Paused', 'Scope Changed', 'Dependency Affected', 'No Impact'].map(function (x) { return '<option>' + x + '</option>'; }).join('') + '</select></label>' +
      '<label>Short explanation*<textarea id="aWhy" rows="2" placeholder="What happened to the planned task?"></textarea></label>' +
      '</div></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn primary" id="aSave">Add task</button><button class="btn" id="aCancel">Cancel</button></div>' +
      '<p class="muted">Only documented impacts are shown in reports — hours alone never imply a delay.</p>';
    document.body.appendChild(dlg); dlg.showModal();
    dlg.querySelector('#aAff').onchange = function (e) {
      dlg.querySelector('#aYesBox').style.display = e.target.value === 'Yes' ? 'block' : 'none';
    };
    dlg.querySelector('#aCancel').onclick = function () { dlg.close(); dlg.remove(); };
    dlg.querySelector('#aSave').onclick = function () {
      var title = dlg.querySelector('#aTitle').value.trim();
      if (!title) { toast('Give the task a title.'); return; }
      var mins = Math.max(0, Number(dlg.querySelector('#aH').value || 0)) * 60 + Math.max(0, Number(dlg.querySelector('#aM').value || 0));
      var affected = dlg.querySelector('#aAff').value === 'Yes';
      var checked = [];
      dlg.querySelectorAll('#aPlans input[type=checkbox]:checked').forEach(function (c) { checked.push(c.value); });
      var why = dlg.querySelector('#aWhy').value.trim();
      var type = dlg.querySelector('#aType').value;
      if (affected && !checked.length) { toast('Select the affected planned task(s), or answer No.'); return; }
      if (affected && !why) { toast('Add a short explanation of the effect.'); return; }
      if (affected && !type) { toast('Choose the impact type.'); return; }
      var newId = window.Store.uid('T');
      dlg.querySelector('#aSave').disabled = true; dlg.close(); dlg.remove();
      var task = {
        task_id: newId, title: title, description: '', owner_id: S.selectedMember, task_type: 'ADDITIONAL',
        priority: 'Medium', status: 'Not Started', completion_percent: 0,
        actual_minutes: mins > 0 ? mins : '', requested_by: '', impact_reason: affected ? why : ''
      };
      var links = affected ? checked.map(function (pid) {
        return { additional_task_id: newId, affected_task_id: pid, impact_type: type, reason: why, evidence_notes: '' };
      }) : [];
      if (window.Store.isDemo()) {
        var now = new Date().toISOString();
        S.tasks.unshift(Object.assign({
          created_at: now, started_at: '', completed_at: '', original_due_at: '', current_due_at: '',
          estimated_minutes: '', blocked_reason: '', impact_notes: '', created_by: 'demo',
          last_updated_at: now, archived_at: ''
        }, task));
        links.forEach(function (l) {
          S.impacts.push(Object.assign({ impact_id: window.Store.uid('I'), estimated_delay_minutes: '', actual_delay_minutes: '', created_by: 'demo', created_at: now, updated_at: now }, l));
        });
        render(); toast('Additional task recorded (demo).');
        return;
      }
      requireLiveKey(function (ok) {
        if (!ok) return;
        setLoading(true, 'Recording…'); render();
        window.Api.createTask(task).then(function () {
          var chain = Promise.resolve();
          links.forEach(function (l) { chain = chain.then(function () { return window.Api.upsertImpact(l); }); });
          return chain;
        }).then(function () { return refreshLive(); })
          .then(function () { setLoading(false); render(); toast('Additional task recorded.'); })
          .catch(function (e) { setLoading(false); render(); fail(e); });
      });
    };
  }

  // Read one check-in row from the form. pct null = left blank (unreported).
  function readCheckinRow(t) {
    var pctEl = document.getElementById('wPct_' + t.task_id);
    if (!pctEl) return null;
    var raw = pctEl.value.trim();
    var noteEl = document.getElementById('wNote_' + t.task_id);
    var rsel = document.getElementById('wReason_' + t.task_id);
    var lsel = document.getElementById('wLink_' + t.task_id);
    var esel = document.getElementById('wEffect_' + t.task_id);
    var whyEl = document.getElementById('wWhy_' + t.task_id);
    return {
      task: t,
      pct: raw === '' ? null : Number(raw),
      outcomeNote: noteEl ? noteEl.value.trim() : '',
      reason: rsel ? rsel.value : 'none',
      linkedId: lsel ? lsel.value : '',
      effect: esel ? esel.value : 'Delayed',
      explanation: whyEl ? whyEl.value.trim() : ''
    };
  }

  // Read the check-in form; validate only. Never writes.
  function collectCheckin(planned, adds) {
    var L = R.CHECKIN_REASON_LABELS;
    var updates = [], errors = [];
    planned.forEach(function (t) {
      var row = readCheckinRow(t);
      if (!row) return;
      if (row.pct === null) {
        if (row.reason !== 'none' || row.explanation) errors.push(t.title + ': enter the % accomplished first.');
        return; // unreported — nothing to save, excluded from averages
      }
      var v = R.validateCheckinRow({
        pct: row.pct, alreadyCompleted: t.status === 'Completed', outcomeNote: row.outcomeNote,
        reason: row.reason, linkedId: row.linkedId, explanation: row.explanation
      });
      if (row.reason === 'none' && row.explanation) {
        errors.push(t.title + ': choose why it is incomplete, or clear the explanation.');
        return;
      }
      if (!v.ok) { v.errors.forEach(function (e) { errors.push(t.title + ': ' + e); }); return; }
      var pct = Math.round(row.pct);
      var link = null;
      if (row.reason === 'additional' && row.linkedId) {
        var add = adds.filter(function (a) { return String(a.task_id) === String(row.linkedId); })[0];
        var lv = R.validateImpactLink(add, t, S.weekStart);
        if (!lv.ok) { lv.errors.forEach(function (e) { errors.push(t.title + ': ' + e); }); return; }
        link = { additional_task_id: row.linkedId, affected_task_id: t.task_id, impact_type: row.effect, reason: row.explanation, evidence_notes: '' };
      }
      var cur = existingCheckin(t);
      var next = { task_id: t.task_id, completion_percent: pct };
      var dirty = pct !== Number(t.completion_percent);
      if (pct === 100 && t.status !== 'Completed') { next.status = 'Completed'; next.outcome_note = row.outcomeNote; dirty = true; }
      else if (t.status === 'Completed' && pct < 100) { next.status = 'In Progress'; dirty = true; }
      else if (t.status === 'Not Started' && pct > 0) { next.status = 'In Progress'; dirty = true; }
      var reasonDirty = (row.reason !== cur.reason) || (row.explanation !== cur.explanation);
      if (row.reason !== 'none' && reasonDirty) {
        next.impact_reason = L[row.reason] || row.reason;
        next.impact_notes = row.explanation;
      }
      var linkDirty = false;
      if (link) {
        var prior = S.impacts.filter(function (i) {
          return String(i.affected_task_id) === String(t.task_id) && String(i.additional_task_id) === String(link.additional_task_id);
        })[0];
        if (!prior) linkDirty = true;
        else {
          if ((prior.reason || '') !== link.reason || (prior.impact_type || '') !== link.impact_type) linkDirty = true;
          link.impact_id = prior.impact_id;
        }
      }
      if (!dirty && !reasonDirty && !linkDirty) return; // untouched row writes nothing
      if (linkDirty) next._link = link;
      updates.push(next);
    });
    return { updates: updates, errors: errors };
  }

  // Save the check-in: one updateTask per changed row, then one upsertImpact
  // per new/changed link. No daily updates or time logs required.
  function saveCheckin() {
    var planned = plannedList(weekTasks(scopedTasks()));
    var adds = weekTasks(scopedTasks()).filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled'; });
    var c = collectCheckin(planned, adds);
    if (c.errors.length) {
      toast(c.errors[0]);
      if (c.errors.length > 1) toast((c.errors.length - 1) + ' more need attention.');
      if (!c.updates.length) return Promise.resolve({ saved: 0, errors: c.errors.length });
    }
    if (!c.updates.length) {
      if (!c.errors.length) toast('Nothing new to save.');
      return Promise.resolve({ saved: 0, errors: c.errors.length });
    }
    if (window.Store.isDemo()) {
      var now = new Date().toISOString();
      c.updates.forEach(function (u) {
        var t = S.tasks.filter(function (x) { return x.task_id === u.task_id; })[0];
        if (!t) return;
        var prev = Number(t.completion_percent);
        t.completion_percent = u.completion_percent;
        if (u.status) t.status = u.status;
        if (u.status === 'Completed') t.completed_at = now;
        if (t.status === 'Completed' && u.completion_percent < 100) t.completed_at = '';
        if (u.impact_reason !== undefined) t.impact_reason = u.impact_reason;
        if (u.impact_notes !== undefined) t.impact_notes = u.impact_notes;
        t.last_updated_at = now;
        if (u.outcome_note) {
          S.updates.push({
            update_id: window.Store.uid('U'), task_id: t.task_id, member_id: t.owner_id,
            update_date: S.weekStart, previous_percent: prev, new_percent: 100,
            accomplishment_notes: u.outcome_note, remaining_work: '', blocker_notes: '', created_at: now
          });
        }
        if (u._link) {
          var prior = S.impacts.filter(function (i) {
            return String(i.affected_task_id) === String(u.task_id) && String(i.additional_task_id) === String(u._link.additional_task_id);
          })[0];
          if (prior) {
            prior.impact_type = u._link.impact_type; prior.reason = u._link.reason; prior.updated_at = now;
          } else {
            S.impacts.push(Object.assign({
              impact_id: window.Store.uid('I'), estimated_delay_minutes: '', actual_delay_minutes: '',
              created_by: 'demo', created_at: now, updated_at: now
            }, u._link));
          }
        }
      });
      render(); toast('Saved ' + c.updates.length + ' update(s) (demo).');
      return Promise.resolve({ saved: c.updates.length, errors: c.errors.length });
    }
    return new Promise(function (resolve) {
      requireLiveKey(function (ok) {
        if (!ok) { resolve({ saved: 0, blocked: true }); return; }
        setLoading(true, 'Saving…'); render();
        var chain = Promise.resolve();
        c.updates.forEach(function (u) {
          var link = u._link; delete u._link;
          chain = chain.then(function () { return window.Api.updateTask(u); }).then(function () {
            if (link) return window.Api.upsertImpact(link);
          });
        });
        chain.then(function () { return refreshLive(); }).then(function () {
          setLoading(false); render(); toast('Saved ' + c.updates.length + ' update(s).');
          resolve({ saved: c.updates.length, errors: c.errors.length });
        }).catch(function (e) { setLoading(false); render(); fail(e); resolve({ saved: 0, failed: true }); });
      });
    });
  }

  function saveCheckinUI() {
    saveCheckin().then(function () { /* toasts/render handled inside */ });
  }

  // Review step: show every planned task with its entered % and reason state,
  // block on validation errors, then confirm. The form underneath keeps its
  // values whatever the reviewer decides.
  function submitWeekly() {
    if (S.selectedMember === 'ALL') { toast('Select your name first.'); return; }
    var planned = plannedList(weekTasks(scopedTasks()));
    var adds = weekTasks(scopedTasks()).filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled'; });
    var c = collectCheckin(planned, adds);
    var L = R.CHECKIN_REASON_LABELS;
    var items = planned.map(function (t) {
      var row = readCheckinRow(t);
      var pctText = !row || row.pct === null ? 'Not reported — stays out of the average' : Math.round(row.pct) + '%';
      var reasonText = '—';
      if (row && row.pct !== null && row.pct < 100) {
        reasonText = row.reason === 'none' ? 'No reason given (optional)' :
          L[row.reason] + (row.reason === 'additional' && row.linkedId ? ' → ' + taskTitle(row.linkedId) : '') + ': ' + (row.explanation || '(missing)');
      }
      var errs = c.errors.filter(function (e) { return e.indexOf(t.title + ': ') === 0; });
      return { title: t.title, pctText: pctText, reasonText: reasonText, errs: errs };
    });
    var unrep = items.filter(function (i) { return i.pctText.indexOf('Not reported') === 0; }).length;
    var dlg = document.createElement('dialog');
    dlg.innerHTML = '<h3 style="margin-top:0">Review before submitting</h3>' +
      '<p class="muted">Week of ' + esc(S.weekStart) + '. ' + planned.length + ' planned task(s)' +
      (unrep ? ', ' + unrep + ' not yet reported (excluded from the average)' : ', all reported') + '.</p>' +
      '<ul class="review">' + items.map(function (i) {
        return '<li><strong>' + esc(i.title) + '</strong> — ' + esc(i.pctText) + '<br><span class="muted">' + esc(i.reasonText) + '</span>' +
          i.errs.map(function (e) { return '<br><span class="err">' + esc(e) + '</span>'; }).join('') + '</li>';
      }).join('') + '</ul>' +
      (c.errors.length
        ? '<p class="err"><strong>' + c.errors.length + ' issue(s) to fix first.</strong> Nothing was saved.</p><div class="row"><button class="btn primary" id="rBack">Back to fix</button></div>'
        : '<p class="muted">Submitting freezes this week\'s record. Earlier weeks never change.</p><div class="row"><button class="btn primary" id="rGo">Confirm submit</button><button class="btn" id="rBack">Back</button></div>');
    document.body.appendChild(dlg); dlg.showModal();
    dlg.querySelector('#rBack').onclick = function () { dlg.close(); dlg.remove(); };
    var go = dlg.querySelector('#rGo');
    if (go) go.onclick = function () { go.disabled = true; dlg.close(); dlg.remove(); doSubmit(); };
  }

  // Submit = save check-in, then freeze the week via idempotent snapshot,
  // then show the generated report. Rerunning updates the same snapshot;
  // other weeks are never touched.
  function doSubmit() {
    setLoading(true, 'Submitting weekly accomplishment…'); render();
    saveCheckin().then(function (r) {
      if (r.blocked || r.failed) return;
      if (window.Store.isDemo()) {
        var wt = weekTasks(scopedTasks());
        var avg = R.averageAccomplishment(wt);
        var time = R.additionalTimeMinutes(wt);
        var ex = S.snapshots.filter(function (s) { return String(s.week_start).slice(0, 10) === S.weekStart && String(s.member_id) === String(S.selectedMember); })[0];
        var row = {
          snapshot_id: ex ? ex.snapshot_id : window.Store.uid('S'), week_start: S.weekStart, member_id: S.selectedMember,
          planned_task_count: avg.count, planned_completion_percent: avg.percent,
          additional_task_count: time.taskCount, additional_effort_minutes: time.totalMinutes,
          generated_at: new Date().toISOString()
        };
        if (ex) Object.assign(ex, row); else S.snapshots.push(row);
        submitResult = R.buildReportText(reportContext());
        setLoading(false); render(); toast('Submitted (demo) — this week\'s record is frozen.');
        return;
      }
      return window.Api.createSnapshot({ week_start: S.weekStart, member_id: S.selectedMember }).then(function () {
        return window.Api.weeklyReport({ week_start: S.weekStart, member_id: S.selectedMember });
      }).then(function (rep) {
        submitResult = rep.text; lastReport = rep.text;
        setLoading(false); render(); toast('Submitted — this week\'s record is frozen.');
      });
    }).catch(function (e) { setLoading(false); render(); fail(e); });
  }

  function teamReportText() {
    var wt = weekTasks(S.tasks.filter(function (t) { return !t.archived_at; }));
    var e = new Date(S.weekStart + 'T00:00:00Z'); e.setUTCDate(e.getUTCDate() + 6);
    var L = ['WEEKLY ACCOMPLISHMENT REPORT — Academic Affairs Team',
      'Reporting period: ' + S.weekStart + ' to ' + e.toISOString().slice(0, 10) + ' (Asia/Manila, Mon–Sun; working days Mon–Fri).', ''];
    S.members.forEach(function (m) {
      var mt = wt.filter(function (t) { return t.owner_id === m.member_id; });
      var avg = R.averageAccomplishment(mt);
      var time = R.additionalTimeMinutes(mt);
      var imp = R.summarizeImpacts(memberImpacts(m.member_id));
      L.push(m.display_name + ' (' + m.role + '): planned average ' +
        (avg.percent === null ? '—' : avg.percent + '%') + ' across ' + avg.count +
        '; additional ' + time.taskCount + ' task(s), ' + time.totalMinutes + ' min recorded; ' +
        imp.count + ' documented impact(s).');
      imp.reasons.forEach(function (x) {
        L.push('  • ' + taskTitle(x.additional_task_id) + ' → ' + taskTitle(x.affected_task_id) + ': ' + (x.reason || x.evidence_notes));
      });
    });
    return L.join('\n');
  }

  function genTeamReport() {
    if (window.Store.isDemo()) {
      lastReport = teamReportText();
      view = 'reports'; render(); toast('Team report generated (demo).');
      return;
    }
    setLoading(true, 'Generating team report…'); render();
    window.Api.weeklyReport({ week_start: S.weekStart, member_id: 'ALL' }).then(function (r) {
      lastReport = r.text; setLoading(false); view = 'reports'; render(); toast('Team report generated.');
    }).catch(function (e) { setLoading(false); render(); fail(e); });
  }

  // Write gates. Keys are page-lifetime memory only (never persisted); the
  // backend re-verifies them on every request. Demo mode needs no key.
  // Member selection never grants anything — it only scopes the view.
  // Callbacks always fire exactly once as cb(ok).
  function askKeyDialog(kind, cb) {
    var isAdmin = kind === 'admin';
    var dlg = document.createElement('dialog');
    dlg.innerHTML = '<h3 style="margin-top:0">' + (isAdmin ? 'Admin key needed' : 'Edit key needed') + '</h3>' +
      '<p class="muted">' + (isAdmin
        ? 'Roster changes are restricted to authorized users.'
        : 'Saving is restricted to authorized editors.') +
      ' The key is used for this action only, kept in this tab\'s memory, and cleared on refresh — never stored.</p>' +
      '<div class="form"><label class="full">' + (isAdmin ? 'Admin key' : 'Edit key') + '<input id="kVal" type="password" autocomplete="off"></label></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn primary" id="kGo">Continue</button><button class="btn" id="kCancel">Cancel</button></div>';
    document.body.appendChild(dlg); dlg.showModal();
    var input = dlg.querySelector('#kVal');
    if (input) input.focus();
    dlg.querySelector('#kCancel').onclick = function () { dlg.close(); dlg.remove(); cb(false); };
    dlg.querySelector('#kGo').onclick = function () {
      var v = dlg.querySelector('#kVal').value;
      if (!v) { toast('Enter the key to continue, or cancel.'); return; }
      if (isAdmin) window.AppConfig.setAdminKey(v); else window.AppConfig.setEditKey(v);
      dlg.close(); dlg.remove(); cb(true);
    };
  }
  function requireLiveKey(cb) {
    if (window.Store.isDemo()) { cb(true); return; }
    if (!S.connected) { toast('Not connected to the live records — use Retry first.'); cb(false); return; }
    if (window.AppConfig.getEditKey()) { cb(true); return; }
    askKeyDialog('edit', cb);
  }
  function requireAdminKey(cb) {
    if (window.Store.isDemo()) { cb(true, ''); return; }
    if (!S.connected) { toast('Not connected to the live records — use Retry first.'); cb(false, ''); return; }
    var admin = window.AppConfig.getAdminKey();
    if (admin) { cb(true, admin); return; }
    askKeyDialog('admin', function (ok) { cb(ok, ok ? window.AppConfig.getAdminKey() : ''); });
  }

  function taskDialog(type, existing) {
    var t = existing || { task_type: type, owner_id: S.selectedMember !== 'ALL' ? S.selectedMember : '', priority: 'Medium', status: 'Not Started', completion_percent: 0 };
    // Stable client-generated id for new tasks: the backend rejects a repeated
    // task_id as DUPLICATE, so double-clicks/retries cannot create two tasks.
    var newId = existing ? existing.task_id : window.Store.uid('T');
    var dlg = document.createElement('dialog');
    dlg.innerHTML = '<h3 style="margin-top:0">' + (existing ? 'Edit task' : (type === 'PLANNED' ? 'Add planned task' : 'Quick-add unexpected work')) + '</h3>' +
      '<div class="form">' +
      '<label class="full">Title*<input id="dTitle" value="' + esc(t.title || '') + '"></label>' +
      '<label class="full">Description / expected output<textarea id="dDesc" rows="3">' + esc(t.description || '') + '</textarea></label>' +
      '<label>Owner<select id="dOwner">' + S.members.map(function (m) { return '<option value="' + esc(m.member_id) + '"' + (t.owner_id === m.member_id ? ' selected' : '') + '>' + esc(m.display_name) + '</option>'; }).join('') + '</select></label>' +
      '<label>Type<select id="dType"><option' + (t.task_type === 'PLANNED' ? ' selected' : '') + '>PLANNED</option><option' + (t.task_type === 'ADDITIONAL' ? ' selected' : '') + '>ADDITIONAL</option></select></label>' +
      '<label>Priority<select id="dPri">' + ['Low', 'Medium', 'High', 'Urgent'].map(function (p) { return '<option' + (t.priority === p ? ' selected' : '') + '>' + p + '</option>'; }).join('') + '</select></label>' +
      '<label>Status<select id="dStatus">' + ['Not Started', 'In Progress', 'Blocked', 'Completed', 'Cancelled'].map(function (p) { return '<option' + (t.status === p ? ' selected' : '') + '>' + p + '</option>'; }).join('') + '</select></label>' +
      '<label>Progress %<input id="dPct" type="number" min="0" max="100" value="' + esc(t.completion_percent || 0) + '"></label>' +
      '<label>Due date<input id="dDue" type="date" value="' + esc(String(t.current_due_at || '').slice(0, 10)) + '"></label>' +
      '<label>Est. minutes<input id="dEst" type="number" min="0" value="' + esc(t.estimated_minutes || '') + '"></label>' +
      '<label>Actual minutes<input id="dAct" type="number" min="0" value="' + esc(t.actual_minutes || '') + '"></label>' +
      '<label>Requested by<input id="dReq" value="' + esc(t.requested_by || '') + '"></label>' +
      '<label>Deadline-change reason<input id="dReason" placeholder="required if changing deadline"></label>' +
      '<label class="full">Blocker / impact notes<textarea id="dBlock" rows="2">' + esc(t.blocked_reason || t.impact_notes || '') + '</textarea></label>' +
      '<label class="full">Outcome note (required to complete)<input id="dOutcome" placeholder="deliverable or accomplishment"></label>' +
      '</div><div class="row" style="margin-top:12px"><button class="btn primary" id="dSave">Save</button><button class="btn" id="dCancel">Cancel</button></div>' +
      '<p class="muted">Completed requires 100% + completion timestamp + outcome note. Cancelled tasks are excluded from completion denominators.</p>';
    document.body.appendChild(dlg); dlg.showModal();
    dlg.querySelector('#dCancel').onclick = function () { dlg.close(); dlg.remove(); };
    dlg.querySelector('#dSave').onclick = function () {
      var payload = {
        task_id: newId,
        title: dlg.querySelector('#dTitle').value.trim(),
        description: dlg.querySelector('#dDesc').value,
        owner_id: dlg.querySelector('#dOwner').value,
        task_type: dlg.querySelector('#dType').value,
        priority: dlg.querySelector('#dPri').value,
        status: dlg.querySelector('#dStatus').value,
        completion_percent: Number(dlg.querySelector('#dPct').value || 0),
        current_due_at: dlg.querySelector('#dDue').value,
        original_due_at: existing ? existing.original_due_at : dlg.querySelector('#dDue').value,
        estimated_minutes: dlg.querySelector('#dEst').value,
        actual_minutes: dlg.querySelector('#dAct').value,
        requested_by: dlg.querySelector('#dReq').value,
        reason: dlg.querySelector('#dReason').value,
        blocked_reason: dlg.querySelector('#dBlock').value,
        outcome_note: dlg.querySelector('#dOutcome').value
      };
      if (!payload.title) { toast('Title is required.'); return; }
      if (payload.status === 'Completed') {
        payload.completion_percent = 100;
        if (!existing) payload.completed_at = new Date().toISOString();
        else if (!existing.completed_at) payload.completed_at = new Date().toISOString();
        if (!payload.outcome_note && !payload.blocked_reason) { toast('An outcome note is required to complete a task.'); return; }
        payload.impact_notes = payload.outcome_note || payload.blocked_reason;
      }
      dlg.querySelector('#dSave').disabled = true; // prevent double-submit; backend task_id guard is the backstop
      dlg.close(); dlg.remove();
      saveTask(payload, existing);
    };
  }

  function saveTask(payload, existing) {
    if (window.Store.isDemo()) {
      if (existing) Object.assign(existing, payload, { last_updated_at: new Date().toISOString() });
      else S.tasks.unshift(Object.assign({ task_id: window.Store.uid('T'), created_at: new Date().toISOString(), started_at: '', completed_at: '', original_due_at: payload.current_due_at || '', last_updated_at: new Date().toISOString(), archived_at: '', created_by: 'demo' }, payload));
      render(); toast('Saved (demo).');
      return;
    }
    requireLiveKey(function (ok) { if (!ok) return;
      setLoading(true, 'Saving…'); render();
      var call = existing
        ? window.Api.updateTask(Object.assign({ task_id: existing.task_id }, payload))
        : window.Api.createTask(Object.assign({ clientMutationId: window.Store.uid('M') }, payload));
      call.then(function () { return refreshLive(); })
        .then(function () { setLoading(false); render(); toast('Saved.'); })
        .catch(function (e) { setLoading(false); render(); fail(e); });
    });
  }

  function openTask(id) {
    var t = S.tasks.filter(function (x) { return x.task_id === id; })[0];
    if (!t) return;
    var dlg = document.createElement('dialog');
    var hist = S.updates.filter(function (u) { return u.task_id === id; });
    var logs = S.workLogs.filter(function (l) { return l.task_id === id; });
    dlg.innerHTML = '<h3 style="margin-top:0">' + esc(t.title) + '</h3>' +
      '<p class="muted">' + esc(t.task_type) + ' · ' + esc(t.status) + ' · ' + esc(t.completion_percent) + '% · Owner: ' + esc(memberName(t.owner_id)) +
      '<br>Due: ' + esc((t.current_due_at || t.original_due_at || '—')) + (t.original_due_at && t.current_due_at && t.original_due_at !== t.current_due_at ? ' (orig ' + esc(t.original_due_at) + ')' : '') +
      '<br>Est ' + esc(t.estimated_minutes === '' ? '—' : t.estimated_minutes + 'm') + ' · Act ' + esc(t.actual_minutes === '' ? '—' : t.actual_minutes + 'm') +
      (t.blocked_reason ? '<br>Blocker: ' + esc(t.blocked_reason) : '') + '</p>' +
      '<p>' + esc(t.description || '') + '</p>' +
      '<h4>Daily updates (' + hist.length + ')</h4>' +
      (hist.length ? hist.map(function (u) { return '<p class="muted">' + esc(u.update_date) + ': ' + esc(u.previous_percent) + '% → ' + esc(u.new_percent) + '% — ' + esc(u.accomplishment_notes || '') + '</p>'; }).join('') : '<p class="muted">No updates yet — history is preserved per day, never overwritten.</p>') +
      '<h4>Work logs (' + logs.length + ')</h4>' +
      (logs.length ? logs.map(function (l) { return '<p class="muted">' + esc(l.work_date) + ': ' + esc(l.minutes_spent) + 'm — ' + esc(l.notes || l.work_category || '') + '</p>'; }).join('') : '<p class="muted">No effort logged.</p>') +
      '<div class="row"><button class="btn primary" id="oUpdate">Add daily update</button>' +
      '<button class="btn" id="oLog">Log effort</button>' +
      '<button class="btn" id="oEdit">Edit</button>' +
      '<button class="btn danger" id="oDel">Archive</button>' +
      '<button class="btn" id="oClose">Close</button></div>' +
      '<p class="muted" id="oHist">Full server history (TaskEvents) loads in live mode.</p>';
    document.body.appendChild(dlg); dlg.showModal();
    dlg.querySelector('#oClose').onclick = function () { dlg.close(); dlg.remove(); };
    dlg.querySelector('#oEdit').onclick = function () { dlg.close(); dlg.remove(); taskDialog(t.task_type, t); };
    dlg.querySelector('#oUpdate').onclick = function () { dlg.close(); dlg.remove(); updateDialog(t); };
    dlg.querySelector('#oLog').onclick = function () { dlg.close(); dlg.remove(); logDialog(t); };
    dlg.querySelector('#oDel').onclick = function () {
      if (!confirm('Archive this task? Audit history is preserved.')) return;
      dlg.close(); dlg.remove(); archiveTask(t);
    };
    if (!window.Store.isDemo()) {
      window.Api.taskHistory(id).then(function (h) {
        var p = dlg.querySelector('#oHist');
        if (p) p.innerHTML = 'Server history: ' + h.events.length + ' event(s), ' + h.updates.length + ' update(s), ' + h.workLogs.length + ' log(s). ' +
          h.events.map(function (e) { return '<br>• ' + esc(e.event_type) + ': ' + esc(e.previous_value) + ' → ' + esc(e.new_value) + ' (' + esc(e.reason || 'no reason') + ')'; }).join('');
      }).catch(function () { /* keep silent, dialog already useful */ });
    }
  }

  function updateDialog(t) {
    var dlg = document.createElement('dialog');
    dlg.innerHTML = '<h3 style="margin-top:0">Daily update — ' + esc(t.title) + '</h3>' +
      '<p class="muted">Previous progress: ' + esc(t.completion_percent) + '%. You do not need to re-enter the description.</p>' +
      '<div class="form"><label>New progress %<input id="uPct" type="number" min="0" max="100" value="' + esc(t.completion_percent) + '"></label>' +
      '<label>Date<input id="uDate" type="date" value="' + new Date().toISOString().slice(0, 10) + '"></label>' +
      '<label class="full">Accomplishment notes<textarea id="uAcc" rows="3"></textarea></label>' +
      '<label class="full">Remaining work<input id="uRem"></label>' +
      '<label class="full">Blocker notes<input id="uBlo"></label>' +
      '<label class="full">Reason (required if reducing progress)<input id="uReason"></label></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn primary" id="uSave">Save update</button><button class="btn" id="uCancel">Cancel</button></div>';
    document.body.appendChild(dlg); dlg.showModal();
    dlg.querySelector('#uCancel').onclick = function () { dlg.close(); dlg.remove(); };
    dlg.querySelector('#uSave').onclick = function () {
      var p = {
        task_id: t.task_id, member_id: t.owner_id,
        new_percent: Number(dlg.querySelector('#uPct').value || 0),
        update_date: dlg.querySelector('#uDate').value,
        accomplishment_notes: dlg.querySelector('#uAcc').value,
        remaining_work: dlg.querySelector('#uRem').value,
        blocker_notes: dlg.querySelector('#uBlo').value,
        reason: dlg.querySelector('#uReason').value
      };
      dlg.querySelector('#uSave').disabled = true; // prevent double-submit
      dlg.close(); dlg.remove();
      if (window.Store.isDemo()) {
        S.updates.push(Object.assign({ update_id: window.Store.uid('U'), previous_percent: t.completion_percent, created_at: new Date().toISOString() }, p));
        t.completion_percent = p.new_percent;
        if (p.new_percent === 100) { t.status = 'Completed'; t.completed_at = new Date().toISOString(); }
        else if (t.status === 'Not Started' && p.new_percent > 0) t.status = 'In Progress';
        if (p.blocker_notes) t.blocked_reason = p.blocker_notes;
        render(); toast('Update saved (demo).');
        return;
      }
      requireLiveKey(function (ok) { if (!ok) return;
        setLoading(true, 'Saving update…'); render();
        window.Api.addDailyUpdate(p).then(function () { return refreshLive(); })
          .then(function () { setLoading(false); render(); toast('Update saved.'); })
          .catch(function (e) { setLoading(false); render(); fail(e); });
      });
    };
  }

  function logDialog(t) {
    var dlg = document.createElement('dialog');
    dlg.innerHTML = '<h3 style="margin-top:0">Log effort — ' + esc(t.title) + '</h3>' +
      '<div class="form"><label>Date<input id="lDate" type="date" value="' + new Date().toISOString().slice(0, 10) + '"></label>' +
      '<label>Minutes spent<input id="lMin" type="number" min="0" max="1440" placeholder="e.g. 90"></label>' +
      '<label>Start<input id="lStart" type="datetime-local"></label><label>End<input id="lEnd" type="datetime-local"></label>' +
      '<label>Category<input id="lCat" placeholder="e.g. Analysis, Urgent request"></label>' +
      '<label class="full">Notes<input id="lNotes"></label></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn primary" id="lSave">Save</button><button class="btn" id="lCancel">Cancel</button></div>' +
      '<p class="muted">Provide start/end or total minutes. Duplicate submissions are rejected by the server.</p>';
    document.body.appendChild(dlg); dlg.showModal();
    dlg.querySelector('#lCancel').onclick = function () { dlg.close(); dlg.remove(); };
    dlg.querySelector('#lSave').onclick = function () {
      var p = {
        task_id: t.task_id, member_id: t.owner_id, work_date: dlg.querySelector('#lDate').value,
        minutes_spent: dlg.querySelector('#lMin').value, start_time: dlg.querySelector('#lStart').value,
        end_time: dlg.querySelector('#lEnd').value, work_category: dlg.querySelector('#lCat').value,
        notes: dlg.querySelector('#lNotes').value, work_log_id: window.Store.uid('W')
      };
      dlg.querySelector('#lSave').disabled = true; // prevent double-submit; work_log_id guard is the backstop
      dlg.close(); dlg.remove();
      if (window.Store.isDemo()) {
        S.workLogs.push(Object.assign({ created_at: new Date().toISOString() }, p));
        t.actual_minutes = (Number(t.actual_minutes) || 0) + (Number(p.minutes_spent) || 0);
        render(); toast('Effort logged (demo).');
        return;
      }
      requireLiveKey(function (ok) { if (!ok) return;
        setLoading(true, 'Logging effort…'); render();
        window.Api.addWorkLog(p).then(function () { return refreshLive(); })
          .then(function () { setLoading(false); render(); toast('Effort logged.'); })
          .catch(function (e) { setLoading(false); render(); fail(e); });
      });
    };
  }

  function archiveTask(t) {
    if (window.Store.isDemo()) {
      t.archived_at = new Date().toISOString();
      render(); toast('Archived (demo).');
      return;
    }
    requireLiveKey(function (ok) { if (!ok) return;
      setLoading(true, 'Archiving…'); render();
      window.Api.archiveTask({ task_id: t.task_id, reason: 'archived from dashboard' })
        .then(function () { return refreshLive(); })
        .then(function () { setLoading(false); render(); toast('Archived.'); })
        .catch(function (e) { setLoading(false); render(); fail(e); });
    });
  }

  function impactDialog() {
    var opts = S.tasks.filter(function (t) { return !t.archived_at; })
      .map(function (t) { return '<option value="' + esc(t.task_id) + '">' + esc(t.title) + ' [' + esc(t.task_type) + ']</option>'; }).join('');
    var dlg = document.createElement('dialog');
    dlg.innerHTML = '<h3 style="margin-top:0">Link workload impact</h3><div class="form">' +
      '<label>Additional task<select id="iAdd">' + opts + '</select></label>' +
      '<label>Affected planned task<select id="iAff">' + opts + '</select></label>' +
      '<label>Impact<select id="iType">' + ['Delayed', 'Paused', 'Scope Changed', 'Dependency Affected', 'No Impact'].map(function (x) { return '<option>' + x + '</option>'; }).join('') + '</select></label>' +
      '<label>Actual delay (min)<input id="iDelay" type="number" min="0"></label>' +
      '<label class="full">Reason*<select id="iReason">' + ['Urgent supervisor request', 'System incident or troubleshooting', 'Administrative work or meetings', 'Missing requirements, data, or access', 'Waiting for approval', 'Dependency on another person or department', 'Scope change', 'Underestimated effort', 'Other documented reason'].map(function (x) { return '<option>' + x + '</option>'; }).join('') + '</select></label>' +
      '<label class="full">Evidence notes<textarea id="iEv" rows="3" placeholder="reference, dates, tickets…"></textarea></label></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn primary" id="iSave">Save link</button><button class="btn" id="iCancel">Cancel</button></div>';
    document.body.appendChild(dlg); dlg.showModal();
    dlg.querySelector('#iCancel').onclick = function () { dlg.close(); dlg.remove(); };
    dlg.querySelector('#iSave').onclick = function () {
      var p = {
        additional_task_id: dlg.querySelector('#iAdd').value, affected_task_id: dlg.querySelector('#iAff').value,
        impact_type: dlg.querySelector('#iType').value, actual_delay_minutes: dlg.querySelector('#iDelay').value,
        reason: dlg.querySelector('#iReason').value, evidence_notes: dlg.querySelector('#iEv').value
      };
      dlg.querySelector('#iSave').disabled = true; // prevent double-submit
      dlg.close(); dlg.remove();
      if (window.Store.isDemo()) {
        S.impacts.push(Object.assign({ impact_id: window.Store.uid('I'), estimated_delay_minutes: '', created_by: 'demo', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, p));
        render(); toast('Impact linked (demo).');
        return;
      }
      requireLiveKey(function (ok) { if (!ok) return;
        setLoading(true, 'Linking…'); render();
        window.Api.upsertImpact(p).then(function () { return refreshLive(); })
          .then(function () { setLoading(false); render(); toast('Impact linked.'); })
          .catch(function (e) { setLoading(false); render(); fail(e); });
      });
    };
  }

  function memberDialog() {
    var dlg = document.createElement('dialog');
    dlg.innerHTML = '<h3 style="margin-top:0">Add team member (admin)</h3><div class="form">' +
      '<label class="full">Display name*<input id="mName"></label>' +
      '<label class="full">Role<input id="mRole"></label></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn primary" id="mSave">Save</button><button class="btn" id="mCancel">Cancel</button></div>';
    document.body.appendChild(dlg); dlg.showModal();
    dlg.querySelector('#mCancel').onclick = function () { dlg.close(); dlg.remove(); };
    dlg.querySelector('#mSave').onclick = function () {
      var p = { display_name: dlg.querySelector('#mName').value.trim(), role: dlg.querySelector('#mRole').value, department: 'Academic Affairs' };
      if (!p.display_name) { toast('Name required.'); return; }
      dlg.close(); dlg.remove();
      if (window.Store.isDemo()) {
        S.members.push(Object.assign({ member_id: window.Store.uid('M'), is_active: 'TRUE', created_at: new Date().toISOString() }, p));
        render(); toast('Member added (demo).');
        return;
      }
      requireAdminKey(function (ok, admin) { if (!ok) return;
        setLoading(true, 'Saving member…'); render();
        window.Api.upsertMember(p, admin).then(function () { return refreshLive(); })
          .then(function () { setLoading(false); render(); toast('Member saved.'); })
          .catch(function (e) { setLoading(false); render(); fail(e); });
      });
    };
  }

  // ---------- reports ----------
  function reportContext() {
    var wt = weekTasks(S.tasks.filter(function (t) { return !t.archived_at; }));
    var mine = S.selectedMember === 'ALL' ? wt : wt.filter(function (t) { return t.owner_id === S.selectedMember; });
    var logs = weekLogs().filter(function (l) { return S.selectedMember === 'ALL' || l.member_id === S.selectedMember; });
    var planned = mine.filter(function (t) { return t.task_type === 'PLANNED' && t.status !== 'Cancelled'; });
    var additional = mine.filter(function (t) { return t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled'; });
    var completedThisWeek = mine.filter(function (t) { return t.status === 'Completed' && t.completed_at && R.inWeek(t.completed_at, S.weekStart); });
    var pending = mine.filter(function (t) { return t.status !== 'Completed' && t.status !== 'Cancelled'; });
    var now = new Date().toISOString();
    var overdue = pending.filter(function (t) { return R.isOverdue(t, now); });
    var blocked = mine.filter(function (t) { return t.status === 'Blocked'; });
    var needs = pending.filter(function (t) { return !t.blocked_reason && !t.impact_reason && !t.impact_notes; });
    var eff = logs.reduce(function (s, l) { return s + (Number(l.minutes_spent) || 0); }, 0);
    var e = new Date(S.weekStart + 'T00:00:00Z'); e.setUTCDate(e.getUTCDate() + 6);
    return {
      memberName: S.selectedMember === 'ALL' ? 'Academic Affairs Team' : memberName(S.selectedMember),
      weekStart: S.weekStart, weekEnd: e.toISOString().slice(0, 10),
      planned: planned, additional: additional, completedThisWeek: completedThisWeek,
      pending: pending, overdue: overdue, blocked: blocked, needsClarification: needs,
      effortMinutes: eff, impacts: S.impacts
    };
  }

  function genReport() {
    if (window.Store.isDemo()) {
      lastReport = R.buildReportText(reportContext());
      render(); toast('Report generated from recorded demo data.');
      return;
    }
    setLoading(true, 'Generating report…'); render();
    window.Api.weeklyReport({ week_start: S.weekStart, member_id: S.selectedMember })
      .then(function (r) { lastReport = r.text; setLoading(false); render(); toast('Report generated from server records.'); })
      .catch(function (e) { setLoading(false); render(); fail(e); });
  }

  function exportCsv() {
    var rows = S.tasks.filter(function (t) { return !t.archived_at; });
    var head = ['task_id', 'title', 'owner_id', 'task_type', 'status', 'completion_percent', 'priority', 'original_due_at', 'current_due_at', 'completed_at', 'estimated_minutes', 'actual_minutes', 'blocked_reason'];
    var esc2 = function (v) {
      var s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var csv = [head.join(',')].concat(rows.map(function (t) { return head.map(function (h) { return esc2(t[h]); }).join(','); })).join('\n');
    if (!window.Store.isDemo()) {
      window.Api.exportCsv({ sheet: 'Tasks' }).then(function (r) { download('tasks.csv', r.csv); toast('Exported ' + r.rowCount + ' rows from server.'); }).catch(fail);
      return;
    }
    download('tasks-demo.csv', csv);
    toast('CSV downloaded (demo data).');
  }

  function download(name, text) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function saveSnapshot() {
    setLoading(true, 'Saving snapshot…'); render();
    window.Api.createSnapshot({ week_start: S.weekStart, member_id: S.selectedMember })
      .then(function (s) { setLoading(false); render(); toast('Snapshot saved for ' + s.week_start + ' (' + s.member_id + ').'); })
      .catch(function (e) { setLoading(false); render(); fail(e); });
  }

  // ---------- config / connect ----------
  function saveConfig() {
    window.AppConfig.setApiBase($('cfgApi').value.trim());
    if ($('cfgEdit').value) window.AppConfig.setEditKey($('cfgEdit').value);
    if ($('cfgAdmin').value) window.AppConfig.setAdminKey($('cfgAdmin').value);
    connectLive();
  }
  function ping() {
    var api = $('cfgApi') ? $('cfgApi').value.trim() : window.AppConfig.getApiBase();
    if ($('cfgApi')) window.AppConfig.setApiBase(api);
    if (!api) { toast('Set the /exec URL first.'); return; }
    setLoading(true, 'Testing connection…'); render();
    window.Api.ping().then(function () { setLoading(false); S.error = ''; render(); toast('Connection OK.'); })
      .catch(function (e) { setLoading(false); render(); fail(e); });
  }
  function connectLive() {
    if (!window.AppConfig.getApiBase()) {
      S.connected = false;
      fail({ code: 'NOT_CONFIGURED', message: 'Live records address is not configured.' });
      render();
      return;
    }
    setLoading(true, 'Loading live records…'); render();
    window.Api.initLoad({ week_start: S.weekStart })
      .then(function (d) {
        window.Store.enterLive(d);
        // A remembered member that no longer exists falls back to whole team.
        if (S.selectedMember !== 'ALL' && !S.members.some(function (m) { return m.member_id === S.selectedMember; })) {
          S.selectedMember = 'ALL';
        }
        S.error = ''; S.errorKind = ''; setLoading(false); render();
      })
      // No demo fallback: a failed live load stays a visible error with Retry.
      .catch(function (e) { S.connected = false; setLoading(false); render(); fail(e); });
  }
  function refreshLive() {
    var warnings = [];
    return window.Api.initLoad({ week_start: S.weekStart }).then(function (d) {
      S.members = d.members || S.members;
      S.tasks = d.tasks || [];
      S.settings = d.settings || S.settings;
      return window.Api.listImpacts({}).then(function (im) { S.impacts = im || []; }).catch(function (e) { warnings.push('impacts: ' + ((e && e.message) || 'failed')); });
    }).then(function () {
      var p = S.selectedMember === 'ALL' ? {} : { member_id: S.selectedMember };
      return window.Api.listWorkLogs(p).then(function (w) { S.workLogs = w || []; }).catch(function (e) { warnings.push('work logs: ' + ((e && e.message) || 'failed')); });
    }).then(function () {
      var p = S.selectedMember === 'ALL' ? {} : { member_id: S.selectedMember };
      return window.Api.listDailyUpdates(p).then(function (u) { S.updates = u || []; }).catch(function (e) { warnings.push('daily updates: ' + ((e && e.message) || 'failed')); });
    }).then(function () {
      // Snapshots power the submitted / not-yet-submitted status line.
      return window.Api.listSnapshots({}).then(function (s) { S.snapshots = s || []; }).catch(function (e) { warnings.push('snapshots: ' + ((e && e.message) || 'failed')); });
    }).then(function () {
      // Partial refreshes must be visible: stale sub-lists alongside fresh tasks
      // would silently misstate effort and progress.
      S.error = warnings.length ? 'Partial refresh — showing fresh tasks but stale ' + warnings.join('; ') + '. Retry shortly.' : '';
    });
  }

  // ---------- boot ----------
  function boot() {
    // Restore harmless preferences (member + view only; week always current).
    // Live mode is the default: connect first, demo only by explicit action.
    var prefs = window.AppConfig.getPrefs();
    if (prefs.view === 'my' || prefs.view === 'additional' || prefs.view === 'team' || prefs.view === 'reports' || prefs.view === 'settings') {
      view = prefs.view;
    }
    if (prefs.memberId) S.selectedMember = prefs.memberId; // validated against the roster after load
    $('memberSelect').onchange = function (e) {
      S.selectedMember = e.target.value; submitResult = ''; lastReport = '';
      window.AppConfig.setPrefs({ memberId: S.selectedMember });
      render();
    };
    $('weekInput').value = S.weekStart;
    $('weekInput').onchange = function (e) {
      if (!e.target.value) return;
      S.weekStart = window.Store.monday(e.target.value);
      e.target.value = S.weekStart;
      submitResult = ''; lastReport = '';
      if (!window.Store.isDemo()) refreshLive().then(render).catch(function (err) { fail(err); });
      else render();
    };
    document.querySelectorAll('.nav button').forEach(function (b) {
      b.onclick = function () { view = b.dataset.view; window.AppConfig.setPrefs({ view: view }); render(); };
    });
    $('settingsLink').onclick = function () { view = 'settings'; window.AppConfig.setPrefs({ view: view }); render(); };
    connectLive();
  }

  window.App = { boot: boot, render: render };
  document.addEventListener('DOMContentLoaded', boot);
})();
