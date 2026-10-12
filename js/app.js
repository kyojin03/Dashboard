/* Main UI — views: My Dashboard (personal), Team Overview (management), Reports, Settings. */
(function () {
  var S = window.Store.state;
  var R = window.Reports;
  var view = 'my';
  var filters = { status: '', type: '', priority: '', q: '' };
  var lastReport = '';

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
    return tasks.filter(function (t) {
      return R.inWeek(t.created_at, S.weekStart) || R.inWeek(t.current_due_at || t.original_due_at, S.weekStart) ||
        R.inWeek(t.completed_at, S.weekStart) ||
        (String(t.created_at || '').slice(0, 10) < S.weekStart && t.status !== 'Completed' && t.status !== 'Cancelled');
    });
  }
  function weekLogs() {
    return S.workLogs.filter(function (l) { return R.inWeek(l.work_date || l.created_at, S.weekStart); });
  }

  // ---------- banner / header ----------
  function renderBanner() {
    var b = $('banner');
    var mode = window.Store.isDemo()
      ? '<strong>DEMO MODE</strong> — labeled sample data for evaluation. Not production data. Connect the API in Config for live data.'
      : '<strong>LIVE MODE</strong> — connected to the Apps Script backend. Edits require an edit key (session only, never stored in source).';
    var sel = S.selectedMember === 'ALL' ? 'Whole team' : esc(memberName(S.selectedMember));
    b.className = 'banner' + (window.Store.isDemo() ? ' demo' : '');
    b.innerHTML = mode + '<br><span class="muted">Viewing: <strong>' + sel + '</strong> · Week starting <strong>' + esc(S.weekStart) + '</strong> (Mon–Sun; working days Mon–Fri, Asia/Manila)</span>' +
      (S.error ? '<br><span style="color:#b3372f"><strong>Error:</strong> ' + esc(S.error) + '</span>' : '');
  }

  function renderMemberOptions() {
    var sel = $('memberSelect');
    sel.innerHTML = '<option value="ALL">Whole team (team dashboard)</option>' +
      S.members.map(function (m) {
        return '<option value="' + esc(m.member_id) + '"' + (S.selectedMember === m.member_id ? ' selected' : '') + '>' +
          esc(m.display_name) + ' — ' + esc(m.role) + '</option>';
      }).join('');
  }

  // ---------- summary cards ----------
  function cardsHTML(sum, ta) {
    function card(label, val, hint) {
      return '<div class="card"><h3>' + label + '</h3><div class="big">' + val + '</div><div class="hint">' + hint + '</div></div>';
    }
    return '<div class="grid cards">' +
      card('Planned tasks', sum.plannedCount, sum.plannedCompleted + ' completed') +
      card('Planned completion', R.fmtPct(sum.plannedCompletion), 'completed / eligible × 100; cancelled excluded') +
      card('Weighted completion', R.fmtPct(sum.weightedCompletion), sum.weightedExcluded + ' task(s) without estimates excluded') +
      card('Additional received', sum.additionalCount, sum.additionalCompleted + ' completed') +
      card('Additional effort', R.fmtH(sum.additionalEffortMinutes), 'actual minutes on additional work') +
      card('Overdue', sum.overdueCount, 'past current deadline, not completed/cancelled') +
      card('Blocked', sum.blockedCount, 'status = Blocked') +
      card('Turnaround (median)', ta.medianHours === null ? '—' : ta.medianHours + 'h', 'additional tasks; same-day ' + R.fmtPct(ta.sameDayRate)) +
      '</div><p class="kpi-def">Definitions: count completion = completed eligible ÷ total eligible × 100. Weighted = Σ(estimate × % ÷ 100) ÷ Σ(estimate) × 100. Overdue respects Asia/Manila calendar date. Same-day = completed on receipt date ÷ completed with timestamps (' + ta.sameDay + '/' + ta.sameDayDen + '). Incomplete timestamps are flagged, never invented.</p>';
  }

  // ---------- task table ----------
  function taskRows(tasks) {
    var f = filters;
    return tasks.filter(function (t) {
      if (f.status && t.status !== f.status) return false;
      if (f.type && t.task_type !== f.type) return false;
      if (f.priority && t.priority !== f.priority) return false;
      if (f.q && String(t.title + ' ' + (t.description || '')).toLowerCase().indexOf(f.q.toLowerCase()) === -1) return false;
      return true;
    });
  }
  function taskTable(tasks) {
    var rows = taskRows(tasks);
    if (!rows.length) return '<div class="empty">No tasks match. Add a planned task or quick-add unexpected work below.</div>';
    var h = '<div style="overflow-x:auto"><table><thead><tr><th>Task</th><th>Type</th><th>Owner</th><th>Status</th><th>Progress</th><th>Due</th><th>Effort</th><th></th></tr></thead><tbody>';
    rows.forEach(function (t) {
      var due = esc((t.current_due_at || t.original_due_at || '').slice(0, 10));
      var od = t.original_due_at && t.current_due_at && t.original_due_at !== t.current_due_at
        ? '<br><span class="muted">orig ' + esc(String(t.original_due_at).slice(0, 10)) + '</span>' : '';
      h += '<tr><td><strong>' + esc(t.title) + '</strong><br><span class="muted">' + esc((t.description || '').slice(0, 120)) + '</span></td>' +
        '<td><span class="pill ' + esc(t.task_type.toLowerCase()) + '">' + esc(t.task_type) + '</span></td>' +
        '<td>' + esc(memberName(t.owner_id)) + '</td>' +
        '<td><span class="pill ' + esc(t.status.toLowerCase().replace(/ /g, '')) + '">' + esc(t.status) + '</span>' +
        (t.status === 'Blocked' && t.blocked_reason ? '<br><span class="muted">' + esc(t.blocked_reason) + '</span>' : '') + '</td>' +
        '<td><div class="progress"><div style="width:' + Number(t.completion_percent || 0) + '%"></div></div><span class="muted">' + esc(t.completion_percent) + '%</span></td>' +
        '<td>' + due + od + '</td>' +
        '<td class="muted">est ' + esc(t.estimated_minutes === '' ? '—' : t.estimated_minutes) + 'm<br>act ' + esc(t.actual_minutes === '' ? '—' : t.actual_minutes) + 'm</td>' +
        '<td><button class="btn small" data-open="' + esc(t.task_id) + '">Open</button></td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  // ---------- personal dashboard ----------
  function ageDays(iso) {
    if (!iso) return null;
    var ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms) || ms < 0) return 0;
    return Math.round(ms / 86400000);
  }

  function myCards(sum, ot, ta) {
    function card(label, val, hint) {
      return '<div class="card"><h3>' + label + '</h3><div class="big">' + val + '</div><div class="hint">' + hint + '</div></div>';
    }
    return '<div class="grid cards">' +
      card('Task completion', R.fmtPct(sum.plannedCompletion), sum.plannedCompleted + ' of ' + sum.plannedCount + ' planned done') +
      card('Weighted completion', R.fmtPct(sum.weightedCompletion), sum.weightedExcluded + ' without estimates excluded') +
      card('On-time (original)', R.fmtPct(ot.original.percent), ot.original.onTime + ' of ' + ot.original.total + ' by original deadline') +
      card('On-time (current)', R.fmtPct(ot.current.percent), ot.current.onTime + ' of ' + ot.current.total + ' by approved deadline') +
      card('Additional work', sum.additionalCompleted + '/' + sum.additionalCount, R.fmtH(sum.additionalEffortMinutes) + ' actual effort') +
      card('Turnaround (median)', ta.medianHours === null ? '—' : ta.medianHours + 'h', 'same-day ' + R.fmtPct(ta.sameDayRate) + ' (' + ta.sameDay + '/' + ta.sameDayDen + ')') +
      card('Pending', sum.plannedCount - sum.plannedCompleted + sum.additionalCount - sum.additionalCompleted, 'open tasks needing work') +
      card('Blocked', sum.blockedCount, 'waiting on something else') +
      '</div><p class="kpi-def">No single number here is an efficiency score. Completion sits alongside on-time delivery, additional workload, turnaround, pending work, and blockers — read them together. Empty data shows —, never 0%.</p>';
  }

  function pendingPanel(wt) {
    var open = wt.filter(function (t) { return t.status !== 'Completed' && t.status !== 'Cancelled'; });
    var blocked = wt.filter(function (t) { return t.status === 'Blocked'; });
    var noReason = open.filter(function (t) { return !t.blocked_reason && !t.impact_reason && !t.impact_notes; });
    function row(t) {
      var due = (t.current_due_at || t.original_due_at || '').slice(0, 10) || 'no deadline';
      var age = ageDays(t.created_at);
      return '<tr><td><strong>' + esc(t.title) + '</strong> <span class="pill ' + esc(String(t.task_type).toLowerCase()) + '">' + esc(t.task_type) + '</span></td>' +
        '<td>' + esc(t.status) + ' · ' + esc(t.completion_percent) + '%</td>' +
        '<td>' + esc(due) + (t.original_due_at && t.current_due_at && t.original_due_at !== t.current_due_at ? '<br><span class="muted">was ' + esc(String(t.original_due_at).slice(0, 10)) + '</span>' : '') + '</td>' +
        '<td class="muted">' + (age === null ? '—' : age + 'd old') + '</td>' +
        '<td>' + esc(t.blocked_reason || t.impact_notes || '') + '</td>' +
        '<td><button class="btn small" data-open="' + esc(t.task_id) + '">Open</button></td></tr>';
    }
    var h = '<div class="panel"><h2>Pending work (' + open.length + ')</h2>';
    h += open.length ? '<div style="overflow-x:auto"><table><thead><tr><th>Task</th><th>Progress</th><th>Deadline</th><th>Age</th><th>Reason / notes</th><th></th></tr></thead><tbody>' +
      open.map(row).join('') + '</tbody></table></div>' : '<div class="empty">Nothing pending — nice. Add next week\'s planned tasks when ready.</div>';
    h += blocked.length ? '<h2 style="margin-top:14px">Blocked (' + blocked.length + ')</h2><ul>' +
      blocked.map(function (t) { return '<li><strong>' + esc(t.title) + '</strong> — ' + esc(t.blocked_reason || 'reason not recorded yet; open the task and add one.'); }).join('') + '</ul>' : '';
    h += noReason.length ? '<p class="muted">' + noReason.length + ' open task(s) still need a delay reason — flagged as requiring clarification in the weekly report.</p>' : '';
    return h + '</div>';
  }

  function vMy() {
    if (S.selectedMember === 'ALL') {
      return '<div class="panel"><h2>Whose work are you recording?</h2>' +
        '<p>Select your name at the top to open your personal dashboard — your tasks, your progress, your weekly report.</p>' +
        '<p class="muted">Selecting a name only chooses what to view. It does not prove who you are; saving still needs the edit key.</p></div>' +
        '<div class="panel"><h2>How it works</h2><ol>' +
        '<li>Add your <strong>planned tasks</strong> at the start of the week (title + deadline is enough).</li>' +
        '<li>During the week, <strong>quick-add unexpected work</strong> as additional tasks.</li>' +
        '<li>Update <strong>progress + accomplishments</strong> daily; log effort; note blockers.</li>' +
        '<li>Link extra work to any planned task it delayed, with a reason.</li>' +
        '<li>Generate your <strong>weekly accomplishment report</strong> from the records.</li></ol></div>';
    }
    var m = S.members.filter(function (x) { return x.member_id === S.selectedMember; })[0];
    var wt = weekTasks(scopedTasks());
    var sum = R.summarize(wt, weekLogs());
    var ot = R.onTimeCompletion(wt);
    var ta = R.turnaround(wt.filter(function (t) { return t.task_type === 'ADDITIONAL'; }));
    var daily = S.updates.filter(function (u) { return R.inWeek(u.update_date, S.weekStart) && u.member_id === S.selectedMember; });
    var h = '<div class="panel"><h2>' + esc(m ? m.display_name : S.selectedMember) + (m ? ' <span class="muted">· ' + esc(m.role) + '</span>' : '') + '</h2>' +
      '<p class="muted">Week of ' + esc(S.weekStart) + ' (Mon–Sun, Asia/Manila). Progress measures deliverables achieved, not time elapsed.</p></div>';
    h += myCards(sum, ot, ta);
    h += '<div class="panel"><h2>My tasks (' + wt.length + ' this week)</h2>' + filterBar() + taskTable(wt) + quickAddButtons() + '</div>';
    h += '<div class="panel"><h2>Daily accomplishments</h2>' + (daily.length ? '<table><thead><tr><th>Date</th><th>Task</th><th>Progress</th><th>What got done</th><th>Blockers</th></tr></thead><tbody>' +
      daily.map(function (u) {
        return '<tr><td>' + esc(u.update_date) + '</td><td>' + esc(taskTitle(u.task_id)) + '</td><td>' + esc(u.previous_percent) + '% → ' + esc(u.new_percent) + '%</td><td>' + esc(u.accomplishment_notes || '') + (u.remaining_work ? '<br><span class="muted">Next: ' + esc(u.remaining_work) + '</span>' : '') + '</td><td>' + esc(u.blocker_notes || '') + '</td></tr>';
      }).join('') + '</tbody></table>' : '<div class="empty">No updates yet this week. Open a task → “Add daily update” — it takes seconds and builds your weekly report.</div>') + '</div>';
    h += pendingPanel(wt);
    h += '<div class="panel"><h2>Extra work vs plan</h2><p class="muted">When additional work delays a planned task, link them with a reason — that link (not the hours alone) is what explains the delay.</p>' + impactList() +
      '<div class="row"><button class="btn primary" data-act="new-impact">+ Link extra work to affected plan</button></div></div>';
    return h;
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
  function vTeam() {
    var wt = weekTasks(S.tasks.filter(function (t) { return !t.archived_at; }));
    var sum = R.summarize(wt, weekLogs());
    var ta = R.turnaround(wt.filter(function (t) { return t.task_type === 'ADDITIONAL'; }));
    var rows = S.members.map(function (m) {
      var mt = wt.filter(function (t) { return t.owner_id === m.member_id; });
      var ml = S.workLogs.filter(function (l) { return l.member_id === m.member_id && R.inWeek(l.work_date || l.created_at, S.weekStart); });
      var s = R.summarize(mt, ml);
      var ot = R.onTimeCompletion(mt);
      var t2 = R.turnaround(mt.filter(function (t) { return t.task_type === 'ADDITIONAL'; }));
      var pending = mt.filter(function (t) { return t.status !== 'Completed' && t.status !== 'Cancelled'; }).length;
      return { m: m, s: s, ot: ot, t2: t2, pending: pending };
    });
    var h = '<div class="panel"><h2>Team overview <span class="muted">· read-only; members record via My Dashboard</span></h2>' +
      '<p class="muted">Roles differ, so people are never ranked on one number. Each row shows completion together with on-time delivery, extra work, effort, pending load, and blockers.</p></div>';
    h += cardsHTML(sum, ta);
    h += '<div class="panel"><h2>Individual summaries</h2><div style="overflow-x:auto"><table><thead><tr><th>Member</th><th>Planned done</th><th>On-time (orig)</th><th>Extra work</th><th>Effort (extra)</th><th>Turnaround</th><th>Pending</th><th>Blocked</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td><strong>' + esc(r.m.display_name) + '</strong><br><span class="muted">' + esc(r.m.role) + '</span></td>' +
          '<td>' + r.s.plannedCompleted + '/' + r.s.plannedCount + ' (' + R.fmtPct(r.s.plannedCompletion) + ')</td>' +
          '<td>' + R.fmtPct(r.ot.original.percent) + ' <span class="muted">' + r.ot.original.onTime + '/' + r.ot.original.total + '</span></td>' +
          '<td>' + r.s.additionalCompleted + '/' + r.s.additionalCount + '</td>' +
          '<td>' + R.fmtH(r.s.additionalEffortMinutes) + '</td>' +
          '<td>' + (r.t2.medianHours === null ? '—' : r.t2.medianHours + 'h') + '</td>' +
          '<td>' + r.pending + '</td><td>' + r.s.blockedCount + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    h += '<div class="panel"><h2>All tasks in scope (' + wt.length + ') — open for detail</h2>' + filterBar() + taskTable(wt) + '</div>';
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

  function filterBar() {
    return '<div class="filters">' +
      '<select id="fStatus"><option value="">All statuses</option>' + ['Not Started', 'In Progress', 'Blocked', 'Completed', 'Cancelled'].map(function (s) { return '<option' + (filters.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
      '<select id="fType"><option value="">Planned + Additional</option><option value="PLANNED"' + (filters.type === 'PLANNED' ? ' selected' : '') + '>Planned</option><option value="ADDITIONAL"' + (filters.type === 'ADDITIONAL' ? ' selected' : '') + '>Additional</option></select>' +
      '<select id="fPri"><option value="">All priorities</option>' + ['Low', 'Medium', 'High', 'Urgent'].map(function (s) { return '<option' + (filters.priority === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
      '<input id="fQ" placeholder="Search tasks…" value="' + esc(filters.q) + '">' +
      '</div>';
  }

  function quickAddButtons() {
    return '<div class="row" style="margin-top:10px"><button class="btn primary" data-act="new-planned">+ Add planned task</button>' +
      '<button class="btn" data-act="new-additional">+ Quick-add unexpected work</button></div>' +
      '<p class="muted">Quick-add needs only a title — details can be completed later. Progress measures deliverable achieved, not time elapsed.</p>';
  }

  function vReports() {
    return '<div class="panel"><h2>Weekly accomplishment report</h2>' +
      '<div class="row"><button class="btn primary" data-act="gen-report">Generate report</button>' +
      '<button class="btn" data-act="export-csv">Export tasks CSV</button>' +
      '<button class="btn" data-act="print">Print / Save PDF</button>' +
      (window.Store.isDemo() ? '' : '<button class="btn" data-act="snapshot">Save snapshot</button>') + '</div>' +
      '<p class="muted">Derived only from stored tasks, daily updates, work logs, and impact records. Incomplete tasks without explanations are flagged as requiring clarification. Review before export.</p>' +
      '<pre class="report" id="reportPre">' + esc(lastReport || 'Press “Generate report” to preview.') + '</pre></div>';
  }

  function vSettings() {
    var api = window.AppConfig.getApiBase();
    return '<div class="panel"><h2>Connection</h2>' +
      '<div class="form"><label class="full">Apps Script /exec URL<input id="cfgApi" value="' + esc(api) + '" placeholder="https://script.google.com/macros/s/…/exec"></label>' +
      '<label>Edit key (session only)<input id="cfgEdit" type="password" placeholder="required for saving in live mode"></label>' +
      '<label>Admin key (session only)<input id="cfgAdmin" type="password" placeholder="required for roster"></label></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn primary" data-act="save-config">Save & connect</button>' +
      '<button class="btn" data-act="use-demo">Use demo mode</button>' +
      '<button class="btn" data-act="ping">Test connection</button></div>' +
      '<p class="muted">Keys stay in this tab only and are never written into source files. Selecting a name does not identify anyone.</p>' +
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
    else if (view === 'team') h = vTeam();
    else if (view === 'reports') h = vReports();
    else if (view === 'settings') h = vSettings();
    else { view = 'my'; h = vMy(); }
    el.innerHTML = h;
    bindView();
  }

  function bindView() {
    var fs = $('fStatus'); if (fs) fs.onchange = function () { filters.status = fs.value; render(); };
    var ft = $('fType'); if (ft) ft.onchange = function () { filters.type = ft.value; render(); };
    var fp = $('fPri'); if (fp) fp.onchange = function () { filters.priority = fp.value; render(); };
    var fq = $('fQ'); if (fq) fq.oninput = function () { filters.q = fq.value; renderKeepFocus(); };
    document.querySelectorAll('[data-open]').forEach(function (b) { b.onclick = function () { openTask(b.dataset.open); }; });
    document.querySelectorAll('[data-act]').forEach(function (b) { b.onclick = function () { act(b.dataset.act); }; });
  }
  function renderKeepFocus() {
    var v = $('fQ') ? $('fQ').value : '';
    render();
    var q = $('fQ'); if (q) { q.focus(); q.setSelectionRange(v.length, v.length); }
  }

  // ---------- actions ----------
  function act(a) {
    if (a === 'new-planned') taskDialog('PLANNED');
    else if (a === 'new-additional') taskDialog('ADDITIONAL');
    else if (a === 'new-impact') impactDialog();
    else if (a === 'add-member') memberDialog();
    else if (a === 'gen-report') genReport();
    else if (a === 'export-csv') exportCsv();
    else if (a === 'print') window.print();
    else if (a === 'snapshot') saveSnapshot();
    else if (a === 'save-config') saveConfig();
    else if (a === 'use-demo') { window.Store.enterDemo(); S.error = ''; render(); toast('Demo mode enabled.'); }
    else if (a === 'ping') ping();
  }

  function requireLiveKey() {
    if (window.Store.isDemo()) return true;
    if (!window.AppConfig.getEditKey()) { toast('Enter the edit key in Settings first (saving is controlled, not open).'); view = 'settings'; render(); return false; }
    return true;
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
    if (!requireLiveKey()) return;
    setLoading(true, 'Saving…'); render();
    var call = existing
      ? window.Api.updateTask(Object.assign({ task_id: existing.task_id }, payload))
      : window.Api.createTask(Object.assign({ clientMutationId: window.Store.uid('M') }, payload));
    call.then(function () { return refreshLive(); })
      .then(function () { setLoading(false); render(); toast('Saved.'); })
      .catch(function (e) { setLoading(false); render(); fail(e); });
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
      if (!requireLiveKey()) return;
      setLoading(true, 'Saving update…'); render();
      window.Api.addDailyUpdate(p).then(function () { return refreshLive(); })
        .then(function () { setLoading(false); render(); toast('Update saved.'); })
        .catch(function (e) { setLoading(false); render(); fail(e); });
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
      if (!requireLiveKey()) return;
      setLoading(true, 'Logging effort…'); render();
      window.Api.addWorkLog(p).then(function () { return refreshLive(); })
        .then(function () { setLoading(false); render(); toast('Effort logged.'); })
        .catch(function (e) { setLoading(false); render(); fail(e); });
    };
  }

  function archiveTask(t) {
    if (window.Store.isDemo()) {
      t.archived_at = new Date().toISOString();
      render(); toast('Archived (demo).');
      return;
    }
    if (!requireLiveKey()) return;
    setLoading(true, 'Archiving…'); render();
    window.Api.archiveTask({ task_id: t.task_id, reason: 'archived from dashboard' })
      .then(function () { return refreshLive(); })
      .then(function () { setLoading(false); render(); toast('Archived.'); })
      .catch(function (e) { setLoading(false); render(); fail(e); });
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
      if (!requireLiveKey()) return;
      setLoading(true, 'Linking…'); render();
      window.Api.upsertImpact(p).then(function () { return refreshLive(); })
        .then(function () { setLoading(false); render(); toast('Impact linked.'); })
        .catch(function (e) { setLoading(false); render(); fail(e); });
    };
  }

  function memberDialog() {
    var admin = window.AppConfig.getAdminKey();
    if (!window.Store.isDemo() && !admin) { toast('Admin key required — enter it in Settings.'); view = 'settings'; render(); return; }
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
      setLoading(true, 'Saving member…'); render();
      window.Api.upsertMember(p, admin).then(function () { return refreshLive(); })
        .then(function () { setLoading(false); render(); toast('Member saved.'); })
        .catch(function (e) { setLoading(false); render(); fail(e); });
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
    if (!window.AppConfig.getApiBase()) { window.Store.enterDemo(); render(); return; }
    setLoading(true, 'Connecting to backend…'); render();
    window.Api.initLoad({ week_start: S.weekStart })
      .then(function (d) { window.Store.enterLive(d); S.error = ''; setLoading(false); render(); toast('Connected to live backend.'); })
      .catch(function (e) { setLoading(false); window.Store.enterDemo(); render(); fail(e); });
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
      // Partial refreshes must be visible: stale sub-lists alongside fresh tasks
      // would silently misstate effort and progress.
      S.error = warnings.length ? 'Partial refresh — showing fresh tasks but stale ' + warnings.join('; ') + '. Retry shortly.' : '';
    });
  }

  // ---------- boot ----------
  function boot() {
    window.Store.enterDemo();
    $('memberSelect').onchange = function (e) { S.selectedMember = e.target.value; render(); };
    $('weekInput').value = S.weekStart;
    $('weekInput').onchange = function (e) {
      if (!e.target.value) return;
      S.weekStart = window.Store.monday(e.target.value);
      e.target.value = S.weekStart;
      if (!window.Store.isDemo()) refreshLive().then(render).catch(function (err) { fail(err); });
      else render();
    };
    document.querySelectorAll('.nav button').forEach(function (b) { b.onclick = function () { view = b.dataset.view; render(); }; });
    // Auto-connect if an API URL was previously saved
    if (window.AppConfig.getApiBase()) connectLive();
    else render();
  }

  window.App = { boot: boot, render: render };
  document.addEventListener('DOMContentLoaded', boot);
})();
