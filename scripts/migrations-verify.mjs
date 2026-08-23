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

const tables = (
  await clean.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`)
).rows.map((r) => r.tablename);
check('таблиц создано 35', tables.length === 35, String(tables.length));
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

console.log(`\nИтог: ${failures === 0 ? 'все проверки пройдены' : failures + ' проверок не прошли'}`);
process.exit(failures === 0 ? 0 : 1);
