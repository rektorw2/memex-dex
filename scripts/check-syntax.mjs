import ts from 'typescript';
import { readFileSync } from 'node:fs';

import { execSync } from 'node:child_process';

const files = execSync(
  `find apps prisma packages -type f \\( -name "*.ts" -o -name "*.tsx" \\) -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.next/*"`,
  { encoding: 'utf8' },
).trim().split('\n');

let errors = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.ES2022, true,
    f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length) {
    errors += diags.length;
    console.log(`\n${f}:`);
    for (const d of diags.slice(0, 5)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(d.start);
      console.log(`  ${line + 1}:${character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
  }
}
console.log(`\nПроверено файлов: ${files.length}, синтаксических ошибок: ${errors}`);
