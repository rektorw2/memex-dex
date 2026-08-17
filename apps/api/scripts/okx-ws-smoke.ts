/**
 * Запуск проверки живого канала OKX.
 *
 * Тонкая обёртка: разбор переменных окружения и код выхода. Вся
 * проверка живёт в `src/smoke/ws-smoke.ts` и покрыта тестами
 * на подделке транспорта — иначе её нельзя было бы проверить
 * без сети и ключей.
 *
 * Запуск: npm run okx:ws-smoke -w @memex/api
 *
 * Переменные:
 *   OKX_SMOKE_WALLET      — адрес, на который подписываемся
 *   OKX_SMOKE_OBSERVE_MS  — сколько держать соединение, по умолчанию 60000
 */

import { runWsSmoke } from '../src/smoke/ws-smoke.js';
import { SMOKE_EXIT } from '../src/smoke/exit-codes.js';
import { isOkxWalletConfigured } from '../src/services/okx-wallets.js';
import { env } from '../src/lib/env.js';

const DEFAULT_OBSERVE_MS = 60_000;
/** Верхняя граница: smoke, висящий полчаса, блокирует конвейер. */
const MAX_OBSERVE_MS = 600_000;

async function main(): Promise<number> {
  const wallet = process.env.OKX_SMOKE_WALLET ?? '';
  const observeRaw = Number(process.env.OKX_SMOKE_OBSERVE_MS ?? DEFAULT_OBSERVE_MS);

  if (!Number.isFinite(observeRaw) || observeRaw <= 0) {
    console.error('OKX_SMOKE_OBSERVE_MS должен быть положительным числом миллисекунд');
    return SMOKE_EXIT.config;
  }

  const observeMs = Math.min(observeRaw, MAX_OBSERVE_MS);

  console.log('Проверка живого канала OKX, только чтение');
  console.log(`Адрес: ${env.OKX_WS_URL}\n`);

  const result = await runWsSmoke({
    configured: isOkxWalletConfigured() && env.OKX_WS_ENABLED,
    wallet,
    observeMs,
    log: (line) => console.log(line),
  });

  console.log(result.code === SMOKE_EXIT.ok ? '\nПроверка пройдена.' : '\nПроверка не пройдена.');

  return result.code;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: any) => {
    // Только код: объект ошибки транспорта содержит заголовки,
    // а в них подпись и ключ.
    console.error('Проверка прервалась ошибкой.');
    console.error(`Код: ${e?.code ?? e?.name ?? 'unknown'}`);
    process.exitCode = SMOKE_EXIT.network;
  })
  .finally(() => {
    // Сокет и таймеры закрываются внутри проверки, но процесс всё
    // равно завершается явно: незакрытый таймер переподключения
    // держал бы его открытым до бесконечности.
    setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
  });
