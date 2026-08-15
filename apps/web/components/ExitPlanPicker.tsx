'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { fetcher, api, errorMessage, fmtPrice } from '@/lib/api';

/**
 * Выбор плана выхода.
 *
 * Работает в двух режимах и в обоих показывает одно и то же:
 * до входа — что будет поставлено, после входа — что стоит сейчас
 * и что изменится.
 *
 * План всегда один. Это не упрощение интерфейса, а следствие того,
 * как устроено резервирование: отложенный ордер замораживает токены,
 * а одни и те же токены нельзя заморозить дважды. Лестница целей
 * вместе со стопом на всю позицию потребовала бы больше, чем есть,
 * и стоп молча перестал бы покрывать остаток.
 */

interface Preset {
  key: string;
  label: string;
  description: string;
}

interface PlanState {
  tokenId: string;
  symbol: string;
  quantity: string;
  avgCostUsd: string;
  activePreset: string | null;
  orders: Array<{
    id: string;
    type: string;
    triggerPriceUsd: string | null;
    quantity: string;
    multiple: number | null;
  }>;
}

/* ─────────────── Режим до входа: просто выбор ─────────────── */

export function ExitPlanChoice({
  presets,
  value,
  onChange,
}: {
  presets: Preset[];
  value: string;
  onChange: (key: string) => void;
}) {
  const active = presets.find((p) => p.key === value);

  // Пока список не пришёл, выбор не показываем: пустой ряд кнопок
  // выглядит как «планов нет», хотя они просто ещё грузятся.
  if (presets.length === 0) {
    return (
      <div>
        <label className="label">План выхода</label>
        <p className="text-muted text-xs">Загрузка планов…</p>
      </div>
    );
  }

  return (
    <div>
      <label className="label">План выхода</label>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onChange(p.key)}
            className={`tap rounded-md border px-3 py-1.5 text-xs transition-colors ${
              value === p.key
                ? 'border-accent bg-accent/15 text-accent'
                : 'border-border text-muted hover:text-white'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {active && (
        <p className="text-muted mt-1.5 text-[11px] leading-relaxed">{active.description}</p>
      )}
    </div>
  );
}

/* ─────────────── Режим после входа: смена плана ─────────────── */

export function ExitPlanManager({ tokenId, onChanged }: { tokenId: string; onChanged?: () => void }) {
  const { data, error, mutate } = useSWR<{ presets: Preset[]; plan: PlanState }>(
    `/positions/${tokenId}/exit-plan`,
    fetcher,
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  if (error) {
    return (
      <p className="text-muted text-xs">
        {errorMessage(error, 'План выхода недоступен')}
      </p>
    );
  }

  if (!data) return <p className="text-muted text-xs">Загрузка плана…</p>;

  const { presets, plan } = data;

  async function apply(key: string) {
    setBusy(key);
    setFailed(null);
    setNotice(null);
    try {
      const r: any = await api(`/positions/${tokenId}/exit-plan`, {
        method: 'PUT',
        body: JSON.stringify({ preset: key }),
      });
      setNotice(
        r.created > 0
          ? `Снято ордеров: ${r.cancelled}, поставлено: ${r.created}`
          : `План снят. Ордеров снято: ${r.cancelled}`,
      );
      mutate();
      onChanged?.();
    } catch (e) {
      setFailed(errorMessage(e, 'План не изменён'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">План выхода</span>
        <span className="text-muted num text-[11px]">
          вход {fmtPrice(plan.avgCostUsd)}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => {
          const isActive = plan.activePreset === p.key;
          return (
            <button
              key={p.key}
              onClick={() => !isActive && apply(p.key)}
              disabled={busy !== null || isActive}
              title={p.description}
              className={`tap rounded-md border px-3 py-1.5 text-xs transition-colors disabled:opacity-100 ${
                isActive
                  ? 'border-accent bg-accent/15 text-accent'
                  : 'border-border text-muted hover:text-white disabled:opacity-40'
              }`}
            >
              {busy === p.key ? '…' : p.label}
            </button>
          );
        })}
      </div>

      {/* Что стоит сейчас — от цены входа, а не от текущей.
          «Взять 3×» означает трёхкратный рост от входа. */}
      {plan.orders.length > 0 ? (
        <div className="bg-bg space-y-1 rounded p-2.5 text-[11px]">
          {plan.orders.map((o) => (
            <div key={o.id} className="flex justify-between gap-2">
              <span className="text-muted">
                {o.type === 'STOP_LOSS'
                  ? 'стоп'
                  : `цель ${o.multiple ? `${o.multiple.toFixed(1)}×` : ''}`}
              </span>
              <span
                className={`num ${o.type === 'STOP_LOSS' ? 'text-down' : 'text-up'}`}
              >
                {fmtPrice(o.triggerPriceUsd)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-muted text-[11px] leading-relaxed">
          Ордеров выхода нет — позиция закрывается только вручную.
        </p>
      )}

      {plan.activePreset === null && plan.orders.length > 0 && (
        <p className="text-warn text-[11px] leading-relaxed">
          Стоящие ордера не совпадают ни с одним готовым планом — вероятно,
          часть уже сработала. Выберите план заново, чтобы привести их в порядок.
        </p>
      )}

      {notice && <p className="text-up text-[11px]">{notice}</p>}
      {failed && <p className="text-down text-[11px]">{failed}</p>}
    </div>
  );
}
