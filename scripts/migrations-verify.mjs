/**
 * Проверка миграций на настоящем Postgres, без сети и без production.
 *
 * База поднимается прямо в процессе: PGlite — это Postgres,
 * собранный в WebAssembly. Не заглушка и не имитация — тот же
 * планировщик, те же типы, те же ограничения. Проверять миграции
 * на подделке смысла нет: ошибаются они как раз в том, что подделка
 * не воспроизводит.
 *
 * Два сценария, потому что вопросов два.
 *
 * Чистая база отвечает на вопрос «соберётся ли схема с нуля» —
 * это про новые окружения и про CI.
 *
 * Копия существующей отвечает на вопрос, который дороже: «переживут
 * ли миграцию данные, которые уже есть». Baseline здесь играет роль
 * боевой базы, поверх неё кладутся строки, и только потом приходит
 * feature-миграция.
 *
 * Запуск:
 *   node scripts/migrations-verify.mjs
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = fs.readFileSync(`${R}/prisma/migrations/0_baseline/migration.sql`, 'utf8');
const feature = fs.readFileSync(
  `${R}/prisma/migrations/20260821120000_add_subscriptions_and_trial/migration.sql`,
  'utf8',
);

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ок  ' : ' СБОЙ '} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

/**
 * Возраст рынка. Третья миграция, только добавление колонок.
 */
const marketAge = fs.readFileSync(
  `${R}/prisma/migrations/20260823040000_add_token_market_age/migration.sql`,
  'utf8',
);

/** Очередь проверки и возраст котировки. Тоже только добавление. */
const checkQueue = fs.readFileSync(
  `${R}/prisma/migrations/20260823120000_add_check_queue_and_price_age/migration.sql`,
  'utf8',
);

/** История официального OKX Signal. */
const okxSignals = fs.readFileSync(
  `${R}/prisma/migrations/20260823170000_add_okx_signals/migration.sql`,
  'utf8',
);

/** Происхождение экономической сделки. Только добавление. */
const tradeProvenance = fs.readFileSync(
  `${R}/prisma/migrations/20260825090000_add_trade_provenance/migration.sql`,
  'utf8',
);

/**
 * Контракт сводки кошелька. Только добавление, все колонки NULL-able.
 *
 * Проверять её на настоящем Postgres важнее обычного: смысл этой
 * миграции целиком держится на том, что колонки пустые. Умолчание,
 * прокравшееся в SQL, не сломало бы ни одну проверку типов, но стёрло
 * бы разницу между «посчитано и вышло ноль» и «ещё не пересчитано».
 */
const walletSummary = fs.readFileSync(
  `${R}/prisma/migrations/20260825120000_add_wallet_summary_contract/migration.sql`,
  'utf8',
);

/** Локальный PnL события ленты. Только добавление NULL-able колонок. */
const walletActivityPnl = fs.readFileSync(
  `${R}/prisma/migrations/20260825150000_add_wallet_activity_local_pnl/migration.sql`,
  'utf8',
);

/** Накопленный ATH каждого события Signal. */
const okxSignalAth = fs.readFileSync(
  `${R}/prisma/migrations/20260823180000_add_okx_signal_ath/migration.sql`,
  'utf8',
);

/** Автономный paper-агент: только новые таблицы и адреса Signal. */
const paperAgent = fs.readFileSync(
  `${R}/prisma/migrations/20260826100000_add_paper_agent/migration.sql`,
  'utf8',
);

/** Phase 2: manual default, explicit costs and notification outbox. */
const paperAgentPhase2 = fs.readFileSync(
  `${R}/prisma/migrations/20260826110000_add_paper_agent_phase2/migration.sql`,
  'utf8',
);

/** Phase 3: isolated Fixed/Autopilot capital accounts and immutable ledger. */
const paperAgentPhase3 = fs.readFileSync(
  `${R}/prisma/migrations/20260826120000_add_paper_agent_phase3/migration.sql`,
  'utf8',
);

const paperAgentSignalPipeline = fs.readFileSync(
  `${R}/prisma/migrations/20260827100000_fix_paper_agent_signal_pipeline/migration.sql`,
  'utf8',
);

const phase4LiveFoundation = fs.readFileSync(
  `${R}/prisma/migrations/20260827160000_add_phase4_live_foundation/migration.sql`,
  'utf8',
);

const phase4Reconciliation = fs.readFileSync(
  `${R}/prisma/migrations/20260904100000_add_phase4_reconciliation/migration.sql`,
  'utf8',
);

const signingIdentity = fs.readFileSync(
  `${R}/prisma/migrations/20260904220000_add_signing_identity/migration.sql`,
  'utf8',
);

const intentLifecycle = fs.readFileSync(
  `${R}/prisma/migrations/20260904210000_add_intent_lifecycle/migration.sql`,
  'utf8',
);

const transactionIntent = fs.readFileSync(
  `${R}/prisma/migrations/20260904200000_add_transaction_intent/migration.sql`,
  'utf8',
);

// ── Проверяется ли вообще то, что лежит в репозитории ──────────────
/*
 * Файл называет миграции поимённо, и это его слабое место: миграция
 * появляется в каталоге, здесь её не дописывают, и проверка молча
 * подтверждает вчерашнюю схему. Ровно так и случилось с возрастом
 * рынка на стороне загрузчика.
 *
 * Поэтому сначала сверяется сам список.
 */
console.log('\n=== Каталог миграций ===');

const KNOWN = [
  '0_baseline',
  '20260821120000_add_subscriptions_and_trial',
  '20260823040000_add_token_market_age',
  '20260823120000_add_check_queue_and_price_age',
  '20260823170000_add_okx_signals',
  '20260823180000_add_okx_signal_ath',
  '20260825090000_add_trade_provenance',
  '20260825120000_add_wallet_summary_contract',
  '20260825150000_add_wallet_activity_local_pnl',
  '20260826100000_add_paper_agent',
  '20260826110000_add_paper_agent_phase2',
  '20260826120000_add_paper_agent_phase3',
  '20260827100000_fix_paper_agent_signal_pipeline',
  '20260827160000_add_phase4_live_foundation',
  '20260904100000_add_phase4_reconciliation',
  '20260904200000_add_transaction_intent',
  '20260904210000_add_intent_lifecycle',
  '20260904220000_add_signing_identity',
];

const onDisk = fs
  .readdirSync(`${R}/prisma/migrations`, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

check(
  'проверяются все миграции каталога',
  JSON.stringify(onDisk) === JSON.stringify([...KNOWN].sort()),
  onDisk.filter((n) => !KNOWN.includes(n)).join(', ') || 'совпадает',
);

// ── Сценарий 1: чистая база ────────────────────────────────────────
console.log('\n=== Чистая база: baseline, затем feature ===');
const clean = await PGlite.create();
await clean.exec(baseline);
await clean.exec(feature);
await clean.exec(marketAge);
await clean.exec(checkQueue);
await clean.exec(okxSignals);

const tables = (
  await clean.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`)
).rows.map((r) => r.tablename);
check('таблиц создано 36', tables.length === 36, String(tables.length));
for (const t of ['Subscription', 'EntitlementAudit', 'PaymentCustomer', 'SubscriptionPayment', 'WebhookReceipt']) {
  check(`таблица ${t}`, tables.includes(t));
}

const enums = (
  await clean.query(`SELECT typname FROM pg_type WHERE typtype='e' ORDER BY 1`)
).rows.map((r) => r.typname);
for (const e of ['PlanCode', 'SubscriptionStatus', 'SubscriptionSource', 'PaymentProvider', 'PaymentState', 'KycState']) {
  check(`перечисление ${e}`, enums.includes(e));
}

const idx = (
  await clean.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename IN ('Subscription','EntitlementAudit') ORDER BY 1`,
  )
).rows.map((r) => r.indexname);
for (const i of [
  'Subscription_one_active_per_user',
  'Subscription_one_trial_per_user',
  'Subscription_userId_status_startsAt_idx',
  'Subscription_status_expiresAt_idx',
  'EntitlementAudit_userId_occurredAt_idx',
]) {
  check(`индекс ${i}`, idx.includes(i));
}

const partial = (
  await clean.query(
    `SELECT indexdef FROM pg_indexes WHERE indexname='Subscription_one_active_per_user'`,
  )
).rows;
check('индекс одной активной подписки — частичный',
  partial.length === 1 && /WHERE .*status.*ACTIVE/i.test(partial[0].indexdef),
  partial.length ? partial[0].indexdef : 'индекса нет');

const fks = (
  await clean.query(
    `SELECT conname FROM pg_constraint WHERE contype='f' AND conrelid::regclass::text IN ('"Subscription"','"EntitlementAudit"') ORDER BY 1`,
  )
).rows.map((r) => r.conname);
check('внешних ключей 2', fks.length === 2, fks.join(', '));

// ── Сценарий 2: копия существующей базы ────────────────────────────
console.log('\n=== Копия существующей базы: данные до feature-миграции ===');
const cloneDb = await PGlite.create();
await cloneDb.exec(baseline);
await cloneDb.exec(`
  INSERT INTO "User" ("id","email","passwordHash","updatedAt") VALUES ('u9','old@x.y','h',NOW());
  INSERT INTO "RadarEvent" ("id","chain","address","symbol","name","source","riskCodes","firstSeenAt","currentPriceUsd")
  VALUES ('old1','BNB','0xabc','OLD','Old token','okx',ARRAY['LOW_LIQUIDITY']::text[],NOW(),1.25);
`);
const before = await cloneDb.query(`SELECT "id","currentPriceUsd","riskCodes" FROM "RadarEvent" WHERE "id"='old1'`);
await cloneDb.exec(feature);
const afterRows = await cloneDb.query(`SELECT "id","currentPriceUsd","riskCodes" FROM "RadarEvent" WHERE "id"='old1'`);
check('строка радара пережила миграцию', afterRows.rows.length === 1);
check('значения не изменились',
  String(before.rows[0].currentPriceUsd) === String(afterRows.rows[0].currentPriceUsd) &&
  JSON.stringify(before.rows[0].riskCodes) === JSON.stringify(afterRows.rows[0].riskCodes));
