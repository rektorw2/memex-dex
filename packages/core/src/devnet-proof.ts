/**
 * Доказательство того, что узел devnet проверен.
 *
 * Файл появился из-за одной строки:
 *
 *     networkVerified: Boolean(env.SOLANA_PREFLIGHT_RPC_URL)
 *
 * Она означала «переменная задана», а читалась как «сеть проверена».
 * Наличие строки с адресом не доказывает ничего: узел может не
 * отвечать, оказаться mainnet, не поддерживать нужные методы, быть
 * заменён после проверки — или проверки могло не быть вовсе. Строка
 * при этом остаётся на месте и продолжает выглядеть подтверждением.
 *
 * Здесь описано, что считается доказательством и когда оно перестаёт
 * им быть. Правило одно и оно жёсткое: **отсутствие проверки — это не
 * успех**. `NOT_RUN` никогда не даёт `verified`, и никакая настройка
 * не может его поднять.
 *
 * Чего здесь нет и не будет: адреса узла, query-строки, заголовков,
 * учётных данных, идентификатора ключа KMS и тел ответов RPC. Наружу
 * идут имя сети, публичный genesis hash, отпечаток конфигурации, время
 * и машинные коды. Отпечаток — односторонняя функция от настройки:
 * по нему видно, что endpoint сменился, но не видно, на какой.
 */

export const DEVNET_PROOF_FORMAT_VERSION = 1;

/**
 * Срок годности доказательства.
 *
 * Тридцать минут — не «сколько живёт узел», а «как долго вчерашний
 * ответ ещё что-то говорит о сегодняшнем состоянии». Провайдер может
 * сменить тариф, упереться в предел частоты или отключить архив, и
 * ничего из этого не оставляет следа в конфигурации.
 *
 * Срок намеренно короткий. Долгий срок превращает доказательство в ту
 * же переменную окружения, только записанную в базу: однажды
 * проверили — и с тех пор «проверено».
 */
export const DEVNET_PROOF_TTL_MS = 30 * 60 * 1000;

/**
 * Методы, без которых узел непригоден.
 *
 * `getHealth` и `getGenesisHash` отвечают на вопрос «жив ли и та ли
 * это сеть». `getSlot` нужен для blockhash, `getSignaturesForAddress`
 * — для сверки зачислений. Узел без любого из них формально работает,
 * но контур на нём не работает.
 */
export const DEVNET_REQUIRED_RPC_METHODS = [
  'getHealth',
  'getGenesisHash',
  'getSlot',
  'getSignaturesForAddress',
] as const;

/**
 * Методы RPC, которых в контуре проверки быть не должно.
 *
 * Закрытый список полных имён, а не поиск подстрок. Разница не
 * стилистическая: проверка `/send|sign|simulate/i` объявляла
 * запрещённым `getSignaturesForAddress` — обычное чтение чужой
 * публичной истории, на котором держится сверка зачислений. Защита,
 * ловящая безопасное вместе с опасным, кончается тем, что её
 * ослабляют целиком.
 *
 * Сравнивать нужно полное имя метода. `sendTransaction` запрещён,
 * `getSignaturesForAddress` разрешён, и никакая общая часть строки
 * не должна их путать.
 */
export const FORBIDDEN_SOLANA_RPC_METHODS = [
  /** Отправка подписанной транзакции. Транспорта нет и не должно быть. */
  'sendTransaction',
  'sendRawTransaction',
  /*
   * Симуляция. Не двигает средств, но требует собранной транзакции,
   * а собирать её проверке узла незачем: появление такого вызова
   * означало бы, что контур проверки начал делать что-то ещё.
   */
  'simulateTransaction',
  /** Запрос средств у крана. Меняет состояние цепочки. */
  'requestAirdrop',
] as const;

export type ForbiddenSolanaRpcMethod = (typeof FORBIDDEN_SOLANA_RPC_METHODS)[number];

/** Точное совпадение имени, а не вхождение подстроки. */
export function isForbiddenSolanaRpcMethod(method: string): boolean {
  return (FORBIDDEN_SOLANA_RPC_METHODS as readonly string[]).includes(method);
}

