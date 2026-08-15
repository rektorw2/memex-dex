'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { fetcher, api, errorMessage, fmtUsd, fmtPrice } from '@/lib/api';
import { TokenLogo } from '@/components/TokenLogo';
import { chainLabel } from '@/lib/chains';

/**
 * Активы кошелька: общая стоимость, приём и отправка.
 *
 * Итог показывается вместе с тем, из чего он сложился: заблокированное
 * под ордерами и количество активов без цены. Одно число «всего $X»
 * без этих двух уточнений расходится с ожиданием человека, и расхождение
 * читается как ошибка в расчётах, хотя расчёт верен.
 */

interface Asset {
  tokenId: string;
  symbol: string;
  name: string;
  chain: string;
  address: string;
  logoUrl: string | null;
  isQuote: boolean;
  available: string;
  locked: string;
  priceUsd: string | null;
  valueUsd: string | null;
}

interface AssetsResponse {
  totalUsd: string;
  lockedUsd: string;
  availableUsd: string;
  unpricedAssets: number;
  withdrawalFeeBps: number;
  assets: Asset[];
  depositAddresses: Array<{ id: string; chain: string; address: string }>;
  pendingWithdrawals: Array<{
    id: string;
    chain: string;
    amount: string;
    feeAmount: string;
    toAddress: string;
    status: string;
    createdAt: string;
  }>;
}

function qty(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (n === 0) return '0';
  if (n < 0.0001) return n.toExponential(3);
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 6 });
}