const users = await cloneDb.query(`SELECT COUNT(*)::int c FROM "User"`);
check('пользователь на месте', users.rows[0].c === 1);
const newTables = (await cloneDb.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('Subscription','EntitlementAudit')`)).rows;
check('новые таблицы появились', newTables.length === 2, String(newTables.length));

// ── Подписки: переходы и журнал ─────────────────────────────────────
console.log('\n=== Подписки: переходы, журнал, роли ===');

const subs = await PGlite.create();
await subs.exec(baseline);
await subs.exec(feature);
await subs.exec(`
  INSERT INTO "User" ("id","email","passwordHash","role","updatedAt") VALUES
    ('su1','one@x.y','h','USER',NOW()),
    ('su2','two@x.y','h','ADMIN',NOW());
`);

/** Переход, как его делает activatePlan: закрыть прежний, открыть новый, записать журнал. */
const activate = async (userId, plan, prev, reason, source = 'PAYMENT', at = 'NOW()') => {
  await subs.exec(`
    UPDATE "Subscription" SET "status"='CANCELLED', "cancelledAt"=${at}
      WHERE "userId"='${userId}' AND "status"='ACTIVE';
    INSERT INTO "Subscription" ("id","userId","plan","status","startsAt","source","updatedAt")
      VALUES ('sub-${userId}-${plan}-${reason}','${userId}','${plan}','ACTIVE',${at},'${source}',NOW());
    INSERT INTO "EntitlementAudit" ("id","userId","subscriptionId","previousPlan","nextPlan","reason","source","occurredAt")
      VALUES ('aud-${userId}-${plan}-${reason}','${userId}','sub-${userId}-${plan}-${reason}','${prev}','${plan}','${reason}','${source}',${at});
  `);
};

await activate('su1', 'PRO', 'EXPIRED', 'PAYMENT_RECEIVED');
await activate('su1', 'FULL_AUTO', 'PRO', 'PLAN_UPGRADED');
await activate('su1', 'SEMI_AUTO', 'FULL_AUTO', 'PLAN_DOWNGRADED');

const activeRows = await subs.query(`SELECT "plan" FROM "Subscription" WHERE "userId"='su1' AND "status"='ACTIVE'`);
check('после трёх переходов активна ровно одна подписка', activeRows.rows.length === 1, String(activeRows.rows.length));
check('активен последний план', activeRows.rows[0].plan === 'SEMI_AUTO', activeRows.rows[0].plan);

const hist = await subs.query(`SELECT "previousPlan","nextPlan","reason" FROM "EntitlementAudit" WHERE "userId"='su1' ORDER BY "occurredAt", "id"`);
check('журнал хранит все три перехода', hist.rows.length === 3, String(hist.rows.length));
check('переходы записаны с прежним и новым планом',
  hist.rows.every((r) => r.previousPlan && r.nextPlan),
  hist.rows.map((r) => `${r.previousPlan}→${r.nextPlan}`).join(', '));

const closed = await subs.query(`SELECT "plan","status" FROM "Subscription" WHERE "userId"='su1' AND "status"<>'ACTIVE' ORDER BY "startsAt"`);
check('прежние договоры сохранены, а не переписаны', closed.rows.length === 2, String(closed.rows.length));
check('в истории остались именно купленные планы',
  closed.rows.map((r) => r.plan).join(',') === 'PRO,FULL_AUTO',
  closed.rows.map((r) => r.plan).join(','));

// Отмена и истечение
await subs.exec(`
  UPDATE "Subscription" SET "status"='CANCELLED', "cancelledAt"=NOW() WHERE "userId"='su1' AND "status"='ACTIVE';
  INSERT INTO "EntitlementAudit" ("id","userId","previousPlan","nextPlan","reason","source","occurredAt")
    VALUES ('aud-cancel','su1','SEMI_AUTO','EXPIRED','CANCELLED_BY_USER','PAYMENT',NOW());
`);
const afterCancel = await subs.query(`SELECT COUNT(*)::int c FROM "Subscription" WHERE "userId"='su1' AND "status"='ACTIVE'`);
check('после отмены активных подписок нет — это и есть EXPIRED', afterCancel.rows[0].c === 0);

// Журнал переживает удаление подписки и пользователя
await subs.exec(`DELETE FROM "Subscription" WHERE "userId"='su1'`);
const auditAfterSubDelete = await subs.query(`SELECT COUNT(*)::int c FROM "EntitlementAudit" WHERE "userId"='su1'`);
check('удаление подписок не стирает журнал', auditAfterSubDelete.rows[0].c === 4, String(auditAfterSubDelete.rows[0].c));

const nulled = await subs.query(`SELECT COUNT(*)::int c FROM "EntitlementAudit" WHERE "userId"='su1' AND "subscriptionId" IS NULL`);
check('ссылка на удалённый договор обнулилась, запись осталась', nulled.rows[0].c === 4, String(nulled.rows[0].c));

await subs.exec(`DELETE FROM "User" WHERE "id"='su1'`);
const auditAfterUserDelete = await subs.query(`SELECT COUNT(*)::int c FROM "EntitlementAudit" WHERE "userId"='su1'`);
check('удаление пользователя не стирает журнал — ради этого связи и нет',
  auditAfterUserDelete.rows[0].c === 4, String(auditAfterUserDelete.rows[0].c));

// Роли и тарифы независимы
await subs.exec(`
  INSERT INTO "Subscription" ("id","userId","plan","status","source","updatedAt")
    VALUES ('sub-admin','su2','EXPIRED','ACTIVE','PAYMENT',NOW());
`);
const admin = await subs.query(`
  SELECT u."role", s."plan" FROM "User" u JOIN "Subscription" s ON s."userId"=u."id" WHERE u."id"='su2'
`);
check('администратор без платного плана остаётся администратором',
  admin.rows[0].role === 'ADMIN' && admin.rows[0].plan === 'EXPIRED',
  `${admin.rows[0].role}/${admin.rows[0].plan}`);

const planColumn = await subs.query(`
  SELECT COUNT(*)::int c FROM information_schema.columns
  WHERE table_name='User' AND column_name='plan'
`);
check('колонки plan в User нет — второго источника истины не завели', planColumn.rows[0].c === 0);

// Конкурентная выдача двух активных подписок
let race = null;
try {
  await subs.exec(`
    INSERT INTO "Subscription" ("id","userId","plan","status","source","updatedAt")
      VALUES ('sub-admin-2','su2','FULL_AUTO','ACTIVE','ADMIN_GRANT',NOW());
  `);
} catch (e) { race = e.message; }
check('вторая активная подписка отклонена базой, а не кодом', race != null,
  race ? 'ограничение сработало' : 'вставка прошла');

// ── Один пробный период за всё время ───────────────────────────────
console.log('\n=== Один пробный период на пользователя за всё время ===');

const tr = await PGlite.create();
await tr.exec(baseline);
await tr.exec(feature);
await tr.exec(`
  INSERT INTO "User" ("id","email","passwordHash","emailVerifiedAt","updatedAt")
  VALUES ('tu1','t1@x.y','h',NOW(),NOW()), ('tu2','t2@x.y','h',NOW(),NOW());
`);

const startTrial = (id, user, startsAt, expiresAt, status = 'ACTIVE') =>
  tr.query(
    `INSERT INTO "Subscription" ("id","userId","plan","status","startsAt","expiresAt","source","updatedAt")
     VALUES ($1,$2,'TRIAL',$3,$4,$5,'TRIAL',NOW())`,
    [id, user, status, startsAt, expiresAt],
  );

const T = '2026-08-21T12:00:00Z';
const T_END = '2026-08-26T12:00:00Z';

await startTrial('t-1', 'tu1', T, T_END);
check('первый пробный период создаётся', true);

let second = null;
try { await startTrial('t-2', 'tu1', T_END, '2026-08-31T12:00:00Z'); } catch (e) { second = e.message; }
check('второй пробный период отклонён базой', second != null,
  second ? 'ограничение сработало' : 'вставка прошла');

// Даже после истечения — та же строка занимает место.
await tr.exec(`UPDATE "Subscription" SET "status"='EXPIRED' WHERE "id"='t-1'`);
let afterExpiry = null;
try { await startTrial('t-3', 'tu1', T_END, '2026-08-31T12:00:00Z', 'ACTIVE'); } catch (e) { afterExpiry = e.message; }
check('истёкший период тоже занимает место — второго не создать',
  afterExpiry != null, afterExpiry ? 'ограничение сработало' : 'вставка прошла');

const trialCount = await tr.query(`SELECT COUNT(*)::int c FROM "Subscription" WHERE "userId"='tu1' AND "plan"='TRIAL'`);
check('запись о пробном периоде ровно одна', trialCount.rows[0].c === 1, String(trialCount.rows[0].c));

// Ограничение не мешает купить платный план — и купить его дважды.
await tr.exec(`
  INSERT INTO "Subscription" ("id","userId","plan","status","source","updatedAt")
    VALUES ('p-1','tu1','PRO','CANCELLED','PAYMENT',NOW());
  INSERT INTO "Subscription" ("id","userId","plan","status","source","updatedAt")
    VALUES ('p-2','tu1','PRO','ACTIVE','PAYMENT',NOW());
`);
const proCount = await tr.query(`SELECT COUNT(*)::int c FROM "Subscription" WHERE "userId"='tu1' AND "plan"='PRO'`);
check('платный план можно купить повторно после отмены', proCount.rows[0].c === 2, String(proCount.rows[0].c));

// Другому пользователю пробный период доступен.
await startTrial('t-other', 'tu2', T, T_END);
const otherCount = await tr.query(`SELECT COUNT(*)::int c FROM "Subscription" WHERE "userId"='tu2' AND "plan"='TRIAL'`);
check('ограничение действует на пользователя, а не на всех', otherCount.rows[0].c === 1);

const trialIdx = await tr.query(`SELECT indexdef FROM pg_indexes WHERE indexname='Subscription_one_trial_per_user'`);
check('ограничение выражено частичным индексом по плану',
  trialIdx.rows.length === 1 && /WHERE .*plan.*TRIAL/i.test(trialIdx.rows[0].indexdef),
  trialIdx.rows.length ? trialIdx.rows[0].indexdef : 'индекса нет');

const verified = await tr.query(`
  SELECT COUNT(*)::int c FROM information_schema.columns
  WHERE table_name='User' AND column_name='emailVerifiedAt'
`);
check('подтверждение почты есть в схеме', verified.rows[0].c === 1);

// ── Колонки подтверждения почты ────────────────────────────────────
console.log('\n=== Подтверждение почты ===');

const cols = (await tr.query(`
  SELECT column_name, is_nullable, column_default FROM information_schema.columns
  WHERE table_name='User' AND column_name LIKE 'email%' ORDER BY 1
`)).rows;

const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
for (const c of ['emailVerifiedAt', 'emailCodeHash', 'emailCodeIssuedAt', 'emailCodeExpires', 'emailCodeAttempts']) {
  check(`колонка ${c}`, byName[c] != null);
}

check('все новые колонки необязательны или с умолчанием',
  ['emailVerifiedAt', 'emailCodeHash', 'emailCodeIssuedAt', 'emailCodeExpires']
    .every((c) => byName[c]?.is_nullable === 'YES') &&
  byName.emailCodeAttempts?.column_default != null,
  'иначе миграция уронила бы существующие строки');

// Существующая строка переживает добавление колонок.
await tr.exec(`
  INSERT INTO "User" ("id","email","passwordHash","updatedAt")
  VALUES ('old-user','old@x.y','h',NOW());
`);
const old = await tr.query(`SELECT "emailVerifiedAt","emailCodeAttempts" FROM "User" WHERE "id"='old-user'`);
check('у существующего пользователя почта не подтверждена', old.rows[0].emailVerifiedAt === null);
check('счётчик попыток начинается с нуля', old.rows[0].emailCodeAttempts === 0);

// ── Платежи за подписку ────────────────────────────────────────────
console.log('\n=== Оплата подписок ===');

const pay = await PGlite.create();
await pay.exec(baseline);
await pay.exec(feature);
await pay.exec(marketAge);
await pay.exec(checkQueue);
await pay.exec(`
  INSERT INTO "User" ("id","email","passwordHash","emailVerifiedAt","updatedAt")
  VALUES ('pu1','pay@x.y','h',NOW(),NOW());
  INSERT INTO "PaymentCustomer" ("id","userId","provider","externalCustomerId","kycState","tosAccepted","updatedAt")
  VALUES ('pc1','pu1','BRIDGE','cust_1','APPROVED',true,NOW());
`);

const newPayment = (id, ref, transferId, state = 'AWAITING_FUNDS') =>
  pay.query(
    `INSERT INTO "SubscriptionPayment"
       ("id","userId","customerId","plan","priceAmount","priceCurrency","termDays",
        "sourceCurrency","sourceAmount","destinationCurrency","destinationChain",
        "destinationAddress","provider","providerTransferId","clientReference","state","updatedAt")
     VALUES ($1,'pu1','pc1','PRO',50.00,'USDC',30,'USD',50.00,'USDC','SOLANA',
             '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU','BRIDGE',$2,$3,$4,NOW())`,
    [id, transferId, ref, state],
  );

await newPayment('p1', 'ref-1', 'transfer_1');
check('платёж создаётся', true);

let dupRef = null;
try { await newPayment('p2', 'ref-1', 'transfer_2'); } catch (e) { dupRef = e.message; }
check('повторный ключ идемпотентности отклонён', dupRef != null,
  dupRef ? 'ограничение сработало' : 'вставка прошла');

let dupTransfer = null;
try { await newPayment('p3', 'ref-3', 'transfer_1'); } catch (e) { dupTransfer = e.message; }
check('один перевод провайдера — один платёж', dupTransfer != null,
  dupTransfer ? 'ограничение сработало' : 'вставка прошла');

// Один платёж выдаёт одну подписку.
await pay.exec(`
  INSERT INTO "Subscription" ("id","userId","plan","status","source","expiresAt","updatedAt")
  VALUES ('s1','pu1','PRO','ACTIVE','PAYMENT',NOW() + INTERVAL '30 days',NOW());
  UPDATE "SubscriptionPayment" SET "grantedSubscriptionId"='s1', "state"='PAID' WHERE "id"='p1';
`);

await newPayment('p4', 'ref-4', 'transfer_4');
let dupGrant = null;
try {
  await pay.exec(`UPDATE "SubscriptionPayment" SET "grantedSubscriptionId"='s1' WHERE "id"='p4'`);
} catch (e) { dupGrant = e.message; }
check('одна подписка не выдаётся двумя платежами', dupGrant != null,
  dupGrant ? 'ограничение сработало' : 'обновление прошло');

// Идемпотентность вебхука.
await pay.exec(`
  INSERT INTO "WebhookReceipt" ("id","provider","eventId","eventType","eventCreatedAt","outcome")
  VALUES ('w1','BRIDGE','evt_1','transfer.updated',NOW(),'ACCEPTED');
`);

let dupEvent = null;
try {
  await pay.exec(`
    INSERT INTO "WebhookReceipt" ("id","provider","eventId","eventType","eventCreatedAt","outcome")
    VALUES ('w2','BRIDGE','evt_1','transfer.updated',NOW(),'ACCEPTED');
  `);
} catch (e) { dupEvent = e.message; }
check('повторное событие отклонено базой', dupEvent != null,
  dupEvent ? 'ограничение сработало' : 'вставка прошла');

// Один клиент провайдера на пользователя.
let dupCustomer = null;
try {
  await pay.exec(`
    INSERT INTO "PaymentCustomer" ("id","userId","provider","kycState","tosAccepted","updatedAt")
    VALUES ('pc2','pu1','BRIDGE','NOT_STARTED',false,NOW());
  `);
} catch (e) { dupCustomer = e.message; }
check('один клиент провайдера на пользователя', dupCustomer != null);

// Суммы хранятся как Decimal, а не как число с плавающей точкой.
const moneyCols = (await pay.query(`
  SELECT column_name, data_type, numeric_precision, numeric_scale
  FROM information_schema.columns
  WHERE table_name='SubscriptionPayment' AND column_name IN ('priceAmount','sourceAmount','deliveredAmount')
  ORDER BY 1
`)).rows;
check('денежные колонки — numeric, а не float',
  moneyCols.length === 3 && moneyCols.every((c) => c.data_type === 'numeric'),
  moneyCols.map((c) => `${c.column_name}:${c.data_type}`).join(', '));

const stored = await pay.query(`SELECT "priceAmount"::text p, "termDays" t FROM "SubscriptionPayment" WHERE "id"='p1'`);
check('снимок цены и срока сохранён', stored.rows[0].p.startsWith('50') && stored.rows[0].t === 30,
  `${stored.rows[0].p} / ${stored.rows[0].t}`);

// Журнал переживает удаление платежа.
await pay.exec(`DELETE FROM "SubscriptionPayment" WHERE "id"='p4'`);
const subsLeft = await pay.query(`SELECT COUNT(*)::int c FROM "Subscription" WHERE "userId"='pu1'`);
check('удаление платежа не трогает подписку', subsLeft.rows[0].c === 1);


// ─────────────────────────── Второй провайдер ───────────────────────────────

console.log('\n=== Оплата через Coinbase ===');

// Значение перечисления обязано существовать до того, как код начнёт
// его писать: иначе первая же покупка упадёт на вставке.
const providerValues = (await pay.query(`
  SELECT unnest(enum_range(NULL::"PaymentProvider"))::text v ORDER BY 1
`)).rows.map((r) => r.v);

check('в перечислении провайдеров есть BRIDGE и COINBASE',
  providerValues.includes('BRIDGE') && providerValues.includes('COINBASE'),
  providerValues.join(', '));

const newCoinbasePayment = (id, ref, partnerRef, transferId = null) =>
  pay.query(
    `INSERT INTO "SubscriptionPayment"
       ("id","userId","plan","priceAmount","priceCurrency","termDays",
        "sourceCurrency","sourceAmount","destinationCurrency","destinationChain",
        "destinationAddress","provider","partnerUserRef","providerTransferId",
        "clientReference","state","updatedAt")
     VALUES ($1,'pu1','PRO',50.00,'USDC',30,'USD',50.00,'USDC','SOLANA',
             '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU','COINBASE',$2,$3,$4,
             'AWAITING_FUNDS',NOW())`,
    [id, partnerRef, transferId, ref],
  );

// Ещё два платежа Bridge: раздел выше оставляет один, а проверка
// уникальности по NULL требует минимум двух.
await newPayment('br-a', 'br-ref-a', 'transfer_a');
await newPayment('br-b', 'br-ref-b', 'transfer_b');

await newCoinbasePayment('cb1', 'cb-ref-1', 'mx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
check('платёж Coinbase создаётся без клиента провайдера', true);

// Отдельного KYC у Coinbase нет, и запись PaymentCustomer для него
// не обязательна. Если бы связь была обязательной, покупку нельзя
// было бы записать вовсе.
const noCustomer = await pay.query(`SELECT "customerId" c FROM "SubscriptionPayment" WHERE "id"='cb1'`);
check('связь с клиентом провайдера необязательна', noCustomer.rows[0].c === null);

let dupPartnerRef = null;
try {
  await newCoinbasePayment('cb2', 'cb-ref-2', 'mx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
} catch (e) { dupPartnerRef = e.message; }

check('одна ссылка покупателя — один платёж', dupPartnerRef != null,
  dupPartnerRef ? 'ограничение сработало' : 'вставка прошла');

// Ссылка покупателя может отсутствовать: у платежей Bridge её нет,
// и частичность здесь обязательна — иначе второй платёж Bridge
// упёрся бы в уникальность по NULL.
const bridgeWithoutRef = await pay.query(
  `SELECT COUNT(*)::int c FROM "SubscriptionPayment" WHERE "provider"='BRIDGE' AND "partnerUserRef" IS NULL`,
);
check('несколько платежей Bridge живут без ссылки покупателя', bridgeWithoutRef.rows[0].c >= 3,
  `${bridgeWithoutRef.rows[0].c} шт.`);

// Транзакция провайдера одна на платёж — независимо от провайдера.
await pay.exec(`UPDATE "SubscriptionPayment" SET "providerTransferId"='cb_tx_1' WHERE "id"='cb1'`);

let dupCoinbaseTx = null;
try {
  await newCoinbasePayment('cb3', 'cb-ref-3', 'mx_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cb_tx_1');
} catch (e) { dupCoinbaseTx = e.message; }

check('одна транзакция Coinbase — один платёж', dupCoinbaseTx != null,
  dupCoinbaseTx ? 'ограничение сработало' : 'вставка прошла');

// Суммы Coinbase тоже numeric: копейки, потерянные во float,
// превращаются в расхождение при сверке.
const cbMoney = (await pay.query(`
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name='SubscriptionPayment'
    AND column_name IN ('purchaseAmount','paymentSubtotal','paymentTotal','networkFee')
  ORDER BY 1
`)).rows;

check('денежные колонки Coinbase — numeric',
  cbMoney.length === 4 && cbMoney.every((c) => c.data_type === 'numeric'),
  cbMoney.map((c) => `${c.column_name}:${c.data_type}`).join(', '));

// Поля разбора существуют: без них расхождение нечем объяснить.
const forensics = (await pay.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name='SubscriptionPayment'
    AND column_name IN ('deliveredToAddress','providerTxType','purchaseNetwork','purchaseCurrency','checkoutExpiresAt')
  ORDER BY 1
`)).rows.map((r) => r.column_name);