export type DevnetProofCode =
  /** Доказательство свежее и совпадает с текущей конфигурацией. */
  | 'VERIFIED'
  /** Адрес узла не задан. Проверять нечего, и это не отказ. */
  | 'NOT_CONFIGURED'
  /** Адрес задан, но проверка ни разу не выполнялась. */
  | 'NOT_RUN'
  /** Истёк срок годности. */
  | 'EXPIRED'
  /** Сеть в доказательстве не та, которую ждёт конфигурация. */
  | 'NETWORK_CHANGED'
  /** Endpoint заменили после проверки. */
  | 'ENDPOINT_CHANGED'
  /** Genesis hash не совпал с ожидаемым для этой сети. */
  | 'GENESIS_MISMATCH'
  /** Узел оказался mainnet при devnet-конфигурации. */
  | 'MAINNET_ENDPOINT_REFUSED'
  /** Узел не поддерживает методы, без которых контур не работает. */
  | 'METHODS_UNSUPPORTED'
  /** Запись написана другой версией формата и не читается. */
  | 'FORMAT_UNSUPPORTED'
  /** Запись неполна или повреждена. */
  | 'INCOMPLETE_RECORD'
  /** Проверка выполнялась и не прошла. */
  | 'CHECK_FAILED';

/** Как записано доказательство. Ровно то, что переживает рестарт. */
export interface DevnetProofRecord {
  formatVersion: number;
  /** Сеть, как её назвала конфигурация в момент проверки. */
  network: string;
  /** Наблюдённый genesis hash. Публичное значение сети, не секрет. */
  genesisHash: string | null;
  /** Односторонний отпечаток настройки endpoint. Ни URL, ни ключа. */
  endpointFingerprint: string;
  /**
   * `VERIFIED` — проверка прошла. `FAILED` — выполнялась и не прошла.
   * `NOT_RUN` — строка заведена (например, ради аренды), но проверки
   * ещё не было. Третье значение существует, чтобы «не проверяли» не
   * пришлось записывать неудачей: это разные факты, и путать их
   * значит показывать оператору поломку там, где её нет.
   */
  outcome: string;
  /** Безопасный машинный код отказа. */
  failureCode: string | null;
  /** Какие методы RPC подтверждены ответом узла. */
  methods: string[];
  verifiedAtMs: number | null;
  expiresAtMs: number | null;
}

export interface DevnetProofExpectation {
  /** Сеть, которую ждёт конфигурация сейчас. */
  network: string;
  /** Ожидаемый genesis hash этой сети. */
  genesisHash: string;
  /**
   * Genesis основной сети — только чтобы назвать причину точнее.
   *
   * Отказ одинаков в обоих случаях; разница в том, что оператору
   * говорят. «Не тот genesis» отправляет искать опечатку, а «это
   * mainnet» называет самую вероятную и самую дорогую ошибку:
   * боевой адрес оставили в переменной, поменяв только имя сети.
   */
  mainnetGenesisHash: string | null;
  /** Отпечаток текущей настройки. `null` — endpoint не задан. */
  endpointFingerprint: string | null;
  requiredMethods: readonly string[];
  nowMs: number;
}

export interface DevnetProofVerdict {
  verified: boolean;
  code: DevnetProofCode;
  /** Сколько миллисекунд доказательство ещё годно. Null — не годно. */
  expiresInMs: number | null;
  /** Проверка была успешной, но состарилась. */
  stale: boolean;
}

function refuse(code: DevnetProofCode, stale = false): DevnetProofVerdict {
  return { verified: false, code, expiresInMs: null, stale };
}

/**
 * Годится ли записанное доказательство прямо сейчас.
 *
 * Порядок проверок — от «нечего проверять» к «проверено, но не то».
 * Он не косметический: первая же несостыковка прекращает разбор,
 * поэтому причина всегда называет самое раннее нарушенное условие,
 * а не последнее.
 */
