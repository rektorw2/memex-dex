import { z } from 'zod';
import {
  legacySigningFlagVerdict,
  LEGACY_SIGNING_FLAG_MESSAGE,
} from '@memex/core';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Загрузка .env выполняется здесь явно и до разбора схемы.
 *
 * Почему не полагаемся на неявную загрузку: @prisma/client тоже читает .env
 * при импорте, и раньше конфигурация «работала» только в тех процессах, где
 * Prisma случайно импортировался раньше env.ts. Воркеры стартовали, а API —
 * нет, с одним и тем же .env. Порядок импортов не должен влиять на то,
 * видит ли приложение свою конфигурацию.
 *
 * Файл ищется вверх по дереву от этого модуля: скрипты запускаются из разных
 * директорий (корень монорепо, apps/api), а .env лежит в корне.
 */
function loadDotenv(): void {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      applyEnvFile(candidate);
      return;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
}

function applyEnvFile(path: string): void {
  const content = readFileSync(path, 'utf8');

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    const value = parseValue(line.slice(eq + 1));

    // Переменные, заданные в окружении, имеют приоритет над файлом:
    // так деплой-платформа может переопределить любое значение.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Разбор правой части строки .env.
 *
 * Хвостовые комментарии обязаны отсекаться: в .env.example значения
 * снабжены пояснениями вида `EXECUTION_MODE=paper   # paper | live`,
 * и без этого значением стало бы «paper   # paper | live», что не
 * прошло бы проверку enum.
 *
 * Решётка внутри значения при этом должна сохраняться — она legally
 * встречается в паролях строк подключения. Поэтому комментарием
 * считается только `#`, отделённый пробелом.
 */
function parseValue(raw: string): string {
  const value = raw.trim();

  // `KEY=    # пояснение` — значение не задано, вся правая часть комментарий.
  if (value.startsWith('#')) return '';

  // Значение в кавычках берётся целиком до закрывающей кавычки,
  // остаток строки игнорируется — так можно сохранить и решётку, и пробелы.
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const close = value.indexOf(quote, 1);
    if (close !== -1) return value.slice(1, close);
    return value.slice(1);
  }

  const comment = value.search(/\s#/);
  return comment === -1 ? value : value.slice(0, comment).trim();
}

loadDotenv();

/**
 * Пустая строка в .env означает «не задано», а не «задано пустым».
 * Строка вида `RHC_RPC_URL=` — это заготовка под будущее значение,
 * и валидатор url не должен на неё ругаться.
 */
const optional = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === '' || v === undefined ? undefined : v), inner.optional());