check('поля для разбора расхождений на месте', forensics.length === 5, forensics.join(', '));

// События обоих провайдеров живут в одной таблице и не мешают друг другу.
await pay.exec(`
  INSERT INTO "WebhookReceipt" ("id","provider","eventId","eventType","eventCreatedAt","outcome","receivedAt")
  VALUES ('w-cb1','COINBASE','shared-evt','onramp.transaction.success',NOW(),'ACCEPTED',NOW());
`);

let sameEventOtherProvider = null;
try {
  await pay.exec(`
    INSERT INTO "WebhookReceipt" ("id","provider","eventId","eventType","eventCreatedAt","outcome","receivedAt")
    VALUES ('w-br1','BRIDGE','shared-evt','transfer.updated',NOW(),'ACCEPTED',NOW());
  `);
} catch (e) { sameEventOtherProvider = e.message; }

check('одинаковый идентификатор события у разных провайдеров не конфликтует',
  sameEventOtherProvider === null,
  sameEventOtherProvider ?? 'обе записи приняты');

let dupCoinbaseEvent = null;
try {
  await pay.exec(`
    INSERT INTO "WebhookReceipt" ("id","provider","eventId","eventType","eventCreatedAt","outcome","receivedAt")
    VALUES ('w-cb2','COINBASE','shared-evt','onramp.transaction.success',NOW(),'ACCEPTED',NOW());
  `);
} catch (e) { dupCoinbaseEvent = e.message; }

