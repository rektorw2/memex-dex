import crypto from 'node:crypto';

/**
 * Подпись запросов к Coinbase Developer Platform.
 *
 * CDP принимает обычный JWT, подписанный закрытым ключом от Secret
 * API Key. Официальный SDK это умеет — и весит семь мегабайт
 * в распакованном виде, притаскивая с собой viem, axios и половину
 * клиента Solana. В этом проекте viem уже отвергали однажды: его
 * граф типов укладывал компилятор на сборщике с ограниченной
 * памятью. Ради одного заголовка такую цену платить незачем.
 *
 * Формат JWT здесь не изобретён: он описан в документации CDP,
 * и всё, что делает этот файл, — собирает три части и подписывает
 * их встроенным `node:crypto`.
 *
 * Ключ живёт только в переменных окружения и в этом файле. В журнал,
 * в ответ API и в браузер он не попадает никогда.
 */

/** Сколько живёт токен. Минута: он нужен ровно на один запрос. */
const TOKEN_TTL_SECONDS = 120;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Тип ключа по его содержимому.
 *
 * CDP выдаёт два вида: эллиптический P-256 в PEM и Ed25519 в base64.
 * Различать их по длине строки было бы гаданием, поэтому смотрим
 * на признаки формата.
 */
function detectKey(secret: string): { key: crypto.KeyObject; alg: 'ES256' | 'EdDSA' } {
  const trimmed = secret.trim();

  if (trimmed.includes('BEGIN')) {
    // PEM: эллиптическая кривая P-256, алгоритм ES256.
    return {
      key: crypto.createPrivateKey({ key: trimmed.replace(/\\n/g, '\n'), format: 'pem' }),
      alg: 'ES256',
    };
  }

  // Ed25519: 64 байта в base64 — сначала секретная часть, затем
  // открытая. Node принимает только первые 32 байта, обёрнутые
  // в структуру PKCS#8.
  const raw = Buffer.from(trimmed, 'base64');
  if (raw.length !== 64 && raw.length !== 32) {
    throw new Error('COINBASE_CDP_API_KEY_SECRET: не PEM и не 32/64 байта Ed25519');
  }

  const seed = raw.subarray(0, 32);
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]);

  return {
    key: crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }),
    alg: 'EdDSA',
  };
}

export interface CdpJwtInput {
  keyId: string;
  keySecret: string;
  method: string;
  /** Хост без схемы: `api.developer.coinbase.com`. */
  host: string;
  /** Путь с ведущим слэшем и без строки запроса. */
  path: string;
  nowSeconds: number;
}

/**
 * Токен для одного запроса.
 *
 * В утверждении `uri` стоит метод, хост и путь — токен, подписанный
 * для одного адреса, нельзя переиспользовать для другого. Срок
 * жизни короткий по той же причине: перехваченный заголовок должен
 * стать бесполезным быстро.
 */
export function createCdpJwt(input: CdpJwtInput): string {
  const { key, alg } = detectKey(input.keySecret);

  const header = {
    alg,
    kid: input.keyId,
    typ: 'JWT',
    // Одноразовое значение: два одинаковых токена подряд не появятся
    // даже в пределах одной секунды.
    nonce: crypto.randomBytes(16).toString('hex'),
  };

  const payload = {
    iss: 'cdp',
    sub: input.keyId,
    aud: ['cdp_service'],
    nbf: input.nowSeconds,
    exp: input.nowSeconds + TOKEN_TTL_SECONDS,
    uris: [`${input.method.toUpperCase()} ${input.host}${input.path}`],
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  const signature =
    alg === 'ES256'
      ? crypto.sign('sha256', Buffer.from(signingInput), {
          key,
          dsaEncoding: 'ieee-p1363',
        })
      : crypto.sign(null, Buffer.from(signingInput), key);

  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Пригоден ли ключ вообще.
 *
 * Вызывается при старте: негодный ключ должен обнаружиться там,
 * а не в момент, когда человек нажал «оплатить».
 */
export function canSignWithKey(secret: string): boolean {
  try {
    detectKey(secret);
    return true;
  } catch {
    return false;
  }
}
