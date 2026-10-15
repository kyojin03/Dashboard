/**
 * API client tests (js/api.js loaded via vm with stubbed fetch/AppConfig).
 * Pins request shapes the dashboard depends on (GET action URLs, POST JSON
 * envelope over text/plain) and the three failure modes the UI surfaces:
 * non-JSON responses, {ok:false} envelopes, and transport errors.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const API_SRC = fs.readFileSync(path.join(ROOT, 'js/api.js'), 'utf8');

function loadApi(fetchStub, opts) {
  const calls = [];
  const token = (opts && opts.idToken) || '';
  const sandbox = {
    window: {
      AppConfig: {
        getApiBase: () => 'https://example.invalid/exec',
        getEditKey: () => 'EK',
        getAdminKey: () => 'AK',
        getIdToken: () => token
      }
    },
    console,
    AbortController: AbortController,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  };
  sandbox.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return fetchStub(url, opts);
  };
  vm.createContext(sandbox);
  vm.runInContext(API_SRC, sandbox, { filename: 'js/api.js' });
  return { Api: sandbox.window.Api, calls };
}

const jsonRes = (obj) => ({ text: async () => JSON.stringify(obj) });

describe('Api request shapes', () => {
  it('GET actions encode action + payload in the URL', async () => {
    const { Api, calls } = loadApi(async () => jsonRes({ ok: true, data: [] }));
    await Api.listTasks({ owner_id: 'M001' });
    assert.match(calls[0].url, /action=listTasks/);
    assert.match(calls[0].url, /payload=/);
    assert.match(decodeURIComponent(calls[0].url), /"owner_id":"M001"/);
    assert.equal(calls[0].opts.method, 'GET');
  });
  it('POST sends {action, payload} as text/plain with no legacy key fields', async () => {
    const { Api, calls } = loadApi(async () => jsonRes({ ok: true, v: '2.1.0', data: {} }));
    await Api.createTask({ title: 'T' });
    assert.equal(calls[0].opts.method, 'POST');
    assert.match(calls[0].opts.headers['Content-Type'], /text\/plain/);
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.action, 'createTask');
    assert.equal(body.payload.title, 'T');
    assert.ok(!('key' in body) && !('adminKey' in body), 'v2 uses idToken, not shared keys');
  });
  it('sends the ID token on GET and POST when one is held', async () => {
    const { Api, calls } = loadApi(async () => jsonRes({ ok: true, v: '2.1.0', data: {} }), { idToken: 'TOK' });
    await Api.ping();
    assert.match(calls[0].url, /idToken=TOK/);
    await Api.createTask({ title: 'T' });
    assert.equal(JSON.parse(calls[1].opts.body).idToken, 'TOK');
  });
  it('accepts the v2 envelope and tolerates a missing v field', async () => {
    const { Api } = loadApi(async () => jsonRes({ ok: true, v: '2.1.0', data: { status: 'ok' } }));
    assert.deepEqual(JSON.parse(JSON.stringify(await Api.ping())), { status: 'ok' });
  });
});

describe('retry, timeout, and error text', () => {
  it('retries BUSY with backoff then succeeds', async () => {
    let n = 0;
    const { Api, calls } = loadApi(async () => (++n === 1
      ? jsonRes({ ok: false, error: { code: 'BUSY', message: 'busy' } })
      : jsonRes({ ok: true, data: 'done' })));
    Api.retry.baseMs = 1;
    try {
      assert.equal(await Api.ping(), 'done');
      assert.equal(calls.length, 2);
    } finally { Api.retry.baseMs = 800; }
  });
  it('retries network errors, then surfaces them', async () => {
    let n = 0;
    const { Api, calls } = loadApi(async () => { n++; throw new TypeError('down'); });
    Api.retry.baseMs = 1;
    try {
      await assert.rejects(Api.ping(), (e) => !e.code);
      assert.equal(calls.length, 4);
    } finally { Api.retry.baseMs = 800; }
  });
  it('times out a hung request', async () => {
    const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { Api } = loadApi((url, opts) => new Promise((_, rej) => {
      var sig = opts && opts.signal;
      if (!sig) { /* no signal: hang like a broken transport */ return; }
      if (sig.aborted) rej(abortErr());
      else sig.addEventListener('abort', function () { rej(abortErr()); });
    }));
    const keep = Api.retry.timeoutMs;
    Api.retry.timeoutMs = 30;
    try {
      await assert.rejects(Api.ping(), (e) => e.code === 'TIMEOUT');
    } finally { Api.retry.timeoutMs = keep; }
  });
  it('maps new v2 codes to clear messages', async () => {
    const { Api } = loadApi(async () => jsonRes({ ok: true, data: {} }));
    assert.equal(Api.errorKind({ code: 'CONFLICT' }), 'other');
    assert.equal(Api.errorKind({ code: 'UNAUTHENTICATED' }), 'auth');
    assert.equal(Api.errorMessage({ code: 'CONFLICT' }), 'Changed by someone else just now. Fresh data was loaded — review and try again.');
    assert.equal(Api.errorMessage({ code: 'DUPLICATE' }), 'Already saved — a duplicate was ignored, nothing was lost.');
    assert.equal(Api.errorMessage({ code: 'UNAUTHENTICATED' }), 'Sign-in required. Sign in and try again.');
    assert.equal(Api.errorMessage({ code: 'SERVER_CONFIG', message: 'X' }), 'Server is misconfigured. Tell the administrator: X');
  });
});