check('повторное событие Coinbase отклонено базой', dupCoinbaseEvent != null,
  dupCoinbaseEvent ? 'ограничение сработало' : 'вставка прошла');

// Исторические платежи Bridge остаются читаемыми после появления
// второго провайдера — иначе смена провайдера означала бы потерю
// незакрытых покупок.
const bridgeStillThere = await pay.query(
  `SELECT COUNT(*)::int c FROM "SubscriptionPayment" WHERE "provider"='BRIDGE'`,
);
check('платежи Bridge продолжают читаться', bridgeStillThere.rows[0].c >= 3,
  `${bridgeStillThere.rows[0].c} шт.`);

// ─────────────────────────── Возраст рынка ─────────────────────────────────

console.log('\n=== Возраст рынка ===');

const ageCols = (await clean.query(`
  SELECT column_name, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_name='Token' AND column_name IN ('poolCreatedAt','firstSeenAt')
  ORDER BY 1
`)).rows;

check('колонки возраста добавлены', ageCols.length === 2,
  ageCols.map((c) => c.column_name).join(', '));

check('обе необязательны', ageCols.every((c) => c.is_nullable === 'YES'));

// Умолчание `now()` объявило бы все существующие токены созданными
// в момент миграции, то есть выдало бы полторы тысячи старых
// за новые разом.
check('умолчания нет: старые записи не становятся новыми',
  ageCols.every((c) => c.column_default === null));

const ageIdx = (await clean.query(`
  SELECT indexname FROM pg_indexes
  WHERE tablename='Token' AND indexname LIKE '%CreatedAt%' OR indexname LIKE '%firstSeenAt%'
`)).rows.map((r) => r.indexname);

check('индексы под отбор по возрасту на месте', ageIdx.length >= 2, ageIdx.join(', '));

// Существующие строки остаются без возраста, и это правильный ответ:
// «возраст неизвестен» честнее выдуманной даты.
await clean.exec(`
  INSERT INTO "Token" ("id","chain","address","symbol","name","decimals")
  VALUES ('t-age','SOLANA','AgeTestAddress1111111111111111111111111111','AGE','Age',9);
`);

const aged = await clean.query(`SELECT "poolCreatedAt" p, "firstSeenAt" f FROM "Token" WHERE id='t-age'`);
check('у новой строки возраст пуст, а не выдуман',
  aged.rows[0].p === null && aged.rows[0].f === null);

// ───────────────────── Очередь проверки и возраст цены ─────────────────────

console.log('\n=== Очередь проверки и возраст цены ===');

const queueCols = (await clean.query(`
  SELECT column_name, is_nullable, column_default, data_type
  FROM information_schema.columns
  WHERE table_name='Token'
    AND column_name IN ('scamCheckAttempts','scamCheckNextAt','scamProviderError','priceUpdatedAt')
  ORDER BY 1
`)).rows;

const q = Object.fromEntries(queueCols.map((c) => [c.column_name, c]));

check('все четыре колонки добавлены', queueCols.length === 4,
  queueCols.map((c) => c.column_name).join(', '));

// Счётчик и флаг обязаны иметь умолчание: полторы тысячи
// существующих строк иначе получили бы NULL там, где код ждёт число.
check('счётчик попыток начинается с нуля у существующих строк',
  q.scamCheckAttempts?.column_default?.startsWith('0') === true,
  q.scamCheckAttempts?.column_default ?? 'нет умолчания');

check('флаг ошибки провайдера по умолчанию снят',
  q.scamProviderError?.column_default === 'false',
  q.scamProviderError?.column_default ?? 'нет умолчания');

// А у времени умолчания быть не должно: now() объявил бы все
// существующие цены свежими в момент миграции.
check('у возраста цены умолчания нет: старые котировки не становятся свежими',
  q.priceUpdatedAt?.column_default === null && q.priceUpdatedAt?.is_nullable === 'YES');

check('время следующей попытки необязательно',
  q.scamCheckNextAt?.is_nullable === 'YES' && q.scamCheckNextAt?.column_default === null);

const queueIdx = (await clean.query(`
  SELECT indexname FROM pg_indexes
  WHERE tablename='Token' AND (indexname LIKE '%scamCheckNextAt%' OR indexname LIKE '%priceUpdatedAt%')
  ORDER BY 1
`)).rows.map((r) => r.indexname);

check('индексы под отбор очереди и холодного цикла цен', queueIdx.length === 2,
  queueIdx.join(', '));

// Существующая строка переживает добавление колонок и получает
// честные значения, а не выдуманные.
await clean.exec(`
  INSERT INTO "Token" ("id","chain","address","symbol","name","decimals")
  VALUES ('t-queue','SOLANA','QueueTestAddress111111111111111111111111111','QQ','Queue',9);
`);

const qrow = (await clean.query(`
  SELECT "scamCheckAttempts" a, "scamCheckNextAt" n, "scamProviderError" e, "priceUpdatedAt" p
  FROM "Token" WHERE id='t-queue'
`)).rows[0];

check('новая строка: попыток ноль, ошибок нет, повтор не запланирован',
  qrow.a === 0 && qrow.e === false && qrow.n === null);

check('возраст цены пуст, а не выдуман', qrow.p === null);

// ──────────────────────────── OKX Signal ──────────────────────────────────

console.log('\n=== История OKX Signal ===');

check('таблица OkxSignal создана', tables.includes('OkxSignal'));

await clean.exec(`
  INSERT INTO "OkxSignal"
    ("id","providerKey","chain","address","tokenId","symbol","name","signaledAt","priceUsd","walletTypes","source")
  VALUES
    ('sig-1','provider-1','SOLANA','SignalAddress111111111111111111111111111','t-queue','GEM','Gem',NOW(),0.001,ARRAY['smart_money'],'okx_websocket');
`);

// Миграция приходит поверх уже накопленных событий и обязана дать
// им честную первую точку ATH, не меняя исходную цену сигнала.
await clean.exec(okxSignalAth);

const signalRows = await clean.query(`
  SELECT "tokenId","walletTypes","priceUsd","peakPriceUsd","peakObservedAt"
  FROM "OkxSignal" WHERE id='sig-1'
`);
check('сигнал связан с импортированным токеном', signalRows.rows[0]?.tokenId === 't-queue');
check('типы кошельков сохраняются массивом', signalRows.rows[0]?.walletTypes?.[0] === 'smart_money');
check('существующий сигнал начинает ATH со своей цены',
  String(signalRows.rows[0]?.peakPriceUsd) === String(signalRows.rows[0]?.priceUsd));
check('существующий сигнал получает время первого пика', signalRows.rows[0]?.peakObservedAt != null);

