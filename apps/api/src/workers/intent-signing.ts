import { randomUUID } from 'node:crypto';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { PrismaSigningStore } from '../services/prisma-signing-store.js';
import { createBlockhashSource, createSolanaSigner } from '../services/signer-factory.js';
import { readSigningState, signingStateFromConfig } from '../services/signing-state.js';
import { signIntent, type IntentRecord } from '../services/transaction-intent-signing.js';

/**
 * Подпись одобренных намерений.
 *
 * Выключен. Не «по умолчанию выключен» — технически выключен:
 * `SOLANA_SIGNING_ENABLED` по умолчанию `false`, провайдер подписи
 * по умолчанию `unavailable`, а общий блокер Phase 4 не позволяет
 * включить сетевой денежный контур ни при какой комбинации флагов.
 *
 * Существует он ради одного: чтобы порядок шагов был записан кодом,
 * а не намерением дописать позже. Порядок здесь и есть защита.
 *
 * Отправки нет. Транспорт broadcast сюда не импортируется, и
 * состояния после `SIGNED` не существует.
 */

export interface IntentSigningStatus {
  running: boolean;
  lastCycleAt: string | null;
  lastErrorCode: string | null;
  signed: number;
  refused: number;
  ambiguous: number;
}

const runtime: IntentSigningStatus = {
  running: false,
  lastCycleAt: null,
  lastErrorCode: null,
  signed: 0,
  refused: 0,
  ambiguous: 0,
};

let timer: NodeJS.Timeout | null = null;
let ticking = false;
const workerId = `intent-signing:${process.pid}:${randomUUID()}`;

export function getIntentSigningStatus(): IntentSigningStatus {
  return { ...runtime };
}

/**
 * Один проход.
 *
 * Берёт одно намерение за раз намеренно: пакет означал бы, что при
 * неоднозначном ответе провайдера непонятно, какие из намерений
 * подписаны, а какие нет.
 */
export async function runIntentSigningCycle(): Promise<'idle' | 'signed' | 'refused'> {
  /*
   * Полный расчёт, с базой: защёлка, реестр ключа, неоднозначные
   * попытки. Он же отвечает за devnet и за выключенные выводы.
   *
   * Ни одно из этих условий здесь не перепроверяется отдельно:
   * дубликат условия — это будущее расхождение.
   */
  const signing = await readSigningState();
  if (!signing.allowsKmsCall) {
    runtime.lastErrorCode = signing.blockers[0] ?? 'SIGNING_NOT_ALLOWED';
    return 'idle';
  }

  const candidate = await prisma.transactionIntent.findFirst({
    where: { state: 'APPROVED', network: 'devnet', expiresAt: { gt: new Date() } },
    orderBy: { approvedAt: 'asc' },
  });
  if (!candidate) return 'idle';

  const wallet = await prisma.wallet.findUnique({
    where: { id: candidate.walletId },
    select: { address: true },
  });
  if (!wallet) return 'idle';

  const record: IntentRecord = {
    id: candidate.id,
    userId: candidate.userId,
    state: candidate.state as IntentRecord['state'],
    approved: {
      network: candidate.network,
      purpose: candidate.purpose,
      mint: candidate.mint,
      rawAmount: candidate.rawAmount,
      sourceAddress: candidate.sourceAddress,
      destinationAddress: candidate.destinationAddress,
      feeLimitLamports: candidate.feeLimitLamports,
      slippageBps: candidate.slippageBps,
      allowedProgramIds: candidate.allowedProgramIds,
      messageHash: candidate.messageHash,
      policyVersion: candidate.policyVersion,
    },
    request: {
      purpose: candidate.purpose,
      network: candidate.network,
      ownerAddress: candidate.sourceAddress,
      destinationAddress: candidate.destinationAddress,
      rawAmount: candidate.rawAmount,
      mint: candidate.mint,
      feeLimitLamports: candidate.feeLimitLamports,
      slippageBps: candidate.slippageBps,
      recentBlockhash: candidate.recentBlockhash,
      lastValidBlockHeight: candidate.lastValidBlockHeight,
    },
    expiresAt: candidate.expiresAt.getTime(),
    lastValidBlockHeight: candidate.lastValidBlockHeight,
    approvedKeyVersion: candidate.keyVersion ?? env.SOLANA_SIGNER_KEY_VERSION ?? '',
    // Публичный ключ кошелька берётся из настройки и сверяется
    // с тем, что отдаёт KMS, уже внутри `signIntent`.
    walletPublicKey: new Uint8Array(32),
  };

  /*
   * Высота берётся из сети до захвата строки.
   *
   * Сверять срок blockhash с ним же самим бессмысленно: значение из
   * намерения всегда «ещё живо» относительно себя. Нужна высота,
   * которую сообщила цепочка.
   *
   * Сетевой вызов здесь, а не внутри `signIntent`, по той же
   * причине, что и в `decideProposal`: держать транзакцию БД
   * открытой на время сетевого запроса нельзя.
   */
  const blockhashSource = createBlockhashSource();
  if (!blockhashSource) {
    runtime.lastErrorCode = 'BLOCKHASH_UNAVAILABLE';
    return 'idle';
  }
  let currentBlockHeight: string;
  try {
    currentBlockHeight = (await blockhashSource()).lastValidBlockHeight;
  } catch {
    runtime.lastErrorCode = 'BLOCKHASH_UNAVAILABLE';
    return 'idle';
  }

  const outcome = await signIntent({
    intent: record,
    actorId: candidate.userId,
    /*
     * Настоящий подписант из фабрики.
     *
     * Он же по умолчанию отказывает: `SOLANA_SIGNING_ENABLED=false`
     * даёт `UnavailableSolanaSigner`, и до этой строки выполнение
     * вообще не доходит — воркер не запускается. Подключён он для
     * того, чтобы включение было одним решением, а не дописыванием
     * кода в спешке.
     *
     * Локального ключа здесь нет и не будет: контур, подписывающий
     * ключом из файла, выглядит защищённым и не является им.
     */
    signer: createSolanaSigner(),
    store: new PrismaSigningStore(),
    environment: {
      currentBlockHeight,
      safetyLatchHealthy: true,
      now: Date.now(),
    },
    workerId,
  });

  if (outcome.status === 'signed') {
    runtime.signed += 1;
    return 'signed';
  }
  if (outcome.status === 'refused' && outcome.code === 'SIGNER_AMBIGUOUS') {
    /*
     * Неоднозначный ответ не повторяется автоматически.
     *
     * Разорванное соединение не говорит, создалась подпись или нет.
     * Строка остаётся открытой для ручного разбора — счётчик здесь
     * не для статистики, а чтобы дежурный увидел, что накопилось.
     */
    runtime.ambiguous += 1;
  }
  runtime.refused += 1;
  return 'refused';
}