/** `Boolean('false') === true`, поэтому z.coerce.boolean для .env непригоден. */
const booleanFromEnv = z.preprocess((value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}, z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Render, Railway, Fly и Heroku назначают порт сами через PORT.
  // Игнорировать его нельзя: health check пойдёт не туда, платформа
  // сочтёт сервис мёртвым и будет бесконечно перезапускать деплой.
  API_PORT: z.coerce.number().default(4000),
  PORT: z.coerce.number().optional(),
  DATABASE_URL: z.string().url('DATABASE_URL должен быть строкой подключения postgresql://…'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET должен быть минимум 32 символа'),
  JWT_TTL: z.string().default('15m'),

  // Разрешённые источники для CORS в production, через запятую.
  // Пример: https://memex.up.railway.app,https://memex.trade
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v.split(',').map((s) => s.trim()).filter(Boolean),
    ),

  /**
   * Запускать воркеры внутри процесса API вместо отдельного сервиса.
   *
   * Нужно для бесплатных тарифов, где фоновые процессы платные: без
   * воркеров не обновляются цены и не срабатывают лимитные ордера,
   * то есть половина продукта не работает.
   *
   * Для нагрузки выше демонстрационной так делать не стоит: воркеры
   * и HTTP-запросы начнут конкурировать за event loop, и задержки
   * ответов вырастут. Тогда — отдельный сервис.
   */
  RUN_WORKERS_IN_API: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  KMS_PROVIDER: z.enum(['local', 'aws-kms', 'gcp-kms']).default('local'),
  KMS_LOCAL_MASTER_KEY: optional(z.string()),
  /**
   * Ключ AWS для конвертного шифрования DEK.
   *
   * Это НЕ ключ подписи Solana: у них разные типы (симметричный
   * против `ECC_NIST_EDWARDS25519`) и разное назначение. Ключ
   * подписи задаётся отдельно, `SOLANA_SIGNER_KEY_ID`; попытка
   * обойтись одним привела бы к отказу провайдера в лучшем случае
   * и к подписи неправильным ключом в худшем.
   */
  AWS_KMS_KEY_ID: optional(z.string()),
  HOT_WALLET_MAX_USD: z.coerce.number().default(25_000),

  SOLANA_RPC_URL: z.string().url().default('https://api.mainnet-beta.solana.com'),
  BNB_RPC_URL: z.string().url().default('https://bsc-dataseed.binance.org'),
  RHC_RPC_URL: optional(z.string().url()),
  RHC_CHAIN_ID: optional(z.coerce.number().int().positive()),

  /**
   * Ключ Gemini для AI-разбора токенов. Необязателен: без него разбор
   * возвращает только проверяемые факты, а трактовка не формируется.
   * Бесплатный тариф даёт порядка 250-1000 запросов в сутки на моделях
   * Flash — при ручном запуске админом этого достаточно с запасом.
   */
  GEMINI_API_KEY: optional(z.string()),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),

  /**
   * Учётные данные OKX Onchain OS — основного источника рыночных данных.
   * Регистрация бесплатна: web3.okx.com → Developer Portal.
   *
   * Без них список токенов строится на запасном источнике
   * (GeckoTerminal), а расширенная проверка безопасности не работает.
   * Терминал при этом не ломается, но проверенных токенов в нём
   * не будет: непроверенное безопасным не считается.
   *
   * Читаются только на сервере. В клиентский бандл они не попадают
   * ни при каких обстоятельствах — за этим следит отдельный тест,
   * apps/api/src/lib/no-secrets.test.ts.
   */
  OKX_API_KEY: optional(z.string()),
  OKX_API_SECRET: optional(z.string()),
  OKX_PASSPHRASE: optional(z.string()),
  OKX_PROJECT_ID: optional(z.string()),

  /**
   * Те же ключи под именами из документации OKX.
   *
   * Документация называет их OKX_SECRET_KEY и OKX_API_PASSPHRASE,
   * а в проекте исторически прижились OKX_API_SECRET и OKX_PASSPHRASE.
   * Принимаем оба написания вместо переименования: переименование
   * тихо сломало бы уже настроенные развёртывания, и обнаружилось бы
   * это как «OKX перестал отвечать», а не как «переменная не найдена».
   */
  OKX_SECRET_KEY: optional(z.string()),
  OKX_API_PASSPHRASE: optional(z.string()),

  /**
   * Базовый адрес и выключатель кошельковых разделов OKX.
   *
   * Адрес вынесен в настройку не ради гибкости, а ради проверки:
   * без него нельзя направить клиент на локальный стенд и убедиться,
   * что подпись строится верно, не имея боевых ключей.
   */
  OKX_API_BASE_URL: z.string().default('https://web3.okx.com'),
  OKX_MARKET_ENABLED: booleanFromEnv.default(true),

  /**
   * Пороги отбора кандидатов при поиске смарт-кошельков.
   *
   * Это фильтр поиска, а не доказательство качества. Он отсекает шум,
   * чтобы не заводить в базу кошельки с тремя сделками на двадцать
   * долларов; настоящая оценка считается позже собственным ядром
   * по закрытым позициям.
   *
   * Ноль в любом из них выключает соответствующее условие.
   */
  SMART_WALLET_MIN_REALIZED_PNL_USD: z.coerce.number().default(1_000),
  SMART_WALLET_MIN_WIN_RATE_PERCENT: z.coerce.number().default(50),
  SMART_WALLET_MIN_TXS: z.coerce.number().default(10),
  SMART_WALLET_MIN_VOLUME_USD: z.coerce.number().default(5_000),

  /**
   * Живая лента через WebSocket.
   *
   * Пороги вынесены в настройки не ради гибкости, а потому что
   * подобрать их без наблюдения за живым потоком нельзя: как часто
   * OKX присылает сообщения по спокойному рынку, заранее неизвестно,
   * а от этого зависит, что считать зависшим соединением.
   *
   * Значения по умолчанию выбраны осторожно: лишнее переподключение
   * дешевле, чем источник, который висит мёртвым и выглядит живым.
   */
  OKX_WS_ENABLED: booleanFromEnv.default(true),
  OKX_WS_URL: z.string().default('wss://wsdex.okx.com/ws/v6/dex'),
  OKX_WS_CONNECT_TIMEOUT_MS: z.coerce.number().default(10_000),
  OKX_WS_LOGIN_TIMEOUT_MS: z.coerce.number().default(10_000),
  OKX_WS_SUBSCRIBE_TIMEOUT_MS: z.coerce.number().default(15_000),
  OKX_WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().default(20_000),
  /** Молчание дольше этого — соединение считается зависшим. */
  OKX_WS_STALE_AFTER_MS: z.coerce.number().default(90_000),
  OKX_WS_RECONNECT_BASE_MS: z.coerce.number().default(1_000),
  OKX_WS_RECONNECT_MAX_MS: z.coerce.number().default(60_000),
  /** Сколько соединение должно продержаться, чтобы счётчик попыток обнулился. */
  OKX_WS_HEALTHY_RESET_MS: z.coerce.number().default(60_000),
  OKX_ACTIVITY_REST_FALLBACK_INTERVAL_MS: z.coerce.number().default(20_000),
  /**
   * Запасной опрос Signal вращается по одной сети за проход.
   * Основной путь — WebSocket; минута здесь бережёт платную квоту,
   * но за полный круг всё равно проходит не больше четырёх минут.
   */
  OKX_SIGNAL_REST_FALLBACK_INTERVAL_MS: z.coerce.number().min(15_000).default(60_000),

  /**
   * Тарифный план OKX Market API.
   *
   * От него зависит месячная квота и — что важнее — доступен ли
   * WebSocket вообще. На бесплатном плане он официально не поддержан,
   * и без этой настройки приложение бесконечно переподключалось бы
   * к каналу, которого для него не существует, попутно расходуя
   * Premium-квоту параллельным опросом REST.
   *
   * Значение по умолчанию — самое осторожное: неизвестный или
   * незаданный план читается как бесплатный.
   */
  OKX_PLAN: optional(z.string()),

  /**
   * Сети, которым достаётся квота в первую очередь.
   *
   * Список через запятую, например `SOLANA,BASE`. Когда квоты
   * не хватает на всех, обновляться чаще должны те сети, где
   * происходит торговля: на этом рынке это прежде всего Solana.
   *
   * Пустое значение означает равный приоритет — это честнее, чем
   * зашитый в код порядок, о котором никто не помнит.
   */
  OKX_PRIORITY_CHAINS: optional(z.string()),

  /**
   * Перенос сделок в позиции.
   *
   * Объединение по времени — главная настройка: десять событий
   * одного кошелька за двадцать секунд должны дать один запрос
   * к истории, а не десять. Параллельность намеренно маленькая:
   * сотня кошельков разом — это залп по лимиту провайдера.
   */
  WALLET_LEDGER_SYNC_ENABLED: booleanFromEnv.default(true),
  WALLET_LEDGER_SYNC_DEBOUNCE_MS: z.coerce.number().default(20_000),
  WALLET_LEDGER_SYNC_CONCURRENCY: z.coerce.number().default(3),
  WALLET_LEDGER_SYNC_RETRY_BASE_MS: z.coerce.number().default(5_000),
  WALLET_LEDGER_SYNC_RETRY_MAX_MS: z.coerce.number().default(300_000),
  WALLET_LEDGER_SYNC_MAX_ATTEMPTS: z.coerce.number().default(5),
  WALLET_LEDGER_BACKFILL_DAYS: z.coerce.number().default(90),
  /** Перекрытие: история обновляется позже сокета. */
  WALLET_LEDGER_OVERLAP_MS: z.coerce.number().default(600_000),

  /** Токен бота Telegram для уведомлений радара. Получить у @BotFather. */
  TELEGRAM_BOT_TOKEN: optional(z.string()),
  /** Отдельный выключатель paper-уведомлений автономного агента. */
  TELEGRAM_AGENT_NOTIFICATIONS_ENABLED: booleanFromEnv.default(false),
  /** Единственный административный чат Phase 2. Никогда не отдаётся клиенту. */
  TELEGRAM_AGENT_CHAT_ID: optional(z.string()),

  /** Порог ликвидности, ниже которого радар не уведомляет вообще. */
  RADAR_MIN_LIQUIDITY_USD: z.coerce.number().default(20_000),

  JUPITER_API_URL: z.string().url().default('https://quote-api.jup.ag/v6'),
  ZEROX_API_URL: z.string().url().default('https://api.0x.org'),
  ZEROX_API_KEY: optional(z.string()),
  EXECUTION_MODE: z.enum(['paper', 'live']).default('paper'),

  /**
   * Приём реальных пополнений.
   *
   * Выключено, и включать нельзя до решения по подписи транзакций.
   * Пока приватные ключи пользователей лежат на сервере под ключом,
   * которым тоже управляет сервер, принятые средства охраняются
   * ровно одним секретом. Пополнение при таком устройстве означает,
   * что платформа собрала чужие деньги в одну точку отказа.
   *
   * Проверка ниже не даёт включить признак вместе с боевым режимом
   * и локальным KMS.
   */
  FUNDING_ENABLED: booleanFromEnv.default(false),
  /** Future LIVE agent. All three switches are false by default. */
  LIVE_AGENT_ENABLED: booleanFromEnv.default(false),
  LIVE_EXECUTION_ENABLED: booleanFromEnv.default(false),
  WITHDRAWALS_ENABLED: booleanFromEnv.default(false),
  /** Operator readiness gates. They are not client-visible controls. */
  LIVE_RPC_READY: booleanFromEnv.default(false),
  LIVE_RECONCILIATION_ENABLED: booleanFromEnv.default(false),
  LIVE_MIGRATIONS_READY: booleanFromEnv.default(false),
  /**
   * Устаревший флаг. Читается только слоем совместимости ниже.
   *
   * Он означал «LIVE-контур готов» в те времена, когда контура
   * подписи не существовало. Сегодня подписью управляет
   * `SOLANA_SIGNING_ENABLED`, а этот флаг остался в Render и в
   * production-примерах — то есть в тех самых местах, где ошибка
   * дороже всего.
   *
   * Умолчания нет намеренно: `undefined` отличается от `false`.
   * Первое — «переменной нет», второе — «старое окружение явно
   * сказало нет». Слить их значило бы потерять единственный
   * признак, по которому видно, что окружение пора чистить.
   */
  KMS_SIGNING_ENABLED: optional(booleanFromEnv),
  LIVE_AGENT_CONTROL_MODE: z.enum(['semi-auto', 'auto']).default('semi-auto'),
  /** Phase 4 deposit reader. It remains inert while FUNDING_ENABLED=false. */
  SOLANA_DEPOSIT_SOURCE: z.enum(['disabled', 'rpc']).default('disabled'),
  SOLANA_DEPOSIT_BOOTSTRAP_SLOT: optional(z.string().regex(/^\d+$/)),
  SOLANA_DEPOSIT_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  SOLANA_DEPOSIT_OVERLAP_SLOTS: z.coerce.number().int().min(64).max(100_000).default(512),
  SOLANA_DEPOSIT_RPC_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  SOLANA_DEPOSIT_SIGNATURE_PAGE_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
  SOLANA_DEPOSIT_MAX_PAGES: z.coerce.number().int().min(1).max(100).default(10),
  SOLANA_DEPOSIT_MAX_TRANSACTIONS: z.coerce.number().int().min(1).max(5_000).default(250),
  /**
   * Насколько глубоко просматривается адрес, который не сверялся ни разу.
   *
   * Общий checkpoint не отвечает за кошелёк, заведённый после того,
   * как он сдвинулся. Окно ограничено: неограниченная история либо
   * исчерпает бюджет страниц, либо остановится на середине.
   */
  SOLANA_DEPOSIT_NEW_ADDRESS_LOOKBACK_SLOTS: z.coerce
    .number().int().min(1_000).max(10_000_000).default(216_000),

  /**
   * Ожидаемая сеть Solana.
   *
   * Отдельно от `SOLANA_RPC_URL`, потому что URL ничего не доказывает:
   * платный endpoint выглядит одинаково для devnet и mainnet, а имя
   * хоста может быть каким угодно. Настоящая проверка — genesis hash.
   */
  SOLANA_NETWORK: z.enum(['devnet', 'testnet', 'mainnet-beta']).default('devnet'),
  /**
   * Genesis hash, которому обязана соответствовать сеть.
   *
   * Пустое значение означает «сверять со встроенным списком».
   * Оператор может задать значение сам, если доверяет своему
   * `solana genesis-hash` больше, чем константе в коде.
   */
  SOLANA_EXPECTED_GENESIS_HASH: optional(z.string().min(32).max(64)),
  /** Сверка зачислений с цепочкой. Инертна при FUNDING_ENABLED=false. */
  SOLANA_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(120_000),
  SOLANA_RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  /**
   * Тестовый SPL-токен devnet.
   *
   * Нужен потому, что канонического USDC в devnet не существует:
   * его адрес принадлежит mainnet. В боевой список разрешённых
   * активов этот токен не попадает никогда — он живёт отдельным
   * параметром и в любой сети кроме devnet запрещён на старте.
   */
  SOLANA_DEVNET_TEST_MINT: optional(z.string().min(32).max(64)),
  SOLANA_DEVNET_TEST_MINT_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),
  /** Ожидаемая активность адреса. Нужна для расчёта бюджета просмотра. */
  SOLANA_EXPECTED_SIGNATURES_PER_HOUR: z.coerce.number().int().min(0).max(100_000).default(20),

  // ─── Подпись транзакций Solana (Phase 4D) ──────────────────────────
  //
  // Подпись отделена от отправки. Ничего из перечисленного ниже
  // не включает broadcast: транспорта отправки в контуре нет.
  /** Провайдер подписи. `unavailable` — честный отказ, а не заглушка. */
  SOLANA_SIGNER_PROVIDER: z.enum(['unavailable', 'aws-kms', 'gcp-kms']).default('unavailable'),
  /** Идентификатор ключа. Наружу за пределы сервера не выходит. */
  SOLANA_SIGNER_KEY_ID: optional(z.string().min(1).max(512)),
  SOLANA_SIGNER_KEY_VERSION: optional(z.string().min(1).max(64)),
  /**
   * Публичный ключ кошелька в base58.
   *
   * Сверяется с тем, что отдаёт KMS. Расхождение означает, что
   * подпись пойдёт с чужого адреса, и это повод не стартовать.
   */
  SOLANA_SIGNER_WALLET_PUBLIC_KEY: optional(z.string().min(32).max(64)),
  /** Разрешение подписывать. Отправку не включает и включить не может. */
  SOLANA_SIGNING_ENABLED: booleanFromEnv.default(false),
  /**
   * Регион AWS.
   *
   * Учётных данных здесь нет и не будет: их находит стандартная
   * цепочка SDK. Секрет, прошедший через конфигурацию приложения,
   * рано или поздно окажется в журнале запуска.
   */
  AWS_REGION: optional(z.string().min(2).max(32)),
  /**
   * Адрес devnet-узла для проверки сети и получения blockhash.
   *
   * Отдельно от `SOLANA_RPC_URL`, у которого значение по умолчанию
   * указывает на mainnet. Значение по умолчанию здесь однажды
   * отправило бы подпись в боевую сеть, поэтому его нет.
   *
   * Наружу не выходит: путь и query могут содержать API-ключ.
   */
  SOLANA_PREFLIGHT_RPC_URL: optional(z.string().url()),
  /**
   * Ожидаемый адрес Solana подписывающего ключа.
   *
   * Задаётся человеком отдельно от базы и служит независимым
   * свидетелем: если и база, и KMS изменились согласованно, это
   * единственное, что заметит подмену.
   */
  AWS_KMS_EXPECTED_PUBLIC_KEY: optional(z.string().min(32).max(64)),
  /**
   * Разрешение на настоящий вызов Sign в preflight.
   *
   * Отдельно от разрешения подписывать: проверка узла и подпись
   * боевого намерения — разные решения, и включать их одним флагом
   * значит однажды подписать, собираясь только проверить.
   */
  KMS_PREFLIGHT_ALLOW_SIGN: booleanFromEnv.default(false),

  // ─── Почта ─────────────────────────────────────────────────────────
  //
  // Подтверждение адреса — обязательный шаг перед бесплатным периодом,
  // поэтому неработающая доставка равна неработающей регистрации.
  // Умолчание `disabled` выбрано намеренно: приложение, поднятое без
  // настроек, честно отвечает «доставка не настроена», а не делает
  // вид, что письма уходят.

  /** disabled | console | resend | smtp. */
  EMAIL_PROVIDER: z.enum(['disabled', 'console', 'resend', 'smtp']).default('disabled'),
  /** Отправитель: «Имя <адрес@домен>» либо просто адрес. */
  EMAIL_FROM: z.string().optional(),
  /** Ключ Resend. В журнал и в ответы не попадает никогда. */
  RESEND_API_KEY: z.string().optional(),
  /** SMTP, в том числе Gmail с отдельным паролем приложения. */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(465),
  SMTP_SECURE: booleanFromEnv.default(true),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** Публичное имя продукта. Уходит в тему письма. */
  PUBLIC_APP_NAME: z.string().default('Memex DEX'),
  /** Публичный адрес приложения. Нужен ссылкам в письмах, если появятся. */
  PUBLIC_APP_URL: z.string().optional(),

  // ─── Оплата подписок через Bridge ──────────────────────────────────
  //
  // Выключено по умолчанию. Каталог тарифов при этом работает:
  // посмотреть цены можно и без возможности заплатить, а вот
  // показать кнопку оплаты, за которой ничего нет, нельзя.
  //
  // Это выручка платформы, а не пополнение торгового кошелька
  // (FUNDING_ENABLED) — два разных денежных потока с разными
    // правилами и разными последствиями.

  BRIDGE_PAYMENTS_ENABLED: booleanFromEnv.default(false),
  BRIDGE_API_KEY: z.string().optional(),
  BRIDGE_API_BASE_URL: z.string().default('https://api.bridge.xyz/v0'),
  /** Открытый ключ конкретного webhook-адреса. Выдаётся при его включении. */
  BRIDGE_WEBHOOK_PUBLIC_KEY: z.string().optional(),
  /** Куда Bridge присылает USDC. Единственный адрес выручки. */
  SUBSCRIPTION_TREASURY_SOLANA_ADDRESS: z.string().optional(),
  /** Насколько старое событие ещё принимается. */
  BRIDGE_WEBHOOK_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),

  // ─── Оплата подписок: выбор провайдера ─────────────────────────────
  //
  // Провайдер выбирается сервером, а не клиентом. Строка из браузера
  // определяла бы, чьи правила проверки применить к деньгам, —
  // а это ровно то решение, которое пользователю не принадлежит.
  //
  // Одновременно активным может быть только один: два включённых
  // означали бы платежи в двух местах и вопрос «какой из них
  // настоящий» при первом же расхождении.
  SUBSCRIPTION_PAYMENT_PROVIDER: z.enum(['disabled', 'bridge', 'coinbase']).default('disabled'),

  // ─── Coinbase Onramp ───────────────────────────────────────────────
  COINBASE_ONRAMP_ENABLED: booleanFromEnv.default(false),
  /** Песочница и боевая среда — разные адреса и разные деньги. */
  COINBASE_ONRAMP_MODE: z.enum(['sandbox', 'production']).default('sandbox'),
  COINBASE_CDP_API_KEY_ID: z.string().optional(),
  /** Закрытый ключ: PEM для P-256 либо base64 для Ed25519. */
  COINBASE_CDP_API_KEY_SECRET: z.string().optional(),
  /** Секрет подписи вебхука. Выдаётся при создании подписки. */
  COINBASE_WEBHOOK_SECRET: z.string().optional(),
  /** Куда возвращается человек. Домен должен быть в списке Coinbase. */
  COINBASE_REDIRECT_URL: z.string().optional(),
  /** Насколько старое событие ещё принимается. Пять минут по документации. */
  COINBASE_WEBHOOK_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  /**
   * Адрес, подставляемый вместо настоящего в песочнице.
   *
   * Документация разрешает тестовый адрес при локальной проверке.
   * В боевой среде подставлять его нельзя: по адресу провайдер
   * определяет страну и доступные способы оплаты.
   */
  COINBASE_SANDBOX_CLIENT_IP: z.string().default('192.0.2.1'),

  PERFORMANCE_FEE_BPS: z.coerce.number().default(1000),
  PLATFORM_SWAP_FEE_BPS: z.coerce.number().default(0),
  /**
   * Комиссия за вывод средств. Отдельная от комиссии за успех: та берётся
   * с прибыли по копируемым сделкам, эта — с суммы вывода независимо от
   * результата. Человек, потерявший деньги на торговле, платит её тоже,
   * поэтому размер удержания показывается до подтверждения, а не после.
   */
  WITHDRAWAL_FEE_BPS: z.coerce.number().min(0).max(10_000).default(500),
  MAX_SLIPPAGE_BPS: z.coerce.number().default(300),
  MIN_LIQUIDITY_USD: z.coerce.number().default(15_000),
  COPY_MAX_ALLOCATION_PCT: z.coerce.number().default(25),
});

