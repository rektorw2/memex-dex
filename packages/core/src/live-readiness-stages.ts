/**
 * Лестница готовности к LIVE на devnet.
 *
 * Шесть ступеней от «работает бумажный режим» до стены, за которой
 * mainnet. Ступени именованы, порядок фиксирован, и подняться на
 * следующую можно только выполнив всё, что требует она сама, и всё,
 * что требовали предыдущие.
 *
 * Зачем лестница, если есть набор флагов. Флаг отвечает на вопрос
 * «попросили ли», ступень — на вопрос «на чём мы сейчас стоим».
 * Пока состояния не было, готовность собиралась в голове читающего:
 * десяток переменных, и каждый складывал их по-своему. Так и
 * появлялось «вроде всё включено» при неподтверждённом ключе.
 *
 * Главное правило и причина, по которой это отдельный файл:
 * **ни один переход не совершается одним флагом окружения**. Каждая
 * ступень требует не меньше двух независимых условий, и хотя бы одно
 * из них — наблюдаемый факт, а не настройка: подтверждённый ключ,
 * состоявшаяся подпись, здоровая защёлка сверки. Настройку можно
 * поставить по ошибке одной строкой в панели развёртывания; факт —
 * нет.
 *
 * Отдельно про верхнюю ступень. `MAINNET_BLOCKED` — не достижение,
 * а стена: она означает «devnet пройден, дальше mainnet, и туда эта
 * лестница не ведёт». Перевод в mainnet — отдельное решение с
 * отдельным контуром, а не следующая галочка.
 */

export const LIVE_READINESS_STAGES = [
  'PAPER_READY',
  'DEVNET_SIGNING_CONFIGURED',
  'DEVNET_IDENTITY_VERIFIED',
  'DEVNET_FUNDING_RECONCILED',
  'DEVNET_SIGNATURE_PROVEN',
  'MAINNET_BLOCKED',
] as const;

export type LiveReadinessStage = (typeof LIVE_READINESS_STAGES)[number];

export interface LiveStageInput {
  // ─── Ступень 1: бумажный режим ───────────────────────────────────
  /** Агент настроен и способен принимать решения. */
  paperAgentConfigured: boolean;
  /** Режим распределения капитала выбран человеком. */
  allocationConfigured: boolean;

  // ─── Ступень 2: контур подписи собран ────────────────────────────
  /** Канонический флаг подписи включён. */
  signingEnabled: boolean;
  /** Провайдер подписи выбран и поддерживается. */
  signerProviderSupported: boolean;
  /** Полностью задан ключ: идентификатор, версия, регион. */
  signerKeyConfigured: boolean;
  /**
   * Отпечаток ключа получен от провайдера.
   *
   * Наблюдаемый факт этой ступени, и он ей необходим. Без него
   * ступень состояла бы из одних настроек — то есть поднималась бы
   * правкой конфигурации и не доказывала ничего: ключ мог быть
   * несуществующим, не того типа или недоступным по правам.
   */
  signerKeyFingerprintObserved: boolean;

  // ─── Ступень 3: ключ подтверждён ─────────────────────────────────
  /** Реестр подписантов содержит запись в состоянии REGISTERED. */
  identityRegistered: boolean;
  /** Отпечаток совпал с ожидаемым. */
  expectedKeyMatches: boolean;
  /** Узел devnet отвечает и проверен. */
  networkVerified: boolean;

  // ─── Ступень 4: сверка зачислений работает ───────────────────────
  /** Воркер сверки включён. */
  reconciliationEnabled: boolean;
  /** Защёлка не поднята. */
  safetyLatchHealthy: boolean;
  /** Схема применена целиком: планировщик миграций отвечает ready. */
  migrationsReady: boolean;

  // ─── Ступень 5: подпись состоялась ───────────────────────────────
  /** Хотя бы одна подпись прошла проверку Ed25519. */
  signatureValidated: boolean;
  /** Неоднозначных попыток нет. */
  hasAmbiguousAttempt: boolean;

  // ─── Стена ───────────────────────────────────────────────────────
  /** Сеть, как её видит конфигурация. */
  network: string;
}

export interface LiveStageRequirement {
  /** Имя условия. Наружу идёт только оно. */
  code: string;
  /** Выполнено ли. */
  met: boolean;
  /**
   * Наблюдаемый факт, а не настройка.
   *
   * Ступень, все условия которой — настройки, поднимается правкой
   * конфигурации. Ступень с фактом требует, чтобы что-то произошло.
   */
  observed: boolean;
}

