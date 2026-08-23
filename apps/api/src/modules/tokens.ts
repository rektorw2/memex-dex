import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  assessToken,
  SAFE_LEVELS,
  TRADEABLE_LEVELS,
  looksLikeAddress,
  effectiveLiquidityFloor,
  chartState,
  checkStatus,
  CHECK_STATUSES,
  CHECK_STATUS_TEXT,
  DEFAULT_BACKOFF,
  marketAge,
  marketAgeLabel,
  NEW_MARKET_MAX_AGE_MS,
} from '@memex/core';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { SUPPORTED_INTERVALS, isMarketDataSupported } from '../services/market-data.js';
import { requestCandlesSoon } from '../workers/candle-builder.js';
import { markHot, markHotFromList, hotCount, hotTokens } from '../workers/hot-tokens.js';
import {
  PRICE_STALE_AFTER_MS,
  COLD_BATCH,
  COLD_INTERVAL_MS,
  priceMetrics,
} from '../workers/price-updater.js';
import { serializeResearch } from '../services/research.js';
import { RULES_VERSION } from '../workers/scam-checker.js';
import { MARKET_DATA_SOURCE } from '../services/okx-market.js';
import { cached } from '../lib/cache.js';

/**
 * Рыночные данные публичны.
 *
 * Все маршруты этого модуля отдают то, что одинаково для всех: цену,
 * ликвидность, оборот, свечи и разбор риска. Прятать это за входом
 * значило бы требовать регистрацию за сведения, которые человек
 * и так увидит на любом агрегаторе, — а первое, что он делает,
 * попав на торговый терминал, это смотрит, что тут вообще есть.
 *
 * Приватного здесь нет ничего: ни портфеля, ни балансов, ни истории
 * сделок. Они живут в других модулях и требуют входа.
 *
 * Платным остаётся действие, а не просмотр. Покупка, продажа,
 * копирование и автоматика проверяются там, где выполняются.
 */

/**
 * Порядок сортировки витрины.
 *
 * `gainers` — каноническое определение «лучшего токена» на всё
 * приложение: наибольший рост цены за 24 часа среди тех, кто прошёл
 * пороги ликвидности и оборота (см. `liquidityFloor` ниже). Второго
 * определения быть не должно: карточка на первом экране и список
 * в терминале обязаны называть лидером одно и то же.
 */
/**
 * Отсечка для сортировок по изменению цены.
 *
 * В пуле на двадцать тысяч одна сделка на тысячу двигает цену
 * на порядки, и «растущие» без строгого порога — это список мёртвых
 * токенов с ростом на 120000%, а не рынок.
 */
const CHANGE_SORT_LIQUIDITY_FLOOR = 100_000;

/** Предел попыток очереди. Берётся из политики, а не дублируется числом. */
const MAX_CHECK_ATTEMPTS = DEFAULT_BACKOFF.maxAttempts;

/**
 * Состояние проверки для ответа.
 *
 * Одна функция на все маршруты: список, карточка и разбор обязаны
 * называть одно и то же состояние одним словом, иначе человек видит
 * «Проверен» в списке и «Ожидает проверки» в карточке того же токена.
 */
function checkStatusOf(t: {
  riskLevel?: string | null;
  scamCheckedAt?: Date | null;
  scamRulesVersion?: number | null;
  scamProviderError?: boolean | null;
  riskCodes?: string[] | null;
}) {
  /*
   * Отсутствующие поля читаются как «ничего не известно», а не роняют
   * ответ. Витрина публичная и должна отдаваться даже над строкой,
   * которая старше последней миграции: пятисотая на списке токенов
   * хуже, чем честное «ожидает проверки».
   */
  const status = checkStatus({
    riskLevel: t.riskLevel ?? null,
    checkedAt: t.scamCheckedAt ?? null,
    rulesVersion: t.scamRulesVersion ?? null,
    currentRulesVersion: RULES_VERSION,
    providerError: t.scamProviderError ?? false,
    // Проверка прошла, но ни один источник безопасности не ответил.
    // От сбоя отличается тем, что ожидание не поможет.
    insufficientData: (t.riskCodes ?? []).includes('SECURITY_DATA_UNAVAILABLE'),
  });

  return { checkStatus: status, checkStatusText: CHECK_STATUS_TEXT[status] };
}

/**
 * Возраст котировки.
 *
 * Отдаётся всегда, включая `null`. Пустое значение означает «цена
 * ни разу не обновлялась после импорта», и это не то же самое, что
 * «обновлена только что»: интерфейс обязан различать их, иначе
 * покажет вчерашнее число как текущее.
 */
function priceFreshness(priceUpdatedAt: Date | null) {
  const ageMs = priceUpdatedAt == null ? null : Date.now() - priceUpdatedAt.getTime();

  return {
    priceUpdatedAt,
    priceAgeMs: ageMs,
    // Неизвестный возраст считается устаревшим: отсутствие сведений
    // о свежести — не сведения о свежести.
    priceStale: ageMs == null || ageMs > PRICE_STALE_AFTER_MS,
  };
}

const SORTS = {
  volume: { volume24hUsd: 'desc' },
  liquidity: { liquidityUsd: 'desc' },
  gainers: { priceChange24h: 'desc' },
  losers: { priceChange24h: 'asc' },
  /*
   * «Новые» — по возрасту рынка, а не по времени импорта.
   *
   * Раньше здесь стоял `createdAt`, то есть момент появления записи
   * в нашей базе. Старый токен, впервые увиденный сегодня, попадал
   * в новинки — а «новое» на этом рынке читается как «успей первым».
   *
   * Сортировка идёт по `poolCreatedAt`; записи без него отсекаются
   * фильтром ниже и до сортировки не доходят.
   */
  new: { poolCreatedAt: 'desc' },
} as const;

/**
 * Как часто разрешено заводить в базу новые токены из внешнего списка.
 *
 * Раньше запись шла на каждом запросе. Маршрут стал публичным,
 * и это превратилось в кнопку «записать в базу» для всякого, кто
 * умеет обновлять страницу: двадцать строк на нажатие, без входа
 * и без счёта.
 *
 * Теперь запись отделена от чтения и происходит не чаще раза
 * в пять минут на весь процесс, независимо от того, сколько запросов
 * пришло. Проверка витрины всё равно разбирает очередь медленнее,
 * так что чаще и не нужно.
 */
export const INGEST_INTERVAL_MS = 5 * 60_000;

/** Когда последний раз заводили новые токены. Общее на процесс. */
let lastIngestAt = 0;