// Значения из веб-панелей деплоя регулярно приезжают с хвостовым пробелом
// или переводом строки — их не видно глазом, но валидатор url на них падает
// с сообщением, которое никак не намекает на причину.
const rawEnv: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(process.env)) {
  rawEnv[key] = typeof value === 'string' ? value.trim() : value;
}

const parsed = schema.safeParse(rawEnv);

if (!parsed.success) {
  const errors = parsed.error.flatten().fieldErrors;

  console.error('\nНекорректная конфигурация окружения:\n');
  for (const [key, messages] of Object.entries(errors)) {
    const value = rawEnv[key];
    // Различаем «не задана» и «задана неверно»: это принципиально разные
    // причины, а сообщения валидатора для них почти одинаковы.
    const state =
      value === undefined
        ? 'переменная не задана'
        : value === ''
          ? 'переменная пуста'
          : `текущее значение начинается с «${value.slice(0, 24)}…»`;
    console.error(`  ${key}: ${messages?.join(', ')}`);
    console.error(`    ${state}\n`);
  }

  if (process.env.NODE_ENV === 'production') {
    console.error(
      'Задайте недостающие переменные в панели хостинга:\n' +
        '  Render:  сервис → Environment → Add Environment Variable\n' +
        '  Railway: сервис → Variables\n',
    );
  } else {
    console.error('Проверьте .env в корне проекта. Если файла нет — выполните: npm run setup\n');
  }
  process.exit(1);
}

