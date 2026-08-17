'use client';

/**
 * Избранные кошельки пользователя.
 *
 * Вкладка была заглушкой: «подписки ещё не подключены». Теперь здесь
 * настоящие отметки — те же, что горят звёздами в списке и в ленте.
 *
 * Два состояния, которые важно не спутать. Кошелёк может быть
 * отмечен раньше, чем о нём собрана статистика: мы видим адрес
 * в ленте, но истории его сделок ещё не выгрузили. Это не «нулевые
 * показатели» и не ошибка — это «считаем», и выглядеть оно обязано
 * иначе, чем посчитанный ноль.
 */

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { timeAgo } from '@memex/core';
import { fetcher, errorMessage } from '@/lib/api';
import { chainLabel, CHAINS } from '@/lib/chains';
import { useFavorites, walletKey } from '@/lib/favorites';
import { Identicon } from './SmartScore';
import { short } from './WalletViews';
import { FavoriteStar } from './FavoriteStar';
import { PnlValue } from './PnlValue';

interface FavoritePnl {
  state: 'available' | 'pending' | 'incomplete_history';
  realizedUsd: number | null;
  unrealizedUsd: number | null;
  closedPositions: number | null;
  incompleteTokens: number | null;
  computedAt: string | null;
}

interface FavoriteItem {
  chain: string;
  address: string;
  addedAt: string;
  /** Статистика по кошельку собрана. Иначе показатели ещё считаются. */
  known: boolean;
  score: number | null;
  label: string | null;
  tokensBought: number | null;
  wins2x: number | null;
  lastActiveAt: string | null;
  pnl: FavoritePnl;
}

interface FavoritesResponse {
  available: boolean;
  requiredAction: string | null;
  favorites: FavoriteItem[];
}

type Sort = 'added' | 'score' | 'pnl' | 'active';

const SORTS: Array<[Sort, string]> = [
  ['added', 'По дате добавления'],
  ['score', 'По Smart Score'],
  ['pnl', 'По результату'],
  ['active', 'По активности'],
];

