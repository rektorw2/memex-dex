/**
 * Подставная база для проверки воркера пересчёта.
 *
 * Не заглушка: она моделирует именно то, что делает поведение
 * воркера трудным — ограничения уникальности, аренду задачи,
 * поколения и возможность упасть в заданной точке. Без этого
 * гонку между завершающимся воркером и приходящим событием
 * можно поймать только удачей.
 *
 * Живёт в исходниках, а не в тестах, потому что ею пользуются
 * и тесты, и смоук-скрипты в сухом режиме.
 */

import type {
  WalletLedgerRepository,
  SyncJob,
  ActivityInput,
  FinishOutcome,
  PersistResult,
  PendingActivity,
  ActivityStateUpdate,
} from './wallet-ledger-repo.js';
import type { CanonicalTrade } from '@memex/core';

interface QueueRow {
  id: string;
  chain: string;
  walletAddress: string;
  dueAt: number;
  generation: number;
  attempts: number;
  lockedBy: string | null;
  leaseToken: string | null;
  lockedUntil: number | null;
  lastErrorCode: string | null;
}

interface ActivityRow {
  id: string;
  chain: string;
  walletAddress: string;
  tokenAddress: string;
  side: string;
  tradedAt: number;
  appliedToLedger: boolean;
  ledgerState: string;
  ledgerAttempts: number;
}

/** Точки, в которых тест может уронить операцию. */
export type FailPoint =
  | 'ingest'
  | 'claim'
  | 'persist'
  | 'load'
  | 'apply'
  | 'finish'
  | null;

export class FakeWalletLedgerRepository implements WalletLedgerRepository {
  queue = new Map<string, QueueRow>();
  trades = new Map<string, CanonicalTrade>();
  activities = new Map<string, ActivityRow>();

  /** Где уронить следующую операцию. Сбрасывается после срабатывания. */
  failAt: FailPoint = null;
  now = () => this.clock;
  clock = 1_000_000;

  private seq = 0;

  private maybeFail(point: FailPoint): void {
    if (this.failAt === point) {
      this.failAt = null;
      throw new Error(`сбой в точке ${point}`);
    }
  }

  async markDirty(chain: string, wallet: string, dueAt: Date): Promise<void> {
    const id = `${chain}:${wallet}`;
    const row = this.queue.get(id);

    if (row) {
      row.dueAt = dueAt.getTime();
      // Поколение растёт: по нему воркер поймёт, что за время
      // его работы появилась новая работа.
      row.generation++;
      return;
    }

    this.queue.set(id, {
      id, chain, walletAddress: wallet, dueAt: dueAt.getTime(),
      generation: 1, attempts: 0,
      lockedBy: null, leaseToken: null, lockedUntil: null, lastErrorCode: null,
    });
  }

  async ingestAtomically(a: ActivityInput, dueAt: Date): Promise<{ created: boolean }> {
    this.maybeFail('ingest');

    if (this.activities.has(a.id)) {
      // Событие уже было. Если оно всё ещё не перенесено в позиции,
      // задача обязана существовать: прошлый проход мог упасть.
      const existing = this.activities.get(a.id)!;
      if (!existing.appliedToLedger) await this.markDirty(a.chain, a.walletAddress, dueAt);
      return { created: false };
    }

    // Обе записи разом: падение между ними оставило бы событие
    // навсегда неучтённым.
    this.activities.set(a.id, {
      id: a.id, chain: a.chain, walletAddress: a.walletAddress,
      tokenAddress: a.tokenAddress, side: a.side, tradedAt: a.tradedAt.getTime(),
      appliedToLedger: false, ledgerState: 'pending', ledgerAttempts: 0,
    });
    await this.markDirty(a.chain, a.walletAddress, dueAt);

    return { created: true };
  }

