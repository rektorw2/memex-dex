/**
 * Проверка контракта истории DEX. Только чтение и только в памяти.
 *
 * Проверка отвечает на вопрос, который нельзя выяснить по журналу:
 * совпадает ли форма ответа провайдера с тем, что разбирает
 * `okx-dex-history.ts`. Расхождение здесь особенно неприятно тем,
 * что не выглядит поломкой: изменившееся имя поля даёт не ошибку,
 * а пустой список, а пустой список неотличим от «кошелёк не торговал».
 *
 * Ни одной записи в базу. Позиция собирается в памяти и выбрасывается:
 * smoke, который пишет в боевую базу, — это не проверка, а самый
 * незаметный способ испортить учёт.
 *
 * Наружу печатаются количество записей, вердикт полноты и время.
 * Ни payload провайдера, ни полный адрес кошелька, ни ключи.
 */

import {
  parseHistoryPage,
  dedupeCanonical,
  sortForLedger,
  buildPositions,
  checkCompleteness,
  scorableTokens,
  coveragePercent,
  assessCoverage,
  historyTradeKey,
  type CanonicalTrade,
  type ChainKey,
  type EconomicTrade,
} from '@memex/core';
import { SMOKE_EXIT, NETWORK_UNAVAILABLE, maskAddress, type SmokeExit } from './exit-codes.js';

/** Как smoke ходит за страницей истории. Подделывается целиком. */
export interface HistoryFetcher {
  (params: {
    chainIndex: string;
    walletAddress: string;
    begin: number;
    end: number;
    limit: number;
    cursor: string | null;
  }): Promise<unknown>;
}

export interface LedgerSmokeOptions {
  configured: boolean;
  wallet: string;
  chain: ChainKey;
  chainIndex: string;
  begin: number;
  end: number;
  fetch: HistoryFetcher;
  maxPages?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface LedgerSmokeResult {
  code: SmokeExit;
  lines: string[];
  records: number;
  pages: number;
  coverage: string | null;
  /** Строго ноль. Проверяется тестом: smoke не пишет в базу. */
  writes: number;
}

const DEFAULT_MAX_PAGES = 10;
const PAGE_LIMIT = 100;

export async function runLedgerSmoke(opts: LedgerSmokeOptions): Promise<LedgerSmokeResult> {
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    opts.log?.(line);
  };

  const now = opts.now ?? (() => Date.now());
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  if (!opts.configured) {
    log('OKX provider is not configured — задайте OKX_API_KEY, OKX_API_SECRET, OKX_PASSPHRASE');
    return { code: SMOKE_EXIT.config, lines, records: 0, pages: 0, coverage: null, writes: 0 };
  }

  if (!opts.wallet || !opts.chainIndex) {
    log('Не заданы OKX_SMOKE_WALLET или OKX_SMOKE_CHAIN_INDEX');
    return { code: SMOKE_EXIT.config, lines, records: 0, pages: 0, coverage: null, writes: 0 };
  }

  if (!(opts.begin < opts.end)) {
    // Перевёрнутый интервал даёт пустой ответ, и пустой ответ
    // легко принять за отсутствие сделок.
    log('OKX_SMOKE_BEGIN должен быть меньше OKX_SMOKE_END');
    return { code: SMOKE_EXIT.config, lines, records: 0, pages: 0, coverage: null, writes: 0 };
  }

  const started = now();

  log(`Кошелёк: ${maskAddress(opts.wallet)}`);
  log(`Сеть: ${opts.chain} (chainIndex ${opts.chainIndex})`);

  const all: CanonicalTrade[] = [];
  const seenCursors = new Set<string>();
  const skipped: Record<string, number> = {};

  let cursor: string | null = null;
  let pages = 0;
  let cursorExhausted = false;
  let cursorRepeated = false;

