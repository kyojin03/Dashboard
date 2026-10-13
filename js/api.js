/**
 * API client — separation layer between UI and the Apps Script JSON API.
 * - Uses fetch() against the /exec endpoint only (never google.script.run).
 * - Consistent JSON envelope: { ok:true, data } or { ok:false, error:{code,message} }.
 * - Never silently falls back to localStorage on server failure: failures
 *   reject so the UI can show an explicit error state.
 */
(function () {
  function base() {
    var b = window.AppConfig.getApiBase();
    if (!b) throw { code: 'NOT_CONFIGURED', message: 'API endpoint is not configured. Open Config and set the Apps Script /exec URL, or use Demo mode.' };
    return b;
  }

  function get(action, payload) {
    var url = base() + '?action=' + encodeURIComponent(action);
    if (payload && Object.keys(payload).length) {
      url += '&payload=' + encodeURIComponent(JSON.stringify(payload));
    }
    return fetch(url, { method: 'GET' }).then(parse);
  }

  function post(action, payload, opts) {
    opts = opts || {};
    var body = {
      action: action,
      payload: payload || {},
      key: opts.editKey !== undefined ? opts.editKey : window.AppConfig.getEditKey(),
      adminKey: opts.adminKey !== undefined ? opts.adminKey : window.AppConfig.getAdminKey()
    };
    return fetch(base(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids GAS CORS preflight issues
      body: JSON.stringify(body)
    }).then(parse);
  }

  function parse(res) {
    return res.text().then(function (txt) {
      var obj;
      try { obj = JSON.parse(txt); }
      catch (e) { throw { code: 'BAD_RESPONSE', message: 'Server returned a non-JSON response.' }; }
      if (!obj.ok) throw obj.error || { code: 'UNKNOWN', message: 'Request failed.' };
      return obj.data;
    });
  }

  // Classify failures so the UI can tell "can't reach the API" (retryable)
  // apart from "key rejected" (needs the key prompt). Transport errors carry
  // no code at all and count as connection failures.
  function errorKind(err) {
    var code = (err && err.code) || '';
    if (code === 'FORBIDDEN') return 'auth';
    if (code === 'NOT_CONFIGURED') {
      return /EDIT_KEY|ADMIN_KEY/i.test((err && err.message) || '') ? 'auth' : 'connection';
    }
    if (code === 'BAD_RESPONSE' || code === 'UNKNOWN' || code === '') return 'connection';
    return 'other';
  }

  window.Api = {
    ping: function () { return get('ping'); },
    initLoad: function (p) { return get('initLoad', p || {}); },
    listMembers: function () { return get('listMembers'); },
    upsertMember: function (p, adminKey) { return post('upsertMember', p, { adminKey: adminKey }); },
    listTasks: function (p) { return get('listTasks', p || {}); },
    createTask: function (p) { return post('createTask', p); },
    updateTask: function (p) { return post('updateTask', p); },
    archiveTask: function (p) { return post('archiveTask', p); },
    addDailyUpdate: function (p) { return post('addDailyUpdate', p); },
    listDailyUpdates: function (p) { return get('listDailyUpdates', p || {}); },
    addWorkLog: function (p) { return post('addWorkLog', p); },
    listWorkLogs: function (p) { return get('listWorkLogs', p || {}); },
    taskHistory: function (taskId) { return get('taskHistory', { task_id: taskId }); },
    upsertImpact: function (p) { return post('upsertImpact', p); },
    listImpacts: function (p) { return get('listImpacts', p || {}); },
    teamAnalytics: function (p) { return get('teamAnalytics', p || {}); },
    weeklyReport: function (p) { return get('weeklyReport', p || {}); },
    createSnapshot: function (p) { return post('createSnapshot', p); },
    listSnapshots: function (p) { return get('listSnapshots', p || {}); },
    exportCsv: function (p) { return get('exportCsv', p || {}); },
    getSettings: function () { return get('getSettings'); },
    saveSettings: function (p, adminKey) { return post('saveSettings', p, { adminKey: adminKey }); },
    isConfigured: function () { return !!window.AppConfig.getApiBase(); },
    errorKind: errorKind
  };
})();
