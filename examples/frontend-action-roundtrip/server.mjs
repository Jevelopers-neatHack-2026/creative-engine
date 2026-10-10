/** Mock application identity/state boundary. This is NOT an authentication server. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplyStore } from '../../src/controls/actions.mjs';
import { createControlSchema } from '../../src/controls/schema.mjs';
import { fixtureState, principal, projection } from '../../fixtures/controls/state.mjs';

const port = Number(process.env.CONTROLS_FIXTURE_PORT ?? 4317);
const dir = mkdtempSync(join(tmpdir(), 'creative-browser-'));
let state = fixtureState();
const store = new ApplyStore(join(dir, 'outbox.sqlite'), () => projection(state));
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/schema.mjs': ['../../src/controls/schema.mjs', 'text/javascript; charset=utf-8'],
};
const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && files[path]) {
      const [file, mime] = files[path];
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'" });
      return res.end(await readFile(new URL(file, import.meta.url)));
    }
    if (req.method === 'GET' && path === '/api/schema') return json(res, { mode: 'mock', schema: createControlSchema(state), counters: store.counts() });
    if (req.method === 'GET' && path === '/api/counters') return json(res, { mode: 'mock', ...store.counts() });
    if (req.method !== 'POST' || !['/api/apply', '/api/dispatch', '/api/cancel', '/__fixture/state', '/__fixture/reset'].includes(path)) return json(res, { code: 'not_found' }, 404);
    if (!req.headers['content-type']?.startsWith('application/json')) return json(res, { code: 'validation' }, 415);
    if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return json(res, { code: 'permission' }, 403);
    let body = '', size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 32768) return json(res, { code: 'validation' }, 413); body += chunk; }
    const payload = JSON.parse(body);
    // All identity comes from this explicit synthetic server fixture principal,
    // not request JSON/headers/cookies. Production application supplies its own.
    if (path === '/api/apply') return json(res, { mode: 'mock', ...store.apply(principal, payload), counters: store.counts() });
    if (path === '/api/dispatch') return json(res, { mode: 'mock', ...store.dispatch(principal, payload.operation_id), counters: store.counts() });
    if (path === '/api/cancel') return json(res, { mode: 'mock', ...store.cancel(principal, payload.operation_id), counters: store.counts() });
    // Mock-only test controls, never exported by the runtime/API adapter.
    if (path === '/__fixture/reset') {
      store.db.exec('DELETE FROM control_completions; DELETE FROM control_jobs; DELETE FROM control_audit;'); state = fixtureState();
    } else {
      if (payload.advance_design) state.versions.design = 'design_v2';
      if (payload.revoke) state.can_apply = false;
      if (payload.unlock_logo) state.locks = [];
      if (payload.revoke_asset) state.permitted_asset_ids = [];
      if (payload.stacked_name) { state.values.layout = 'stacked'; state.follow_up_answers.q01 = 'name'; state.versions.composition = 'composition_v2'; }
      if (payload.lock_followup) state.follow_up_locks = ['q01'];
    }
    return json(res, { mode: 'mock', ok: true });
  } catch { return json(res, { ok: false, code: 'validation', mode: 'mock' }, 400); }
});
server.listen(port, '127.0.0.1', () => console.log(`Mock controls fixture http://127.0.0.1:${port}; no provider integrations`));
const stop = () => server.close(() => { store.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0); });
process.on('SIGTERM', stop); process.on('SIGINT', stop);