export function WalletAssets() {
  const { data, error, mutate } = useSWR<AssetsResponse>('/wallets/assets', fetcher, {
    refreshInterval: 30_000,
  });

  const [receiveOpen, setReceiveOpen] = useState(false);
  const [sendAsset, setSendAsset] = useState<Asset | null>(null);

  if (error) {
    return (
      <p className="text-down border-down/30 bg-down/10 rounded border p-3 text-sm">
        {errorMessage(error, 'Не удалось загрузить активы')}
      </p>
    );
  }

  if (!data) return <p className="text-muted py-8 text-center text-sm">Загрузка активов…</p>;

  const feePct = (data.withdrawalFeeBps / 100).toFixed(data.withdrawalFeeBps % 100 ? 2 : 0);

  return (
    <div className="space-y-4">
      {/* Итог */}
      <div className="panel p-4">
        <p className="text-muted text-xs">Стоимость активов</p>
        <p className="num mt-1 text-2xl font-semibold">{fmtUsd(data.totalUsd)}</p>

        <div className="text-muted mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <span>
            свободно: <span className="num text-white">{fmtUsd(data.availableUsd)}</span>
          </span>
          {Number(data.lockedUsd) > 0 && (
            <span title="Средства под открытыми ордерами. Вывести их нельзя, пока ордер не снят">
              в ордерах: <span className="num text-white">{fmtUsd(data.lockedUsd)}</span>
            </span>
          )}
          {data.unpricedAssets > 0 && (
            <span title="Для этих токенов нет котировки, поэтому в итог они не вошли">
              без цены: <span className="num text-white">{data.unpricedAssets}</span>
            </span>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={() => setReceiveOpen((v) => !v)} className="btn-ghost text-sm">
            Принять
          </button>
          <button
            onClick={() => setSendAsset(data.assets.find((a) => Number(a.available) > 0) ?? null)}
            disabled={data.assets.every((a) => Number(a.available) <= 0)}
            className="btn-ghost text-sm"
          >
            Отправить
          </button>
        </div>
      </div>

      {receiveOpen && <ReceivePanel addresses={data.depositAddresses} />}

      {sendAsset && (
        <SendPanel
          assets={data.assets.filter((a) => Number(a.available) > 0)}
          initial={sendAsset}
          feeBps={data.withdrawalFeeBps}
          onClose={() => setSendAsset(null)}
          onDone={() => {
            setSendAsset(null);
            mutate();
          }}
        />
      )}

      {/* Заявки в работе */}
      {data.pendingWithdrawals.length > 0 && (
        <div className="panel space-y-2 p-4">
          <h2 className="text-sm font-medium">Заявки на вывод</h2>
          {data.pendingWithdrawals.map((w) => (
            <div key={w.id} className="bg-bg flex flex-wrap items-center gap-2 rounded p-2.5 text-xs">
              <span className="num">{qty(w.amount)}</span>
              <span className="text-muted">удержано {qty(w.feeAmount)}</span>
              <span className="text-muted truncate">→ {w.toAddress.slice(0, 12)}…</span>
              <span className="text-accent ml-auto">{w.status}</span>
              <button
                onClick={async () => {
                  if (!confirm('Отменить заявку? Средства вернутся на баланс.')) return;
                  await api(`/wallets/withdraw/${w.id}`, { method: 'DELETE' }).catch(() => {});
                  mutate();
                }}
                className="text-muted hover:text-down"
              >
                отменить
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Список активов */}
      <div className="panel">
        <div className="border-border flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-medium">Активы</h2>
          <span className="text-muted text-xs">комиссия за вывод {feePct}%</span>
        </div>

        {data.assets.length === 0 ? (
          <p className="text-muted p-6 text-center text-sm">
            Активов нет. Пополните кошелёк через «Принять».
          </p>
        ) : (
          <div className="divide-border divide-y">
            {data.assets.map((a) => (
              <div key={a.tokenId} className="flex items-center gap-3 px-4 py-3">
                <TokenLogo symbol={a.symbol} address={a.address} logoUrl={a.logoUrl} size={32} />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{a.symbol}</span>
                    <span className="text-muted shrink-0 text-[11px]">{chainLabel(a.chain)}</span>
                  </div>
                  <p className="text-muted truncate text-xs">
                    {qty(a.available)}
                    {Number(a.locked) > 0 && (
                      <span title="Заблокировано под ордерами"> · {qty(a.locked)} в ордерах</span>
                    )}
                  </p>
                </div>

                <div className="shrink-0 text-right">
                  <p className="num text-sm">{a.valueUsd ? fmtUsd(a.valueUsd) : '—'}</p>
                  <p className="text-muted num text-xs">
                    {a.priceUsd ? fmtPrice(a.priceUsd) : 'нет цены'}
                  </p>
                </div>

                <button
                  onClick={() => setSendAsset(a)}
                  disabled={Number(a.available) <= 0}
                  className="text-muted hover:text-white shrink-0 text-xs disabled:opacity-40"
                >
                  вывести
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Адреса для пополнения. */
function ReceivePanel({ addresses }: { addresses: Array<{ id: string; chain: string; address: string }> }) {
  const [copied, setCopied] = useState<string | null>(null);

  return (
    <div className="panel space-y-3 p-4">
      <h2 className="text-sm font-medium">Пополнение</h2>

      {addresses.length === 0 ? (
        <p className="text-muted text-xs leading-relaxed">
          Адресов для пополнения ещё нет. Создайте кошелёк в разделе ниже — адрес
          появится сразу после создания.
        </p>
      ) : (
        <>
          <p className="text-muted text-xs leading-relaxed">
            Отправляйте только токены той сети, что указана рядом с адресом.
            Перевод из другой сети на этот же адрес приводит к потере средств —
            вернуть их невозможно.
          </p>

          <div className="space-y-2">
            {addresses.map((d) => (
              <div key={d.id} className="bg-bg rounded p-3">
                <p className="text-muted mb-1 text-xs">{chainLabel(d.chain)}</p>
                <p className="num break-all text-xs">{d.address}</p>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(d.address);
                    setCopied(d.id);
                    setTimeout(() => setCopied(null), 2000);
                  }}
                  className="text-accent mt-2 text-xs"
                >
                  {copied === d.id ? 'скопировано' : 'копировать адрес'}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Форма вывода с расчётом удержания до подтверждения. */
function SendPanel({
  assets,
  initial,
  feeBps,
  onClose,
  onDone,
}: {
  assets: Asset[];
  initial: Asset;
  feeBps: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [tokenId, setTokenId] = useState(initial.tokenId);
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const asset = assets.find((a) => a.tokenId === tokenId) ?? initial;

  // Расчёт на клиенте — только для показа. Итог считает сервер при
  // отправке: ставка комиссии живёт в его настройках, и дублировать
  // её здесь значит однажды показать одно, а списать другое.
  const gross = Number(amount) || 0;
  const fee = gross * (feeBps / 10_000);
  const net = gross - fee;
  const price = Number(asset.priceUsd ?? 0);

  const tooMuch = gross > Number(asset.available);
  const canSend = gross > 0 && !tooMuch && address.trim().length >= 20 && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r: any = await api('/wallets/withdraw', {
        method: 'POST',
        body: JSON.stringify({ tokenId, amount, toAddress: address.trim(), mode: 'GROSS' }),
      });
      setDone(r.notice);
      setAmount('');
      setAddress('');
      onDone();
    } catch (e) {
      setError(errorMessage(e, 'Заявка не создана'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Отправка</h2>
        <button onClick={onClose} className="text-muted text-xs hover:text-white">
          закрыть
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Актив</label>
          <select
            className="input text-sm"
            value={tokenId}
            onChange={(e) => setTokenId(e.target.value)}
          >
            {assets.map((a) => (
              <option key={a.tokenId} value={a.tokenId}>
                {a.symbol} · {qty(a.available)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label">Сумма</label>
          <div className="flex gap-2">
            <input
              className="input num text-sm"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button
              onClick={() => setAmount(asset.available)}
              className="btn-ghost shrink-0 text-xs"
            >
              всё
            </button>
          </div>
          {tooMuch && (
            <p className="text-down mt-1 text-[11px]">
              Доступно только {qty(asset.available)}
            </p>
          )}
        </div>
      </div>

      <div>
        <label className="label">Адрес получателя ({chainLabel(asset.chain)})</label>
        <input
          className="input font-mono text-sm"
          placeholder="Адрес в сети"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      </div>

      {/* Удержание показывается до подтверждения, а не после. */}
      {gross > 0 && (
        <div className="bg-bg space-y-1 rounded p-3 text-xs">
          <div className="flex justify-between">
            <span className="text-muted">Списывается</span>
            <span className="num">
              {qty(String(gross))} {asset.symbol}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Комиссия сервиса {(feeBps / 100).toFixed(0)}%</span>
            <span className="num text-down">
              −{qty(String(fee))} {asset.symbol}
              {price > 0 && <span className="text-muted"> ({fmtUsd(fee * price)})</span>}
            </span>
          </div>
          <div className="border-border flex justify-between border-t pt-1 font-medium">
            <span>Придёт на адрес</span>
            <span className="num text-up">
              {qty(String(net))} {asset.symbol}
              {price > 0 && <span className="text-muted"> ({fmtUsd(net * price)})</span>}
            </span>
          </div>
        </div>
      )}

      <button onClick={submit} disabled={!canSend} className="btn-ghost text-sm">
        {busy ? 'Отправляем…' : 'Создать заявку'}
      </button>

      <p className="text-muted text-[11px] leading-relaxed">
        Проверьте адрес и сеть. Перевод на адрес другой сети или на неверный адрес
        необратим — вернуть средства невозможно.
      </p>

      {error && (
        <p className="text-down border-down/30 bg-down/10 rounded border p-2 text-xs">{error}</p>
      )}

      {done && (
        <p className="text-up border-up/30 bg-up/10 rounded border p-2 text-xs leading-relaxed">
          {done}
        </p>
      )}
    </div>
  );
}
