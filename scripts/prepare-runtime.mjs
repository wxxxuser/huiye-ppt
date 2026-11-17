import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { annaEnvironment, projectRoot, runtimeVersion } from './runtime-env.mjs';

const version = runtimeVersion();
// Warm exactly the CLI-pinned runtime before the CLI's bridge startup timeout.
// This only downloads dependencies and waits for _ready: no login, app session,
// model request, upload, or published app mutation is performed.
console.log(`准备 Anna 本地 runtime ${version}（独立缓存，不使用 AI 额度）…`);
const child = spawn('uvx', ['--from', `anna-app-runtime-local@${version}`, 'anna-app-bridge'], {
  cwd: projectRoot, env: annaEnvironment(), stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
});
const lines = createInterface({ input: child.stdout });
let ready = false;
lines.on('line', line => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (!ready && frame?.method === '_ready') {
    ready = true;
    console.log('Anna runtime 就绪。');
    child.stdin.end();
  }
});
child.once('error', error => {
  console.error(`无法启动 uvx：${error.message}。请安装 uv，或将 HUIYE_UV_BIN 指向含 uvx 的目录。`);
  process.exitCode = 1;
});
child.once('close', code => {
  lines.close();
  if (!ready || code !== 0) {
    console.error('本地 runtime 准备未完成，请检查上方 Python / 下载错误后重试。');
    process.exitCode = code || 1;
  }
});
child.stdin.on('error', error => {
  console.error(`runtime 标准输入错误：${error.message}`);
  process.exitCode = 1;
});
