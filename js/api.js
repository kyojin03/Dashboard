/**
 * API client v2 — single-request wrapper around the Apps Script JSON API.
 * - fetch() against the /exec endpoint only (never google.script.run).
 * - POST bodies as text/plain (no CORS preflight); GET for read actions.
 * - Envelope { ok:true, v, data } / { ok:false, v, error:{code,message} }
 *   (`v` is informational only and never gates behavior).
 * - Timeout per attempt, retry with backoff on BUSY + network errors only.
 *   POSTs are retried because every write carries a client-stable idempotency
 *   id (task_id / update_id / work_log_id / impact pair / week+member) and the
 *   server rejects repeats as DUPLICATE instead of double-applying.
 * - Optional Google ID token (memory-only, when GIS is enabled) is sent as
 *   `idToken` on every request; absent in open mode.
 * - Failures reject with { code, message, kind } so the UI can show an
 *   explicit error state. Never falls back to cached data silently.
 */
(function () {
  var RETRY = { attempts: 4, baseMs: 800, timeoutMs: 25000 };

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function base() {
    var b = window.AppConfig.getApiBase();
    if (!b) throw { code: 'NOT_CONFIGURED', message: 'Live records address is not configured. The API URL is fixed in js/config.js.' };
    return b;
  }

  function idToken() {
    try {
      return (window.AppConfig.getIdToken && window.AppConfig.getIdToken()) || '';
    } catch (e) { return ''; }
  }

  // 'auth' → ask for sign-in/key; 'connection' → retryable/offline;
  // 'other' → show the message, no retry, no prompt.
  function errorKind(err) {
    var code = (err && err.code) || '';
    if (code === 'FORBIDDEN' || code === 'UNAUTHENTICATED') return 'auth';
    if (code === 'NOT_CONFIGURED') {
      return /EDIT_KEY|ADMIN_KEY/i.test((err && err.message) || '') ? 'auth' : 'connection';
    }
    if (code === 'BAD_RESPONSE' || code === 'UNKNOWN' || code === '') return 'connection';
    return 'other';
  }

  // One clear sentence per server code; server text is kept when already clear.
  function errorMessage(err) {
    var code = (err && err.code) || '';
    var server = (err && err.message) || '';
    switch (code) {
      case 'VALIDATION': return server || 'Check the highlighted fields and try again.';
      case 'DUPLICATE': return 'Already saved — a duplicate was ignored, nothing was lost.';
      case 'NOT_FOUND': return 'Not found. It may have been deleted or archived.';
      case 'CONFLICT': return 'Changed by someone else just now. Fresh data was loaded — review and try again.';
      case 'BUSY': return 'Server is busy. Please wait a few seconds and retry.';
      case 'FORBIDDEN': return server || 'You are not allowed to do that.';
      case 'UNAUTHENTICATED': return 'Sign-in required. Sign in and try again.';
      case 'SERVER_CONFIG': return 'Server is misconfigured. Tell the administrator: ' + server;
      case 'INTERNAL': return 'Unexpected server error. Check the Apps Script execution logs.';
      case 'METHOD_NOT_ALLOWED': return server || 'That action needs a different request.';
      case 'BAD_REQUEST': return server || 'The request was malformed.';
      case 'BAD_RESPONSE': return 'Server returned a non-JSON response (often a login page). Check the deployment sharing setting.';
      case 'NOT_CONFIGURED': return server || 'The app is not configured.';
      case 'TIMEOUT': return 'The request timed out. Check your connection and retry.';
      default: return server || 'Request failed.';
    }
  }

  function parse(res) {
    return res.text().then(function (txt) {
      var obj;
      try { obj = JSON.parse(txt); }
      catch (e) { throw { code: 'BAD_RESPONSE', message: 'Server returned a non-JSON response.' }; }
      if (!obj || typeof obj !== 'object') throw { code: 'BAD_RESPONSE', message: 'Server returned an unexpected response.' };
      if (!obj.ok) {
        var err = obj.error || { code: 'UNKNOWN', message: 'Request failed.' };
        err.message = errorMessage(err);
        err.kind = errorKind(err);
        throw err;
      }
      return obj.data;
    });
  }

  function shouldRetry(err) {
    var code = err && err.code;
    return code === 'BUSY' || !code;
  }

  function request(action, payload, opts) {
    opts = opts || {};
    var attempts = opts.retries !== undefined ? opts.retries : RETRY.attempts;
    var timeoutMs = opts.timeoutMs || RETRY.timeoutMs;
    var isGet = !!opts.get;
    function attempt(n) {
      var ctrl = null, timer = null;
      try {
        if (typeof AbortController !== 'undefined') {
          ctrl = new AbortController();
          timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
        }
      } catch (e) { ctrl = null; }
      var task;
      if (isGet) {
        var url = base() + '?action=' + encodeURIComponent(action);
        var p = payload || {};
        if (Object.keys(p).length) url += '&payload=' + encodeURIComponent(JSON.stringify(p));
        var tok = idToken();
        if (tok) url += '&idToken=' + encodeURIComponent(tok);
        task = fetch(url, { method: 'GET', signal: ctrl ? ctrl.signal : undefined });
      } else {
        var body = { action: action, payload: payload || {} };
        var tok2 = idToken();
        if (tok2) body.idToken = tok2;
        task = fetch(base(), {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids GAS CORS preflight issues
          body: JSON.stringify(body),
          signal: ctrl ? ctrl.signal : undefined
        });
      }
      return task.then(function (res) {
        if (timer) clearTimeout(timer);
        return parse(res);
      }).catch(function (err) {
        if (timer) clearTimeout(timer);
        if (err && err.name === 'AbortError') err = { code: 'TIMEOUT', message: 'The request timed out.' };
        if (err && !err.kind) err.kind = errorKind(err);
        if (n < attempts && shouldRetry(err)) {
          return sleep(RETRY.baseMs * Math.pow(2, n - 1)).then(function () { return attempt(n + 1); });
        }
        throw err;
      });
    }
    return attempt(1);
  }

  function get(action, payload, opts) {
    return request(action, payload, Object.assign({ get: true }, opts));
  }

  function post(action, payload, opts) {
    return request(action, payload, opts);
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
    restoreTask: function (p) { return post('restoreTask', p); },
    deleteTask: function (p) { return post('deleteTask', p); },
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
    errorKind: errorKind,
    errorMessage: errorMessage,
    retry: RETRY
  };
})();
