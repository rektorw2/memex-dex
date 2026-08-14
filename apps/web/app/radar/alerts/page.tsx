'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher, api, errorMessage } from '@/lib/api';
import { chainLabel } from '@/lib/chains';

const CHAIN_OPTIONS = ['SOLANA', 'BNB', 'BASE', 'ETHEREUM'] as const;

export default function AlertsPage() {
  const { data, mutate } = useSWR<any>('/radar/subscription', fetcher);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);

  const tg = data?.subscriptions?.find((s: any) => s.channel === 'TELEGRAM');

  const [form, setForm] = useState({
    chains: [] as string[],
    minLiquidityUsd: 50_000,
    maxRiskScore: 50,
    maxPoolAgeHours: 24,
    maxAlertsPerHour: 20,
  });

  async function getCode() {
    setError(null);
    try {
      const r: any = await api('/radar/telegram/code', { method: 'POST' });
      setCode(r.code);
      mutate();
    } catch (e) {
      setError(errorMessage(e, 'Не удалось получить код'));
    }
  }

  async function save(isActive: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api('/radar/subscription', {
        method: 'PUT',
        body: JSON.stringify({ channel: 'TELEGRAM', isActive, ...form }),
      });
      mutate();
    } catch (e) {
      setError(errorMessage(e, 'Не удалось сохранить настройки'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <Link href="/radar" className="text-sm text-muted hover:text-white inline-block">
        ← К радару
      </Link>

      <h1 className="text-xl sm:text-2xl font-bold">Уведомления радара</h1>

      <div className="panel p-4 space-y-3">
        <h2 className="font-medium">Telegram</h2>

        {!data?.telegram?.enabled ? (
          <p className="text-sm text-muted">
            Бот не настроен на сервере: администратору нужно указать токен
            от @BotFather в переменной TELEGRAM_BOT_TOKEN.
          </p>
        ) : data?.telegram?.linked ? (
          <p className="text-sm text-up">Чат привязан — уведомления будут приходить сюда.</p>
        ) : (
          <>
            <p className="text-sm text-muted leading-relaxed">
              Получите код и отправьте его боту сообщением. Направление именно
              такое, потому что обратное требует постоянно доступного адреса,
              а сервис на бесплатном тарифе засыпает и теряет входящие.
            </p>
            {code ? (
              <div className="bg-bg rounded-md p-3">
                <p className="text-xs text-muted mb-1">Отправьте боту:</p>
                <code className="text-accent">/link {code}</code>
              </div>
            ) : (
              <button onClick={getCode} className="btn-ghost text-sm">Получить код</button>
            )}
          </>
        )}
      </div>

      <div className="panel p-4 space-y-4">
        <h2 className="font-medium">Что присылать</h2>

        <div>
          <label className="label">Сети — пусто означает все</label>
          <div className="flex flex-wrap gap-2">
            {CHAIN_OPTIONS.map((c) => (
              <button
                key={c}
                onClick={() =>
                  setForm({
                    ...form,
                    chains: form.chains.includes(c)
                      ? form.chains.filter((x) => x !== c)
                      : [...form.chains, c],
                  })
                }
                className={`text-xs px-2 py-1 rounded border ${
                  form.chains.includes(c)
                    ? 'border-accent text-accent bg-accent/10'
                    : 'border-border text-muted'
                }`}
              >
                {chainLabel(c)}
              </button>
            ))}
          </div>
        </div>

        <Range label="Минимальная ликвидность" value={form.minLiquidityUsd}
               min={20_000} max={500_000} step={10_000}
               format={(v) => `$${(v / 1000).toFixed(0)}K`}
               onChange={(v) => setForm({ ...form, minLiquidityUsd: v })} />

        <Range label="Максимальный риск-скор" value={form.maxRiskScore}
               min={10} max={100} step={5} format={(v) => String(v)}
               onChange={(v) => setForm({ ...form, maxRiskScore: v })} />

        <Range label="Возраст пула не больше" value={form.maxPoolAgeHours}
               min={1} max={72} step={1} format={(v) => `${v} ч`}
               onChange={(v) => setForm({ ...form, maxPoolAgeHours: v })} />

        <Range label="Не больше сообщений в час" value={form.maxAlertsPerHour}
               min={1} max={100} step={1} format={(v) => String(v)}
               onChange={(v) => setForm({ ...form, maxAlertsPerHour: v })} />

        <p className="text-xs text-muted leading-relaxed">
          Ограничение частоты нужно не для экономии: без него в час активности
          придёт несколько сотен сообщений, и уведомления перестанут читать
          вовсе — а вместе с ними пропустят и важное.
        </p>

        {error && <p className="text-xs text-down bg-down/10 border border-down/30 rounded p-2">{error}</p>}

        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => save(false)} disabled={busy || !data?.telegram?.linked}
                  className="btn-ghost text-sm">
            Отключить
          </button>
          <button onClick={() => save(true)} disabled={busy || !data?.telegram?.linked}
                  className="btn bg-accent hover:bg-accent/80 text-white text-sm">
            {busy ? '…' : tg?.isActive ? 'Обновить' : 'Включить'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Range({
  label, value, min, max, step, format, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  format: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="label">{label}: <span className="num text-white">{format(value)}</span></label>
      <input type="range" min={min} max={max} step={step} value={value}
             onChange={(e) => onChange(Number(e.target.value))}
             className="w-full accent-accent" />
    </div>
  );
}
