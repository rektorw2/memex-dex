'use client';

import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { fetcher, api, errorMessage } from '@/lib/api';
import { CHAINS, chainLabel } from '@/lib/chains';

/**
 * Управление автопубликацией.
 *
 * Устроено так, чтобы включить боевой режим было труднее, чем режим
 * наблюдения. Автоматика публикует от вашего имени, и разница между
 * «посмотреть, что бы получилось» и «выпустить это пользователям»
 * должна быть видна в интерфейсе, а не только в названии галочки.
 */

interface Rule {
  id: string;
  name: string;
  isEnabled: boolean;
  isDryRun: boolean;
  chains: string[];
  minSmartBuyers: number;
  minSignalStrength: number;
  minSmartVolumeUsd: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  maxRiskScore: number;
  maxPoolAgeHours: number;
  maxCallsPerDay: number;
  cooldownMinutes: number;
  targetPcts: number[];
  stopLossPct: number;
  suggestedPct: number;
  timeHorizon: string;
  isCopyEnabled: boolean;
  lastFiredAt: string | null;
}

interface RuleResponse {
  rule: Rule;
  stats: { firedToday: number; dryRunToday: number; skippedToday: number; totalFired: number };
}

interface LogEntry {
  id: string;
  chain: string;
  symbol: string;
  address: string;
  outcome: string;
  reason: string;
  callId: string | null;
  createdAt: string;
}

const OUTCOMES: Record<string, { text: string; cls: string }> = {
  FIRED: { text: 'опубликовано', cls: 'text-up border-up/40 bg-up/10' },
  DRY_RUN: { text: 'наблюдение', cls: 'text-accent border-accent/40 bg-accent/10' },
  SKIPPED: { text: 'пропущено', cls: 'text-muted border-border' },
};