  for (let page = 0; page < maxPages; page++) {
    let raw: unknown;

    try {
      raw = await opts.fetch({
        chainIndex: opts.chainIndex,
        walletAddress: opts.wallet,
        begin: opts.begin,
        end: opts.end,
        limit: PAGE_LIMIT,
        cursor,
      });
    } catch (e: any) {
      const code = e?.code ?? e?.name ?? 'unknown';

      if (code === 'ETIMEDOUT' || code === 'AbortError' || code === 'TimeoutError') {
        log('Запрос истории не уложился в отведённое время.');
        return finish(SMOKE_EXIT.timeout, lines, all.length, pages, null, log, now, started);
      }

      log(NETWORK_UNAVAILABLE);
      log(`Код: ${code}`);
      return finish(SMOKE_EXIT.network, lines, all.length, pages, null, log, now, started);
    }

    pages++;

    const parsed = parseHistoryPage(raw, { chain: opts.chain, wallet: opts.wallet });

    // Разбор не бросает исключений — он сообщает, что отбросил
    // и почему. Единственный признак совсем чужой формы — malformed
    // на самой первой странице.
    if (page === 0 && parsed.skipped.malformed) {
      log('Ответ не похож на страницу истории: нет ни transactionList, ни объекта верхнего уровня.');
      return finish(SMOKE_EXIT.contract, lines, 0, pages, null, log, now, started);
    }

    for (const [why, count] of Object.entries(parsed.skipped)) {
      skipped[why] = (skipped[why] ?? 0) + count;
    }

    all.push(...parsed.trades);

    if (!parsed.cursor || parsed.trades.length === 0) {
      cursorExhausted = true;
      break;
    }

    if (seenCursors.has(parsed.cursor)) {
      // Провайдер вернул тот же курсор — дальше он страниц не отдаёт.
      // Продолжать значило бы бесконечно перекладывать одну страницу
      // и считать выгрузку полной.
      cursorRepeated = true;
      break;
    }

    seenCursors.add(parsed.cursor);
    cursor = parsed.cursor;
  }

  const trades = dedupeCanonical(all);
  const duplicatesDropped = all.length - trades.length;

  const coverage = assessCoverage({
    trades,
    pagesFetched: pages,
    cursorExhausted,
    pageLimitReached: pages >= maxPages && !cursorExhausted,
    cursorRepeated,
    requestedBegin: opts.begin,
  });

  log(`Страниц получено: ${pages}`);
  log(`Записей после дедупликации: ${trades.length}`);
  if (duplicatesDropped > 0) log(`Повторов отброшено: ${duplicatesDropped}`);

  for (const [why, count] of Object.entries(skipped)) {
    log(`Пропущено (${why}): ${count}`);
  }

  if (trades.length === 0) {
    // Важное различие. Пустой ответ подтверждает, что запрос ушёл
    // и вернулся, но ничего не говорит о разборе полей: объявлять
    // на этом основании ledger проверенным нельзя.
    log('DEX History contract verified; no trades found for the selected interval.');
    log('Разбор полей на этом ответе не проверен: сделок в интервале нет.');
    return finish(SMOKE_EXIT.ok, lines, 0, pages, coverage.status, log, now, started);
  }

  // ── Проверка обязательных полей ──────────────────────────────────
  const broken = trades.filter(
    (t) =>
      !isPositiveDecimal(t.amount) ||
      !isDecimal(t.valueUsd) ||
      !isDecimal(t.price) ||
      !Number.isFinite(t.tradedAt) ||
      t.tradedAt <= 0 ||
      (t.side !== 'BUY' && t.side !== 'SELL'),
  );

  if (broken.length > 0) {
    log(`Записей с непригодными числами или временем: ${broken.length}`);
    log('Разбор числовых полей разошёлся с ответом провайдера.');
    return finish(SMOKE_EXIT.contract, lines, trades.length, pages, coverage.status, log, now, started);
  }

