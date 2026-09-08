/**
 * Проверка узла Solana перед включением приёма депозитов.
 *
 * Запуск:
 *   npm run solana:deposit-preflight            — отчёт о пригодности
 *   npm run solana:deposit-preflight -- --dry-run --address <адрес>
 *   npm run solana:deposit-preflight -- --record — проверить и записать
 *
 * Скрипт только читает сеть. Он не создаёт кошелёк, не отправляет
 * SOL, не запрашивает faucet, не подписывает транзакции и не меняет
 * балансы.
 *
 * По умолчанию он не пишет и в базу. Статического импорта Prisma
 * здесь нет, и это не забывчивость: модуль записи подключается
 * динамически и только в режиме `--record`. Обычный запуск и
 * `--dry-run` его не загружают вовсе — значит, кода записи в процессе
 * просто нет. Решение о режиме и само подключение живут в
 * `src/services/devnet-preflight-command.ts`, где проверяются
 * компилятором и тестами.
 *
 * Режимы взаимоисключающие, и это важно для расхода чужого лимита
 * частоты: прежняя версия сначала выполняла preflight ради вывода на
 * экран, а затем при `--record` вызывала службу, которая выполняла ту
 * же проверку заново. Теперь при `--record` узел обходится один раз, а
 * подробный отчёт возвращает сама служба.
 *
 * Сетевой запрос не делается неявно. Endpoint задаётся отдельной
 * переменной `SOLANA_PREFLIGHT_RPC_URL`; без неё скрипт объясняет,
 * чего не хватает, и завершается, ничего не вызвав. Это защита от
 * случая, когда «просто проверить» оборачивается запросом к mainnet
 * из-за значения по умолчанию.
 */

import {
  FetchSolanaRpcClient,
  type SolanaRpcClient,
} from '../src/services/solana-rpc-deposit-source.js';
import {
  type PreflightReport,
  type SolanaNetworkName,
} from '../src/services/solana-preflight.js';
import type { DryRunSummary } from '../src/services/solana-deposit-dry-run.js';
import {
  preflightMode,
  runPreflightCommand,
} from '../src/services/devnet-preflight-command.js';
import type { DevnetCheckOutcome } from '../src/services/devnet-network-proof.js';

const NETWORKS: readonly SolanaNetworkName[] = ['devnet', 'testnet', 'mainnet-beta'];

interface Args {
  dryRun: boolean;
  /** Записать итог как доказательство проверки сети. */
  record: boolean;
  address: string | null;
  fromSlot: bigint | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: false, record: false, address: null, fromSlot: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--record') args.record = true;
    else if (flag === '--address') args.address = argv[++i] ?? null;
    else if (flag === '--from-slot') {
      const value = argv[++i] ?? '';
      if (!/^\d+$/.test(value)) {
        console.error('--from-slot должен быть неотрицательным целым числом.');
        process.exit(2);
      }
      args.fromSlot = BigInt(value);
    }
  }
  return args;
}

