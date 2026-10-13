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
