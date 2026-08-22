import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Секреты не должны попадать в клиентскую часть.
 *
 * Проверка нужна именно автоматическая, потому что утечка такого рода
 * не проявляется никак. Приложение работает, интерфейс выглядит
 * правильно, ошибок нет — просто ключ лежит в исходниках страницы,
 * и узнают об этом от того, кто им воспользуется.
 *
 * Механизм утечки в Next.js простой и коварный: любая переменная
 * с префиксом NEXT_PUBLIC_ подставляется в бандл при сборке, а обычное
 * обращение к process.env в клиентском компоненте молча даёт undefined.
 * Поэтому опасен не столько прямой доступ, сколько попытка «починить»
 * его добавлением префикса.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '../../../web');

/** Имена, которых в клиентской части быть не может ни при каких условиях. */
const SECRET_NAMES = [
  'OKX_API_KEY',
  'OKX_API_SECRET',
  'OKX_SECRET_KEY',
  'OKX_PASSPHRASE',
  'OKX_API_PASSPHRASE',
  'OKX_PROJECT_ID',
  'JWT_SECRET',
  'KMS_LOCAL_MASTER_KEY',
  'ZEROX_API_KEY',
  'SMTP_PASS',
  'DATABASE_URL',
  'OK-ACCESS-SIGN',
  'OK-ACCESS-PASSPHRASE',
];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;

  for (const name of readdirSync(dir)) {
    // Собранное и зависимости не проверяем: .next пересобирается,
    // node_modules не наш.
    if (name === 'node_modules' || name === '.next' || name === 'out' || name === '.git') continue;

    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Директива 'use client' — это оператор в начале файла, а не слово.
 *
 * Наивный поиск подстроки принимал за клиентский компонент любой файл,
 * где эта пара слов встречалась в комментарии, — в том числе
 * next.config.mjs, который выполняется при сборке и читать переменные
 * окружения обязан. Ложная тревога в проверке безопасности хуже, чем
 * кажется: к ней быстро привыкают и перестают читать.
 */
function isClientComponent(text: string): boolean {
  for (const line of text.split('\n', 20)) {
    const t = line.trim();
    if (t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    return /^['"]use client['"];?$/.test(t);
  }
  return false;
}

describe('секреты не попадают в клиентскую часть', () => {
  const files = sourceFiles(WEB);

  it('исходники веб-приложения вообще найдены', () => {
    // Без этой проверки пустой список файлов дал бы зелёные тесты
    // при полном отсутствии проверки — худший из возможных исходов.
    expect(files.length).toBeGreaterThan(5);
  });

  for (const secret of SECRET_NAMES) {
    it(`${secret} не упоминается в apps/web`, () => {
      const found = files.filter((f) => readFileSync(f, 'utf8').includes(secret));
      expect(found.map((f) => f.replace(WEB, 'apps/web'))).toEqual([]);
    });
  }

  it('в apps/web нет переменных NEXT_PUBLIC_ с признаками секрета', () => {
    // NEXT_PUBLIC_ подставляется в бандл при сборке. Переменная
    // с таким префиксом и словом KEY или SECRET в имени — это
    // опубликованный секрет, независимо от намерений автора.
    const bad: string[] = [];

    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) {
        if (/KEY|SECRET|PASSPHRASE|TOKEN|PASSWORD|CREDENTIAL/.test(m[0])) {
          bad.push(`${f.replace(WEB, 'apps/web')}: ${m[0]}`);
        }
      }
    }

    expect(bad).toEqual([]);
  });

  it('клиентские компоненты не читают process.env напрямую', () => {
    // Единственное исключение — NEXT_PUBLIC_API_URL: адрес сервера
    // не секрет, и он обязан быть в бандле, чтобы браузер знал,
    // куда обращаться.
    const bad: string[] = [];

    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (!isClientComponent(text)) continue;

      for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        if (m[1] !== 'NEXT_PUBLIC_API_URL' && m[1] !== 'NODE_ENV') {
          bad.push(`${f.replace(WEB, 'apps/web')}: ${m[0]}`);
        }
      }
    }

    expect(bad).toEqual([]);
  });

  it('подпись запросов существует только на сервере', () => {
    // HMAC от секрета OKX. Если эта строка окажется в apps/web,
    // значит туда попал и сам секрет.
    const bad = files.filter((f) => {
      const t = readFileSync(f, 'utf8');
      return t.includes('createHmac') || t.includes('OK-ACCESS');
    });

    expect(bad.map((f) => f.replace(WEB, 'apps/web'))).toEqual([]);
  });
});
