'use client';

import Link from 'next/link';
import { SemiAutoProposals } from '@/components/SemiAutoProposals';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import useSWR from 'swr';
import { ApiError, api, errorMessage, fetcher } from '@/lib/api';
import { agentFailureVerdict, paperExitPlan, type AgentFailureKind } from '@memex/core';
import { EXIT_MODE_COPY, ExitModeCard } from '@/components/agent/ExitModeCard';

type MaybeNumber = number | null;
type AgentTab = 'overview' | 'positions' | 'history' | 'live';

interface AgentRun {
  id: string;
  tokenId: string | null;
  token: { id: string; symbol: string; name: string; logoUrl: string | null } | null;
  state: string;
  decisionCode: string | null;
  strategyLabel: string;
  chain: string;
  address: string;
  symbol: string;
  signaledAt: string;
  decidedAt: string | null;
  signalOrigin: string | null;
  entryAt: string | null;
  exitAt: string | null;
  entryPriceUsd: MaybeNumber;
  currentPriceUsd: MaybeNumber;
  realizedPnlUsd: MaybeNumber;
  unrealizedPnlUsd: MaybeNumber;
  maxMultiple: MaybeNumber;
  durationMs: MaybeNumber;
  positionUsd: MaybeNumber;
  totalCostsUsd: MaybeNumber;
  allocation?: {
    mode?: string; riskProfile?: string | null; allocatedUsd?: MaybeNumber; signalScore?: number; reason?: string;
    /** Ход плана выхода. Отсутствует у позиций, открытых до появления режимов. */
    exit?: ExitProgress | null;
  };
}

type ExitMode = 'TARGET' | 'PROTECTED' | 'LADDER' | 'TRAILING' | 'TRAILING_PURE';

interface ExitProgress {
  mode: ExitMode;
  label: string;
  description: string;
  remainingPct: number;
  legsFilled: number;
  legsTotal: number;
  stopPriceUsd: MaybeNumber;
  stopReason: string | null;
  nextTargetPriceUsd: MaybeNumber;
  exitReason: string | null;
}

interface LedgerEvent {
  id: string;
  eventType: string;
  amountUsd: MaybeNumber;
  freeAfterUsd: MaybeNumber;
  reservedAfterUsd: MaybeNumber;
  inPositionsAfterUsd: MaybeNumber;
  realizedPnlAfterUsd: MaybeNumber;
  equityAfterUsd: MaybeNumber;
  createdAt: string;
  allocation: null | {
    decisionCode: string | null;
    reason: string | null;
    signalScore: number | null;
    tokenId: string | null;
    symbol: string;
    token: { id: string; symbol: string; name: string; logoUrl: string | null } | null;
  };
}

interface PaperWallet {
  id: string;
  kind: 'ACTIVE' | 'SHADOW';
  mode: 'FIXED' | 'AUTOPILOT';
  riskProfile: string | null;
  status: string;
  /** Правило выхода счёта. Старый сервер поля не отдаёт — тогда это TARGET. */
  exitPlan?: { mode: ExitMode; label: string; description: string } | null;
  capital: {
    initialUsd: MaybeNumber;
    freeUsd: MaybeNumber;
    reservedUsd: MaybeNumber;
    inPositionsUsd: MaybeNumber;
    equityUsd: MaybeNumber;
    realizedPnlUsd: MaybeNumber;
    unrealizedPnlUsd: MaybeNumber;
    tradingFeesUsd: MaybeNumber;
    slippageUsd: MaybeNumber;
    networkCostsUsd: MaybeNumber;
    drawdownPct: MaybeNumber;
    dailyChangeUsd?: MaybeNumber;
  };
  limits: { reservePct: MaybeNumber; maxOpenPositions: number; maxPositionPct: MaybeNumber; drawdownStopPct: MaybeNumber };
  openPositions: number;
  ledger: LedgerEvent[];
}

interface Phase4Status {
  /*
   * Доступность диагностики. Может отсутствовать: статика и API
   * выкладываются раздельно, и старый сервер этого поля не отдаёт.
   */
  status?: 'AVAILABLE' | 'UNAVAILABLE';
  unavailable?: string[];
  mode: 'SEMI_AUTO';
  network: 'SOLANA';
  live: {
    enabled: boolean;
    executionEnabled: boolean;
    ready: boolean;
    blockers: string[];
    /** Ступень лестницы devnet. `null` — диагностика молчит. */
    stage?: string | null;
    stageBlockers?: string[];
    mainnetRequested?: boolean;
    /*
     * Состояние узла сети. Может отсутствовать: статика и API
     * выкладываются раздельно, и старый сервер этого поля не отдаёт.
     *
     * Адреса узла здесь нет и не будет. Наружу идут состояние и
     * время — этого хватает, чтобы понять, доверять ли ступени.
     */
    rpc?: {
      state: 'NOT_CONFIGURED' | 'NOT_RUN' | 'VERIFYING' | 'VERIFIED' | 'STALE' | 'FAILED';
      verifiedAt: string | null;
      expiresAt: string | null;
      stale: boolean;
    } | null;
  };
  funding: {
    enabled: boolean;
    source: 'DISABLED' | 'NOT_CONFIGURED';
    assets: Array<{ symbol: string; mint: string | null; minAmount: string; decimals: number; minConfirmations: number }>;
  };
  /*
   * Может отсутствовать: статика и API выкладываются раздельно, и
   * браузер какое-то время держит новую страницу против старого
   * сервера. Обязательное поле здесь означало бы белый экран у
   * человека, который ни при чём.
   */
  depositNetwork?: { status: 'VALIDATING' | 'PAUSED' | 'REVIEW_REQUIRED' | 'NOT_CONNECTED' } | null;
  /** Может отсутствовать: статика и API выкладываются раздельно. */
  signing?: {
    ready: boolean;
    network: string;
    broadcastAvailable: boolean;
    /** Необязательно: старый API этого поля не отдаёт. */
    status?: string;
  } | null;
  withdrawals: { enabled: boolean };
  compliance: { state: 'NOT_CONFIGURED' | 'REVIEW_REQUIRED' | 'APPROVED' };
  proposal: null;
}

interface PublicAgentData {
  paper: true;
  network: 'Solana';
  viewer: { isAdmin: boolean };
  health: 'OFF' | 'STANDBY' | 'ACTIVE' | 'DEGRADED' | 'REFUSED';
  control: { isEnabled: boolean; activeAllocationMode: 'FIXED' | 'AUTOPILOT' | null; learningModeEnabled: boolean };
  runtime: { running: boolean; lastActivityAt: string | null; queued: number };
  source: {
    transportMode: 'WEBSOCKET' | 'REST_ONLY' | 'DISABLED';
    socketState: string | null;
    lastSignalAt: string | null;
    lastRestSuccessAt: string | null;
    nextRestReconciliationAt: string | null;
    fallbackActive: boolean;
  };
  lastDecisionAt: string | null;
  notifications: { unread: number; telegramEnabled: boolean };
  metrics24h: { uniqueSignals: number; runs: number; openPositions: number; closedPositions: number; capitalUtilizationPct: number };
  wallet: PaperWallet | null;
  positions: AgentRun[];
  recentDecisions: AgentRun[];
  analytics: { strategyCount: number; decisionLatencyP50Ms: MaybeNumber; decisionLatencyP95Ms: MaybeNumber; validLatencySampleSize: number };
  phase4: Phase4Status;
}

interface AdminAgentData {
  control: { isEnabled: boolean; learningModeEnabled: boolean; activeAllocationMode: 'FIXED' | 'AUTOPILOT' | null };
  allocation?: { configured: boolean; accounts: PaperWallet[]; policies: Array<{ id: string; label: string; status: string; mode: string; riskProfile: string | null; createdAt: string }> };
  comparison: Array<{ key: string; label: string; kind: string; isBaseline: boolean; entries: number; closed: number; totalNetPnlUsd: MaybeNumber; winRatePct: MaybeNumber; worstDrawdownPct: MaybeNumber }>;
}

const STATUS: Record<PublicAgentData['health'], { label: string; detail: string; tone: string }> = {
  OFF: { label: 'Выключен', detail: 'Новые входы не создаются', tone: 'text-muted' },
  STANDBY: { label: 'Готов', detail: 'Ждёт подходящий сигнал', tone: 'text-accent' },
  ACTIVE: { label: 'Работает', detail: 'Обрабатывает сигналы', tone: 'text-up' },
  DEGRADED: { label: 'Резервный режим', detail: 'Основной канал временно недоступен', tone: 'text-warn' },
  REFUSED: { label: 'Остановлен защитой', detail: 'Разрешён только PAPER-режим', tone: 'text-down' },
};

/*
 * Подписи состояний run.
 *
 * `DEPOSIT` отсюда убран. Состояния с таким именем у run не бывает —
 * подпись была мёртвой, — но главное не это: в бумажном режиме
 * никакого внесения средств не существует, и слово «внесено» рядом
 * с готовящимся приёмом настоящих депозитов вводило бы в заблуждение
 * ровно там, где ошибиться дороже всего. Создание счёта называется
 * `INITIALIZE` и подписано в `LEDGER_LABELS`.
 */
const EVENT_LABELS: Record<string, string> = {
  RECEIVED: 'Сигнал получен', WAITING_ENTRY: 'Ожидается вход', ELIGIBLE: 'Сигнал подходит',
  ENTRY: 'Позиция открыта', EXIT: 'Позиция закрыта',
  RESERVE: 'Капитал зарезервирован', RELEASE: 'Резерв освобождён', RESET: 'Счёт перезапущен',
  PAPER_OPEN: 'Позиция открыта', PAPER_CLOSED: 'Позиция закрыта', SKIPPED: 'Сигнал пропущен',
  WAITING_PRICE: 'Ожидается цена', ERROR: 'Не удалось обработать сигнал',
};