async function tick(): Promise<void> {
  if (!runtime.running || ticking) return;
  ticking = true;
  runtime.lastCycleAt = new Date().toISOString();
  /*
   * Код очищается до прохода, а не после.
   *
   * После — значит стереть то, что цикл только что записал: он сам
   * выставляет `BLOCKHASH_UNAVAILABLE` и возвращается штатно, без
   * исключения. Дежурный видел бы вечное «ошибок нет» у воркера,
   * который не может сделать ни одного шага.
   */
  runtime.lastErrorCode = null;
  try {
    await runIntentSigningCycle();
  } catch (error: unknown) {
    runtime.lastErrorCode = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'INTENT_SIGNING_CYCLE_FAILED';
    logger.warn({ code: runtime.lastErrorCode }, 'Intent signing cycle failed');
  } finally {
    ticking = false;
  }
}

/**
 * Запуск.
 *
 * Условие одно, и оно общее с интерфейсом. Собственный список
 * условий здесь и был причиной расхождения: экран и воркер отвечали
 * на один вопрос по разным наборам переменных.
 */
export function startIntentSigningWorker(): boolean {
  if (runtime.running) return true;
  /*
   * Решение принимает общий расчёт, а не три проверки здесь.
   *
   * Раньше воркер перечислял условия сам, и его список разошёлся
   * со списком интерфейса: экран говорил «выключено», а воркер
   * считал себя вправе запуститься.
   *
   * Берётся конфигурационный вариант: старт происходит до того, как
   * база доступна. Он строже полного — неизвестное считается
   * непроверенным.
   */
  if (!signingStateFromConfig().allowsKmsCall) return false;

  runtime.running = true;
  timer = setInterval(() => void tick(), 30_000);
  timer.unref?.();
  logger.info({ network: env.SOLANA_NETWORK }, 'Intent signing worker started');
  return true;
}

export function stopIntentSigningWorker(): void {
  runtime.running = false;
  if (timer) clearInterval(timer);
  timer = null;
}