function parseNetwork(value: string | undefined): SolanaNetworkName {
  const network = (value ?? 'devnet') as SolanaNetworkName;
  if (!NETWORKS.includes(network)) {
    console.error(`SOLANA_NETWORK должен быть одним из: ${NETWORKS.join(', ')}`);
    process.exit(2);
  }
  return network;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const network = parseNetwork(process.env.SOLANA_NETWORK);
  const endpoint = process.env.SOLANA_PREFLIGHT_RPC_URL?.trim();
  const mode = preflightMode(args);

  if (mode === 'CONFLICT') {
    /*
     * Отказ, а не тихое предпочтение одного флага другому. Молча
     * проигнорировать `--record` значило бы, что человек попросил
     * записать, об отказе не узнал и ушёл в уверенности, что
     * доказательство есть.
     */
    console.error(
      '--dry-run и --record несовместимы.\n' +
      'Холостой проход ничего не записывает; запись требует настоящей\n' +
      'проверки узла. Выберите одно.',
    );
    process.exit(2);
  }

  if (!endpoint) {
    console.error(
      'Не задан SOLANA_PREFLIGHT_RPC_URL.\n\n' +
      'Endpoint указывается отдельной переменной намеренно: значение\n' +
      'по умолчанию однажды отправило бы проверку в mainnet.\n\n' +
      `  SOLANA_NETWORK=${network} \\\n` +
      '  SOLANA_PREFLIGHT_RPC_URL=https://api.devnet.solana.com \\\n' +
      '  npm run solana:deposit-preflight\n',
    );
    process.exit(2);
  }

  if (network === 'mainnet-beta' && process.env.SOLANA_PREFLIGHT_ALLOW_MAINNET !== 'yes') {
    console.error(
      'Проверка mainnet требует SOLANA_PREFLIGHT_ALLOW_MAINNET=yes.\n' +
      'Это read-only запросы, но подтверждение обязательно: боевая\n' +
      'сеть не должна выбираться опечаткой в имени.',
    );
    process.exit(2);
  }

  if (mode === 'DRY_RUN') {
    if (!args.address) {
      console.error(
        'Холостому прогону нужен публичный адрес: --address <адрес>.\n' +
        'Приватный ключ не требуется и не принимается.',
      );
      process.exit(2);
    }
    if (args.fromSlot == null) {
      console.error(
        'Нужен --from-slot: с какого слота смотреть.\n' +
        'Значения по умолчанию нет намеренно — «с начала цепочки»\n' +
        'означало бы годы истории и упор в предел страниц.',
      );
      process.exit(2);
    }
  }

  const rpc: SolanaRpcClient = new FetchSolanaRpcClient(endpoint, 10_000);

  const result = await runPreflightCommand({
    mode,
    network,
    rpc,
    dryRun:
      mode === 'DRY_RUN' && args.address && args.fromSlot != null
        ? {
            address: args.address,
            fromSlot: args.fromSlot,
            pageSize: positiveInt(process.env.SOLANA_DRY_RUN_PAGE_SIZE, 50),
            maxPages: positiveInt(process.env.SOLANA_DRY_RUN_MAX_PAGES, 2),
            maxTransactions: positiveInt(process.env.SOLANA_DRY_RUN_MAX_TRANSACTIONS, 100),
          }
        : undefined,
    reportOptions: {
      expectedGenesisHash: process.env.SOLANA_EXPECTED_GENESIS_HASH ?? null,
      // Приём депозитов ищет транзакции задним числом, поэтому архив
      // нужен: узел без него ответит «нет такой» на существующую.
      requireHistory: true,
      maxLatencyMs: positiveInt(process.env.SOLANA_PREFLIGHT_MAX_LATENCY_MS, 5_000),
      planning: {
        lookbackSlots: positiveInt(process.env.SOLANA_DEPOSIT_NEW_ADDRESS_LOOKBACK_SLOTS, 216_000),
        pageSize: positiveInt(process.env.SOLANA_DEPOSIT_SIGNATURE_PAGE_SIZE, 100),
        maxPages: positiveInt(process.env.SOLANA_DEPOSIT_MAX_PAGES, 10),
        expectedSignaturesPerHour: positiveInt(process.env.SOLANA_EXPECTED_SIGNATURES_PER_HOUR, 20),
      },
    },
  });

  if (result.dryRun) printDryRun(result.dryRun);
  if (result.report) print(result.report);
  if (result.proof) printProof(result.proof);

  /*
   * Соединение закрывается только там, где оно могло открыться.
   *
   * Модуль базы подключается динамически, и в обычном запуске его в
   * процессе нет вовсе. Импортировать его на выходе ради
   * `$disconnect` значило бы завести базу именно там, где мы
   * добивались её отсутствия.
   */
  if (result.mode === 'RECORD') await disconnect();

  process.exit(result.exitCode);
}

/** Закрыть соединение после записи. Вызывается только в режиме `--record`. */
async function disconnect(): Promise<void> {
  const { prismaWasInstantiated, prisma } = await import('../src/lib/prisma.js');
  if (prismaWasInstantiated()) await prisma.$disconnect();
}