/**
 * Сброс троттла между тестами.
 *
 * Состояние живёт на модуле, и без сброса второй тест наследовал бы
 * отметку от первого — то есть проверял бы не то, что написано
 * в его названии.
 */
export function resetIngestThrottleForTests(): void {
  lastIngestAt = 0;
}

/**
 * Ответ внешнего списка, уже собранный.
 *
 * Кэшируется целиком: без этого каждое обновление страницы гостем
 * давало запрос в базу с длинным OR по паре сеть-адрес. Внешний
 * провайдер закэширован у себя (см. dexscreener.ts), а вот наша
 * база — нет, и упиралось всё именно в неё.
 */
export const DEXSCREENER_TTL_MS = 30_000;

export const tokenRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Состояние проверки витрины.
   *
   * Нужно интерфейсу, чтобы пустой или короткий список читался верно:
   * «ничего не найдено» и «проверено ещё не всё» — разные сообщения,
   * и второе не должно выглядеть как первое.
   */
  /**
   * Немедленная перепроверка витрины.
   *
   * Нужна после изменения правил: обычная очередь разбирает по восемь
   * токенов раз в сорок пять секунд, и дожидаться её на полутора сотнях
   * токенов — это двадцать минут, в течение которых в списке висят
   * подделки.
   */
  app.post('/admin/tokens/recheck', { preHandler: [app.requireAdmin] }, async (req) => {
    const body = z
      .object({
        limit: z.number().int().min(1).max(60).default(30),
        /**
         * Сколько секунд отвести проходу.
         *
         * Ограничение по времени, а не только по количеству, появилось
         * потому что проверка одного токена стоит семи обращений
         * к внешним источникам. Шестьдесят токенов — это минуты,
         * и вызов из консоли всё это время выглядит как зависший.
         *
         * Тридцать секунд сверху: дольше держать соединение открытым
         * бессмысленно, обратный прокси всё равно его оборвёт, и это
         * будет выглядеть как ошибка сервера вместо честного
         * «успели столько».
         */
        budgetSeconds: z.number().int().min(5).max(30).default(20),
        /**
         * Сбросить состояние повторов у исчерпавших попытки.
         *
         * Без этого маршрут не мог сделать ровно то, ради чего его
         * зовут вручную. Токен, шесть раз подряд уронивший проверку,
         * выпадает из очереди совсем, а `checkBatch` берёт кандидатов
         * по той же политике — то есть исчерпанные записи не проверял
         * и ручной вызов.
         *
         * По умолчанию выключено, и это не осторожность ради
         * осторожности: сброс стирает след того, что запись стабильно
         * не проверяется, и делать это молча нельзя.
         */
        apply: z.boolean().default(false),
      })
      .parse(req.body ?? {});

    const { checkBatch } = await import('../workers/scam-checker.js');

    /*
     * Кого сбрасывать.
     *
     * Выборка ограничена тем же лимитом, что и проход: сбросить
     * тысячу записей одной командой значит вернуть в очередь тысячу
     * заведомо проблемных токенов и выесть ими всю пропускную
     * способность.
     */
    const exhausted = await prisma.token.findMany({
      where: { isQuote: false, scamCheckAttempts: { gte: MAX_CHECK_ATTEMPTS } },
      orderBy: [{ scamCheckedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      select: { id: true, riskLevel: true },
      take: body.limit,
    });

    const totalExhausted = await prisma.token.count({
      where: { isQuote: false, scamCheckAttempts: { gte: MAX_CHECK_ATTEMPTS } },
    });

    if (!body.apply) {
      /*
       * Пробный прогон ничего не меняет и ничего не запускает.
       *
       * Смысл именно в этом: показать, что произойдёт, до того как
       * оно произойдёт. Проход проверки здесь не запускается тоже —
       * иначе «пробный» означало бы «частично настоящий».
       */
      return {
        mode: 'dry-run' as const,
        wouldReset: exhausted.length,
        totalExhausted,
        blockedAmongThem: exhausted.filter((t) => t.riskLevel === 'blocked').length,
        note:
          totalExhausted === 0
            ? 'Исчерпавших попытки записей нет: очередь разбирает всё сама.'
            : `Будет сброшено ${exhausted.length} из ${totalExhausted}. ` +
              'Повторите с apply: true. Сброс касается только счётчика попыток: ' +
              'блокировки, коды причин и скрытие остаются как есть, ' +
              'до нового успешного вердикта.',
      };
    }

    /*
     * Сбрасывается ровно состояние повторов.
     *
     * Ни `riskLevel`, ни `riskCodes`, ни `isHidden` здесь не трогаются
     * намеренно. Сброс попыток — это разрешение попробовать ещё раз,
     * а не отмена вердикта: заблокированный токен остаётся
     * заблокированным, пока новая проверка не скажет иного.
     *
     * Операция идемпотентна: повторный вызов над теми же записями
     * запишет те же значения.
     */
    const reset = await prisma.$transaction(async (tx) => {
      const updated = await tx.token.updateMany({
        where: { id: { in: exhausted.map((t) => t.id) } },
        data: {
          scamCheckAttempts: 0,
          scamCheckNextAt: null,
          scamProviderError: false,
          /*
           * `checkBatch` выбирает никогда не проверенные, устаревшие
           * или проверенные по прежней версии правил. Одного сброса
           * попыток недостаточно: свежая неудача иначе останется вне
           * выборки до следующего планового окна. null возвращает её
           * в очередь немедленно, не отменяя сохранённый вердикт.
           */
          scamCheckedAt: null,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: req.user.sub,
          action: 'tokens.recheck.reset',
          entity: 'Token',
          entityId: null,
          // Идентификаторы токенов — не персональные данные, и без них
          // журнал не отвечает на вопрос «что именно трогали».
          before: { exhausted: totalExhausted } as never,
          after: { reset: updated.count, ids: exhausted.map((t) => t.id) } as never,
          ip: req.ip,
        },
      });

      return updated;
    });

    const result = await checkBatch(body.limit, { budgetMs: body.budgetSeconds * 1000 });

    return {
      mode: 'applied' as const,
      reset: reset.count,
      totalExhausted,
      ...result,
      note: result.timedOut
        ? `Проход остановлен по времени: разобрано ${result.checked}, ` +
          `осталось ${result.remaining} из выборки. Повторите вызов — ` +
          'очередь продолжится с того же места.'
        : result.checked === 0
          ? 'Проверять нечего: все токены разобраны по действующим правилам.'
          : `Разобрано ${result.checked} токенов. Повторите, если check-status ` +
            'показывает непроверенные.',
    };
  });

  /**
   * Сколько токенов в каком состоянии проверки.
   *
   * Считается перебором строк, а не набором `count` с условиями,
   * и это осознанный размен. Условия пришлось бы писать вторым
   * выражением той же классификации — то есть сверять её саму с собой,
   * и любое расхождение проявилось бы как «проверено 148 из 152»
   * при пустом списке проверенных.
   *
   * Колонок читается пять, строк — вся видимая витрина, результат
   * живёт в кеше полминуты. Для диагностики этого достаточно.
   */
  app.get('/tokens/check-status', async () => {
    const value = await cached(
      'tokens:check-status',
      async () => {
        const rows = await prisma.token.findMany({
          where: { isQuote: false, isHidden: false },
          select: {
            riskLevel: true,
            riskCodes: true,
            scamCheckedAt: true,
            scamRulesVersion: true,
            scamProviderError: true,
          },
        });

        const byStatus: Record<string, number> = {};
        for (const s of CHECK_STATUSES) byStatus[s] = 0;

        for (const r of rows) byStatus[checkStatusOf(r).checkStatus]!++;

        return {
          total: rows.length,
          byStatus,

          /*
           * Прежние имена оставлены: интерфейс читает их, и ломать
           * его одним махом незачем. Значения теперь берутся
           * из той же классификации, а не считаются отдельно.
           */
          ok: byStatus.SAFE!,
          warn: byStatus.WARNING!,
          blocked: byStatus.BLOCKED!,
          unchecked: byStatus.PENDING! + byStatus.INSUFFICIENT_DATA!,
          stale: byStatus.STALE! + byStatus.PROVIDER_ERROR!,
        };
      },
      { ttlMs: 30_000, staleMs: 5 * 60_000 },
    );

    return value.value;
  });

  /**
   * Здоровье очереди проверки.
   *
   * Отвечает на вопрос «почему витрина не обновляется», на который
   * распределение по статусам не отвечает: статусы говорят, где мы
   * находимся, а этот маршрут — движемся ли мы вообще.
   *
   * Только для администратора и только на чтение. Адресов, символов
   * и чего-либо пользовательского здесь нет намеренно: это счётчики,
   * а не выгрузка витрины.
   */
  app.get('/tokens/check-queue', { preHandler: app.requireAdmin }, async () => {
    const base = { isQuote: false } as const;
    const now = Date.now();

    const [
      total,
      neverChecked,
      outdatedRules,
      waitingRetry,
      exhausted,
      providerErrors,
      hiddenPending,
      oldest,
    ] = await Promise.all([
      prisma.token.count({ where: base }),
      prisma.token.count({ where: { ...base, scamCheckedAt: null } }),
      prisma.token.count({ where: { ...base, scamRulesVersion: { lt: RULES_VERSION } } }),
      prisma.token.count({ where: { ...base, scamCheckNextAt: { gt: new Date(now) } } }),
      // Токены, исчерпавшие попытки: они выпали из очереди совсем
      // и без смены версии правил туда не вернутся.
      prisma.token.count({ where: { ...base, scamCheckAttempts: { gte: MAX_CHECK_ATTEMPTS } } }),
      prisma.token.count({ where: { ...base, scamProviderError: true } }),
      // Находки DexScreener, ждущие проверки. Раньше они висели здесь
      // вечно: проверка не брала скрытые вовсе.
      prisma.token.count({ where: { ...base, isHidden: true, scamCheckedAt: null } }),
      prisma.token.findFirst({
        where: { ...base, scamCheckedAt: { not: null } },
        orderBy: { scamCheckedAt: 'asc' },
        select: { scamCheckedAt: true },
      }),
    ]);

    return {
      rulesVersion: RULES_VERSION,
      total,
      neverChecked,
      outdatedRules,
      waitingRetry,
      exhausted,
      providerErrors,
      hiddenPending,
      /**
       * Возраст самой давней проверки.
       *
       * Главное число этого ответа. Если оно растёт от вызова
       * к вызову, очередь не справляется, и никакая настройка
       * порогов этого не исправит.
       */
      oldestCheckAgeMs:
        oldest?.scamCheckedAt != null ? now - oldest.scamCheckedAt.getTime() : null,
      hotTokens: hotCount(now),
    };
  });

  /**
   * Фактическая свежесть цен.
   *
   * Считается по базе, а не по настройкам воркера. Разница
   * принципиальная: настройки говорят, как часто мы намереваемся
   * обновлять, а `priceUpdatedAt` — как часто получилось. Заявлять
   * первое вместо второго — это ровно та ошибка, из-за которой
   * «цены обновляются раз в десять секунд» уживалось с тем, что
   * они не обновлялись вовсе.
   */
  app.get('/admin/price-health', { preHandler: app.requireAdmin }, async () => {
    const now = Date.now();
    const hotIds = hotTokens(now);

    const ageOf = (rows: { priceUpdatedAt: Date | null }[]) =>
      rows
        .map((r) => (r.priceUpdatedAt == null ? null : now - r.priceUpdatedAt.getTime()))
        .filter((v): v is number => v != null)
        .sort((a, b) => a - b);

    const [hotRows, coldRows, neverPriced] = await Promise.all([
      hotIds.length
        ? prisma.token.findMany({
            where: { id: { in: hotIds } },
            select: { priceUpdatedAt: true },
          })
        : Promise.resolve([]),
      prisma.token.findMany({
        where: { isHidden: false, isQuote: false },
        select: { priceUpdatedAt: true },
      }),
      prisma.token.count({
        where: { isHidden: false, isQuote: false, priceUpdatedAt: null },
      }),
    ]);

    /**
     * Персентиль по возрасту.
     *
     * Именно p95, а не среднее: среднее прячет хвост, а вопрос
     * ровно про хвост — сколько токенов показывают вчерашнюю цену.
     */
    const p = (sorted: number[], q: number): number | null =>
      sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;

    const hotAges = ageOf(hotRows);
    const coldAges = ageOf(coldRows);

    return {
      hot: {
        tracked: hotIds.length,
        priceAgeP50Ms: p(hotAges, 0.5),
        priceAgeP95Ms: p(hotAges, 0.95),
        priceAgeMaxMs: hotAges.at(-1) ?? null,
      },
      cold: {
        tracked: coldRows.length,
        priceAgeP50Ms: p(coldAges, 0.5),
        priceAgeP95Ms: p(coldAges, 0.95),
        priceAgeMaxMs: coldAges.at(-1) ?? null,
        /** Ни разу не обновлялись после импорта. */
        neverPriced,
      },
      /**
       * Расчётная длительность полного круга.
       *
       * Отдаётся рядом с измеренной намеренно: расхождение между ними
       * означает, что круг идёт не так, как задумано, и это первое,
       * что стоит заметить.
       */
      cycle: {
        batch: COLD_BATCH,
        intervalMs: COLD_INTERVAL_MS,
        expectedFullCycleMs:
          coldRows.length > 0
            ? Math.ceil(coldRows.length / COLD_BATCH) * COLD_INTERVAL_MS
            : 0,
        measuredFullCycleMs: priceMetrics().lastFullCycleMs,
      },
      provider: priceMetrics(),
    };
  });

  /**
   * Что именно режет выдачу.
   *
   * Появилось после случая, когда версия правил 5 заблокировала 137
   * токенов из 173, и понять причину можно было только перебором
   * гипотез. Счётчик по кодам отвечает на этот вопрос сразу: видно,
   * какое правило сработало сколько раз, и правило, сработавшее
   * на трёх четвертях витрины, почти наверняка описывает норму
   * рынка, а не нарушение.
   */
  app.get('/tokens/risk-breakdown', { preHandler: app.requireAdmin }, async (req) => {
    /*
     * Только администратору.
     *
     * Это не витрина и не карточка токена, а карта нашей защиты:
     * какое правило сработало сколько раз и на какой доле выдачи.
     * По ней видно, какой признак дешевле всего обойти, чтобы попасть
     * в списки, — и отдавать такое публично значит выдавать
     * инструкцию тем, от кого мы защищаемся.
     *
     * Сводное состояние проверки (`/tokens/check-status`) остаётся
     * открытым: оно нужно интерфейсу и не называет ни одного правила.
     */
    const q = z
      .object({ level: z.enum(['blocked', 'high', 'medium', 'all']).default('blocked') })
      .parse(req.query ?? {});

    const rows = await prisma.token.findMany({
      where: {
        isQuote: false,
        isHidden: false,
        ...(q.level === 'all' ? {} : { riskLevel: q.level }),
      },
      select: { riskCodes: true },
    });

    const counts = new Map<string, number>();
    for (const r of rows) {
      for (const code of r.riskCodes ?? []) {
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
    }

    return {
      level: q.level,
      tokens: rows.length,
      codes: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => ({
          code,
          count,
          // Доля от выборки: код, встречающийся почти у всех,
          // описывает рынок, а не отдельный токен.
          share: rows.length > 0 ? Math.round((count / rows.length) * 100) : 0,
        })),
    };
  });

  /**
   * Продвигаемые токены DexScreener, пропущенные через нашу проверку.
   *
   * Список у DexScreener рекламный: «boosted» означает «за размещение
   * заплатили», а не «стоит внимания». Брать его как готовую витрину
   * нельзя — это ровно то, от чего мы месяц чистили терминал.
   *
   * Поэтому здесь он источник кандидатов. Каждый адрес сверяется
   * с нашей базой:
   *
   *   знаем и проверили  — отдаём со своим уровнем риска;
   *   знаем, не проверили — отдаём как непроверенный, честно;
   *   не знаем вовсе      — заводим в базу и ставим в очередь.
   *
   * Последнее важно: без этого вкладка при первом открытии была бы
   * почти пустой, и человек решил бы, что она сломана, хотя на самом
   * деле проверка просто ещё не дошла.
   */
  app.get(
    '/tokens/dexscreener',
    {
      /*
       * Свой лимит, строже общего.
       *
       * Маршрут дороже остальных публичных: за ним внешний провайдер
       * и запрос в базу. Общего лимита в триста запросов в минуту
       * здесь мало — он рассчитан на дешёвое чтение.
       */
      config: { rateLimit: { max: 30, timeWindow: '1m' } },
    },
    async (req, reply) => {
    // Внешний разбор — та же платная часть терминала, что и обзор.
    const q = z
      .object({
        chain: z.string().optional(),
        /** Скрывать не прошедшие проверку. По умолчанию да. */
        safeOnly: z.coerce.boolean().default(true),
        limit: z.coerce.number().max(60).default(40),
      })
      .parse(req.query);

    // Ответ целиком берётся из кэша: обновление страницы не должно
    // доходить ни до провайдера, ни до базы.
    const key = `dexscreener:${q.chain ?? 'all'}:${q.safeOnly}:${q.limit}`;

    const hit = await cached(
      key,
      async () => {
        const { fetchBoostedTokens } = await import('../services/dexscreener.js');
        const boosted = await fetchBoostedTokens();

        return buildDexscreenerView(boosted, q);
      },
      { ttlMs: DEXSCREENER_TTL_MS, staleMs: 5 * 60_000 },
    );

    // Браузеру и посреднику тоже сообщаем срок: часть обновлений
    // не дойдёт до нас вовсе.
    reply.header('Cache-Control', `public, max-age=${Math.floor(DEXSCREENER_TTL_MS / 1000)}`);

    return hit.value;
  },
  );

  /**
   * Сборка ответа по внешнему списку.
   *
   * Только чтение. Заведение новых токенов в базу здесь намеренно
   * отсутствует: оно вынесено отдельно и не зависит от того, кто
   * и как часто открывает страницу.
   */
  async function buildDexscreenerView(
    boosted: Awaited<ReturnType<typeof import('../services/dexscreener.js')['fetchBoostedTokens']>>,
    q: { chain?: string; safeOnly: boolean; limit: number },
  ) {
    const filtered = q.chain ? boosted.filter((b) => b.chain === q.chain) : boosted;
    if (filtered.length === 0) {
      return { tokens: [], source: 'DexScreener', unchecked: 0, total: 0 };
    }

    // Сопоставление по паре сеть-адрес, а не по тикеру: тикер
    // не уникален, и совпадение по нему свело бы подделку
    // с настоящим токеном в одну запись.
    const known = await prisma.token.findMany({
      where: {
        OR: filtered.map((b) => ({
          chain: b.chain as never,
          address: { equals: b.address, mode: 'insensitive' as const },
        })),
      },
    });

    const byKey = new Map(known.map((t) => [`${t.chain}:${t.address.toLowerCase()}`, t]));

    // Незнакомые заводим в базу — но не здесь и не сейчас. Запись
    // отделена от ответа: она не задерживает человека и, главное,
    // не запускается его обновлением страницы.
    const missing = filtered.filter((b) => !byKey.has(`${b.chain}:${b.address.toLowerCase()}`));

    void ingestUnknownTokens(missing);

    const rows = filtered
      .map((b) => {
        const t = byKey.get(`${b.chain}:${b.address.toLowerCase()}`);
        if (!t) {
          return {
            id: null,
            chain: b.chain,
            address: b.address,
            symbol: '???',
            name: b.description ?? null,
            logoUrl: b.iconUrl,
            riskLevel: null,
            riskCodes: [] as string[],
            riskScore: null,
            priceUsd: null,
            liquidityUsd: null,
            volume24hUsd: null,
            priceChange24h: null,
            boostAmount: b.boostAmount,
            isNew: true,
          };
        }

        return {
          id: t.id,
          chain: t.chain,
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          logoUrl: t.logoUrl,
          riskLevel: t.riskLevel,
          riskCodes: t.riskCodes ?? [],
          riskScore: t.riskScore,
          priceUsd: t.priceUsd?.toString() ?? null,
          liquidityUsd: t.liquidityUsd?.toString() ?? null,
          volume24hUsd: t.volume24hUsd?.toString() ?? null,
          priceChange24h: t.priceChange24h?.toString() ?? null,
          boostAmount: b.boostAmount,
          isNew: false,
        };
      })
      // Заблокированные не показываем никогда: за них заплатили,
      // но продать их всё равно нельзя.
      .filter((r) => r.riskLevel !== 'blocked');

    /*
     * Прошедшие проверку и ожидающие её — два разных списка.
     *
     * Раньше здесь стоял один фильтр по `safeOnly`, и при значении
     * по умолчанию он удалял непроверенные молча. Комментарий рядом
     * обещал показывать их честно; на деле человек при семнадцати
     * ожидающих видел пустой экран и решал, что вкладка сломана.
     *
     * Теперь непроверенные возвращаются отдельным полем. Смешивать
     * их с проверенными нельзя — `pending` не должен читаться как
     * «проверено», — но и прятать незачем: это единственное, что
     * на вкладке вообще есть в первые минуты после импорта.
     */
    const checked = rows.filter((r) => SAFE_LEVELS.includes(r.riskLevel as never));
    const pending = rows.filter((r) => r.riskLevel == null);
    const flagged = rows.filter(
      (r) => r.riskLevel != null && !SAFE_LEVELS.includes(r.riskLevel as never),
    );

    return {
      source: 'DexScreener',
      // Честное число: сколько в исходном списке и сколько дошло.
      total: filtered.length,
      unchecked: pending.length,
      // Прошедшие проверку первыми. Клиент при `safeOnly` показывает
      // только их в основном списке, а ожидающих — отдельной секцией
      // с заметным статусом и без торговых кнопок.
      tokens: checked.slice(0, q.limit),
      pending: pending.slice(0, q.limit),
      // Замечания показываются, только когда человек сам снял
      // строгий режим.
      flagged: q.safeOnly ? [] : flagged.slice(0, q.limit),
    };
  }

  /**
   * Заведение незнакомых токенов в базу.
   *
   * Не чаще раза в пять минут на весь процесс и всегда в фоне.
   * Ошибка проглатывается: это наполнение витрины, а не ответ
   * человеку, и падать из-за него ответ не должен.
   *
   * Уровень риска не выставляется: непроверенное непроверено,
   * и попасть в общую витрину токен должен на общих основаниях,
   * а не потому, что за него заплатили.
   */
  async function ingestUnknownTokens(
    missing: { chain: string; address: string; description?: string | null; iconUrl?: string | null }[],
  ): Promise<void> {
    if (missing.length === 0) return;

    const now = Date.now();
    if (now - lastIngestAt < INGEST_INTERVAL_MS) return;
    lastIngestAt = now;

    await prisma.token
      .createMany({
        data: missing.slice(0, 20).map((b) => ({
          chain: b.chain as never,
          address: b.address,
          symbol: '???',
          name: b.description?.slice(0, 60) ?? 'Неизвестный токен',
          decimals: b.chain === 'SOLANA' ? 9 : 18,
          logoUrl: b.iconUrl,
          source: 'dexscreener',
          isHidden: true,
        })),
        skipDuplicates: true,
      })
      .catch(() => undefined);
  }

  /**
   * Живая лента OKX Signal для вкладки GEMS.
   *
   * У маршрута намеренно нет ни risk-, ни liquidity-, ни chain-фильтров.
   * Он показывает события провайдера в том порядке, в котором они
   * появились, включая токены, ещё скрытые в нашей обычной витрине.
   * GEMS сейчас информационный: ответ не выдаёт торгового разрешения
   * и не превращает сигнал в рекомендацию или возможность покупки.
   */
  app.get('/tokens/gems', async (req, reply) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
      .parse(req.query);

    const signals = await prisma.okxSignal.findMany({
      orderBy: [{ signaledAt: 'desc' }, { id: 'desc' }],
      take: limit,
      // Не тянем JSON-разбор риска и остальные тяжёлые поля Token:
      // GEMS их не показывает, а маршрут обновляется каждые три секунды.
      select: {
        id: true,
        providerKey: true,
        chain: true,
        address: true,
        symbol: true,
        name: true,
        logoUrl: true,
        signaledAt: true,
        receivedAt: true,
        walletTypes: true,
        triggerWalletCount: true,
        amountUsd: true,
        soldRatioPct: true,
        priceUsd: true,
        marketCapUsd: true,
        holders: true,
        token: {
          select: {
            id: true,
            priceUsd: true,
            priceChange24h: true,
            priceUpdatedAt: true,
            fdvUsd: true,
            liquidityUsd: true,
            volume24hUsd: true,
            holders: true,
            poolAddress: true,
            isVerified: true,
          },
        },
      },
    });

    // Лента опрашивается каждые три секунды, а горячий ценовой цикл
    // идёт раз в четыре. Продлеваем метку только первым видимым
    // токенам: так карточки действительно live, но одна публичная
    // вкладка не может заставить провайдера обновлять все сто строк.
    markHotFromList(
      signals.flatMap((signal) => (signal.token?.id ? [signal.token.id] : [])),
    );

    // Двухсекундный браузерный кэш сглаживает несколько одновременно
    // открытых вкладок, но не превращает живой поток в минутную ленту.
    reply.header('Cache-Control', 'public, max-age=2, stale-while-revalidate=3');

    return {
      source: 'OKX Signal',
      updatedAt: new Date().toISOString(),
      signals: signals.map((signal) => ({
        id: signal.id,
        providerKey: signal.providerKey,
        signaledAt: signal.signaledAt,
        receivedAt: signal.receivedAt,
        walletTypes: signal.walletTypes,
        triggerWalletCount: signal.triggerWalletCount,
        amountUsd: signal.amountUsd?.toString() ?? null,
        soldRatioPct: signal.soldRatioPct?.toString() ?? null,
        signalPriceUsd: signal.priceUsd?.toString() ?? null,
        signalMarketCapUsd: signal.marketCapUsd?.toString() ?? null,
        token: {
          id: signal.token?.id ?? null,
          chain: signal.chain,
          address: signal.address,
          symbol: signal.symbol,
          name: signal.name,
          logoUrl: signal.logoUrl,
          priceUsd: signal.token?.priceUsd?.toString() ?? signal.priceUsd?.toString() ?? null,
          priceChange24h: signal.token?.priceChange24h?.toString() ?? null,
          priceUpdatedAt: signal.token?.priceUpdatedAt ?? null,
          marketCapUsd:
            signal.token?.fdvUsd?.toString() ?? signal.marketCapUsd?.toString() ?? null,
          liquidityUsd: signal.token?.liquidityUsd?.toString() ?? null,
          volume24hUsd: signal.token?.volume24hUsd?.toString() ?? null,
          holders: signal.token?.holders ?? signal.holders,
          hasChart: signal.token?.poolAddress != null,
          isVerified: signal.token?.isVerified ?? false,
        },
      })),
    };
  });

  app.get('/tokens', async (req) => {
    const q = z
      .object({
        chain: z.string().optional(),
        search: z.string().optional(),
        sort: z.enum(['volume', 'liquidity', 'gainers', 'losers', 'new']).default('volume'),
        verifiedOnly: z.coerce.boolean().default(false),
        minLiquidity: z.coerce.number().optional(),
        maxRiskScore: z.coerce.number().optional(),
        /**
         * Показать заблокированные. По умолчанию выключено: токен,
         * который нельзя продать, не должен попадаться в списке
         * случайно — его показ должен быть осознанным действием.
         */
        includeBlocked: z.coerce.boolean().default(false),
        /** Только проверенные и чистые. */
        safeOnly: z.coerce.boolean().default(false),
        /** Предельный возраст рынка в часах. Действует для sort=new. */
        maxAgeHours: z.coerce.number().positive().max(24 * 30).optional(),
        limit: z.coerce.number().max(200).default(60),
      })
      .parse(req.query);

    /**
     * Сортировка по изменению цены требует более строгой отсечки, чем
     * остальные. В пуле на 20 тысяч долларов одна сделка на тысячу двигает
     * цену на порядки, и «растущие» без фильтра — это список мёртвых
     * токенов с ростом на 120000%, а не рынок. Порог поднимаем на порядок
     * относительно базового и требуем реальный дневной объём.
     */
    const isChangeSort = q.sort === 'gainers' || q.sort === 'losers';

    /*
     * Порог ликвидности применяется ко всем подборкам, а не только
     * к сортировкам по изменению цены.
     *
     * Раньше он был `undefined` для `volume`, `liquidity` и `new`,
     * то есть настройка `MIN_LIQUIDITY_USD` к витрине не применялась
     * вовсе, и в списки попадали пулы на полдоллара — их нельзя
     * продать, а стоят они рядом с настоящими рынками.
     *
     * Клиент может попросить строже, но не мягче: `minLiquidity=0`
     * прежде отключал фильтр целиком, потому что проверялся
     * на истинность.
     */
    const baseFloor = isChangeSort
      ? Math.max(CHANGE_SORT_LIQUIDITY_FLOOR, env.MIN_LIQUIDITY_USD)
      : env.MIN_LIQUIDITY_USD;

    const liquidityFloor = effectiveLiquidityFloor(q.minLiquidity, baseFloor);

    /*
     * Возраст рынка для «Новых».
     *
     * Отсекается на сервере, а не сортировкой в браузере: без этого
     * при пустой выборке свежих пулов список молча заполнялся бы
     * самыми старыми записями, отсортированными по убыванию.
     */
    const maxAgeMs = q.maxAgeHours != null ? q.maxAgeHours * 3_600_000 : NEW_MARKET_MAX_AGE_MS;

    /**
     * Поиск по точному адресу — особый случай.
     *
     * Человек, вставивший адрес контракта, знает, что ищет, и скрывать
     * от него результат неправильно: он всё равно найдёт токен в другом
     * месте, только уже без наших предупреждений. Поэтому по точному
     * адресу показываем всё, включая заблокированное, — но вместе
     * с уровнем риска и причинами, которые интерфейс обязан показать
     * красным.
     *
     * Это не дыра в фильтрации. Разница между «попался в списке»
     * и «нашёл по адресу, который сам ввёл» существенна: в первом
     * случае мы предлагаем, во втором отвечаем на вопрос.
     */
    const byExactAddress = q.search != null && looksLikeAddress(q.search);

    const tokens = await prisma.token.findMany({
      where: byExactAddress
        ? {
            // Регистронезависимо: EVM-адреса хранятся в нижнем регистре,
            // а вставляют их обычно в контрольной форме с заглавными.
            // Требовать точного совпадения строк значило бы не находить
            // токен по его же собственному адресу.
            address: { equals: q.search!.trim(), mode: 'insensitive' },
            ...(q.chain ? { chain: q.chain as never } : {}),
          }
        : {
        isHidden: false,
        ...(q.verifiedOnly ? { isVerified: true } : {}),
        ...(q.chain ? { chain: q.chain as never } : {}),
        // Сравнение с числом, а не проверка на истинность: порог
        // в ноль — это тоже порог, и отключать фильтр он не должен.
        liquidityUsd: { gte: liquidityFloor },
        ...(q.sort === 'new'
          ? {
              // Возраст известен и не больше суток. Записи без времени
              // пула сюда не попадают: неизвестный возраст — не малый.
              poolCreatedAt: { not: null, gte: new Date(Date.now() - maxAgeMs) },
            }
          : {}),
        ...(isChangeSort
          ? {
              volume24hUsd: { gte: 50_000 },
              priceChange24h: { not: null },
              // По списку растущих принимают самые импульсивные решения,
              // поэтому непроверенным токенам здесь не место. Показывать
              // «+543%» рядом с вопросительным знаком значит предлагать
              // сделку, о предмете которой мы сами ничего не знаем.
              riskLevel: { in: [...SAFE_LEVELS] },
            }
          : {}),
        ...(q.maxRiskScore != null ? { riskScore: { lte: q.maxRiskScore } } : {}),

        // Заблокированные скрыты всегда, кроме явного запроса.
        ...(q.includeBlocked ? {} : { riskLevel: { not: 'blocked' } }),
        // Строгий режим: только подтверждённые и низкий риск.
        // Непроверенные сюда не попадают принципиально — незавершённая
        // проверка это отсутствие сведений, а не сведения об отсутствии
        // проблем.
        ...(q.safeOnly ? { riskLevel: { in: [...SAFE_LEVELS] } } : {}),
        ...(q.search
          ? {
              OR: [
                { symbol: { contains: q.search, mode: 'insensitive' } },
                { name: { contains: q.search, mode: 'insensitive' } },
                { address: q.search },
              ],
            }
          : {}),
      },
      orderBy: [SORTS[q.sort], { volume24hUsd: 'desc' }],
      take: q.limit,
    });

    /*
     * Показанное человеку становится горячим.
     *
     * Помечается начало выдачи, а не вся страница: на экране
     * помещается десяток, а ответ отдаёт до двухсот. Идентификаторы
     * здесь наши собственные — только что прочитанные из базы,
     * — поэтому ни несуществующих, ни скрытых среди них не бывает
     * по построению.
     */
    markHotFromList(tokens.map((t) => t.id));

    return tokens.map((t) => ({
      id: t.id,
      chain: t.chain,
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      logoUrl: t.logoUrl,
      isQuote: t.isQuote,
      isVerified: t.isVerified,
      priceUsd: t.priceUsd?.toString() ?? null,
      priceChange24h: t.priceChange24h?.toString() ?? null,
      liquidityUsd: t.liquidityUsd?.toString() ?? null,
      volume24hUsd: t.volume24hUsd?.toString() ?? null,
      // Возраст рынка и его источник. Интерфейс обязан различать
      // «два часа» и «неизвестно»: второе не является малым числом.
      ...(() => {
        const age = marketAge({ poolCreatedAt: t.poolCreatedAt, firstSeenAt: t.firstSeenAt });
        return {
          marketAgeMs: age.ageMs,
          marketAgeSource: age.source,
          marketAgeLabel: marketAgeLabel(age),
        };
      })(),
      fdvUsd: t.fdvUsd?.toString() ?? null,
      riskScore: t.riskScore,
      hasChart: t.poolAddress != null,
      source: t.source,

      // Вердикт отдаётся всегда, включая null: интерфейс должен уметь
      // отличить «проверен и чист» от «ещё не проверялся».
      riskLevel: t.riskLevel,
      riskCodes: t.riskCodes,
      isRegistered: t.isRegistered,
      scamVerdict: t.scamVerdict,
      scamReasons: t.scamReasons,
      scamCheckedAt: t.scamCheckedAt,
      // Состояние проверки одним словом. Уровень риска отвечает
      // «насколько опасно», а человек, глядя на пустой список,
      // спрашивает «почему здесь ничего нет».
      ...checkStatusOf(t),
      // Возраст котировки: без него интерфейс не может отличить
      // цену минутной давности от вчерашней.
      ...priceFreshness(t.priceUpdatedAt),
      buys24h: t.buys24h,
      sells24h: t.sells24h,
      socials: t.socials,
    }));
  });

  app.get('/tokens/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const t = await prisma.token.findUnique({ where: { id } });
    if (!t || t.isHidden) return reply.code(404).send({ error: 'Токен не найден' });

    /*
     * Открытая карточка переводит токен в горячие.
     *
     * Обычный обход идёт по обороту и до хвоста витрины не доходит,
     * а открывают чаще всего именно оттуда: по ссылке, из поиска,
     * из радара. Без этой отметки человек смотрел бы на цену
     * суточной давности, пока не закроет вкладку.
     */
    markHot(t.id);

    return {
      ...t,
      priceUsd: t.priceUsd?.toString() ?? null,
      priceChange24h: t.priceChange24h?.toString() ?? null,
      liquidityUsd: t.liquidityUsd?.toString() ?? null,
      volume24hUsd: t.volume24hUsd?.toString() ?? null,
      fdvUsd: t.fdvUsd?.toString() ?? null,
      hasChart: t.poolAddress != null,
      ...checkStatusOf(t),
      ...priceFreshness(t.priceUpdatedAt),
    };
  });

  /**
   * Полная карточка токена: метрики, разбор рисков, связанные коллы
   * и статистика сделок на платформе.
   *
   * Собрано в один запрос намеренно: страница токена — то место, где
   * пользователь решает, входить ли. Четыре последовательных запроса
   * означали бы, что часть блоков дорисовывается уже после того, как
   * он нажал «Купить».
   */
  app.get('/tokens/:id/overview', async (req, reply) => {
    /*
     * Разбор токена — платная часть терминала.
     *
     * Список токенов остаётся открытым: это витрина, по ней человек
     * решает, стоит ли вообще заводить аккаунт. Закрыто то, ради чего
     * платят, — разложенная по причинам оценка риска, история цены
     * и сводка для решения о покупке.
     */
    const { id } = z.object({ id: z.string() }).parse(req.params);

    const token = await prisma.token.findUnique({ where: { id }, include: { research: true } });
    if (!token || token.isHidden) return reply.code(404).send({ error: 'Токен не найден' });

    const ageHours = token.createdAt
      ? (Date.now() - token.createdAt.getTime()) / 3_600_000
      : null;

    const risk = assessToken({
      liquidityUsd: token.liquidityUsd?.toString() ?? null,
      volume24hUsd: token.volume24hUsd?.toString() ?? null,
      holders: token.holders,
      topHolderPct: token.topHolderPct?.toString() ?? null,
      lpBurnedPct: token.lpBurnedPct?.toString() ?? null,
      isHoneypot: token.isHoneypot,
      ageHours,
    });

    const [calls, tradeAgg, recentTrades, holdersCount] = await Promise.all([
      prisma.call.findMany({
        where: { tokenId: id, status: { not: 'DRAFT' } },
        orderBy: { publishedAt: 'desc' },
        take: 5,
        select: {
          id: true, title: true, thesis: true, risk: true, status: true,
          entryPriceUsd: true, targets: true, stopLossUsd: true,
          resultPct: true, peakMultiple: true, publishedAt: true,
        },
      }),
      prisma.trade.aggregate({
        where: { status: 'CONFIRMED', OR: [
          { order: { tokenOutId: id, side: 'BUY' } },
          { order: { tokenInId: id, side: 'SELL' } },
        ] },
        _count: true,
        _sum: { valueUsd: true },
      }),
      prisma.trade.findMany({
        where: { status: 'CONFIRMED', OR: [
          { order: { tokenOutId: id, side: 'BUY' } },
          { order: { tokenInId: id, side: 'SELL' } },
        ] },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true, createdAt: true, valueUsd: true, priceUsd: true,
          order: { select: { side: true, source: true } },
        },
      }),
      // Сколько пользователей платформы держат этот токен — сигнал
      // популярности внутри сервиса, а не в сети целиком.
      prisma.position.count({ where: { tokenId: id, quantity: { gt: 0 } } }),
    ]);

    return {
      token: {
        id: token.id,
        chain: token.chain,
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        logoUrl: token.logoUrl,
        isVerified: token.isVerified,
        isQuote: token.isQuote,
        source: token.source,
        poolAddress: token.poolAddress,
        hasChart: token.poolAddress != null,
        priceUsd: token.priceUsd?.toString() ?? null,
        priceChange24h: token.priceChange24h?.toString() ?? null,
        liquidityUsd: token.liquidityUsd?.toString() ?? null,
        volume24hUsd: token.volume24hUsd?.toString() ?? null,
        fdvUsd: token.fdvUsd?.toString() ?? null,
        holders: token.holders,
        lpBurnedPct: token.lpBurnedPct?.toString() ?? null,
        topHolderPct: token.topHolderPct?.toString() ?? null,
        isHoneypot: token.isHoneypot,
        listedAt: token.createdAt,
        metricsUpdated: token.metricsUpdated,
      },
      risk,
      research: token.research ? serializeResearch(token.research) : null,
      calls: calls.map((c) => ({
        ...c,
        entryPriceUsd: c.entryPriceUsd.toString(),
        stopLossUsd: c.stopLossUsd?.toString() ?? null,
        resultPct: c.resultPct?.toString() ?? null,
        peakMultiple: c.peakMultiple?.toString() ?? null,
      })),
      platformStats: {
        trades: tradeAgg._count,
        volumeUsd: tradeAgg._sum?.valueUsd?.toString() ?? '0',
        holders: holdersCount,
      },
      recentTrades: recentTrades.map((t) => ({
        id: t.id,
        date: t.createdAt,
        side: t.order.side,
        source: t.order.source,
        valueUsd: t.valueUsd.toString(),
        priceUsd: t.priceUsd.toString(),
      })),
    };
  });

  app.get('/tokens/:id/candles', async (req, reply) => {
    /*
     * Разбор токена — платная часть терминала.
     *
     * Список токенов остаётся открытым: это витрина, по ней человек
     * решает, стоит ли вообще заводить аккаунт. Закрыто то, ради чего
     * платят, — разложенная по причинам оценка риска, история цены
     * и сводка для решения о покупке.
     */
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const q = z
      .object({
        interval: z.string().default('5m'),
        limit: z.coerce.number().max(1000).default(300),
      })
      .parse(req.query);

    if (!SUPPORTED_INTERVALS.includes(q.interval)) {
      return reply.code(400).send({
        error: `Неподдерживаемый интервал. Доступны: ${SUPPORTED_INTERVALS.join(', ')}`,
      });
    }

    const [token, candles] = await Promise.all([
      prisma.token.findUnique({
        where: { id },
        select: { chain: true, poolAddress: true },
      }),
      prisma.candle.findMany({
        where: { tokenId: id, interval: q.interval },
        orderBy: { openTime: 'desc' },
        take: q.limit,
      }),
    ]);

    if (!token) return reply.code(404).send({ error: 'Токен не найден' });

    /*
     * Почему свечей нет — отдельный ответ, а не пустой массив.
     *
     * Прежде интерфейс на всё отвечал «не найден пул ликвидности»,
     * и это врало чаще, чем говорило правду: сообщение видели
     * у токена с пулом на 184 тысячи, потому что пул был, а свечей
     * не было. Причины разные, и действия по ним разные.
     */
    const hasAnyCandles =
      candles.length > 0 ||
      (await prisma.candle.count({ where: { tokenId: id } })) > 0;

    const state = chartState({
      hasPool: token.poolAddress != null,
      supported: isMarketDataSupported(token.chain),
      candleCount: candles.length,
      hasAnyCandles,
    });

    /*
     * Открытый человеком токен просится в очередь вне общего круга.
     *
     * Обход воркера идёт по объёму и берёт триста штук: токен
     * за их пределами не получил бы свечей никогда. Пометка ставится
     * тихо и не задерживает ответ — она лишь двигает приоритет.
     */
    if (state === 'candles-queued' || state === 'empty-period') {
      requestCandlesSoon(id, q.interval);
    }

    return {
      interval: q.interval,
      state,
      // Формат lightweight-charts: время в секундах, значения числами.
      candles: candles.reverse().map((c) => ({
        time: Math.floor(c.openTime.getTime() / 1000),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volumeUsd),
      })),
    };
  });

  /** Сводка по рынку — для шапки витрины. */
  app.get('/market/summary', async () => {
    // Сводка считается по тем же токенам, что попадают в список:
    // объём и ликвидность, включающие заблокированные, описывают
    // не тот рынок, который человек видит на экране.
    const listed = { isHidden: false, riskLevel: { in: [...SAFE_LEVELS] } };

    const [total, passed, byChain, agg] = await Promise.all([
      prisma.token.count({ where: { isHidden: false } }),
      prisma.token.count({ where: listed }),
      prisma.token.groupBy({ by: ['chain'], where: listed, _count: true }),
      prisma.token.aggregate({
        where: listed,
        _sum: { volume24hUsd: true, liquidityUsd: true },
      }),
    ]);

    return {
      tokens: total,
      passedCheck: passed,
      byChain: Object.fromEntries(byChain.map((c) => [c.chain, c._count])),
      volume24hUsd: agg._sum?.volume24hUsd?.toString() ?? '0',
      liquidityUsd: agg._sum?.liquidityUsd?.toString() ?? '0',
      // Источник подписывается на стороне сервера, а не зашивается
      // в интерфейс: если завтра основной поставщик сменится, подпись
      // должна смениться вместе с ним, а не остаться прежней.
      dataSource: MARKET_DATA_SOURCE,
      updatedAt: new Date().toISOString(),
      intervals: SUPPORTED_INTERVALS,
    };
  });
};