// PORT от платформы имеет приоритет над API_PORT из конфигурации.
export const env = {
  ...parsed.data,
  API_PORT: parsed.data.PORT ?? parsed.data.API_PORT,

  // Приведение двух написаний ключей OKX к одному. Сведение делается
  // здесь и один раз: если бы каждый потребитель проверял оба имени
  // сам, рано или поздно один из них проверил бы только одно.
  OKX_API_SECRET: parsed.data.OKX_API_SECRET ?? parsed.data.OKX_SECRET_KEY,
  OKX_PASSPHRASE: parsed.data.OKX_PASSPHRASE ?? parsed.data.OKX_API_PASSPHRASE,
};

// Предохранитель: боевой режим с локальным KMS — это утечка ключей,
// ждущая своего часа. Мастер-ключ в переменной окружения означает, что
// дамп окружения равен доступу ко всем средствам пользователей.
/*
 * Почта: настройки должны быть согласованы до первого запроса.
 *
 * Выбранный провайдер без ключа или без отправителя — это приложение,
 * которое обещает отправить письмо и не может. Обнаружить такое лучше
 * при старте, чем по жалобе человека, который ждёт код десять минут.
 */
if (env.EMAIL_PROVIDER === 'resend') {
  const missing = [
    !env.RESEND_API_KEY ? 'RESEND_API_KEY' : null,
    !env.EMAIL_FROM ? 'EMAIL_FROM' : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `EMAIL_PROVIDER=resend требует ${missing.join(' и ')}. ` +
        'Без них приложение сообщало бы об отправленных письмах, которых нет.',
    );
  }
}

