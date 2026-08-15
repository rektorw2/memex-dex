'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher, api, fmtUsd, fmtPrice, fmtPct, errorMessage } from '@/lib/api';
import { chainLabel, CHAINS } from '@/lib/chains';
import { Sparkline } from '@/components/Sparkline';

const CHAIN_OPTIONS = ['SOLANA', 'BNB', 'BASE', 'ETHEREUM'] as const;

type Tab = 'radar' | 'gems';

export default function RadarPage() {
  const [tab, setTab] = useState<Tab>('radar');
  const [chain, setChain] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => setIsAdmin(localStorage.getItem('role') === 'ADMIN'), []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-xl sm:text-2xl font-bold">Радар</h1>
        <p className="text-sm text-muted">
          Новые токены и что с ними стало дальше
        </p>
      </div>

      <div className="flex gap-1 border-b border-border scroll-x">
        {([['radar', 'Находки'], ['gems', 'Результаты']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${
              tab === k ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
        <Link href="/radar/alerts" className="ml-auto self-center text-xs text-accent px-2 whitespace-nowrap">
          Уведомления →
        </Link>
      </div>

      <div className="flex gap-1 text-xs flex-wrap">
        <Chip active={!chain} onClick={() => setChain('')}>Все сети</Chip>
        {CHAIN_OPTIONS.map((c) => (
          <Chip key={c} active={chain === c} onClick={() => setChain(c)}>{chainLabel(c)}</Chip>
        ))}
      </div>

      {tab === 'radar' ? <FreshFinds chain={chain} isAdmin={isAdmin} /> : <Gems chain={chain} />}
    </div>
  );
}

// ──────────────────────────────── Находки ───────────────────────────────────

function FreshFinds({ chain, isAdmin }: { chain: string; isAdmin: boolean }) {
  const [maxRisk, setMaxRisk] = useState<number | ''>('');
  const [maxAge, setMaxAge] = useState<number | ''>('');
  const [smartOnly, setSmartOnly] = useState(false);
  const [showWatch, setShowWatch] = useState(false);
  const [busy, setBusy] = useState(false);

  const params = new URLSearchParams({
    limit: '60',
    // При включённом фильтре сортируем по силе сигнала: иначе список
    // остаётся хронологическим и самые интересные находки тонут.
    sort: smartOnly ? 'wallets' : 'recent',
  });
  if (chain) params.set('chain', chain);
  if (maxRisk !== '') params.set('maxRiskScore', String(maxRisk));
  if (maxAge !== '') params.set('maxAgeHours', String(maxAge));
  if (smartOnly) params.set('smartOnly', 'true');

  const { data, mutate, error } = useSWR<any>(`/radar?${params}`, fetcher, {
    refreshInterval: 30_000,
    keepPreviousData: true,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center">
        <select className="input w-auto text-xs font-sans" value={maxRisk}
                onChange={(e) => setMaxRisk(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">Любой риск</option>
          <option value="30">Риск до 30</option>
          <option value="50">Риск до 50</option>
          <option value="70">Риск до 70</option>
        </select>

        <select className="input w-auto text-xs font-sans" value={maxAge}
                onChange={(e) => setMaxAge(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">Любой возраст</option>
          <option value="1">До часа</option>
          <option value="6">До 6 часов</option>
          <option value="24">До суток</option>
        </select>

        <button
          onClick={() => setSmartOnly((v) => !v)}
          title="Только находки, которые покупали кошельки с подтверждённой историей"
          className={`rounded-md border px-3 py-2 text-xs transition ${
            smartOnly ? 'border-up bg-up/15 text-up' : 'border-border text-muted hover:text-white'
          }`}
        >
          Со смарт-деньгами
        </button>

        {isAdmin && (
          <>
            <button
              onClick={() => setShowWatch((v) => !v)}
              className="btn-ghost text-xs"
            >
              Добавить вручную
            </button>
            <button
              onClick={async () => { setBusy(true); try { await api('/radar/scan', { method: 'POST' }); mutate(); } finally { setBusy(false); } }}
              disabled={busy}
              className="btn-ghost text-xs"
            >
              {busy ? 'Сканируем…' : 'Сканировать сейчас'}
            </button>
          </>
        )}

        {data?.sources && (
          <span className="text-xs text-muted ml-auto">
            {data.sources.okx ? 'OKX + GeckoTerminal' : 'GeckoTerminal'} · порог{' '}
            {fmtUsd(data.minLiquidityUsd)}
          </span>
        )}
      </div>

      {isAdmin && showWatch && <WatchBox onDone={() => mutate()} />}

      {error && (
        <div className="panel p-4 border-down/40">
          <p className="text-sm text-down">{errorMessage(error)}</p>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data?.events?.map((e: any) => <TokenCard key={e.id} event={e} />)}
        {data && data.events.length === 0 && (
          <p className="text-muted text-sm col-span-full py-12 text-center">
            {smartOnly
              ? 'Среди находок пока нет таких, где покупали размеченные кошельки. Разметка накапливается по мере наблюдения за пулами.'
              : 'Пока ничего не найдено. Радар проверяет источники каждые три минуты.'}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Ручное добавление находок.
 *
 * Нужно потому, что автоматически читать чужие закрытые ленты нельзя:
 * это нарушает условия площадок и ломается молча — лента просто
 * перестаёт обновляться, без ошибки в логах. Здесь человек смотрит
 * своими глазами и вставляет то, что счёл нужным, а дальше находка
 * идёт обычным путём: наблюдение за ценой, разметка кошельков,
 * проверка автоправилом.
 */
function WatchBox({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api('/radar/watch', {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      setResult(r);
      setText('');
      onDone();
    } catch (e) {
      setError(errorMessage(e, 'Не удалось добавить'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium">Добавить токены под наблюдение</h3>
        <p className="text-muted mt-1 text-xs leading-relaxed">
          Вставьте адреса или ссылки — можно вперемешку и списком. Сеть
          определяется сама: для Solana по виду адреса, для EVM перебором,
          поскольку один адрес существует сразу в нескольких сетях.
        </p>
      </div>

      <textarea
        className="input h-24 font-mono text-xs"
        placeholder={'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\nhttps://dexscreener.com/base/0x…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={submit} disabled={busy || !text.trim()} className="btn-ghost text-xs">
          {busy ? 'Проверяем…' : 'Добавить'}
        </button>
        <span className="text-muted text-xs">
          Ручная находка проходит те же проверки, что автоматическая
        </span>
      </div>

      {error && <p className="text-down text-xs">{error}</p>}

      {result && (
        <div className="bg-bg space-y-1 rounded p-2.5 text-xs">
          <p>
            Добавлено: <span className="num text-up">{result.added}</span>
            {result.existed > 0 && (
              <> · уже под наблюдением: <span className="num">{result.existed}</span></>
            )}
          </p>
          {result.notFound?.length > 0 && (
            <div className="text-muted">
              {/* Причину показываем по каждому адресу: «не найдено» без
                  объяснения заставляет гадать, в адресе дело или в сети. */}
              {result.notFound.map((n: any) => (
                <p key={n.address} className="truncate">
                  <span className="num">{n.address.slice(0, 10)}…</span> — {n.reason}
                </p>
              ))}
            </div>
          )}
          {result.added === 0 && result.existed === 0 && !result.notFound?.length && (
            <p className="text-muted">Адресов в тексте не найдено</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── Результаты ─────────────────────────────────

function Gems({ chain }: { chain: string }) {
  const [sort, setSort] = useState<'peak' | 'current' | 'recent'>('peak');
  const [days, setDays] = useState(7);

  const params = new URLSearchParams({ sort, periodDays: String(days), limit: '60' });
  if (chain) params.set('chain', chain);

  const { data, error } = useSWR<any>(`/radar/gems?${params}`, fetcher, {
    refreshInterval: 60_000,
    keepPreviousData: true,
  });

  const perf = data?.performance;

  return (
    <div className="space-y-4">
      {/* Честная статистика самого радара */}
      {perf && perf.total > 0 && (
        <div className="panel p-3 sm:p-4">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Stat label="Находок за неделю" value={String(perf.total)} />
            <Stat label="Дошли до 2×" value={`${perf.hitRate2x}%`} tone="up" />
            <Stat label="Дошли до 5×" value={`${perf.hitRate5x}%`} tone="up" />
            <Stat label="Потеряли 80%+" value={`${perf.rugRate}%`} tone="down" />
            <Stat label="Медианный пик" value={`${perf.medianPeak.toFixed(2)}×`} />
          </div>
          <p className="text-xs text-muted mt-3 leading-relaxed">
            Доля провалов показывается намеренно. Витрина из одних побед
            не позволяет оценить, чего стоит отдельная находка: без знания,
            сколько токенов обнулилось, кратность ничего не значит.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <div className="flex gap-1 text-xs">
          <Chip active={sort === 'peak'} onClick={() => setSort('peak')}>По пику</Chip>
          <Chip active={sort === 'current'} onClick={() => setSort('current')}>По текущей</Chip>
          <Chip active={sort === 'recent'} onClick={() => setSort('recent')}>По времени</Chip>
        </div>
        <div className="flex gap-1 text-xs">
          {[1, 7, 30].map((d) => (
            <Chip key={d} active={days === d} onClick={() => setDays(d)}>
              {d === 1 ? 'сутки' : `${d} дней`}
            </Chip>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-down">{errorMessage(error)}</p>}

      <div className="space-y-2">
        {data?.events?.map((e: any) => <GemRow key={e.id} event={e} />)}
        {data && data.events.length === 0 && (
          <p className="text-muted text-sm py-12 text-center">
            Пока нет находок, выросших больше чем в полтора раза.
            Результаты появляются по мере наблюдения.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Строка «кто покупает» на карточке находки.
 *
 * Молчит, когда покупок размеченных кошельков нет. Плашка «0 смарт-денег»
 * на каждой карточке быстро перестаёт читаться и заодно создаёт ложное
 * впечатление, будто отсутствие метки — это проверенный вывод, а не
 * отсутствие данных.
 */
function WalletStrip({ wallets }: { wallets?: { smart: number; whale: number; smartVolumeUsd: string; strength: number } }) {
  if (!wallets || (wallets.smart === 0 && wallets.whale === 0)) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-bg p-2.5 text-xs">
      {wallets.smart > 0 && (
        <span className="text-up">
          {wallets.smart} с историей · {fmtUsd(wallets.smartVolumeUsd)}
        </span>
      )}
      {wallets.whale > 0 && <span className="text-accent">{wallets.whale} крупных</span>}
      <span className="ml-auto num text-muted" title="Сила сигнала с учётом давности покупок">
        {wallets.strength}/100
      </span>
    </div>
  );
}

// ──────────────────────────────── Карточки ──────────────────────────────────

function TokenCard({ event: e }: { event: any }) {
  const flags: string[] = Array.isArray(e.riskFlags) ? e.riskFlags : [];
  const chain = CHAINS[e.chain];
  const cur = e.currentMultiple;

  return (
    <article className="panel p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold truncate">{e.symbol}</div>
          <div className="text-xs text-muted truncate">{e.name}</div>
        </div>
        <MultipleBadge peak={e.peakMultiple} current={cur} />
      </div>

      <Sparkline points={e.points} />

      <div className="grid grid-cols-3 gap-2 text-xs bg-bg rounded-md p-2.5">
        <Cell label="Цена" value={fmtPrice(e.priceUsd)} />
        <Cell label="Ликвидность" value={fmtUsd(e.liquidityUsd)} />
        <Cell label="Возраст" value={e.poolAgeHours != null ? `${e.poolAgeHours.toFixed(1)} ч` : '—'} />
      </div>

      {e.riskScore != null && (
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 bg-border rounded overflow-hidden">
            <div
              className={`h-full ${e.riskScore > 60 ? 'bg-down' : e.riskScore > 30 ? 'bg-yellow-400' : 'bg-up'}`}
              style={{ width: `${e.riskScore}%` }}
            />
          </div>
          <span className="text-xs text-muted num">риск {e.riskScore}</span>
        </div>
      )}

      <WalletStrip wallets={e.wallets} />

      {flags.length > 0 && (
        <ul className="text-xs space-y-1">
          {flags.slice(0, 2).map((f, i) => (
            <li key={i} className="flex gap-1.5 text-muted">
              <span className="text-down shrink-0">•</span>{f}
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between text-xs text-muted">
        <span>{chainLabel(e.chain)} · {e.source}</span>
        <span>{new Date(e.firstSeenAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => navigator.clipboard?.writeText(e.address)}
          className="btn-ghost text-xs flex-1"
          title={e.address}
        >
          Копировать адрес
        </button>
        {chain && (
          <a
            href={chain.dexScreener(e.address)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-ghost text-xs"
          >
            График ↗
          </a>
        )}
      </div>
    </article>
  );
}

function GemRow({ event: e }: { event: any }) {
  const from = Number(e.mcapAtSignalUsd ?? 0);
  const to = Number(e.currentMcapUsd ?? 0);
  const grew = to >= from;

  return (
    <div className="panel p-3 flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{e.symbol}</span>
          <span className="text-xs text-muted truncate">{e.name}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-border text-muted">
            {chainLabel(e.chain)}
          </span>
        </div>
        <div className="text-xs text-muted mt-1 flex flex-wrap items-center gap-1.5">
          <span>{timeAgo(e.firstSeenAt)}</span>
          <span>·</span>
          <span className="num">{fmtUsd(from)}</span>
          <span className={grew ? 'text-up' : 'text-down'}>→</span>
          <span className={`num ${grew ? 'text-up' : 'text-down'}`}>{fmtUsd(to)}</span>
        </div>
      </div>

      <div className="w-24 shrink-0">
        <Sparkline points={e.points} height={32} />
      </div>

      <MultipleBadge peak={e.peakMultiple} current={e.currentMultiple} />
    </div>
  );
}

/**
 * Кратность показывается парой: пик и текущее значение.
 *
 * Одна цифра «111×» на витрине — это то, из-за чего такие ленты
 * превращаются в рекламу. Если пик давно пройден, а сейчас токен ниже
 * точки входа, человек должен видеть оба числа сразу.
 */
function MultipleBadge({ peak, current }: { peak: number | null; current: number | null }) {
  if (peak == null) return null;

  const faded = current != null && current < peak * 0.5;

  return (
    <div className="text-right shrink-0">
      <div
        className={`text-sm px-2 py-0.5 rounded border whitespace-nowrap num ${
          peak >= 5
            ? 'bg-up/15 text-up border-up/30'
            : peak >= 2
              ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30'
              : 'bg-border text-muted border-border'
        }`}
        title="Максимальная достигнутая кратность"
      >
        пик {peak.toFixed(peak >= 10 ? 0 : 2)}×
      </div>
      {current != null && (
        <div
          className={`text-[10px] mt-1 num ${
            current >= 1 ? 'text-muted' : 'text-down'
          }`}
          title="Кратность прямо сейчас"
        >
          сейчас {current.toFixed(2)}×
          {faded && ' ↓'}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── Мелочи ─────────────────────────────────────

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className="num">{value}</div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={`num ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''}`}>
        {value}
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 rounded whitespace-nowrap ${
        active ? 'bg-accent/20 text-accent' : 'text-muted hover:text-white hover:bg-border'
      }`}
    >
      {children}
    </button>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} мин`;
  if (h < 24) return `${Math.round(h)} ч`;
  return `${Math.round(h / 24)} д`;
}
