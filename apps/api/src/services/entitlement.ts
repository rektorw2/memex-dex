import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  entitlementFor,
  effectivePlan,
  can,
  capabilityList,
  requiredPlanFor,
  isTrialActive,
  trialRemainingSeconds,
  ALL_CAPABILITIES,
  type Entitlement,
  type Capability,
  type PlanCode,
} from '@memex/core';
import { activeSubscription } from './subscriptions.js';
import { isEmailVerified } from './email-verify.js';
import { hasServiceAccess } from './service-access.js';
import { trialOf } from './trial.js';
import { serverNow } from '../lib/clock.js';

/**
 * Какие права у того, кто прислал запрос.
 *
 * Единственное место, где на этот вопрос отвечают. Правило простое
 * и без исключений: план вычисляется из договоров пользователя,
 * найденных по идентификатору из проверенной подписи токена. Ни тело
 * запроса, ни строка запроса, ни заголовки, ни cookie в этом
 * не участвуют.
 *
 * Причина не в аккуратности. Всё, что приходит от клиента, клиент же
 * и пишет. Поле `plan` в теле запроса — не сведение о пользователе,
 * а его пожелание; принять его значит раздать платные возможности
 * всем, кто прочитал документацию к API.
 *
 * Скрытая кнопка защитой тоже не является: запрос можно отправить
 * и без неё.
 */

export interface RequestEntitlement extends Entitlement {
  /** Кто спрашивает. null — аноним. */
  userId: string | null;
  /** Действует ли пробный период прямо сейчас. */
  trialActive: boolean;
  trialStartedAt: Date | null;
  trialExpiresAt: Date | null;
  trialRemainingSeconds: number;
  /** Можно ли ещё начать пробный период. */
  canStartTrial: boolean;
  /**
   * Подтверждён ли адрес почты.
   *
   * Нужен первому сценарию: без подтверждения пробный период
   * не выдаётся, и интерфейс обязан знать это заранее, а не узнавать
   * отказом после того, как человек нажал кнопку.
   *
   * У администратора остаётся честным: служебный доступ обходит
   * этот шаг, а не притворяется, что он пройден.
   */
  emailVerified: boolean;
  /**
   * Доступ выдан ролью, а не тарифом.
   *
   * Нужен интерфейсу, чтобы не предлагать администратору купить
   * то, что у него и так есть, и не показывать ему `EXPIRED`
   * при полном наборе возможностей.
   */
  serviceAccess: boolean;
  serverTime: Date;
}

/**
 * Идентификатор пользователя из токена.
 *
 * Токен проверяется мягко: часть маршрутов открыта и анониму,
 * поэтому отсутствие или негодность токена — не ошибка, а ответ
 * «пользователь неизвестен». Важно, что проверка настоящая: подпись
 * сверяется, и подставить чужой `sub` нельзя.
 */