export function evaluateDevnetProof(
  proof: DevnetProofRecord | null,
  expectation: DevnetProofExpectation,
): DevnetProofVerdict {
  if (!expectation.endpointFingerprint) return refuse('NOT_CONFIGURED');
  if (proof == null) return refuse('NOT_RUN');

  if (proof.formatVersion !== DEVNET_PROOF_FORMAT_VERSION) return refuse('FORMAT_UNSUPPORTED');

  /*
   * Отказ разбирается раньше полноты записи.
   *
   * У неудачной проверки нет ни genesis hash, ни срока годности, и
   * без этой ветки она читалась бы как «повреждённая запись» —
   * то есть как неисправность стенда вместо неисправности узла.
   */
  if (proof.outcome === 'NOT_RUN') return refuse('NOT_RUN');
  if (proof.outcome === 'FAILED') return refuse('CHECK_FAILED');
  if (proof.outcome !== 'VERIFIED') return refuse('INCOMPLETE_RECORD');

  if (!complete(proof)) return refuse('INCOMPLETE_RECORD');

  if (proof.network !== expectation.network) return refuse('NETWORK_CHANGED');
  if (proof.endpointFingerprint !== expectation.endpointFingerprint) {
    return refuse('ENDPOINT_CHANGED');
  }

  if (
    expectation.mainnetGenesisHash &&
    proof.genesisHash === expectation.mainnetGenesisHash &&
    expectation.genesisHash !== expectation.mainnetGenesisHash
  ) {
    return refuse('MAINNET_ENDPOINT_REFUSED');
  }
  if (proof.genesisHash !== expectation.genesisHash) return refuse('GENESIS_MISMATCH');

  const observed = new Set(proof.methods);
  if (expectation.requiredMethods.some((method) => !observed.has(method))) {
    return refuse('METHODS_UNSUPPORTED');
  }

  const expiresInMs = (proof.expiresAtMs as number) - expectation.nowMs;
  // Истёкшее доказательство помечается устаревшим, а не сломанным:
  // узел, возможно, в порядке — но об этом никто не знает.
  if (expiresInMs <= 0) return refuse('EXPIRED', true);

  return { verified: true, code: 'VERIFIED', expiresInMs, stale: false };
}

/**
 * Полна ли запись.
 *
 * Частичная запись — не мелочь. Успешное доказательство без срока
 * годности не истекает никогда, а без genesis hash не отличает
 * devnet от mainnet. Оба случая выглядят как «проверено».
 */
function complete(proof: DevnetProofRecord): boolean {
  if (!proof.network) return false;
  if (!proof.genesisHash) return false;
  if (!proof.endpointFingerprint) return false;
  if (proof.methods.length === 0) return false;
  if (!Number.isFinite(proof.verifiedAtMs ?? Number.NaN)) return false;
  if (!Number.isFinite(proof.expiresAtMs ?? Number.NaN)) return false;
  // Срок, истекающий раньше момента проверки, означает испорченные
  // часы или испорченную запись. И то и другое — не доказательство.
  return (proof.expiresAtMs as number) > (proof.verifiedAtMs as number);
}

/**
 * Состояние узла для человека.
 *
 * Шесть значений вместо кодов: «не настроен», «проверяется»,
 * «готов», «устарел», «не проверялся», «ошибка». Внутренние коды
 * остаются администратору — обычному человеку они не помогают и
 * заодно описывают постороннему устройство контура.
 */
export type DevnetRpcState =
  | 'NOT_CONFIGURED'
  | 'NOT_RUN'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'STALE'
  | 'FAILED';

export function devnetRpcState(code: DevnetProofCode, checkInProgress: boolean): DevnetRpcState {
  /*
   * Идущая проверка не отменяет годного доказательства.
   *
   * Показать «проверяется» вместо «готов» значило бы на минуту
   * опустить ступень лестницы, ничего при этом не узнав.
   */
  if (code === 'VERIFIED') return 'VERIFIED';
  if (checkInProgress) return 'VERIFYING';
  if (code === 'NOT_CONFIGURED') return 'NOT_CONFIGURED';
  if (code === 'NOT_RUN') return 'NOT_RUN';
  if (code === 'EXPIRED') return 'STALE';
  return 'FAILED';
}

/**
 * Можно ли начинать проверку.
 *
 * Аренда, а не блокировка в памяти: процессов может быть несколько,
 * и «уже проверяю» одного из них не видно остальным. Просроченная
 * аренда освобождается сама — иначе упавший процесс запретил бы
 * проверку навсегда.
 */
export const DEVNET_PROOF_LEASE_MS = 2 * 60 * 1000;

export function leaseHeld(leaseExpiresAtMs: number | null, nowMs: number): boolean {
  return leaseExpiresAtMs != null && leaseExpiresAtMs > nowMs;
}
