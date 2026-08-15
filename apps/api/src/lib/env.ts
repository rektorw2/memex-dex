import { z } from 'zod';
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
   * Учётные данные Web3 API OKX для радара новых токенов.
   * Регистрация бесплатна: web3.okx.com → Developer Portal.
   * Без них радар работает на бесплатном источнике GeckoTerminal.
   */
  OKX_API_KEY: optional(z.string()),
  OKX_API_SECRET: optional(z.string()),
  OKX_PASSPHRASE: optional(z.string()),
  OKX_PROJECT_ID: optional(z.string()),

  /** Токен бота Telegram для уведомлений радара. Получить у @BotFather. */
  TELEGRAM_BOT_TOKEN: optional(z.string()),

  /** Порог ликвидности, ниже которого радар не уведомляет вообще. */
  RADAR_MIN_LIQUIDITY_USD: z.coerce.number().default(20_000),

  JUPITER_API_URL: z.string().url().default('https://quote-api.jup.ag/v6'),
  ZEROX_API_URL: z.string().url().default('https://api.0x.org'),
  ZEROX_API_KEY: optional(z.string()),
  EXECUTION_MODE: z.enum(['paper', 'live']).default('paper'),

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
};

// Предохранитель: боевой режим с локальным KMS — это утечка ключей,
// ждущая своего часа. Мастер-ключ в переменной окружения означает, что
// дамп окружения равен доступу ко всем средствам пользователей.
if (env.NODE_ENV === 'production' && env.KMS_PROVIDER === 'local' && env.EXECUTION_MODE === 'live') {
  throw new Error(
    'KMS_PROVIDER=local запрещён при EXECUTION_MODE=live. ' +
      'Мастер-ключ в переменной окружения означает, что дамп окружения ' +
      'равен доступу ко всем средствам пользователей. Используйте aws-kms или gcp-kms.',
  );
}

if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.length === 0) {
  console.warn(
    '\nCORS_ORIGINS не задан — в production фронтенд не сможет обращаться к API.\n' +
      'Укажите адрес веб-приложения, например: CORS_ORIGINS=https://memex.up.railway.app\n',
  );
}
