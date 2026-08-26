import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { KNOWN_MIGRATIONS } from '../lib/production-schema-repair.js';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const sqlOf = (name: string) =>
  readFileSync(`${ROOT}prisma/migrations/${name}/migration.sql`, 'utf8');

let db: PGlite;

async function seed(): Promise<void> {
  await db.exec(`
    INSERT INTO "PaperAgentControl" ("id","updatedAt") VALUES ('primary',NOW());
    INSERT INTO "PaperAgentStrategy"
      ("id","key","version","label","kind","config","updatedAt")
    VALUES ('strategy','baseline',1,'Baseline','BASELINE','{}',NOW());
    INSERT INTO "OkxSignal"
      ("id","providerKey","chain","address","symbol","name","signaledAt","walletTypes","source")
    VALUES ('signal','provider','SOLANA','Mint','GEM','Gem',NOW(),ARRAY['smart_money'],'okx_websocket');
    INSERT INTO "PaperAgentRun"
      ("id","signalId","strategyId","providerKey","chain","address","symbol","source",
       "state","signaledAt","receivedAt","walletTypes","updatedAt")
    VALUES ('run','signal','strategy','provider','SOLANA','Mint','GEM','okx_websocket',
            'ELIGIBLE',NOW(),NOW(),ARRAY['smart_money'],NOW());
  `);
  for (const [id, kind] of [['active', 'ACTIVE'], ['shadow', 'SHADOW']] as const) {
    await db.exec(`
      INSERT INTO "PaperAgentAccountSession"
        ("id","kind","mode","policyKey","policyVersion","policySnapshot","scorePolicyKey",
         "scorePolicyVersion","reservePct","maxExposurePct","maxPositionPct","maxOpenPositions",
         "minimumPositionUsd","dailyEntryLimit","drawdownStopPct","allowPartialAllocation",
         "initialCapitalUsd","freeBalanceUsd","reservedBalanceUsd","inPositionsUsd",
         "realizedPnlUsd","unrealizedPnlUsd","tradingFeesUsd","slippageUsd","networkCostsUsd",
         "equityUsd","peakEquityUsd","drawdownPct","dailyEntriesDate","updatedAt")
      VALUES ('${id}','${kind}','FIXED','fixed',1,'{}','score',1,30,70,25,4,5,10,20,false,
              100,70,30,0,0,0,0,0,0,100,100,0,NOW(),NOW());
    `);
  }
}

beforeAll(async () => {
  db = await PGlite.create();
  for (const migration of KNOWN_MIGRATIONS) await db.exec(sqlOf(migration));
}, 15_000);

beforeEach(async () => {
  await db.exec(`
    TRUNCATE TABLE "PaperAgentCapitalLedger", "PaperAgentAllocation",
      "PaperAgentAccountSession", "PaperAgentAllocationPolicy", "PaperAgentNotification",
      "PaperAgentRun", "PaperAgentStrategy", "OkxSignal", "PaperAgentControl" CASCADE;
  `);
  await seed();
});

afterAll(async () => db.close());