describe('error classification (connection vs authorization)', () => {
  it('FORBIDDEN and key-related NOT_CONFIGURED are auth failures', async () => {
    const { Api } = loadApi(async () => jsonRes({ ok: true, data: {} }));
    assert.equal(Api.errorKind({ code: 'FORBIDDEN', message: 'Invalid edit key.' }), 'auth');
    assert.equal(Api.errorKind({ code: 'NOT_CONFIGURED', message: 'EDIT_KEY is not configured.' }), 'auth');
    assert.equal(Api.errorKind({ code: 'NOT_CONFIGURED', message: 'ADMIN_KEY is not configured.' }), 'auth');
  });
  it('transport, HTML, and unknown errors are connection failures', async () => {
    const { Api } = loadApi(async () => jsonRes({ ok: true, data: {} }));
    assert.equal(Api.errorKind({ code: 'BAD_RESPONSE', message: 'x' }), 'connection');
    assert.equal(Api.errorKind({ code: 'UNKNOWN', message: 'x' }), 'connection');
    assert.equal(Api.errorKind(new TypeError('fetch failed')), 'connection');
    assert.equal(Api.errorKind({ code: 'NOT_CONFIGURED', message: 'Live records address is not configured.' }), 'connection');
  });
  it('data errors are neither (message shown, no retry, no key prompt)', async () => {
    const { Api } = loadApi(async () => jsonRes({ ok: true, data: {} }));
    assert.equal(Api.errorKind({ code: 'VALIDATION', message: 'Title is required.' }), 'other');
    assert.equal(Api.errorKind({ code: 'DUPLICATE', message: 'x' }), 'other');
  });
});

describe('Api failure modes (what the UI shows)', () => {
  it('non-JSON responses reject as BAD_RESPONSE (e.g. login HTML)', async () => {
    const { Api } = loadApi(async () => ({ text: async () => '<!DOCTYPE html><html>' }));
    await assert.rejects(Api.ping(), (e) => e.code === 'BAD_RESPONSE');
  });
  it('{ok:false} envelopes reject with the server error intact', async () => {
    const { Api } = loadApi(async () => jsonRes({ ok: false, error: { code: 'FORBIDDEN', message: 'Invalid edit key.' } }));
    await assert.rejects(Api.updateTask({ task_id: 'T1' }), (e) => e.code === 'FORBIDDEN' && /Invalid edit key/.test(e.message));
  });
  it('transport failures reject instead of silently succeeding', async () => {
    const { Api } = loadApi(async () => { throw new TypeError('fetch failed'); });
    Api.retry.baseMs = 1;
    try {
      await assert.rejects(Api.weeklyReport({}));
    } finally { Api.retry.baseMs = 800; }
  });
  it('unconfigured endpoint fails with a guidance error before any fetch', async () => {
    const src = API_SRC;
    const sandbox = {
      window: { AppConfig: { getApiBase: () => '', getEditKey: () => '', getAdminKey: () => '' } },
      console, fetch: async () => { throw new Error('must not be called'); }
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'js/api.js' });
    // base() throws synchronously (no fetch is attempted), so wrap the call.
    await assert.rejects(async () => sandbox.window.Api.ping(), (e) => e.code === 'NOT_CONFIGURED');
  });
});
