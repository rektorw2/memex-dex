import { Prisma as P } from '@prisma/client';
import {
  checkScam,
  checkSanity,
  crossCheck,
  judgeRoundTrip,
  checkAuthenticity,
  checkRwa,
  concentrationRulesApply,
  assessRisk,
  DEFAULT_RISK_CONFIG,
  type ScamSignals,
  type SourceReading,
  type Reason,
  type ChainKey,
  type RwaRegistry,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { fetchSecurityFacts } from '../services/token-intel.js';
import { fetchTokenPair, isDexScreenerSupported } from '../services/dexscreener.js';
import { fetchJupiterToken } from '../services/jupiter.js';
import {
  fetchOkxTokenDetail,
  checkRoundTrip,
  isOkxConfigured,
  isOkxSupported,
} from '../services/okx.js';
import { fetchRwaRegistry, fetchPriceInfo, safeCall } from '../services/okx-market.js';
import { fetchAdvancedInfo, readTags, readOkxRisk } from '../services/okx-security.js';
import { checkHoneypot, isHoneypotSupported } from '../services/honeypot.js';
import { checkRugcheck, isAbsoluteFinding } from '../services/rugcheck.js';
import { sharePctOrNull } from '../lib/decimal.js';

/**
 * Проверка токенов витрины на очевидные ловушки.
 *
 * Раньше этой проверки не было вовсе: импортёр считал риск по ликвидности,
 * объёму и возрасту пула, а данные о самом контракте — активный mint,
 * возможность заморозки, налог на продажу — до терминала не доходили.
 * В результате в списке оказывались токены, которые нельзя продать,
 * и отличить их от обычных было нечем.
 *
 * Источники складываются, а не заменяют друг друга:
 *
 *   GoPlus       — свойства контракта. Единственный источник, который
 *                  отвечает на вопрос «можно ли продать».
 *   DexScreener  — счётчики покупок и продаж. Ловит ханипоты, которые
 *                  проверка контракта пропустила: продать формально
 *                  можно, но за сутки никто не смог.
 *   OKX Web3     — независимое подтверждение цены и ликвидности,
 *                  если ключи настроены.
 *
 * Ни один источник не считается истиной сам по себе. Отсутствие данных
 * трактуется как «не проверено», а не как «всё чисто» — иначе токен,
 * который не удалось проверить, выглядел бы надёжнее проверенного
 * и найденного плохим.
 */

const TICK_MS = 45_000;
/**
 * Токенов за проход. Ограничитель — GoPlus: у него порядка 30 запросов
 * в минуту без ключа, и делить его больше не с кем.
 */
const BATCH = 8;
/** Перепроверка не чаще раза в сутки: свойства контракта меняются редко. */
const RECHECK_HOURS = 24;

/**
 * Версия набора правил.
 *
 * Увеличивается при каждом изменении логики проверки. Токены, у которых
 * записана меньшая версия, перепроверяются вне очереди, независимо
 * от времени последней проверки.
 *
 * Без этого механизма новое правило не действовало на уже проверенные
 * токены целые сутки: у них стояла свежая отметка времени, и очередь
 * до них не доходила. Подделки под NVDA так и остались в витрине после
 * добавления проверки, которая их ловит.
 *
 * История версий:
 *   1 — контракт (GoPlus), счётчики сделок, поведение пула
 *   2 — подделки под известные тикеры, клоны, правдоподобность чисел
 *   3 — сверка источников между собой, замер выхода через агрегатор
 *   4 — веса пересчитаны под мем-коины, а не под голубые фишки
 *   5 — OKX advanced-info, реестр подтверждённых RWA, Honeypot.is,
 *       RugCheck; подделки под биржевые тикеры отделены от подделок
 *       под криптоактивы
 *   6 — метка danger от RugCheck больше не блокирует сама по себе.
 *       Версия 5 заблокировала 137 токенов из 173: на мем-коинах
 *       RugCheck помечает уровнем danger активную эмиссию и высокую
 *       концентрацию, то есть норму этого рынка.
 *   7 — устранён круг в сверке источников: сохранённое значение
 *       больше не участвует в сравнении. Версия 6 сверяла свежие
 *       котировки с ценой, которую сама же и записала в базу,
 *       и разницу объявляла подделкой — 106 блокировок из 132.
 *       Заодно метка isSus от Jupiter понижена с приговора
 *       до тяжёлого замечания по той же причине, что и danger.
 *   8 — JUPITER_SUSPICIOUS убран из критических кодов. В версии 7
 *       ему понизили вес, но оставили в CRITICAL_CODES, где вес
 *       не значит ничего: правка выглядела осмысленной и не делала
 *       ничего. Метка стояла у 54% заблокированных.
 */
export const RULES_VERSION = 8;

let timer: NodeJS.Timeout | null = null;
let running = false;

export interface CheckResult {
  checked: number;
  blocked: number;
  warned: number;
  ok: number;
  /** Проход остановлен по времени, а не потому что кончились токены. */
  timedOut?: boolean;
  /** Сколько токенов из выборки остались неразобранными. */
  remaining?: number;
}

/**
 * Предел времени на один проход.
 *
 * Появился после того, как проверка одного токена выросла до семи
 * обращений к внешним источникам: GoPlus, DexScreener, OKX detail,
 * advanced-info, Honeypot.is, RugCheck и замер круга. Шестьдесят
 * токенов при таком наборе — это минуты, а вызов из админки при этом
 * просто висит без единого признака жизни.
 *
 * Ограничение по времени честнее ограничения по количеству: сколько
 * токенов успеет разобраться, зависит от того, как отвечают источники
 * сегодня, и угадать это числом заранее нельзя. Незаконченную работу
 * подхватит следующий проход — очередь и так устроена так, что
 * прерывание её не портит.
 */
const DEFAULT_BUDGET_MS = 20_000;

export interface CheckOptions {
  /** Сколько времени отвести проходу. */
  budgetMs?: number;
}

export async function checkBatch(
  limit = BATCH,
  opts: CheckOptions = {},
): Promise<CheckResult> {
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const stale = new Date(Date.now() - RECHECK_HOURS * 3_600_000);

  const tokens = await prisma.token.findMany({
    where: {
      isQuote: false,
      isHidden: false,
      OR: [
        { scamCheckedAt: null },
        // Устаревшие правила важнее устаревшего времени: токен, проверенный
        // час назад по прежним правилам, опаснее проверенного вчера
        // по нынешним.
        { scamRulesVersion: { lt: RULES_VERSION } },
        { scamCheckedAt: { lt: stale } },
      ],
    },
    orderBy: [
      { scamRulesVersion: 'asc' },
      { scamCheckedAt: { sort: 'asc', nulls: 'first' } },
      { volume24hUsd: 'desc' },
    ],
    take: limit,
  });

  if (tokens.length === 0) return { checked: 0, blocked: 0, warned: 0, ok: 0 };

  const result: CheckResult = { checked: 0, blocked: 0, warned: 0, ok: 0 };

  // Одноимённые токены считаются одним запросом на всю пачку: три NVDA
  // с разными адресами — это не совпадение, а рассылка шаблона, и увидеть
  // её можно только глядя на витрину целиком, а не на токен по отдельности.
  const clones = await countClones(tokens.map((t) => t.symbol));

  // Реестр подтверждённых токенизированных акций берётся один раз
  // на всю пачку и живёт в кеше часами: он меняется несколько раз
  // в месяц, а нужен при проверке каждого токена.
  const rwaRegistry = await fetchRwaRegistry();

  for (const [index, token] of tokens.entries()) {
    // Проверка времени до начала работы над токеном, а не после:
    // прерывать на середине незачем, а начинать восьмой токен,
    // когда бюджет уже вышел, — тем более.
    if (Date.now() > deadline) {
      result.timedOut = true;
      result.remaining = tokens.length - index;
      logger.info(
        { checked: result.checked, remaining: result.remaining },
        'проверка витрины: проход остановлен по времени',
      );
      break;
    }

    try {
      const chain = token.chain as ChainKey;

      const [security, pair, okx, advanced, honeypot, rug] = await Promise.all([
        fetchSecurityFacts(token.chain, token.address).catch(() => null),
        isDexScreenerSupported(token.chain)
          ? fetchTokenPair(token.chain, token.address).catch(() => null)
          : Promise.resolve(null),
        isOkxConfigured() && isOkxSupported(token.chain)
          ? fetchOkxTokenDetail(token.chain, token.address).catch(() => null)
          : Promise.resolve(null),
        // Расширенные сведения: доли insider/bundle/sniper, история
        // создателя, теги. Плановая проверка — как раз тот случай,
        // ради которого этот запрос и делается выборочно.
        isOkxConfigured() && isOkxSupported(chain)
          ? fetchAdvancedInfo(chain, token.address, safeCall).catch(() => null)
          : Promise.resolve(null),
        // Симуляция продажи. Единственная проверка, которая не спрашивает
        // мнения, а пробует продать.
        isHoneypotSupported(chain)
          ? checkHoneypot(chain, token.address).catch(() => null)
          : Promise.resolve(null),
        chain === 'SOLANA' ? checkRugcheck(token.address).catch(() => null) : Promise.resolve(null),
      ]);

      const tagReading = advanced ? readTags(advanced.tags) : null;
      const okxRisk = readOkxRisk(advanced?.riskControlLevel ?? null);

      const poolAgeHours = pair?.pairCreatedAt
        ? (Date.now() - pair.pairCreatedAt.getTime()) / 3_600_000
        : null;

      // ─── Сверка источников ────────────────────────────────────────
      // Раньше здесь брался максимум из известных значений, и это было
      // ошибкой: достаточно одному источнику ошибиться в большую
      // сторону, чтобы завышенное число прошло дальше. Ровно так
      // в витрину попал токен с ликвидностью в три с половиной
      // миллиарда долларов на Base.
      //
      // Теперь источники проверяют друг друга. У настоящего токена они
      // видят один пул и сообщают близкие числа; расхождение в разы
      // означает, что как минимум один читает подделку.
      const readings: SourceReading[] = [
        {
          // Сохранённое значение, а не источник. Пометка live: false
          // выводит его из сверки: в базу эту цену пишет эта же
          // проверка, и сравнение с ней означало бы сверку с самой
          // собой. Ровно так правило расхождения цен заблокировало
          // 106 токенов из 132 — оно измеряло не согласие источников,
          // а время, прошедшее с прошлого прохода.
          source: 'сохранённое значение',
          live: false,
          priceUsd: token.priceUsd != null ? Number(token.priceUsd) : null,
          liquidityUsd: token.liquidityUsd != null ? Number(token.liquidityUsd) : null,
          volume24hUsd: token.volume24hUsd != null ? Number(token.volume24hUsd) : null,
        },
      ];

      if (isDexScreenerSupported(token.chain)) {
        readings.push({
          source: 'DexScreener',
          live: true,
          priceUsd: pair?.priceUsd ?? null,
          liquidityUsd: pair?.liquidityUsd ?? null,
          volume24hUsd: pair?.volume24hUsd ?? null,
        });
      }

      if (isOkxConfigured() && isOkxSupported(token.chain)) {
        readings.push({
          source: 'OKX',
          live: true,
          priceUsd: okx?.priceUsd ?? null,
          liquidityUsd: okx?.liquidityUsd ?? null,
          volume24hUsd: okx?.volume24hUsd ?? null,
        });
      }

      const cross = crossCheck(readings, { poolAgeHours });

      // Дальше в расчёт идут согласованные значения — медиана,
      // а не максимум.
      const liquidityUsd = cross.agreed.liquidityUsd;
      const volume24hUsd = cross.agreed.volume24hUsd;

      // Сигналы собираются для наглядности и журнала; решение
      // принимается по кодам причин ниже.
      const signals: ScamSignals = {
        isHoneypot: security?.isHoneypot ?? null,
        mintable: security?.mintable ?? null,
        freezable: security?.freezable ?? null,
        ownerCanModify: security?.ownerCanModify ?? null,
        buyTaxPct: security?.buyTaxPct ?? null,
        sellTaxPct: security?.sellTaxPct ?? null,
        lpLocked: security?.lpLocked ?? null,
        top10Pct: security?.top10Pct ?? null,
        creatorPct: security?.creatorPct ?? null,
        holderCount: security?.holderCount ?? null,
        liquidityUsd,
        volume24hUsd,
        buys24h: pair?.buys24h ?? null,
        sells24h: pair?.sells24h ?? null,
        poolAgeHours,
        // Проверенным считается только тот случай, когда источник
        // действительно ответил хоть по одному свойству контракта.
        securityChecked: Boolean(security?.source),
      };


      // ─── Подделки и клоны ─────────────────────────────────────────
      // Проверка контракта этот класс не ловит вовсе: у токена может
      // быть всё в порядке с эмиссией и налогами, и при этом он
      // называется NVDA и выдаёт себя за акцию NVIDIA.
      const clone = clones.get(token.symbol.toUpperCase()) ?? {
        count: 1,
        maxLiquidity: null,
      };

      // Подлинность определяется совпадением адреса, а не тикером.
      // Прежняя проверка блокировала любой токен с символом NVDA,
      // включая настоящий, если бы он появился.
      const auth = checkAuthenticity(chain, token.address, token.symbol);

      // Подделки под биржевые бумаги проверяются отдельно от подделок
      // под криптоактивы. Для USDC вопрос решается статическим реестром:
      // настоящий один и он известен. Для NVDA — только списком
      // эмитента, потому что настоящий токенизированный NVDA существует
      // и блокировать его вместе с подделками было бы худшим исходом
      // из возможных.
      const rwa = checkRwa(
        {
          chain,
          address: token.address,
          symbol: token.symbol,
          tags: advanced?.tags,
          communityRecognized: tagReading?.communityRecognized,
        },
        rwaRegistry,
      );

      // Jupiter знает про Solana то, чего не знает никто: собственные
      // метки banned и isSus по итогам их аудита.
      const jup =
        token.chain === 'SOLANA'
          ? await fetchJupiterToken(token.address).catch(() => null)
          : null;

      const sanity = checkSanity({
        liquidityUsd,
        volume24hUsd,
        fdvUsd: token.fdvUsd != null ? Number(token.fdvUsd) : null,
        priceChange24h: token.priceChange24h != null ? Number(token.priceChange24h) : null,
      });

      // ─── Сбор причин с кодами ─────────────────────────────────────
      const reasons: Reason[] = [];
      const cfg = DEFAULT_RISK_CONFIG;

      if (auth.isImpersonation) {
        reasons.push({ code: 'FAKE_SYMBOL', message: auth.reason!, weight: 100 });
      }

      // Подделка под биржевую бумагу. Блокируется полностью: человек,
      // покупающий «NVDA», рассчитывает на долю в NVIDIA, а не на мем-коин
      // с тем же тикером, и никакое предупреждение этого не исправит.
      if (rwa.isFakeRwa) {
        reasons.push({ code: 'FAKE_RWA_TICKER', message: rwa.reason!, weight: 100 });
      }

      // Претендует на бумагу, но списка подтверждённых у нас нет.
      // Не блокируем — мы не проверили, а не нашли нарушение. Но и
      // в безопасные такой токен не пустим: вес держит его вне
      // строгого режима.
      if (rwa.isUndetermined) {
        reasons.push({ code: 'UNVERIFIED_RWA_CLAIM', message: rwa.reason!, weight: 40 });
      }

      // ─── Приговор OKX ─────────────────────────────────────────────
      // Первый уровень отсева, но не единственный. Уровень 3 и выше —
      // полное скрытие; уровень 2 — повод для осторожности, а не
      // приговор; ноль не означает ничего.
      if (okxRisk.hardBlock) {
        reasons.push({ code: 'OKX_HIGH_RISK', message: okxRisk.explanation, weight: 100 });
      } else if (okxRisk.band === 'caution') {
        reasons.push({ code: 'OKX_CAUTION', message: okxRisk.explanation, weight: 20 });
      }

      if (tagReading?.isHoneypot) {
        reasons.push({
          code: 'HONEYPOT',
          message: 'OKX пометил контракт как ловушку',
          weight: 100,
        });
      }

      // ─── Симуляция продажи ────────────────────────────────────────
      // Самое весомое свидетельство из имеющихся: не мнение о коде,
      // а результат попытки продать.
      if (honeypot?.isHoneypot) {
        reasons.push({
          code: 'HONEYPOT',
          message: honeypot.reason
            ? `Симуляция продажи: ${honeypot.reason}`
            : 'Симуляция показала, что продать токен нельзя',
          weight: 100,
        });
      }
      if (honeypot?.sellFailed) {
        reasons.push({
          code: 'SELL_FAILED',
          message: 'Симуляция продажи не прошла',
          weight: 100,
        });
      }
      if (honeypot?.sellTaxPct != null && honeypot.sellTaxPct >= cfg.maxSellTaxPct) {
        reasons.push({
          code: 'HIGH_SELL_TAX',
          message: `Симуляция: налог на продажу ${honeypot.sellTaxPct.toFixed(0)}%`,
          weight: 100,
        });
      }

      // RugCheck на Solana играет роль, которую на EVM играет симуляция.
      //
      // Блокирует только невозможность выйти из позиции. Их метка
      // danger стоит и на активной эмиссии, и на концентрации
      // у топ-10 — на мем-коинах это норма, и принимать её
      // за приговор значит заблокировать почти всю сеть.
      if (rug?.hasCritical) {
        const worst = rug.risks.find((r) => isAbsoluteFinding(r.name));
        reasons.push({
          code: 'RUGCHECK_CRITICAL',
          message: worst?.description
            ? `RugCheck: ${worst.description}`
            : `RugCheck: ${worst?.name ?? 'выход из позиции невозможен'}`,
          weight: 100,
        });
      } else if (rug && rug.dangerCount > 0) {
        // Прочие находки уровня danger — повод для осторожности,
        // взвешенный нашей мерой, а не их.
        reasons.push({
          code: 'OKX_CAUTION',
          message: `RugCheck отметил ${rug.dangerCount} проблем(ы): ${rug.risks
            .filter((r) => r.level === 'danger')
            .map((r) => r.name)
            .slice(0, 3)
            .join(', ')}`,
          weight: Math.min(30, rug.dangerCount * 10),
        });
      }

      // История создателя — самый предсказуемый признак из известных.
      // Человек, бросивший три токена, бросит и четвёртый.
      if (advanced?.devRugPullTokenCount != null && advanced.devRugPullTokenCount > 0) {
        const total = advanced.devCreateTokenCount;
        reasons.push({
          code: 'DEV_RUG_HISTORY',
          message:
            `У создателя ${advanced.devRugPullTokenCount} брошенных токенов` +
            (total ? ` из ${total} выпущенных` : ''),
          // Один брошенный токен может быть неудачей, три и больше —
          // это уже способ работы.
          weight: advanced.devRugPullTokenCount >= 3 ? 100 : 45,
        });
      }

      if (jup?.isBanned) {
        reasons.push({
          code: 'JUPITER_BANNED',
          message: 'Jupiter исключил токен из реестра',
          weight: 100,
        });
      }
      if (jup?.isSuspicious) {
        reasons.push({
          code: 'JUPITER_SUSPICIOUS',
          message: 'Аудит Jupiter пометил токен как подозрительный',
          // Не приговор, а тяжёлое замечание. Ошибка та же, что была
          // с меткой danger у RugCheck: чужая осторожность принималась
          // за установленный факт. Метка стояла у 47% заблокированных —
          // столько подтверждённого мошенничества не бывает, значит
          // метка означает «есть к чему придраться», а не «мошенник».
          //
          // Веса хватает, чтобы токен не попал в строгий режим,
          // но не хватает, чтобы исчезнуть совсем.
          weight: 45,
        });
      }

      if (security?.isHoneypot === true) {
        reasons.push({
          code: 'HONEYPOT',
          message: 'Продажа заблокирована контрактом',
          weight: 100,
        });
      }
      if (security?.sellTaxPct != null && security.sellTaxPct >= cfg.maxSellTaxPct) {
        reasons.push({
          code: 'HIGH_SELL_TAX',
          message: `Налог на продажу ${security.sellTaxPct.toFixed(0)}%`,
          weight: 100,
        });
      }
      if (security?.freezable === true) {
        reasons.push({
          code: 'FREEZE_AUTHORITY_ACTIVE',
          message: 'Токен можно заморозить на вашем кошельке',
          weight: 100,
        });
      }
      if (security?.creatorPct != null && security.creatorPct > cfg.maxCreatorPct) {
        reasons.push({
          code: 'CREATOR_CONTROLS_SUPPLY',
          message: `У создателя ${security.creatorPct.toFixed(0)}% предложения`,
          weight: 100,
        });
      }
      // Ноль — это не «неизвестно», а «пул пуст». Прежнее условие
      // требовало liq > 0 и потому пропускало именно тот случай,
      // ради которого правило писалось: осушенный пул с ликвидностью
      // в районе нуля не срабатывал вовсе, и токен оставался в ленте
      // с оборотом в сотни тысяч при пустом пуле.
      //
      // Неизвестность по-прежнему отсеивается проверкой на null.
      if (liquidityUsd != null && liquidityUsd < cfg.minLiquidityUsd) {
        reasons.push({
          code: 'LOW_LIQUIDITY',
          message: `Ликвидность $${Math.round(liquidityUsd).toLocaleString('ru-RU')} — выйти без обвала нельзя`,
          weight: 100,
        });
      }
      for (const s of sanity) {
        reasons.push({ code: 'IMPLAUSIBLE_METRICS', message: s, weight: 100 });
      }
      for (const b of cross.blockers) {
        reasons.push({ code: 'SOURCE_PRICE_MISMATCH', message: b, weight: 100 });
      }

      // ─── Повышающие риск ──────────────────────────────────────────
      if (security?.mintable === true || jup?.mintAuthorityActive === true) {
        reasons.push({
          code: 'MINT_AUTHORITY_ACTIVE',
          message: 'Эмиссию можно допечатать',
          // Серьёзно, но само по себе не должно прятать токен:
          // у части живых мем-коинов эмиссия не отозвана, и в паре
          // с чем-то ещё это уже средний риск.
          weight: 25,
        });
      }
      if (security?.lpLocked === false) {
        reasons.push({
          code: 'UNLOCKED_LIQUIDITY',
          message: 'Ликвидность не залочена',
          // Настоящий риск, но на этом рынке повсеместный. Вес такой,
          // чтобы он не перевешивал в одиночку.
          weight: 15,
        });
      }
      if (security?.ownerCanModify === true) {
        reasons.push({
          code: 'OWNER_CAN_MODIFY',
          message: 'Владелец может менять правила контракта',
          weight: 15,
        });
      }
      if (
        security?.sellTaxPct != null &&
        security.sellTaxPct > cfg.elevatedSellTaxPct &&
        security.sellTaxPct < cfg.maxSellTaxPct
      ) {
        reasons.push({
          code: 'ELEVATED_SELL_TAX',
          message: `Налог на продажу ${security.sellTaxPct.toFixed(0)}%`,
          weight: 10,
        });
      }

      // ─── Распределение владения ───────────────────────────────────
      //
      // К подтверждённому токенизированному активу эти правила
      // не применяются вовсе. У настоящего Ondo или xStocks эмитент
      // держит основную часть выпуска — это обеспечение бумаги,
      // а не подготовка к обвалу. Применять к нему мерки мем-коина
      // значит прятать именно то, что надёжнее всего в списке.
      if (concentrationRulesApply(rwa)) {
        const top10 = advanced?.top10HoldPct ?? jup?.topHoldersPct ?? security?.top10Pct ?? null;
        if (top10 != null && top10 > cfg.highConcentrationPct) {
          reasons.push({
            code: 'HIGH_TOP10_CONCENTRATION',
            message: `У топ-10 держателей ${top10.toFixed(0)}% предложения`,
            // Половина предложения у топ-10 — для мем-коина обычное дело:
            // пул и команда почти всегда там. Тревожно становится за 85%,
            // где одна продажа обваливает всё.
            weight: top10 > cfg.criticalConcentrationPct ? 25 : 10,
          });
        }

        // Доля разработчика — отдельно от топ-10, потому что это
        // один человек с одним решением, а не десять с разными.
        if (advanced?.devHoldingPct != null && advanced.devHoldingPct > cfg.maxCreatorPct) {
          reasons.push({
            code: 'HIGH_DEV_HOLDING',
            message: `У создателя ${advanced.devHoldingPct.toFixed(0)}% предложения`,
            weight: advanced.devHoldingPct > 40 ? 100 : 35,
          });
        }

        // Bundle-кошельки: закупка пачкой адресов в одной транзакции.
        // Признак того, что «держатели» — один человек, и распределение
        // нарисовано.
        if (advanced?.bundleHoldingPct != null && advanced.bundleHoldingPct > 25) {
          reasons.push({
            code: 'HIGH_BUNDLE_HOLDING',
            message: `Связанные кошельки держат ${advanced.bundleHoldingPct.toFixed(0)}% предложения`,
            weight: advanced.bundleHoldingPct > 50 ? 100 : 35,
          });
        }

        if (advanced?.suspiciousHoldingPct != null && advanced.suspiciousHoldingPct > 20) {
          reasons.push({
            code: 'SUSPICIOUS_HOLDERS',
            message: `Подозрительные адреса держат ${advanced.suspiciousHoldingPct.toFixed(0)}%`,
            weight: advanced.suspiciousHoldingPct > 50 ? 100 : 30,
          });
        }

        // Снайперы — те, кто вошёл в первом блоке. Их доля говорит
        // о том, сколько предложения окажется на продаже при первом
        // же росте.
        if (advanced?.sniperHoldingPct != null && advanced.sniperHoldingPct > 30) {
          reasons.push({
            code: 'HIGH_SNIPER_HOLDING',
            message: `Вошедшие в первом блоке держат ${advanced.sniperHoldingPct.toFixed(0)}%`,
            weight: 20,
          });
        }
      }

      // Выход разработчика — событие, а не свойство. Полный выход
      // весомее частичного: продавший всё больше не заинтересован
      // в проекте ничем.
      if (tagReading?.devSoldAll) {
        reasons.push({
          code: 'DEV_SOLD_HOLDINGS',
          message: 'Создатель продал всю свою долю',
          weight: 40,
        });
      } else if (tagReading?.devSold) {
        reasons.push({
          code: 'DEV_SOLD_HOLDINGS',
          message: 'Создатель продал часть своей доли',
          weight: 15,
        });
      }

      const holders = jup?.holderCount ?? security?.holderCount ?? null;
      if (holders != null && holders < cfg.minHolders) {
        reasons.push({
          code: 'FEW_HOLDERS',
          message: `Держателей всего ${holders}`,
          weight: 10,
        });
      }

      if (
        volume24hUsd != null &&
        liquidityUsd != null &&
        liquidityUsd > 0 &&
        volume24hUsd / liquidityUsd > cfg.maxVolumeToLiquidity
      ) {
        reasons.push({
          code: 'SUSPICIOUS_VOLUME',
          message: `Оборот в ${Math.round(volume24hUsd / liquidityUsd)} раз выше ликвидности`,
          weight: 20,
        });
      }

      const buys = pair?.buys24h ?? null;
      const sells = pair?.sells24h ?? null;
      if (buys != null && sells != null && buys + sells >= cfg.minTradesForRatio) {
        if (sells === 0 || buys / sells > cfg.maxBuySellRatio) {
          reasons.push({
            code: 'ONE_SIDED_TRADING',
            message:
              sells === 0
                ? `${buys} покупок и ни одной продажи за сутки`
                : `Покупок в ${(buys / sells).toFixed(0)} раз больше, чем продаж`,
            weight: sells === 0 ? 35 : 25,
          });
        }
      }

      if (poolAgeHours != null && poolAgeHours < cfg.youngPoolHours) {
        reasons.push({
          code: 'YOUNG_POOL',
          message: `Пулу ${poolAgeHours.toFixed(1)} ч — история не сложилась`,
          // Молодость пула — свойство, а не порок: на вкладке «Новые»
          // такие токены и ищут.
          weight: 5,
        });
      }

      if (clone.count > 1) {
        const minor =
          liquidityUsd != null &&
          clone.maxLiquidity != null &&
          liquidityUsd * 10 < clone.maxLiquidity;

        reasons.push({
          code: minor ? 'MINOR_CLONE' : 'DUPLICATE_SYMBOL',
          message: minor
            ? `Ещё ${clone.count - 1} токен(ов) с этим тикером, и этот не крупнейший`
            : `Токенов с тикером ${token.symbol}: ${clone.count}`,
          weight: minor ? 30 : 10,
        });
      }

      for (const w of cross.warnings) {
        reasons.push({ code: 'SINGLE_SOURCE', message: w, weight: 10 });
      }

      if (!security?.source) {
        reasons.push({
          code: 'SECURITY_DATA_UNAVAILABLE',
          message: 'Проверка контракта недоступна',
          // Вес нулевой намеренно: отсутствие проверки уже переводит
          // токен в pending отдельной веткой. Добавлять за это ещё
          // и баллы значит наказывать дважды за одно и то же — токен
          // получал high вместо честного «не проверен».
          weight: 0,
        });
      }



      // ─── Замер выхода через агрегатор OKX ──────────────────────────
      //
      // Самая сильная проверка и самая дорогая: два запроса на токен.
      // Применяется только к тем, у кого нет критических причин —
      // тратить лимит на уже заблокированный токен незачем.
      let roundTrip: ReturnType<typeof judgeRoundTrip> | null = null;
      const hasCriticalSoFar = reasons.some((r) => r.weight >= 100);

      if (!hasCriticalSoFar && isOkxConfigured() && isOkxSupported(token.chain)) {
        const rt = await checkRoundTrip(token.chain, token.address).catch(() => null);

        if (rt) {
          roundTrip = judgeRoundTrip(rt);

          if (roundTrip.verdict === 'BLOCK') {
            reasons.push({
              code: rt.canSell ? 'CANNOT_SELL_ALL' : 'SELL_FAILED',
              message: roundTrip.reason,
              weight: 100,
            });
          } else if (roundTrip.verdict === 'WARN') {
            reasons.push({
              code: 'COSTLY_ROUND_TRIP',
              message: roundTrip.reason,
              weight: 20,
            });
          }
        }
      }

      // ─── Итоговый уровень ─────────────────────────────────────────
      //
      // Проверенным считается токен, о котором хоть один источник
      // безопасности действительно высказался. Список источников
      // расширился, и это меняет дело: раньше токен без ответа GoPlus
      // висел в pending, даже если симуляция продажи прошла успешно.
      const securityChecked =
        Boolean(security?.source) ||
        Boolean(jup) ||
        Boolean(advanced) ||
        Boolean(honeypot?.simulated) ||
        Boolean(rug);

      // Подтверждённым активом считается и токен из нашего реестра,
      // и подтверждённая токенизированная бумага. Признание сообществом
      // по версии OKX сюда не входит: это репутация, а не проверяемый
      // факт о контракте, и приравнивать её к записи в реестре нельзя.
      const risk = assessRisk({
        reasons,
        securityChecked,
        isVerifiedAsset: auth.isVerified || rwa.isGenuineRwa,
      });

      // Совместимость со старым полем: часть запросов ещё смотрит
      // на scamVerdict, и оставлять его рассогласованным нельзя.
      const legacyVerdict =
        risk.level === 'blocked' ? 'BLOCK' : risk.level === 'verified' || risk.level === 'low' ? 'OK' : 'WARN';

      await prisma.token.update({
        where: { id: token.id },
        data: {
          riskLevel: risk.level,
          riskCodes: risk.codes,
          isRegistered: auth.isVerified,
          scamVerdict: legacyVerdict,
          scamReasons: {
            level: risk.level,
            score: risk.score,
            reasons: risk.reasons.map((r) => ({ code: r.code, message: r.message })),
            // Старые поля оставлены: интерфейс переходит на новые
            // постепенно, и ломать его одним махом незачем.
            blockers: risk.reasons.filter((r) => r.weight >= 100).map((r) => r.message),
            warnings: risk.reasons.filter((r) => r.weight < 100).map((r) => r.message),
            sources: {
              goplus: Boolean(security?.source),
              dexscreener: Boolean(pair),
              okx: Boolean(okx) || Boolean(advanced),
              jupiter: Boolean(jup),
              honeypotIs: Boolean(honeypot?.simulated),
              rugcheck: Boolean(rug),
              // Мнение OKX сохраняется отдельно от нашего вывода:
              // человеку полезно видеть, совпали они или разошлись.
              okxRiskLevel: okxRisk.level,
              okxTags: advanced?.tags ?? [],
              // Признаки внимания рынка. Показываются, но в оценку
              // не входят: оплаченное продвижение говорит о бюджете,
              // а не о свойствах контракта.
              attention: tagReading?.attention ?? [],
              rwa: rwa.isGenuineRwa
                ? { genuine: true, issuer: rwa.entry?.issuer ?? null }
                : rwa.isFakeRwa
                  ? { genuine: false, fake: true }
                  : null,
              sellSimulation: honeypot
                ? {
                    ran: honeypot.simulated,
                    isHoneypot: honeypot.isHoneypot,
                    sellTaxPct: honeypot.sellTaxPct,
                  }
                : null,
              lpBurnedPct: advanced?.lpBurnedPct ?? null,
              top10HoldPct:
                advanced?.top10HoldPct ?? jup?.topHoldersPct ?? security?.top10Pct ?? null,
              devHoldingPct: advanced?.devHoldingPct ?? null,
              bundleHoldingPct: advanced?.bundleHoldingPct ?? null,
              suspiciousHoldingPct: advanced?.suspiciousHoldingPct ?? null,
              creatorAddress: advanced?.creatorAddress ?? null,
              devRugPullCount: advanced?.devRugPullTokenCount ?? null,
              tokenCreatedAt: advanced?.createdAt ?? null,
              // Согласие источников — часть объяснения вердикта:
              // «цена подтверждена тремя» и «известен одному» это
              // разные основания доверять числу.
              known: cross.known,
              queried: cross.queried,
              priceSpread: cross.priceSpread,
              // Измеренная стоимость выхода — самое конкретное, что
              // мы знаем о токене, и её стоит хранить отдельно.
              roundTrip: roundTrip
                ? { verdict: roundTrip.verdict, lossPct: roundTrip.lossPct }
                : null,
            },
          } as unknown as P.InputJsonValue,
          scamCheckedAt: new Date(),
          scamRulesVersion: RULES_VERSION,
          riskScore: risk.score,

          buys24h: pair?.buys24h ?? null,
          sells24h: pair?.sells24h ?? null,

          // Данные, которых у GeckoTerminal нет или они хуже.
          ...(security?.isHoneypot != null ? { isHoneypot: security.isHoneypot } : {}),
          ...(security?.holderCount != null ? { holders: security.holderCount } : {}),
          // Доля вне диапазона 0-100 отбрасывается: 10 000
          // в колонке процентов было бы прочитано как достоверное
          // число, а это ошибка единиц измерения у провайдера.
          ...(sharePctOrNull(security?.top10Pct) != null
            ? { topHolderPct: new P.Decimal(sharePctOrNull(security?.top10Pct)!) }
            : {}),
          // Логотип не перезаписываем, если он уже есть: админ мог
          // поставить свой.
          ...(pair?.logoUrl && !token.logoUrl ? { logoUrl: pair.logoUrl } : {}),
          ...(pair && (pair.websites.length > 0 || pair.socials.length > 0)
            ? {
                socials: {
                  websites: pair.websites,
                  socials: pair.socials,
                } as unknown as P.InputJsonValue,
              }
            : {}),
          // В базу идут согласованные значения: показывать в терминале
          // число, которое подтвердил один источник из трёх, значит
          // выдавать догадку за факт.
          ...(cross.agreed.priceUsd != null
            ? { priceUsd: new P.Decimal(cross.agreed.priceUsd) }
            : {}),
          ...(liquidityUsd != null ? { liquidityUsd: new P.Decimal(liquidityUsd) } : {}),
          ...(volume24hUsd != null ? { volume24hUsd: new P.Decimal(volume24hUsd) } : {}),
        },
      });

      result.checked++;
      if (risk.level === 'blocked') result.blocked++;
      else if (risk.level === 'verified' || risk.level === 'low') result.ok++;
      else result.warned++;

      if (risk.level === 'blocked') {
        logger.info(
          {
            symbol: token.symbol,
            chain: token.chain,
            codes: risk.codes,
            reason: risk.reasons[0]?.message,
          },
          'токен заблокирован в витрине',
        );
      }
    } catch (e: any) {
      // Сбой на одном токене не должен останавливать проход: следующий
      // может быть как раз тем, который надо заблокировать.
      logger.warn({ err: e?.message, symbol: token.symbol }, 'проверка токена не удалась');

      // Отметку времени ставим всё равно, иначе токен, который стабильно
      // роняет проверку, будет вечно занимать место в очереди.
      // Версию не проставляем: токен, который уронил проверку, должен
      // попасть в неё снова при следующем изменении правил, а не считаться
      // разобранным.
      await prisma.token
        .update({ where: { id: token.id }, data: { scamCheckedAt: new Date() } })
        .catch(() => undefined);
    }
  }

  if (result.blocked > 0 || result.warned > 0) {
    logger.info(result, 'проверка витрины: проход завершён');
  }

  return result;
}

/**
 * Число одноимённых токенов и наибольшая ликвидность среди них.
 *
 * Считается по всей витрине, а не по проверяемой пачке: клон мог быть
 * заведён неделю назад и в текущую пачку не попасть, а сравнивать
 * нужно именно с ним.
 */
async function countClones(
  symbols: string[],
): Promise<Map<string, { count: number; maxLiquidity: number | null }>> {
  const out = new Map<string, { count: number; maxLiquidity: number | null }>();
  if (symbols.length === 0) return out;

  const unique = [...new Set(symbols.map((s) => s.toUpperCase()))];

  const rows = await prisma.token.findMany({
    where: {
      isQuote: false,
      isHidden: false,
      symbol: { in: unique, mode: 'insensitive' },
    },
    select: { symbol: true, liquidityUsd: true },
  });

  for (const r of rows) {
    const key = r.symbol.toUpperCase();
    const prev = out.get(key) ?? { count: 0, maxLiquidity: null };
    const liq = r.liquidityUsd != null ? Number(r.liquidityUsd) : null;

    out.set(key, {
      count: prev.count + 1,
      maxLiquidity:
        liq != null && (prev.maxLiquidity == null || liq > prev.maxLiquidity)
          ? liq
          : prev.maxLiquidity,
    });
  }

  return out;
}

// ─────────────────────────────── Планировщик ────────────────────────────────

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Бюджет заметно меньше интервала между проходами. Иначе проход,
    // затянувшийся на источниках, наезжает на следующий: флаг running
    // его отменит, и очередь встанет — при том что снаружи всё будет
    // выглядеть работающим.
    await checkBatch(BATCH, { budgetMs: Math.floor(TICK_MS * 0.6) });
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'проверка витрины: ошибка прохода');
  } finally {
    running = false;
  }
}

export function startScamChecker(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  void tick();
  logger.info('проверка витрины запущена');
}

export function stopScamChecker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
