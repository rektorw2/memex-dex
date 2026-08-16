/**
 * Проверка связи с OKX без изменения чего-либо.
 *
 * Скрипт отвечает на один вопрос: работают ли ключи и подпись.
 * Отвечать на него по журналу приложения неудобно — там отказ
 * авторизации выглядит как «список пуст», и отличить неверную
 * подпись от спокойного рынка нельзя.
 *
 * Наружу печатается только количество, задержка и состояние.
 * Адреса кошельков, тела ответов и тем более секреты не выводятся:
 * вывод скрипта попадает в историю терминала и в журналы CI.
 *
 * Запуск: npm run okx:smoke -w @memex/api
 */

import { isOkxWalletConfigured, fetchLeaderboard } from '../src/services/okx-wallets.js';
import { OKX_TIMEFRAME, OKX_SORT, type ChainKey } from '@memex/core';

async function probe(chain: ChainKey): Promise<void> {
  const started = Date.now();

  const rows = await fetchLeaderboard({
    chain,
    timeFrame: OKX_TIMEFRAME.d7,
    sortBy: OKX_SORT.pnl,
  });

  const latency = Date.now() - started;

  // Сколько записей и насколько они полны — этого достаточно,
  // чтобы понять, работает ли интеграция.
  const withPnl = rows.filter((r) => r.provider.realizedPnlUsd != null).length;

  console.log(
    `${chain.padEnd(9)} записей: ${String(rows.length).padStart(2)} · ` +
      `с прибылью: ${String(withPnl).padStart(2)} · ${latency} мс`,
  );

  if (rows.length === 0 && latency < 50) {
    // Мгновенный пустой ответ означает, что запроса не было вовсе.
    throw new Error('OKX_NETWORK_UNAVAILABLE');
  }
}

async function main(): Promise<void> {
  if (!isOkxWalletConfigured()) {
    console.error(
      'OKX provider is not configured — заполните OKX_API_KEY, OKX_API_SECRET, OKX_PASSPHRASE',
    );
    process.exit(2);
  }

  console.log('Проверка OKX Onchain OS, только чтение\n');

  try {
    await probe('SOLANA');
    await probe('ETHEREUM');
    console.log('\nСвязь есть, подпись принимается.');
  } catch (e: any) {
    if (e?.message === 'OKX_NETWORK_UNAVAILABLE') {
      console.error('\nOKX_NETWORK_UNAVAILABLE — сеть недоступна из этого окружения');
      process.exit(3);
    }
    console.error(`\nПроверка не прошла: ${e?.message ?? 'без причины'}`);
    process.exit(1);
  }
}

void main();
