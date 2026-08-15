'use client';

import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { fetcher, api, errorMessage, fmtPrice } from '@/lib/api';

/**
 * Покупка по адресу с автоматическим выходом.
 *
 * Форма сознательно короткая: адрес, сумма, цель. Всё остальное имеет
 * разумные умолчания, потому что этим экраном пользуются в момент, когда
 * решение уже принято и важна скорость.
 *
 * Цели показываются пересчитанными в цену до нажатия кнопки. Без этого
 * «3×» остаётся абстракцией, и ошибка в поле обнаруживается только
 * после сделки.
 */

interface Token {
  id: string;
  symbol: string;
  chain: string;
  isQuote?: boolean;
}

type Result = {
  token: { symbol: string; chain: string; address: string };
  buy: { orderId: string; status: string; quantity: string; entryPriceUsd: string };
  exits: Array<{ orderId: string; multiple: number; triggerPriceUsd: string; quantity: string }>;
  stopLossOrderId: string | null;
  warnings: string[];
};

/** Готовые наборы целей. Первый — то, что просили: всё на 3×. */
const PRESETS: Array<{ key: string; label: string; hint: string; steps: Array<{ multiple: number; fraction: number }> }> = [
  {
    key: 'x3',
    label: 'Всё на 3×',
    hint: 'Одна цель. Рост меньше трёхкратного не фиксируется вообще',
    steps: [{ multiple: 3, fraction: 1 }],
  },
  {
    key: 'ladder',
    label: 'Лестница 2× / 3× / 5×',
    hint: 'Половина на 2×, треть на 3×, остаток на 5×. Забирает и умеренный рост',
    steps: [
      { multiple: 2, fraction: 0.5 },
      { multiple: 3, fraction: 0.3 },
      { multiple: 5, fraction: 0.2 },
    ],
  },
];

export function QuickBuy() {
  const { data: tokens } = useSWR<Token[]>('/tokens', fetcher);

  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [quoteId, setQuoteId] = useState('');
  const [preset, setPreset] = useState('x3');
  const [stopLoss, setStopLoss] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const quotes = (tokens ?? []).filter((t) => t.isQuote);
  const activeQuote = quoteId || quotes[0]?.id || '';
  const steps = PRESETS.find((p) => p.key === preset)!.steps;

  const canSubmit = address.trim().length >= 10 && Number(amount) > 0 && activeQuote && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api<Result>('/admin/quick-buy', {
        method: 'POST',
        body: JSON.stringify({
          addressOrLink: address.trim(),
          amountIn: amount,
          quoteTokenId: activeQuote,
          steps,
          stopLossPct: stopLoss ? Number(stopLoss) : null,
        }),
      });
      setResult(r);
      setAddress('');
      setAmount('');
    } catch (e) {
      setError(errorMessage(e, 'Покупка не выполнена'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel space-y-4 p-4">
      <div>
        <h2 className="font-medium">Купить по адресу</h2>
        <p className="text-muted mt-1 text-xs leading-relaxed">
          Токен находится по адресу, покупается на указанную сумму, и сразу
          выставляется автопродажа на купленное количество. Цели считаются
          от фактической цены входа, а не от котировки на момент нажатия —
          из-за проскальзывания они расходятся.
        </p>
      </div>

      <div>
        <label className="label">Адрес токена или ссылка</label>
        <input
          className="input font-mono text-sm"
          placeholder="EPjFWdd5… или https://dexscreener.com/base/0x…"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <p className="text-muted mt-1 text-[11px]">
          Сеть определяется сама: для Solana по виду адреса, для EVM перебором
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Сумма</label>
          <input
            className="input num text-sm"
            inputMode="decimal"
            placeholder="100"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Платим</label>
          <select
            className="input text-sm"
            value={activeQuote}
            onChange={(e) => setQuoteId(e.target.value)}
          >
            {quotes.length === 0 && <option value="">Нет котировочных токенов</option>}
            {quotes.map((q) => (
              <option key={q.id} value={q.id}>
                {q.symbol} · {q.chain}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="label">Автопродажа</label>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              title={p.hint}
              onClick={() => setPreset(p.key)}
              className={`rounded-md border px-3 py-1.5 text-xs transition ${
                preset === p.key
                  ? 'border-accent bg-accent/15 text-white'
                  : 'border-border text-muted hover:text-white'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="text-muted mt-1.5 text-[11px] leading-relaxed">
          {PRESETS.find((p) => p.key === preset)!.hint}
        </p>
      </div>

      <div>
        <label className="label">Стоп-лосс, % ниже входа (необязательно)</label>
        <input
          className="input num max-w-[160px] text-sm"
          inputMode="numeric"
          placeholder="без стопа"
          value={stopLoss}
          onChange={(e) => setStopLoss(e.target.value.replace(/\D/g, ''))}
        />
      </div>

      <button onClick={submit} disabled={!canSubmit} className="btn-ghost text-sm">
        {busy ? 'Покупаем…' : 'Купить и поставить выход'}
      </button>

      {error && (
        <p className="text-down border-down/30 bg-down/10 rounded border p-2 text-xs">{error}</p>
      )}

      {result && (
        <div className="bg-bg space-y-2 rounded p-3 text-xs">
          <p className="font-medium">
            {result.token.symbol} · куплено{' '}
            <span className="num">{Number(result.buy.quantity).toLocaleString('ru-RU')}</span> по{' '}
            <span className="num">{fmtPrice(result.buy.entryPriceUsd)}</span>
          </p>

          {result.exits.length > 0 ? (
            <div className="space-y-1">
              {result.exits.map((e) => (
                <p key={e.orderId} className="text-muted">
                  цель {e.multiple}× — продажа по{' '}
                  <span className="num text-up">{fmtPrice(e.triggerPriceUsd)}</span>
                </p>
              ))}
            </div>
          ) : (
            <p className="text-down">Цели не поставлены</p>
          )}

          {result.stopLossOrderId && <p className="text-muted">стоп-лосс поставлен</p>}

          {result.warnings.length > 0 && (
            <div className="border-border space-y-1 border-t pt-2">
              {result.warnings.map((w, i) => (
                <p key={i} className="text-muted leading-relaxed">
                  {w}
                </p>
              ))}
            </div>
          )}

          <Link href="/portfolio" className="text-accent inline-block">
            Открыть портфель →
          </Link>
        </div>
      )}
    </div>
  );
}
