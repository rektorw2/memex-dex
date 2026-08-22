'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '../../lib/api';
import { useAccess } from '../../lib/access';

/**
 * Оплата подписки.
 *
 * Страница собирается по возможностям действующего провайдера,
 * а не по его имени. Это не украшение: у Bridge есть отдельный шаг
 * проверки личности и банковские реквизиты, у Coinbase проверка
 * происходит внутри его страницы, а реквизитов нет вовсе. Зашитая
 * здесь карта провайдеров разъехалась бы в день переключения, и
 * человек увидел бы шаг, которого не существует.
 *
 * Чего страница не делает ни при каком провайдере.
 *
 * Не выдаёт доступ. Ни одна кнопка здесь подписку не открывает.
 * Возвращение браузера с чужой страницы состоянием не является —
 * браузер возвращается и по кнопке «назад», и по закрытой вкладке.
 *
 * Не спрашивает провайдера. Все состояния приходят от нашего API,
 * которое само перечитывает их у провайдера и сверяет сумму, актив,
 * сеть и адрес получателя.
 */

interface PaymentsStatus {
  enabled: boolean;
  provider: 'disabled' | 'bridge' | 'coinbase';
  capabilities: string[];
  kycInsideCheckout: boolean;
  needsSeparateKyc: boolean;
  sandbox: boolean;
}

interface Onboarding {
  kycUrl: string | null;
  tosUrl: string | null;
  kycState: string;
  tosAccepted: boolean;
}

interface Payment {
  paymentId: string;
  provider: string;
  plan: string;
  state: string;
  priceAmount: string;
  priceCurrency: string;
  termDays: number;
  sourceCurrency: string;
  sourceAmount: string;
  destinationCurrency: string;
  destinationChain: string;
  instructions: {
    depositMessage: string | null;
    bankName: string | null;
    accountNumber: string | null;
    routingNumber: string | null;
  } | null;
  destinationTxHash: string | null;
  receiptUrl: string | null;
  deliveredAmount: string | null;
  paidAt: string | null;
}

/** Ответ на создание размещённой оплаты. Реквизитов у него нет. */
interface HostedCheckout {
  paymentId: string;
  plan: string;
  hostedUrl: string;
  expiresAt: string;
  priceAmount: string;
  priceCurrency: string;
  termDays: number;
}

const KYC_TEXT: Record<string, string> = {
  NOT_STARTED: 'Проверка не начата.',
  NOT_REQUIRED: 'Отдельная проверка не требуется.',
  INCOMPLETE: 'Проверка начата, но не закончена.',
  UNDER_REVIEW: 'Проверка идёт. Обычно это минуты, иногда — до следующего рабочего дня.',
  APPROVED: 'Проверка пройдена.',
  REJECTED: 'Проверка не пройдена. Обратитесь в поддержку провайдера.',
  PAUSED: 'Проверка приостановлена. Обратитесь в поддержку.',
  OFFBOARDED: 'Провайдер прекратил обслуживание этого аккаунта.',
};

const STATE_TEXT: Record<string, string> = {
  CREATED: 'Счёт создан.',
  KYC_REQUIRED: 'Нужна проверка личности.',
  AWAITING_FUNDS: 'Ждём вашу оплату.',
  IN_REVIEW: 'Провайдер проверяет платёж. Обычно это секунды.',
  FUNDS_RECEIVED: 'Деньги получены, идёт конвертация.',
  PAYMENT_SUBMITTED: 'Перевод отправлен в сеть.',
  PAID: 'Оплачено. Подписка активна.',
  UNDELIVERABLE: 'Доставить не удалось. Напишите в поддержку.',
  FAILED: 'Платёж не состоялся.',
  MANUAL_REVIEW_REQUIRED:
    'Платёж на разборе: оплата не совпала с ожидаемой. Деньги не потеряны, с вами свяжутся.',
};

const OPEN_STATES = new Set([
  'CREATED',
  'KYC_REQUIRED',
  'AWAITING_FUNDS',
  'IN_REVIEW',
  'FUNDS_RECEIVED',
  'PAYMENT_SUBMITTED',
]);

