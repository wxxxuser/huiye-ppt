import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { annaEnvironment, cliEntry, projectRoot } from './runtime-env.mjs';

if (!existsSync(cliEntry)) {
  console.error('未找到项目内 Anna CLI，请先运行 npm install。');
  process.exit(1);
}
const args = process.argv.slice(2);
// CLI 0.1.64 has --no-llm / --mock-llm, NOT --llm off/real. Its default
// can spend quota when a PAT exists. This wrapper defaults to off; explicitly
// selecting --llm-account is the opt-in for a real local bridge.
if (args[0] === 'dev' && !args.some(arg => arg === '--llm-account' || arg.startsWith('--llm-account=')
  || arg === '--no-llm' || arg === '--mock-llm' || arg.startsWith('--mock-llm='))) {
  args.push('--no-llm');
}
const child = spawn(process.execPath, [cliEntry, ...args], {
  cwd: projectRoot, env: annaEnvironment(), stdio: 'inherit', windowsHide: true,
});
child.once('error', error => { console.error(`Anna CLI 启动失败：${error.message}`); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