describe('Phase 3 ledger on real Postgres', () => {
  it('two concurrent claims cannot reserve the same session version twice', async () => {
    const claim = () => db.query(`
      UPDATE "PaperAgentAccountSession"
      SET "freeBalanceUsd"="freeBalanceUsd"-25,
          "inPositionsUsd"="inPositionsUsd"+25,
          "openPositions"="openPositions"+1,
          "ledgerVersion"="ledgerVersion"+1,
          "updatedAt"=NOW()
      WHERE "id"='active' AND "ledgerVersion"=0 AND "freeBalanceUsd">=25
      RETURNING "id"
    `);
    const [first, second] = await Promise.all([claim(), claim()]);
    expect(first.rows.length + second.rows.length).toBe(1);
    const account = (await db.query<any>(`
      SELECT "freeBalanceUsd","inPositionsUsd","openPositions","ledgerVersion"
      FROM "PaperAgentAccountSession" WHERE "id"='active'
    `)).rows[0];
    expect(Number(account.freeBalanceUsd)).toBe(45);
    expect(Number(account.inPositionsUsd)).toBe(25);
    expect(account.openPositions).toBe(1);
    expect(account.ledgerVersion).toBe(1);
  });

  it('ACTIVE mutation cannot consume SHADOW capital or slot', async () => {
    await db.exec(`
      UPDATE "PaperAgentAccountSession"
      SET "freeBalanceUsd"=45,"inPositionsUsd"=25,"openPositions"=1,
          "ledgerVersion"=1,"updatedAt"=NOW()
      WHERE "id"='active';
    `);
    const shadow = (await db.query<any>(`
      SELECT "freeBalanceUsd","inPositionsUsd","openPositions","ledgerVersion"
      FROM "PaperAgentAccountSession" WHERE "id"='shadow'
    `)).rows[0];
    expect(Number(shadow.freeBalanceUsd)).toBe(70);
    expect(Number(shadow.inPositionsUsd)).toBe(0);
    expect(shadow.openPositions).toBe(0);
    expect(shadow.ledgerVersion).toBe(0);
  });

  it('duplicate signal creates at most one allocation per account', async () => {
    const insert = (id: string) => db.exec(`
      INSERT INTO "PaperAgentAllocation"
        ("id","sessionId","runId","isShadow","state","decisionCode","mode","policyKey",
         "policyVersion","policySnapshot","inputFacts","signalScore","signalBand",
         "allocationReason","freeAfterUsd","reserveAfterUsd","exposureAfterUsd","updatedAt")
      VALUES ('${id}','active','run',false,'SKIPPED','LIMIT','FIXED','fixed',1,'{}','{}',
              0,'WEAK','limit',70,30,0,NOW())
    `);
    await insert('allocation-1');
    await expect(insert('allocation-2')).rejects.toBeTruthy();
    const count = (await db.query<any>(`
      SELECT COUNT(*)::int AS count FROM "PaperAgentAllocation"
      WHERE "runId"='run' AND "sessionId"='active'
    `)).rows[0].count;
    expect(count).toBe(1);
  });

  it('outbox failure rolls back allocation, ledger and reserved capital together', async () => {
    await db.exec(`
      INSERT INTO "PaperAgentNotification"
        ("id","eventKey","runId","eventType","payload","updatedAt")
      VALUES ('existing','same-event','run','PAPER_BUY','{}',NOW());
    `);
    await db.exec('BEGIN');
    try {
      await db.exec(`
        UPDATE "PaperAgentAccountSession"
        SET "freeBalanceUsd"=45,"inPositionsUsd"=25,"openPositions"=1,
            "ledgerVersion"=1,"updatedAt"=NOW() WHERE "id"='active';
        INSERT INTO "PaperAgentAllocation"
          ("id","sessionId","runId","isShadow","state","decisionCode","mode","policyKey",
           "policyVersion","policySnapshot","inputFacts","signalScore","signalBand",
           "allocationReason","allocatedUsd","capitalPct","freeAfterUsd","reserveAfterUsd",
           "exposureAfterUsd","updatedAt")
        VALUES ('allocation','active','run',false,'OPEN','ALLOCATED','FIXED','fixed',1,'{}','{}',
                50,'MEDIUM','allocated',25,25,45,30,25,NOW());
        INSERT INTO "PaperAgentCapitalLedger"
          ("id","eventKey","sessionId","allocationId","eventType","amountUsd",
           "freeBeforeUsd","freeAfterUsd","reservedBeforeUsd","reservedAfterUsd",
           "inPositionsBeforeUsd","inPositionsAfterUsd","realizedPnlAfterUsd","equityAfterUsd",
           "tradingFeesAfterUsd","slippageAfterUsd","networkCostsAfterUsd")
        VALUES ('ledger','allocation:OPEN','active','allocation','OPEN',25,70,45,30,30,0,25,0,100,0,0,0);
        INSERT INTO "PaperAgentNotification"
          ("id","eventKey","runId","eventType","payload","updatedAt")
        VALUES ('duplicate','same-event','run','PAPER_BUY','{}',NOW());
      `);
      await db.exec('COMMIT');
      throw new Error('expected unique violation');
    } catch {
      await db.exec('ROLLBACK');
    }
    const account = (await db.query<any>(`
      SELECT "freeBalanceUsd","inPositionsUsd","openPositions","ledgerVersion"
      FROM "PaperAgentAccountSession" WHERE "id"='active'
    `)).rows[0];
    expect(Number(account.freeBalanceUsd)).toBe(70);
    expect(Number(account.inPositionsUsd)).toBe(0);
    expect(account.openPositions).toBe(0);
    expect(account.ledgerVersion).toBe(0);
    expect((await db.query(`SELECT 1 FROM "PaperAgentAllocation" WHERE id='allocation'`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM "PaperAgentCapitalLedger" WHERE id='ledger'`)).rows).toHaveLength(0);
  });

  it('simultaneous close and new signal cannot update one ledger version twice', async () => {
    await db.exec(`
      UPDATE "PaperAgentAccountSession"
      SET "freeBalanceUsd"=45,"inPositionsUsd"=25,"openPositions"=1,
          "ledgerVersion"=0,"updatedAt"=NOW()
      WHERE "id"='active';
    `);
    const close = () => db.query(`
      UPDATE "PaperAgentAccountSession"
      SET "freeBalanceUsd"="freeBalanceUsd"+25,
          "inPositionsUsd"="inPositionsUsd"-25,
          "openPositions"="openPositions"-1,
          "ledgerVersion"="ledgerVersion"+1,"updatedAt"=NOW()
      WHERE "id"='active' AND "ledgerVersion"=0 AND "inPositionsUsd">=25
      RETURNING "id"
    `);
    const open = () => db.query(`
      UPDATE "PaperAgentAccountSession"
      SET "freeBalanceUsd"="freeBalanceUsd"-25,
          "inPositionsUsd"="inPositionsUsd"+25,
          "openPositions"="openPositions"+1,
          "ledgerVersion"="ledgerVersion"+1,"updatedAt"=NOW()
      WHERE "id"='active' AND "ledgerVersion"=0 AND "freeBalanceUsd">=25
      RETURNING "id"
    `);
    const [closed, opened] = await Promise.all([close(), open()]);
    expect(closed.rows.length + opened.rows.length).toBe(1);
    const account = (await db.query<any>(`
      SELECT "freeBalanceUsd","reservedBalanceUsd","inPositionsUsd","ledgerVersion"
      FROM "PaperAgentAccountSession" WHERE "id"='active'
    `)).rows[0];
    expect(Number(account.freeBalanceUsd) + Number(account.reservedBalanceUsd) + Number(account.inPositionsUsd)).toBe(100);
    expect(account.ledgerVersion).toBe(1);
  });

  it('new policy version cannot rewrite an old allocation snapshot', async () => {
    await db.exec(`
      INSERT INTO "PaperAgentAllocationPolicy"
        ("id","policyKey","version","mode","label","limits","scorePolicyKey","scorePolicyVersion")
      VALUES ('policy-v1','fixed',1,'FIXED','Fixed v1','{"maxPositionPct":25}','score',1);
      INSERT INTO "PaperAgentAllocation"
        ("id","sessionId","runId","isShadow","state","decisionCode","mode","policyKey",
         "policyVersion","policySnapshot","inputFacts","signalScore","signalBand",
         "allocationReason","freeAfterUsd","reserveAfterUsd","exposureAfterUsd","updatedAt")
      VALUES ('snapshot-allocation','active','run',false,'SKIPPED','LIMIT','FIXED','fixed',1,
              '{"maxPositionPct":25}','{}',0,'WEAK','test',70,30,0,NOW());
      INSERT INTO "PaperAgentAllocationPolicy"
        ("id","policyKey","version","mode","label","limits","scorePolicyKey","scorePolicyVersion")
      VALUES ('policy-v2','fixed',2,'FIXED','Fixed v2','{"maxPositionPct":10}','score',1);
    `);
    const allocation = (await db.query<any>(`
      SELECT "policyVersion","policySnapshot" FROM "PaperAgentAllocation"
      WHERE id='snapshot-allocation'
    `)).rows[0];
    expect(allocation.policyVersion).toBe(1);
    expect(Number(allocation.policySnapshot.maxPositionPct)).toBe(25);
  });

  it('reset creates a replacement session and preserves the old ledger history', async () => {
    await db.exec(`
      INSERT INTO "PaperAgentAllocation"
        ("id","sessionId","runId","isShadow","state","decisionCode","mode","policyKey",
         "policyVersion","policySnapshot","inputFacts","signalScore","signalBand",
         "allocationReason","freeAfterUsd","reserveAfterUsd","exposureAfterUsd","updatedAt")
      VALUES ('old-allocation','active','run',false,'SKIPPED','LIMIT','FIXED','fixed',1,
              '{}','{}',0,'WEAK','old',70,30,0,NOW());
      INSERT INTO "PaperAgentCapitalLedger"
        ("id","eventKey","sessionId","allocationId","eventType","amountUsd",
         "freeBeforeUsd","freeAfterUsd","reservedBeforeUsd","reservedAfterUsd",
         "inPositionsBeforeUsd","inPositionsAfterUsd","realizedPnlAfterUsd","equityAfterUsd",
         "tradingFeesAfterUsd","slippageAfterUsd","networkCostsAfterUsd")
      VALUES ('old-ledger','old-allocation:SKIP','active','old-allocation','SKIP',0,
              70,70,30,30,0,0,0,100,0,0,0);
      UPDATE "PaperAgentAccountSession" SET "status"='CLOSED',"closedAt"=NOW(),"updatedAt"=NOW()
      WHERE id='active';
      INSERT INTO "PaperAgentAccountSession"
        ("id","kind","mode","policyKey","policyVersion","policySnapshot","scorePolicyKey",
         "scorePolicyVersion","reservePct","maxExposurePct","maxPositionPct","maxOpenPositions",
         "minimumPositionUsd","dailyEntryLimit","drawdownStopPct","allowPartialAllocation",
         "initialCapitalUsd","freeBalanceUsd","reservedBalanceUsd","inPositionsUsd",
         "realizedPnlUsd","unrealizedPnlUsd","tradingFeesUsd","slippageUsd","networkCostsUsd",
         "equityUsd","peakEquityUsd","drawdownPct","dailyEntriesDate","resetFromId","updatedAt")
      VALUES ('active-reset','ACTIVE','FIXED','fixed',1,'{}','score',1,30,70,25,4,5,10,20,false,
              200,140,60,0,0,0,0,0,0,200,200,0,NOW(),'active',NOW());
    `);
    const sessions = await db.query<any>(`
      SELECT id,status,"resetFromId" FROM "PaperAgentAccountSession"
      WHERE id IN ('active','active-reset') ORDER BY id
    `);
    expect(sessions.rows).toHaveLength(2);
    expect(sessions.rows.find((row: any) => row.id === 'active-reset').resetFromId).toBe('active');
    expect((await db.query(`SELECT 1 FROM "PaperAgentAllocation" WHERE id='old-allocation'`)).rows).toHaveLength(1);
    expect((await db.query(`SELECT 1 FROM "PaperAgentCapitalLedger" WHERE id='old-ledger'`)).rows).toHaveLength(1);
  });
});