const athColumns = (await clean.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name='OkxSignal' AND column_name IN ('peakPriceUsd','peakObservedAt')
`)).rows.map((row) => row.column_name);
check('колонки ATH сигнала созданы вместе', athColumns.length === 2, athColumns.join(', '));

let duplicateSignal = null;
try {
  await clean.exec(`
    INSERT INTO "OkxSignal"
      ("id","providerKey","chain","address","symbol","name","signaledAt","walletTypes","source")
    VALUES
      ('sig-2','provider-1','SOLANA','OtherSignal111111111111111111111111111','OTHER','Other',NOW(),ARRAY[]::text[],'okx_rest');
  `);
} catch (e) {
  duplicateSignal = e.message;
}
check('одно событие провайдера не записывается дважды', duplicateSignal != null,
  duplicateSignal ? 'ограничение сработало' : 'вставка прошла');

// ───────────────── Происхождение экономической сделки ──────────────────────

console.log('\n=== Происхождение и идентичность сделки ===');

await clean.exec(tradeProvenance);

const provCols = (await clean.query(`
  SELECT column_name, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_name='WalletEconomicTrade'
    AND column_name IN ('source','sourceEventId','txHash','fillCount',
                        'firstFillAt','lastFillAt','reconciliation','supersededBy')
  ORDER BY 1
`)).rows;

const pc = Object.fromEntries(provCols.map((c) => [c.column_name, c]));

check('все восемь колонок добавлены', provCols.length === 8,
  provCols.map((c) => c.column_name).join(', '));

check('источник по умолчанию — история',
  pc.source?.column_default?.includes('okx_dex_history') === true,
  pc.source?.column_default ?? 'нет умолчания');

check('состояние сверки по умолчанию каноническое',
  pc.reconciliation?.column_default?.includes('canonical') === true,
  pc.reconciliation?.column_default ?? 'нет умолчания');

check('счётчик переводов начинается с единицы',
  pc.fillCount?.column_default?.startsWith('1') === true,
  pc.fillCount?.column_default ?? 'нет умолчания');

check('хеш транзакции необязателен: история его не отдаёт',
  pc.txHash?.is_nullable === 'YES' && pc.txHash?.column_default === null);

// Частичный уникальный индекс — главное здесь.
const liveIdx = (await clean.query(`
  SELECT indexdef FROM pg_indexes
  WHERE tablename='WalletEconomicTrade' AND indexname='WalletEconomicTrade_live_identity'
`)).rows;

check('индекс живой идентичности частичный',
  liveIdx.length === 1 && /WHERE .*txHash.* IS NOT NULL/i.test(liveIdx[0].indexdef),
  liveIdx.length ? liveIdx[0].indexdef : 'индекса нет');

// Проверка поведения, а не только определения.
await clean.exec(`
  INSERT INTO "WalletEconomicTrade"
    ("key","chain","walletAddress","tokenAddress","side","amount","valueUsd","price","tradedAt","updatedAt")
  VALUES
    ('k-live-1','SOLANA','W1','T1','BUY',1,1,1,NOW(),NOW()),
    ('k-hist-1','SOLANA','W1','T1','BUY',1,1,1,NOW(),NOW()),
    ('k-hist-2','SOLANA','W1','T1','BUY',2,2,1,NOW(),NOW());
`);

check('несколько строк без хеша уживаются: NULL не конфликтует', true,
  'история хеша не отдаёт, и это законно');

await clean.exec(`UPDATE "WalletEconomicTrade" SET "txHash"='0xdead' WHERE "key"='k-live-1'`);

let dupLive = null;
try {
  await clean.exec(`
    INSERT INTO "WalletEconomicTrade"
      ("key","chain","walletAddress","tokenAddress","side","amount","valueUsd","price","txHash","tradedAt","updatedAt")
    VALUES ('k-live-dup','SOLANA','W1','T1','BUY',1,1,1,'0xdead',NOW(),NOW());
  `);
} catch (e) { dupLive = e.message; }

check('одна транзакция — одна live-сделка', dupLive != null,
  dupLive ? 'ограничение сработало' : 'вставка прошла');

// Та же транзакция с другой стороной — законная вторая половина свопа.
let swapHalf = null;
try {
  await clean.exec(`
    INSERT INTO "WalletEconomicTrade"
      ("key","chain","walletAddress","tokenAddress","side","amount","valueUsd","price","txHash","tradedAt","updatedAt")
    VALUES ('k-live-sell','SOLANA','W1','T1','SELL',1,1,1,'0xdead',NOW(),NOW());
  `);
} catch (e) { swapHalf = e.message; }

check('две половины свопа не конфликтуют', swapHalf === null,
  swapHalf ?? 'обе записаны');

// ───────────────────── Контракт сводки кошелька ────────────────────────────

console.log('\n=== Контракт сводки результативности ===');

/*
 * До миграции в таблице лежит строка, посчитанная прежними правилами:
 * оценка 100 при двух исходах. Она специально записывается здесь,
 * чтобы проверить не определение колонок, а поведение — что миграция
 * оставляет её на месте и при этом делает отличимой от пересчитанной.
 */
await clean.exec(`
  INSERT INTO "TraderWallet" ("id","chain","address","tokensBought","wins2x","wins5x","rugs","score","updatedAt")
  VALUES ('tw-legacy','SOLANA','LegacyWallet1111111111111111111111111',2,8,3,0,100,NOW());
`);

await clean.exec(walletSummary);

const sumCols = (await clean.query(`
  SELECT column_name, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_name='TraderWallet'
    AND column_name IN ('scorableOutcomes','pendingOutcomes','ambiguousOutcomes',
                        'scoreVersion','scoreComputedAt','scoreConfidence',
                        'scoreCoverage','scoreReason')
  ORDER BY 1
`)).rows;

check('все восемь колонок сводки добавлены', sumCols.length === 8,
  sumCols.map((c) => c.column_name).join(', '));

/*
 * Главная проверка этой миграции.
 *
 * Умолчание `0` у знаменателя выглядело бы безобидно и уничтожило бы
 * весь смысл: строка, никогда не пересчитанная, стала бы неотличима
 * от честно посчитанной строки с нулём оцениваемых исходов, и чтение
 * не смогло бы отказаться показывать её старую оценку.
 */
check('ни у одной колонки сводки нет умолчания',
  sumCols.every((c) => c.column_default === null),
  sumCols.filter((c) => c.column_default !== null).map((c) => c.column_name).join(', ') || 'умолчаний нет');

check('все колонки сводки допускают NULL',
  sumCols.every((c) => c.is_nullable === 'YES'));

const legacy = (await clean.query(`
  SELECT "score","wins2x","tokensBought","scoreVersion","scorableOutcomes","ambiguousOutcomes"
  FROM "TraderWallet" WHERE "id"='tw-legacy'
`)).rows[0];

check('старая строка не удалена и не изменена',
  Number(legacy.score) === 100 && Number(legacy.wins2x) === 8 && Number(legacy.tokensBought) === 2);

check('старая строка отличима: версия расчёта пуста',
  legacy.scoreVersion === null && legacy.scorableOutcomes === null,
  `scoreVersion=${legacy.scoreVersion}, scorableOutcomes=${legacy.scorableOutcomes}`);

/*
 * Нейтральные исходы — та самая потеря, ради которой миграция и нужна.
 * Знаменатель 10 при одной победе и одном rug не выводится из wins
 * и rugs никаким выражением, поэтому он записывается отдельно.
 */
await clean.exec(`
  INSERT INTO "TraderWallet"
    ("id","chain","address","tokensBought","wins2x","wins5x","rugs",
     "scorableOutcomes","pendingOutcomes","ambiguousOutcomes",
     "scoreVersion","scoreComputedAt","scoreConfidence","scoreCoverage","updatedAt")
  VALUES ('tw-new','SOLANA','FreshWallet11111111111111111111111111',10,1,0,1,
          10,0,0,2,'2026-08-25T10:00:00Z','low','complete',NOW());
`);

const fresh = (await clean.query(`
  SELECT "scorableOutcomes","wins2x","rugs","scoreVersion",
         -- Сравнение делает сама база.
         --
         -- Колонка объявлена без часового пояса, и разбор её значения
         -- в JavaScript добавил бы смещение машины, где идёт проверка.
         -- Тогда проверка падала бы или проходила в зависимости от TZ,
         -- то есть проверяла бы не то, что записано.
         ("scoreComputedAt" = TIMESTAMP '2026-08-25 10:00:00') AS "timeKept"
  FROM "TraderWallet" WHERE "id"='tw-new'
`)).rows[0];

check('знаменатель хранится, а не выводится из побед и rug',
  Number(fresh.scorableOutcomes) === 10 &&
  Number(fresh.scorableOutcomes) !== Math.max(Number(fresh.wins2x), Number(fresh.rugs)),
  `хранится ${fresh.scorableOutcomes}, max(wins,rugs) = ${Math.max(Number(fresh.wins2x), Number(fresh.rugs))}`);

check('время расчёта сохраняется как момент пересчёта', fresh.timeKept === true);

const versionIdx = (await clean.query(`
  SELECT indexname FROM pg_indexes
  WHERE tablename='TraderWallet' AND indexname='TraderWallet_scoreVersion_idx'
`)).rows;

check('есть индекс по версии расчёта', versionIdx.length === 1);

// ───────────────────── Локальный PnL события ленты ────────────────────────

console.log('\n=== Локальный PnL события ленты ===');

// Существующая строка несёт число провайдера. Миграция обязана
// сохранить его как диагностику, но не заполнять локальный результат.
await clean.exec(`
  INSERT INTO "WalletActivity"
    ("id","chain","walletAddress","tokenAddress","side","realizedPnlUsd",
     "source","parsingConfidence","tradedAt")
  VALUES ('wa-legacy','SOLANA','W1','T1','SELL',999,'okx_rest',1,NOW());
`);

await clean.exec(walletActivityPnl);

const pnlCols = (await clean.query(`
  SELECT column_name, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_name='WalletActivity'
    AND column_name IN ('canonicalTradeKey','localRealizedPnlUsd','localCostBasisUsd',
                        'localPnlState','pnlVersion','pnlComputedAt')
  ORDER BY 1
`)).rows;

check('все шесть колонок локального PnL добавлены', pnlCols.length === 6,
  pnlCols.map((c) => c.column_name).join(', '));
check('локальные поля допускают NULL и не имеют умолчаний',
  pnlCols.every((c) => c.is_nullable === 'YES' && c.column_default === null));

const legacyActivity = (await clean.query(`
  SELECT "realizedPnlUsd","localRealizedPnlUsd","pnlVersion"
  FROM "WalletActivity" WHERE "id"='wa-legacy'
`)).rows[0];

check('число провайдера сохранено только как диагностика',
  Number(legacyActivity.realizedPnlUsd) === 999 &&
  legacyActivity.localRealizedPnlUsd === null && legacyActivity.pnlVersion === null);

const localPnlIndexes = (await clean.query(`
  SELECT indexname FROM pg_indexes
  WHERE tablename='WalletActivity'
    AND indexname IN ('WalletActivity_canonicalTradeKey_key',
                      'WalletActivity_localPnlState_tradedAt_idx',
                      'WalletActivity_pnlVersion_idx')
`)).rows;
check('индексы локального PnL созданы вместе', localPnlIndexes.length === 3);

await clean.exec(`
  INSERT INTO "WalletActivity"
    ("id","chain","walletAddress","tokenAddress","side","source",
     "parsingConfidence","tradedAt","canonicalTradeKey")
  VALUES ('wa-match-1','SOLANA','W1','T1','BUY','okx_rest',1,NOW(),'trade-1');
`);
let duplicateCanonicalTrade = null;
try {
  await clean.exec(`
    INSERT INTO "WalletActivity"
      ("id","chain","walletAddress","tokenAddress","side","source",
       "parsingConfidence","tradedAt","canonicalTradeKey")
    VALUES ('wa-match-2','SOLANA','W1','T1','BUY','okx_rest',1,NOW(),'trade-1');
  `);
} catch (error) {
  duplicateCanonicalTrade = error;
}
check(
  'одна каноническая сделка не объясняет два события',
  duplicateCanonicalTrade != null,
  'ограничение сработало',
);

// ───────────────────── Автономный paper-агент ────────────────────────────

console.log('\n=== Автономный paper-агент ===');
await clean.exec(paperAgent);

const agentTables = (await clean.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname='public'
    AND tablename IN ('PaperAgentControl','PaperAgentStrategy','PaperAgentRun')
  ORDER BY 1
`)).rows.map((row) => row.tablename);
check('все три таблицы paper-агента созданы', agentTables.length === 3, agentTables.join(', '));

