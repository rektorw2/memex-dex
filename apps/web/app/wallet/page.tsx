'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { fetcher, api, errorMessage } from '@/lib/api';
import { WalletAssets } from '@/components/WalletAssets';
import { CHAINS, chainLabel } from '@/lib/chains';

const CHAIN_OPTIONS = ['SOLANA', 'BNB', 'BASE', 'ETHEREUM', 'ROBINHOOD'] as const;

export default function WalletPage() {
  const { data, mutate, error } = useSWR<any>('/wallets', fetcher);
  const [tab, setTab] = useState<'create' | 'import'>('create');

  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-xl sm:text-2xl font-bold">Кошелёк</h1>

      {/* Активы идут первыми: это то, ради чего сюда заходят.
          Управление адресами — служебное действие, оно ниже. */}
      <WalletAssets />

      <div className="panel p-4">
        <h2 className="font-medium mb-3">Ваши адреса</h2>
        {error ? (
          <p className="text-sm text-down">{errorMessage(error)}</p>
        ) : !data ? (
          <p className="text-sm text-muted">Загрузка…</p>
        ) : data.wallets.length === 0 ? (
          <p className="text-sm text-muted">
            Кошельков пока нет. Создайте адрес для нужной сети — он понадобится
            для пополнения и торговли.
          </p>
        ) : (
          <div className="space-y-2">
            {data.wallets.map((w: any) => (
              <WalletRow key={w.id} wallet={w} onChanged={mutate} />
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-1 border-b border-border">
        {([['create', 'Создать'], ['import', 'Импортировать']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${
              tab === k ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'create' ? <CreateWallet onDone={mutate} /> : <ImportWallet onDone={mutate} />}
    </div>
  );
}

function WalletRow({ wallet, onChanged }: { wallet: any; onChanged: () => void }) {
  const chain = CHAINS[wallet.chain];
  return (
    <div className="bg-bg rounded-md p-3 flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{chainLabel(wallet.chain)}</div>
        <div className="text-xs text-muted font-mono break-address">{wallet.address}</div>
      </div>
      <button
        onClick={() => navigator.clipboard?.writeText(wallet.address)}
        className="btn-ghost text-xs"
      >
        Копировать
      </button>
      {chain && (
        <a
          href={chain.explorerToken(wallet.address)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted hover:text-white"
        >
          Обозреватель ↗
        </a>
      )}
      <button
        onClick={async () => {
          if (!confirm('Отключить кошелёк? История операций сохранится.')) return;
          await api(`/wallets/${wallet.id}`, { method: 'DELETE' });
          onChanged();
        }}
        className="text-xs text-muted hover:text-down"
      >
        отключить
      </button>
    </div>
  );
}

function CreateWallet({ onDone }: { onDone: () => void }) {
  const [chain, setChain] = useState<string>('SOLANA');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r: any = await api('/wallets', {
        method: 'POST',
        body: JSON.stringify({ chain }),
      });
      setMsg(`Адрес создан: ${r.wallet.address}`);
      onDone();
    } catch (e) {
      setError(errorMessage(e, 'Не удалось создать кошелёк'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel p-4 space-y-3">
      <p className="text-sm text-muted leading-relaxed">
        Ключ генерируется на сервере и сразу шифруется: в базу попадает только
        зашифрованное значение, а сам ключ не показывается и не выгружается.
        Для каждой сети нужен свой адрес — Solana и EVM используют разные
        криптографические кривые.
      </p>

      <div>
        <label className="label">Сеть</label>
        <select className="input font-sans" value={chain} onChange={(e) => setChain(e.target.value)}>
          {CHAIN_OPTIONS.map((c) => (
            <option key={c} value={c}>{chainLabel(c)}</option>
          ))}
        </select>
      </div>

      {msg && <p className="text-xs text-up bg-up/10 border border-up/30 rounded p-2 break-address">{msg}</p>}
      {error && <p className="text-xs text-down bg-down/10 border border-down/30 rounded p-2">{error}</p>}

      <button onClick={create} disabled={busy}
              className="btn bg-accent hover:bg-accent/80 text-white w-full">
        {busy ? 'Создаём…' : 'Создать кошелёк'}
      </button>
    </div>
  );
}

function ImportWallet({ onDone }: { onDone: () => void }) {
  const [chain, setChain] = useState<string>('SOLANA');
  const [key, setKey] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r: any = await api('/wallets/import', {
        method: 'POST',
        body: JSON.stringify({ chain, privateKey: key.trim(), acknowledgeCustody: true }),
      });
      // Значение из поля стираем сразу: незачем держать ключ в DOM
      // дольше, чем нужно на отправку.
      setKey('');
      setMsg(`${r.wallet.address}\n\n${r.warning}`);
      onDone();
    } catch (e) {
      setError(errorMessage(e, 'Не удалось импортировать ключ'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel p-4 space-y-3">
      <div className="text-sm bg-down/10 border border-down/30 rounded-md p-3 space-y-2">
        <p className="text-down font-medium">Прочитайте, прежде чем вставлять ключ</p>
        <p className="text-muted leading-relaxed">
          Приватный ключ даёт полный контроль над средствами. Отправляя его сюда,
          вы передаёте этот контроль платформе. Ровно так же выглядят фишинговые
          сайты — поэтому никогда не вводите ключ нигде, кроме мест, которым
          осознанно доверяете.
        </p>
        <p className="text-muted leading-relaxed">
          Ключ, побывавший в двух местах, считается скомпрометированным. Для
          торговли безопаснее создать новый адрес и перевести на него нужную
          сумму, а не импортировать основной кошелёк.
        </p>
      </div>

      <div>
        <label className="label">Сеть</label>
        <select className="input font-sans" value={chain} onChange={(e) => setChain(e.target.value)}>
          {CHAIN_OPTIONS.map((c) => (
            <option key={c} value={c}>{chainLabel(c)}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="label">
          Приватный ключ — {chain === 'SOLANA' ? 'base58 или массив из 64 байт' : '64 символа hex'}
        </label>
        <textarea
          className="input min-h-[80px] text-xs"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={chain === 'SOLANA' ? '4xQy…' : '0x…'}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <label className="flex gap-2 items-start text-xs text-muted cursor-pointer">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)}
               className="mt-0.5 accent-accent" />
        <span>
          Я понимаю, что передаю приватный ключ на хранение платформе, и что
          этот кошелёк больше нельзя считать полностью моим.
        </span>
      </label>

      {msg && (
        <p className="text-xs text-up bg-up/10 border border-up/30 rounded p-2 whitespace-pre-line break-address">
          {msg}
        </p>
      )}
      {error && <p className="text-xs text-down bg-down/10 border border-down/30 rounded p-2">{error}</p>}

      <button onClick={run} disabled={busy || !ack || key.trim().length < 32}
              className="btn-ghost w-full">
        {busy ? 'Импортируем…' : 'Импортировать'}
      </button>
    </div>
  );
}
