'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { api, errorMessage, fetcher } from '@/lib/api';
import { publicAsset } from '@/lib/public-assets';

type MaybeNumber = number | null;
type AgentTab = 'overview' | 'positions' | 'history' | 'settings';

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
  allocation?: { mode?: string; riskProfile?: string | null; allocatedUsd?: MaybeNumber; signalScore?: number; reason?: string };
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
  mode: 'SEMI_AUTO';
  network: 'SOLANA';
  live: { enabled: boolean; executionEnabled: boolean; ready: boolean; blockers: string[] };
  funding: {
    enabled: boolean;
    source: 'DISABLED' | 'NOT_CONFIGURED';
    assets: Array<{ symbol: string; mint: string | null; minAmount: string; decimals: number; minConfirmations: number }>;
  };
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

const EVENT_LABELS: Record<string, string> = {
  DEPOSIT: 'PAPER-счёт создан', ENTRY: 'Позиция открыта', EXIT: 'Позиция закрыта',
  RESERVE: 'Капитал зарезервирован', RELEASE: 'Резерв освобождён', RESET: 'Счёт перезапущен',
  PAPER_OPEN: 'Позиция открыта', PAPER_CLOSED: 'Позиция закрыта', SKIPPED: 'Сигнал пропущен',
  WAITING_PRICE: 'Ожидается цена', ERROR: 'Не удалось обработать сигнал',
};

export default function AgentPage() {
  const { data, error, mutate } = useSWR<PublicAgentData>('/paper-agent', fetcher, { refreshInterval: 3_000 });
  const { data: admin, mutate: mutateAdmin } = useSWR<AdminAgentData>(data?.viewer.isAdmin ? '/admin/paper-agent' : null, fetcher, { refreshInterval: 5_000 });
  const [tab, setTab] = useState<AgentTab>('overview');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<'FIXED' | 'AUTOPILOT'>('FIXED');
  const [capital, setCapital] = useState('1000');
  const [positions, setPositions] = useState('4');
  const [profile, setProfile] = useState<'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE'>('BALANCED');

  useEffect(() => {
    if (new URL(window.location.href).searchParams.has('run')) setTab('history');
  }, []);

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

  if (error) return <StateCard title="Агент временно недоступен">Обновите страницу через несколько секунд.</StateCard>;
  if (!data) return <AgentSkeleton />;

  const status = STATUS[data.health];
  const tabs: Array<{ key: AgentTab; label: string }> = [
    { key: 'overview', label: 'Обзор' }, { key: 'positions', label: 'Позиции' }, { key: 'history', label: 'История' },
    ...(data.viewer.isAdmin ? [{ key: 'settings' as const, label: 'Настройки' }] : []),
  ];

  return (
    <main className="agent-enter space-y-5 pb-14">
      <header className="panel relative overflow-hidden p-5 sm:p-6">
        <div aria-hidden className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent to-transparent" />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent">PAPER</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-raised px-2.5 py-1 text-xs text-muted">
                <img src={publicAsset('/brand/solana-mark.svg')} alt="" className="h-3.5 w-3.5" /> Solana
              </span>
            </div>
            <h1 className="text-2xl font-bold sm:text-3xl">Автономный торговый агент</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">Наблюдайте, как стратегия принимает решения и ведёт виртуальный портфель. Реальные средства, кошельки и подпись транзакций не подключены.</p>
          </div>
          <div className="min-w-[180px] rounded-xl border border-border bg-bg/60 p-3" aria-live="polite">
            <div className={`flex items-center gap-2 text-sm font-semibold ${status.tone}`}><span className="agent-status-dot h-2 w-2 rounded-full bg-current" />{status.label}</div>
            <div className="mt-1 text-xs text-muted">{status.detail}</div>
            <div className="mt-2 text-[11px] text-muted">обновлено {freshness(data.runtime.lastActivityAt ?? data.lastDecisionAt)}</div>
          </div>
        </div>
      </header>

      <AgentModeBoundary data={data} />

      <AgentPipeline data={data} />

      <nav role="tablist" aria-label="Разделы агента" className="flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((item) => <button key={item.key} role="tab" aria-selected={tab === item.key} onClick={() => setTab(item.key)} className={`min-h-11 whitespace-nowrap border-b-2 px-4 text-sm transition-colors ${tab === item.key ? 'border-accent text-white' : 'border-transparent text-muted hover:text-white'}`}>{item.label}</button>)}
      </nav>

      {tab === 'overview' && <Overview data={data} />}
      {tab === 'positions' && <Positions rows={data.positions} />}
      {tab === 'history' && <History rows={data.recentDecisions} ledger={data.wallet?.ledger ?? []} />}
      {tab === 'settings' && data.viewer.isAdmin && (
        <AdminSettings
          data={data}
          admin={admin}
          busy={busy}
          notice={notice}
          mode={mode}
          setMode={setMode}
          capital={capital}
          setCapital={setCapital}
          positions={positions}
          setPositions={setPositions}
          profile={profile}
          setProfile={setProfile}
          act={act}
        />
      )}
    </main>
  );
}