  // ── Канонический ключ ────────────────────────────────────────────
  const keys = new Set(trades.map((t) => t.key));

  if (keys.size !== trades.length) {
    // После дедупликации совпадающих ключей быть не может;
    // если они есть — ключ собирается не из того, что делает
    // сделку уникальной.
    log('Канонические ключи повторяются после дедупликации.');
    return finish(SMOKE_EXIT.contract, lines, trades.length, pages, coverage.status, log, now, started);
  }

  const sample = trades[0]!;

  /*
   * Ключ обязан пересобираться из тех же полей.
   *
   * Проверка та же, что была, но собирается новой идентичностью:
   * суммы в ключ больше не входят. Именно из-за них переводы одной
   * транзакции расходились на несколько «сделок», а повторный импорт
   * с другим округлением создавал ещё одну запись.
   */
  const rebuilt = historyTradeKey({
    chain: sample.chain,
    wallet: sample.wallet,
    tokenAddress: sample.tokenAddress,
    side: sample.side,
    tradedAt: sample.tradedAt,
  });

  if (rebuilt !== sample.key) {
    log('Ключ, собранный заново из тех же полей, не совпал с исходным.');
    return finish(SMOKE_EXIT.contract, lines, trades.length, pages, coverage.status, log, now, started);
  }

  log('Канонический ключ воспроизводится.');

  // ── Расчёт в памяти ──────────────────────────────────────────────
  const ordered = sortForLedger(trades);
  const completeness = checkCompleteness(ordered);
  const scorable = scorableTokens(completeness);

  const positions = buildPositions(toEconomic(ordered));
  const orphans = completeness.filter((c) => c.hasOrphanSell);

  log(`Токенов: ${completeness.length}, позиций: ${positions.length}`);
  log(`Годных для оценки токенов: ${scorable.size}`);
  log(`Полнота себестоимости: ${coveragePercent(completeness) ?? '—'}%`);

  if (orphans.length > 0) {
    log(
      `Токенов с продажей без известной покупки: ${orphans.length} — ` +
        'их себестоимость вне доступного окна, в оценку они не идут',
    );
  }

  log(`Полнота выгрузки: ${coverage.status}${coverage.reason ? ` (${coverage.reason})` : ''}`);

  if (coverage.status === 'truncated') {
    log('История упёрлась в потолок провайдера: позиции по этому кошельку считать полными нельзя.');
  }

  return finish(SMOKE_EXIT.ok, lines, trades.length, pages, coverage.status, log, now, started);
}

// ──────────────────────────── Вспомогательное ───────────────────────────────

function finish(
  code: SmokeExit,
  lines: string[],
  records: number,
  pages: number,
  coverage: string | null,
  log: (line: string) => void,
  now: () => number,
  started: number,
): LedgerSmokeResult {
  log(`Длительность: ${now() - started} мс`);
  // writes всегда ноль: в этом модуле нет ни одного обращения
  // к Prisma, и тест проверяет это отдельно.
  return { code, lines, records, pages, coverage, writes: 0 };
}

function isDecimal(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

function isPositiveDecimal(value: string): boolean {
  return isDecimal(value) && Number(value) > 0;
}

/**
 * Перевод в формат существующего ядра расчёта.
 *
 * Приведение строк к числу происходит здесь и только здесь — там же,
 * где это делает боевой пересчёт, чтобы smoke проверял тот же путь.
 */
function toEconomic(trades: CanonicalTrade[]): EconomicTrade[] {
  return trades.map((t) => ({
    chain: t.chain,
    wallet: t.wallet,
    tokenAddress: t.tokenAddress,
    side: t.side,
    tokenAmount: Number(t.amount),
    amountUsd: Number(t.valueUsd),
    priceUsd: Number(t.price),
    timestamp: t.tradedAt,
    txHash: t.key,
    legs: 1,
    parsingConfidence: 1,
    source: 'okx_dex_history',
  }));
}