if (env.EMAIL_PROVIDER === 'smtp') {
  const missing = [
    !env.SMTP_HOST ? 'SMTP_HOST' : null,
    !env.SMTP_USER ? 'SMTP_USER' : null,
    !env.SMTP_PASS ? 'SMTP_PASS' : null,
    !env.EMAIL_FROM ? 'EMAIL_FROM' : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `EMAIL_PROVIDER=smtp требует ${missing.join(', ')}. ` +
        'Основной пароль почты использовать нельзя: нужен отдельный пароль приложения.',
    );
  }
}

if (env.TELEGRAM_AGENT_NOTIFICATIONS_ENABLED) {
  const missing = [
    !env.TELEGRAM_BOT_TOKEN ? 'TELEGRAM_BOT_TOKEN' : null,
    !env.TELEGRAM_AGENT_CHAT_ID ? 'TELEGRAM_AGENT_CHAT_ID' : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `TELEGRAM_AGENT_NOTIFICATIONS_ENABLED=true требует ${missing.join(' и ')}. ` +
        'Paper-агент не стартует с частично настроенной доставкой.',
    );
  }
}

/*
 * Оплата подписок: настройки должны быть полными до первого запроса.
 *
 * Включённый модуль без ключа, без открытого ключа вебхука или без
 * адреса казначейства — это приложение, которое возьмёт деньги
 * и не сможет ни подтвердить платёж, ни доставить его по назначению.
 * Обнаружить такое надо при старте.
 */
