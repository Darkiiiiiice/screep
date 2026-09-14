/** Launch the native engine using its own ABI, with a bounded wall-clock timeout. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const node = process.env.SCREEPS_ENGINE_NODE ?? resolve(homedir(), '.cache/screeps-node24/node-v24.21.0-linux-x64/bin/node');
if (!existsSync(node) || !existsSync('.engine/node_modules/screeps-server-mockup')) {
  console.error('[scenario] engine missing; run npm run engine');
  process.exit(1);
}
const child = spawn(node, ['scripts/lib/scenario-worker.mjs', ...process.argv.slice(2)], {
  stdio: 'inherit', detached: true,
});
const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ } };
const timer = setTimeout(() => { console.error('[scenario] timed out'); stop(); }, process.argv.includes('--lifecycle') ? 1800000 : 120000);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('error', (error) => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { clearTimeout(timer); stop(); process.exitCode = code ?? 1; });
