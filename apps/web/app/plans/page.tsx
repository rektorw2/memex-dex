'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';
import { useAccess } from '../../lib/access';

/**
 * Сравнение тарифов.
 *
 * Цены, срок, валюты и сеть приходят с сервера — из того же каталога,
 * по которому считают деньги. Записать их здесь руками было бы
 * быстрее ровно один раз: при первом же изменении страница начала бы
 * обещать не то, что списывается, и заметить это можно было бы только
 * по жалобе.
 *
 * Два обещания, которых страница не даёт.
 *
 * Не «в месяц». Период ровно тридцать суток; месяц бывает 28, 29, 30
 * и 31 день, и разница однажды превратилась бы в спор.
 *
 * Не «доллар равен USDC». Платят долларами, получают USDC —
 * конвертирует провайдер, и комиссии видны только в его ответе.
 * Обещать равенство значит обещать курс, которым мы не управляем.
 *
 * И не «оплатите картой». Способ оплаты зависит от действующего
 * провайдера, а он выбирается настройкой сервера. Названный здесь
 * руками, он разойдётся с действительностью в день переключения.
 */

interface CatalogResponse {
  trialHours: number;
  paymentsEnabled: boolean;
  plans: Array<{
    plan: string;
    price: { amount: string; currency: string };
    termDays: number;
    sourceCurrency: string;
    sourceAmount: string;
    settlementChain: string;
  }>;
}

const PLAN_TITLE: Record<string, string> = {
  PRO: 'PRO',
  SEMI_AUTO: 'Полуавтомат',
  FULL_AUTO: 'Автомат',
};

const CAPABILITY_TITLE: Record<string, string> = {
  RADAR_ACCESS: 'Радар находок',
  TERMINAL_ACCESS: 'Разбор токена в терминале',
  MANUAL_TRADE: 'Ручная покупка',
  PORTFOLIO_READ: 'Свой портфель',
  WALLET_DEPOSIT: 'Пополнение кошелька',
  WALLET_WITHDRAW: 'Вывод средств',
  SELL_OWN_ASSET: 'Продажа своих активов',
  PROTECTIVE_EXIT: 'Защитные выходы',
  SMART_WALLETS_ACCESS: 'Смарт-кошельки',
  LEADER_COPY_BUY: 'Копирование покупок лидера',
  SEMI_AUTO_TRADE: 'Вход по сигналу',
  AUTO_BUY: 'Автоматическая покупка',
  AUTO_EXIT: 'Автоматический выход',
  STRATEGY_AUTOMATION: 'Настройка стратегий',
};

interface PlansResponse {
  plans: Array<{ plan: string; capabilities: string[] }>;
}

interface PaymentsStatus {
  enabled: boolean;
  provider: 'disabled' | 'bridge' | 'coinbase';
  capabilities: string[];
  sandbox: boolean;
}

