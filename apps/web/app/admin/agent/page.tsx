'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { api, errorMessage, fetcher } from '@/lib/api';
import { ChartPanel } from '@/components/terminal/ChartPanel';
import type { Token } from '@/components/terminal/types';
import { useTerminalChart } from '@/components/terminal/useTerminalChart';
import type { AgentChartMarker } from '@/components/PriceChart';
import { autopilotAllocationPolicy, fixedAllocationPolicy, type PaperAllocationLimits } from '@memex/core';

type MaybeNumber = number | null;
interface AgentRun {
  id: string; tokenId: string | null; state: string; decisionCode: string | null;
  errorCode: string | null; strategyKey: string; strategyLabel: string; chain: string;
  address: string; symbol: string; signaledAt: string; decidedAt: string | null;
  latencyMs: number | null; signalOrigin: string | null;
  providerDeliveryLatencyMs: number | null; agentDecisionLatencyMs: number | null;
  endToEndLatencyMs: number | null; entryAt: string | null; exitAt: string | null;
  entryPriceUsd: MaybeNumber; currentPriceUsd: MaybeNumber; realizedPnlUsd: MaybeNumber;
  unrealizedPnlUsd: MaybeNumber; maxMultiple: MaybeNumber; maxDrawdownPct: MaybeNumber;
  exitReason: string | null; positionUsd: MaybeNumber; costModelKey: string | null;
  tradeFeeBps: number | null; entrySlippageBps: number | null; exitSlippageBps: number | null;
  networkFeeUsdPerSide: MaybeNumber; totalCostsUsd: MaybeNumber; durationMs: MaybeNumber;
  allocation?: { id?: string; mode?: string; policyKey?: string; policyVersion?: number;
    riskProfile?: string | null; allocatedUsd?: MaybeNumber; capitalPct?: MaybeNumber;
    signalScore?: number; signalBand?: string; reason?: string; state?: string;
    legacy?: boolean; label?: string };
}
interface StrategyStats {
  key: string; label: string; kind: string; isEnabled: boolean; isBaseline: boolean;
  config: Record<string, unknown>; signals: number; entries: number; skipped: number;
  skipRatePct: MaybeNumber; open: number; closed: number; winRatePct: MaybeNumber;
  averagePnlUsd: MaybeNumber; medianPnlUsd: MaybeNumber; totalNetPnlUsd: MaybeNumber;
  profitFactor: MaybeNumber; averageMaxMultiple: MaybeNumber; worstDrawdownPct: MaybeNumber;
  averageDurationMs: MaybeNumber; decisionLatencyP50Ms: MaybeNumber;
  decisionLatencyP95Ms: MaybeNumber; decisionLatencySampleSize: number;
  totalCostsUsd: MaybeNumber; sampleSize: number;
  minimumSampleSize: number; enoughData: boolean;
}
interface AgentData {
  paper: true; network: 'Solana'; health: 'OFF' | 'STANDBY' | 'ACTIVE' | 'DEGRADED' | 'REFUSED';
  control: { isEnabled: boolean; baselineStrategyKey: string; telegramShadowEnabled: boolean;
    activeAllocationMode: 'FIXED' | 'AUTOPILOT' | null; activeAllocationPolicyKey: string | null;
    activeAllocationPolicyVersion: number | null; learningModeEnabled: boolean; updatedAt: string };
  runtime: { running: boolean; refusalReason: string | null; lastTickAt: string | null;
    lastErrorCode: string | null; lastActivityAt: string | null; queued: number;
    duplicatesSeen: number; processingErrors: number; liveExecutionReachable: false };
  okxSignal: { running: boolean; transportMode: 'WEBSOCKET' | 'REST_ONLY' | 'DISABLED';
    permanentDenialCode: string | null; accessMessage: string | null;
    lastSignalAt: string | null; lastRestSuccessAt: string | null;
    nextRestReconciliationAt: string | null; lastRestErrorCode: string | null;
    socket: { state: string; lastMessageAt: number | null;
    reconnects: number; lastErrorCode: string | null; lastProviderCode: string | null;
    channelTransportMode: string; channelAccessDeniedCode: string | null } | null;
    lastPersistedSignal: { signaledAt: string; receivedAt: string } | null };
  notifications: { unread: number; pending: number; running: boolean; telegramEnabled: boolean; transport: string };
  metrics24h: { receivedSignals: number; uniqueSignals: number; runs: number;
    averageRunsPerSignal: MaybeNumber; processedRuns: number; errorRuns: number;
    openPositions: number; states: Record<string, number>; skipReasons: Record<string, number>;
    skipReasonsUniqueSignals: Record<string, number>;
    skipReasonsByStrategy: Record<string, Record<string, number>>;
    skipReasonsByContour: Record<string, Record<string, number>>;
    signalOrigins: Record<string, number>; ingestCodes: Record<string, number>;
    runsByOrigin: Record<string, number>; runsByStrategyKind: Record<string, number>;
    runsByStrategyVersion: Record<string, number>; capitalContours: Record<string, number>;
    allocationPolicyVersions: Record<string, number>;
    decisionLatencyP50Ms: MaybeNumber; decisionLatencyP95Ms: MaybeNumber;
    decisionLatencySampleSize: number; providerDeliveryLatencyP50Ms: MaybeNumber;
    providerDeliveryLatencyP95Ms: MaybeNumber; providerDeliveryLatencySampleSize: number;
    endToEndLatencyP50Ms: MaybeNumber; endToEndLatencyP95Ms: MaybeNumber;
    endToEndLatencySampleSize: number };
  comparison: StrategyStats[];
  allocation?: {
    configured: boolean; execution: 'PAPER'; network: 'Solana';
    accounts: AllocationAccount[]; policies: AllocationPolicy[];
    comparison: AllocationComparison[]; hypotheses: AllocationHypothesis[];
  };
  positions: { open: AgentRun[]; closed: AgentRun[] }; decisions: AgentRun[];
}
interface AllocationAccount {
  id: string; kind: 'ACTIVE' | 'SHADOW'; mode: 'FIXED' | 'AUTOPILOT';
  status: 'ACTIVE' | 'DRAINING' | 'CLOSED'; policyKey: string; policyVersion: number;
  riskProfile: string | null; policySnapshot: Record<string, unknown>;
  capital: { initialUsd: MaybeNumber; freeUsd: MaybeNumber; reservedUsd: MaybeNumber;
    inPositionsUsd: MaybeNumber; equityUsd: MaybeNumber; realizedPnlUsd: MaybeNumber;
    unrealizedPnlUsd: MaybeNumber; tradingFeesUsd: MaybeNumber; slippageUsd: MaybeNumber;
    networkCostsUsd: MaybeNumber; peakEquityUsd: MaybeNumber; drawdownPct: MaybeNumber };
  limits: { reservePct: MaybeNumber; maxExposurePct: MaybeNumber; maxPositionPct: MaybeNumber;
    maxOpenPositions: number; minimumPositionUsd: MaybeNumber; dailyEntryLimit: number;
    drawdownStopPct: MaybeNumber; allowPartialAllocation: boolean };
  openPositions: number; dailyEntries: number; createdAt: string; closedAt: string | null;
}
interface AllocationPolicy {
  id: string; policyKey: string; version: number; mode: string; riskProfile: string | null;
  label: string; limits: Record<string, unknown>; status: string; source: string;
  hypothesisMetrics: Record<string, unknown> | null; sampleSize: number | null;
  periodStart: string | null; periodEnd: string | null; createdAt: string;
}
interface AllocationComparison {
  accountId: string; kind: string; mode: string; policyKey: string; policyVersion: number;
  riskProfile: string | null; capital: AllocationAccount['capital']; decisions: number;
  entries: number; skipped: number; open: number; closed: number; realizedPnlUsd: MaybeNumber;
  signals: number; missedInsufficientBalance: number; missedExposureLimit: number;
  missedMaxPositions: number; averageAllocationUsd: MaybeNumber; medianAllocationUsd: MaybeNumber;
  turnoverUsd: MaybeNumber; averageReserveUsd: MaybeNumber; averageExposureUsd: MaybeNumber;
  capitalUtilizationPct: MaybeNumber; currentExposureUsd: MaybeNumber; currentReserveUsd: MaybeNumber;
  unrealizedPnlUsd: MaybeNumber; netPnlUsd: MaybeNumber; winRatePct: MaybeNumber;
  profitFactor: MaybeNumber; totalCostsUsd: MaybeNumber; tradingFeesUsd: MaybeNumber;
  slippageUsd: MaybeNumber; networkCostsUsd: MaybeNumber; maxDrawdownPct: MaybeNumber;
  averageHoldingMs: MaybeNumber; averageMaxMultiple: MaybeNumber; maxMultiple: MaybeNumber;
  decisionLatencyP50Ms: MaybeNumber; decisionLatencyP95Ms: MaybeNumber;
  pnlBySourceType: Record<string, { count: number; netPnlUsd: number }>;
  pnlByScoreBand: Record<string, { count: number; netPnlUsd: number }>;
  lastDecision: { code: string; reason: string } | null;
  sampleSize: number; minimumSampleSize: number; enoughData: boolean;
}
interface AllocationHypothesis {
  id: string; policyKey: string; version: number; label: string;
  limits: Record<string, unknown>; metrics: Record<string, unknown> | null;
  sampleSize: number | null; periodStart: string | null; periodEnd: string | null;
}
interface NotificationItem {
  id: string; runId: string | null; eventType: string; strategyKey: string | null;
  isBaselineEvent: boolean; payload: Record<string, unknown>; isRead: boolean;
  telegramStatus: string; telegramAttempts: number; telegramErrorCode: string | null; createdAt: string;
}

