'use client';

import Link from 'next/link';
import { loginHref } from '@memex/core';
import { TradePanel } from '@/components/TradePanel';
import { fmtUsd } from '@/lib/api';
import type { Token } from './types';

/**
 * Правая колонка: портфель и торговля.
 *
 * Порядок обратный привычному — сводка сверху, торговля под ней.
 * Причина в том, что сводку читают до решения, а форму заполняют
 * после: свободный остаток нужно видеть раньше, чем поле суммы.
 *
 * Если торговать нечем, колонка не остаётся пустой: пустая треть
 * экрана выглядит как незагрузившийся интерфейс, а не как отсутствие
 * возможности.
 *
 * Три разных состояния, и путать их нельзя.
 *
 * Гость — терминал открыт без входа, ему предлагается регистрация.
 *
 * Вошедший без действующего доступа — ему предлагается онбординг.
 * Раньше он получал рабочую форму покупки, потому что признаком
 * считался факт входа. Форма отправляла заявку, сервер отвечал
 * отказом, и человек видел ошибку там, где должен был увидеть
 * предложение. Признак теперь другой: серверная возможность
 * `MANUAL_TRADE`.
 *
 * Вошедший с доступом — форма.
 *
 * Портфель при этом показывается всем вошедшим независимо от плана:
 * `PORTFOLIO_READ` не отбирается никогда, и человек с истёкшей
 * подпиской обязан видеть свои позиции, чтобы иметь возможность
 * их продать.
 */

interface Props {
  token: Token | null;
  quoteToken: Token | undefined;
  portfolio: any;
  isLoading?: boolean;
  /**
   * Вошёл ли человек. Приходит из ответа сервера о правах.
   *
   * Раньше это выводили из наличия портфеля, и вывод был неверным:
   * у вошедшего человека портфель может не загрузиться, и тогда
   * интерфейс объявлял бы его гостем и предлагал войти повторно.
   */
  anonymous: boolean;
  /**
   * Есть ли серверная возможность торговать.
   *
   * Не «вошёл ли»: вход и право покупать — разные вещи, и форма,
   * показанная по первому признаку, отправляет заявку, которую
   * сервер отклонит.
   */
  canTrade: boolean;
}

export function SidePanel({
  token,
  quoteToken,
  portfolio,
  isLoading,
  anonymous,
  canTrade,
}: Props) {
  const isAuthed = !anonymous;
  const pnl = Number(portfolio?.unrealizedPnlUsd ?? 0);

  return (
    <div className="flex h-full min-w-0 flex-col gap-4">
      {/* ─── Портфель ───────────────────────────────────────────────── */}
      <div className="panel shrink-0 p-4">
        <h2 className="mb-3 text-sm font-medium">Портфель</h2>

        {isLoading && !portfolio ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-4 animate-pulse rounded bg-raised" />
            ))}
          </div>
        ) : !isAuthed ? (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-muted">
              Котировки, графики и оценка риска открыты без входа. Позиции
              и торговля — после регистрации.
            </p>
            <Link href={loginHref(null, { register: true })} className="btn-primary block w-full text-center text-sm">
              Создать аккаунт
            </Link>
            <Link
              href={loginHref(null)}
              className="block w-full text-center text-xs text-muted hover:text-white"
            >
              У меня уже есть аккаунт
            </Link>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <Row label="Всего" value={fmtUsd(portfolio?.totalValueUsd)} strong />
            <Row label="Свободно" value={fmtUsd(portfolio?.cashUsd)} />
            <Row
              label="Нереализованный PnL"
              value={fmtUsd(portfolio?.unrealizedPnlUsd)}
              tone={pnl >= 0 ? 'up' : 'down'}
              sign
            />
            <div className="border-t border-border pt-2">
              <Row
                label="Уплаченная комиссия"
                value={fmtUsd(portfolio?.totalFeesPaidUsd)}
                small
              />
            </div>
          </div>
        )}
      </div>

      {/* ─── Торговля ───────────────────────────────────────────────── */}
      {isAuthed && canTrade && token && quoteToken ? (
        <TradePanel
          tokenId={token.id}
          tokenSymbol={token.symbol}
          quoteTokenId={quoteToken.id}
          quoteSymbol={quoteToken.symbol}
          chain={token.chain}
          currentPriceUsd={Number(token.priceUsd ?? 0)}
          availableQuote={Number(portfolio?.cashUsd ?? 0)}
          availableToken={Number(
            portfolio?.holdings?.find((h: any) => h.tokenId === token.id)?.quantity ?? 0,
          )}
        />
      ) : (
        <div className="panel flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-sm text-muted">
            {!isAuthed
              ? 'Торговля после регистрации'
              : !canTrade
                ? 'Торговля на действующем плане'
                : !token
                  ? 'Выберите токен'
                  : 'Нет котировочной валюты'}
          </p>

          <p className="max-w-[220px] text-xs leading-relaxed text-muted/70">
            {!isAuthed
              ? 'Ордера исполняются по реальным котировкам в бумажном режиме — деньги не задействованы'
              : !canTrade
                ? 'Свои позиции видны, продать и вывести можно всегда. Для покупки включите бесплатный период'
                : !token
                  ? 'Форма покупки появится здесь'
                  : 'В этой сети не заведён USDC или другой котировочный токен — добавьте его в админке'}
          </p>

          {!isAuthed && (
            <Link href={loginHref(null, { register: true })} className="btn-primary mt-1 text-sm">
              Начать бесплатно
            </Link>
          )}

          {isAuthed && !canTrade && (
            <Link href="/onboarding" className="btn-primary mt-1 text-sm">
              Включить доступ
            </Link>
          )}
        </div>
      )}

      {/* ─── Открытые позиции ───────────────────────────────────────── */}
      {isAuthed && portfolio?.holdings?.length > 0 && (
        <div className="panel shrink-0 p-4">
          <h2 className="mb-2 text-sm font-medium">Позиции</h2>
          <div className="space-y-1.5">
            {portfolio.holdings.slice(0, 5).map((h: any) => {
              const p = Number(h.unrealizedPnlPct ?? 0);
              return (
                <div key={h.tokenId} className="flex items-center gap-2 text-xs">
                  <span className="truncate font-medium">{h.symbol}</span>
                  <span className="num ml-auto text-muted">{fmtUsd(h.valueUsd)}</span>
                  <span className={`num w-[58px] text-right ${p >= 0 ? 'text-up' : 'text-down'}`}>
                    {p >= 0 ? '+' : ''}
                    {p.toFixed(1)}%
                  </span>
                </div>
              );
            })}
          </div>
          {portfolio.holdings.length > 5 && (
            <Link
              href="/portfolio"
              className="mt-2 inline-block text-xs text-accent hover:underline"
            >
              ещё {portfolio.holdings.length - 5} →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  small,
  strong,
  sign,
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down';
  small?: boolean;
  strong?: boolean;
  sign?: boolean;
}) {
  // Знак у величин, которые бывают отрицательными: полагаться на один
  // цвет нельзя, его различают не все.
  const shown = sign && tone === 'up' && !value.startsWith('-') ? `+${value}` : value;

  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className={`text-muted ${small ? 'text-xs' : ''}`}>{label}</span>
      <span
        className={`num ${small ? 'text-xs' : ''} ${strong ? 'text-base font-semibold' : ''} ${
          tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''
        }`}
      >
        {shown}
      </span>
    </div>
  );
}
