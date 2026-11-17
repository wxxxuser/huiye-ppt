import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { annaEnvironment, cliEntry, projectRoot } from './runtime-env.mjs';

// Real official local dispatcher; no PAT access, LLM request, or network service.
// The tiny fixture isolates the host contract from the UI build under development.
const bundle = resolve(projectRoot, '.anna/smoke-bundle');
await mkdir(bundle, { recursive: true });
await writeFile(resolve(bundle, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Local host check</title>', 'utf8');
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [cliEntry, 'dev', '--bundle', bundle, '--slug', 'huiye-ppt',
  '--port', String(port), '--no-watch', '--no-llm', '--storage', 'legacy'], {
  cwd: projectRoot, env: annaEnvironment({ offline: true }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let logs = '';
let launchError;
child.stdout.setEncoding('utf8').on('data', chunk => { logs = (logs + chunk).slice(-8_192); });
child.stderr.setEncoding('utf8').on('data', chunk => { logs = (logs + chunk).slice(-8_192); });
child.once('error', error => { launchError = error; });
async function post(path, body = {}) {
  const response = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.ok, true, `Local ${path} failed: HTTP ${response.status}`);
  return response.json();
}
try {
  let ready = false;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (launchError || child.exitCode !== null) throw launchError ?? new Error('Local harness stopped before ready.');
    try { ready = (await fetch(base + '/api/config', { signal: AbortSignal.timeout(1_000) })).ok; }
    catch { /* Wait for this test's own server, never reach a platform endpoint. */ }
    if (ready) break;
    await delay(250);
  }
  assert.equal(ready, true, 'Local harness did not become ready; run scripts/prepare-runtime.mjs first.');
  const session = await post('/api/session/create');
  assert.equal(typeof session.session_id, 'string');
  async function call(ns, method, args = {}) {
    const response = await post('/api/session/call', { session_id: session.session_id, ns, method, args });
    assert.equal(response.ok, true, `${ns}.${method}: ${response.error?.code ?? 'unexpected response'}`);
    return response.result;
  }
  const hello = await call('window', 'hello');
  assert.equal(hello.view_meta.name, 'main');
  const key = 'checks/offline-smoke';
  const value = { title: '汇页 PPT host smoke', bytes: '中文', verified: true };
  await call('storage', 'set', { key, value, scope: 'app' });
  const stored = await call('storage', 'get', { key, scope: 'app' });
  assert.deepEqual(stored.value, value);
  await call('window', 'set_title', { title: '汇页 PPT · 无 AI 验证' });
  await call('storage', 'delete', { key, scope: 'app' });
  console.log('PASS: official local host hello + own-app storage round-trip + window title; 0 model calls.');
} catch (error) {
  console.error(error.message);
  console.error('Local harness log:', logs);
  process.exitCode = 1;
} finally {
  if (child.pid && child.exitCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else child.kill('SIGTERM');
  }
}