if (env.BRIDGE_PAYMENTS_ENABLED) {
  const missing = [
    !env.BRIDGE_API_KEY ? 'BRIDGE_API_KEY' : null,
    !env.BRIDGE_WEBHOOK_PUBLIC_KEY ? 'BRIDGE_WEBHOOK_PUBLIC_KEY' : null,
    !env.SUBSCRIPTION_TREASURY_SOLANA_ADDRESS ? 'SUBSCRIPTION_TREASURY_SOLANA_ADDRESS' : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `BRIDGE_PAYMENTS_ENABLED=true требует ${missing.join(', ')}. ` +
        'Без них платёж некуда доставить и нечем подтвердить.',
    );
  }

  // Адрес Solana — 32 байта в base58. Проверка формы, а не
  // существования: опечатка в адресе казначейства означает деньги,
  // ушедшие в никуда без возможности вернуть.
  const address = env.SUBSCRIPTION_TREASURY_SOLANA_ADDRESS!;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    throw new Error(
      'SUBSCRIPTION_TREASURY_SOLANA_ADDRESS не похож на адрес Solana. ' +
        'Опечатка здесь означает выручку, ушедшую в никуда.',
    );
  }
}

/*
 * Coinbase Onramp: настройки должны быть полными и согласованными.
 */
if (env.COINBASE_ONRAMP_ENABLED) {
  const missing = [
    !env.COINBASE_CDP_API_KEY_ID ? 'COINBASE_CDP_API_KEY_ID' : null,
    !env.COINBASE_CDP_API_KEY_SECRET ? 'COINBASE_CDP_API_KEY_SECRET' : null,
    !env.COINBASE_WEBHOOK_SECRET ? 'COINBASE_WEBHOOK_SECRET' : null,
    !env.COINBASE_REDIRECT_URL ? 'COINBASE_REDIRECT_URL' : null,
    !env.SUBSCRIPTION_TREASURY_SOLANA_ADDRESS ? 'SUBSCRIPTION_TREASURY_SOLANA_ADDRESS' : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `COINBASE_ONRAMP_ENABLED=true требует ${missing.join(', ')}. ` +
        'Без них платёж некуда доставить, нечем подтвердить и некуда вернуть человека.',
    );
  }

  const address = env.SUBSCRIPTION_TREASURY_SOLANA_ADDRESS!;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    throw new Error(
      'SUBSCRIPTION_TREASURY_SOLANA_ADDRESS не похож на адрес Solana. ' +
        'Опечатка здесь означает выручку, ушедшую в никуда.',
    );
  }

  if (env.NODE_ENV === 'production') {
    // Песочница в боевой среде — самая дорогая из возможных опечаток:
    // страница оплаты принимает тестовые карты, а подписка выдаётся
    // настоящая.
    if (env.COINBASE_ONRAMP_MODE !== 'production') {
      throw new Error(
        'COINBASE_ONRAMP_MODE=sandbox в production запрещён: тестовые карты ' +
          'выдавали бы настоящие подписки.',
      );
    }

    const redirect = env.COINBASE_REDIRECT_URL!;
    if (!/^https:\/\//.test(redirect)) {
      throw new Error('COINBASE_REDIRECT_URL в production обязан быть https.');
    }

    if (/localhost|127\.0\.0\.1|sandbox/i.test(redirect)) {
      throw new Error(
        'COINBASE_REDIRECT_URL в production не может указывать на localhost или песочницу.',
      );
    }

    if (/sandbox|test/i.test(env.COINBASE_CDP_API_KEY_ID ?? '')) {
      throw new Error('COINBASE_CDP_API_KEY_ID выглядит тестовым, а среда боевая.');
    }
  }
}

/*
 * Активный провайдер оплаты ровно один.
 *
 * Две включённые интеграции означали бы два места, куда приходят
 * деньги, и вопрос «какое из них настоящее» при первом расхождении.
 */
if (
  env.SUBSCRIPTION_PAYMENT_PROVIDER === 'bridge' &&
  !env.BRIDGE_PAYMENTS_ENABLED
) {
  throw new Error(
    'SUBSCRIPTION_PAYMENT_PROVIDER=bridge требует BRIDGE_PAYMENTS_ENABLED=true.',
  );
}

if (
  env.SUBSCRIPTION_PAYMENT_PROVIDER === 'coinbase' &&
  !env.COINBASE_ONRAMP_ENABLED
) {
  throw new Error(
    'SUBSCRIPTION_PAYMENT_PROVIDER=coinbase требует COINBASE_ONRAMP_ENABLED=true.',
  );
}

if (env.NODE_ENV === 'production' && env.EMAIL_PROVIDER === 'console') {
  throw new Error(
    'EMAIL_PROVIDER=console в production запрещён. Этот транспорт пишет письмо ' +
      'в журнал вместо отправки: пользователь никогда не получит код, ' +
      'а API отчитается об успехе.',
  );
}

