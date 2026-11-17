import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const cliRoot = resolve(projectRoot, 'node_modules/@anna-ai/cli');
export const cliEntry = resolve(cliRoot, 'dist/cli.js');

export function annaEnvironment({ offline = false } = {}) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const candidates = [
    env.HUIYE_UV_BIN,
    resolve(projectRoot, '.tools/python/bin'),
    // Reuse only the existing uv executable, never its project/cache/credentials.
    resolve(projectRoot, '../mini-notes-anna/.tools/python/bin'),
  ].filter(Boolean).filter(path => existsSync(path));
  if (candidates.length) env[pathKey] = `${candidates.join(delimiter)}${delimiter}${env[pathKey] ?? ''}`;
  env.UV_CACHE_DIR = resolve(projectRoot, '.tools/uv-cache');
  env.UV_HTTP_TIMEOUT ??= '120';
  env.UV_HTTP_RETRIES ??= '3';
  if (offline) env.UV_OFFLINE = 'true';
  return env;
}

export function runtimeVersion() {
  if (!existsSync(cliEntry)) throw new Error('请先在 huiye-ppt 目录运行 npm install。');
  const dist = resolve(cliRoot, 'dist');
  for (const file of readdirSync(dist).filter(name => /^bridge.*\.js$/.test(name))) {
    const match = /(?:const|let|var) PINNED_RUNTIME_VERSION\s*=\s*["']([^"']+)["']/.exec(readFileSync(resolve(dist, file), 'utf8'));
    if (match) return match[1];
  }
  throw new Error('无法识别当前 Anna CLI 的 Python runtime 版本，请检查已安装 CLI。');
}