function AgentModeBoundary({ data }: { data: PublicAgentData }) {
  return <section aria-label="Режимы агента" className="grid gap-3 md:grid-cols-2">
    <article className="relative overflow-hidden rounded-xl border border-accent/40 bg-accent/10 p-4 sm:p-5">
      <div aria-hidden className="absolute inset-y-0 left-0 w-1 bg-accent" />
      <div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold tracking-wider text-accent">PAPER · АКТИВНЫЙ КОНТУР</span><span className="rounded-full bg-accent/15 px-2 py-1 text-[11px] text-accent">виртуальные средства</span></div>
      <div className="mt-3 flex items-end justify-between gap-3"><div><h2 className="font-semibold">Без риска для реальных средств</h2><p className="mt-1 text-sm text-muted">Баланс {money(data.wallet?.capital.equityUsd ?? null)} · решения и PnL изолированы от LIVE.</p></div><span aria-hidden className="text-2xl">◎</span></div>
    </article>
    <article className="rounded-xl border border-border bg-raised/50 p-4 sm:p-5" aria-disabled="true">
      <div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold tracking-wider text-muted">LIVE · ЗАБЛОКИРОВАН</span><span className="rounded-full border border-border px-2 py-1 text-[11px] text-muted">реальные средства</span></div>
      <div className="mt-3 flex items-end justify-between gap-3"><div><h2 className="font-semibold text-muted">Только Semi-Auto после проверки</h2><p className="mt-1 text-sm text-muted">Предложение → подтверждение пользователя → исполнение. Auto недоступен.</p></div><button type="button" disabled className="min-h-11 shrink-0 rounded-lg border border-border px-3 text-xs text-muted">Недоступно</button></div>
    </article>
  </section>;
}