export async function resolveUserId(req: FastifyRequest): Promise<string | null> {
  if (req.user?.sub) return req.user.sub;

  try {
    const payload = await req.jwtVerify<{ sub: string }>();
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

/**
 * Права по запросу.
 *
 * Аноним получает `EXPIRED`: неизвестный посетитель не может иметь
 * ни оплаты, ни пробного периода, и умолчание выбрано в сторону
 * меньших прав.
 *
 * Роль читается, и это изменение относительно прежнего порядка.
 * Раньше здесь было написано, что администратор не получает прав
 * за должность; теперь получает — но не побочным эффектом роли,
 * а именованной политикой в `service-access.ts`, у которой есть
 * своё описание, свои границы и свои тесты.
 *
 * Границы такие. Обходятся тарифные правила: подписка, пробный
 * период, подтверждение почты. Не обходится ничего из защиты —
 * вход, подпись токена, ограничение частоты, подпись вебхуков,
 * идемпотентность, KMS, аудит и торговые risk-guards работают
 * как для всех.
 *
 * Роль берётся из базы, а не из токена: токен подписан нами,
 * но это снимок на момент входа, и снятая роль осталась бы в нём
 * до истечения срока. Из тела запроса роль не читается никогда.
 */
export async function entitlementOfRequest(
  req: FastifyRequest,
  now = serverNow(),
): Promise<RequestEntitlement> {
  const userId = await resolveUserId(req);

  if (!userId) {
    return {
      ...entitlementFor('EXPIRED'),
      userId: null,
      trialActive: false,
      trialStartedAt: null,
      trialExpiresAt: null,
      trialRemainingSeconds: 0,
      canStartTrial: false,
      emailVerified: false,
      serviceAccess: false,
      serverTime: now,
    };
  }

  const [sub, trial, emailVerified, serviceAccess] = await Promise.all([
    activeSubscription(userId, now),
    trialOf(userId),
    isEmailVerified(userId),
    hasServiceAccess(userId),
  ]);

  const trialState = trial
    ? { startedAt: trial.startsAt.getTime(), expiresAt: trial.expiresAt.getTime() }
    : null;

  const plan = effectivePlan(
    {
      subscription: sub
        ? {
            plan: sub.plan as Exclude<PlanCode, 'TRIAL' | 'EXPIRED'>,
            startsAt: sub.startsAt.getTime(),
            expiresAt: sub.expiresAt?.getTime() ?? null,
          }
        : null,
      trial: trialState,
    },
    now.getTime(),
  );

  /*
   * Служебный доступ подменяет только набор возможностей.
   *
   * План остаётся тем, какой есть на самом деле: у администратора
   * с оплаченным PRO так и написано PRO, а у администратора без
   * подписки — EXPIRED. Выдуманная подписка была бы записью
   * о деньгах, которых не было, и однажды попала бы в отчёт.
   *
   * Пробный период администратору не предлагается: он ему незачем,
   * и потратить единственную попытку на человека, у которого доступ
   * и так полный, значит отобрать её у него же после снятия роли.
   */
  const capabilities = serviceAccess ? ALL_CAPABILITIES : entitlementFor(plan).capabilities;

  return {
    plan,
    capabilities,
    userId,
    trialActive: isTrialActive(trialState, now.getTime()),
    trialStartedAt: trial?.startsAt ?? null,
    trialExpiresAt: trial?.expiresAt ?? null,
    trialRemainingSeconds: trialRemainingSeconds(trialState, now.getTime()),
    // Пробный период даётся один раз за всё время, а не один раз
    // одновременно. Наличие любой записи — даже давно истёкшей —
    // закрывает возможность начать заново.
    canStartTrial: serviceAccess ? false : trial == null,
    emailVerified,
    serviceAccess,
    serverTime: now,
  };
}

/** Есть ли у запроса такое право. */
export function requestCan(e: RequestEntitlement, capability: Capability): boolean {
  return can(e, capability);
}

/**
 * Отказ, из которого понятно, что делать дальше.
 *
 * Код нужного плана уходит в ответ намеренно: «нужен PRO» помогает
 * человеку, «доступ запрещён» — нет. Ни номера договора, ни сумм,
 * ни платёжных идентификаторов здесь нет: интерфейсу они не нужны,
 * а в логах и в истории браузера оседают навсегда.
 */
export interface UpgradeRequired {
  error: string;
  code: 'UPGRADE_REQUIRED';
  capability: Capability;
  requiredPlan: PlanCode | null;
  currentPlan: PlanCode;
  canStartTrial: boolean;
}

export function upgradeRequired(
  e: RequestEntitlement,
  capability: Capability,
): UpgradeRequired {
  return {
    error: 'Возможность недоступна на текущем плане',
    code: 'UPGRADE_REQUIRED',
    capability,
    requiredPlan: requiredPlanFor(capability),
    currentPlan: e.plan,
    canStartTrial: e.canStartTrial,
  };
}

/**
 * Проверка права прямо в обработчике.
 *
 * Возвращает `null`, если право есть, и готовый ответ 403, если нет.
 * Отдельная функция, а не preHandler, потому что часть маршрутов
 * меняет поведение в зависимости от права, а не отказывает целиком.
 */
export function denyIfMissing(
  e: RequestEntitlement,
  capability: Capability,
  reply: FastifyReply,
): boolean {
  if (can(e, capability)) return false;

  void reply.code(403).send(upgradeRequired(e, capability));
  return true;
}

/**
 * Что отдаётся клиенту о его доступе.
 *
 * Ни идентификаторов платежей, ни внутренних записей журнала,
 * ни чужих данных. Всё, что здесь есть, человек и так знает про себя;
 * всё, чего нет, ему знать незачем.
 */
export function accessView(e: RequestEntitlement) {
  return {
    effectivePlan: e.plan,
    status: e.serviceAccess
      ? 'service'
      : e.plan === 'EXPIRED'
        ? 'expired'
        : e.trialActive && e.plan === 'TRIAL'
          ? 'trial'
          : 'active',
    capabilities: capabilityList(e),
    trialStartedAt: e.trialStartedAt?.toISOString() ?? null,
    trialExpiresAt: e.trialExpiresAt?.toISOString() ?? null,
    trialRemainingSeconds: e.trialRemainingSeconds,
    canStartTrial: e.canStartTrial,
    emailVerified: e.emailVerified,
    serviceAccess: e.serviceAccess,
    // Администратору покупать нечего: возможности у него полные
    // независимо от того, что написано в плане.
    upgradeRequired: e.plan === 'EXPIRED' && !e.serviceAccess,
    serverTime: e.serverTime.toISOString(),
  };
}

/**
 * Заголовки кеширования.
 *
 * Ответы зависят от того, кто спрашивает, поэтому общего кеша у них
 * нет. Раздельных ячеек под задержанные и мгновенные данные больше
 * не существует — задержки не существует тоже, и данные для всех
 * планов приходят из одного и того же места.
 */
export function applyCacheHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Vary', 'Authorization');
}
