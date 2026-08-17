import { spawn } from 'node:child_process';
import process from 'node:process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [start('start:api'), start('start:web')];
let stopping = false;

function start(script: string) {
  const child = spawn(npmCommand, ['run', script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  child.once('exit', (code, signal) => {
    if (stopping) {
      return;
    }
    stopping = true;
    for (const sibling of children) {
      if (sibling !== child && sibling.exitCode === null) {
        sibling.kill('SIGTERM');
      }
    }
    process.exitCode = signal ? 1 : (code ?? 1);
  });
  return child;
}

function stop(signal: NodeJS.Signals): void {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill(signal);
    }
  }
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
