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

function loadApi(fetchStub) {
  const calls = [];
  const sandbox = {
    window: {
      AppConfig: {
        getApiBase: () => 'https://example.invalid/exec',
        getEditKey: () => 'EK',
        getAdminKey: () => 'AK'
      }
    },
    console
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
  it('POST sends the JSON envelope as text/plain with both keys', async () => {
    const { Api, calls } = loadApi(async () => jsonRes({ ok: true, data: {} }));
    await Api.createTask({ title: 'T' });
    assert.equal(calls[0].opts.method, 'POST');
    assert.match(calls[0].opts.headers['Content-Type'], /text\/plain/);
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.action, 'createTask');
    assert.equal(body.key, 'EK');
    assert.equal(body.adminKey, 'AK');
    assert.equal(body.payload.title, 'T');
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
    await assert.rejects(Api.weeklyReport({}));
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