export function FollowingTab({ onFind }: { onFind?: () => void }) {
  const { keys, isGuest, revision } = useFavorites();
  const [chain, setChain] = useState('');
  const [sort, setSort] = useState<Sort>('added');

  // Ключ запроса включает счётчик изменений: нажатие звезды в другой
  // вкладке обязано обновить этот список без перезагрузки страницы.
  const { data, error, isLoading } = useSWR<FavoritesResponse>(
    isGuest ? null : ['/wallets/favorites', revision],
    ([path]) => fetcher(path as string),
    { keepPreviousData: true },
  );

  const items = useMemo(() => {
    // Гость видит свои отметки из браузера. Показателей по ним нет —
    // они считаются на сервере и требуют аккаунта, и это честнее,
    // чем прятать сам список.
    const source: FavoriteItem[] = isGuest
      ? [...keys].map((key) => guestItem(key))
      : (data?.favorites ?? []);

    const filtered = chain ? source.filter((f) => f.chain === chain) : source;
    return sortItems(filtered, sort);
  }, [isGuest, keys, data, chain, sort]);

  // ── Схема базы ещё не обновлена ─────────────────────────────────
  if (data && data.available === false) {
    return (
      <Notice
        title="Избранное пока не сохраняется на сервере"
        text="В базе нет таблицы избранного. Отметки живут в браузере и не потеряются, но между устройствами не переносятся."
      />
    );
  }

  if (error) {
    return (
      <div className="panel border-down/40 p-4">
        <p className="text-sm text-down">Не удалось загрузить избранное</p>
        <p className="mt-1 text-xs text-muted/70">{errorMessage(error)}</p>
      </div>
    );
  }

  if (isLoading && items.length === 0) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="panel flex items-center gap-3 p-4">
            <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-raised" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-32 animate-pulse rounded bg-raised" />
              <div className="h-2.5 w-48 animate-pulse rounded bg-raised/60" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="panel px-6 py-16 text-center">
        <p className="text-sm text-muted">Пока никого не отслеживаете</p>
        <p className="mx-auto mt-2 max-w-[380px] text-xs leading-relaxed text-muted/70">
          Отметьте звёздочкой кошелёк в списке или в ленте активности —
          он появится здесь.
        </p>
        {onFind && (
          <button
            onClick={onFind}
            className="tap mt-4 h-10 rounded-lg bg-accent px-4 text-sm font-medium text-white"
          >
            Найти кошельки
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="scroll-x flex gap-1.5">
          <Chip active={!chain} onClick={() => setChain('')}>
            Все сети
          </Chip>
          {(['SOLANA', 'BNB', 'BASE', 'ETHEREUM'] as const).map((c) => (
            <Chip key={c} active={chain === c} onClick={() => setChain(c)}>
              {chainLabel(c)}
            </Chip>
          ))}
        </div>

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="ml-auto h-10 cursor-pointer appearance-none rounded-lg border border-border bg-panel px-3 text-xs outline-none focus:border-accent"
        >
          {SORTS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {isGuest && (
        <p className="panel px-4 py-3 text-[11px] leading-relaxed text-muted/80">
          Отметки хранятся в этом браузере. Войдите, чтобы они переносились
          между устройствами и чтобы считались результаты по кошелькам.
        </p>
      )}

      <div className="space-y-2">
        {items.map((f) => (
          <FavoriteRow key={walletKey(f.chain, f.address)} item={f} />
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────── Строка ────────────────────────────────────

function FavoriteRow({ item: f }: { item: FavoriteItem }) {
  const chain = CHAINS[f.chain];
  const pending = f.pnl.state === 'pending';
  const incomplete = f.pnl.state === 'incomplete_history';
  const computedAt = f.pnl.computedAt ? new Date(f.pnl.computedAt).getTime() : null;

  return (
    <article className="panel space-y-3 p-4">
      <div className="flex items-start gap-3">
        <Identicon address={f.address} size={36} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="num truncate text-[13px] font-medium">{short(f.address)}</span>
            <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] text-muted">
              {chainLabel(f.chain)}
            </span>

            {/* Оценки может не быть, и это не «плохой кошелёк»,
                а недостаток наблюдений. Формулировка это отражает. */}
            {f.score != null ? (
              <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                Smart Score {f.score}
              </span>
            ) : (
              <span className="shrink-0 text-[10px] text-muted/60">
                {f.known ? 'оценки пока нет' : 'собираем историю'}
              </span>
            )}
          </div>

          <p className="mt-1 text-[11px] text-muted/70">
            {f.lastActiveAt ? `Активен ${timeAgo(f.lastActiveAt)}` : 'Активность неизвестна'}
            {f.pnl.closedPositions != null && <> · закрытых сделок {f.pnl.closedPositions}</>}
            {' · '}в избранном {timeAgo(f.addedAt)}
          </p>
        </div>

        <FavoriteStar chain={f.chain} address={f.address} />
      </div>

      {/* Три показателя раздельно. Реализованный — деньги, которые
          уже получены; нереализованный — бумажная величина, которая
          исчезнет при первом развороте рынка. Смешивать их нельзя. */}
      <dl className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-[11px]">
        <Cell label="Реализованный">
          <PnlValue
            valueUsd={f.pnl.realizedUsd}
            isPending={pending}
            hasIncompleteHistory={incomplete}
            computedAt={computedAt}
            kind="realized"
            size="sm"
          />
        </Cell>

        <Cell label="Нереализованный">
          <PnlValue
            valueUsd={f.pnl.unrealizedUsd}
            isPending={pending}
            hasIncompleteHistory={incomplete}
            computedAt={computedAt}
            kind="unrealized"
            size="sm"
          />
        </Cell>

        <Cell label="Общий">
          <PnlValue
            // Складываем только когда известны обе части: подставить
            // ноль вместо неизвестного значит выдать половину ответа
            // за целый.
            valueUsd={
              f.pnl.realizedUsd != null && f.pnl.unrealizedUsd != null
                ? f.pnl.realizedUsd + f.pnl.unrealizedUsd
                : null
            }
            isPending={pending}
            hasIncompleteHistory={incomplete}
            computedAt={computedAt}
            kind="total"
            size="sm"
          />
        </Cell>
      </dl>

      {incomplete && f.pnl.incompleteTokens != null && f.pnl.incompleteTokens > 0 && (
        <p className="text-[10px] leading-relaxed text-warn/70">
          По {f.pnl.incompleteTokens} токенам покупки произошли раньше доступной
          истории. Такие позиции в оценку не идут.
        </p>
      )}

      {chain && (
        <a
          href={chain.explorerAddress?.(f.address) ?? chain.explorerToken(f.address)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-[11px] text-accent transition-opacity hover:opacity-80"
        >
          Открыть в обозревателе ↗
        </a>
      )}
    </article>
  );
}

// ─────────────────────────────── Мелочи ─────────────────────────────────────

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-muted/60">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`tap shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs transition-colors ${
        active ? 'bg-accent/15 text-accent' : 'bg-raised text-muted hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <div className="panel px-6 py-12 text-center">
      <p className="text-sm text-muted">{title}</p>
      <p className="mx-auto mt-2 max-w-[420px] text-xs leading-relaxed text-muted/70">{text}</p>
    </div>
  );
}

/**
 * Отметка гостя.
 *
 * Показателей у неё нет и быть не может: они считаются на сервере
 * по истории сделок. Состояние `pending` здесь означает именно это,
 * а не «сейчас досчитается».
 */
function guestItem(key: string): FavoriteItem {
  const index = key.indexOf(':');

  return {
    chain: key.slice(0, index),
    address: key.slice(index + 1),
    addedAt: new Date().toISOString(),
    known: false,
    score: null,
    label: null,
    tokensBought: null,
    wins2x: null,
    lastActiveAt: null,
    pnl: {
      state: 'pending',
      realizedUsd: null,
      unrealizedUsd: null,
      closedPositions: null,
      incompleteTokens: null,
      computedAt: null,
    },
  };
}

function sortItems(items: FavoriteItem[], sort: Sort): FavoriteItem[] {
  const copy = [...items];

  switch (sort) {
    case 'score':
      // Кошельки без оценки уходят вниз, а не считаются нулём:
      // отсутствие оценки — это мало наблюдений, а не плохой результат.
      return copy.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

    case 'pnl':
      return copy.sort((a, b) => (b.pnl.realizedUsd ?? -Infinity) - (a.pnl.realizedUsd ?? -Infinity));

    case 'active':
      return copy.sort(
        (a, b) => timeOf(b.lastActiveAt) - timeOf(a.lastActiveAt),
      );

    default:
      return copy.sort((a, b) => timeOf(b.addedAt) - timeOf(a.addedAt));
  }
}

function timeOf(value: string | null): number {
  return value ? new Date(value).getTime() : 0;
}