function AgentPipeline({ data }: { data: PublicAgentData }) {
  const active = data.control.isEnabled;
  const steps = [
    { label: 'OKX Signal', detail: data.source.fallbackActive ? 'Резервный REST-канал' : 'Поток сигналов', on: data.source.transportMode !== 'DISABLED' },
    { label: 'Отбор', detail: `${data.metrics24h.uniqueSignals} сигналов за 24ч`, on: active },
    { label: 'Решение', detail: data.control.activeAllocationMode ?? 'Не настроено', on: active && data.control.activeAllocationMode != null },
    { label: 'PAPER-позиция', detail: `${data.metrics24h.openPositions} открыто`, on: data.metrics24h.openPositions > 0 },
  ];
  return <section aria-label="Как работает агент" className="panel p-4 sm:p-5">
    <div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-semibold">Путь решения</h2><span className="text-xs text-muted">только виртуальный капитал</span></div>
    <div className="grid gap-2 sm:grid-cols-4">
      {steps.map((step, index) => <div key={step.label} className="relative rounded-xl border border-border bg-raised/60 p-3">
        <div className="flex items-center gap-2"><span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-semibold ${step.on ? 'bg-accent/20 text-accent' : 'bg-border text-muted'}`}>{index + 1}</span><span className="text-sm font-medium">{step.label}</span></div>
        <div className="mt-2 text-xs text-muted">{step.detail}</div>
        {index < steps.length - 1 && <span aria-hidden className="absolute -right-2 top-1/2 z-10 hidden h-px w-2 bg-accent/40 sm:block" />}
      </div>)}
    </div>
  </section>;
}

function Overview({ data }: { data: PublicAgentData }) {
  const wallet = data.wallet;
  if (!wallet) return <StateCard title="PAPER-счёт ещё не создан">Администратор сначала выбирает Fixed или Autopilot и задаёт виртуальный капитал.</StateCard>;
  const capital = wallet.capital;
  const initial = capital.initialUsd ?? 0;
  const freePct = initial > 0 ? ((capital.freeUsd ?? 0) / initial) * 100 : 0;
  const reservedPct = initial > 0 ? ((capital.reservedUsd ?? 0) / initial) * 100 : 0;
  const investedPct = Math.max(0, 100 - freePct - reservedPct);
  return <><div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(300px,.7fr)]">
    <section className="panel p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs uppercase tracking-wider text-muted">PAPER wallet</p><h2 className="mt-1 text-xl font-semibold">{money(capital.equityUsd)}</h2></div><ModeBadge wallet={wallet} /></div>
      <div className="mt-5 grid gap-5 sm:grid-cols-[150px_1fr] sm:items-center">
        <div aria-label="Распределение капитала" className="mx-auto grid h-36 w-36 place-items-center rounded-full" style={{ background: `conic-gradient(#8b5cf6 0 ${investedPct}%, #38bdf8 ${investedPct}% ${investedPct + reservedPct}%, #334155 ${investedPct + reservedPct}% 100%)` }}>
          <div className="grid h-24 w-24 place-items-center rounded-full bg-surface text-center"><div><div className="text-xs text-muted">Использовано</div><div className="num font-semibold">{data.metrics24h.capitalUtilizationPct.toFixed(1)}%</div></div></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Metric label="Свободно" value={money(capital.freeUsd)} tone="neutral" />
          <Metric label="В позициях" value={money(capital.inPositionsUsd)} tone="neutral" />
          <Metric label="Резерв" value={money(capital.reservedUsd)} tone="neutral" />
          <Metric label="Общий PnL" value={money((capital.realizedPnlUsd ?? 0) + (capital.unrealizedPnlUsd ?? 0))} tone={pnlTone((capital.realizedPnlUsd ?? 0) + (capital.unrealizedPnlUsd ?? 0))} />
          <Metric label="Реализованный" value={money(capital.realizedPnlUsd)} tone={pnlTone(capital.realizedPnlUsd ?? 0)} />
          <Metric label="Нереализованный" value={money(capital.unrealizedPnlUsd)} tone={pnlTone(capital.unrealizedPnlUsd ?? 0)} />
          <Metric label="Изменение 24ч" value={money(capital.dailyChangeUsd ?? null)} tone={pnlTone(capital.dailyChangeUsd ?? 0)} />
          <Metric label="Расходы" value={money((capital.tradingFeesUsd ?? 0) + (capital.slippageUsd ?? 0) + (capital.networkCostsUsd ?? 0))} tone="neutral" />
          <Metric label="Просадка" value={percent(capital.drawdownPct)} tone={capital.drawdownPct && capital.drawdownPct > 0 ? 'down' : 'neutral'} />
        </div>
      </div>
    </section>
    <section className="panel p-4 sm:p-5"><div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Кривая капитала</h2><span className="text-xs text-muted">последние события</span></div><EquityChart ledger={wallet.ledger} fallback={capital.equityUsd} /><div className="mt-4 grid grid-cols-2 gap-3"><Metric label="Сигналов 24ч" value={String(data.metrics24h.uniqueSignals)} tone="neutral" /><Metric label="Закрыто 24ч" value={String(data.metrics24h.closedPositions)} tone="neutral" /></div></section>
  </div><Phase4Foundation status={data.phase4} /></>;
}

function Phase4Foundation({ status }: { status: Phase4Status }) {
  const usdc = status.funding.assets.find((asset) => asset.symbol === 'USDC');
  const steps = ['Ожидаем перевод', 'Обнаружен', 'Подтверждения', 'Финальность', 'Зачисление'];
  return <section className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_.8fr]" aria-label="Подготовка LIVE">
    <article className="panel p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold tracking-wider text-muted">ПОПОЛНЕНИЕ SOLANA</p><h2 className="mt-1 font-semibold">Контракт pipeline подготовлен</h2><p className="mt-1 text-xs text-muted">On-chain источник не подключён — реальные переводы не принимаются.</p></div><span className="rounded-full border border-warn/30 bg-warn/10 px-2.5 py-1 text-xs text-warn">адаптер не подключён</span></div>
      <div className="mt-5 grid grid-cols-5 gap-1" role="list" aria-label="Этапы пополнения">
        {steps.map((step, index) => <div key={step} role="listitem" className="min-w-0 text-center"><div className="mx-auto grid h-7 w-7 place-items-center rounded-full border border-border bg-raised text-[11px] text-muted">{index + 1}</div><div className="mt-2 break-words text-[10px] leading-tight text-muted sm:text-xs">{step}</div></div>)}
      </div>
      <div className="mt-5 rounded-lg border border-warn/20 bg-warn/5 p-3 text-xs leading-relaxed text-muted">
        Отправлять можно будет только в сети Solana. USDC принимается только с официальным mint <span className="num break-all text-white">{usdc?.mint ?? '—'}</span>. Поддельный mint и сумма ниже {usdc?.minAmount ?? '—'} USDC отклоняются.
      </div>
    </article>
    <article className="panel p-4 sm:p-5">
      <p className="text-xs font-semibold tracking-wider text-muted">SEMI-AUTO</p><h2 className="mt-1 font-semibold">Подтверждение до исполнения</h2>
      <dl className="mt-4 space-y-2 text-sm"><div className="flex justify-between gap-3"><dt className="text-muted">Сеть</dt><dd>Solana</dd></div><div className="flex justify-between gap-3"><dt className="text-muted">Сумма и комиссии</dt><dd className="text-muted">появятся в предложении</dd></div><div className="flex justify-between gap-3"><dt className="text-muted">Compliance</dt><dd className="text-warn">не настроен</dd></div></dl>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-1"><button type="button" disabled className="min-h-11 rounded-lg border border-border bg-raised px-4 text-sm text-muted">Подтверждение LIVE недоступно</button><button type="button" disabled className="min-h-11 rounded-lg border border-down/25 bg-down/5 px-4 text-sm text-muted">LIVE kill switch недоступен</button><Link href="/terminal/" className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-4 text-sm text-accent hover:border-accent/50 hover:text-white">Открыть терминал</Link></div>
    </article>
  </section>;
}

function Positions({ rows }: { rows: AgentRun[] }) {
  if (!rows.length) return <StateCard title="Открытых позиций нет">Агент ждёт подходящий сигнал. Свободный слот сам по себе покупку не инициирует.</StateCard>;
  return <section className="grid gap-3 md:grid-cols-2">{rows.map((run) => <RunCard key={run.id} run={run} />)}</section>;
}

function History({ rows, ledger }: { rows: AgentRun[]; ledger: LedgerEvent[] }) {
  if (!rows.length && !ledger.length) return <StateCard title="История пока пуста">Решения и изменения PAPER-счёта появятся после первых сигналов.</StateCard>;
  return <section className="panel divide-y divide-border overflow-hidden">
    {rows.slice(0, 40).map((run) => <div key={`run:${run.id}`} className="flex flex-wrap items-center gap-3 p-4"><TokenMark run={run} /><div className="min-w-0 flex-1"><div className="text-sm font-medium">{EVENT_LABELS[run.state] ?? humanDecision(run.decisionCode)}</div><div className="mt-1 text-xs text-muted">{timestamp(run.decidedAt ?? run.signaledAt)} · {run.strategyLabel}</div></div><div className={`num text-sm ${pnlClass(run.realizedPnlUsd ?? run.unrealizedPnlUsd)}`}>{money(run.realizedPnlUsd ?? run.unrealizedPnlUsd)}</div></div>)}
    {ledger.slice(0, Math.max(0, 40 - rows.length)).map((event) => <LedgerRow key={`ledger:${event.id}`} event={event} />)}
  </section>;
}

const LEDGER_LABELS: Record<string, string> = {
  INITIALIZE: 'Создан PAPER-счёт',
  OPEN: 'Капитал направлен в PAPER-позицию',
  CLOSE: 'PAPER-позиция закрыта',
};

function LedgerRow({ event }: { event: LedgerEvent }) {
  const tokenId = event.allocation?.token?.id ?? event.allocation?.tokenId;
  const symbol = event.allocation?.token?.symbol ?? event.allocation?.symbol;
  return <div className="flex flex-wrap items-center gap-3 p-4">
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

function RunCard({ run }: { run: AgentRun }) {
  return <article className="panel p-4"><div className="flex items-start gap-3"><TokenMark run={run} /><div className="min-w-0 flex-1"><div className="truncate font-semibold">{run.token?.symbol ?? run.symbol}</div><div className="truncate text-xs text-muted">{run.token?.name ?? run.address}</div></div><div className={`num text-sm ${pnlClass(run.unrealizedPnlUsd)}`}>{money(run.unrealizedPnlUsd)}</div></div><div className="mt-4 grid grid-cols-2 gap-3"><Metric label="Позиция" value={money(run.positionUsd)} tone="neutral" /><Metric label="Максимум" value={run.maxMultiple == null ? '—' : `${run.maxMultiple.toFixed(2)}×`} tone="neutral" /></div>{run.tokenId && <Link href={`/terminal/?token=${encodeURIComponent(run.tokenId)}`} className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-accent hover:text-white">Открыть график →</Link>}</article>;
}

function AdminSettings(props: {
  data: PublicAgentData; admin?: AdminAgentData; busy: boolean; notice: string | null;
  mode: 'FIXED' | 'AUTOPILOT'; setMode: (value: 'FIXED' | 'AUTOPILOT') => void;
  capital: string; setCapital: (value: string) => void; positions: string; setPositions: (value: string) => void;
  profile: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE'; setProfile: (value: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE') => void;
  act: (work: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const { data, admin, busy, notice, mode, setMode, capital, setCapital, positions, setPositions, profile, setProfile, act } = props;
  return <div className="space-y-4">
    <section className="panel p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="font-semibold">Управление агентом</h2><p className="mt-1 text-sm text-muted">Stop запрещает новые входы; открытые PAPER-позиции продолжают сопровождаться.</p></div><button disabled={busy || (!data.control.isEnabled && !data.wallet)} className={data.control.isEnabled ? 'btn-sell' : 'btn-buy'} onClick={() => {
      if (!window.confirm(data.control.isEnabled ? 'Остановить новые входы агента?' : 'Запустить PAPER-агента?')) return;
      void act(() => api('/admin/paper-agent', { method: 'PUT', body: JSON.stringify({ isEnabled: !data.control.isEnabled }) }), data.control.isEnabled ? 'Новые входы остановлены' : 'PAPER-агент запущен');
    }}>{data.control.isEnabled ? 'Stop' : 'Start PAPER'}</button></div></section>

    <section className="panel p-4 sm:p-5"><h2 className="font-semibold">Распределение виртуального капитала</h2><div className="mt-4 grid gap-3 sm:grid-cols-2">{(['FIXED', 'AUTOPILOT'] as const).map((item) => <button key={item} type="button" aria-pressed={mode === item} onClick={() => setMode(item)} className={`min-h-24 rounded-xl border p-4 text-left transition-colors ${mode === item ? 'border-accent bg-accent/10' : 'border-border bg-raised hover:border-accent/40'}`}><div className="font-semibold">{item === 'FIXED' ? 'Fixed' : 'Autopilot'}</div><p className="mt-1 text-xs leading-relaxed text-muted">{item === 'FIXED' ? 'Капитал после резерва делится поровну между заданным числом позиций.' : 'Профиль задаёт резерв, размер позиции, число входов и предел просадки.'}</p></button>)}</div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs text-muted">PAPER-капитал, USD<input className="input mt-1" inputMode="decimal" value={capital} onChange={(event) => setCapital(event.target.value)} /></label>{mode === 'FIXED' ? <label className="text-xs text-muted">Максимум позиций<input className="input mt-1" inputMode="numeric" value={positions} onChange={(event) => setPositions(event.target.value)} /></label> : <label className="text-xs text-muted">Профиль<select className="input mt-1" value={profile} onChange={(event) => setProfile(event.target.value as typeof profile)}><option value="CONSERVATIVE">Conservative · 60/40</option><option value="BALANCED">Balanced · 70/30</option><option value="AGGRESSIVE">Aggressive · 80/20</option></select></label>}</div>
      <button disabled={busy} className="btn-ghost mt-4" onClick={() => {
        if (!window.confirm('Создать новый PAPER-счёт с этими параметрами?')) return;
        void act(() => api('/admin/paper-agent/allocation', { method: 'PUT', body: JSON.stringify({ mode, capitalUsd: capital, ...(mode === 'FIXED' ? { maxOpenPositions: Number(positions) } : { riskProfile: profile }), confirm: true }) }), 'PAPER-счёт настроен');
      }}>Применить с подтверждением</button>
    </section>

    <section className="panel p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="font-semibold">Learning</h2><p className="mt-1 text-sm text-muted">Формирует гипотезы, но никогда не меняет активную policy самостоятельно.</p></div><button disabled={busy} className="btn-ghost" onClick={() => void act(() => api('/admin/paper-agent/learning', { method: 'PUT', body: JSON.stringify({ enabled: !data.control.learningModeEnabled }) }), data.control.learningModeEnabled ? 'Learning выключен' : 'Learning включён')}>{data.control.learningModeEnabled ? 'Выключить' : 'Включить'}</button></div></section>

    {notice && <p role="status" className="rounded-lg border border-accent/30 bg-accent/10 p-3 text-sm">{notice}</p>}
    <details className="panel p-4"><summary className="cursor-pointer font-medium">Техническая аналитика для администратора</summary><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{admin?.comparison?.map((strategy) => <div key={strategy.key} className="rounded-lg border border-border bg-raised p-3"><div className="text-sm font-medium">{strategy.label}</div><div className="mt-2 space-y-1 text-xs text-muted"><div>Контур: {strategy.kind}</div><div>Входов: {strategy.entries}</div><div>Закрыто: {strategy.closed}</div><div>PnL: {money(strategy.totalNetPnlUsd)}</div></div></div>)}</div></details>
  </div>;
}

function EquityChart({ ledger, fallback }: { ledger: LedgerEvent[]; fallback: MaybeNumber }) {
  const values = [...ledger].reverse().map((event) => event.equityAfterUsd).filter((value): value is number => value != null && Number.isFinite(value));
  if (!values.length && fallback != null) values.push(fallback);
  if (values.length < 2) return <div className="mt-5 grid h-36 place-items-center rounded-lg border border-dashed border-border text-xs text-muted">Кривая появится после второго события счёта</div>;
  const min = Math.min(...values); const max = Math.max(...values); const span = Math.max(max - min, 0.000001);
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${94 - ((value - min) / span) * 80}`).join(' ');
  return <svg viewBox="0 0 100 100" role="img" aria-label="Кривая капитала PAPER-счёта" className="mt-4 h-36 w-full overflow-visible"><defs><linearGradient id="agent-equity" x1="0" y1="0" x2="1" y2="0"><stop stopColor="#8b5cf6"/><stop offset="1" stopColor="#38bdf8"/></linearGradient></defs><path d="M0 94H100" stroke="currentColor" className="text-border" strokeWidth=".5"/><polyline points={points} fill="none" stroke="url(#agent-equity)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

function TokenMark({ run }: { run: AgentRun }) {
  const symbol = run.token?.symbol ?? run.symbol ?? '?';
  return run.tokenId ? <Link href={`/terminal/?token=${encodeURIComponent(run.tokenId)}`} aria-label={`Открыть график ${symbol}`} className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-accent/15 font-semibold text-accent">{run.token?.logoUrl ? <img src={run.token.logoUrl} alt="" className="h-full w-full object-cover" /> : symbol.slice(0, 2)}</Link> : <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-border text-xs text-muted">{symbol.slice(0, 2)}</span>;
}

function ModeBadge({ wallet }: { wallet: PaperWallet }) { return <span className="rounded-full border border-border bg-raised px-2.5 py-1 text-xs text-muted">{wallet.mode === 'FIXED' ? 'Fixed allocation' : `Autopilot · ${wallet.riskProfile?.toLowerCase() ?? 'balanced'}`}</span>; }
function Metric({ label, value, tone }: { label: string; value: string; tone: 'up' | 'down' | 'neutral' }) { return <div className="rounded-lg border border-border bg-raised/60 p-3"><div className="text-xs text-muted">{label}</div><div className={`num mt-1 text-sm font-semibold ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''}`}>{value}</div></div>; }
function StateCard({ title, children }: { title: string; children: ReactNode }) { return <div className="panel grid min-h-48 place-items-center p-6 text-center"><div><h2 className="font-semibold">{title}</h2><p className="mt-2 max-w-md text-sm text-muted">{children}</p></div></div>; }
function AgentSkeleton() { return <div aria-label="Загрузка агента" className="space-y-4"><div className="skeleton h-44 rounded-xl"/><div className="grid gap-3 sm:grid-cols-4">{[0,1,2,3].map((item) => <div key={item} className="skeleton h-24 rounded-xl"/>)}</div><div className="skeleton h-80 rounded-xl"/></div>; }
function money(value: MaybeNumber) { if (value == null || !Number.isFinite(value)) return '—'; return `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function percent(value: MaybeNumber) { return value == null ? '—' : `${value.toFixed(2)}%`; }
function pnlTone(value: number): 'up' | 'down' | 'neutral' { return value > 0 ? 'up' : value < 0 ? 'down' : 'neutral'; }
function pnlClass(value: MaybeNumber) { return value == null || value === 0 ? 'text-muted' : value > 0 ? 'text-up' : 'text-down'; }
function timestamp(value: string | null) { return value ? new Date(value).toLocaleString('ru-RU') : '—'; }
function freshness(value: string | null) { if (!value) return 'данных пока нет'; const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000)); return seconds < 10 ? 'только что' : seconds < 60 ? `${seconds} сек. назад` : seconds < 3600 ? `${Math.floor(seconds / 60)} мин. назад` : timestamp(value); }
function humanDecision(code: string | null) { if (!code) return 'Решение принято'; return ({ ENTRY_OPENED: 'Позиция открыта', MAX_POSITIONS_REACHED: 'Достигнут лимит позиций', INSUFFICIENT_FREE_BALANCE: 'Недостаточно свободного капитала', EXPOSURE_LIMIT_REACHED: 'Достигнут предел экспозиции', SCORE_BELOW_THRESHOLD: 'Сигнал не набрал нужный score', DUPLICATE_POSITION: 'Повторная позиция не открыта' } as Record<string,string>)[code] ?? 'Сигнал обработан'; }