const signalAddresses = (await clean.query(`
  SELECT "triggerWalletAddresses" FROM "OkxSignal" WHERE id='sig-1'
`)).rows[0]?.triggerWalletAddresses;
check('старые сигналы получают пустой список адресов, а не NULL',
  Array.isArray(signalAddresses) && signalAddresses.length === 0);

await clean.exec(`
  INSERT INTO "PaperAgentStrategy"
    ("id","key","version","label","kind","config","updatedAt")
  VALUES ('strategy-1','baseline-v1',1,'Baseline','BASELINE','{}',NOW());
  INSERT INTO "PaperAgentRun"
    ("id","signalId","strategyId","providerKey","tokenId","chain","address","symbol",
     "source","state","signaledAt","receivedAt","walletTypes","updatedAt")
  VALUES ('run-1','sig-1','strategy-1','provider-1','t-queue','SOLANA',
          'SignalAddress111111111111111111111111111','GEM','okx_websocket','RECEIVED',
          NOW(),NOW(),ARRAY['smart_money'],NOW());
`);

let duplicateRun = null;
try {
  await clean.exec(`
    INSERT INTO "PaperAgentRun"
      ("id","signalId","strategyId","providerKey","chain","address","symbol",
       "source","state","signaledAt","receivedAt","walletTypes","updatedAt")
    VALUES ('run-2','sig-1','strategy-1','provider-1','SOLANA','A','GEM',
            'okx_rest','RECEIVED',NOW(),NOW(),ARRAY[]::text[],NOW());
  `);
} catch (error) {
  duplicateRun = error;
}
check('одно событие не создаёт две позиции одной стратегии', duplicateRun != null,
  duplicateRun ? 'ограничение сработало' : 'дубликат записан');

const agentIndexes = (await clean.query(`
  SELECT indexname FROM pg_indexes
  WHERE tablename='PaperAgentRun'
    AND indexname IN ('PaperAgentRun_signalId_strategyId_key',
                      'PaperAgentRun_state_updatedAt_idx',
                      'PaperAgentRun_tokenId_state_idx')
`)).rows;
check('у paper-агента есть уникальность и индексы сопровождения', agentIndexes.length === 3,
  String(agentIndexes.length));

// ───────────────────── Paper-агент Phase 2 ───────────────────────────────

console.log('\n=== Paper-агент Phase 2 ===');
await clean.exec(paperAgentPhase2);

const controlDefault = (await clean.query(`
  SELECT column_default FROM information_schema.columns
  WHERE table_name='PaperAgentControl' AND column_name='isEnabled'
`)).rows[0]?.column_default;
check('новая база начинает с выключенным агентом', /false/i.test(String(controlDefault)), String(controlDefault));

const phase2Tables = (await clean.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname='public' AND tablename='PaperAgentNotification'
`)).rows;
check('transactional outbox создан', phase2Tables.length === 1);

const phase2RunColumns = (await clean.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name='PaperAgentRun'
    AND column_name IN ('costModelKey','tradeFeeBps','entrySlippageBps','exitSlippageBps',
                        'networkFeeUsdPerSide','entryTradingFeeUsd','entryNetworkFeeUsd',
                        'entrySlippageUsd','exitTradingFeeUsd','exitNetworkFeeUsd',
                        'exitSlippageUsd','totalCostsUsd')
`)).rows;
check('все поля снимка расходов добавлены', phase2RunColumns.length === 12, String(phase2RunColumns.length));

await clean.exec(`
  INSERT INTO "PaperAgentNotification"
    ("id","eventKey","runId","eventType","payload","updatedAt")
  VALUES ('notice-1','run-1:PAPER_BUY:v2','run-1','PAPER_BUY','{}',NOW());
`);
let duplicateNotice = null;
try {
  await clean.exec(`
    INSERT INTO "PaperAgentNotification"
      ("id","eventKey","runId","eventType","payload","updatedAt")
    VALUES ('notice-2','run-1:PAPER_BUY:v2','run-1','PAPER_BUY','{}',NOW());
  `);
} catch (error) {
  duplicateNotice = error;
}
check('одно событие уведомления не записывается дважды', duplicateNotice != null,
  duplicateNotice ? 'ограничение сработало' : 'дубликат записан');

// Имитируем существующую инсталляцию, где Phase 2 агент был включён.
// Phase 3 обязана безопасно вернуть его в OFF до явной настройки капитала.
await clean.exec(`
  INSERT INTO "PaperAgentControl" ("id","isEnabled","updatedAt")
  VALUES ('primary',true,NOW())
  ON CONFLICT ("id") DO UPDATE SET "isEnabled"=true,"updatedAt"=NOW();
`);

// ───────────────────── Paper-агент Phase 3 ───────────────────────────────

console.log('\n=== Paper-агент Phase 3 ===');
await clean.exec(paperAgentPhase3);