function CheckoutInner() {
  const params = useSearchParams();
  const plan = params.get('plan') ?? 'PRO';
  const { reload } = useAccess();

  const [status, setStatus] = useState<PaymentsStatus | null>(null);
  const [onboarding, setOnboarding] = useState<Onboarding | null>(null);
  const [fullName, setFullName] = useState('');
  const [payment, setPayment] = useState<Payment | null>(null);
  const [hosted, setHosted] = useState<HostedCheckout | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const resumed = useRef(false);

  const loadOnboarding = useCallback(async () => {
    try {
      setOnboarding(await api<Onboarding>('/payments/onboarding', { base: 'root' }));
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { code?: string } | undefined) : undefined;
      if (body?.code === 'PAYMENTS_UNAVAILABLE') setError('Оплата подписок сейчас недоступна.');
    }
  }, []);

  useEffect(() => {
    api<PaymentsStatus>('/payments/status', { base: 'root' })
      .then(setStatus)
      .catch(() => setError('Не удалось узнать состояние оплаты.'));
  }, []);

  useEffect(() => {
    if (status?.needsSeparateKyc) void loadOnboarding();
  }, [status, loadOnboarding]);

  /**
   * Возвращение с размещённой страницы оплаты.
   *
   * Провайдер возвращает браузер на один и тот же адрес и не говорит,
   * какой платёж имелся в виду. Поэтому незавершённый платёж
   * находится по нашим же записям, а его состояние перечитывается
   * на сервере — этот запрос ничего не утверждает, он спрашивает.
   */
  useEffect(() => {
    if (!status?.enabled || status.provider !== 'coinbase' || resumed.current) return;
    resumed.current = true;

    void (async () => {
      setChecking(true);

      try {
        const { payments } = await api<{ payments: Payment[] }>('/payments?limit=10', {
          base: 'root',
        });

        const mine = payments.find((p) => p.plan === plan && OPEN_STATES.has(p.state));
        if (!mine) return;

        const fresh = await api<Payment>(`/payments/${mine.paymentId}/refresh`, {
          method: 'POST',
          base: 'root',
        });

        setPayment(fresh);
        if (fresh.state === 'PAID') await reload();
      } catch {
        // Молчим: страницу это не ломает, состояние подтянет опрос.
      } finally {
        setChecking(false);
      }
    })();
  }, [status, plan, reload]);

  /**
   * Опрос состояния платежа.
   *
   * Только по нашему API. Провайдера браузер не спрашивает: ключ
   * к нему в браузере не появляется, а верить чужому ответу
   * на клиенте нельзя.
   */
  useEffect(() => {
    if (!payment || !OPEN_STATES.has(payment.state)) return;

    const timer = setInterval(async () => {
      try {
        const path =
          payment.provider === 'COINBASE'
            ? `/payments/${payment.paymentId}/refresh`
            : `/payments/${payment.paymentId}`;

        const fresh = await api<Payment>(path, {
          base: 'root',
          ...(payment.provider === 'COINBASE' ? { method: 'POST' as const } : {}),
        });

        setPayment(fresh);

        // Права пересчитывает сервер. Интерфейс их только перечитывает.
        if (fresh.state === 'PAID') await reload();
      } catch {
        // Молчим: следующая попытка через десять секунд.
      }
    }, 10_000);

    return () => clearInterval(timer);
  }, [payment, reload]);

  async function startKyc() {
    if (fullName.trim().length < 2) {
      setError('Укажите имя и фамилию, как в документе');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      setOnboarding(
        await api<Onboarding>('/payments/onboarding', {
          method: 'POST',
          base: 'root',
          body: JSON.stringify({ fullName: fullName.trim() }),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось начать проверку');
    } finally {
      setBusy(false);
    }
  }

  async function createPayment() {
    setBusy(true);
    setError(null);

    try {
      // Отправляется только код плана. Сумму, срок, сеть, адрес
      // и провайдера сервер выбирает сам.
      const res = await api<Payment | HostedCheckout>('/payments/checkout', {
        method: 'POST',
        base: 'root',
        body: JSON.stringify({ plan }),
      });

      if ('hostedUrl' in res) setHosted(res);
      else setPayment(res);
    } catch (e) {
      const body =
        e instanceof ApiError
          ? (e.body as { code?: string; paymentId?: string } | undefined)
          : undefined;

      if (body?.code === 'CHECKOUT_IN_PROGRESS' && body.paymentId) {
        setPayment(await api<Payment>(`/payments/${body.paymentId}`, { base: 'root' }));
      } else if (body?.code === 'PLAN_CHANGE_POLICY_REQUIRED') {
        setError('У вас действует другой платный план. Смена плана обсуждается с поддержкой.');
      } else if (body?.code === 'EMAIL_NOT_VERIFIED') {
        setError('Сначала подтвердите адрес почты.');
      } else {
        setError(e instanceof Error ? e.message : 'Не удалось создать счёт');
      }
    } finally {
      setBusy(false);
    }
  }

  const box: React.CSSProperties = {
    border: '1px solid var(--border)',
    borderRadius: '12px',
    padding: '16px',
  };

  const needsKyc = status?.needsSeparateKyc ?? false;
  const kycDone = !needsKyc || (onboarding?.kycState === 'APPROVED' && onboarding.tosAccepted);
  const hostedFlow = status?.capabilities.includes('hostedCheckout') ?? false;

  return (
    <div style={{ display: 'grid', gap: '20px', maxWidth: '640px' }}>
      <h1 style={{ margin: 0 }}>Оплата плана {plan}</h1>

      {status?.sandbox ? (
        <p
          style={{
            margin: 0,
            padding: '10px 12px',
            border: '1px solid var(--danger)',
            borderRadius: '10px',
            fontSize: '14px',
          }}
        >
          <strong>Тестовый режим.</strong> Оплата идёт на песочнице провайдера: настоящие
          деньги не принимаются и не списываются. Не вводите здесь реальную карту.
        </p>
      ) : null}

      {status && !status.enabled ? (
        <p style={{ color: 'var(--muted)', margin: 0 }}>
          Оплата подписок сейчас не подключена. <Link href="/plans">Тарифы</Link>
        </p>
      ) : null}

      {error ? <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p> : null}

      {checking ? (
        <p style={{ color: 'var(--muted)', margin: 0 }}>
          Проверяем платёж у провайдера…
        </p>
      ) : null}

      {/* Шаг 1: проверка личности — только там, где она отдельная. */}
      {status?.enabled && needsKyc && !kycDone ? (
        <section style={box}>
          <h2 style={{ marginTop: 0, fontSize: '18px' }}>Проверка личности</h2>

          <p style={{ color: 'var(--muted)', fontSize: '14px', margin: '0 0 12px' }}>
            Документы принимает и хранит платёжный провайдер — мы их не видим и не храним.
            {onboarding ? ` ${KYC_TEXT[onboarding.kycState] ?? ''}` : ''}
          </p>

          {onboarding?.kycUrl && onboarding.tosUrl ? (
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <a href={onboarding.tosUrl} target="_blank" rel="noreferrer">
                {onboarding.tosAccepted ? 'Условия приняты' : 'Принять условия провайдера'}
              </a>
              <a href={onboarding.kycUrl} target="_blank" rel="noreferrer">
                Пройти проверку
              </a>
              <button onClick={loadOnboarding} disabled={busy}>
                Проверить состояние
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                placeholder="Имя и фамилия, как в документе"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                style={{ minWidth: '260px' }}
              />
              <button onClick={startKyc} disabled={busy}>
                {busy ? 'Готовим…' : 'Начать проверку'}
              </button>
            </div>
          )}
        </section>
      ) : null}

      {/* Шаг 2: создание оплаты. */}
      {status?.enabled && kycDone && !payment && !hosted ? (
        <section style={box}>
          <h2 style={{ marginTop: 0, fontSize: '18px' }}>Оплата</h2>

          <p style={{ color: 'var(--muted)', fontSize: '14px', margin: '0 0 12px' }}>
            {hostedFlow
              ? 'Оплата пройдёт на странице провайдера. Он же проверит личность — отдельного шага у нас для этого нет. Провайдер может отказать по стране проживания: это его решение.'
              : 'Мы создадим одноразовый счёт с точной суммой и уникальным сообщением перевода.'}
          </p>

          <button onClick={createPayment} disabled={busy}>
            {busy ? 'Готовим…' : hostedFlow ? 'Перейти к оплате' : 'Создать счёт'}
          </button>
        </section>
      ) : null}

      {/* Размещённая оплата: ссылка живёт считанные минуты. */}
      {hosted ? (
        <section style={box}>
          <h2 style={{ marginTop: 0, fontSize: '18px' }}>
            {hosted.priceAmount} {hosted.priceCurrency} за {hosted.termDays} суток
          </h2>

          <p style={{ fontSize: '14px', margin: '0 0 12px' }}>
            Ссылка на оплату одноразовая и действует до{' '}
            {new Date(hosted.expiresAt).toLocaleTimeString('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
            })}
            . Если не успеете — вернитесь сюда и создайте новую.
          </p>

          <a
            href={hosted.hostedUrl}
            rel="noreferrer"
            style={{ fontWeight: 600 }}
          >
            Открыть страницу оплаты
          </a>

          <p style={{ fontSize: '13px', color: 'var(--muted)', margin: '12px 0 0' }}>
            Сумму, актив и адрес получателя задаём мы. Если на странице провайдера
            изменить сумму, валюту, сеть или получателя, платёж не совпадёт с этим
            счётом — доступ не откроется, и разбираться придётся вручную.
          </p>
        </section>
      ) : null}

      {/* Состояние платежа. */}
      {payment ? (
        <section style={box}>
          <h2 style={{ marginTop: 0, fontSize: '18px' }}>
            {payment.priceAmount} {payment.priceCurrency} за {payment.termDays} суток
          </h2>

          <p style={{ margin: '0 0 12px' }}>
            <strong>{STATE_TEXT[payment.state] ?? payment.state}</strong>
          </p>

          {payment.instructions?.depositMessage && payment.state !== 'PAID' ? (
            <>
              <table style={{ width: '100%', fontSize: '14px', marginBottom: '12px' }}>
                <tbody>
                  <tr>
                    <td style={{ color: 'var(--muted)', padding: '4px 0' }}>Сумма</td>
                    <td style={{ textAlign: 'right' }}>
                      <strong>
                        {payment.sourceAmount} {payment.sourceCurrency}
                      </strong>
                    </td>
                  </tr>
                  <tr>
                    <td style={{ color: 'var(--muted)', padding: '4px 0' }}>Банк</td>
                    <td style={{ textAlign: 'right' }}>{payment.instructions.bankName ?? '—'}</td>
                  </tr>
                  <tr>
                    <td style={{ color: 'var(--muted)', padding: '4px 0' }}>Счёт</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                      {payment.instructions.accountNumber ?? '—'}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ color: 'var(--muted)', padding: '4px 0' }}>Routing</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                      {payment.instructions.routingNumber ?? '—'}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ color: 'var(--muted)', padding: '4px 0' }}>Сообщение перевода</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                      {payment.instructions.depositMessage}{' '}
                      <button
                        onClick={() => {
                          void navigator.clipboard?.writeText(
                            payment.instructions?.depositMessage ?? '',
                          );
                          setCopied(true);
                        }}
                        style={{ fontSize: '12px', padding: '2px 8px' }}
                      >
                        {copied ? 'Скопировано' : 'Копировать'}
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>

              <p style={{ fontSize: '14px', margin: '0 0 8px' }}>
                Отправьте <strong>ровно {payment.sourceAmount} {payment.sourceCurrency}</strong>{' '}
                и обязательно укажите сообщение перевода. Без него платёж не сопоставится
                с вашим счётом, и его придётся искать вручную.
              </p>

              <p style={{ fontSize: '13px', color: 'var(--muted)', margin: 0 }}>
                Провайдер конвертирует сумму в {payment.destinationCurrency} и отправит
                в сети {payment.destinationChain === 'SOLANA' ? 'Solana' : payment.destinationChain}.
                Комиссии и итоговая сумма появятся здесь после завершения. Банковский перевод
                идёт от нескольких часов до нескольких рабочих дней.
              </p>
            </>
          ) : null}

          {payment.state === 'PAID' ? (
            <div style={{ fontSize: '14px' }}>
              <p style={{ margin: '0 0 8px' }}>
                Доставлено: {payment.deliveredAmount ?? '—'} {payment.destinationCurrency}
              </p>
              {payment.destinationTxHash ? (
                <p style={{ margin: '0 0 8px', fontFamily: 'monospace', fontSize: '12px' }}>
                  {payment.destinationTxHash}
                </p>
              ) : null}
              {payment.receiptUrl ? (
                <a href={payment.receiptUrl} target="_blank" rel="noreferrer">
                  Квитанция провайдера
                </a>
              ) : null}
              <p style={{ margin: '12px 0 0' }}>
                <Link href="/portfolio">Перейти в портфель</Link>
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      <p style={{ color: 'var(--muted)', fontSize: '13px', margin: 0 }}>
        Оплата подписки — это платёж платформе. Он не пополняет ваш торговый кошелёк
        и не смешивается с ним. <Link href="/plans">Тарифы</Link>
      </p>
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<p style={{ color: 'var(--muted)' }}>Загружаем…</p>}>
      <CheckoutInner />
    </Suspense>
  );
}
