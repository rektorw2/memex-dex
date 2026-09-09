/**
 * Проверка всей цепочки источника сигналов — на настоящем клиенте.
 *
 * Наличие API-ключа само по себе ничего не подтверждает: ключ может
 * быть верным, а тариф — без WebSocket; тариф — платным, а канал
 * сигналов — без whitelist; канал — открытым, а сеть — не в списке
 * поддерживаемых. Поэтому проверка идёт по ступеням и останавливается
 * на первой, которая не подтверждена:
 *
 *   1. ключи заданы;
 *   2. REST принимает подпись: `signal/supported/chain` отвечает списком;
 *   3. нужные сети есть в этом списке (Solana, BNB, Robinhood Chain);
 *   4. REST отдаёт сигналы по сети;
 *   5. WebSocket: вход принят, подписка на канал сигналов подтверждена
 *      (или отклонена кодом 60029 — тогда нужен whitelist);
 *   6. первый сигнал получен в окне наблюдения;
 *   7. локальный расчёт решения по этому сигналу — тем же
 *      `evaluatePaperSignal`, что работает в бою. Это проверка
 *      транспорта и формы данных, а не серверной обработки: что сигнал
 *      дошёл до базы, воркера и решения, проверяет `okx:signal-chain`.
 *
 * Итог — один из трёх: подтверждено (все ступени доказаны), ошибка
 * (ступень отказала) или неполно (не хватило доступа, времени или
 * событий). Спокойный рынок без сигналов — «неполно», не успех.
 *
 * Поток кошельков (`kol_smartmoney-tracker-activity`) сюда не входит
 * намеренно: код `60036`, наблюдавшийся в нём, к доступу к Signal
 * не относится, и смешивать их значит чинить не то.
 *
 * Наружу не печатаются ключ, секрет, парольная фраза, подпись и тела
 * сообщений провайдера. Коды отказа OKX печатаются: они не секрет.
 */
import {
  OKX_CHAIN_INDEX,
  PAPER_AGENT_STRATEGIES,
  evaluatePaperSignal,
  type ChainKey,
  type OkxSignal,
} from '@memex/core';
import {
  OkxWalletWebSocketClient,
  type SocketFactory,
} from '../services/okx-ws-client.js';
import { SMOKE_EXIT, describeProviderCode, exitForProviderCode, type SmokeExit } from './exit-codes.js';

/** Сети, которые агент умеет вести. Порядок — порядок в отчёте. */
export const AGENT_SIGNAL_CHAINS: readonly ChainKey[] = ['SOLANA', 'BNB', 'ROBINHOOD'];

export interface SupportedChainRow {
  chainIndex: string;
  chainName: string;
}

