import { randomUUID } from 'node:crypto';
import {
  PAPER_TEST_ADDRESS_PREFIX,
  PAPER_TEST_ORIGIN,
  paperTestSourceVerdict,
  paperTestWriteAllowed,
  type PaperTestSourceRefusal,
} from '@memex/core';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';

/**
 * Управляемый источник сигналов и цен для PAPER-режима.
 *
 * Тонкий адаптер: все правила допуска живут в ядре и проверены там
 * отдельно. Здесь только запись в базу — и один запрет, который
 * нельзя выразить чистой функцией: служба физически не умеет
 * трогать строки, которые не создавала сама.
 *
 * Почему это важнее, чем кажется. `Token.priceUsd` — общее поле:
 * его читает терминал, радар и все подборки. Запись туда из
 * тестового контура была бы подменой production market data для
 * всех сразу, а не «только в моём прогоне».
 */

export type PaperTestOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: PaperTestSourceRefusal | 'ADDRESS_NOT_TEST_NAMESPACE' };

/** Допуск по конфигурации и роли. Единственная точка входа. */
export function paperTestAccess(actorRole: string): PaperTestOutcome<true> {
  const verdict = paperTestSourceVerdict({
    testSourceEnabled: env.PAPER_TEST_SOURCE_ENABLED,
    executionMode: env.EXECUTION_MODE,
    liveExecutionEnabled: env.LIVE_EXECUTION_ENABLED,
    withdrawalsEnabled: env.WITHDRAWALS_ENABLED,
    solanaNetwork: env.SOLANA_NETWORK,
    actorRole,
  });

  return verdict.allowed ? { ok: true, value: true } : { ok: false, reason: verdict.reason };
}

/** Адрес в тестовом пространстве. Совпадение с настоящим mint невозможно. */
export function newPaperTestAddress(): string {
  return `${PAPER_TEST_ADDRESS_PREFIX}${randomUUID().replace(/-/g, '')}`;
}

export interface PaperTestTokenInput {
  symbol: string;
  name: string;
  /** Цена в момент создания. `null` — цены нет вовсе. */
  priceUsd: number | null;
  /** Возраст рынка. Управляет правилом «токен слишком старый». */
  poolCreatedAt: Date | null;
}

/**
 * Создать тестовый токен.
 *
 * Адрес выдаётся службой, а не приходит снаружи: параметр `address`
 * означал бы, что вызывающий может назвать чужой mint и заставить
 * службу писать в него.
 */
export async function createPaperTestToken(
  actorRole: string,
  input: PaperTestTokenInput,
): Promise<PaperTestOutcome<{ id: string; address: string }>> {
  const access = paperTestAccess(actorRole);
  if (!access.ok) return access;

  const address = newPaperTestAddress();
  const token = await prisma.token.create({
    data: {
      chain: 'SOLANA',
      address,
      symbol: input.symbol,
      name: input.name,
      decimals: 9,
      source: 'paper-test',
      // Вне витрины: тестовый токен не должен попадать в подборки.
      isHidden: true,
      priceUsd: input.priceUsd == null ? null : input.priceUsd,
      priceUpdatedAt: input.priceUsd == null ? null : new Date(),
      poolCreatedAt: input.poolCreatedAt,
    },
    select: { id: true, address: true },
  });

  return { ok: true, value: token };
}

/**
 * Изменить цену тестового токена.
 *
 * Здесь и стоит главный запрет. Токен ищется по идентификатору, а
 * писать разрешено только если его адрес принадлежит тестовому
 * пространству: иначе достаточно было бы передать `id` настоящего
 * токена, чтобы переписать его цену для всего приложения.
 */
export async function setPaperTestPrice(
  actorRole: string,
  tokenId: string,
  priceUsd: number | null,
): Promise<PaperTestOutcome<{ id: string }>> {
  const access = paperTestAccess(actorRole);
  if (!access.ok) return access;

  const token = await prisma.token.findUnique({
    where: { id: tokenId },
    select: { id: true, address: true },
  });
  if (!token || !paperTestWriteAllowed(token.address)) {
    return { ok: false, reason: 'ADDRESS_NOT_TEST_NAMESPACE' };
  }

  await prisma.token.update({
    where: { id: token.id },
    data: {
      priceUsd: priceUsd == null ? null : priceUsd,
      priceUpdatedAt: priceUsd == null ? null : new Date(),
    },
  });

  return { ok: true, value: { id: token.id } };
}

export interface PaperTestSignalInput {
  tokenId: string;
  walletTypes: string[];
  amountUsd: number;
  /** Отметка провайдера. Управляет расчётом задержек. */
  signaledAt: Date;
  /** Когда сигнал «получен». Управляет правилом дедлайна решения. */
  receivedAt: Date;
  /** Цена в самом сигнале; `null` — сигнал без цены. */
  priceUsd: number | null;
}

/**
 * Создать тестовый сигнал.
 *
 * `ingestOrigin` — `TEST_HARNESS`, и это не косметика: ни одна
 * метрика живой ленты такое происхождение не считает своим.
 * Тестовый прогон не должен улучшать отчётность.
 */
export async function createPaperTestSignal(
  actorRole: string,
  input: PaperTestSignalInput,
): Promise<PaperTestOutcome<{ id: string }>> {
  const access = paperTestAccess(actorRole);
  if (!access.ok) return access;

  const token = await prisma.token.findUnique({
    where: { id: input.tokenId },
    select: { id: true, address: true, symbol: true, name: true },
  });
  if (!token || !paperTestWriteAllowed(token.address)) {
    return { ok: false, reason: 'ADDRESS_NOT_TEST_NAMESPACE' };
  }

  const signal = await prisma.okxSignal.create({
    data: {
      providerKey: `paper-test:${randomUUID()}`,
      chain: 'SOLANA',
      address: token.address,
      tokenId: token.id,
      symbol: token.symbol,
      name: token.name,
      signaledAt: input.signaledAt,
      receivedAt: input.receivedAt,
      priceUsd: input.priceUsd == null ? null : input.priceUsd,
      walletTypes: input.walletTypes,
      amountUsd: input.amountUsd,
      source: 'paper-test',
      ingestOrigin: PAPER_TEST_ORIGIN,
    },
    select: { id: true },
  });

  return { ok: true, value: signal };
}