const money = (value: MaybeNumber) => value == null ? '—' : `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(2)}`;
const num = (value: MaybeNumber, suffix = '') => value == null ? '—' : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
const finiteNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const recordOf = (value: unknown): Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const duration = (value: MaybeNumber) => value == null ? '—' : value < 60_000 ? `${Math.round(value / 1_000)}с` : value < 3_600_000 ? `${Math.round(value / 60_000)}м` : `${(value / 3_600_000).toFixed(1)}ч`;
const timestamp = (value: string | null) => value ? new Date(value).toLocaleString('ru-RU') : '—';
const HEALTH_TEXT: Record<AgentData['health'], string> = {
  OFF: 'OFF · отключён администратором', STANDBY: 'STANDBY · ждёт сигнал',
  ACTIVE: 'ACTIVE · обрабатывает', DEGRADED: 'DEGRADED · провайдер или цена недоступны',
  REFUSED: 'REFUSED · разрешён только EXECUTION_MODE=paper',
};

export default function PaperAgentPage() {
  const { data, error, mutate } = useSWR<AgentData>('/admin/paper-agent', fetcher, { refreshInterval: 3_000 });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [interval, setInterval] = useState('5m');
  const [eventType, setEventType] = useState('');
  const [strategyFilter, setStrategyFilter] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [allocationMode, setAllocationMode] = useState<'FIXED' | 'AUTOPILOT'>('FIXED');
  const [capitalUsd, setCapitalUsd] = useState('1000');
  const [maxOpenPositions, setMaxOpenPositions] = useState('4');
  const [reservePct, setReservePct] = useState('30');
  const [riskProfile, setRiskProfile] = useState<'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE'>('BALANCED');
  const [autopilotOverrides, setAutopilotOverrides] = useState({
    reservePct: '', maxExposurePct: '', maxPositionPct: '', maxOpenPositions: '',
    minimumPositionUsd: '', dailyEntryLimit: '', drawdownStopPct: '',
  });
  const draftPolicy = useMemo<{
    limits: PaperAllocationLimits;
    tradingCapitalUsd: number | null;
    maxPositionUsd: number | null;
  } | null>(() => {
    try {
      const capital = Number(capitalUsd);
      if (!Number.isFinite(capital) || capital <= 0) return null;
      const policy = allocationMode === 'FIXED'
        ? fixedAllocationPolicy({
            capitalUsd,
            maxOpenPositions: Number(maxOpenPositions),
            reservePct: Number(reservePct),
          })
        : autopilotAllocationPolicy(riskProfile, {
            ...(autopilotOverrides.reservePct ? { reservePct: Number(autopilotOverrides.reservePct) } : {}),
            ...(autopilotOverrides.maxExposurePct ? { maxExposurePct: Number(autopilotOverrides.maxExposurePct) } : {}),
            ...(autopilotOverrides.maxPositionPct ? { maxPositionPct: Number(autopilotOverrides.maxPositionPct) } : {}),
            ...(autopilotOverrides.maxOpenPositions ? { maxOpenPositions: Number(autopilotOverrides.maxOpenPositions) } : {}),
            ...(autopilotOverrides.minimumPositionUsd ? { minimumPositionUsd: autopilotOverrides.minimumPositionUsd } : {}),
            ...(autopilotOverrides.dailyEntryLimit ? { dailyEntryLimit: Number(autopilotOverrides.dailyEntryLimit) } : {}),
            ...(autopilotOverrides.drawdownStopPct ? { drawdownStopPct: Number(autopilotOverrides.drawdownStopPct) } : {}),
          });
      return {
        limits: policy.limits,
        tradingCapitalUsd: capital * policy.limits.maxExposurePct / 100,
        maxPositionUsd: capital * policy.limits.maxPositionPct / 100,
      };
    } catch {
      return null;
    }
  }, [allocationMode, capitalUsd, maxOpenPositions, reservePct, riskProfile, autopilotOverrides]);

  useEffect(() => {
    const run = new URL(window.location.href).searchParams.get('run');
    if (run) setSelectedRunId(run);
  }, []);
  const selectedRun = useMemo(() => data?.decisions.find((run) => run.id === selectedRunId) ?? null, [data?.decisions, selectedRunId]);
  const { data: selectedToken } = useSWR<Token>(selectedRun?.tokenId ? `/tokens/${selectedRun.tokenId}` : null, fetcher);
  const terminal = useTerminalChart(selectedToken ?? null, interval);
  const { data: markers = [] } = useSWR<AgentChartMarker[]>(
    selectedRun?.tokenId ? `/admin/paper-agent/markers?tokenId=${encodeURIComponent(selectedRun.tokenId)}&interval=${interval}` : null,
    fetcher, { refreshInterval: 3_000 },
  );
  const notificationQuery = new URLSearchParams();
  if (eventType) notificationQuery.set('eventType', eventType);
  if (strategyFilter) notificationQuery.set('strategyKey', strategyFilter);
  if (unreadOnly) notificationQuery.set('unread', 'true');
  const { data: notificationData, mutate: mutateNotifications } = useSWR<{ unread: number; items: NotificationItem[] }>(
    `/admin/paper-agent/notifications?${notificationQuery}`, fetcher, { refreshInterval: 3_000 },
  );

  async function act(work: () => Promise<unknown>, fallback: string) {
    setBusy(true); setNotice(null);
    try { await work(); await Promise.all([mutate(), mutateNotifications()]); }
    catch (cause) { setNotice(errorMessage(cause, fallback)); }
    finally { setBusy(false); }
  }
  function chooseRun(run: AgentRun) {
    setSelectedRunId(run.id);
    const url = new URL(window.location.href); url.searchParams.set('run', run.id);
    window.history.replaceState(null, '', url);
  }

  if (error) return <div className="panel p-5 text-down">{errorMessage(error)}</div>;
  if (!data) return <AgentSkeleton />;
  // Позволяет выкатывать web и API независимо: старая версия API не должна
  // ронять админку до того, как Phase 3 окажется на сервере.
  const allocation = data.allocation ?? {
    configured: false,
    execution: 'PAPER' as const,
    network: 'Solana' as const,
    accounts: [],
    policies: [],
    comparison: [],
    hypotheses: [],
  };
  const focusMarkerId = selectedRun
    ? `${selectedRun.allocation?.id ?? selectedRun.id}:${selectedRun.exitAt ? 'sell' : 'buy'}`
    : null;

  return <div className="space-y-5 pb-12">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-3xl">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge tone="warn">PAPER</Badge><Badge tone="accent">Solana only</Badge>
          <Badge tone={data.health === 'ACTIVE' ? 'up' : data.health === 'REFUSED' ? 'down' : 'muted'}>{HEALTH_TEXT[data.health]}</Badge>
        </div>
        <h1 className="text-2xl font-bold">Автономный paper-агент</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">OKX Signal → детерминированное решение → виртуальная позиция. Реальные сделки, кошельки, RPC отправки и приватные ключи недостижимы.</p>
      </div>
      <button disabled={busy || (!data.control.isEnabled && !allocation.configured)} className={data.control.isEnabled ? 'btn-sell' : 'btn-buy'} onClick={() => act(
        () => api('/admin/paper-agent', { method: 'PUT', body: JSON.stringify({ isEnabled: !data.control.isEnabled }) }),
        'Не удалось изменить состояние агента',
      )}>{data.control.isEnabled ? 'Stop · запретить новые входы' : allocation.configured ? 'Start paper-агента' : 'Сначала настройте капитал'}</button>
    </header>
    {notice && <div className="panel border-warn/40 p-3 text-sm text-warn">{notice}</div>}

    <section className="panel overflow-hidden">
      <div className="border-b border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Распределение PAPER-капитала</h2>
            <p className="mt-1 text-xs text-muted">Один Signal и одна цена. ACTIVE и SHADOW имеют отдельные виртуальные балансы, резерв и лимиты.</p>
          </div>
          <div className="flex items-center gap-2"><Badge tone="warn">PAPER ONLY</Badge><Badge tone="accent">Solana</Badge></div>
        </div>
      </div>
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,.8fr)]">
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            {(['FIXED', 'AUTOPILOT'] as const).map((mode) => <button key={mode} type="button" onClick={() => setAllocationMode(mode)} className={`rounded-xl border p-4 text-left transition-colors motion-reduce:transition-none ${allocationMode === mode ? 'border-accent bg-accent/10' : 'border-border bg-raised hover:border-muted'}`}>
              <div className="flex items-center justify-between gap-3"><strong>{mode === 'FIXED' ? 'Fixed' : 'Autopilot'}</strong>{data.control.activeAllocationMode === mode && <Badge tone="up">ACTIVE MODE</Badge>}</div>
              <p className="mt-2 text-xs leading-relaxed text-muted">{mode === 'FIXED' ? 'Вы задаёте количество позиций, агент использует фиксированный лимит. Свободный слот сам по себе не вызывает покупку.' : 'Агент выбирает размер позиции по силе сигнала в установленных границах. Autopilot не является безлимитным.'}</p>
              {allocationMode === mode && draftPolicy && <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border/70 pt-3 text-[10px] text-muted">
                <span>Экспозиция ≤ {num(draftPolicy.limits.maxExposurePct, '%')}</span>
                <span>Резерв ≥ {num(draftPolicy.limits.reservePct, '%')}</span>
                <span>Позиция ≤ {money(draftPolicy.maxPositionUsd)}</span>
                <span>Открыто ≤ {draftPolicy.limits.maxOpenPositions}</span>
              </div>}
            </button>)}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs text-muted">Начальный капитал, USD<input className="input mt-1 w-full" inputMode="decimal" value={capitalUsd} onChange={(event) => setCapitalUsd(event.target.value)} /></label>
            {allocationMode === 'FIXED' ? <>
              <label className="text-xs text-muted">Максимум позиций<input className="input mt-1 w-full" inputMode="numeric" value={maxOpenPositions} onChange={(event) => setMaxOpenPositions(event.target.value)} /></label>
              <label className="text-xs text-muted">Резерв, %<input className="input mt-1 w-full" inputMode="decimal" value={reservePct} onChange={(event) => setReservePct(event.target.value)} /></label>
            </> : <label className="text-xs text-muted sm:col-span-2">Risk profile<select className="input mt-1 w-full" value={riskProfile} onChange={(event) => setRiskProfile(event.target.value as typeof riskProfile)}><option value="CONSERVATIVE">Conservative</option><option value="BALANCED">Balanced</option><option value="AGGRESSIVE">Aggressive</option></select></label>}
          </div>
          {draftPolicy ? <div className="grid gap-2 rounded-lg border border-border bg-raised p-3 text-xs text-muted sm:grid-cols-2 lg:grid-cols-4">
            <Small label="Торговый капитал" value={money(draftPolicy.tradingCapitalUsd)} />
            <Small label="Максимальная позиция" value={money(draftPolicy.maxPositionUsd)} />
            <Small label="Дневной лимит" value={num(draftPolicy.limits.dailyEntryLimit)} />
            <Small label="Drawdown stop" value={num(draftPolicy.limits.drawdownStopPct, '%')} />
          </div> : <div className="rounded-lg border border-down/30 bg-down/5 p-3 text-xs text-down">Проверьте капитал и лимиты: политика не может быть рассчитана.</div>}
          {allocationMode === 'AUTOPILOT' && <details className="rounded-lg border border-border bg-raised p-3 text-xs">
            <summary className="cursor-pointer font-medium">Расширенные hard limits Autopilot</summary>
            <p className="mt-2 text-muted">Пустое поле использует версионированный default профиля. Резерв и drawdown stop нельзя отключить.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {([
                ['reservePct', 'Минимальный резерв, %'], ['maxExposurePct', 'Макс. экспозиция, %'],
                ['maxPositionPct', 'Макс. позиция, %'], ['maxOpenPositions', 'Макс. позиций'],
                ['minimumPositionUsd', 'Мин. позиция, USD'], ['dailyEntryLimit', 'Входов в сутки'],
                ['drawdownStopPct', 'Drawdown stop, %'],
              ] as const).map(([key, label]) => <label key={key} className="text-muted">{label}<input className="input mt-1 w-full" inputMode="decimal" placeholder={draftPolicy ? String(draftPolicy.limits[key]) : ''} value={autopilotOverrides[key]} onChange={(event) => setAutopilotOverrides((current) => ({ ...current, [key]: event.target.value }))} /></label>)}
            </div>
          </details>}
          <details className="rounded-lg border border-border bg-raised p-3 text-xs">
            <summary className="cursor-pointer font-medium">Как принимается решение</summary>
            <div className="mt-3 grid gap-2 text-muted sm:grid-cols-2">
              <span>Только данные, известные в момент сигнала</span><span>Свежесть market data: до 60 секунд</span>
              <span>Резерв не участвует во входах</span><span>Лимиты позиций, дня и drawdown обязательны</span>
              <span>ATH и будущий PnL не входят в score</span><span>Все версии правил сохраняются в истории</span>
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-buy" disabled={busy} onClick={() => {
              if (!confirm('Создать новые изолированные ACTIVE и SHADOW PAPER-счета? Старые открытые позиции продолжат сопровождение.')) return;
              const payload = allocationMode === 'FIXED'
                ? { mode: allocationMode, capitalUsd, maxOpenPositions: Number(maxOpenPositions), reservePct: Number(reservePct), confirm: true }
                : { mode: allocationMode, capitalUsd, riskProfile, overrides: {
                    ...(autopilotOverrides.reservePct ? { reservePct: Number(autopilotOverrides.reservePct) } : {}),
                    ...(autopilotOverrides.maxExposurePct ? { maxExposurePct: Number(autopilotOverrides.maxExposurePct) } : {}),
                    ...(autopilotOverrides.maxPositionPct ? { maxPositionPct: Number(autopilotOverrides.maxPositionPct) } : {}),
                    ...(autopilotOverrides.maxOpenPositions ? { maxOpenPositions: Number(autopilotOverrides.maxOpenPositions) } : {}),
                    ...(autopilotOverrides.minimumPositionUsd ? { minimumPositionUsd: autopilotOverrides.minimumPositionUsd } : {}),
                    ...(autopilotOverrides.dailyEntryLimit ? { dailyEntryLimit: Number(autopilotOverrides.dailyEntryLimit) } : {}),
                    ...(autopilotOverrides.drawdownStopPct ? { drawdownStopPct: Number(autopilotOverrides.drawdownStopPct) } : {}),
                  }, confirm: true };
              void act(() => api('/admin/paper-agent/allocation', { method: 'PUT', body: JSON.stringify(payload) }), 'Не удалось настроить распределение капитала');
            }}>{allocation.configured ? 'Создать новую сессию' : 'Настроить PAPER-капитал'}</button>
            <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={data.control.learningModeEnabled} disabled={busy} onChange={(event) => act(
              () => api('/admin/paper-agent/learning', { method: 'PUT', body: JSON.stringify({ enabled: event.target.checked }) }),
              'Не удалось изменить learning mode',
            )} />Learning предлагает гипотезы, но не применяет их</label>
          </div>
        </div>
        <div className="space-y-3">
          {allocation.accounts.filter((account) => account.status !== 'CLOSED').map((account) => {
            const metrics = allocation.comparison.find((row) => row.accountId === account.id);
            const drawdownStopped = account.capital.drawdownPct != null && account.limits.drawdownStopPct != null && account.capital.drawdownPct >= account.limits.drawdownStopPct;
            const insufficientBalance = account.capital.freeUsd != null && account.limits.minimumPositionUsd != null && account.capital.freeUsd < account.limits.minimumPositionUsd;
            return <article key={account.id} className="rounded-xl border border-border bg-raised p-4">
              <div className="flex flex-wrap items-center gap-2"><strong>{account.kind}</strong><Badge tone={account.kind === 'ACTIVE' ? 'up' : 'muted'}>{account.mode}</Badge>{account.riskProfile && <Badge tone="accent">{account.riskProfile}</Badge>}{drawdownStopped && <Badge tone="down">DRAWDOWN STOP</Badge>}{insufficientBalance && <Badge tone="warn">НЕДОСТАТОЧНО БАЛАНСА</Badge>}<span className="ml-auto text-[10px] text-muted">v{account.policyVersion}</span></div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 xl:grid-cols-2">
                <Small label="Equity / peak" value={`${money(account.capital.equityUsd)} / ${money(account.capital.peakEquityUsd)}`} /><Small label="Свободно" value={money(account.capital.freeUsd)} />
                <Small label="Резерв" value={money(account.capital.reservedUsd)} /><Small label="В позициях" value={money(account.capital.inPositionsUsd)} />
                <Small label="Realized" value={money(account.capital.realizedPnlUsd)} /><Small label="Unrealized" value={money(account.capital.unrealizedPnlUsd)} />
                <Small label="Drawdown" value={`${num(account.capital.drawdownPct, '%')} / ${num(account.limits.drawdownStopPct, '%')}`} /><Small label="Открыто" value={`${account.openPositions}/${account.limits.maxOpenPositions}`} />
                <Small label="Входы сегодня" value={`${account.dailyEntries}/${account.limits.dailyEntryLimit}`} /><Small label="Последнее решение" value={metrics?.lastDecision ? `${metrics.lastDecision.code} · ${metrics.lastDecision.reason}` : 'Ждёт сигнал'} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-md border border-border p-2 text-[10px] text-muted">
                <span>Резерв ≥ {num(account.limits.reservePct, '%')}</span><span>Экспозиция ≤ {num(account.limits.maxExposurePct, '%')}</span>
                <span>Позиция ≤ {num(account.limits.maxPositionPct, '%')}</span><span>Мин. позиция {money(account.limits.minimumPositionUsd)}</span>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-[10px] text-muted"><span className="break-all">{account.policyKey} · v{account.policyVersion}</span><button className="btn-ghost min-h-0 px-2 py-1" disabled={busy || account.openPositions > 0} onClick={() => {
                if (!confirm('Сбросить этот PAPER-счёт? История и ledger останутся, будет создана новая сессия.')) return;
                void act(() => api(`/admin/paper-agent/allocation/${account.id}/reset`, { method: 'POST', body: JSON.stringify({ confirm: true }) }), 'Не удалось сбросить PAPER-счёт');
              }}>Сбросить</button></div>
            </article>;
          })}
          {allocation.accounts.filter((account) => account.status !== 'CLOSED').length === 0 && <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">Режим ещё не выбран. Агент остаётся OFF.</div>}
          <button disabled className="btn-ghost w-full opacity-60">Phase 4 · Live execution — недоступно</button>
        </div>
      </div>
      <AllocationMetrics rows={allocation.comparison} />
      <PolicyHistory policies={allocation.policies} activePolicyKey={data.control.activeAllocationPolicyKey} activePolicyVersion={data.control.activeAllocationPolicyVersion} />
      <LearningHypotheses hypotheses={allocation.hypotheses} busy={busy} act={act} />
    </section>

    <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-10">
      <Metric label="Уник. сигналов 24ч" value={num(data.metrics24h.uniqueSignals)} />
      <Metric label="Runs / решений" value={num(data.metrics24h.runs)} />
      <Metric label="Runs на сигнал" value={num(data.metrics24h.averageRunsPerSignal)} />
      <Metric label="Открыто" value={num(data.metrics24h.openPositions)} />
      <Metric label="Закрыто" value={num(data.metrics24h.states.PAPER_CLOSED ?? 0)} />
      <Metric label="Решение агента p50" value={num(data.metrics24h.decisionLatencyP50Ms, ' мс')} />
      <Metric label="Решение агента p95" value={num(data.metrics24h.decisionLatencyP95Ms, ' мс')} />
      <Metric label="Валидная выборка" value={num(data.metrics24h.decisionLatencySampleSize)} />
      <Metric label="Очередь" value={num(data.runtime.queued)} /><Metric label="Ошибки" value={num(data.metrics24h.errorRuns)} />
    </section>

    <section className="grid gap-3 lg:grid-cols-3">
      <StatusCard title="OKX Signal transport">
        <StatusLine label="Режим" value={data.okxSignal.transportMode === 'REST_ONLY' ? 'REST ONLY' : data.okxSignal.transportMode} />
        {data.okxSignal.accessMessage && <p className="mt-2 break-words text-xs text-warn">{data.okxSignal.accessMessage}</p>}
        <StatusLine label="Код OKX" value={data.okxSignal.permanentDenialCode ?? data.okxSignal.socket?.lastProviderCode ?? '—'} />
        <StatusLine label="Последний REST" value={timestamp(data.okxSignal.lastRestSuccessAt)} />
        <StatusLine label="Последний сигнал" value={timestamp(data.okxSignal.lastSignalAt)} />
        <StatusLine label="Следующий REST" value={timestamp(data.okxSignal.nextRestReconciliationAt)} />
        <StatusLine label="REST ошибка" value={data.okxSignal.lastRestErrorCode ?? '—'} />
        {data.okxSignal.transportMode !== 'REST_ONLY' && <><StatusLine label="WebSocket" value={data.okxSignal.socket?.state ?? 'не подключён'} /><StatusLine label="Reconnect" value={num(data.okxSignal.socket?.reconnects ?? null)} /></>}
      </StatusCard>
      <StatusCard title="Уведомления">
        <StatusLine label="Непрочитано" value={num(data.notifications.unread)} /><StatusLine label="Ожидают внимания" value={num(data.notifications.pending)} />
        <StatusLine label="Telegram" value={data.notifications.telegramEnabled ? data.notifications.transport : 'выключен'} />
        <label className="mt-3 flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={data.control.telegramShadowEnabled} disabled={busy || !data.notifications.telegramEnabled} onChange={(event) => act(
          () => api('/admin/paper-agent/telegram-shadow', { method: 'PUT', body: JSON.stringify({ enabled: event.target.checked }) }),
          'Не удалось изменить Telegram для shadow',
        )} />Отправлять shadow в Telegram</label>
      </StatusCard>
      <StatusCard title="Гарантии контура"><StatusLine label="Execution" value="paper only" /><StatusLine label="Новые входы" value={data.control.isEnabled ? 'разрешены' : 'запрещены'} /><StatusLine label="Позиции при Stop" value="продолжают оцениваться" /></StatusCard>
    </section>

    <section className="grid gap-3 lg:grid-cols-3">
      <StatusCard title="Доставка провайдера · live">
        <StatusLine label="p50 / p95" value={`${num(data.metrics24h.providerDeliveryLatencyP50Ms)} / ${num(data.metrics24h.providerDeliveryLatencyP95Ms)} мс`} />
        <StatusLine label="Выборка" value={num(data.metrics24h.providerDeliveryLatencySampleSize)} />
      </StatusCard>
      <StatusCard title="End-to-end · не скорость агента">
        <StatusLine label="p50 / p95" value={`${num(data.metrics24h.endToEndLatencyP50Ms)} / ${num(data.metrics24h.endToEndLatencyP95Ms)} мс`} />
        <StatusLine label="Выборка" value={num(data.metrics24h.endToEndLatencySampleSize)} />
      </StatusCard>
      <StatusCard title="Происхождение сигналов">
        {Object.entries(data.metrics24h.signalOrigins).map(([key, value]) => <StatusLine key={key} label={key} value={num(value)} />)}
        <StatusLine label="Отфильтровано не-Solana" value={num(data.metrics24h.ingestCodes.FILTERED_UNSUPPORTED_NETWORK ?? 0)} />
      </StatusCard>
    </section>

    <section className="panel overflow-hidden">
      <div className="border-b border-border p-4"><h2 className="font-semibold">Baseline и четыре shadow-стратегии</h2><p className="mt-1 text-xs text-muted">Eligibility и выходы продолжают сравниваться независимо от allocation mode. Два капиталовых контура применяются только к baseline, поэтому произведения 5×2 нет.</p></div>
      <div className="scroll-x"><table className="w-full min-w-[1500px] text-left text-xs">
        <thead className="bg-raised text-muted"><tr>{['Версия','Сигналы','Входы','Закрыто','Skip','Win','Avg PnL','Median PnL','Net PnL','Profit factor','Avg max','Worst DD','Avg duration','p50 / p95','Расходы','Выборка',''].map((label) => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead>
        <tbody className="divide-y divide-border">{data.comparison.map((row) => <tr key={row.key}>
          <td className="px-3 py-3"><div className="font-medium">{row.label}</div><div className="mt-1 text-[10px] text-muted">{row.isBaseline ? 'BASELINE' : 'SHADOW'} · {row.key}</div></td>
          <Cell value={num(row.signals)} /><Cell value={num(row.entries)} /><Cell value={num(row.closed)} /><Cell value={num(row.skipRatePct, '%')} /><Cell value={num(row.winRatePct, '%')} />
          <Cell value={money(row.averagePnlUsd)} /><Cell value={money(row.medianPnlUsd)} /><Cell value={money(row.totalNetPnlUsd)} /><Cell value={num(row.profitFactor)} />
          <Cell value={num(row.averageMaxMultiple, '×')} /><Cell value={num(row.worstDrawdownPct, '%')} /><Cell value={duration(row.averageDurationMs)} /><Cell value={`${num(row.decisionLatencyP50Ms)} / ${num(row.decisionLatencyP95Ms)} мс`} /><Cell value={money(row.totalCostsUsd)} />
          <td className="px-3 py-3">{row.enoughData ? row.sampleSize : `Недостаточно данных · ${row.sampleSize}/${row.minimumSampleSize}`}</td>
          <td className="px-3 py-3">{!row.isBaseline && <button className="btn-ghost min-h-0 px-2 py-1 text-[11px]" disabled={busy} onClick={() => {
            if (!confirm('Назначить shadow новым baseline? История останется неизменной.')) return;
            void act(() => api('/admin/paper-agent/promote', { method: 'POST', body: JSON.stringify({ strategyKey: row.key, confirm: true }) }), 'Не удалось сменить baseline');
          }}>Продвинуть вручную</button>}</td>
        </tr>)}</tbody>
      </table></div>
    </section>

    <section className="grid gap-3 xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="panel max-h-[720px] overflow-y-auto"><div className="sticky top-0 border-b border-border bg-panel p-4"><h2 className="font-semibold">Позиции и решения</h2></div>
        {data.decisions.map((run) => <button key={run.id} className={`block w-full border-b border-border p-3 text-left text-xs transition-colors motion-reduce:transition-none ${selectedRunId === run.id ? 'bg-accent/10' : 'hover:bg-raised'}`} onClick={() => chooseRun(run)}>
          <div className="flex items-center justify-between gap-2"><strong>{run.symbol}</strong><span className="num">{money(run.realizedPnlUsd ?? run.unrealizedPnlUsd)}</span></div>
          <div className="mt-1 text-muted">{run.strategyLabel} · {run.decisionCode ?? run.state}</div><div className="mt-1 break-all text-[10px] text-muted">{run.address}</div>
        </button>)}{data.decisions.length === 0 && <p className="p-8 text-center text-sm text-muted">Сигналов пока нет</p>}
      </div>
      <div className="panel min-w-0 overflow-hidden">
        <ChartPanel token={terminal.token} chart={terminal.chart} onRetry={() => void terminal.reload()} interval={interval} onInterval={setInterval} chartHeight={420} loadOlder={terminal.loadOlder} markers={markers} focusMarkerId={focusMarkerId} />
        {selectedRun && <div className="grid gap-2 border-t border-border p-4 text-xs sm:grid-cols-2 xl:grid-cols-4">
          <Small label="Режим капитала" value={selectedRun.allocation?.legacy ? (selectedRun.allocation.label ?? 'Legacy Phase 1/2') : `${selectedRun.allocation?.mode ?? '—'}${selectedRun.allocation?.riskProfile ? ` · ${selectedRun.allocation.riskProfile}` : ''}`} />
          <Small label="Распределено" value={selectedRun.allocation?.allocatedUsd == null ? '—' : `${money(selectedRun.allocation.allocatedUsd)} · ${num(selectedRun.allocation.capitalPct ?? null, '% капитала')}`} />
          <Small label="Signal score" value={selectedRun.allocation?.signalScore == null ? '—' : `${num(selectedRun.allocation.signalScore)} · ${selectedRun.allocation.signalBand ?? '—'}`} />
          <Small label="Причина решения" value={selectedRun.allocation?.reason ?? selectedRun.decisionCode ?? '—'} />
          <Small label="Модель расходов" value={selectedRun.costModelKey ?? '—'} /><Small label="Торговая комиссия" value={num(selectedRun.tradeFeeBps, ' bps / сторона')} />
          <Small label="Проскальзывание вход / выход" value={`${num(selectedRun.entrySlippageBps)} / ${num(selectedRun.exitSlippageBps)} bps`} /><Small label="Сеть Solana" value={`${money(selectedRun.networkFeeUsdPerSide)} / сторона`} />
          <Small label="Все расходы" value={money(selectedRun.totalCostsUsd)} /><Small label="Длительность" value={duration(selectedRun.durationMs)} /><Small label="Max multiple" value={num(selectedRun.maxMultiple, '×')} /><Small label="Max drawdown" value={num(selectedRun.maxDrawdownPct, '%')} />
        </div>}
      </div>
    </section>

    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-4"><h2 className="mr-auto font-semibold">Сохранённые уведомления · {notificationData?.unread ?? 0} непрочитано</h2>
        <select value={strategyFilter} onChange={(e) => setStrategyFilter(e.target.value)} className="input min-h-9 text-xs"><option value="">Все стратегии</option>{data.comparison.map((row) => <option key={row.key} value={row.key}>{row.label}</option>)}</select>
        <select value={eventType} onChange={(e) => setEventType(e.target.value)} className="input min-h-9 text-xs"><option value="">Все события</option>{['PAPER_BUY','PAPER_SELL','TRADE_RESULT','CRITICAL_ERROR','OKX_WS_LOST','OKX_WS_RESTORED'].map((event) => <option key={event} value={event}>{event}</option>)}</select>
        <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />Только непрочитанные</label>
      </div>
      <div className="max-h-[560px] divide-y divide-border overflow-y-auto">{notificationData?.items.map((item) => <article key={item.id} className={`p-4 text-xs ${item.isRead ? 'opacity-70' : ''}`}>
        <div className="flex flex-wrap items-center gap-2"><Badge tone="warn">PAPER</Badge><strong>{item.eventType}</strong><span className="text-muted">{new Date(item.createdAt).toLocaleString('ru-RU')}</span><span className="ml-auto text-muted">Telegram: {item.telegramStatus}</span></div>
        <div className="mt-2 grid gap-1 sm:grid-cols-2"><span>{String(item.payload.symbol ?? 'system')} · {String(item.payload.network ?? 'Solana')}</span><span>{String(item.payload.strategyLabel ?? item.strategyKey ?? 'system')}</span>{item.payload.address != null && <code className="break-all sm:col-span-2">{String(item.payload.address)}</code>}{item.payload.allocationMode != null && <span>Капитал: {String(item.payload.allocationMode)}{item.payload.riskProfile != null ? ` · ${String(item.payload.riskProfile)}` : ''}{item.payload.shadow === true ? ' · SHADOW' : ' · ACTIVE'}</span>}{item.payload.allocatedUsd != null && <span>Распределено: {money(Number(item.payload.allocatedUsd))} · {num(Number(item.payload.capitalPct), '%')}</span>}{item.payload.signalScore != null && <span className="sm:col-span-2">Score: {num(Number(item.payload.signalScore))} · {String(item.payload.signalBand ?? '—')} · {String(item.payload.allocationReason ?? '—')}</span>}{item.payload.freeAfterUsd != null && <span>После решения · свободно: {money(Number(item.payload.freeAfterUsd))}</span>}{item.payload.reserveAfterUsd != null && <span>резерв: {money(Number(item.payload.reserveAfterUsd))}</span>}{item.payload.exposureAfterUsd != null && <span>экспозиция: {money(Number(item.payload.exposureAfterUsd))}</span>}{item.payload.pnlUsd != null && <span>Net PnL: {money(Number(item.payload.pnlUsd))}</span>}{item.payload.totalCostsUsd != null && <span>Расходы: {money(Number(item.payload.totalCostsUsd))}</span>}</div>
        <div className="mt-3 flex flex-wrap gap-2">{item.runId && <button className="btn-ghost min-h-0 px-2 py-1" onClick={() => { const run = data.decisions.find((row) => row.id === item.runId); if (run) chooseRun(run); }}>К сделке и графику</button>}
          <button className="btn-ghost min-h-0 px-2 py-1" onClick={() => act(() => api(`/admin/paper-agent/notifications/${item.id}/read`, { method: 'PATCH', body: JSON.stringify({ isRead: !item.isRead }) }), 'Не удалось изменить уведомление')}>{item.isRead ? 'Отметить непрочитанным' : 'Прочитано'}</button>
          {['FAILED', 'AMBIGUOUS'].includes(item.telegramStatus) && <button className="btn-ghost min-h-0 px-2 py-1 text-warn" onClick={() => {
            if (item.telegramStatus === 'AMBIGUOUS' && !confirm('Telegram мог уже принять сообщение. Повтор может создать дубль. Продолжить вручную?')) return;
            void act(() => api(`/admin/paper-agent/notifications/${item.id}/retry`, { method: 'POST' }), 'Повтор доставки не выполнен');
          }}>Повторить Telegram</button>}
          {item.telegramErrorCode && <span className="self-center text-warn">{item.telegramErrorCode}</span>}
        </div>
      </article>)}{notificationData?.items.length === 0 && <p className="p-8 text-center text-sm text-muted">Уведомлений пока нет</p>}</div>
    </section>

    <section className="panel p-4">
      <h2 className="font-semibold">Причины пропусков · 24ч</h2>
      <p className="mt-1 text-xs text-muted">Runs учитывают каждую стратегию; уникальные сигналы считаются один раз на причину.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(data.metrics24h.skipReasons).map(([reason, count]) => <div key={reason} className="flex justify-between gap-3 text-xs"><span className="break-all text-muted">{reason}</span><span className="num">{count} runs · {data.metrics24h.skipReasonsUniqueSignals[reason] ?? 0} сигналов</span></div>)}
        {Object.keys(data.metrics24h.skipReasons).length === 0 && <p className="text-xs text-muted">Пока нет данных</p>}
      </div>
      <details className="mt-4 border-t border-border pt-3">
        <summary className="cursor-pointer text-xs text-muted">По ACTIVE / SHADOW</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {Object.entries(data.metrics24h.skipReasonsByContour).map(([contour, reasons]) => <div key={contour}><div className="text-xs font-medium">{contour}</div><div className="mt-1 flex flex-wrap gap-2">{Object.entries(reasons).map(([reason, count]) => <span key={reason} className="rounded border border-border px-2 py-1 text-[10px] text-muted">{reason}: {count}</span>)}</div></div>)}
        </div>
      </details>
      <details className="mt-4 border-t border-border pt-3">
        <summary className="cursor-pointer text-xs text-muted">По стратегиям и версиям</summary>
        <div className="mt-3 space-y-3">{Object.entries(data.metrics24h.skipReasonsByStrategy).map(([strategy, reasons]) => <div key={strategy}><div className="break-all text-xs font-medium">{strategy}</div><div className="mt-1 flex flex-wrap gap-2">{Object.entries(reasons).map(([reason, count]) => <span key={reason} className="rounded border border-border px-2 py-1 text-[10px] text-muted">{reason}: {count}</span>)}</div></div>)}</div>
      </details>
    </section>
  </div>;
}

