// Starts the API server and the Vite dev server together. Ctrl+C stops both.
import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--watch-path=server', 'server/index.js'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];

function stop(code = 0) {
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}
for (const child of children) child.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
