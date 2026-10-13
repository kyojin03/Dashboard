/**
 * UI wiring consistency tests (static guards, no browser needed).
 * Every button the markup renders must have a handler; every nav target must
 * have a render branch; every static element id referenced must exist; demo
 * mode must stay explicitly labeled so sample data is never mistaken for
 * real records.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appJs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

describe('live-first startup (no silent demo fallback)', () => {
  function fnBody(src, name) {
    const start = src.indexOf('function ' + name);
    assert.ok(start !== -1, name + ' must exist');
    const next = src.indexOf('\n  function ', start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  }
  it('failed live connects never fall back to demo data', () => {
    const body = fnBody(appJs, 'connectLive');
    assert.doesNotMatch(body, /enterDemo/);
    assert.match(body, /S\.connected = false/);
  });
  it('demo activates only through the explicit demo action', () => {
    const uses = [...appJs.matchAll(/\.enterDemo\(\)/g)].length;
    assert.equal(uses, 1, 'enterDemo must have exactly one caller (use-demo), found ' + uses);
    assert.ok(appJs.includes("a === 'use-demo'"));
  });
  it('write gates ask for the key instead of redirecting to settings', () => {
    assert.ok(appJs.includes('function askKeyDialog(kind, cb)'));
    assert.ok(appJs.includes("a === 'retry'"));
    assert.ok(appJs.includes("a === 'forget-keys'"));
    assert.ok(!/Enter the edit key in Settings first/.test(appJs), 'old settings-redirect prompt must be gone');
    assert.ok(!/Admin key required — enter it in Settings/.test(appJs), 'old admin-redirect prompt must be gone');
  });
  it('boot restores prefs and always connects live first', () => {
    const body = fnBody(appJs, 'boot');
    assert.match(body, /getPrefs/);
    assert.match(body, /setPrefs/);
    assert.match(body, /connectLive\(\);/);
    assert.doesNotMatch(body, /enterDemo/);
  });
});

describe('UI wiring consistency', () => {
  it('every data-act button has a handler branch in act()', () => {
    const acts = [...new Set([...appJs.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]))];
    assert.ok(acts.length >= 10, 'expected a full set of actions, found ' + acts.length);
    for (const a of acts) {
      assert.ok(appJs.includes(`a === '${a}'`), `no handler branch for data-act="${a}"`);
    }
  });
  it('every nav data-view (and settings link) has a render branch', () => {
    const views = [...indexHtml.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...views].sort(), ['additional', 'my', 'reports', 'team']);
    for (const v of views) {
      assert.ok(appJs.includes(`view === '${v}'`), `no render branch for view "${v}"`);
    }
    assert.ok(indexHtml.includes('id="settingsLink"'), 'secondary settings entry must exist');
    assert.ok(appJs.includes("view = 'settings'"), 'settings view must be reachable');
  });
  it('static element ids referenced by the app exist in index.html', () => {
    for (const id of ['memberSelect', 'weekInput', 'settingsLink', 'banner', 'loading', 'view', 'toasts']) {
      assert.ok(indexHtml.includes(`id="${id}"`), `missing element #${id} in index.html`);
    }
  });
  it('demo mode stays explicitly labeled (sample data never presented as real)', () => {
    assert.match(appJs, /DEMO MODE/);
    assert.match(appJs, /Not production data/);
  });
  it('roster display names are untouched', () => {
    const storeJs = fs.readFileSync(path.join(ROOT, 'js/store.js'), 'utf8');
    for (const name of ['Michelle Ann F. Pablo', 'Michelle M. Macatangay', 'Divina G. Asuncion',
      'Kathlyn Kate N. Mauricio', 'Juhayna M. Sultan', 'Catherine M. Madriaga',
      'Jemima P. Sarmiento', 'Piolo B. Bernardino', 'Perly S. Saldivar',
      'Rhea Duremdes', 'Jerome Balbuena']) {
      assert.ok(storeJs.includes(name), 'roster name missing: ' + name);
    }
  });
});

describe('premium redesign guards', () => {
  const css = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  it('Esc-dismissed dialogs clean up instead of lingering', () => {
    assert.ok(appJs.includes("addEventListener('close'"), 'missing dialog close-cleanup listener');
  });
  it('member + key dialogs guard against double submit', () => {
    assert.ok(appJs.includes("querySelector('#mSave').disabled = true"));
    assert.ok(appJs.includes("querySelector('#kGo').disabled = true"));
  });
  it('nav uses short labels with icons; settings stays secondary', () => {
    assert.ok(html.includes('<svg viewBox="0 0 24 24"'), 'nav icons missing');
    assert.ok(!/data-view="settings"/.test(html), 'settings must not be a main nav item');
    assert.ok(html.includes('id="settingsLink"'));
  });
  it('mobile bottom tab bar with safe-area room exists', () => {
    assert.ok(css.includes('safe-area-inset-bottom'), 'safe-area handling missing');
    assert.ok(/\.nav\s*\{[^}]*position:\s*fixed/.test(css), 'fixed bottom nav missing');
  });
  it('impact list renders as cards, not a dense table', () => {
    assert.doesNotMatch(appJs, /<table><thead><tr><th>Additional task/);
  });
  it('saved-weeks browser + snapshot viewer are wired', () => {
    assert.ok(appJs.includes('function viewSnapshot(weekStart, memberId)'));
    assert.ok(appJs.includes('data-snap='));
    assert.ok(appJs.includes('Saved weeks'));
  });
  it('My Week header shows member + full week range', () => {
    assert.ok(appJs.includes('function weekEndOf(weekStart)'));
    assert.ok(appJs.includes('My Week</p><h2>') || appJs.includes('>My Week</p>'));
  });
});