export default function AgentPage() {
  const { data, error, mutate } = useSWR<PublicAgentData>('/paper-agent', fetcher, { refreshInterval: 3_000 });
  const [tab, setTab] = useState<AgentTab>('overview');
  useEffect(() => {
    if (new URL(window.location.href).searchParams.has('run')) setTab('history');
  }, []);
  if (error) return <AgentFailure error={error} onRetry={() => { void mutate(); }} />;
  if (!data) return <AgentSkeleton />;
  const tabs: Array<{ key: AgentTab; label: string }> = [
    { key: 'overview', label: 'Обзор' }, { key: 'positions', label: 'Позиции' },
    { key: 'history', label: 'История' }, { key: 'live', label: 'Подготовка LIVE' },
  ];
  return <div className="mx-auto max-w-6xl space-y-4 pb-24 sm:pb-14">
    <AgentHero data={data} status={STATUS[data.health]} />
    <AgentTabs tabs={tabs} tab={tab} onChange={setTab} />
    <div key={tab} id={`agent-panel-${tab}`} role="tabpanel" aria-labelledby={`agent-tab-${tab}`} className="agent-fade">
      {tab === 'overview' && <Overview data={data} onPositions={() => setTab('positions')} />}
      {tab === 'positions' && <Positions rows={data.positions} />}
      {tab === 'history' && <History rows={data.recentDecisions} ledger={data.wallet?.ledger ?? []} />}
      {tab === 'live' && <div className="space-y-4"><AgentModeBoundary data={data} /><SemiAutoProposals /><Phase4Foundation status={data.phase4} />{data.viewer.isAdmin && <LiveDiagnostics data={data} mutate={mutate} />}</div>}
    </div>
    <button className="inline-flex min-h-11 items-center gap-2 text-xs text-muted hover:text-white" onClick={() => setTab('live')}>
      <LockIcon /> LIVE заблокирован · {liveProgress(data.phase4)} <span aria-hidden>→</span>
    </button>
    <MobileAgentBar data={data} />
  </div>;
}

function liveProgress(phase4: Phase4Status) {
  const index = STAGE_ORDER.indexOf(phase4.live.stage ?? '');
  return index < 0 || phase4.status === 'UNAVAILABLE' ? 'готовность неизвестна' : `${Math.min(5, index + 1)} из 5 ступеней`;
}