if (env.NODE_ENV === 'production' && env.KMS_PROVIDER === 'local' && env.FUNDING_ENABLED) {
  throw new Error(
    'FUNDING_ENABLED=true запрещён при KMS_PROVIDER=local. ' +
      'Приём чужих средств на кошельки, ключи от которых лежат рядом с приложением, ' +
      'означает единственную точку отказа для всех денег пользователей. ' +
      'Сначала policy-bound signing, см. docs/custody.md.',
  );
}

if (env.NODE_ENV === 'production' && env.KMS_PROVIDER === 'local' && env.EXECUTION_MODE === 'live') {
  throw new Error(
    'KMS_PROVIDER=local запрещён при EXECUTION_MODE=live. ' +
      'Мастер-ключ в переменной окружения означает, что дамп окружения ' +
      'равен доступу ко всем средствам пользователей. Используйте aws-kms или gcp-kms.',
  );
}

const phase4NetworkRequested =
  env.FUNDING_ENABLED ||
  env.LIVE_AGENT_ENABLED ||
  env.LIVE_EXECUTION_ENABLED ||
  env.WITHDRAWALS_ENABLED;
const phase4LiveRequested =
  env.LIVE_AGENT_ENABLED || env.LIVE_EXECUTION_ENABLED || env.WITHDRAWALS_ENABLED;

if (phase4LiveRequested && env.EXECUTION_MODE !== 'live') {
  throw new Error('LIVE Agent нельзя включить при EXECUTION_MODE=paper.');
}

if (phase4LiveRequested && env.KMS_PROVIDER === 'local') {
  throw new Error('LIVE Agent нельзя включить с KMS_PROVIDER=local.');
}

if (phase4NetworkRequested) {
  const missing = [
    !env.LIVE_RPC_READY ? 'LIVE_RPC_READY' : null,
    !env.LIVE_RECONCILIATION_ENABLED ? 'LIVE_RECONCILIATION_ENABLED' : null,
    !env.LIVE_MIGRATIONS_READY ? 'LIVE_MIGRATIONS_READY' : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `Сетевые денежные операции требуют ${missing.join(', ')}. ` +
        'Флаги готовности должны подтверждаться отдельными startup checks.',
    );
  }
}

/*
 * Тестовый токен devnet не существует нигде, кроме devnet.
 *
 * Проверка на старте, а не в месте использования: параметр,
 * задаваемый переменной окружения, рано или поздно окажется
 * скопирован в боевую конфигурацию вместе с остальным блоком.
 * Тогда платформа начнёт принимать нарисованную монету как деньги,
 * и заметить это можно будет только по балансам.
 */
if (env.SOLANA_DEVNET_TEST_MINT && env.SOLANA_NETWORK !== 'devnet') {
  throw new Error(
    'SOLANA_DEVNET_TEST_MINT допустим только при SOLANA_NETWORK=devnet. ' +
      'Тестовый токен не является средством платежа.',
  );
}

if (env.SOLANA_DEVNET_TEST_MINT && env.NODE_ENV === 'production') {
  throw new Error(
    'SOLANA_DEVNET_TEST_MINT запрещён в production независимо от сети.',
  );
}

/*
 * Подпись включается только с проверенным провайдером.
 *
 * Проверки идут списком, а не первой найденной: оператор, чинящий
 * их по одной, узнаёт о следующей только после перезапуска.
 */
if (env.SOLANA_SIGNING_ENABLED) {
  /*
   * Боевая сеть отвергается первой — до всех проверок полноты.
   *
   * Порядок здесь и есть защита. Сообщение «требуется AWS_REGION»
   * читается как «допиши регион и заработает», и оператор допишет —
   * а следующим отказом будет уже не отказ. Правильная реакция на
   * mainnet: не чинить конфигурацию, а вернуть сеть.
   *
   * Раньше эта проверка стояла ниже, внутри чужого блока и после
   * `throw`, то есть не выполнялась никогда.
   */
  if (env.SOLANA_NETWORK === 'mainnet-beta') {
    throw new Error('Подпись mainnet на текущем этапе запрещена.');
  }

  const blockers = [
    env.SOLANA_SIGNER_PROVIDER === 'unavailable' ? 'SOLANA_SIGNER_PROVIDER' : null,
    !env.SOLANA_SIGNER_KEY_ID ? 'SOLANA_SIGNER_KEY_ID' : null,
    !env.SOLANA_SIGNER_KEY_VERSION ? 'SOLANA_SIGNER_KEY_VERSION' : null,
    !env.SOLANA_SIGNER_WALLET_PUBLIC_KEY ? 'SOLANA_SIGNER_WALLET_PUBLIC_KEY' : null,
  ].filter(Boolean);

  if (blockers.length > 0) {
    throw new Error(
      `SOLANA_SIGNING_ENABLED=true требует: ${blockers.join(', ')}. ` +
        'Подписывать неизвестно каким ключом запрещено.',
    );
  }

  /*
   * `KMS_PROVIDER` здесь больше не проверяется — и это не ослабление.
   *
   * Он относится к custody encryption: чем зашифрован сохранённый
   * key material в `crypto.ts`. К подписи транзакций Solana он не
   * имеет отношения — там приватного ключа у нас нет вовсе, он
   * не покидает облачный HSM. Общее слово «KMS» в названии не
   * делает эти понятия одним.
   *
   * Требовать production-custody ради devnet-подписи значило бы
   * научить оператора обходить непонятный запрет, а заодно скрыть
   * настоящее условие. Настоящее — ниже: провайдер подписи выбран,
   * ключ задан, сеть devnet. Custody-провайдер остаётся условием
   * для LIVE и для приёма средств, где ему и место.
   */
  if (env.SOLANA_SIGNER_PROVIDER === 'unavailable') {
    throw new Error(
      'SOLANA_SIGNING_ENABLED=true требует SOLANA_SIGNER_PROVIDER. ' +
        'Локальным ключом контур подписи не работает.',
    );
  }

  // AWS без региона не найдёт даже endpoint: отказать на старте
  // честнее, чем упасть на первой подписи.
  if (env.SOLANA_SIGNER_PROVIDER === 'aws-kms' && !env.AWS_REGION) {
    throw new Error('SOLANA_SIGNER_PROVIDER=aws-kms требует AWS_REGION.');
  }

  /*
   * Подпись требует проверенной сети.
   *
   * Без адреса devnet blockhash взять неоткуда, а без blockhash
   * подписывать нечего: намерение будет собрано над значением,
   * которого в сети не существует.
   */
  if (!env.SOLANA_PREFLIGHT_RPC_URL) {
    throw new Error(
      'SOLANA_SIGNING_ENABLED=true требует SOLANA_PREFLIGHT_RPC_URL: ' +
        'blockhash берётся только из проверенной сети.',
    );
  }

  // Выводы и подпись не включаются одной рукой: это разные решения
  // с разной ценой ошибки.
  if (env.WITHDRAWALS_ENABLED) {
    throw new Error('SOLANA_SIGNING_ENABLED=true запрещён при включённых выводах.');
  }
}