export default function PlansPage() {
  const { access } = useAccess();
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [caps, setCaps] = useState<Record<string, string[]>>({});
  const [status, setStatus] = useState<PaymentsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<CatalogResponse>('/payments/catalog', { base: 'root' }),
      api<PlansResponse>('/access/plans', { base: 'root' }),
      api<PaymentsStatus>('/payments/status', { base: 'root' }),
    ])
      .then(([c, p, s]) => {
        setCatalog(c);
        setCaps(Object.fromEntries(p.plans.map((x) => [x.plan, x.capabilities])));
        setStatus(s);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить тарифы'));
  }, []);

  if (error) return <p style={{ color: 'var(--danger)' }}>{error}</p>;
  if (!catalog) return <p style={{ color: 'var(--muted)' }}>Загружаем тарифы…</p>;

  // Текст строится по возможностям провайдера, а не по его имени:
  // проверка `provider === 'bridge'` в пяти местах разъезжается
  // при появлении третьего.
  const bankTransfer = status?.capabilities.includes('bankInstructions') ?? false;
  const hostedCheckout = status?.capabilities.includes('hostedCheckout') ?? false;

  return (
    <div>
      <h1>Тарифы</h1>

      <p style={{ color: 'var(--muted)', maxWidth: '62ch' }}>
        Каждый оплаченный период — {catalog.plans[0]?.termDays ?? 30} суток. Первые{' '}
        {catalog.trialHours} часов бесплатны, один раз на аккаунт. Продажа своих активов,
        вывод средств и просмотр портфеля доступны при любом плане и после его окончания.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
          gap: '16px',
          marginTop: '24px',
        }}
      >
        {catalog.plans.map((p) => {
          const current = access?.effectivePlan === p.plan;

          return (
            <section
              key={p.plan}
              style={{
                border: current ? '2px solid var(--accent)' : '1px solid var(--border)',
                borderRadius: '12px',
                padding: '16px',
              }}
            >
              <h2 style={{ marginTop: 0, fontSize: '18px' }}>
                {PLAN_TITLE[p.plan] ?? p.plan}
                {current ? <span style={{ color: 'var(--muted)' }}> · текущий</span> : null}
              </h2>

              <p style={{ fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>
                {p.price.amount} {p.price.currency}
              </p>

              <p style={{ fontSize: '13px', color: 'var(--muted)', margin: '0 0 12px' }}>
                за {p.termDays} суток · оплата {p.sourceAmount} {p.sourceCurrency}
              </p>

              <ul style={{ paddingLeft: '18px', margin: '0 0 16px' }}>
                {(caps[p.plan] ?? []).map((c) => (
                  <li key={c} style={{ fontSize: '14px', lineHeight: 1.7 }}>
                    {CAPABILITY_TITLE[c] ?? c}
                  </li>
                ))}
              </ul>

              {catalog.paymentsEnabled ? (
                <Link href={`/checkout?plan=${p.plan}`}>Оплатить</Link>
              ) : (
                // Кнопки нет вовсе. Нерабочая кнопка оплаты хуже её
                // отсутствия: человек нажмёт и решит, что сломался он.
                <span style={{ fontSize: '13px', color: 'var(--muted)' }}>
                  Оплата пока не подключена
                </span>
              )}
            </section>
          );
        })}
      </div>

      <div style={{ marginTop: '24px', fontSize: '14px', color: 'var(--muted)', maxWidth: '62ch' }}>
        {status?.sandbox ? (
          <p style={{ margin: '0 0 8px', color: 'var(--danger)' }}>
            Оплата работает в тестовом режиме: настоящие деньги не принимаются.
          </p>
        ) : null}

        <p style={{ margin: '0 0 8px' }}>
          Оплата принимается в {catalog.plans[0]?.sourceCurrency ?? 'USD'}
          {bankTransfer ? ' банковским переводом' : ''}. Провайдер конвертирует сумму
          в {catalog.plans[0]?.price.currency ?? 'USDC'} и отправляет в сети{' '}
          {catalog.plans[0]?.settlementChain === 'SOLANA' ? 'Solana' : catalog.plans[0]?.settlementChain}.
          Комиссии конвертации и итоговая доставленная сумма показываются после завершения.
        </p>

        <p style={{ margin: '0 0 8px' }}>
          {/* Сроки называются те, что бывают на самом деле. «Мгновенно»
              на банковском переводе — обещание, которое нарушится
              в первый же раз. */}
          {bankTransfer
            ? 'Доступ открывается не мгновенно: банковский перевод идёт от нескольких часов до нескольких рабочих дней.'
            : 'Доступ открывается после того, как оплата подтвердится в сети. Обычно это минуты, иногда дольше.'}{' '}
          Автоматического продления нет — следующий период покупается отдельно.
        </p>

        {hostedCheckout ? (
          <p style={{ margin: 0 }}>
            Оплата проходит на странице платёжного провайдера. Он же проверяет личность
            и может отказать в обслуживании по стране проживания — это его решение,
            и повлиять на него мы не можем.
          </p>
        ) : null}
      </div>
    </div>
  );
}