export function AgentSettingsPage() {
  const { data, error, mutate } = useSWR<PublicAgentData>('/paper-agent', fetcher, { refreshInterval: 3_000 });
  const { data: admin, mutate: mutateAdmin } = useSWR<AdminAgentData>(data?.viewer.isAdmin ? '/admin/paper-agent' : null, fetcher, { refreshInterval: 5_000 });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<'FIXED' | 'AUTOPILOT'>('FIXED');
  const [capital, setCapital] = useState('1000');
  const [positions, setPositions] = useState('4');
  const [profile, setProfile] = useState<'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE'>('BALANCED');

  async function act(work: () => Promise<unknown>, success: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await work();
      await Promise.all([mutate(), mutateAdmin()]);
      setNotice(success);
    } catch (cause) {
      setNotice(errorMessage(cause, 'Не удалось выполнить действие'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (error) return <AgentFailure error={error} onRetry={() => { void mutate(); }} />;
  if (!data) return <AgentSkeleton />;
  if (!data.viewer.isAdmin) return <p role="status">Настройки доступны только администратору</p>;
  return <div className="mx-auto max-w-3xl space-y-4 pb-16">
    <Link href="/agent" className="inline-flex min-h-11 items-center text-sm text-muted">← К агенту</Link>
    <h1 className="text-2xl font-semibold">Настройки PAPER-агента</h1>
    <AdminSettings key={data.wallet?.id ?? 'new'} data={data} admin={admin} busy={busy} notice={notice}
      mode={mode} setMode={setMode} capital={capital} setCapital={setCapital}
      positions={positions} setPositions={setPositions} profile={profile} setProfile={setProfile} act={act} />
  </div>;
}

function LiveDiagnostics({ data, mutate }: { data: PublicAgentData; mutate: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  async function act(work: () => Promise<unknown>, success: string) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice(null);
    try { await work(); await mutate(); setNotice(success); }
    catch (error) { setNotice(errorMessage(error)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <><AdminLiveStage phase4={data.phase4} busy={busy} act={act} />{notice && <p role="status">{notice}</p>}</>;
}

/* ───────────────────────────── Анимация чисел ───────────────────────────── */

/**
 * Плавный переход числа к новому значению.
 *
 * Первый рендер показывает итоговое число сразу: страница не должна
 * начинать с «$0.00» и разгоняться — это выглядит как загрузка, а не
 * как оформление. Анимируется только изменение уже показанного
 * значения, и только там, где человек не просил меньше движения.
 */
function useAnimatedNumber(target: number, duration = 650) {
  const [value, setValue] = useState(target);
  const previous = useRef(target);

  useEffect(() => {
    const from = previous.current;
    previous.current = target;
    if (from === target) return;
    if (typeof window === 'undefined' || !window.requestAnimationFrame || prefersReducedMotion()) {
      setValue(target);
      return;
    }
    let frame = 0;
    const started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(from + (target - from) * eased);
      if (t < 1) frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [target, duration]);

  return value;
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ───────────────────────────────── Шапка ───────────────────────────────── */

function AgentHero({ data, status }: { data: PublicAgentData; status: (typeof STATUS)[PublicAgentData['health']] }) {
  const equity = data.wallet?.capital.equityUsd ?? null;
  const pnl = (data.wallet?.capital.realizedPnlUsd ?? 0) + (data.wallet?.capital.unrealizedPnlUsd ?? 0);
  const initial = data.wallet?.capital.initialUsd ?? 0;
  const pnlPct = initial > 0 ? (pnl / initial) * 100 : 0;
  const shown = useAnimatedNumber(equity ?? 0);

  return <header data-agent-hero className="agent-card panel p-4 sm:p-5" style={{ '--i': 0 } as CSSProperties}>
    <div className="flex items-center gap-2">
      <h1 className="text-lg font-semibold sm:text-2xl">Агент memex</h1>
      <span className="rounded border border-accent/30 px-1.5 py-0.5 text-[10px] font-semibold text-accent">PAPER</span>
      <span className="text-[10px] text-muted">Solana</span>
      {data.viewer.isAdmin && <Link href="/agent/settings" className="ml-auto inline-flex min-h-11 items-center text-xs text-muted hover:text-white">Настройки →</Link>}
    </div>
    <div role="status" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted" aria-label="Состояние агента">
      <span className={`inline-flex items-center gap-1.5 font-medium ${status.tone}`} title={status.detail}><span className="h-1.5 w-1.5 rounded-full bg-current" />{status.label}</span>
      <span>·</span><span>{data.source.transportMode === 'DISABLED' ? 'Нет сигналов' : data.source.fallbackActive || data.source.transportMode === 'REST_ONLY' ? 'Резервный REST-канал' : 'WebSocket'}</span>
      <span>·</span><span>{data.metrics24h.uniqueSignals} сигналов/24ч</span>
      <span>·</span><span>{positionCount(data.metrics24h.openPositions)}</span>
      <span>·</span><span>выход: {data.wallet?.exitPlan?.label ?? 'Цель 2×'}</span>
    </div>
    {data.health === 'DEGRADED' && <p className="mt-1 text-xs text-warn">{status.detail}</p>}
    <div className="mt-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-1" data-agent-capital>
      <div><div className="text-[11px] text-muted">Виртуальный капитал</div><div className="num mt-1 text-3xl font-semibold sm:text-4xl">{equity == null ? '—' : money(shown)}</div></div>
      {equity != null && <div className="pb-1 text-right"><div className="text-[11px] text-muted">За всё время</div><div className={`num mt-1 text-sm ${pnlClass(pnl)}`}>{money(pnl)} <span className="opacity-70">({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)</span></div></div>}
    </div>
  </header>;
}

function MobileAgentBar({ data }: { data: PublicAgentData }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const hero = document.querySelector('[data-agent-capital]');
    if (!hero || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setVisible(!entry.isIntersecting && entry.boundingClientRect.top < 60), { rootMargin: '-60px 0px 0px 0px' });
    observer.observe(hero);
    return () => observer.disconnect();
  }, []);
  if (!visible) return null;
  const status = STATUS[data.health];
  const pnl = data.wallet ? (data.wallet.capital.realizedPnlUsd ?? 0) + (data.wallet.capital.unrealizedPnlUsd ?? 0) : null;
  return <div data-agent-mobile-bar className="agent-fade fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-3 border-t border-border bg-panel px-4 pt-3 text-xs sm:hidden" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
    <div><span className="text-muted">PAPER </span><strong className="num">{money(data.wallet?.capital.equityUsd ?? null)}</strong><span className={`num ml-2 ${pnlClass(pnl)}`}>{money(pnl)}</span></div>
    <span className={status.tone}>● {status.label}</span>
  </div>;
}

/* ──────────────────────────────── Вкладки ──────────────────────────────── */

/**
 * Вкладки со скользящим индикатором.
 *
 * Полоска под активной вкладкой переезжает, а не перерисовывается:
 * взгляд следует за движением и не теряет, куда переключился.
 * Позиция меряется по кнопке, потому что ширина подписи разная.
 */
function AgentTabs({ tabs, tab, onChange }: { tabs: Array<{ key: AgentTab; label: string }>; tab: AgentTab; onChange: (value: AgentTab) => void }) {
  const listRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    if (!active) return;
    setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => setIndicator({ left: active.offsetLeft, width: active.offsetWidth }));
    observer?.observe(list);
    return () => observer?.disconnect();
  }, [tab, tabs.length]);

  return (
    <nav ref={listRef} role="tablist" aria-label="Разделы агента" className="relative flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((item) => (
        <button
          key={item.key}
          role="tab"
          id={`agent-tab-${item.key}`}
          aria-controls={`agent-panel-${item.key}`}
          aria-selected={tab === item.key}
          tabIndex={tab === item.key ? 0 : -1}
          onKeyDown={(event) => {
            const index = tabs.findIndex((candidate) => candidate.key === item.key);
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
            if (next == null) return;
            event.preventDefault(); onChange(tabs[next].key);
            listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}
          onClick={() => onChange(item.key)}
          className={`min-h-11 whitespace-nowrap px-2 text-xs transition-colors sm:px-4 sm:text-sm ${tab === item.key ? 'text-white' : 'text-muted hover:text-white'}`}
        >
          {item.label}
        </button>
      ))}
      {indicator && (
        <span
          aria-hidden
          className="agent-tab-indicator"
          style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
        />
      )}
    </nav>
  );
}

function AgentModeBoundary({ data }: { data: PublicAgentData }) {
  return <section aria-label="Режимы агента" className="grid gap-3 md:grid-cols-2">
    <article className="agent-card relative overflow-hidden rounded-xl border border-accent/40 bg-accent/10 p-4 sm:p-5" style={{ '--i': 1 } as CSSProperties}>
      <div aria-hidden className="agent-mode-bar absolute inset-y-0 left-0 w-1 bg-accent" />
      <div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold tracking-wider text-accent"><span className="sr-only">PAPER · АКТИВНЫЙ КОНТУР</span><span aria-hidden>PAPER · ВИРТУАЛЬНЫЙ СЧЁТ</span></span><span className="rounded-full bg-accent/15 px-2 py-1 text-[11px] text-accent">виртуальные средства</span></div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div><h2 className="font-semibold">Без риска для реальных средств</h2><p className="mt-1 text-sm text-muted">Баланс {money(data.wallet?.capital.equityUsd ?? null)} · решения и PnL изолированы от LIVE.</p></div>
        <span aria-hidden className="agent-orbit grid h-10 w-10 shrink-0 place-items-center rounded-full border border-accent/40 text-accent">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" />
        </span>
      </div>
    </article>
    <article className="agent-card rounded-xl border border-border bg-raised/50 p-4 sm:p-5" aria-disabled="true" style={{ '--i': 2 } as CSSProperties}>
      <div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold tracking-wider text-muted">LIVE · ЗАБЛОКИРОВАН</span><span className="rounded-full border border-border px-2 py-1 text-[11px] text-muted">реальные средства</span></div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div><h2 className="font-semibold text-muted">Только Semi-Auto после проверки</h2><p className="mt-1 text-sm text-muted">Предложение → подтверждение пользователя → исполнение. Auto недоступен.</p></div>
        <button type="button" disabled className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-xs text-muted">
          <LockIcon /> Недоступно
        </button>
      </div>
    </article>
  </section>;
}

function LockIcon() {
  return <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>;
}

function AgentActivity({ data }: { data: PublicAgentData }) {
  const decisions = [...data.recentDecisions].sort((a, b) => Date.parse(b.exitAt ?? b.decidedAt ?? b.signaledAt) - Date.parse(a.exitAt ?? a.decidedAt ?? a.signaledAt));
  const skips = decisions.filter((run) => run.state === 'SKIPPED');
  const reasons = new Map<string, number>();
  skips.forEach((run) => { const label = humanDecision(run.decisionCode, true); reasons.set(label, (reasons.get(label) ?? 0) + 1); });
  const events = decisions.filter((run) => run.state !== 'SKIPPED').flatMap((run) => {
    const symbol = run.token?.symbol ?? run.symbol;
    const entry = { id: `entry:${run.id}`, time: run.entryAt ?? run.decidedAt ?? run.signaledAt, symbol, label: 'Позиция открыта', detail: 'Сигнал → вход', pnl: null as MaybeNumber };
    if (run.state === 'PAPER_OPEN') return [entry];
    if (run.state === 'PAPER_CLOSED') return [
      ...(run.entryAt ? [entry] : []),
      { id: `exit:${run.id}`, time: run.exitAt ?? run.decidedAt ?? run.signaledAt, symbol, label: 'Позиция закрыта', detail: run.allocation?.exit?.exitReason ? exitReasonLabel(run.allocation.exit.exitReason) : 'Выход выполнен', pnl: run.realizedPnlUsd },
    ];
    return [{ id: `run:${run.id}`, time: run.decidedAt ?? run.signaledAt, symbol,
      label: EVENT_LABELS[run.state] ?? humanDecision(run.decisionCode), detail: humanDecision(run.decisionCode), pnl: null as MaybeNumber }];
  });
  // Partial exits do not change the run state; they only appear in the ledger.
  data.wallet?.ledger.filter((event) => event.eventType === 'PARTIAL_EXIT').forEach((event) => events.push({
    id: `ledger:${event.id}`, time: event.createdAt, symbol: event.allocation?.token?.symbol ?? event.allocation?.symbol ?? 'PAPER',
    label: 'Часть позиции продана', detail: 'Ступень фиксации', pnl: null,
  }));
  const recent = events.sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, skips.length ? 4 : 5);
  return <section aria-label="Последние события" className="panel p-4 sm:p-5">
    <h2 className="text-sm font-semibold">Последние события</h2>
    {recent.length === 0 && skips.length === 0 && <p className="mt-3 text-xs text-muted">Событий пока нет</p>}
    <ol className="mt-2 divide-y divide-border">
      {recent.map((event) => <li key={event.id} className="agent-row flex items-center gap-3 py-3 text-xs">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        <div className="min-w-0 flex-1"><div><strong>{event.symbol}</strong> · {event.label}</div><div className="mt-1 text-muted">{event.detail}</div></div>
        <div className="shrink-0 text-right"><time dateTime={event.time} title={timestamp(event.time)} className="text-muted">{new Date(event.time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</time>{event.pnl != null && <div className={`num ${pnlClass(event.pnl)}`}>{money(event.pnl)}</div>}</div>
      </li>)}
      {skips.length > 0 && <li className="agent-row py-3 text-xs text-muted"><details><summary className="min-h-6 cursor-pointer">Пропущено: {skips.length} · последние решения</summary><ul className="mt-2 flex flex-wrap gap-x-4 gap-y-2">{[...reasons].map(([reason, count]) => <li key={reason}>{reason}: {count}</li>)}</ul></details></li>}
    </ol>
  </section>;
}

function CompactPositions({ rows, onExpand }: { rows: AgentRun[]; onExpand: () => void }) {
  return <section aria-label="Открытые позиции" className="panel p-4 sm:p-5">
    <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Открытые позиции <span className="ml-1 text-muted">{rows.length}</span></h2>{rows.length > 0 && <button onClick={onExpand} className="min-h-8 text-xs text-accent">Подробнее →</button>}</div>
    {rows.length === 0 ? <p className="mt-3 text-sm text-muted">Ждёт подходящий сигнал</p> : <div className="mt-1 divide-y divide-border">
      {rows.slice(0, 5).map((run) => {
        const exit = run.allocation?.exit;
        const multiple = run.entryPriceUsd && run.currentPriceUsd != null ? run.currentPriceUsd / run.entryPriceUsd : null;
        const ratio = (price: MaybeNumber | undefined) => price != null && run.entryPriceUsd ? `${(price / run.entryPriceUsd).toFixed(2)}×` : '—';
        return <details key={run.id} className="agent-row group" data-compact-position={run.id}>
          <summary className="cursor-pointer list-none py-3 sm:flex sm:items-center sm:gap-6 [&::-webkit-details-marker]:hidden">
            <div className="flex items-center gap-2 sm:flex-1"><TokenMark run={run} /><strong className="min-w-0 flex-1 truncate text-sm">{run.token?.symbol ?? run.symbol}</strong><span className={`num text-sm ${pnlClass(run.unrealizedPnlUsd)}`}>{money(run.unrealizedPnlUsd)}</span><span className="num min-w-12 text-right text-xs text-muted">{multiple == null ? '—' : `${multiple.toFixed(2)}×`}</span></div>
            <div className="mt-1 flex justify-end gap-3 text-[11px] text-muted sm:mt-0"><span>Стоп {exit ? exit.stopPriceUsd == null ? 'без стопа' : ratio(exit.stopPriceUsd) : '—'}</span><span>Цель {exit?.nextTargetPriceUsd == null ? '—' : ratio(exit.nextTargetPriceUsd)}</span><span aria-hidden className="group-open:rotate-90">›</span></div>
          </summary>
          <div className="pb-3"><RunCard run={run} /></div>
        </details>;
      })}
      {rows.length > 5 && <button onClick={onExpand} className="min-h-11 text-xs text-accent">Все позиции: {rows.length} →</button>}
    </div>}
  </section>;
}

function Overview({ data, onPositions }: { data: PublicAgentData; onPositions: () => void }) {
  const capital = data.wallet?.capital;
  const costs = capital ? (capital.tradingFeesUsd ?? 0) + (capital.slippageUsd ?? 0) + (capital.networkCostsUsd ?? 0) : null;
  return <div className="space-y-4">
    <CompactPositions rows={data.positions} onExpand={onPositions} />
    {!capital && <p className="text-xs text-muted">PAPER-счёт ещё не создан</p>}
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <AgentActivity data={data} />
      {capital && <details className="panel p-4 sm:p-5"><summary className="flex min-h-6 cursor-pointer items-center justify-between text-sm font-semibold">Капитал подробнее <span aria-hidden className="text-muted">＋</span></summary>
        <div className="mt-4 grid grid-cols-2 gap-3"><Metric label="Свободно" value={money(capital.freeUsd)} tone="neutral" /><Metric label="В позициях" value={money(capital.inPositionsUsd)} tone="neutral" /><Metric label="Резерв" value={money(capital.reservedUsd)} tone="neutral" /><Metric label="Расходы" value={money(costs)} tone="neutral" /><Metric label="Просадка" value={percent(capital.drawdownPct)} tone="down" /><Metric label="Изменение 24ч" value={money(capital.dailyChangeUsd ?? null)} tone={pnlTone(capital.dailyChangeUsd ?? 0)} /></div>
        <h2 className="mt-5 text-sm font-medium">Кривая капитала</h2><EquityChart ledger={data.wallet!.ledger} fallback={capital.equityUsd} />
      </details>}
    </div>
  </div>;
}

/**
 * Что человек читает про приём депозитов.
 *
 * Формулировки описывают положение дел, а не устройство системы.
 * Ни адреса узла, ни номера слота, ни кода ошибки RPC здесь нет:
 * они создают ощущение поломки там, где идёт обычная проверка,
 * и заодно рассказывают постороннему, как устроен контур.
 */
/**
 * Стадии намерения для человека.
 *
 * Четыре шага вместо восьми внутренних состояний. Человеку важно,
 * докуда дошла подготовка, а не как называется строка в базе.
 */
/*
 * Полный путь, включая последний шаг.
 *
 * Отправка показана именно как шаг — заблокированный, но
 * присутствующий. Убрать её из списка значило бы дать прочитать
 * «подписано» как «отправлено»: человек, видящий четыре шага и
 * четвёртый выполненным, считает дело сделанным.
 */
const INTENT_STAGES = [
  { code: 'PROPOSAL', label: 'Предложение' },
  { code: 'AWAITING_APPROVAL', label: 'Подтверждение' },
  { code: 'SIGNING', label: 'Безопасная подпись' },
  { code: 'BROADCAST_LOCKED', label: 'Отправка заблокирована', locked: true },
] as const;

/**
 * Что человек видит о контуре подписи.
 *
 * Одно состояние, пришедшее с сервера, а не набор флагов. Раньше
 * рядом могли оказаться «KMS выключен» и «подписант готов»: их
 * считали из разных переменных, и они расходились. Из одного
 * состояния противоречивая пара не собирается в принципе.
 */
const SIGNING_STATUS_TEXT: Record<string, string> = {
  SIGNING_OFF: 'подпись выключена',
  PREPARING: 'подпись готовится',
  AWAITING_KEY_CONFIRMATION: 'ключ ещё не подтверждён',
  TEST_CIRCUIT_ONLY: 'только проверка',
  SIGNED_NOT_SENT: 'подписано, не отправлено',
  MANUAL_REVIEW: 'нужен разбор вручную',
};

const DEPOSIT_STATUS = {
  VALIDATING: {
    badge: 'сеть проверяется',
    title: 'Сеть депозитов проверяется',
    note: 'Идёт проверка перед приёмом переводов.',
    tone: 'border-border bg-raised text-muted',
    dot: 'bg-muted',
  },
  PAUSED: {
    badge: 'приостановлено',
    title: 'Депозиты временно приостановлены',
    note: 'Уже отправленные переводы сохранены и не потеряны.',
    tone: 'border-warn/30 bg-warn/10 text-warn',
    dot: 'bg-warn',
  },
  REVIEW_REQUIRED: {
    badge: 'требуется проверка',
    title: 'Требуется проверка',
    note: 'Мы разбираемся вручную. Ничего делать не нужно.',
    tone: 'border-down/30 bg-down/10 text-down',
    dot: 'bg-down',
  },
  NOT_CONNECTED: {
    badge: 'ещё не подключено',
    title: 'LIVE-пополнения ещё не подключены',
    note: 'Реальные переводы пока не принимаются.',
    tone: 'border-warn/30 bg-warn/10 text-warn',
    dot: 'bg-warn',
  },
  /*
   * Отдельное состояние, а не оттенок «ещё не подключено».
   *
   * «Не подключено» — утверждение о контуре; «не отвечает» —
   * признание, что о нём сейчас ничего не известно. Показывать
   * первое вместо второго значит выдавать догадку за факт.
   */
  UNAVAILABLE: {
    badge: 'состояние неизвестно',
    title: 'Не удалось прочитать состояние пополнений',
    note: 'На PAPER-счёт это не влияет: он показан выше и работает.',
    tone: 'border-border bg-raised text-muted',
    dot: 'bg-muted',
  },
} as const;

/**
 * Ступени подготовки к LIVE — словами, а не кодами.
 *
 * Список показывает, где контур находится сейчас и сколько ещё
 * впереди. Отдельно названа верхняя ступень: mainnet не следующая
 * галочка на этом пути, а стена.
 *
 * Кодов блокировок здесь нет намеренно. `SIGNER_KEY_NOT_OBSERVED`
 * ничего не говорит человеку и заодно описывает постороннему
 * внутреннее устройство.
 */
const STAGE_TEXT: Record<string, string> = {
  PAPER_READY: 'Бумажный режим работает',
  DEVNET_SIGNING_CONFIGURED: 'Подпись настроена',
  DEVNET_IDENTITY_VERIFIED: 'Ключ подтверждён',
  DEVNET_FUNDING_RECONCILED: 'Сверка зачислений работает',
  DEVNET_SIGNATURE_PROVEN: 'Подпись проверена на devnet',
  MAINNET_BLOCKED: 'Все проверки devnet пройдены',
};

const STAGE_ORDER = [
  'PAPER_READY',
  'DEVNET_SIGNING_CONFIGURED',
  'DEVNET_IDENTITY_VERIFIED',
  'DEVNET_FUNDING_RECONCILED',
  'DEVNET_SIGNATURE_PROVEN',
  'MAINNET_BLOCKED',
];

/**
 * Состояние узла сети — словами.
 *
 * Шесть состояний вместо одного «проверено». Раньше готовность сети
 * выводилась из наличия адреса узла в настройках, и человек читал
 * «проверено» там, где никто ничего не проверял. Разница между «не
 * настроен», «не проверялся» и «устарел» — это разница между «нечего
 * делать», «сделайте проверку» и «сделайте её заново».
 */
const RPC_TEXT: Record<string, { label: string; tone: string }> = {
  NOT_CONFIGURED: { label: 'узел не настроен', tone: 'text-muted' },
  NOT_RUN: { label: 'проверка не выполнялась', tone: 'text-muted' },
  VERIFYING: { label: 'проверяется', tone: 'text-accent' },
  VERIFIED: { label: 'проверен', tone: 'text-up' },
  STALE: { label: 'проверка устарела', tone: 'text-warn' },
  FAILED: { label: 'проверка не прошла', tone: 'text-down' },
};

function RpcState({ rpc }: { rpc: NonNullable<Phase4Status['live']['rpc']> }) {
  /*
   * Незнакомое состояние не выдаётся за известное.
   *
   * Статика и API выкладываются раздельно: новый сервер может
   * прислать состояние, о котором эта страница ещё не знает.
   * Подставить сюда «проверен» значило бы соврать из-за рассинхрона
   * выкладки.
   */
  const text = RPC_TEXT[rpc.state] ?? { label: 'состояние неизвестно', tone: 'text-muted' };

  return (
    <p className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs" data-rpc-state={rpc.state}>
      <span className="text-muted">Узел devnet:</span>
      <span className={text.tone}>{text.label}</span>
      {rpc.verifiedAt && (
        <span className="text-muted">
          · последняя успешная проверка {new Date(rpc.verifiedAt).toLocaleString('ru-RU')}
        </span>
      )}
      {rpc.stale && <span className="text-warn">· требуется повторная проверка</span>}
    </p>
  );
}

function LiveStage({ live }: { live: Phase4Status['live'] }) {
  /*
   * Диагностика молчит — ступени нет. Показывать нижнюю
   * «на всякий случай» нельзя: это утверждение о состоянии,
   * которого никто не проверял.
   */
  if (live.stage == null) {
    return (
      <p className="mt-4 rounded-lg border border-border bg-raised/60 p-3 text-xs text-muted" data-live-stage="UNKNOWN">
        Готовность LIVE сейчас не читается. На PAPER-счёт это не влияет.
      </p>
    );
  }

  const reached = STAGE_ORDER.indexOf(live.stage);
  const done = Math.max(0, reached);
  const total = STAGE_ORDER.length - 1;
  return (
    <div className="mt-4 rounded-lg border border-border p-3" data-live-stage={live.stage}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-semibold tracking-wider text-muted">ПОДГОТОВКА LIVE · DEVNET</p>
        <span className="num text-[11px] text-muted">{done} из {total}</span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-border" aria-hidden>
        <div className="agent-bar h-full rounded-full bg-accent" style={{ width: `${(done / total) * 100}%` }} />
      </div>
      <ol className="mt-3 space-y-1.5 text-xs" role="list">
        {STAGE_ORDER.map((stage, index) => {
          const isDone = index <= reached;
          const isNext = index === reached + 1;
          return (
            <li key={stage} className="flex items-start gap-2" data-stage-done={isDone ? 'true' : undefined}>
              <span aria-hidden className={`mt-px grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[9px] ${isDone ? 'agent-step-done border-accent bg-accent text-white' : isNext ? 'border-accent/60 text-accent' : 'border-border text-muted'}`}>
                {isDone ? '✓' : ''}
              </span>
              <span className={isDone ? 'text-white' : 'text-muted'}>{STAGE_TEXT[stage]}</span>
            </li>
          );
        })}
      </ol>
      {/*
        Состояние узла показывается рядом со ступенями намеренно.
        Ступень «Ключ подтверждён» требует проверенной сети, и без
        этой строки человек не мог бы понять, почему лестница стоит.
      */}
      {live.rpc && <RpcState rpc={live.rpc} />}
      {/*
        Формулировка выбрана так, чтобы её нельзя было прочитать как
        «скоро включим». Переход в mainnet — отдельное решение с
        отдельно. Это не следующая ступень.
      */}
      <p className="mt-3 text-xs leading-relaxed text-muted">
        Реальные средства не задействованы ни на одной ступени. Переход в основную сеть
        этим путём не открывается.
      </p>
    </div>
  );
}

function Phase4Foundation({ status }: { status: Phase4Status }) {
  const usdc = status.funding.assets.find((asset) => asset.symbol === 'USDC');
  // Нет поля или незнакомое значение — показываем «ещё не подключено».
  // Любой другой выбор по умолчанию обещал бы работающие пополнения.
  /*
   * Три разных случая, и путать их нельзя:
   *   • раздел ответил и назвал состояние — показываем его;
   *   • раздел не ответил (`status: 'UNAVAILABLE'`) — говорим,
   *     что состояние неизвестно;
   *   • поля нет вовсе (старый сервер) — прежнее «не подключено».
   */
  const diagnosticsDown = status.status === 'UNAVAILABLE' && status.depositNetwork == null;
  const deposit = diagnosticsDown
    ? DEPOSIT_STATUS.UNAVAILABLE
    : DEPOSIT_STATUS[status.depositNetwork?.status as keyof typeof DEPOSIT_STATUS] ??
      DEPOSIT_STATUS.NOT_CONNECTED;
  const steps = ['Ожидаем перевод', 'Обнаружен', 'Подтверждения', 'Финальность', 'Зачисление'];
  return <section className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_.8fr]" aria-label="Подготовка LIVE">
    <article className="agent-card panel p-4 sm:p-5" style={{ '--i': 2 } as CSSProperties}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-wider text-muted">ПОПОЛНЕНИЕ SOLANA</p>
          <h2 className="mt-1 font-semibold">{deposit.title}</h2>
          <p className="mt-1 text-xs text-muted">{deposit.note}</p>
        </div>
        <span
          role="status"
          data-deposit-status={
            diagnosticsDown ? 'UNAVAILABLE' : status.depositNetwork?.status ?? 'NOT_CONNECTED'
          }
          className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs transition-colors duration-200 motion-reduce:transition-none ${deposit.tone}`}
        >
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${deposit.dot}`} />
          {deposit.badge}
        </span>
      </div>
      <div className="agent-steps mt-5 grid grid-cols-5 gap-1" role="list" aria-label="Этапы пополнения">
        {steps.map((step, index) => <div key={step} role="listitem" className="relative min-w-0 text-center"><div className="relative z-10 mx-auto grid h-7 w-7 place-items-center rounded-full border border-border bg-raised text-[11px] text-muted">{index + 1}</div><div className="mt-2 break-words text-[10px] leading-tight text-muted sm:text-xs">{step}</div></div>)}
      </div>
      <div className="mt-5 rounded-lg border border-border p-3" aria-label="Подготовка подписи">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-xs font-semibold tracking-wider text-muted">ПОДГОТОВКА ПОДПИСИ</p>
          <span className="text-[11px] text-muted">
            сеть {status.signing?.network ?? 'devnet'}
            {' · '}
            <span data-signing-status={status.signing?.status ?? 'SIGNING_OFF'}>
              {SIGNING_STATUS_TEXT[status.signing?.status ?? 'SIGNING_OFF']
                ?? 'состояние неизвестно'}
            </span>
          </span>
        </div>
        <ol className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" role="list">
          {INTENT_STAGES.map((stage) => (
            <li
              key={stage.code}
              data-intent-stage={stage.code}
              data-locked={'locked' in stage ? 'true' : undefined}
              className={`rounded-lg border p-2 transition-colors duration-200 motion-reduce:transition-none ${
                'locked' in stage
                  ? 'border-warn/25 bg-warn/5'
                  : 'border-border bg-raised'
              }`}
            >
              <div className={`text-[11px] ${'locked' in stage ? 'text-warn' : 'text-muted'}`}>
                {stage.label}
              </div>
            </li>
          ))}
        </ol>
        {/*
          Формулировка выбрана так, чтобы её нельзя было прочитать
          как «сделки работают». Подпись и отправка — разные события,
          и второго на этом этапе нет вовсе.
        */}
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Подпись не означает отправку: подписанная транзакция никуда не уходит.
          Отправка ещё не подключена.
        </p>
      </div>

      <div className="mt-5 rounded-lg border border-warn/20 bg-warn/5 p-3 text-xs leading-relaxed text-muted">
        Отправлять можно будет только в сети Solana. USDC принимается только с официальным mint <span className="num break-all text-white">{usdc?.mint ?? '—'}</span>. Поддельный mint и сумма ниже {usdc?.minAmount ?? '—'} USDC отклоняются.
      </div>
    </article>
    <article className="agent-card panel p-4 sm:p-5" style={{ '--i': 3 } as CSSProperties}>
      <p className="text-xs font-semibold tracking-wider text-muted">SEMI-AUTO</p><h2 className="mt-1 font-semibold">Подтверждение до исполнения</h2>
      <dl className="mt-4 space-y-2 text-sm"><div className="flex justify-between gap-3"><dt className="text-muted">Сеть</dt><dd>Solana · devnet</dd></div><div className="flex justify-between gap-3"><dt className="text-muted">Сумма и комиссии</dt><dd className="text-muted">появятся в предложении</dd></div><div className="flex justify-between gap-3"><dt className="text-muted">Compliance</dt><dd className="text-warn">не настроен</dd></div></dl>
      <LiveStage live={status.live} />
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
        <button type="button" disabled className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-raised px-4 text-sm text-muted"><LockIcon /> Подтверждение LIVE недоступно</button>
        <button type="button" disabled className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-down/25 bg-down/5 px-4 text-sm text-muted"><LockIcon /> LIVE kill switch недоступен</button>
        <Link href="/terminal/" className="agent-cta inline-flex min-h-11 items-center justify-center rounded-lg border border-accent/40 px-4 text-sm text-accent hover:border-accent hover:text-white">Открыть терминал →</Link>
      </div>
    </article>
  </section>;
}

function Positions({ rows }: { rows: AgentRun[] }) {
  if (!rows.length) return <p className="py-3 text-sm text-muted">Ждёт подходящий сигнал</p>;
  return <section className="grid gap-3 md:grid-cols-2">{rows.map((run, index) => <RunCard key={run.id} run={run} index={index} />)}</section>;
}

function History({ rows, ledger }: { rows: AgentRun[]; ledger: LedgerEvent[] }) {
  if (!rows.length && !ledger.length) return <StateCard title="История пока пуста">Решения и изменения PAPER-счёта появятся после первых сигналов.</StateCard>;
  return <section className="panel agent-list divide-y divide-border overflow-hidden">
    {rows.slice(0, 40).map((run) => <div key={`run:${run.id}`} className="agent-row flex flex-wrap items-center gap-3 p-4"><TokenMark run={run} /><div className="min-w-0 flex-1"><div className="text-sm font-medium">{EVENT_LABELS[run.state] ?? humanDecision(run.decisionCode)}{run.state === 'SKIPPED' && <span className="text-muted"> · {humanDecision(run.decisionCode)}</span>}{run.allocation?.exit?.exitReason ? <span className="text-muted"> · {exitReasonLabel(run.allocation.exit.exitReason)}</span> : null}</div><div className="mt-1 text-xs text-muted">{timestamp(run.decidedAt ?? run.signaledAt)} · {run.strategyLabel}</div></div><div className={`num text-sm ${pnlClass(run.realizedPnlUsd ?? run.unrealizedPnlUsd)}`}>{money(run.realizedPnlUsd ?? run.unrealizedPnlUsd)}</div></div>)}
    {ledger.slice(0, Math.max(0, 40 - rows.length)).map((event) => <LedgerRow key={`ledger:${event.id}`} event={event} />)}
  </section>;
}

const LEDGER_LABELS: Record<string, string> = {
  INITIALIZE: 'Создан PAPER-счёт',
  OPEN: 'Капитал направлен в PAPER-позицию',
  PARTIAL_EXIT: 'Часть PAPER-позиции зафиксирована',
  CLOSE: 'PAPER-позиция закрыта',
};

/**
 * Почему позиция закрылась — словами.
 *
 * Код причины идёт с сервера и в журнале остаётся кодом; здесь он
 * переводится один раз. Незнакомая причина получает нейтральную подпись без внутреннего кода.
 */
const EXIT_REASON_LABELS: Record<string, string> = {
  TARGET_REACHED: 'цель достигнута',
  TAKE_PROFIT_LEG: 'ступень фиксации',
  STOP_LOSS: 'стоп-лосс',
  BREAKEVEN_STOP: 'стоп в безубытке',
  TRAILING_STOP: 'трейлинг-стоп',
  TIME_STOP: 'выход по времени',
  MAX_HOLD: 'предел удержания',
  MANUAL_PANIC: 'закрыто вручную (Panic)',
  DRAWDOWN_BREAKER: 'предохранитель по просадке',
};

const EXIT_MODES = EXIT_MODE_COPY;

function exitReasonLabel(code: string) { return EXIT_REASON_LABELS[code] ?? 'Другая причина выхода'; }

function LedgerRow({ event }: { event: LedgerEvent }) {
  const tokenId = event.allocation?.token?.id ?? event.allocation?.tokenId;
  const symbol = event.allocation?.token?.symbol ?? event.allocation?.symbol;
  return <div className="agent-row flex flex-wrap items-center gap-3 p-4">
    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-raised text-xs font-semibold text-muted" aria-hidden="true">$</div>
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium">{LEDGER_LABELS[event.eventType] ?? 'Изменение PAPER-счёта'}</div>
      <div className="mt-1 text-xs text-muted">{timestamp(event.createdAt)}{symbol ? ` · ${symbol}` : ''}</div>
    </div>
    <div className="flex items-center gap-3">
      <div className="num text-right text-sm"><div>{money(event.amountUsd)}</div><div className="text-xs text-muted">баланс {money(event.equityAfterUsd)}</div></div>
      {tokenId && <Link href={`/terminal/?token=${encodeURIComponent(tokenId)}`} className="inline-flex min-h-11 items-center text-sm font-medium text-accent hover:text-white" aria-label={`Открыть график ${symbol ?? 'токена'}`}>График →</Link>}
    </div>
  </div>;
}

/**
 * Карточка открытой PAPER-позиции.
 *
 * Полоса под шапкой показывает, где цена относительно цели 2×:
 * человеку важнее «сколько осталось до выхода», чем сырой PnL.
 */
function RunCard({ run, index = 0 }: { run: AgentRun; index?: number }) {
  const exit = run.allocation?.exit ?? null;
  const multiple = run.entryPriceUsd && run.currentPriceUsd ? run.currentPriceUsd / run.entryPriceUsd : null;
  /*
   * Полоса ведёт к ближайшей цели плана — первой ступени или полной
   * цели, — а не всегда к 2×: у лестницы первая ступень на 1.6×,
   * и полоса до 2× показывала бы «ещё далеко» там, где продажа уже прошла.
   */
  const targetMultiple = exit?.nextTargetPriceUsd && run.entryPriceUsd ? exit.nextTargetPriceUsd / run.entryPriceUsd : 2;
  const progress = multiple == null ? null : Math.max(0, Math.min(100, ((multiple - 1) / Math.max(0.01, targetMultiple - 1)) * 100));
  const stopMultiple = exit?.stopPriceUsd && run.entryPriceUsd ? exit.stopPriceUsd / run.entryPriceUsd : null;
  const pnl = run.unrealizedPnlUsd ?? 0;
  return <article className="agent-card panel p-4" style={{ '--i': index } as CSSProperties}>
    <div className="flex items-start gap-3">
      <TokenMark run={run} />
      <div className="min-w-0 flex-1"><div className="truncate font-semibold">{run.token?.symbol ?? run.symbol}</div><div className="truncate text-xs text-muted">{run.token?.name ?? run.address}</div></div>
      <div className="text-right">
        <div className={`num text-sm font-semibold ${pnlClass(run.unrealizedPnlUsd)}`}>{money(run.unrealizedPnlUsd)}</div>
        {multiple != null && <div className={`num text-[11px] ${pnlClass(pnl)}`}>{multiple.toFixed(2)}×</div>}
      </div>
    </div>
    {progress != null && (
      <div className="mt-3" aria-label={`Путь к цели ${targetMultiple.toFixed(2)}×`}>
        <div className="h-1.5 overflow-hidden rounded-full bg-border"><div className={`agent-bar h-full rounded-full ${pnl >= 0 ? 'bg-up' : 'bg-down'}`} style={{ width: `${progress}%` }} /></div>
        <div className="mt-1 flex justify-between text-[10px] text-muted"><span>вход</span><span>{exit && exit.legsTotal > 0 && exit.legsFilled < exit.legsTotal ? `ступень ${exit.legsFilled + 1}/${exit.legsTotal} · ${targetMultiple.toFixed(2)}×` : `цель ${targetMultiple.toFixed(2)}×`}</span></div>
      </div>
    )}
    {exit && (
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted" data-exit-mode={exit.mode}>
        <span className="text-accent">{exit.label}</span>
        {exit.remainingPct < 100 && <span>открыто {Math.round(exit.remainingPct)}%</span>}
        {stopMultiple != null && <span className={stopMultiple >= 1 ? 'text-up' : ''}>стоп {stopMultiple.toFixed(2)}× {exit.stopReason === 'TRAILING_STOP' ? '(трейлинг)' : exit.stopReason === 'BREAKEVEN_STOP' ? '(безубыток)' : ''}</span>}
        {stopMultiple == null && <span>без стопа</span>}
      </div>
    )}
    <div className="mt-3 grid grid-cols-2 gap-3"><Metric label="Позиция" value={money(run.positionUsd)} tone="neutral" /><Metric label="Максимум" value={run.maxMultiple == null ? '—' : `${run.maxMultiple.toFixed(2)}×`} tone="neutral" /></div>
    {run.tokenId && <Link href={`/terminal/?token=${encodeURIComponent(run.tokenId)}`} className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-accent hover:text-white">Открыть график →</Link>}
  </article>;
}

/**
 * То же состояние, но для того, кто его чинит.
 *
 * Разница с пользовательским видом не в оформлении, а в назначении.
 * Человеку нужен ответ «работает или нет»; дежурному — «что именно
 * снять, чтобы поднялось». Поэтому здесь коды блокировок и названия
 * неотвечающих разделов: это адресаты, а не оттенки одного текста.
 *
 * Чего здесь всё равно нет: идентификатора ключа, адреса узла,
 * строки подключения и текста ошибки. Права администратора в
 * интерфейсе не делают эти вещи безопасными на экране — они уходят
 * в журнал, где у них есть `reqId` и срок хранения.
 */
function AdminLiveStage({ phase4, busy, act }: {
  phase4: Phase4Status;
  busy: boolean;
  act: (work: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const unavailable = phase4.unavailable ?? [];
  const stageBlockers = phase4.live.stageBlockers ?? [];
  const rpc = phase4.live.rpc ?? null;

  return (
    <section className="panel p-4 sm:p-5" aria-label="Диагностика подготовки LIVE">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Подготовка LIVE · диагностика</h2>
        <span className="text-xs text-muted" data-admin-stage={phase4.live.stage ?? 'UNKNOWN'}>
          ступень {phase4.live.stage ?? 'неизвестна'}
        </span>
      </div>

      {unavailable.length > 0 && (
        <p className="mt-3 rounded-lg border border-warn/25 bg-warn/5 p-3 text-xs text-warn" role="status">
          Разделы диагностики не отвечают: {unavailable.join(', ')}. Причина записана в журнал
          сервера. PAPER-режим при этом работает.
        </p>
      )}

      <dl className="mt-3 space-y-2 text-xs">
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="text-muted">Блокировки ступени</dt>
          <dd className="num text-right">{stageBlockers.length > 0 ? stageBlockers.join(', ') : '—'}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="text-muted">Блокировки LIVE</dt>
          <dd className="num text-right">{phase4.live.blockers.join(', ') || '—'}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="text-muted">Запрошен mainnet</dt>
          <dd className={phase4.live.mainnetRequested ? 'text-down' : 'text-muted'}>
            {phase4.live.mainnetRequested ? 'да — переход запрещён' : 'нет'}
          </dd>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="text-muted">Узел devnet</dt>
          <dd className="text-right" data-admin-rpc={rpc?.state ?? 'UNKNOWN'}>
            {rpc ? RPC_TEXT[rpc.state]?.label ?? rpc.state : 'не читается'}
            {rpc?.expiresAt && (
              <span className="text-muted"> · годно до {new Date(rpc.expiresAt).toLocaleString('ru-RU')}</span>
            )}
          </dd>
        </div>
      </dl>

      {/*
        Проверку запускает только администратор, и адрес узла она
        берёт с сервера: тела у запроса нет вовсе. Прислать сюда свой
        URL значило бы поднять ступень готовности проверкой чужого
        узла.

        Действие только читает сеть — ничего не подписывает и не
        отправляет, — и попадает в журнал.
      */}
      <button
        type="button"
        disabled={busy || rpc?.state === 'NOT_CONFIGURED' || rpc?.state === 'VERIFYING'}
        className="btn-ghost mt-4"
        data-action="verify-devnet"
        onClick={() => {
          void act(
            () => api('/admin/live/devnet-network/check', { method: 'POST' }),
            'Проверка узла devnet выполнена',
          );
        }}
      >
        Проверить devnet
      </button>
      <p className="mt-2 text-xs leading-relaxed text-muted">
        Проверка только читает сеть: health, genesis hash и доступность методов. Ничего не
        подписывается и не отправляется. Адрес узла задаётся на сервере и здесь не показывается.
      </p>
    </section>
  );
}

function AdminSettings(props: {
  data: PublicAgentData; admin?: AdminAgentData; busy: boolean; notice: string | null;
  mode: 'FIXED' | 'AUTOPILOT'; setMode: (value: 'FIXED' | 'AUTOPILOT') => void;
  capital: string; setCapital: (value: string) => void; positions: string; setPositions: (value: string) => void;
  profile: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE'; setProfile: (value: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE') => void;
  act: (work: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const { data, admin, busy, notice, mode, setMode, capital, setCapital, positions, setPositions, profile, setProfile, act } = props;
  const [exitMode, setExitMode] = useState<ExitMode>(data.wallet?.exitPlan?.mode ?? 'TARGET');
  const [exitTweaks, setExitTweaks] = useState<{ stopLossPct: string; trailingPct: string; maxHoldHours: string }>({ stopLossPct: '', trailingPct: '', maxHoldHours: '' });
  const openPositions = data.metrics24h.openPositions;
  useEffect(() => {
    const wallet = data.wallet;
    if (!wallet) return;
    setCapital(String(wallet.capital.initialUsd ?? 1000)); setMode(wallet.mode);
    setPositions(String(wallet.limits.maxOpenPositions));
    if (wallet.riskProfile === 'CONSERVATIVE' || wallet.riskProfile === 'BALANCED' || wallet.riskProfile === 'AGGRESSIVE') setProfile(wallet.riskProfile);
  }, [data.wallet?.id]);

  const [step, setStep] = useState(1);
  const capitalNumber = Number(capital.replace(',', '.'));
  const validCapital = capital.trim() !== '' && Number.isFinite(capitalNumber) && capitalNumber > 0
    && (mode !== 'FIXED' || (Number.isInteger(Number(positions)) && Number(positions) > 0 && Number(positions) <= 100));
  const overrides: Record<string, number> = {};
  let exitError = '';
  if (exitMode !== 'TARGET') for (const [key, value] of Object.entries(exitTweaks)) {
    if (key === 'trailingPct' && exitMode === 'PROTECTED') continue;
    if (!value.trim()) continue;
    const parsed = Number(value.replace(',', '.'));
    if (!Number.isFinite(parsed)) exitError = 'Введите корректные числа';
    else overrides[key] = parsed;
  }
  let plan: ReturnType<typeof paperExitPlan> | null = null;
  try { plan = paperExitPlan(exitMode, overrides); }
  catch { exitError = 'Проверьте стоп и время удержания'; }
  const exitLabel = EXIT_MODES.find((item) => item.key === exitMode)!.label;
  const profileLabel = { CONSERVATIVE: 'Conservative', BALANCED: 'Balanced', AGGRESSIVE: 'Aggressive' }[profile];
  const summary = `${money(capitalNumber)}, ${mode === 'FIXED' ? `Fixed: до ${positions} позиций` : `Autopilot ${profileLabel}`}, ${exitLabel}: ${plan?.legs.map((leg) => `${leg.sellPct}% на ${leg.multiple}×`).join(', ') || (plan?.targetMultiple ? `выход на ${plan.targetMultiple}×` : '')}${plan?.stopLossPct != null ? `, стоп −${plan.stopLossPct}%` : plan?.trailingPct != null ? `, трейлинг −${plan.trailingPct}% с момента входа` : ', без стопа'}`;
  return <div className="space-y-4">
    <div aria-label="Управление агентом" className="sticky z-30 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-panel p-3" style={{ top: 'calc(var(--header, 60px) + env(safe-area-inset-top, 0px))' }}>
      <div><p className={`text-xs font-medium ${STATUS[data.health].tone}`}>● {STATUS[data.health].label}</p><p className="mt-1 text-[11px] text-muted">Stop — пауза входов</p></div>
      <div className="flex gap-2"><button disabled={busy || (!data.control.isEnabled && !data.wallet)} className={data.control.isEnabled ? 'btn-sell' : 'btn-buy'} onClick={() => {
        if (!window.confirm(data.control.isEnabled ? 'Остановить новые входы агента?' : 'Запустить PAPER-агента?')) return;
        void act(() => api('/admin/paper-agent', { method: 'PUT', body: JSON.stringify({ isEnabled: !data.control.isEnabled }) }), data.control.isEnabled ? 'Новые входы остановлены' : 'PAPER-агент запущен');
      }}>{data.control.isEnabled ? 'Stop' : 'Start PAPER'}</button>
      <button type="button" data-action="panic-close" disabled={busy || openPositions === 0} className="btn-sell" title="Закрывает позиции; новые входы остаются разрешены" onClick={() => {
        if (!window.confirm(`Закрыть ${openPositions} открытых PAPER-позиций по текущей цене? Новые входы останутся разрешены.`)) return;
        void act(() => api('/admin/paper-agent/panic', { method: 'POST', body: JSON.stringify({ confirm: true }) }), 'Закрытие позиций выполнено');
      }}>Panic · закрыть {openPositions}</button></div>
    </div>
    {notice && <p role="status" className="rounded-lg border border-accent/30 bg-accent/10 p-3 text-sm">{notice}</p>}
    <section className="panel p-4 sm:p-5" aria-label="Мастер настройки">
      <ol aria-label="Шаги настройки" className="mb-5 grid grid-cols-3 gap-2 text-xs">
        {['Капитал', 'Выход', 'Подтверждение'].map((label, index) => <li key={label} aria-current={step === index + 1 ? 'step' : undefined} className={`border-b-2 pb-3 ${step === index + 1 ? 'border-accent text-accent' : 'border-border text-muted'}`}>{index + 1}. {label}</li>)}
      </ol>
      <fieldset disabled={busy} className="min-w-0">
      <div key={step} className="agent-fade">
      {step === 1 && (    <div><h2 className="font-semibold">Распределение виртуального капитала</h2><div className="mt-4 grid gap-3 sm:grid-cols-2">{(['FIXED', 'AUTOPILOT'] as const).map((item) => <button key={item} type="button" aria-pressed={mode === item} onClick={() => setMode(item)} className={`min-h-24 rounded-xl border p-4 text-left transition-colors ${mode === item ? 'border-accent bg-accent/10' : 'border-border bg-raised hover:border-accent/40'}`}><div className="font-semibold">{item === 'FIXED' ? 'Fixed' : 'Autopilot'}</div><p className="mt-1 text-xs leading-relaxed text-muted">{item === 'FIXED' ? 'Капитал после резерва делится поровну между заданным числом позиций.' : 'Профиль задаёт резерв, размер позиции, число входов и предел просадки.'}</p></button>)}</div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs text-muted">PAPER-капитал, USD<input className="input mt-1" inputMode="decimal" value={capital} onChange={(event) => setCapital(event.target.value)} /></label>{mode === 'FIXED' ? <label className="text-xs text-muted">Максимум позиций<input className="input mt-1" inputMode="numeric" value={positions} onChange={(event) => setPositions(event.target.value)} /></label> : <label className="text-xs text-muted">Профиль<select className="input mt-1" value={profile} onChange={(event) => setProfile(event.target.value as typeof profile)}><option value="CONSERVATIVE">Conservative · 60/40</option><option value="BALANCED">Balanced · 70/30</option><option value="AGGRESSIVE">Aggressive · 80/20</option></select></label>}</div>
    </div>)}
      {step === 2 && (    <div aria-label="Правило выхода">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="font-semibold">Правило выхода</h2><span className="text-xs text-muted">сейчас: {data.wallet?.exitPlan?.label ?? 'Цель 2×'}</span></div>
      <p className="mt-1 text-sm text-muted">Применяется к позициям, открытым после настройки. Уже открытые ведутся по своему плану до конца.</p>
      <div className="mt-4 grid gap-3" role="radiogroup" aria-label="Режим выхода">
        {EXIT_MODES.map((item, index) => (
          <ExitModeCard
            key={item.key}
            copy={item}
            plan={exitMode === item.key && plan ? plan : undefined}
            selected={exitMode === item.key}
            index={index}
            onSelect={() => setExitMode(item.key)}
            onKeyDown={(event) => {
              /*
               * Стрелки ходят по группе, как у нативных radio: выбор
               * следует за фокусом, и человек с клавиатуры не обязан
               * нажимать Enter на каждой карточке, чтобы сравнить.
               */
              const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
              if (!delta) return;
              event.preventDefault();
              const next = EXIT_MODES[(index + delta + EXIT_MODES.length) % EXIT_MODES.length]!;
              setExitMode(next.key);
              (event.currentTarget.closest('[role="radiogroup"]')?.querySelector(`[data-exit-mode="${next.key}"]`) as HTMLButtonElement | null)?.focus();
            }}
          />
        ))}
      </div>
      {exitMode !== 'TARGET' && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-muted">{exitMode === 'TRAILING_PURE' ? 'Дополнительный стоп от входа, %' : 'Стоп от входа, %'}<input className="input mt-1" inputMode="decimal" placeholder="по умолчанию" value={exitTweaks.stopLossPct} onChange={(event) => setExitTweaks({ ...exitTweaks, stopLossPct: event.target.value })} /></label>
          {exitMode !== 'PROTECTED' && <label className="text-xs text-muted">Трейлинг от максимума, %<input className="input mt-1" inputMode="decimal" placeholder="по умолчанию" value={exitTweaks.trailingPct} onChange={(event) => setExitTweaks({ ...exitTweaks, trailingPct: event.target.value })} /></label>}
          <label className="text-xs text-muted">Не дольше, часов<input className="input mt-1" inputMode="decimal" placeholder="по умолчанию" value={exitTweaks.maxHoldHours} onChange={(event) => setExitTweaks({ ...exitTweaks, maxHoldHours: event.target.value })} /></label>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">Проверьте итог на следующем шаге.</p>
    </div>

)}
      {step === 3 && <div>
        <h2 className="font-semibold">Проверьте настройки</h2>
        <p data-settings-summary className="mt-4 rounded-xl border border-accent/30 bg-accent/5 p-4 text-sm leading-relaxed">{summary}</p>
        {plan?.trailingPct != null && <p className="mt-3 text-xs text-muted">Трейлинг −{plan.trailingPct}% {plan.trailingAfterLeg === 0 ? 'с момента входа' : `после ступени ${plan.trailingAfterLeg}`}</p>}
        {plan?.breakevenAfterLeg != null && <p className="mt-2 text-xs text-muted">Безубыток после ступени {plan.breakevenAfterLeg}</p>}
        {plan?.timeStop && <p className="mt-2 text-xs text-muted">Без {plan.timeStop.minMultiple}× за {plan.timeStop.afterMs / 60000} мин — выход</p>}
        {plan?.maxHoldMs && <p className="mt-2 text-xs text-muted">Удержание: до {plan.maxHoldMs / 3600000} ч</p>}
        <p className="mt-4 text-xs leading-relaxed text-muted">Будет создан новый PAPER-счёт. Открытые позиции сохранят свой план выхода.</p>
      </div>}
      </div>
      {step === 1 && !validCapital && <p role="alert" className="mt-3 text-xs text-down">Введите капитал и допустимое число позиций</p>}
      {step === 2 && exitError && <p role="alert" className="mt-3 text-xs text-down">{exitError}</p>}
      <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
        <button className="btn-ghost" disabled={step === 1 || busy} onClick={() => setStep(step - 1)}>Назад</button>
        {step < 3 ? <button className="btn-primary" disabled={busy || (step === 1 ? !validCapital : !!exitError)} onClick={() => setStep(step + 1)}>Далее</button> : <button className="btn-primary" disabled={busy || !validCapital || !!exitError} onClick={() => {
          void act(() => api('/admin/paper-agent/allocation', { method: 'PUT', body: JSON.stringify({ mode, capitalUsd: String(capitalNumber), ...(mode === 'FIXED' ? { maxOpenPositions: Number(positions) } : { riskProfile: profile }), exitMode, exitOverrides: Object.keys(overrides).length ? overrides : undefined, confirm: true }) }), 'PAPER-счёт настроен');
        }}>Применить</button>}
      </div>
      </fieldset>
    </section>
    <details className="panel p-4 sm:p-5"><summary className="cursor-pointer text-sm font-medium">Исследование стратегий</summary><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="font-semibold">Обучение</h2><p className="mt-1 text-sm text-muted">Предлагает гипотезы. Настройки самостоятельно не меняет.</p></div><button disabled={busy} className="btn-ghost" onClick={() => void act(() => api('/admin/paper-agent/learning', { method: 'PUT', body: JSON.stringify({ enabled: !data.control.learningModeEnabled }) }), data.control.learningModeEnabled ? 'Learning выключен' : 'Learning включён')}>{data.control.learningModeEnabled ? 'Выключить' : 'Включить'}</button></div></details>

    <details className="panel p-4"><summary className="cursor-pointer font-medium">Техническая аналитика для администратора</summary><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{admin?.comparison?.map((strategy) => <div key={strategy.key} className="rounded-lg border border-border bg-raised p-3"><div className="text-sm font-medium">{strategy.label}</div><div className="mt-2 space-y-1 text-xs text-muted"><div>Счёт: {strategy.kind}</div><div>Входов: {strategy.entries}</div><div>Закрыто: {strategy.closed}</div><div>PnL: {money(strategy.totalNetPnlUsd)}</div></div></div>)}</div></details>
  </div>;
}

function EquityChart({ ledger, fallback }: { ledger: LedgerEvent[]; fallback: MaybeNumber }) {
  const values = [...ledger].reverse().map((event) => event.equityAfterUsd).filter((value): value is number => value != null && Number.isFinite(value));
  if (!values.length && fallback != null) values.push(fallback);
  if (values.length < 2) return <div className="mt-5 grid h-36 place-items-center rounded-lg border border-dashed border-border text-xs text-muted">Кривая появится после второго события счёта</div>;
  const min = Math.min(...values); const max = Math.max(...values); const span = Math.max(max - min, 0.000001);
  const coords = values.map((value, index) => [(index / (values.length - 1)) * 100, 94 - ((value - min) / span) * 80] as const);
  const points = coords.map(([x, y]) => `${x},${y}`).join(' ');
  const area = `M0 94 ${coords.map(([x, y]) => `L${x} ${y}`).join(' ')} L100 94 Z`;
  const last = coords[coords.length - 1];
  const rising = values[values.length - 1] >= values[0];
  /*
   * `preserveAspectRatio="none"`: график растягивается на всю ширину
   * панели. Толщина линии при этом не плывёт (`vectorEffect`), а
   * конечная точка вынесена в HTML — круг внутри растянутого SVG
   * стал бы эллипсом.
   */
  return <div className="relative mt-4 h-36 w-full" role="img" aria-label="Кривая капитала PAPER-счёта">
  <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden className="h-full w-full overflow-visible">
    <defs>
      <linearGradient id="agent-equity" x1="0" y1="0" x2="1" y2="0"><stop stopColor="#8b5cf6"/><stop offset="1" stopColor={rising ? '#22C7B8' : '#FF5C6C'}/></linearGradient>
      <linearGradient id="agent-equity-area" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#8b5cf6" stopOpacity=".28"/><stop offset="1" stopColor="#8b5cf6" stopOpacity="0"/></linearGradient>
    </defs>
    <path d="M0 94H100" stroke="currentColor" className="text-border" strokeWidth=".5"/>
    <path d={area} fill="url(#agent-equity-area)" className="agent-area" />
    <polyline points={points} pathLength={1} fill="none" stroke="url(#agent-equity)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" className="agent-line" />
  </svg>
  <span
    aria-hidden
    className={`agent-line-end absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 ring-panel ${rising ? 'bg-up' : 'bg-down'}`}
    style={{ left: `${last[0]}%`, top: `${last[1]}%` }}
  />
  </div>;
}

function TokenMark({ run }: { run: AgentRun }) {
  const symbol = run.token?.symbol ?? run.symbol ?? '?';
  return run.tokenId ? <Link href={`/terminal/?token=${encodeURIComponent(run.tokenId)}`} aria-label={`Открыть график ${symbol}`} className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-accent/15 font-semibold text-accent">{run.token?.logoUrl ? <img src={run.token.logoUrl} alt="" className="h-full w-full object-cover" /> : symbol.slice(0, 2)}</Link> : <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-border text-xs text-muted">{symbol.slice(0, 2)}</span>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone: 'up' | 'down' | 'neutral' }) { return <div className="agent-metric rounded-lg border border-border bg-raised/60 p-3"><div className="text-xs text-muted">{label}</div><div className={`num mt-1 text-sm font-semibold ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''}`}>{value}</div></div>; }
function StateCard({ title, children }: { title: string; children: ReactNode }) {
  return <div className="agent-card panel grid min-h-48 place-items-center p-6 text-center" style={{ '--i': 0 } as CSSProperties}>
    <div>
      <span aria-hidden className="agent-idle mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full border border-border text-muted"><span className="h-2 w-2 rounded-full bg-current" /></span>
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-2 max-w-md text-sm text-muted">{children}</p>
    </div>
  </div>;
}

/**
 * Четыре причины, по которым экран не открылся, — и четыре разных ответа.
 *
 * Раньше здесь была одна карточка: «Агент временно недоступен.
 * Обновите страницу через несколько секунд». В трёх случаях из
 * четырёх этот совет вёл в никуда: при истёкшей сессии и при
 * отсутствии подписки обновление не помогает вообще никогда.
 *
 * Разбор кода живёт в ядре: интерфейс не должен решать, что значит
 * 403. Здесь только текст и действие.
 *
 * Технических подробностей нет ни в одном состоянии. Ни адреса,
 * ни кода ответа, ни текста ошибки: человеку они не помогают,
 * а постороннему рассказывают об устройстве.
 */
const FAILURE_COPY: Record<AgentFailureKind, { title: string; detail: string }> = {
  SIGN_IN_REQUIRED: {
    title: 'Нужно войти заново',
    detail: 'Сессия закончилась. Введённые настройки агента сохранены.',
  },
  ACCESS_REQUIRED: {
    title: 'Экран агента недоступен на текущем тарифе',
    detail: 'Агент входит в Pro. Пробный период открывает его целиком.',
  },
  SERVER_UNAVAILABLE: {
    title: 'Сервер сейчас не отвечает',
    detail: 'Это ненадолго. Данные PAPER-счёта не изменились.',
  },
  NETWORK_UNAVAILABLE: {
    title: 'Не удалось связаться с сервером',
    detail: 'Соединение прервалось. Данные PAPER-счёта не изменились.',
  },
};

function AgentFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  /*
   * Ответ без кода — это отсутствие ответа.
   *
   * `NetworkError` не несёт статуса, и подставлять сюда `500`
   * нельзя: «сервер ответил ошибкой» и «сервер не ответил» —
   * разные поломки с разными советами.
   */
  const status = error instanceof ApiError ? error.status : null;
  const verdict = agentFailureVerdict({ status });
  const copy = FAILURE_COPY[verdict.kind];

  return (
    <div className="panel grid min-h-48 place-items-center p-6 text-center">
      <div data-agent-failure={verdict.kind}>
        <h2 className="font-semibold" role="alert">{copy.title}</h2>
        <p className="mt-2 max-w-md text-sm text-muted">{copy.detail}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {verdict.retryable && (
            <button
              type="button"
              onClick={onRetry}
              className="min-h-11 rounded-lg border border-border px-4 text-sm text-accent hover:border-accent/50 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Попробовать ещё раз
            </button>
          )}
          {verdict.kind === 'SIGN_IN_REQUIRED' && (
            <Link
              href="/login"
              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-4 text-sm text-accent hover:border-accent/50 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Войти
            </Link>
          )}
          {verdict.kind === 'ACCESS_REQUIRED' && (
            <Link
              href="/plans"
              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-4 text-sm text-accent hover:border-accent/50 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Посмотреть тарифы
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
function AgentSkeleton() { return <div aria-label="Загрузка агента" className="space-y-4"><div className="skeleton h-44 rounded-xl"/><div className="grid gap-3 sm:grid-cols-4">{[0,1,2,3].map((item) => <div key={item} className="skeleton h-24 rounded-xl"/>)}</div><div className="skeleton h-80 rounded-xl"/></div>; }
function money(value: MaybeNumber) { if (value == null || !Number.isFinite(value)) return '—'; return `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function percent(value: MaybeNumber) { return value == null ? '—' : `${value.toFixed(2)}%`; }
function pnlTone(value: number): 'up' | 'down' | 'neutral' { return value > 0 ? 'up' : value < 0 ? 'down' : 'neutral'; }
function pnlClass(value: MaybeNumber) { return value == null || value === 0 ? 'text-muted' : value > 0 ? 'text-up' : 'text-down'; }
function timestamp(value: string | null) { return value ? new Date(value).toLocaleString('ru-RU') : '—'; }
function freshness(value: string | null) { if (!value) return 'данных пока нет'; const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000)); return seconds < 10 ? 'только что' : seconds < 60 ? `${seconds} сек. назад` : seconds < 3600 ? `${Math.floor(seconds / 60)} мин. назад` : timestamp(value); }
function humanDecision(code: string | null, short = false) {
  const labels: Record<string, [string, string]> = {
    ALLOCATED: ['Капитал выделен', 'Вход'],
    ENTRY_OPENED: ['Позиция открыта', 'Вход'], MAX_POSITIONS_REACHED: ['Достигнут лимит позиций', 'Лимит'],
    INSUFFICIENT_FREE_BALANCE: ['Недостаточно свободного капитала', 'Мало средств'], EXPOSURE_LIMIT_REACHED: ['Достигнут предел вложений', 'Лимит'],
    SCORE_BELOW_THRESHOLD: ['Сигнал слишком слабый', 'Слабый'], DUPLICATE_POSITION: ['Позиция уже открыта', 'Повтор'],
    WAITING_PRICE: ['Ожидается цена', 'Нет цены'], NO_PRICE: ['Цена недоступна', 'Нет цены'],
    POOL_TOO_OLD: ['Пул слишком старый', 'Старый пул'], STALE_SIGNAL: ['Сигнал устарел', 'Устарел'],
    AMOUNT_BELOW_THRESHOLD: ['Объём сигнала слишком мал', 'Мало средств'],
    TOKEN_AGE_UNKNOWN: ['Возраст пула неизвестен', 'Возраст неизвестен'], TOKEN_TOO_OLD: ['Пул слишком старый', 'Старый пул'],
    WAITING_FOR_PRICE: ['Ожидается цена', 'Нет цены'], WAITING_FOR_ENTRY_DELAY: ['Ожидается время входа', 'Ожидание'],
    PRICE_UNAVAILABLE_BEFORE_DEADLINE: ['Цена не получена вовремя', 'Нет цены'],
    DECISION_DEADLINE_EXCEEDED: ['Сигнал устарел', 'Устарел'], INVALID_SIGNAL_TIMESTAMPS: ['Время сигнала некорректно', 'Время'],
    UNSUPPORTED_SIGNAL_TYPE: ['Тип сигнала не поддерживается', 'Тип сигнала'], NETWORK_NOT_SUPPORTED_PHASE_2: ['Сеть не поддерживается', 'Сеть'],
    INVALID_CAPITAL_STATE: ['Баланс требует проверки', 'Баланс'], RESERVE_VIOLATION: ['Нужно сохранить резерв', 'Резерв'],
    DRAWDOWN_STOP: ['Входы остановлены по просадке', 'Просадка'], DAILY_ENTRY_LIMIT_REACHED: ['Достигнут дневной лимит', 'Лимит'],
    POSITION_BELOW_MINIMUM: ['Размер позиции слишком мал', 'Мало средств'], ELIGIBLE: ['Сигнал подходит', 'Подходит'],
    ALLOCATION_SESSION_UNAVAILABLE: ['PAPER-счёт недоступен', 'Нет счёта'],
    DRAWDOWN_LIMIT_REACHED: ['Достигнут предел просадки', 'Просадка'],
  };
  return labels[code ?? '']?.[short ? 1 : 0] ?? (short ? 'Другое' : 'Сигнал обработан');
}

function positionCount(count: number) { const last = count % 10; const teen = count % 100; return `${count} ${teen >= 11 && teen <= 14 ? 'позиций' : last === 1 ? 'позиция' : last >= 2 && last <= 4 ? 'позиции' : 'позиций'}`; }
