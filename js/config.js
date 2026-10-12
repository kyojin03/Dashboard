/**
 * Frontend configuration — Academic Affairs Workload Dashboard.
 * The API URL is NEVER hardcoded with secrets. It resolves in this order:
 *   1. ?api= query parameter (per-link override, not persisted)
 *   2. localStorage 'aa_api_base' (set on the Config screen)
 *   3. window.APP_CONFIG.API_BASE_URL default below (deploy maintainer edits this)
 * Base path support: all internal links are relative; API calls use absolute URL.
 */
window.APP_CONFIG = Object.assign(
  {
    API_BASE_URL: '', // e.g. 'https://script.google.com/macros/s/AKfyc.../exec'
    TIMEZONE: 'Asia/Manila',
    APP_NAME: 'Academic Affairs — Workload Analytics',
    DEMO_MODE_DEFAULT: true // explicit, labeled demo until a real API is configured
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
      try { return sessionStorage.getItem('aa_edit_key') || ''; } catch (e) { return ''; }
    },
    setEditKey: function (k) {
      try {
        if (!k) sessionStorage.removeItem('aa_edit_key');
        else sessionStorage.setItem('aa_edit_key', k);
      } catch (e) { /* ignore */ }
    },
    getAdminKey: function () {
      try { return sessionStorage.getItem('aa_admin_key') || ''; } catch (e) { return ''; }
    },
    setAdminKey: function (k) {
      try {
        if (!k) sessionStorage.removeItem('aa_admin_key');
        else sessionStorage.setItem('aa_admin_key', k);
      } catch (e) { /* ignore */ }
    }
  };
})();
