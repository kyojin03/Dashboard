/**
 * Startup configuration tests (js/config.js loaded via vm with stubbed
 * storage/location). Pins: live default URL with override priority, keys
 * held in page-lifetime memory only (never Web Storage), non-sensitive
 * preference persistence, and a clean slate on "reload" (fresh vm load).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_SRC = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
const EXPECTED_API = 'https://script.google.com/macros/s/AKfycbz1AO3ntPEc-J9ujfn5NMdosq3zD35f28gMfHxKDZuEeu8cgCm7K_0VQrzysNRyI7U/exec';

function loadConfig({ queryApi = '', storedUrl = undefined, storedPrefs = undefined } = {}) {
  const ls = {};
  if (storedUrl !== undefined) ls.aa_api_base = storedUrl;
  if (storedPrefs !== undefined) ls.aa_prefs = storedPrefs;
  const sandbox = {
    window: { location: { href: 'https://test.invalid/' } },
    console,
    localStorage: {
      getItem: (k) => (k in ls ? ls[k] : null),
      setItem: (k, v) => { ls[k] = String(v); },
      removeItem: (k) => { delete ls[k]; }
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => { throw new Error('keys must never touch Web Storage'); },
      removeItem: () => {}
    },
    URL,
    __queryApi: queryApi,
    __store: ls
  };
  // Route the ?api= lookup through the stubbed query value.
  const src = CONFIG_SRC.replace(
    "return u.searchParams.get('api') || '';",
    'return globalThis.__queryApi || "";'
  );
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'js/config.js' });
  return { AppConfig: sandbox.window.AppConfig, store: ls };
}

describe('automatic live startup', () => {
  it('defaults to the deployed /exec URL with no configuration', () => {
    const { AppConfig } = loadConfig();
    assert.equal(AppConfig.getApiBase(), EXPECTED_API);
  });
  it('override priority: ?api= beats stored URL beats default', () => {
    assert.equal(loadConfig({ storedUrl: 'https://stored.invalid/exec' }).AppConfig.getApiBase(), 'https://stored.invalid/exec');
    assert.equal(
      loadConfig({ queryApi: 'https://link.invalid/exec', storedUrl: 'https://stored.invalid/exec' }).AppConfig.getApiBase(),
      'https://link.invalid/exec');
  });
  it('trailing slashes are normalized', () => {
    assert.equal(loadConfig({ storedUrl: 'https://stored.invalid/exec/' }).AppConfig.getApiBase(), 'https://stored.invalid/exec');
  });
});

describe('keys are memory-only (never persisted)', () => {
  it('set/get works within the page lifetime', () => {
    const { AppConfig } = loadConfig();
    assert.equal(AppConfig.getEditKey(), '');
    AppConfig.setEditKey('EK-1');
    AppConfig.setAdminKey('AK-1');
    assert.equal(AppConfig.getEditKey(), 'EK-1');
    assert.equal(AppConfig.getAdminKey(), 'AK-1');
    AppConfig.clearKeys();
    assert.equal(AppConfig.getEditKey(), '');
    assert.equal(AppConfig.getAdminKey(), '');
  });
  it('keys never reach localStorage or sessionStorage', () => {
    const { AppConfig, store } = loadConfig();
    AppConfig.setEditKey('EK-SECRET');
    AppConfig.setAdminKey('AK-SECRET');
    assert.deepEqual(store, {});
  });
  it('a fresh load ("refresh") starts with empty keys', () => {
    loadConfig().AppConfig.setEditKey('EK-1');
    assert.equal(loadConfig().AppConfig.getEditKey(), '');
  });
  it('source makes no persisted-key storage calls', () => {
    assert.doesNotMatch(CONFIG_SRC, /sessionStorage\s*\./);
    assert.doesNotMatch(CONFIG_SRC, /aa_edit_key/);
    assert.doesNotMatch(CONFIG_SRC, /aa_admin_key/);
  });
});

describe('ordinary preference persistence', () => {
  // vm-realm objects carry a different prototype, so compare via JSON.
  const norm = (o) => JSON.parse(JSON.stringify(o));
  it('remembers member + view, tolerates corrupt data', () => {
    const { AppConfig } = loadConfig();
    assert.deepEqual(norm(AppConfig.getPrefs()), {});
    AppConfig.setPrefs({ memberId: 'M003', view: 'team' });
    assert.deepEqual(norm(AppConfig.getPrefs()), { memberId: 'M003', view: 'team' });
    AppConfig.setPrefs({ view: 'my' });
    assert.deepEqual(norm(AppConfig.getPrefs()), { memberId: 'M003', view: 'my' });
    const bad = loadConfig({ storedPrefs: 'not-json{{{' });
    assert.deepEqual(norm(bad.AppConfig.getPrefs()), {});
  });
  it('preferences never carry secrets', () => {
    const { AppConfig, store } = loadConfig();
    AppConfig.setPrefs({ memberId: 'M001', view: 'my' });
    assert.doesNotMatch(store.aa_prefs || '', /EK-|AK-|key/i);
  });
});
