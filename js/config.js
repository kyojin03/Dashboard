/**
 * Frontend configuration — Academic Affairs Workload Dashboard.
 * The API URL is public (not a secret) and ships as the default below, so
 * the app opens directly in LIVE MODE with no per-browser configuration.
 * Resolution order:
 *   1. ?api= query parameter (per-link override, not persisted)
 *   2. localStorage 'aa_api_base' (manual override; no interface sets it)
 *   3. window.APP_CONFIG.API_BASE_URL default (deployed endpoint)
 * Base path support: all internal links are relative; API calls use absolute URL.
 *
 * Secrets: no keys are requested anywhere in the interface (open-write mode
 * since 2026-10-13). The holder below is retained unused for compatibility;
 * nothing is ever written to localStorage, sessionStorage, or any store.
 *
 * Preferences: only non-sensitive UI choices (member, view) persist, in
 * localStorage 'aa_prefs'. The reporting week always defaults to current.
 */
window.APP_CONFIG = Object.assign(
  {
    API_BASE_URL: 'https://script.google.com/macros/s/AKfycbz1AO3ntPEc-J9ujfn5NMdosq3zD35f28gMfHxKDZuEeu8cgCm7K_0VQrzysNRyI7U/exec',
    TIMEZONE: 'Asia/Manila',
    APP_NAME: 'Academic Affairs — Weekly Accomplishment Reporting'
  },
  window.APP_CONFIG || {}
);

(function () {
  function queryApi() {
    try {
      var u = new URL(window.location.href);
      return u.searchParams.get('api') || '';
    } catch (e) {
      return '';
    }
  }
  // Memory-only key holder. Deliberately NOT localStorage/sessionStorage:
  // persisting secrets there would expose them to any script on the page
  // across sessions. Page refresh clears these; the app re-asks at write
  // time instead of pretending a stored key is an identity.
  var keyCache = { edit: '', admin: '' };
  window.AppConfig = {
    getApiBase: function () {
      var q = queryApi();
      if (q) return q.replace(/\/$/, '');
      try {
        var s = localStorage.getItem('aa_api_base') || '';
        if (s) return s.replace(/\/$/, '');
      } catch (e) { /* storage unavailable */ }
      var d = (window.APP_CONFIG.API_BASE_URL || '').replace(/\/$/, '');
      return d;
    },
    setApiBase: function (url) {
      try {
        if (!url) localStorage.removeItem('aa_api_base');
        else localStorage.setItem('aa_api_base', url.replace(/\/$/, ''));
      } catch (e) { /* ignore */ }
    },
    getEditKey: function () {
      return keyCache.edit || '';
    },
    setEditKey: function (k) {
      keyCache.edit = k || '';
    },
    getAdminKey: function () {
      return keyCache.admin || '';
    },
    setAdminKey: function (k) {
      keyCache.admin = k || '';
    },
    clearKeys: function () {
      keyCache.edit = '';
      keyCache.admin = '';
    },
    getPrefs: function () {
      try {
        var raw = localStorage.getItem('aa_prefs');
        if (!raw) return {};
        var o = JSON.parse(raw);
        return (o && typeof o === 'object') ? o : {};
      } catch (e) { return {}; }
    },
    setPrefs: function (p) {
      try {
        var cur = {};
        try { cur = JSON.parse(localStorage.getItem('aa_prefs') || '{}') || {}; } catch (e2) { cur = {}; }
        if (p.memberId !== undefined) cur.memberId = p.memberId;
        if (p.view !== undefined) cur.view = p.view;
        localStorage.setItem('aa_prefs', JSON.stringify(cur));
      } catch (e) { /* preferences are best-effort only */ }
    }
  };
})();