function AllocationMetrics({ rows }: { rows: AllocationComparison[] }) {
  if (rows.length === 0) return null;
  const headings = [
    'Контур / policy', 'Equity', 'Использование', 'Avg / median allocation',
    'Signals', 'Entries', 'Skip', 'Miss balance', 'Miss exposure', 'Miss positions',
    'Open / closed', 'Realized', 'Unrealized', 'Net PnL', 'Win / PF', 'Max DD',
    'Turnover', 'Fee / slippage / network', 'Avg hold', 'Avg / max multiple',
    'Latency p50 / p95', 'Выборка',
  ];
  return <div className="border-t border-border">
    <div className="p-4">
      <h3 className="text-sm font-semibold">Метрики распределения капитала</h3>
      <p className="mt-1 text-xs text-muted">Каждая строка изолирована по сессии, контуру и версии policy. Данные разных версий не объединяются.</p>
    </div>
    <div className="scroll-x border-t border-border">
      <table className="w-full min-w-[2500px] text-left text-xs">
        <thead className="bg-raised text-muted"><tr>{headings.map((label) => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead>
        <tbody className="divide-y divide-border">{rows.map((row) => <tr key={row.accountId}>
          <td className="px-3 py-3"><div className="font-medium">{row.kind} · {row.mode}{row.riskProfile ? ` · ${row.riskProfile}` : ''}</div><div className="mt-1 break-all text-[10px] text-muted">{row.policyKey} · v{row.policyVersion}</div></td>
          <Cell value={money(row.capital.equityUsd)} /><Cell value={num(row.capitalUtilizationPct, '%')} />
          <Cell value={`${money(row.averageAllocationUsd)} / ${money(row.medianAllocationUsd)}`} />
          <Cell value={num(row.signals)} /><Cell value={num(row.entries)} /><Cell value={num(row.skipped)} />
          <Cell value={num(row.missedInsufficientBalance)} /><Cell value={num(row.missedExposureLimit)} /><Cell value={num(row.missedMaxPositions)} />
          <Cell value={`${num(row.open)} / ${num(row.closed)}`} /><Cell value={money(row.realizedPnlUsd)} /><Cell value={money(row.unrealizedPnlUsd)} /><Cell value={money(row.netPnlUsd)} />
          <Cell value={`${num(row.winRatePct, '%')} / ${num(row.profitFactor)}`} /><Cell value={num(row.maxDrawdownPct, '%')} /><Cell value={money(row.turnoverUsd)} />
          <Cell value={`${money(row.tradingFeesUsd)} / ${money(row.slippageUsd)} / ${money(row.networkCostsUsd)}`} />
          <Cell value={duration(row.averageHoldingMs)} /><Cell value={`${num(row.averageMaxMultiple, '×')} / ${num(row.maxMultiple, '×')}`} />
          <Cell value={`${num(row.decisionLatencyP50Ms)} / ${num(row.decisionLatencyP95Ms)} мс`} />
          <td className="px-3 py-3">{row.enoughData ? row.sampleSize : `Недостаточно · ${row.sampleSize}/${row.minimumSampleSize}`}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div className="grid gap-3 border-t border-border p-4 lg:grid-cols-2">{rows.map((row) => <details key={`${row.accountId}:buckets`} className="rounded-lg border border-border bg-raised p-3 text-xs">
      <summary className="cursor-pointer font-medium">{row.kind} · {row.mode} · PnL по источнику и score band</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <MetricBuckets title="Source type" buckets={row.pnlBySourceType} />
        <MetricBuckets title="Score band" buckets={row.pnlByScoreBand} />
      </div>
      <div className="mt-3 grid gap-2 border-t border-border pt-3 text-muted sm:grid-cols-3">
        <span>Avg reserve: {money(row.averageReserveUsd)}</span><span>Avg exposure: {money(row.averageExposureUsd)}</span><span>Current: {money(row.currentExposureUsd)} / reserve {money(row.currentReserveUsd)}</span>
        <span className="sm:col-span-3">Последнее решение: {row.lastDecision ? `${row.lastDecision.code} · ${row.lastDecision.reason}` : '—'}</span>
      </div>
    </details>)}</div>
  </div>;
}

function MetricBuckets({ title, buckets }: { title: string; buckets: Record<string, { count: number; netPnlUsd: number }> }) {
  const entries = Object.entries(buckets);
  return <div><div className="font-medium">{title}</div><div className="mt-2 space-y-1">{entries.map(([key, bucket]) => <div key={key} className="flex justify-between gap-3 text-muted"><span>{key} · n={bucket.count}</span><span className="num">{money(bucket.netPnlUsd)}</span></div>)}{entries.length === 0 && <span className="text-muted">Нет данных</span>}</div></div>;
}

function PolicyHistory({ policies, activePolicyKey, activePolicyVersion }: {
  policies: AllocationPolicy[];
  activePolicyKey: string | null;
  activePolicyVersion: number | null;
}) {
  if (policies.length === 0) return null;
  return <div className="border-t border-border p-4">
    <h3 className="text-sm font-semibold">Неизменяемая история policy</h3>
    <p className="mt-1 text-xs text-muted">Новая настройка создаёт новую версию и сессию. Старые сделки всегда остаются связаны со своим snapshot.</p>
    <div className="mt-3 grid gap-3 lg:grid-cols-2">{policies.map((policy) => {
      const active = policy.policyKey === activePolicyKey && policy.version === activePolicyVersion;
      return <details key={policy.id} className="rounded-lg border border-border bg-raised p-3 text-xs">
        <summary className="cursor-pointer">
          <span className="font-medium">{policy.label}</span>
          <span className="ml-2 text-muted">{policy.mode}{policy.riskProfile ? ` · ${policy.riskProfile}` : ''} · v{policy.version}</span>
          {active && <span className="ml-2 text-up">ACTIVE</span>}
        </summary>
        <div className="mt-3 grid gap-2 text-muted sm:grid-cols-2">
          <span>Status: {policy.status} · {policy.source}</span><span>Sample: {policy.sampleSize ?? '—'}</span>
          <span>Создана: {new Date(policy.createdAt).toLocaleString('ru-RU')}</span>
          <span>Период: {formatPeriod(policy.periodStart, policy.periodEnd)}</span>
          <code className="break-all sm:col-span-2">{policy.policyKey} · v{policy.version}</code>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border p-2 sm:col-span-2">{JSON.stringify(policy.limits, null, 2)}</pre>
        </div>
      </details>;
    })}</div>
  </div>;
}

function LearningHypotheses({ hypotheses, busy, act }: {
  hypotheses: AllocationHypothesis[];
  busy: boolean;
  act: (work: () => Promise<unknown>, fallback: string) => Promise<void>;
}) {
  if (hypotheses.length === 0) return null;
  return <div className="border-t border-border p-4">
    <h3 className="text-sm font-semibold">Гипотезы learning mode</h3>
    <p className="mt-1 text-xs text-muted">Learning только предлагает более осторожную policy. Автоприменение и повышение hard limits запрещены.</p>
    <div className="mt-3 grid gap-3 lg:grid-cols-2">{hypotheses.map((hypothesis) => {
      const metrics = recordOf(hypothesis.metrics);
      const uncertainty = recordOf(metrics.statisticalUncertainty);
      const comparison = recordOf(metrics.comparisonToActive);
      const sample = hypothesis.sampleSize ?? 0;
      const enough = sample >= 30 && uncertainty.sufficient === true;
      return <article key={hypothesis.id} className="rounded-lg border border-warn/30 bg-warn/5 p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2"><strong>{hypothesis.label}</strong><Badge tone={enough ? 'warn' : 'muted'}>{enough ? 'REVIEW' : 'НЕДОСТАТОЧНО ДАННЫХ'}</Badge></div>
        <div className="mt-3 grid gap-2 text-muted sm:grid-cols-2">
          <span>Период: {formatPeriod(hypothesis.periodStart, hypothesis.periodEnd)}</span><span>Выборка: {sample}</span>
          <span>Net PnL: {money(finiteNumber(metrics.netPnlUsd))}</span><span>Worst DD: {num(finiteNumber(metrics.worstDrawdownPct), '%')}</span>
          <span>Win: {num(finiteNumber(metrics.winRatePct), '%')}</span><span>Profit factor: {num(finiteNumber(metrics.profitFactor))}</span>
          <span>Использование: {num(finiteNumber(metrics.capitalUtilizationPct), '%')}</span><span>Avg allocation: {money(finiteNumber(metrics.averageAllocationUsd))}</span>
          <span>Avg hold: {duration(finiteNumber(metrics.averageHoldingMs))}</span><span>Расходы: {money(finiteNumber(metrics.totalCostsUsd))}</span>
          <span className="sm:col-span-2">Неопределённость win rate 95%: ±{num(finiteNumber(uncertainty.winRateMarginPct95), ' п.п.')}</span>
          <span className="sm:col-span-2">Max position: {money(finiteNumber(comparison.estimatedMaxPositionUsdBefore))} → {money(finiteNumber(comparison.estimatedMaxPositionUsdAfter))}. Hard limits увеличены: {comparison.increasesAnyHardLimit === true ? 'ДА — ОШИБКА' : 'нет'}.</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2"><button disabled={busy} className="btn-ghost min-h-0 px-2 py-1" onClick={() => act(() => api(`/admin/paper-agent/allocation-policies/${hypothesis.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'PROMOTE', confirm: true }) }), 'Не удалось принять гипотезу')}>Принять для ручной настройки</button><button disabled={busy} className="btn-ghost min-h-0 px-2 py-1" onClick={() => act(() => api(`/admin/paper-agent/allocation-policies/${hypothesis.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'REJECT', confirm: true }) }), 'Не удалось отклонить гипотезу')}>Отклонить</button></div>
      </article>;
    })}</div>
  </div>;
}

function formatPeriod(start: string | null, end: string | null): string {
  if (!start && !end) return '—';
  return `${start ? new Date(start).toLocaleDateString('ru-RU') : '—'} — ${end ? new Date(end).toLocaleDateString('ru-RU') : '—'}`;
}

function Badge({ children, tone }: { children: ReactNode; tone: 'warn' | 'accent' | 'up' | 'down' | 'muted' }) {
  const colors = { warn: 'border-warn/40 bg-warn/10 text-warn', accent: 'border-accent/40 bg-accent/10 text-accent', up: 'border-up/40 bg-up/10 text-up', down: 'border-down/40 bg-down/10 text-down', muted: 'border-border bg-raised text-muted' };
  return <span className={`rounded border px-2 py-1 text-[10px] font-semibold tracking-wide ${colors[tone]}`}>{children}</span>;
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="panel p-3"><div className="text-[11px] text-muted">{label}</div><div className="mt-1 num text-lg">{value}</div></div>; }
function StatusCard({ title, children }: { title: string; children: ReactNode }) { return <div className="panel p-4"><h2 className="text-sm font-semibold">{title}</h2><div className="mt-3 space-y-2">{children}</div></div>; }
function StatusLine({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-3 text-xs"><span className="text-muted">{label}</span><span className="break-all text-right num">{value}</span></div>; }
function Small({ label, value }: { label: string; value: string }) { return <div><div className="text-muted">{label}</div><div className="mt-0.5 break-all num">{value}</div></div>; }
function Cell({ value }: { value: string }) { return <td className="px-3 py-3 num">{value}</td>; }
function AgentSkeleton() { return <div className="space-y-4"><div className="skeleton h-24" /><div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <div key={index} className="skeleton h-24" />)}</div><div className="skeleton h-[520px]" /></div>; }