export interface SignalPreflightDeps {
  configured: boolean;
  /** GET signal/supported/chain — уже разобранный ответ. */
  fetchSupportedChains: () => Promise<SupportedChainRow[]>;
  /** POST signal/list по сети. */
  fetchLatestSignals: (chain: ChainKey, limit: number) => Promise<OkxSignal[]>;
  wsEnabled: boolean;
  factory?: SocketFactory;
  observeMs: number;
  connectTimeoutMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface ChainVerdict {
  chain: ChainKey;
  chainIndex: string | null;
  supportedByOkx: boolean;
  restSignals: number | null;
}

export type PreflightStatus = 'complete' | 'error' | 'incomplete';

export interface SignalPreflightReport {
  code: SmokeExit;
  status: PreflightStatus;
  /** Почему проверка неполная — по одной строке на пробел. */
  gaps: string[];
  lines: string[];
  stages: {
    config: boolean;
    restAuth: boolean;
    chains: ChainVerdict[];
    wsLogin: boolean | null;
    wsSubscribed: boolean | null;
    wsDeniedCode: string | null;
    firstSignalVia: 'websocket' | 'rest' | null;
    decisionCode: string | null;
  };
  cleanedUp: boolean;
}

const POLL_MS = 100;

export async function runSignalPreflight(deps: SignalPreflightDeps): Promise<SignalPreflightReport> {
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); deps.log?.(line); };
  const now = deps.now ?? (() => Date.now());
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stages: SignalPreflightReport['stages'] = {
    config: false, restAuth: false, chains: [], wsLogin: null, wsSubscribed: null, wsDeniedCode: null, firstSignalVia: null, decisionCode: null,
  };
  const gaps: string[] = [];
  const done = (code: SmokeExit, cleanedUp = true): SignalPreflightReport => {
    const status: PreflightStatus = code === SMOKE_EXIT.ok ? 'complete' : code === SMOKE_EXIT.incomplete ? 'incomplete' : 'error';
    return { code, status, gaps, lines, stages, cleanedUp };
  };

  // 1. Ключи.
  if (!deps.configured) {
    log('1. Ключи OKX не заданы (OKX_API_KEY / OKX_API_SECRET / OKX_PASSPHRASE). Дальше проверять нечего.');
    return done(SMOKE_EXIT.config);
  }
  stages.config = true;
  log('1. Ключи заданы.');

  // 2. REST-подпись и список сетей.
  let supported: SupportedChainRow[];
  try {
    supported = await deps.fetchSupportedChains();
  } catch (error: any) {
    const kind = error?.code ?? error?.name ?? 'unknown';
    log(`2. REST отклонил запрос списка сетей: ${kind}. ${kind === 'auth' ? 'Проверьте ключ, секрет и парольную фразу.' : ''}`.trim());
    return done(kind === 'auth' ? SMOKE_EXIT.auth : SMOKE_EXIT.network);
  }
  stages.restAuth = true;
  log(`2. REST принял подпись. Сетей в Signal API: ${supported.length} — ${supported.map((row) => `${row.chainName} (${row.chainIndex})`).join(', ') || 'пусто'}.`);

  // 3. Нужные сети.
  const supportedIndexes = new Set(supported.map((row) => String(row.chainIndex)));
  for (const chain of AGENT_SIGNAL_CHAINS) {
    const chainIndex = OKX_CHAIN_INDEX[chain] ?? null;
    stages.chains.push({ chain, chainIndex, supportedByOkx: chainIndex != null && supportedIndexes.has(chainIndex), restSignals: null });
  }
  for (const verdict of stages.chains) {
    log(`3. ${verdict.chain}: ${verdict.chainIndex == null ? 'у OKX нет chainIndex для этой сети — сигналов быть не может' : verdict.supportedByOkx ? `поддерживается (chainIndex ${verdict.chainIndex})` : `chainIndex ${verdict.chainIndex} отсутствует в списке Signal API — сигналов нет`}.`);
  }
  const usable = stages.chains.filter((row) => row.supportedByOkx);
  if (usable.length === 0) {
    log('3. Ни одна сеть агента не поддерживается Signal API на этом ключе.');
    return done(SMOKE_EXIT.contract);
  }

  // 4. REST-сигналы.
  let restSample: OkxSignal | null = null;
  for (const verdict of usable) {
    try {
      const signals = await deps.fetchLatestSignals(verdict.chain, 20);
      verdict.restSignals = signals.length;
      restSample ??= signals[0] ?? null;
      log(`4. ${verdict.chain}: REST вернул ${signals.length} сигналов.`);
    } catch (error: any) {
      verdict.restSignals = null;
      log(`4. ${verdict.chain}: REST не вернул сигналы (${error?.code ?? error?.name ?? 'unknown'}).`);
    }
  }

  // 5–6. WebSocket.
  const wsBox: { sample: OkxSignal | null } = { sample: null };
  let cleanedUp = true;
  if (!deps.wsEnabled) {
    gaps.push('WebSocket выключен (OKX_WS_ENABLED=false): канал не проверялся');
    log('5. WebSocket выключен (OKX_WS_ENABLED=false): только REST-опрос, канал не проверялся.');
  } else {
    const client = new OkxWalletWebSocketClient({
      id: 'signal-preflight',
      addresses: [],
      platformFeed: false,
      signalChains: usable.map((row) => row.chainIndex!),
      onEvent: () => {},
      onSignal: (signal) => { wsBox.sample ??= signal; },
      factory: deps.factory,
      now,
    });
    client.start();
    const deadline = now() + (deps.connectTimeoutMs ?? 30_000);
    let denied: string | null = null;
    while (now() < deadline) {
      const stats = client.stats();
      if (stats.channelAccessDeniedCode) { denied = stats.channelAccessDeniedCode; break; }
      if (stats.loginVerified && stats.subscriptionsVerified) break;
      if (stats.lastProviderCode && !stats.loginVerified) { denied = stats.lastProviderCode; break; }
      await wait(POLL_MS);
    }
    const stats = client.stats();
    stages.wsLogin = stats.loginVerified;
    if (denied) {
      stages.wsDeniedCode = denied;
      stages.wsSubscribed = false;
      const meaning = describeProviderCode(denied);
      log(`5. WebSocket: ${stats.loginVerified ? 'вход принят, но канал сигналов отклонён' : 'вход отклонён'} кодом ${denied}${meaning ? ` — ${meaning}` : ''}.`);
      if (exitForProviderCode(denied) === SMOKE_EXIT.channelDenied) {
        log('   Нужен whitelist канала `dex-market-new-signal-openapi` у OKX; тариф без WebSocket (Free) его не даёт. До этого агент работает по REST.');
      }
      client.stop();
    } else if (!stats.loginVerified) {
      stages.wsSubscribed = false;
      gaps.push('WebSocket: вход не подтверждён в отведённое время');
      log('5. WebSocket: до провайдера не достучались или вход не подтверждён в отведённое время — не подтверждено.');
      client.stop();
    } else if (!stats.subscriptionsVerified) {
      // Вход есть, подтверждения подписки нет: это не «подписан», это «неизвестно».
      stages.wsSubscribed = false;
      gaps.push('WebSocket: вход принят, но подтверждение подписки на канал сигналов не пришло в отведённое время');
      log('5. WebSocket: вход принят, подписка на канал сигналов НЕ подтверждена в отведённое время.');
      client.stop();
    } else {
      stages.wsSubscribed = true;
      log('5. WebSocket: вход принят, подписка на канал сигналов подтверждена провайдером.');
      const observeUntil = now() + deps.observeMs;
      while (now() < observeUntil && !wsBox.sample) await wait(POLL_MS);
      if (wsBox.sample) {
        log(`6. Первый сигнал по WebSocket получен: ${wsBox.sample.chain} ${wsBox.sample.symbol}.`);
      } else {
        gaps.push(`WebSocket: за ${Math.round(deps.observeMs / 1000)} с не пришло ни одного сигнала`);
        log(`6. За ${Math.round(deps.observeMs / 1000)} с по WebSocket сигналов не пришло — на спокойном рынке это не отказ, но и не подтверждение.`);
      }
      client.stop();
    }
    cleanedUp = client.getState() === 'disconnected' || client.getState() === 'disabled';
  }

  // 7. Локальный расчёт решения по первому доступному сигналу.
  const wsSample = wsBox.sample;
  const sample = wsSample ?? restSample;
  stages.firstSignalVia = wsSample ? 'websocket' : restSample ? 'rest' : null;
  if (!sample) {
    gaps.push('Ни одного сигнала ни по REST, ни по WebSocket: решение не проверено');
    log('7. Сигналов для проверки решения нет — цепочка не доказана.');
    if (stages.wsDeniedCode) return done(exitForProviderCode(stages.wsDeniedCode), cleanedUp);
    return done(SMOKE_EXIT.incomplete, cleanedUp);
  }
  const baseline = PAPER_AGENT_STRATEGIES.find((strategy) => strategy.kind === 'BASELINE')!;
  const decidedAt = now();
  const decision = evaluatePaperSignal(baseline, {
    network: OKX_CHAIN_INDEX[sample.chain] ?? sample.chain,
    walletTypes: sample.walletTypes,
    amountUsd: sample.amountUsd,
    signaledAtMs: sample.signaledAt.getTime(),
    receivedAtMs: decidedAt,
    origin: wsSample ? 'WEBSOCKET_LIVE' : 'REST_RECONCILIATION',
    poolCreatedAtMs: null,
    priceUsd: sample.priceUsd,
  }, decidedAt);
  stages.decisionCode = decision.code;
  log(`7. Локальный расчёт решения (${baseline.label}) по сигналу ${sample.symbol}: ${decision.state} · ${decision.code}. Это не серверная обработка: её подтверждает okx:signal-chain.`);

  if (stages.wsDeniedCode) return done(exitForProviderCode(stages.wsDeniedCode), cleanedUp);
  if (gaps.length > 0) return done(SMOKE_EXIT.incomplete, cleanedUp);
  return done(SMOKE_EXIT.ok, cleanedUp);
}
