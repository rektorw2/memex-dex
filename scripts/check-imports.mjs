import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Проверка ссылочной целостности локальных импортов
const files = execSync(
  `find apps packages prisma -type f \\( -name "*.ts" -o -name "*.tsx" \\) -not -path "*/node_modules/*" -not -path "*/dist/*"`,
  { encoding: 'utf8', cwd: process.cwd() },
).trim().split('\n');

const exists = (p) => { try { readFileSync(p); return true; } catch { return false; } };
let broken = 0;

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const dir = f.substring(0, f.lastIndexOf('/'));
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    const base = `${dir}/${spec}`.replace(/\.js$/, '');
    const candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base];
    if (!candidates.some(exists)) {
      console.log(`СЛОМАН ИМПОРТ  ${f} -> ${spec}`);
      broken++;
    }
  }
}
console.log(`\nЛокальных импортов проверено во всех ${files.length} файлах, битых: ${broken}`);
