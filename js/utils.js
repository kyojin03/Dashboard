/**
 * Shared utilities (loaded before app.js; no DOM side effects on load).
 * Single home for escaping, tiny DOM access, Manila date handling, and
 * debounce — so views, reports, and tests share one implementation.
 * window.Utils is intentionally global: the frontend ships without a
 * bundler or framework.
 */
(function () {
  /** Escape any value for safe interpolation into HTML strings. */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function el(id) { return document.getElementById(id); }

  /** Manila calendar date (YYYY-MM-DD) for ANY input: date-only passes
   *  through untouched; full timestamps convert in Asia/Manila. */
  function manilaDay(v) {
    if (v === null || v === undefined || v === '') return '';
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(v));
    } catch (e) {
      return String(v).slice(0, 10);
    }
  }

  /** Today in Manila (for date-input defaults). */
  function todayKey() { return manilaDay(new Date().toISOString()); }

  /** Leading-edge debounce for auto-saves: first call runs now, repeats wait. */
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) return;
      fn.apply(self, args);
      t = setTimeout(function () { t = null; }, ms || 800);
    };
  }

  window.Utils = { esc: esc, el: el, manilaDay: manilaDay, todayKey: todayKey, debounce: debounce };
})();
