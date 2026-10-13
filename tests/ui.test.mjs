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