export default function AutoRulePage() {
  const { data, error, mutate } = useSWR<RuleResponse>('/admin/auto-rule', fetcher, {
    refreshInterval: 30_000,
  });

  const [draft, setDraft] = useState<Rule | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<string>('all');

  useEffect(() => {
    if (data?.rule && !draft) setDraft(data.rule);
  }, [data, draft]);

  const { data: log, mutate: mutateLog } = useSWR<{ entries: LogEntry[] }>(
    `/admin/auto-rule/log?outcome=${logFilter}&limit=60`,
    fetcher,
    { refreshInterval: 30_000 },
  );

  if (error) {
    return (
      <p className="text-down border-down/30 bg-down/10 rounded border p-3 text-sm">
        {errorMessage(error, 'Не удалось загрузить правило')}
      </p>
    );
  }

  if (!data || !draft) return <p className="text-muted py-12 text-center text-sm">Загрузка…</p>;

  const set = <K extends keyof Rule>(k: K, v: Rule[K]) => setDraft({ ...draft, [k]: v });

  async function save(patch: Partial<Rule> = {}) {
    setBusy(true);
    setNotice(null);
    try {
      const body = { ...draft, ...patch };
      const r: any = await api('/admin/auto-rule', {
        method: 'PUT',
        body: JSON.stringify({
          name: body!.name,
          isEnabled: body!.isEnabled,
          isDryRun: body!.isDryRun,
          chains: body!.chains,
          minSmartBuyers: body!.minSmartBuyers,
          minSignalStrength: body!.minSignalStrength,
          minSmartVolumeUsd: body!.minSmartVolumeUsd,
          minLiquidityUsd: body!.minLiquidityUsd,
          minVolume24hUsd: body!.minVolume24hUsd,
          maxRiskScore: body!.maxRiskScore,
          maxPoolAgeHours: body!.maxPoolAgeHours,
          maxCallsPerDay: body!.maxCallsPerDay,
          cooldownMinutes: body!.cooldownMinutes,
          targetPcts: body!.targetPcts,
          stopLossPct: body!.stopLossPct,
          suggestedPct: body!.suggestedPct,
          timeHorizon: body!.timeHorizon,
          isCopyEnabled: body!.isCopyEnabled,
        }),
      });
      setDraft(r.rule);
      setNotice('Настройки сохранены');
      mutate();
    } catch (e) {
      setNotice(errorMessage(e, 'Не удалось сохранить'));
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);
    setNotice(null);
    try {
      const r: any = await api('/admin/auto-rule/run', { method: 'POST' });
      setNotice(
        r.enabled
          ? `Проверено находок: ${r.checked}, опубликовано: ${r.fired}, в наблюдении: ${r.dryRun}, пропущено: ${r.skipped}`
          : 'Правило выключено — проход не выполнялся',
      );
      mutate();
      mutateLog();
    } catch (e) {
      setNotice(errorMessage(e, 'Проход не выполнен'));
    } finally {
      setBusy(false);
    }
  }

  const live = draft.isEnabled && !draft.isDryRun;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-medium">Автопубликация коллов</h1>
        <p className="text-muted mt-1 max-w-2xl text-xs leading-relaxed">
          Правило само публикует коллы по находкам радара, где покупали кошельки
          с подтверждённой историей. Источник находок при этом не важен: они
          приходят и из сканера новых пулов, и из ручного добавления, и от
          внешних скриптов через ключ приёма — проверка у всех одна.
        </p>
      </div>

      {/* Состояние — крупно и первым делом. */}
      <div
        className={`panel p-4 ${live ? 'border-up/50' : draft.isEnabled ? 'border-accent/50' : ''}`}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-sm font-medium">
            {!draft.isEnabled
              ? 'Выключено'
              : draft.isDryRun
                ? 'Режим наблюдения'
                : 'Боевой режим — коллы публикуются'}
          </span>

          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.isEnabled}
              onChange={(e) => save({ isEnabled: e.target.checked })}
            />
            Включить правило
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.isDryRun}
              disabled={!draft.isEnabled}
              onChange={(e) => {
                if (!e.target.checked) {
                  // Переход в боевой режим — единственное действие здесь,
                  // которое видят пользователи. Подтверждение уместно
                  // именно тут, а не на каждом сохранении.
                  const ok = confirm(
                    'Выключить режим наблюдения?\n\n' +
                      'Правило начнёт публиковать коллы от вашего имени без ' +
                      'подтверждения. Они сразу станут видны пользователям.',
                  );
                  if (!ok) return;
                }
                save({ isDryRun: e.target.checked });
              }}
            />
            Только наблюдать, не публиковать
          </label>

          <button onClick={runNow} disabled={busy} className="btn-ghost ml-auto text-xs">
            {busy ? 'Идёт проход…' : 'Прогнать сейчас'}
          </button>
        </div>

        <div className="text-muted mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <span>
            опубликовано за сутки: <span className="num text-white">{data.stats.firedToday}</span>
          </span>
          <span>
            {/* В режиме наблюдения именно это число отвечает на вопрос
                «сколько бы правило наделало». */}
            в наблюдении за сутки:{' '}
            <span className="num text-white">{data.stats.dryRunToday}</span>
          </span>
          <span>
            отказов: <span className="num">{data.stats.skippedToday}</span>
          </span>
          <span>
            всего публикаций: <span className="num">{data.stats.totalFired}</span>
          </span>
        </div>

        {draft.isEnabled && draft.isDryRun && (
          <p className="text-muted mt-3 text-xs leading-relaxed">
            Ничего не публикуется. Понаблюдайте несколько дней за колонкой
            «в наблюдении» в журнале ниже: там видно, какие коллы вышли бы
            при этих настройках.
          </p>
        )}
      </div>

      {notice && (
        <p className="border-border bg-panel text-muted rounded border p-2 text-xs">{notice}</p>
      )}

      {/* Условия срабатывания */}
      <div className="panel space-y-4 p-4">
        <h2 className="font-medium">Когда срабатывать</h2>

        <div>
          <h3 className="text-muted mb-2 text-xs">Активность кошельков — основной триггер</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <Num
              label="Кошельков с историей"
              value={draft.minSmartBuyers}
              onChange={(v) => set('minSmartBuyers', v)}
              hint="Минимум размеченных покупателей"
            />
            <Num
              label="Сила сигнала"
              value={draft.minSignalStrength}
              onChange={(v) => set('minSignalStrength', v)}
              hint="0–100, учитывает давность покупок"
            />
            <Num
              label="Объём смарт-покупок, $"
              value={draft.minSmartVolumeUsd}
              onChange={(v) => set('minSmartVolumeUsd', v)}
              step={500}
            />
          </div>
        </div>

        <div>
          <h3 className="text-muted mb-2 text-xs">
            Страховочные условия — проверяются всегда, даже при сильном сигнале
          </h3>
          <div className="grid gap-3 sm:grid-cols-4">
            <Num
              label="Ликвидность от, $"
              value={draft.minLiquidityUsd}
              onChange={(v) => set('minLiquidityUsd', v)}
              step={5000}
            />
            <Num
              label="Объём 24ч от, $"
              value={draft.minVolume24hUsd}
              onChange={(v) => set('minVolume24hUsd', v)}
              step={5000}
            />
            <Num
              label="Риск до"
              value={draft.maxRiskScore}
              onChange={(v) => set('maxRiskScore', v)}
            />
            <Num
              label="Возраст пула до, ч"
              value={draft.maxPoolAgeHours}
              onChange={(v) => set('maxPoolAgeHours', v)}
            />
          </div>
        </div>

        <div>
          <h3 className="text-muted mb-2 text-xs">Сети (пусто — все)</h3>
          <div className="flex flex-wrap gap-2">
            {Object.keys(CHAINS).map((c) => {
              const on = draft.chains.includes(c);
              return (
                <button
                  key={c}
                  onClick={() =>
                    set('chains', on ? draft.chains.filter((x) => x !== c) : [...draft.chains, c])
                  }
                  className={`rounded-md border px-3 py-1.5 text-xs ${
                    on ? 'border-accent bg-accent/15 text-white' : 'border-border text-muted'
                  }`}
                >
                  {chainLabel(c)}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Ограничители */}
      <div className="panel space-y-3 p-4">
        <h2 className="font-medium">Ограничители</h2>
        <p className="text-muted text-xs leading-relaxed">
          Без них в активный час выходит два десятка коллов подряд, и лента
          перестаёт что-либо значить: читать её никто не будет.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Num
            label="Коллов в сутки не более"
            value={draft.maxCallsPerDay}
            onChange={(v) => set('maxCallsPerDay', v)}
          />
          <Num
            label="Пауза между публикациями, мин"
            value={draft.cooldownMinutes}
            onChange={(v) => set('cooldownMinutes', v)}
            step={15}
          />
        </div>
      </div>

      {/* Параметры колла */}
      <div className="panel space-y-3 p-4">
        <h2 className="font-medium">Каким создавать колл</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Цели, % роста через запятую</label>
            <input
              className="input text-sm"
              value={draft.targetPcts.join(', ')}
              onChange={(e) =>
                set(
                  'targetPcts',
                  e.target.value
                    .split(',')
                    .map((x) => Number(x.trim()))
                    .filter((x) => Number.isFinite(x) && x > 0),
                )
              }
            />
          </div>
          <Num
            label="Стоп-лосс, % ниже входа"
            value={draft.stopLossPct}
            onChange={(v) => set('stopLossPct', v)}
          />
          <Num
            label="Рекомендуемая доля портфеля, %"
            value={draft.suggestedPct}
            onChange={(v) => set('suggestedPct', v)}
            step={0.5}
          />
          <div>
            <label className="label">Горизонт</label>
            <input
              className="input text-sm"
              value={draft.timeHorizon}
              onChange={(e) => set('timeHorizon', e.target.value)}
            />
          </div>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={draft.isCopyEnabled}
            onChange={(e) => set('isCopyEnabled', e.target.checked)}
          />
          Включать копитрейдинг у создаваемых коллов
        </label>

        <p className="text-muted text-xs leading-relaxed">
          У всех автоколлов проставляется высокий риск и в обосновании прямо
          сказано, что колл создан без ручного разбора. Выдавать автоматику
          за аналитику нельзя.
        </p>

        <button onClick={() => save()} disabled={busy} className="btn-ghost text-xs">
          {busy ? 'Сохраняем…' : 'Сохранить настройки'}
        </button>
      </div>

      <IngestKeys />

      {/* Журнал */}
      <div className="panel space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Журнал решений</h2>
          <div className="flex gap-1 text-xs">
            {[
              ['all', 'все'],
              ['FIRED', 'опубликованные'],
              ['DRY_RUN', 'наблюдение'],
              ['SKIPPED', 'отказы'],
            ].map(([k, l]) => (
              <button
                key={k}
                onClick={() => setLogFilter(k!)}
                className={`rounded border px-2 py-1 ${
                  logFilter === k ? 'border-accent bg-accent/15 text-white' : 'border-border text-muted'
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <p className="text-muted text-xs">
          Записываются и отказы: без них не понять, почему правило молчит.
        </p>

        {log?.entries.length === 0 && (
          <p className="text-muted py-6 text-center text-sm">
            Решений пока не было. Правило разбирает находки, где уже есть покупки
            размеченных кошельков.
          </p>
        )}

        <div className="space-y-1.5">
          {log?.entries.map((e) => {
            const meta = OUTCOMES[e.outcome] ?? OUTCOMES.SKIPPED!;
            return (
              <div key={e.id} className="bg-bg rounded p-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{e.symbol}</span>
                  <span className="text-muted">{chainLabel(e.chain)}</span>
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] ${meta.cls}`}>
                    {meta.text}
                  </span>
                  <span className="text-muted num ml-auto">
                    {new Date(e.createdAt).toLocaleString('ru', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <p className="text-muted mt-1 leading-relaxed">{e.reason}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Ключи для внешних источников.
 *
 * Ключ показывается ровно один раз — в базе лежит только его хеш.
 * Это не формальность: ключ даёт право добавлять токены в наблюдение,
 * а значит влиять на то, что разбирает автоправило.
 */
function IngestKeys() {
  const { data, mutate } = useSWR<{ tokens: any[] }>('/admin/ingest-tokens', fetcher);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const r: any = await api('/admin/ingest-tokens', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() || 'Источник' }),
      });
      setFresh(r.token);
      setName('');
      mutate();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm('Отозвать ключ? Скрипты, использующие его, перестанут работать.')) return;
    await api(`/admin/ingest-tokens/${id}`, { method: 'DELETE' });
    mutate();
  }

  return (
    <div className="panel space-y-3 p-4">
      <h2 className="font-medium">Ключи приёма находок</h2>
      <p className="text-muted text-xs leading-relaxed">
        Позволяют внешнему скрипту добавлять токены в наблюдение — дальше они идут
        обычным путём и проверяются правилом выше. Ключ умеет только это: входить
        в аккаунт и распоряжаться средствами им нельзя.
        Шаблон скрипта — <span className="num">scripts/feed.mjs</span>.
      </p>

      <div className="flex flex-wrap gap-2">
        <input
          className="input w-auto flex-1 text-sm"
          placeholder="Название источника"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button onClick={create} disabled={busy} className="btn-ghost text-xs">
          {busy ? 'Создаём…' : 'Создать ключ'}
        </button>
      </div>

      {fresh && (
        <div className="border-up/40 bg-up/10 space-y-2 rounded border p-3">
          <p className="text-up text-xs font-medium">
            Ключ показывается один раз — восстановить его нельзя.
          </p>
          <code className="bg-bg block break-all rounded p-2 text-xs">{fresh}</code>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(fresh);
              setFresh(null);
            }}
            className="btn-ghost text-xs"
          >
            Скопировать и скрыть
          </button>
        </div>
      )}

      {data?.tokens.filter((t) => t.isActive).length === 0 && (
        <p className="text-muted text-xs">Ключей пока нет.</p>
      )}

      <div className="space-y-1.5">
        {data?.tokens
          .filter((t) => t.isActive)
          .map((t) => (
            <div key={t.id} className="bg-bg flex flex-wrap items-center gap-2 rounded p-2.5 text-xs">
              <span className="font-medium">{t.name}</span>
              <span className="text-muted num">{t.prefix}…</span>
              <span className="text-muted">
                запросов: {t.usedCount}
                {t.lastUsedAt &&
                  ` · последний ${new Date(t.lastUsedAt).toLocaleString('ru', {
                    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                  })}`}
              </span>
              <button onClick={() => revoke(t.id)} className="text-down ml-auto">
                отозвать
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}

function Num({
  label,
  value,
  onChange,
  step = 1,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  hint?: string;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        type="number"
        step={step}
        className="input num text-sm"
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
      {hint && <p className="text-muted mt-1 text-[11px]">{hint}</p>}
    </div>
  );
}
