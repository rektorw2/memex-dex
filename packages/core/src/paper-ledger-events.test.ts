import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_PAPER_LEDGER_WORD,
  PAPER_LEDGER_EVENTS,
  isPaperLedgerEvent,
  isRealDepositEvent,
} from './paper-ledger-events.js';

describe('в бумажном журнале нет внесения средств', () => {
  it('среди типов событий нет DEPOSIT', () => {
    /*
     * Главный запрет. Счёт создаётся с виртуальным капиталом,
     * который назначил администратор: человек ничего не вносил,
     * ничем не рисковал и ничего не может вывести.
     */
    expect(PAPER_LEDGER_EVENTS).not.toContain(FORBIDDEN_PAPER_LEDGER_WORD);
  });

  it('создание счёта называется INITIALIZE', () => {
    expect(PAPER_LEDGER_EVENTS).toContain('INITIALIZE');
  });

  it('ни одно событие не считается настоящим поступлением', () => {
    for (const event of PAPER_LEDGER_EVENTS) {
      expect(isRealDepositEvent(event), event).toBe(false);
    }
  });

  it('посторонние типы не признаются', () => {
    for (const value of ['DEPOSIT', 'WITHDRAW', 'deposit', '', null, undefined]) {
      expect(isPaperLedgerEvent(value), String(value)).toBe(false);
    }
  });

  it('список закрыт и не пуст', () => {
    // Пустой список прошёл бы все проверки выше, ничего не проверив.
    expect(PAPER_LEDGER_EVENTS.length).toBeGreaterThan(0);
    for (const event of PAPER_LEDGER_EVENTS) expect(isPaperLedgerEvent(event)).toBe(true);
  });
});
