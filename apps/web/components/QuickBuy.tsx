'use client';

import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { fetcher, api, errorMessage, fmtPrice } from '@/lib/api';
import { ExitPlanChoice } from '@/components/ExitPlanPicker';

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

export function QuickBuy() {
  const { data: tokens } = useSWR<Token[]>('/tokens', fetcher);
  // Список планов берётся с сервера, а не дублируется здесь: иначе
  // интерфейс однажды покажет один набор, а бэкенд применит другой.
  const { data: planMeta } = useSWR<{ presets: Array<{ key: string; label: string; description: string }> }>(
    '/exit-presets',
    fetcher,
  );
  const presets = planMeta?.presets ?? [];

  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [quoteId, setQuoteId] = useState('');
  const [preset, setPreset] = useState('x3');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const quotes = (tokens ?? []).filter((t) => t.isQuote);
  const activeQuote = quoteId || quotes[0]?.id || '';

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
          exitPreset: preset,
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

      {/* План выхода — один активный. Перекрывающиеся цели и стоп
          потребовали бы заморозить одни и те же токены дважды. */}
      <ExitPlanChoice presets={presets} value={preset} onChange={setPreset} />

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