/*
 * Настоящий Sign в preflight требует настроенной подписи.
 *
 * Иначе флаг «разрешаю подписать при проверке» включал бы подпись
 * в обход всех условий, поставленных выше.
 */
if (env.KMS_PREFLIGHT_ALLOW_SIGN && !env.SOLANA_SIGNING_ENABLED) {
  throw new Error('KMS_PREFLIGHT_ALLOW_SIGN=true требует SOLANA_SIGNING_ENABLED=true.');
}

if (env.KMS_PREFLIGHT_ALLOW_SIGN && env.SOLANA_NETWORK !== 'devnet') {
  throw new Error('KMS_PREFLIGHT_ALLOW_SIGN=true допустим только в devnet.');
}

if (env.FUNDING_ENABLED && env.SOLANA_DEPOSIT_SOURCE !== 'rpc') {
  throw new Error('FUNDING_ENABLED=true требует SOLANA_DEPOSIT_SOURCE=rpc.');
}

if (env.FUNDING_ENABLED && !env.SOLANA_DEPOSIT_BOOTSTRAP_SLOT) {
  throw new Error(
    'FUNDING_ENABLED=true требует явный SOLANA_DEPOSIT_BOOTSTRAP_SLOT. ' +
      'Автоматический backfill с нулевого слота запрещён.',
  );
}

/*
 * Слой совместимости со старым флагом. Единственное место, где он
 * вообще читается.
 *
 * Тихий alias был бы худшим из решений: в Render стоит
 * `KMS_SIGNING_ENABLED=false`, и превращение его в синоним нового
 * флага сегодня ничего не сломает, а завтра, когда кто-то поставит
 * `true`, включит подпись в окружении, которое об этом не просило.
 *
 * Поэтому `false` и отсутствие проходят молча, а `true` — это
 * остановка с объяснением, куда переехала настройка.
 */
const legacySigningVerdict = legacySigningFlagVerdict({
  legacyValue: env.KMS_SIGNING_ENABLED,
  canonicalValue: env.SOLANA_SIGNING_ENABLED,
});

if (legacySigningVerdict === 'REFUSED') {
  throw new Error(LEGACY_SIGNING_FLAG_MESSAGE);
}

/*
 * Структура флагов проверяется раньше их возможностей.
 *
 * «Выводы без исполнителя» — ошибка построения конфигурации, а
 * «нужен контур подписи» — отсутствие возможности. Сообщить второе
 * первым значит отправить оператора настраивать подпись для
 * комбинации, которая всё равно не имеет смысла.
 */
if (env.LIVE_EXECUTION_ENABLED && !env.LIVE_AGENT_ENABLED) {
  throw new Error('LIVE_EXECUTION_ENABLED требует LIVE_AGENT_ENABLED=true.');
}

if (env.WITHDRAWALS_ENABLED && !env.LIVE_EXECUTION_ENABLED) {
  throw new Error('WITHDRAWALS_ENABLED требует LIVE_EXECUTION_ENABLED=true.');
}

/*
 * Единственная запись правила «отправка требует контура подписи».
 *
 * Раньше таких записей было две: одна здесь по старому флагу и одна
 * ниже, за общим блокером, «на будущее». После перевода обеих на
 * канонический флаг они стали одним и тем же условием, записанным
 * дважды. Второе удалено: дубликат правила — это будущее
 * расхождение, ровно то, из-за чего и затевалась эта работа.
 */
if ((env.LIVE_EXECUTION_ENABLED || env.WITHDRAWALS_ENABLED) && !env.SOLANA_SIGNING_ENABLED) {
  throw new Error(
    'LIVE execution и withdrawals требуют SOLANA_SIGNING_ENABLED=true. ' +
      'Раньше здесь проверялся KMS_SIGNING_ENABLED — флаг, который ' +
      'не управляет подписью транзакций.',
  );
}

if (env.LIVE_AGENT_CONTROL_MODE === 'auto') {
  throw new Error('Полный Auto в Phase 4 запрещён. Доступен только Semi-Auto.');
}

// A read-only Solana deposit source now exists, but it has not passed live RPC
// validation and the reconciliation scheduler, confirmation transport and
// production KMS adapters are still absent. No combination of optimistic env
// flags may turn this partial path into a money path.
if (phase4NetworkRequested) {
  throw new Error(
    'Phase 4 network adapters are not implemented. FUNDING/LIVE/WITHDRAWALS must remain false.',
  );
}

if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.length === 0) {
  console.warn(
    '\nCORS_ORIGINS не задан — в production фронтенд не сможет обращаться к API.\n' +
      'Укажите адрес веб-приложения, например: CORS_ORIGINS=https://memex.up.railway.app\n',
  );
}
