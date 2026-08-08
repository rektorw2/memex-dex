'use client';

import { useState, useMemo } from 'react';
import { api, newIdempotencyKey, fmtPrice, errorMessage } from '@/lib/api';

type OrderType = 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'TAKE_PROFIT';

interface Props {
  tokenId: string;
  tokenSymbol: string;
  quoteTokenId: string;
  quoteSymbol: string;
  chain: string;
  currentPriceUsd: number;
  availableQuote: number;
  availableToken: number;
}

export function TradePanel(props: Props) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [type, setType] = useState<OrderType>('MARKET');
  const [amount, setAmount] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [slippage, setSlippage] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<any>(null);

  const available = side === 'BUY' ? props.availableQuote : props.availableToken;
  const effectivePrice = type === 'MARKET' ? props.currentPriceUsd : Number(limitPrice || 0);

  const estimate = useMemo(() => {
    const a = Number(amount || 0);
    if (!a || !effectivePrice) return null;
    return side === 'BUY' ? a / effectivePrice : a * effectivePrice;
  }, [amount, effectivePrice, side]);

  async function preview() {
    setError(null);
    try {
      const q = await api('/orders/quote', {
        method: 'POST',
        body: JSON.stringify({
          chain: props.chain,
          tokenInId: side === 'BUY' ? props.quoteTokenId : props.tokenId,
          tokenOutId: side === 'BUY' ? props.tokenId : props.quoteTokenId,
          amountIn: amount,
          slippageBps: slippage,
        }),
      });
      setQuote(q);
    } catch (e) {
      setError(errorMessage(e, 'Не удалось получить котировку'));
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api('/orders', {
        method: 'POST',
        // Ключ идемпотентности защищает от двойной отправки при
        // повторном клике или ретрае сети.
        idempotencyKey: newIdempotencyKey(),
        body: JSON.stringify({
          chain: props.chain,
          tokenInId: side === 'BUY' ? props.quoteTokenId : props.tokenId,
          tokenOutId: side === 'BUY' ? props.tokenId : props.quoteTokenId,
          side,
          type,
          amountIn: amount,
          ...(type !== 'MARKET' ? { limitPrice } : {}),
          slippageBps: slippage,
        }),
      });
      setAmount('');
      setQuote(null);
    } catch (e) {
      setError(errorMessage(e, 'Не удалось создать ордер'));
    } finally {
      setBusy(false);
    }
  }

  const insufficient = Number(amount || 0) > available;

  return (
    <div className="panel p-4 space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setSide('BUY')}
          className={`btn ${side === 'BUY' ? 'bg-up text-white' : 'bg-border text-muted'}`}
        >
          Купить
        </button>
        <button
          onClick={() => setSide('SELL')}
          className={`btn ${side === 'SELL' ? 'bg-down text-white' : 'bg-border text-muted'}`}
        >
          Продать
        </button>
      </div>

      <div className="flex gap-1 text-xs">
        {(['MARKET', 'LIMIT', 'STOP_LOSS', 'TAKE_PROFIT'] as OrderType[]).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={`px-2 py-1 rounded ${type === t ? 'bg-accent/20 text-accent' : 'text-muted hover:text-white'}`}
          >
            {{ MARKET: 'Рынок', LIMIT: 'Лимит', STOP_LOSS: 'Стоп', TAKE_PROFIT: 'Тейк' }[t]}
          </button>
        ))}
      </div>

      {type !== 'MARKET' && (
        <div>
          <label className="label">
            {type === 'LIMIT' ? 'Цена лимита' : 'Цена срабатывания'}, USD
          </label>
          <input
            className="input"
            value={limitPrice}
            onChange={(e) => setLimitPrice(e.target.value)}
            placeholder={String(props.currentPriceUsd)}
          />
        </div>
      )}

      <div>
        <div className="flex justify-between items-baseline">
          <label className="label">
            Сумма, {side === 'BUY' ? props.quoteSymbol : props.tokenSymbol}
          </label>
          <span className="text-xs text-muted num">
            Доступно: {available.toFixed(4)}
          </span>
        </div>
        <input
          className={`input ${insufficient ? 'border-down' : ''}`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
        />
        <div className="flex gap-1 mt-2">
          {[25, 50, 75, 100].map((pct) => (
            <button
              key={pct}
              onClick={() => setAmount(String((available * pct) / 100))}
              className="flex-1 text-xs py-1 rounded bg-border hover:bg-border/70 text-muted"
            >
              {pct}%
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Проскальзывание: {(slippage / 100).toFixed(1)}%</label>
        <input
          type="range" min={10} max={500} step={10}
          value={slippage}
          onChange={(e) => setSlippage(Number(e.target.value))}
          className="w-full accent-accent"
        />
        {slippage > 300 && (
          <p className="text-xs text-down mt-1">
            Высокое проскальзывание — вас могут исполнить заметно хуже рынка
          </p>
        )}
      </div>

      {estimate != null && (
        <div className="text-sm bg-bg rounded-md p-3 space-y-1">
          <div className="flex justify-between">
            <span className="text-muted">Вы получите ≈</span>
            <span className="num">
              {estimate.toFixed(side === 'BUY' ? 2 : 4)}{' '}
              {side === 'BUY' ? props.tokenSymbol : props.quoteSymbol}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Цена</span>
            <span className="num">{fmtPrice(effectivePrice)}</span>
          </div>
        </div>
      )}

      {quote?.warning && (
        <p className="text-xs text-down bg-down/10 border border-down/30 rounded p-2">
          {quote.warning}
        </p>
      )}
      {error && (
        <p className="text-xs text-down bg-down/10 border border-down/30 rounded p-2">{error}</p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button onClick={preview} disabled={!amount || busy} className="btn-ghost">
          Котировка
        </button>
        <button
          onClick={submit}
          disabled={!amount || busy || insufficient}
          className={side === 'BUY' ? 'btn-buy' : 'btn-sell'}
        >
          {busy ? '...' : side === 'BUY' ? 'Купить' : 'Продать'}
        </button>
      </div>

      {insufficient && (
        <p className="text-xs text-down">Недостаточно средств на балансе</p>
      )}
    </div>
  );
}
