import type { DryRunSummary } from './solana-deposit-dry-run.js';
import { runSolanaDepositDryRun } from './solana-deposit-dry-run.js';
import type { SolanaRpcClient } from './solana-rpc-deposit-source.js';
import {
  runSolanaPreflight,
  type PreflightOptions,
  type PreflightReport,
  type SolanaNetworkName,
} from './solana-preflight.js';
import type { DevnetCheckOutcome } from './devnet-network-proof.js';

/**
 * Что делает команда проверки узла — и чего она при этом не грузит.
 *
 * Логика вынесена из скрипта в модуль по двум причинам, и обе
 * практические. Первая: скрипт не входит в `tsconfig`, то есть не
 * проверяется компилятором; здесь проверяется. Вторая: решение «идти
 * ли в базу» стоит проверять поведением, а не чтением исходника.
 *
 * Главное свойство файла — **в безопасном пути нет ни одного
 * статического импорта Prisma и ничего, что тянет базу**. Модуль
 * записи (`devnet-network-proof.js`) подключается динамически и
 * только в режиме `RECORD`. Обычный запуск и `--dry-run` не загружают
 * его вовсе, поэтому не открывают соединений и не могут ничего
 * записать — не по договорённости, а потому, что кода записи в
 * процессе нет.
 *
 * Второе свойство — **один поход к узлу**. Прежняя версия скрипта
 * сначала выполняла `runSolanaPreflight` ради вывода на экран, а
 * затем при `--record` вызывала службу, которая выполняла ту же
 * проверку заново: два одинаковых обхода узла и вдвое больший расход
 * чужого лимита частоты ради одних и тех же цифр. Теперь режимы
 * взаимоисключающие: либо проверка ради отчёта, либо проверка ради
 * записи, и подробный отчёт во втором случае возвращает сама служба.
 */

/** Что именно просили сделать. */
export type PreflightMode =
  /** Показать отчёт о пригодности узла. Ничего не пишется. */
  | 'REPORT'
  /** Холостой проход источника депозитов. Ничего не пишется. */
  | 'DRY_RUN'
  /** Проверить и сохранить доказательство. */
  | 'RECORD'
  /** Просили несовместимое. Ничего не делается. */
  | 'CONFLICT';

export interface PreflightFlags {
  dryRun: boolean;
  record: boolean;
}

/**
 * Режим по флагам.
 *
 * `--dry-run --record` вместе — отказ, а не тихое предпочтение
 * одного другому. Молча проигнорировать `--record` значило бы, что
 * человек попросил записать, ничего об отказе не узнал и ушёл в
 * уверенности, что доказательство есть.
 */
export function preflightMode(flags: PreflightFlags): PreflightMode {
  if (flags.dryRun && flags.record) return 'CONFLICT';
  if (flags.dryRun) return 'DRY_RUN';
  if (flags.record) return 'RECORD';
  return 'REPORT';
}

/** Подключение модуля записи. Подменяется в тестах. */
export type RecorderLoader = () => Promise<{
  verifyDevnetNetwork: (request: {
    actorId: string | null;
    rpc?: SolanaRpcClient;
  }) => Promise<DevnetCheckOutcome>;
}>;

export interface DryRunRequest {
  address: string;
  fromSlot: bigint;
  pageSize: number;
  maxPages: number;
  maxTransactions: number;
}

export interface PreflightCommandInput {
  mode: PreflightMode;
  network: SolanaNetworkName;
  rpc: SolanaRpcClient;
  /** Параметры отчёта. Нужны только режиму `REPORT`. */
  reportOptions?: Omit<PreflightOptions, 'network'>;
  /** Параметры холостого прохода. Нужны только режиму `DRY_RUN`. */
  dryRun?: DryRunRequest;
  /**
   * Как подключить запись.
   *
   * По умолчанию — динамический импорт, и это единственное место во
   * всём безопасном пути, где база вообще появляется.
   */
  loadRecorder?: RecorderLoader;
}

export interface PreflightCommandResult {
  mode: PreflightMode;
  /** Отчёт о пригодности узла. Есть у `REPORT` и у успешного `RECORD`. */
  report: PreflightReport | null;
  dryRun: DryRunSummary | null;
  /** Итог записи доказательства. Только у `RECORD`. */
  proof: DevnetCheckOutcome | null;
  /** Код возврата процесса. */
  exitCode: number;
}

export async function runPreflightCommand(
  input: PreflightCommandInput,
): Promise<PreflightCommandResult> {
  const empty = { report: null, dryRun: null, proof: null };

  if (input.mode === 'CONFLICT') {
    // Ни сети, ни базы: непонятную просьбу не выполняют наполовину.
    return { mode: input.mode, ...empty, exitCode: 2 };
  }

  if (input.mode === 'DRY_RUN') {
    if (!input.dryRun) return { mode: input.mode, ...empty, exitCode: 2 };
    const summary = await runSolanaDepositDryRun(input.rpc, input.network, input.dryRun);
    return {
      mode: input.mode,
      report: null,
      dryRun: summary,
      proof: null,
      exitCode: summary.failureCode ? 1 : 0,
    };
  }

  if (input.mode === 'RECORD') {
    /*
     * Собственного preflight здесь нет намеренно.
     *
     * Служба сама решает, что считать доказательством, сама берёт
     * аренду и сама пишет журнал. Клиент RPC передаётся ей готовым —
     * тот же, что построила команда из той же серверной настройки, —
     * поэтому обход узла происходит ровно один раз. Отчёт приходит
     * оттуда же и печатается без повторного запроса.
     */
    const load: RecorderLoader =
      input.loadRecorder ?? (() => import('./devnet-network-proof.js'));
    const { verifyDevnetNetwork } = await load();
    const outcome = await verifyDevnetNetwork({ actorId: null, rpc: input.rpc });

    return {
      mode: input.mode,
      report: outcome.report,
      dryRun: null,
      proof: outcome,
      exitCode: outcome.ok ? 0 : 1,
    };
  }

  const report = await runSolanaPreflight(input.rpc, {
    ...input.reportOptions,
    network: input.network,
  });
  return { mode: 'REPORT', report, dryRun: null, proof: null, exitCode: report.ok ? 0 : 1 };
}