  async claimNext(now: Date, leaseMs: number, owner: string): Promise<SyncJob | null> {
    this.maybeFail('claim');

    const t = now.getTime();

    for (const row of [...this.queue.values()].sort((a, b) => a.dueAt - b.dueAt)) {
      if (row.dueAt > t) continue;
      // Свободна либо аренда просрочена.
      if (row.lockedUntil != null && row.lockedUntil > t) continue;

      const leaseToken = `${owner}:${++this.seq}`;
      row.lockedBy = owner;
      row.leaseToken = leaseToken;
      row.lockedUntil = t + leaseMs;

      return {
        id: row.id, chain: row.chain, walletAddress: row.walletAddress,
        generation: row.generation, attempts: row.attempts, leaseToken,
      };
    }

    return null;
  }

  async extendLease(job: SyncJob, until: Date): Promise<boolean> {
    const row = this.queue.get(job.id);
    // Продлить можно только свою аренду.
    if (!row || row.leaseToken !== job.leaseToken) return false;
    row.lockedUntil = until.getTime();
    return true;
  }

  async finish(job: SyncJob, outcome: FinishOutcome): Promise<'cleared' | 'requeued'> {
    this.maybeFail('finish');

    const row = this.queue.get(job.id);
    if (!row || row.leaseToken !== job.leaseToken) return 'requeued';

    row.lockedBy = null;
    row.leaseToken = null;
    row.lockedUntil = null;

    if (!outcome.ok) {
      row.attempts++;
      row.lastErrorCode = outcome.errorCode ?? 'unknown';
      row.dueAt = (outcome.retryAt ?? new Date(this.now() + 60_000)).getTime();
      return 'requeued';
    }

    // Снимаем только при совпадении поколения: иначе за время
    // работы пришло новое событие, и снятие стёрло бы его.
    if (row.generation !== job.generation) {
      // Немедленно, а не «сейчас по внутренним часам»: подделка
      // не должна зависеть от того, совпадают ли её часы с теми,
      // по которым спрашивает вызывающий.
      row.dueAt = 0;
      return 'requeued';
    }

    row.attempts = 0;
    row.lastErrorCode = null;
    row.dueAt = this.now() + 864e5;
    return 'cleared';
  }

  async persistCanonicalTrades(list: CanonicalTrade[]): Promise<PersistResult> {
    this.maybeFail('persist');

    let created = 0;
    let duplicates = 0;

    for (const t of list) {
      // Ключ — первичный: повторная строка истории не создаёт
      // второй записи.
      if (this.trades.has(t.key)) {
        duplicates++;
        continue;
      }
      this.trades.set(t.key, t);
      created++;
    }

    return { created, duplicates };
  }

  async loadCanonicalTrades(chain: string, wallet: string): Promise<CanonicalTrade[]> {
    this.maybeFail('load');

    return [...this.trades.values()]
      .filter((t) => t.chain === chain && t.wallet === wallet)
      .sort((a, b) => (a.tradedAt - b.tradedAt) || (a.key < b.key ? -1 : 1));
  }

  async lastTradeTime(chain: string, wallet: string): Promise<number | null> {
    const list = await this.loadCanonicalTrades(chain, wallet);
    return list.length > 0 ? list[list.length - 1]!.tradedAt : null;
  }

  async pendingActivities(chain: string, wallet: string, limit: number): Promise<PendingActivity[]> {
    return [...this.activities.values()]
      .filter((a) => a.chain === chain && a.walletAddress === wallet && !a.appliedToLedger)
      .slice(0, limit)
      .map((a) => ({ id: a.id, tokenAddress: a.tokenAddress, side: a.side, tradedAt: a.tradedAt }));
  }

  async applyActivityStates(updates: ActivityStateUpdate[]): Promise<void> {
    this.maybeFail('apply');

    for (const u of updates) {
      const row = this.activities.get(u.id);
      if (!row) continue;
      row.appliedToLedger = u.applied;
      row.ledgerState = u.state;
      if (!u.applied) row.ledgerAttempts++;
    }
  }
}