export interface LiveStageVerdict {
  /** На какой ступени мы стоим сейчас. */
  stage: LiveReadinessStage;
  /** Что мешает подняться выше. Пусто на верхней ступени. */
  blockers: string[];
  /**
   * Mainnet запрошен.
   *
   * Отдельное поле, а не ступень: это не место в очереди,
   * а отказ, который не снимается прохождением ступеней.
   */
  mainnetRequested: boolean;
}

/** Требования каждой ступени. Первая — база, дальше по нарастающей. */
function requirementsOf(input: LiveStageInput): Array<{
  stage: LiveReadinessStage;
  requirements: LiveStageRequirement[];
}> {
  return [
    {
      stage: 'PAPER_READY',
      requirements: [
        { code: 'PAPER_AGENT_NOT_CONFIGURED', met: input.paperAgentConfigured, observed: true },
        { code: 'ALLOCATION_NOT_CONFIGURED', met: input.allocationConfigured, observed: true },
      ],
    },
    {
      stage: 'DEVNET_SIGNING_CONFIGURED',
      requirements: [
        { code: 'SIGNING_DISABLED', met: input.signingEnabled, observed: false },
        { code: 'PROVIDER_NOT_SUPPORTED', met: input.signerProviderSupported, observed: false },
        { code: 'SIGNER_KEY_NOT_CONFIGURED', met: input.signerKeyConfigured, observed: false },
        {
          code: 'SIGNER_KEY_NOT_OBSERVED',
          met: input.signerKeyFingerprintObserved,
          observed: true,
        },
      ],
    },
    {
      stage: 'DEVNET_IDENTITY_VERIFIED',
      requirements: [
        { code: 'IDENTITY_NOT_REGISTERED', met: input.identityRegistered, observed: true },
        { code: 'IDENTITY_MISMATCH', met: input.expectedKeyMatches, observed: true },
        { code: 'NETWORK_NOT_VERIFIED', met: input.networkVerified, observed: true },
      ],
    },
    {
      stage: 'DEVNET_FUNDING_RECONCILED',
      requirements: [
        { code: 'RECONCILIATION_DISABLED', met: input.reconciliationEnabled, observed: false },
        { code: 'SAFETY_LATCH_RAISED', met: input.safetyLatchHealthy, observed: true },
        { code: 'MIGRATIONS_NOT_READY', met: input.migrationsReady, observed: true },
      ],
    },
    {
      stage: 'DEVNET_SIGNATURE_PROVEN',
      requirements: [
        { code: 'SIGNATURE_NOT_VALIDATED', met: input.signatureValidated, observed: true },
        { code: 'AMBIGUOUS_ATTEMPT_PRESENT', met: !input.hasAmbiguousAttempt, observed: true },
      ],
    },
  ];
}

export function isMainnet(network: string): boolean {
  return network === 'mainnet' || network === 'mainnet-beta';
}

/**
 * На какой ступени стоит контур.
 *
 * Ступень определяется первой невыполненной: стоять на четвёртой,
 * не выполнив условия второй, нельзя. Это и есть запрет прыжка —
 * лестница проходится по порядку, а не выборочно.
 */
export function liveReadinessStage(input: LiveStageInput): LiveStageVerdict {
  const mainnetRequested = isMainnet(input.network);
  const ladder = requirementsOf(input);

  /*
   * Первая ступень особая: пока не работает бумажный режим,
   * говорить о готовности к LIVE нечего вовсе.
   */
  const paper = ladder[0]!;
  const paperBlockers = paper.requirements.filter((r) => !r.met).map((r) => r.code);
  if (paperBlockers.length > 0) {
    return { stage: 'PAPER_READY', blockers: paperBlockers, mainnetRequested };
  }

  let reached: LiveReadinessStage = 'PAPER_READY';
  for (const step of ladder.slice(1)) {
    const blockers = step.requirements.filter((r) => !r.met).map((r) => r.code);
    if (blockers.length > 0) return { stage: reached, blockers, mainnetRequested };
    reached = step.stage;
  }

  /*
   * Все ступени devnet пройдены. Дальше не следующая галочка,
   * а стена: mainnet этой лестницей не открывается.
   */
  return { stage: 'MAINNET_BLOCKED', blockers: [], mainnetRequested };
}

/**
 * Сколько независимых условий у каждого перехода.
 *
 * Вынесено отдельно ради проверки: правило «переход не совершается
 * одним флагом» должно быть измеримым, а не обещанным в комментарии.
 */
export function stageRequirementCounts(
  input: LiveStageInput,
): Array<{ stage: LiveReadinessStage; total: number; observed: number }> {
  return requirementsOf(input).map((step) => ({
    stage: step.stage,
    total: step.requirements.length,
    observed: step.requirements.filter((r) => r.observed).length,
  }));
}
