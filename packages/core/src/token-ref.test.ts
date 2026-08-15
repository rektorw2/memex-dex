import { describe, it, expect } from 'vitest';
import { parseTokenRefs, candidateChains } from './token-ref.js';

const SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EVM = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const ALL = ['SOLANA', 'BNB', 'ETHEREUM', 'BASE', 'ROBINHOOD'];

describe('parseTokenRefs', () => {
  it('находит голый адрес Solana', () => {
    const r = parseTokenRefs(SOL);
    expect(r).toHaveLength(1);
    expect(r[0]!.address).toBe(SOL);
    expect(r[0]!.family).toBe('solana');
  });

  it('находит голый адрес EVM', () => {
    const r = parseTokenRefs(EVM);
    expect(r).toHaveLength(1);
    expect(r[0]!.family).toBe('evm');
  });

  it('извлекает адрес из ссылки и берёт сеть из неё', () => {
    const r = parseTokenRefs(`https://dexscreener.com/bsc/${EVM}`);
    expect(r).toHaveLength(1);
    expect(r[0]!.chainHint).toBe('BNB');
  });

  it('распознаёт сети по разным написаниям', () => {
    expect(parseTokenRefs(`https://x.io/ethereum/${EVM}`)[0]!.chainHint).toBe('ETHEREUM');
    expect(parseTokenRefs(`https://x.io/base/${EVM}`)[0]!.chainHint).toBe('BASE');
    expect(parseTokenRefs(`https://x.io/bnb/${EVM}`)[0]!.chainHint).toBe('BNB');
  });

  it('разбирает вставленный абзац с несколькими токенами', () => {
    const text = `
      Посмотри вот эти:
      https://dexscreener.com/solana/${SOL}
      и ещё https://dexscreener.com/base/${EVM}
      всё
    `;
    const r = parseTokenRefs(text);
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.family).sort()).toEqual(['evm', 'solana']);
  });

  it('убирает дубликаты', () => {
    // Один и тот же токен, вставленный двумя способами, не должен
    // превратиться в две записи.
    const r = parseTokenRefs(`${SOL}\nhttps://dexscreener.com/solana/${SOL}`);
    expect(r).toHaveLength(1);
  });

  it('дубликаты EVM ловятся независимо от регистра', () => {
    const r = parseTokenRefs(`${EVM}\n${EVM.toLowerCase()}`);
    expect(r).toHaveLength(1);
  });

  it('сеть определяется по своей строке, а не по всему тексту', () => {
    // Иначе слово в первой строке приписало бы свою сеть всем адресам ниже.
    const r = parseTokenRefs(`solana подборка:\nhttps://dexscreener.com/base/${EVM}`);
    expect(r[0]!.chainHint).toBe('BASE');
  });

  it('пропускает ссылки на транзакции', () => {
    // Хеш транзакции Solana неотличим по виду от адреса — единственный
    // признак это /tx/ в ссылке.
    expect(parseTokenRefs(`https://solscan.io/tx/${SOL}`)).toHaveLength(0);
    expect(parseTokenRefs(`https://etherscan.io/transaction/${EVM}`)).toHaveLength(0);
  });

  it('отсеивает системные адреса Solana', () => {
    const wsol = 'So11111111111111111111111111111111111111112';
    const r = parseTokenRefs(`${wsol}\n${SOL}`);
    expect(r).toHaveLength(1);
    expect(r[0]!.address).toBe(SOL);
  });

  it('не принимает мусор за адрес', () => {
    expect(parseTokenRefs('')).toEqual([]);
    expect(parseTokenRefs('просто текст без адресов')).toEqual([]);
    expect(parseTokenRefs('0x123')).toEqual([]);
    expect(parseTokenRefs('короткий')).toEqual([]);
    expect(parseTokenRefs(null as never)).toEqual([]);
  });

  it('соблюдает ограничение количества', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      `0x${i.toString(16).padStart(40, '0')}`,
    ).join('\n');
    expect(parseTokenRefs(many, 10)).toHaveLength(10);
  });

  it('адрес Solana без подсказки всё равно получает свою сеть', () => {
    // Форма адреса здесь однозначна, домен не нужен.
    expect(parseTokenRefs(SOL)[0]!.chainHint).toBe('SOLANA');
  });
});

describe('candidateChains', () => {
  it('для Solana даёт ровно одну сеть', () => {
    const ref = parseTokenRefs(SOL)[0]!;
    expect(candidateChains(ref, ALL)).toEqual(['SOLANA']);
  });

  it('подсказка из ссылки сужает перебор до одной сети', () => {
    const ref = parseTokenRefs(`https://dexscreener.com/base/${EVM}`)[0]!;
    expect(candidateChains(ref, ALL)).toEqual(['BASE']);
  });

  it('без подсказки EVM перебирается по нескольким сетям', () => {
    // Один и тот же адрес существует в Ethereum, BNB и Base
    // одновременно — угадать по нему сеть невозможно.
    const ref = parseTokenRefs(EVM)[0]!;
    const c = candidateChains(ref, ALL);
    expect(c.length).toBeGreaterThan(1);
    expect(c).toContain('BNB');
    expect(c).toContain('ETHEREUM');
  });

  it('неподдерживаемые сети не предлагаются', () => {
    const ref = parseTokenRefs(EVM)[0]!;
    expect(candidateChains(ref, ['BNB'])).toEqual(['BNB']);

    const solRef = parseTokenRefs(SOL)[0]!;
    expect(candidateChains(solRef, ['BNB'])).toEqual([]);
  });

  it('подсказка на неподдерживаемую сеть не ломает перебор', () => {
    const ref = parseTokenRefs(`https://x.io/ethereum/${EVM}`)[0]!;
    // Ethereum отключён — возвращаемся к перебору остальных.
    expect(candidateChains(ref, ['BNB', 'BASE'])).toEqual(['BNB', 'BASE']);
  });
});