/** Итог записи доказательства. Ни адреса узла, ни отпечатка настройки. */
function printProof(outcome: DevnetCheckOutcome): void {
  console.log(
    `\nДоказательство: ${outcome.snapshot.state}` +
    (outcome.ok
      ? `\n  годно до: ${outcome.snapshot.expiresAt ?? '—'}`
      : `\n  причина:  ${outcome.reason}` +
        `\n  код узла: ${outcome.snapshot.failureCode ?? '—'}`) +
    '\n',
  );
}

function print(report: PreflightReport): void {
  // Печатается только имя сети. Endpoint может содержать API-ключ
  // в пути или в query, и попадание его в журнал равносильно утечке.
  console.log(`\nСеть: ${report.network}`);
  for (const check of report.checks) {
    const mark = check.outcome === 'PASS' ? '✓' : check.outcome === 'SKIPPED' ? '·' : '✗';
    /*
     * Тип указан явно. Без него вывод сужается до `PreflightCheckName`
     * по первому элементу, и дописать в ту же строку код отказа или
     * задержку становится ошибкой типа. Скрипт не входит в
     * `tsconfig`, поэтому она молчала.
     */
    const parts: string[] = [check.name];
    if (check.kind) parts.push(check.kind);
    if (check.code) parts.push(check.code);
    else if (check.detail) parts.push(check.detail);
    if (check.latencyMs != null) parts.push(`${check.latencyMs} мс`);
    console.log(`  ${mark} ${parts.join('  ')}`);
  }

  if (report.commitmentLagSlots != null) {
    console.log(`\nОтставание confirmed от finalized: ${report.commitmentLagSlots} слотов`);
  }

  if (report.budget) {
    const b = report.budget;
    console.log(
      `\nБюджет просмотра: ${b.status}\n` +
      `  вместимость прохода: ${b.signatureCapacity} подписей\n` +
      `  ожидается в окне:    ${b.expectedSignatures}\n` +
      `  безопасное окно:     ${b.safeLookbackSlots ?? '—'} слотов`,
    );
    if (b.status === 'INSUFFICIENT_SCAN_BUDGET') {
      console.log(
        '  Окно не помещается. Не сокращайте его молча: сокращённое\n' +
        '  окно неотличимо от просмотренного. Либо поднимите\n' +
        '  SOLANA_DEPOSIT_MAX_PAGES, либо возьмите безопасное значение выше.',
      );
    }
  }

  if (report.bootstrap) {
    console.log(
      `\nПервый слот: ${report.bootstrap.status}` +
      (report.bootstrap.suggestedSlot != null
        ? `\n  предлагается: ${report.bootstrap.suggestedSlot}` +
          `\n  диапазон:     ${report.bootstrap.range?.from}…${report.bootstrap.range?.to}` +
          '\n  Перенесите значение в SOLANA_DEPOSIT_BOOTSTRAP_SLOT вручную.'
        : '\n  предлагать нечего'),
    );
  }

  console.log(`\nИтог: ${report.ok ? 'узел пригоден' : 'узел не пригоден'}\n`);
}

function printDryRun(summary: DryRunSummary): void {
  console.log(
    `\nХолостой прогон (${summary.network})\n` +
    '  Ничего не записано: ни депозита, ни проводки, ни курсора.\n\n' +
    `  диапазон слотов:      ${summary.fromSlot}…${summary.scannedThroughSlot}\n` +
    `  подписей:             ${summary.signatures}\n` +
    `  транзакций:           ${summary.transactions}\n` +
    `  переводов SOL:        ${summary.solTransfers}\n` +
    `  переводов SPL:        ${summary.splTransfers}\n` +
    `  токен вне списка:     ${summary.unsupportedMint}\n` +
    `  наибольшая сумма:     ${summary.largestRawAmount ?? '—'} (минимальные единицы)\n` +
    `  индексы инструкций:   ${summary.instructionIndexes.join(', ') || '—'}`,
  );
  if (summary.failureCode) {
    console.log(`\n  Проход не завершён: ${summary.failureCode}`);
    console.log('  Ноль переводов и «прочитать не удалось» — разные ответы.');
  }
  console.log('');
}

main().catch((error: unknown) => {
  // Наружу выходит только тип ошибки: сообщение может содержать URL.
  console.error(error instanceof Error ? error.name : 'PREFLIGHT_FAILED');
  process.exit(1);
});