const phase3Tables = (await clean.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname='public'
    AND tablename IN ('PaperAgentAllocationPolicy','PaperAgentAccountSession',
                      'PaperAgentAllocation','PaperAgentCapitalLedger')
  ORDER BY 1
`)).rows.map((row) => row.tablename);
check('все четыре таблицы распределения капитала созданы', phase3Tables.length === 4,
  phase3Tables.join(', '));

const phase3Control = (await clean.query(`
  SELECT "isEnabled","activeAllocationMode","learningModeEnabled"
  FROM "PaperAgentControl" WHERE id='primary'
`)).rows[0];
check('Phase 3 не включает агента и не выбирает режим сама',
  phase3Control != null &&
    phase3Control.isEnabled === false &&
    phase3Control.activeAllocationMode === null &&
    phase3Control.learningModeEnabled === false);

const legacyPhase2Run = (await clean.query(`
  SELECT "state","symbol","strategyId" FROM "PaperAgentRun" WHERE id='run-1'
`)).rows[0];
const legacyPhase2Allocations = (await clean.query(`
  SELECT COUNT(*)::int AS count FROM "PaperAgentAllocation" WHERE "runId"='run-1'
`)).rows[0]?.count;
check('Phase 3 сохраняет legacy run без пересчёта и выдуманной аллокации',
  legacyPhase2Run?.state === 'RECEIVED' &&
    legacyPhase2Run?.symbol === 'GEM' &&
    legacyPhase2Run?.strategyId === 'strategy-1' &&
    legacyPhase2Allocations === 0,
  `state=${legacyPhase2Run?.state}, allocations=${legacyPhase2Allocations}`);

await clean.exec(`
  INSERT INTO "PaperAgentAllocationPolicy"
    ("id","policyKey","version","mode","label","limits","scorePolicyKey","scorePolicyVersion")
  VALUES ('policy-1','fixed-test',1,'FIXED','Fixed','{}','score',1);
  INSERT INTO "PaperAgentAccountSession"
    ("id","kind","mode","policyKey","policyVersion","policySnapshot",
     "scorePolicyKey","scorePolicyVersion","reservePct","maxExposurePct",
     "maxPositionPct","maxOpenPositions","minimumPositionUsd","dailyEntryLimit",
     "drawdownStopPct","allowPartialAllocation","initialCapitalUsd","freeBalanceUsd",
     "reservedBalanceUsd","inPositionsUsd","realizedPnlUsd","unrealizedPnlUsd",
     "tradingFeesUsd","slippageUsd","networkCostsUsd","equityUsd","peakEquityUsd",
     "drawdownPct","dailyEntriesDate","updatedAt")
  VALUES ('account-1','ACTIVE','FIXED','fixed-test',1,'{}','score',1,30,70,25,4,5,100,100,
          false,100,70,30,0,0,0,0,0,0,100,100,0,NOW(),NOW());
  INSERT INTO "PaperAgentAllocation"
    ("id","sessionId","runId","isShadow","state","decisionCode","mode","policyKey",
     "policyVersion","policySnapshot","inputFacts","signalScore","signalBand",
     "allocationReason","allocatedUsd","capitalPct","freeAfterUsd","reserveAfterUsd",
     "exposureAfterUsd","updatedAt")
  VALUES ('allocation-1','account-1','run-1',false,'OPEN','ALLOCATED','FIXED','fixed-test',1,
          '{}','{}',50,'MEDIUM','FIXED_MEDIUM_POSITION',25,25,45,30,25,NOW());
  INSERT INTO "PaperAgentCapitalLedger"
    ("id","eventKey","sessionId","allocationId","eventType","amountUsd",
     "freeBeforeUsd","freeAfterUsd","reservedBeforeUsd","reservedAfterUsd",
     "inPositionsBeforeUsd","inPositionsAfterUsd","realizedPnlAfterUsd","equityAfterUsd",
     "tradingFeesAfterUsd","slippageAfterUsd","networkCostsAfterUsd")
  VALUES ('ledger-1','allocation-1:OPEN','account-1','allocation-1','OPEN',25,
          70,45,30,30,0,25,0,100,0,0,0);
`);

let duplicateAllocation = null;
try {
  await clean.exec(`
    INSERT INTO "PaperAgentAllocation"
      ("id","sessionId","runId","isShadow","state","decisionCode","mode","policyKey",
       "policyVersion","policySnapshot","inputFacts","signalScore","signalBand",
       "allocationReason","freeAfterUsd","reserveAfterUsd","exposureAfterUsd","updatedAt")
    VALUES ('allocation-2','account-1','run-1',false,'SKIPPED','LIMIT','FIXED','fixed-test',1,
            '{}','{}',0,'WEAK','duplicate',45,30,25,NOW());
  `);
} catch (error) {
  duplicateAllocation = error;
}
check('один run получает не больше одного решения на капиталовый контур',
  duplicateAllocation != null, duplicateAllocation ? 'ограничение сработало' : 'дубликат записан');

let duplicateLedger = null;
try {
  await clean.exec(`
    INSERT INTO "PaperAgentCapitalLedger"
      ("id","eventKey","sessionId","eventType","amountUsd","freeBeforeUsd","freeAfterUsd",
       "reservedBeforeUsd","reservedAfterUsd","inPositionsBeforeUsd","inPositionsAfterUsd",
       "realizedPnlAfterUsd","equityAfterUsd","tradingFeesAfterUsd","slippageAfterUsd",
       "networkCostsAfterUsd")
    VALUES ('ledger-2','allocation-1:OPEN','account-1','OPEN',25,70,45,30,30,0,25,0,100,0,0,0);
  `);
} catch (error) {
  duplicateLedger = error;
}
check('повтор капиталовой проводки блокируется eventKey', duplicateLedger != null,
  duplicateLedger ? 'ограничение сработало' : 'дубликат записан');

// ───────────── Signal provenance and latency observability ────────────────

console.log('\n=== Paper-agent signal pipeline ===');
check('миграция pipeline не содержит destructive SQL',
  !/\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/i.test(paperAgentSignalPipeline));
await clean.exec(paperAgentSignalPipeline);

const signalPipelineColumns = (await clean.query(`
  SELECT table_name,column_name FROM information_schema.columns
  WHERE table_schema='public' AND (
    (table_name='OkxSignal' AND column_name IN ('ingestOrigin','paperAgentIngestCode')) OR
    (table_name='PaperAgentRun' AND column_name IN
      ('signalOrigin','providerDeliveryLatencyMs','agentDecisionLatencyMs','endToEndLatencyMs'))
  )
`)).rows;
check('все шесть колонок pipeline добавлены', signalPipelineColumns.length === 6,
  String(signalPipelineColumns.length));

const legacyPipelineRow = (await clean.query(`
  SELECT "ingestOrigin","paperAgentIngestCode" FROM "OkxSignal" WHERE id='sig-1'
`)).rows[0];
const legacyPipelineRun = (await clean.query(`
  SELECT "signalOrigin","providerDeliveryLatencyMs","agentDecisionLatencyMs","endToEndLatencyMs"
  FROM "PaperAgentRun" WHERE id='run-1'
`)).rows[0];
check('исторические строки сохранены и новые поля остаются NULL',
  legacyPipelineRow?.ingestOrigin == null &&
    legacyPipelineRow?.paperAgentIngestCode == null &&
    legacyPipelineRun?.signalOrigin == null &&
    legacyPipelineRun?.providerDeliveryLatencyMs == null &&
    legacyPipelineRun?.agentDecisionLatencyMs == null &&
    legacyPipelineRun?.endToEndLatencyMs == null);

// ───────────────────── Phase 4 LIVE foundation ───────────────────────────

console.log('\n=== Phase 4 LIVE foundation ===');
check('Phase 4 migration is additive only',
  !/\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/i.test(phase4LiveFoundation));
await clean.exec(phase4LiveFoundation);

const phase4Tables = (await clean.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname='public' AND tablename IN (
    'SolanaDepositCheckpoint','SolanaDepositEvent','LiveAgentProposal',
    'SolanaTransaction','WithdrawalOperation','ComplianceReview',
    'SolanaReconciliationIssue','KmsAuditEvent'
  ) ORDER BY 1
`)).rows.map((row) => row.tablename);
check('all eight Phase 4 tables created', phase4Tables.length === 8, phase4Tables.join(', '));

await clean.exec(`
  INSERT INTO "SolanaDepositEvent"
    ("id","eventKey","signature","instructionIndex","slot","destination","rawAmount","updatedAt")
  VALUES
    ('dep-event-1','same-signature:0','same-signature',0,10,'wallet','1000000',NOW()),
    ('dep-event-2','same-signature:1','same-signature',1,10,'wallet','2000000',NOW());
`);
const multiTransfer = (await clean.query(`
  SELECT COUNT(*)::int AS count FROM "SolanaDepositEvent" WHERE "signature"='same-signature'
`)).rows[0]?.count;
check('one transaction may contain multiple transfer events', multiTransfer === 2, String(multiTransfer));

let duplicateDepositEvent = null;
try {
  await clean.exec(`
    INSERT INTO "SolanaDepositEvent"
      ("id","eventKey","signature","instructionIndex","slot","destination","rawAmount","updatedAt")
    VALUES ('dep-event-3','same-signature:0','same-signature',0,10,'wallet','1000000',NOW());
  `);
} catch (error) {
  duplicateDepositEvent = error;
}
check('same signature and instruction index cannot be credited twice',
  duplicateDepositEvent != null,
  duplicateDepositEvent ? 'constraint enforced' : 'duplicate inserted');

// ───────────────────── Phase 4 сверка с цепочкой ─────────────────────────

console.log('\n=== Phase 4 сверка ===');
check('миграция сверки только добавляет',
  !/\b(?:DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN|RENAME)\b/i.test(phase4Reconciliation));

// Строка, существовавшая до миграции: боевая база не пуста.
await clean.exec(phase4Reconciliation);

const legacyDepositEvent = (await clean.query(`
  SELECT "reconciliationState", "lastChainSeenAt", "missingSince",
         "consecutiveMissingChecks", "reconcileAttempts"
  FROM "SolanaDepositEvent" WHERE "id"='dep-event-1'
`)).rows[0];
check('старая строка остаётся несверенной, а не «совпавшей»',
  legacyDepositEvent?.reconciliationState == null &&
  legacyDepositEvent?.lastChainSeenAt == null &&
  legacyDepositEvent?.missingSince == null,
  JSON.stringify(legacyDepositEvent));
check('счётчики начинаются с честного нуля',
  Number(legacyDepositEvent?.consecutiveMissingChecks) === 0 &&
  Number(legacyDepositEvent?.reconcileAttempts) === 0);

const reconciliationTables = (await clean.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname='public'
    AND tablename IN ('SolanaDepositAddressCursor','FundingSafetyLatch')
  ORDER BY 1
`)).rows.map((row) => row.tablename);
check('таблицы курсора адресов и защёлки созданы',
  reconciliationTables.length === 2, reconciliationTables.join(', '));

const latchDefault = (await clean.query(`
  INSERT INTO "FundingSafetyLatch" ("id","updatedAt") VALUES ('solana-funding-v1', NOW())
  RETURNING "state"
`)).rows[0]?.state;
check('защёлка по умолчанию здорова', latchDefault === 'HEALTHY', String(latchDefault));

// Повторное применение: планировщик может встретить частично
// применённую миграцию после обрыва деплоя.
let reapplyError = null;
try {
  await clean.exec(phase4Reconciliation);
} catch (error) {
  reapplyError = error;
}
check('повторное применение не падает', reapplyError == null, reapplyError?.message ?? 'ok');

// ───────────────────── Phase 4D подпись без отправки ─────────────────────

console.log('\n=== Phase 4D подпись ===');
check('миграция намерений только добавляет',
  !/\b(?:DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN|RENAME)\b/i.test(transactionIntent));

/*
 * Отправки в модели нет.
 *
 * Проверяется отсутствие состояний, а не наличие проверки перед
 * отправкой: несуществующее состояние обойти нельзя, а проверку —
 * можно.
 */
/*
 * Комментарии вырезаются: в шапке миграции перечислено ровно то,
 * чего в ней нет, и совпадение с текстом объяснения не является
 * совпадением с DDL.
 */
const intentDdl = transactionIntent.replace(/--.*$/gm, '');
check('в модели нет состояний отправки и подтверждения',
  !/SUBMITTED|CONFIRMED|FINALIZED|broadcast/i.test(intentDdl));

await clean.exec(transactionIntent);

const intentTables = (await clean.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname='public' AND tablename IN ('TransactionIntent','SigningAttempt')
  ORDER BY 1
`)).rows.map((row) => row.tablename);
check('таблицы намерения и попытки подписи созданы',
  intentTables.length === 2, intentTables.join(', '));

