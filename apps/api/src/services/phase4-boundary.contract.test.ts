import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const wallets = readFileSync(new URL('../modules/wallets.ts', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../modules/admin.ts', import.meta.url), 'utf8');
const solana = readFileSync(new URL('../chains/solana.ts', import.meta.url), 'utf8');
const paperWorker = readFileSync(new URL('../workers/paper-agent.ts', import.meta.url), 'utf8');
const workerIndex = readFileSync(new URL('../workers/index.ts', import.meta.url), 'utf8');
const depositWorker = readFileSync(new URL('../workers/solana-deposit.ts', import.meta.url), 'utf8');
const reconcileWorker = readFileSync(
  new URL('../workers/solana-reconciliation.ts', import.meta.url),
  'utf8',
);
const reconcilePipeline = readFileSync(
  new URL('./solana-reconciliation-pipeline.ts', import.meta.url),
  'utf8',
);
const reconcileRepo = readFileSync(
  new URL('./prisma-solana-reconciliation-repository.ts', import.meta.url),
  'utf8',
);
const preflight = readFileSync(new URL('./solana-preflight.ts', import.meta.url), 'utf8');
const signing = readFileSync(
  new URL('./transaction-intent-signing.ts', import.meta.url), 'utf8',
);
const signerContract = readFileSync(
  new URL('./solana-signer-contract.ts', import.meta.url), 'utf8',
);
const kmsAdapters = readFileSync(
  new URL('./kms-ed25519-adapters.ts', import.meta.url), 'utf8',
);
const intentBuilder = readFileSync(
  new URL('./transaction-intent-builder.ts', import.meta.url), 'utf8',
);
const signingStore = readFileSync(
  new URL('./prisma-signing-store.ts', import.meta.url), 'utf8',
);

/** Исходник без комментариев: объяснение — не код. */
const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('Phase 4 hard boundaries', () => {
  it('refuses user withdrawal before any balance lock while withdrawals are disabled', () => {
    const route = wallets.slice(wallets.indexOf("app.post('/wallets/withdraw'"));
    expect(route.indexOf('WITHDRAWALS_DISABLED')).toBeGreaterThan(-1);
    expect(route.indexOf('WITHDRAWALS_DISABLED')).toBeLessThan(route.indexOf('balances.lock'));
  });

  it('refuses administrative withdrawal approval before changing its state', () => {
    const route = admin.slice(admin.indexOf("app.post('/admin/withdrawals/:id/decide'"));
    expect(route.indexOf('WITHDRAWALS_DISABLED')).toBeGreaterThan(-1);
    expect(route.indexOf('WITHDRAWALS_DISABLED')).toBeLessThan(route.indexOf('prisma.withdrawal.update'));
  });

  it('contains no implemented Solana live broadcast path', () => {
    expect(solana).toContain('LIVE_SOLANA_EXECUTION_NOT_IMPLEMENTED');
    expect(solana).not.toMatch(/sendRawTransaction|sendAndConfirmTransaction/);
  });

  it('keeps the PAPER worker free of RPC, KMS and private-key imports', () => {
    expect(paperWorker).not.toMatch(/sendRawTransaction|privateKey|KMS_SIGNING_ENABLED|SOLANA_RPC_URL/);
  });

  it('wires the deposit worker separately and keeps it behind FUNDING_ENABLED', () => {
    expect(workerIndex).toContain('startSolanaDepositWorker');
    expect(depositWorker).toContain('if (!env.FUNDING_ENABLED');
    expect(depositWorker).not.toMatch(/privateKey|sendRawTransaction|signTransaction/);
  });

  it('runs reconciliation as its own worker behind the same switch', () => {
    // Отдельный цикл: приём не должен ждать перепроверки старых
    // записей, а перепроверка — торопиться за приёмом.
    expect(workerIndex).toContain('startSolanaReconciliationWorker');
    expect(reconcileWorker).toContain('if (!env.FUNDING_ENABLED');
    expect(reconcileWorker).not.toMatch(/privateKey|sendRawTransaction|signTransaction|Keypair/);
  });

  it('gives reconciliation no way to move money', () => {
    /*
     * Сверка умеет записать наблюдение, завести проблему и поднять
     * защёлку. Списания по подозрению нет по конструкции: подозрение
     * бывает ложным, а снятые у человека деньги возвращаются руками.
     */
    expect(reconcilePipeline).not.toMatch(
      /balances\.|creditFinalizedAtomically|prisma\.deposit|ledgerEntry|\.debit\(/,
    );
  });

  it('never lowers the safety latch automatically', () => {
    /*
     * Проверяется путь, а не строка.
     *
     * Запрет `state: 'HEALTHY'` во всём файле был бы неверен: ручное
     * снятие обязано записывать именно его. Значение имеет то, какая
     * функция это делает — автоматическая или та, что требует
     * человека и оставляет след в журнале.
     */
    const raise = reconcileRepo.slice(
      reconcileRepo.indexOf('async raiseSafety'),
      reconcileRepo.indexOf('async creditsWithoutChainEvent'),
    );
    expect(raise.length).toBeGreaterThan(0);
    // Ранний выход при HEALTHY — это отказ записывать, а не запись.
    // Запрещено именно присваивание состояния.
    expect(raise).not.toMatch(/state:\s*'HEALTHY'/);
    expect(reconcileRepo).toContain('Защёлка только поднимается');
  });

  it('lowers the latch only through an audited manual action', () => {
    const clear = reconcileRepo.slice(reconcileRepo.indexOf('clearFundingSafetyLatch'));

    // Снимающая функция обязана знать, кто снял, и записать это.
    expect(clear).toContain('actorId');
    expect(clear).toContain('auditLog.create');
    expect(clear).toContain('FUNDING_SAFETY_LATCH_CLEARED');
  });

  it('exposes the clearing route behind requireAdmin', () => {
    const route = admin.slice(admin.indexOf("app.post('/admin/funding/latch/clear'"));
    expect(route.length).toBeGreaterThan(0);
    expect(route.slice(0, 200)).toContain('app.requireAdmin');
  });

  it('keeps preflight free of database and signing imports', () => {
    expect(preflight).not.toMatch(/prisma|Keypair|requestAirdrop|sendTransaction/);
  });

  it('keeps the funding status route read-only', () => {
    const route = admin.slice(admin.indexOf("app.get('/admin/funding/status'"));
    expect(route.length).toBeGreaterThan(0);
    // Ни адресов кошельков, ни адреса RPC, ни владельца аренды.
    expect(route).not.toMatch(/SOLANA_RPC_URL|leaseOwner|destination|address/);
  });

  it('Phase 4D не содержит ни одного пути отправки транзакции', () => {
    /*
     * Отрицательный контракт этапа.
     *
     * Ни один модуль подписи не должен уметь отправить подписанное.
     * Проверяется отсутствие вызова, а не наличие условия перед ним:
     * условие можно обойти, отсутствующего вызова — нет.
     */
    for (const [name, source] of Object.entries({
      signing, signerContract, kmsAdapters, intentBuilder, signingStore,
    })) {
      expect(strip(source), name).not.toMatch(
        /sendTransaction|sendRawTransaction|sendAndConfirmTransaction|broadcast|submitTransaction|simulateTransaction/i,
      );
    }
  });

  it('контур подписи не открывает соединения с сетью', () => {
    for (const [name, source] of Object.entries({ signing, signerContract, intentBuilder })) {
      expect(strip(source), name).not.toMatch(/new Connection|fetch\(|axios|undici/);
    }
  });

  it('приватный ключ не появляется в контуре подписи', () => {
    for (const [name, source] of Object.entries({
      signing, signerContract, kmsAdapters, intentBuilder,
    })) {
      expect(strip(source), name).not.toMatch(/privateKey|secretKey|fromSecretKey|Keypair\./);
    }
  });

  it('захват намерения делается одним оператором с условием на состояние', () => {
    /*
     * Между отдельными SELECT и UPDATE помещается второй процесс,
     * и оба уходят подписывать. Состояние обязано быть в условии.
     */
    // Индексы считаются по той же строке, из которой берётся срез:
    // смещения исходника не совпадают со смещениями очищенного.
    const store = strip(signingStore);
    const claim = store.slice(
      store.indexOf('async claim'),
      store.indexOf('async recordAttemptStart'),
    );
    expect(claim).toContain('updateMany');
    expect(claim).toMatch(/state:\s*'APPROVED'/);
    expect(claim).not.toMatch(/findUnique|findFirst/);
  });

  it('подпись ставится только из состояния захвата', () => {
    const store = strip(signingStore);
    const marked = store.slice(store.indexOf('async markSigned'));
    expect(marked.slice(0, 600)).toMatch(/state:\s*'SIGNING'/);
  });

  it('в журнал не попадает ни подпись, ни сообщение', () => {
    const audits = strip(signingStore).match(/auditLog\.create\({[\s\S]*?\}\);/g) ?? [];
    expect(audits.length).toBeGreaterThan(0);
    for (const entry of audits) {
      expect(entry).not.toMatch(/signature[,:]|message|rawAmount/);
    }
  });

  it('нет метода «подписать произвольные байты»', () => {
    // Такой метод превратил бы весь контур проверок в украшение.
    expect(strip(signerContract)).not.toMatch(/signArbitrary|signRaw|signBytes|signAnything/);
    expect(strip(signerContract)).toContain('signMessage');
  });

  it('состояний отправки в машине состояний нет', () => {
    const machine = readFileSync(
      new URL('../../../../packages/core/src/transaction-intent.ts', import.meta.url), 'utf8',
    );
    const code = strip(machine);
    expect(code).not.toMatch(/'SUBMITTED'|'CONFIRMED'|'FINALIZED'/);
  });

  it('диагностика подписи не раскрывает имя ресурса ключа', () => {
    const route = admin.slice(admin.indexOf("app.get('/admin/signing/status'"));
    expect(route.length).toBeGreaterThan(0);
    const body = strip(route.slice(0, route.indexOf('app.post')));

    // Отпечаток вместо ключа: публичный ключ — это адрес кошелька.
    expect(body).toContain('keyFingerprint');

    /*
     * Проверяется возвращаемое, а не упоминание.
     *
     * `env.SOLANA_SIGNER_KEY_ID` внутри маршрута — это условие
     * «ключ настроен», а не выдача идентификатора наружу. Запрет
     * упоминания обвинял бы проверку вместо утечки.
     */
    const returned = body.slice(body.indexOf('return {'));
    expect(returned).not.toMatch(/keyId|keyVersionName|resourceName|arn:/);
    expect(returned).not.toMatch(/publicKey:/);
  });

  it('has no clearing route outside the audited admin one', () => {
    /*
     * Раньше здесь запрещался любой маршрут снятия. Теперь такой
     * маршрут есть намеренно — ручной, за requireAdmin и с записью
     * в журнал. Запрещено другое: второй путь, который обошёл бы
     * проверку прав.
     */
    const clearing = admin.match(/app\.(get|post|put|patch|delete)\('[^']*funding[^']*'/g) ?? [];

    expect(clearing).toEqual([
      "app.get('/admin/funding/status'",
      "app.post('/admin/funding/latch/clear'",
    ]);
  });
});

// ═══════════════ Подпись и отправка — разные контуры ═════════════════════════

describe('broadcast не проникает в контур подписи', () => {
  const FILES = [
    'signing-state.ts',
    'signer-factory.ts',
    'kms-preflight.ts',
    'kms-aws-transport.ts',
    'kms-ed25519-adapters.ts',
    'transaction-intent-signing.ts',
    '../workers/intent-signing.ts',
  ];

  it('ни один модуль подписи не импортирует транспорт отправки', () => {
    /*
     * Запрет на уровне импорта, а не на уровне флага.
     *
     * Флаг «отправка выключена» защищает ровно до того дня, когда
     * его переставят. Отсутствие импорта означает, что отправлять
     * попросту нечем: `SIGNED` не равно `SUBMITTED` не по настройке,
     * а по устройству.
     */
    for (const file of FILES) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

      expect(source, file).not.toMatch(
        /sendTransaction|sendRawTransaction|submitTransaction|broadcastTransaction/,
      );
      expect(source, file).not.toMatch(/from\s+'.*broadcast.*'/);
    }
  });

  it('доступность отправки — константа, а не переменная окружения', () => {
    const source = readFileSync(new URL('./signing-state.ts', import.meta.url), 'utf8');

    // Настройка на этом месте создавала бы впечатление, что за ней
    // что-то стоит. Не стоит ничего.
    expect(source).toContain('export const BROADCAST_AVAILABLE = false');
    expect(source).not.toMatch(/BROADCAST_ENABLED|env\.BROADCAST/);
  });
});
