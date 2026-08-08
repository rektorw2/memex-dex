#!/usr/bin/env node
/**
 * Запуск всех трёх процессов одной командой с префиксами в логах.
 * Без concurrently — лишняя зависимость ради двадцати строк.
 */
import { spawn } from 'node:child_process';

const COLORS = { api: '\x1b[36m', web: '\x1b[35m', worker: '\x1b[33m' };
const RESET = '\x1b[0m';

const procs = [
  { name: 'api', cmd: 'npm', args: ['run', 'dev', '-w', '@memex/api'] },
  { name: 'web', cmd: 'npm', args: ['run', 'dev', '-w', '@memex/web'] },
  { name: 'worker', cmd: 'npm', args: ['run', 'worker', '-w', '@memex/api'] },
];

// core должен быть собран до старта — api и web импортируют его из dist
const build = spawn('npm', ['run', 'build', '-w', '@memex/core'], { stdio: 'inherit' });

build.on('exit', (code) => {
  if (code !== 0) {
    console.error('Не удалось собрать @memex/core');
    process.exit(1);
  }

  const children = procs.map(({ name, cmd, args }) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const prefix = `${COLORS[name]}[${name}]${RESET} `;

    const pipe = (stream, out) => {
      stream.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) out.write(prefix + line + '\n');
        }
      });
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);

    child.on('exit', (c) => console.log(`${prefix}процесс завершился с кодом ${c}`));
    return child;
  });

  const shutdown = () => {
    for (const c of children) c.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
});