// Суммы хранятся текстом: числовой тип потерял бы точность на u64.
const amountType = (await clean.query(`
  SELECT data_type FROM information_schema.columns
  WHERE table_name='TransactionIntent' AND column_name='rawAmount'
`)).rows[0]?.data_type;
check('сумма хранится текстом, а не числом', amountType === 'text', String(amountType));

await clean.exec(`
  INSERT INTO "TransactionIntent"
    ("id","userId","walletId","network","purpose","rawAmount","sourceAddress",
     "destinationAddress","feeLimitLamports","slippageBps","recentBlockhash",
     "lastValidBlockHeight","messageHash","policyVersion","updatedAt","expiresAt")
  VALUES
    ('intent-1','u1','w1','devnet','DEVNET_SELF_TRANSFER','18446744073709551615','addr',
     'addr','5000',50,'hash','1000','abc','phase4d-1',NOW(),NOW());
`);
const storedAmount = (await clean.query(`
  SELECT "rawAmount" FROM "TransactionIntent" WHERE "id"='intent-1'
`)).rows[0]?.rawAmount;
check('u64 на верхней границе не теряет точности',
  storedAmount === '18446744073709551615', String(storedAmount));

await clean.exec(`
  INSERT INTO "SigningAttempt" ("id","intentId","outcome","claimedBy")
  VALUES ('a1','intent-1','SUCCEEDED','worker-a');
`);
let secondSignature = null;
try {
  await clean.exec(`
    INSERT INTO "SigningAttempt" ("id","intentId","outcome","claimedBy")
    VALUES ('a2','intent-1','SUCCEEDED','worker-b');
  `);
} catch (error) {
  secondSignature = error;
}
check('одно намерение нельзя подписать дважды',
  secondSignature != null,
  secondSignature ? 'ограничение сработало' : 'вторая подпись записана');

// Неудачные попытки не ограничены: их может быть сколько угодно.
let secondFailure = null;
try {
  await clean.exec(`
    INSERT INTO "SigningAttempt" ("id","intentId","outcome","claimedBy")
    VALUES ('a3','intent-1','FAILED','worker-b'), ('a4','intent-1','AMBIGUOUS','worker-c');
  `);
} catch (error) {
  secondFailure = error;
}
check('неудачные попытки не блокируются', secondFailure == null);

/*
 * Атомарный захват на настоящем Postgres.
 *
 * До сих пор он проверялся только на подделке хранилища, а подделка
 * реализует ту семантику, которую от неё ждут. Здесь два «процесса»
 * бьются за одну строку в настоящей базе: выиграть должен ровно один.
 */
await clean.exec(`
  INSERT INTO "TransactionIntent"
    ("id","userId","walletId","network","purpose","rawAmount","sourceAddress",
     "destinationAddress","feeLimitLamports","slippageBps","recentBlockhash",
     "lastValidBlockHeight","messageHash","policyVersion","state","updatedAt","expiresAt")
  VALUES
    ('intent-race','u1','w1','devnet','DEVNET_SELF_TRANSFER','1','addr',
     'addr','5000',50,'hash','1000','abc','phase4d-1','APPROVED',NOW(),NOW() + INTERVAL '1 hour');
`);

const claimOne = (await clean.query(`
  UPDATE "TransactionIntent" SET "state"='SIGNING', "signingClaimedBy"='worker-a'
  WHERE "id"='intent-race' AND "state"='APPROVED' RETURNING "id"
`)).rows.length;
const claimTwo = (await clean.query(`
  UPDATE "TransactionIntent" SET "state"='SIGNING', "signingClaimedBy"='worker-b'
  WHERE "id"='intent-race' AND "state"='APPROVED' RETURNING "id"
`)).rows.length;

check('захват достаётся ровно одному процессу',
  claimOne === 1 && claimTwo === 0, `${claimOne} и ${claimTwo}`);

const claimOwner = (await clean.query(`
  SELECT "signingClaimedBy" FROM "TransactionIntent" WHERE "id"='intent-race'
`)).rows[0]?.signingClaimedBy;
check('второй процесс не перебил владельца захвата',
  claimOwner === 'worker-a', String(claimOwner));

// Подпись ставится только из состояния захвата: строка, у которой
// захват потерян, не должна получить подпись задним числом.
const signFromApproved = (await clean.query(`
  UPDATE "TransactionIntent" SET "state"='SIGNED', "signature"='sig'
  WHERE "id"='intent-race' AND "state"='APPROVED' RETURNING "id"
`)).rows.length;
check('подпись не ставится в обход захвата', signFromApproved === 0, String(signFromApproved));

// ── Жизненный цикл: происхождение и связь с предложением ──────────

check('миграция жизненного цикла только добавляет',
  !/\b(?:DROP|TRUNCATE|DELETE\s+FROM|RENAME)\b/i.test(intentLifecycle));

await clean.exec(intentLifecycle);

// Старая строка получает происхождение по умолчанию, но остаётся
// без связи с предложением: NULL здесь означает «не из предложения»,
// а не «предложение забыли записать».
const legacyIntent = (await clean.query(`
  SELECT "origin", "proposalId", "shownFingerprint"
  FROM "TransactionIntent" WHERE "id"='intent-1'
`)).rows[0];
check('старая строка не выдумывает связь с предложением',
  legacyIntent?.proposalId == null && legacyIntent?.shownFingerprint == null,
  JSON.stringify(legacyIntent));

await clean.exec(`
  INSERT INTO "TransactionIntent"
    ("id","userId","walletId","network","purpose","rawAmount","sourceAddress",
     "destinationAddress","feeLimitLamports","slippageBps","recentBlockhash",
     "lastValidBlockHeight","messageHash","policyVersion","state","proposalId",
     "updatedAt","expiresAt")
  VALUES
    ('intent-p1','u1','w1','devnet','DEVNET_SELF_TRANSFER','1','a','a','5000',50,
     'h','1000','abc','phase4d-1','APPROVED','proposal-1',NOW(),NOW() + INTERVAL '1 hour');
`);
let secondLiveIntent = null;
try {
  await clean.exec(`
    INSERT INTO "TransactionIntent"
      ("id","userId","walletId","network","purpose","rawAmount","sourceAddress",
       "destinationAddress","feeLimitLamports","slippageBps","recentBlockhash",
       "lastValidBlockHeight","messageHash","policyVersion","state","proposalId",
       "updatedAt","expiresAt")
    VALUES
      ('intent-p2','u1','w1','devnet','DEVNET_SELF_TRANSFER','1','a','a','5000',50,
       'h','1000','abc','phase4d-1','DRAFT','proposal-1',NOW(),NOW() + INTERVAL '1 hour');
  `);
} catch (error) {
  secondLiveIntent = error;
}
check('одно предложение не порождает два живых намерения',
  secondLiveIntent != null,
  secondLiveIntent ? 'ограничение сработало' : 'создано второе намерение');

// Закрытое намерение освобождает предложение: после отказа человек
// вправе получить новое предложение по тому же поводу.
await clean.exec(`UPDATE "TransactionIntent" SET "state"='REJECTED' WHERE "id"='intent-p1'`);
let afterRejected = null;
try {
  await clean.exec(`
    INSERT INTO "TransactionIntent"
      ("id","userId","walletId","network","purpose","rawAmount","sourceAddress",
       "destinationAddress","feeLimitLamports","slippageBps","recentBlockhash",
       "lastValidBlockHeight","messageHash","policyVersion","state","proposalId",
       "updatedAt","expiresAt")
    VALUES
      ('intent-p3','u1','w1','devnet','DEVNET_SELF_TRANSFER','1','a','a','5000',50,
       'h','1000','abc','phase4d-1','DRAFT','proposal-1',NOW(),NOW() + INTERVAL '1 hour');
  `);
} catch (error) {
  afterRejected = error;
}
check('закрытое намерение освобождает предложение', afterRejected == null,
  afterRejected?.message ?? 'ok');

// ── Кто подписывает ───────────────────────────────────────────────

check('миграция signing identity только добавляет',
  !/\b(?:DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN|RENAME)\b/i.test(signingIdentity));

await clean.exec(signingIdentity);

// Имя ресурса KMS в таблице отсутствует: по нему восстанавливаются
// аккаунт и регион, по отпечатку — нет.
const identityColumns = (await clean.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name='SigningIdentity'
`)).rows.map((row) => row.column_name);
check('в таблице нет идентификатора ресурса KMS',
  !identityColumns.some((name) => /keyId|resource|arn|keyArn/i.test(name)),
  identityColumns.join(', '));

const identityDefault = (await clean.query(`
  INSERT INTO "SigningIdentity"
    ("id","provider","fingerprint","solanaAddress","keyVersion","algorithm","network","updatedAt")
  VALUES ('solana-signer-v1','aws-kms','abc','Addr','1','ED25519_SHA_512','devnet',NOW())
  RETURNING "state"
`)).rows[0]?.state;
// Незарегистрированное состояние по умолчанию: ключ, о котором
// человек не знает, подписывать не должен.
check('новая identity не зарегистрирована по умолчанию',
  identityDefault === 'UNREGISTERED', String(identityDefault));

let intentReapply = null;
try {
  await clean.exec(transactionIntent);
} catch (error) {
  intentReapply = error;
}
check('повторное применение миграции не падает',
  intentReapply == null, intentReapply?.message ?? 'ok');

console.log(`\nИтог: ${failures === 0 ? 'все проверки пройдены' : failures + ' проверок не прошли'}`);
process.exit(failures === 0 ? 0 : 1);
