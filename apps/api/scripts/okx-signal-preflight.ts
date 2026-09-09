/**
 * Проверка цепочки источника сигналов OKX.
 *
 * Запуск: npm run okx:signal-preflight -w @memex/api
 *
 * Переменные:
 *   OKX_SIGNAL_PREFLIGHT_OBSERVE_MS — окно ожидания первого сигнала по WebSocket (по умолчанию 60000).
 *
 * Вся логика — в `src/smoke/signal-preflight.ts`, покрыта тестами на
 * подделке транспорта. Здесь только подключение настоящих клиентов и
 * код выхода: 0 — транспорт подтверждён; 2 — ключи не заданы; 3 —
 * сеть; 4 — ключ отклонён; 5 — ни одна сеть агента не поддержана;
 * 8 — канал сигналов требует whitelist; 9 — проверка не завершена
 * (нет сигналов, подписка не подтверждена, WebSocket выключен).
 */
import { env } from '../src/lib/env.js';
import { isOkxWalletConfigured, okxCall } from '../src/services/okx-client.js';
import { fetchLatestSignals } from '../src/services/okx-market.js';
import { runSignalPreflight, type SupportedChainRow } from '../src/smoke/signal-preflight.js';
import { SMOKE_EXIT } from '../src/smoke/exit-codes.js';

async function main(): Promise<number> {
  const observeMs = Math.min(600_000, Math.max(1_000, Number(process.env.OKX_SIGNAL_PREFLIGHT_OBSERVE_MS ?? 60_000) || 60_000));
  console.log('Проверка источника сигналов OKX Signal API, только чтение');
  console.log(`REST: ${env.OKX_API_BASE_URL} · WebSocket: ${env.OKX_WS_URL} · тариф по настройке: ${env.OKX_PLAN ?? 'не указан'}\n`);

  const report = await runSignalPreflight({
    configured: isOkxWalletConfigured(),
    wsEnabled: env.OKX_WS_ENABLED,
    observeMs,
    fetchSupportedChains: async () => {
      const raw = await okxCall<{ code?: string; data?: SupportedChainRow[] }>('/api/v6/dex/market/signal/supported/chain', { label: 'signal-supported-chain' });
      if (raw?.code && raw.code !== '0') throw Object.assign(new Error('OKX rejected'), { code: `okx_${raw.code}` });
      return Array.isArray(raw?.data) ? raw.data.map((row) => ({ chainIndex: String(row.chainIndex), chainName: String(row.chainName ?? '') })) : [];
    },
    fetchLatestSignals: (chain, limit) => fetchLatestSignals(chain, limit),
    log: (line) => console.log(line),
  });

  if (report.status === 'complete') {
    console.log('\nТранспорт подтверждён: авторизация → сети → подписка → сигнал → локальный расчёт решения.');
    console.log('Серверную обработку (запись в базу → воркер → решение) подтверждает отдельно: npm run okx:signal-chain -w @memex/api');
  } else if (report.status === 'incomplete') {
    console.log(`\nПроверка НЕ завершена (код ${report.code}): подтверждения нет, ошибки тоже нет.`);
    for (const gap of report.gaps) console.log(`  • ${gap}`);
  } else {
    console.log(`\nОбнаружена ошибка (код ${report.code}).`);
  }
  return report.code;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e: any) => {
    console.error('Проверка прервалась ошибкой.');
    console.error(`Код: ${e?.code ?? e?.name ?? 'unknown'}`);
    process.exitCode = SMOKE_EXIT.network;
  });
