import {
  checkSigningIdentity,
  verdictPausesSigning,
  type SigningIdentityFacts,
  type SigningIdentityState,
} from '@memex/core';
import { prisma, serializable } from '../lib/prisma.js';
import { recordAudit } from './intent-audit.js';
import { SignerError, type SolanaMessageSigner } from './solana-signer-contract.js';
import { createSolanaSigner, expectedFingerprint, identityFactsFrom } from './signer-factory.js';

/**
 * Реестр ключа, которым подписывают.
 *
 * Ключ не привязывается сам. Не «по умолчанию, если совпал», не
 * «автоматически при первом успешном вызове» — только человек,
 * посмотревший на отпечаток и адрес Solana и сказавший «да, этот».
 *
 * Причина простая: всё остальное в этом контуре сервер проверяет
 * сам, и проверять ему нечем ровно в одном месте — принадлежит ли
 * ключ нам. Ошибка в регионе, чужой ARN в конфигурации, подменённая
 * переменная окружения — во всех этих случаях KMS ответит успехом,
 * метаданные будут безупречны, а подпись выйдет чужим ключом.
 * Единственная защита здесь — человек, который сверил строку.
 *
 * Идентификатор ресурса ключа в таблице не хранится. Хранятся
 * отпечаток, адрес и версия: их достаточно, чтобы узнать ключ, и
 * недостаточно, чтобы что-то о нём рассказать.
 */

/** Единственная строка реестра: контур подписи в проекте один. */
const IDENTITY_ID = 'solana-signing-identity';

export class IdentityRegistryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'IdentityRegistryError';
  }
}

export interface RegisteredIdentity {
  state: SigningIdentityState;
  provider: string;
  fingerprint: string;
  solanaAddress: string;
  keyVersion: string;
  algorithm: string;
  network: string;
  registeredAt: string | null;
  pausedReason: string | null;
}

/** Что записано в реестре сейчас. `null` — ключ не регистрировали. */
export async function readRegisteredIdentity(): Promise<RegisteredIdentity | null> {
  const row = await prisma.signingIdentity.findUnique({ where: { id: IDENTITY_ID } });
  if (!row) return null;
  return {
    state: row.state as SigningIdentityState,
    provider: row.provider,
    fingerprint: row.fingerprint,
    solanaAddress: row.solanaAddress,
    keyVersion: row.keyVersion,
    algorithm: row.algorithm,
    network: row.network,
    registeredAt: row.registeredAt?.toISOString() ?? null,
    pausedReason: row.pausedReason,
  };
}

/**
 * Шаг первый: посмотреть, что отдаёт провайдер.
 *
 * Ничего не записывает. Возвращает то, что человек будет сверять
 * глазами: отпечаток, адрес Solana, алгоритм и версию.
 *
 * Совпадение с ожидаемым значением показывается, но решения не
 * принимает: `AWS_KMS_EXPECTED_PUBLIC_KEY` живёт в той же
 * конфигурации, что и адрес ключа, и подменяются они вместе.
 */
export async function discoverSigningIdentity(input: {
  actorId: string;
  provider: string;
  network: string;
  signer?: SolanaMessageSigner;
}): Promise<{ facts: SigningIdentityFacts; matchesExpected: boolean | null }> {
  const signer = input.signer ?? createSolanaSigner();

  let facts: SigningIdentityFacts;
  try {
    const identity = await signer.identity();
    facts = identityFactsFrom({
      publicKey: identity.publicKey,
      keyVersion: identity.version,
      algorithm: identity.algorithm,
    });
  } catch (error: unknown) {
    const code = error instanceof SignerError ? error.code : 'SIGNER_UNAVAILABLE';
    await recordAudit(prisma, entry('SIGNING_KEY_MISMATCH', input.actorId, input.network, code));
    throw new IdentityRegistryError(code);
  }

  const expected = expectedFingerprint();
  await recordAudit(prisma, {
    ...entry('SIGNING_KEY_DISCOVERED', input.actorId, input.network, null),
    keyFingerprint: facts.fingerprint,
    keyVersion: facts.keyVersion,
  });

  return { facts, matchesExpected: expected == null ? null : expected === facts.fingerprint };
}

/**
 * Шаг второй: подтверждение человеком.
 *
 * Администратор присылает отпечаток, который видел на экране. Совпал
 * с тем, что отдаёт провайдер прямо сейчас, — привязка сохраняется;
 * не совпал — отказ.
 *
 * Эхо отпечатка обязательно. Кнопка «подтвердить», не несущая того,
 * что было на экране, подтверждает не увиденное, а текущее состояние
 * сервера — включая то, которое изменилось, пока человек читал.
 */
export async function registerSigningIdentity(input: {
  actorId: string;
  provider: string;
  network: string;
  /** Отпечаток, показанный администратору. */
  confirmedFingerprint: string;
  signer?: SolanaMessageSigner;
  now?: Date;
}): Promise<RegisteredIdentity> {
  const now = input.now ?? new Date();
  const { facts } = await discoverSigningIdentity({
    actorId: input.actorId,
    provider: input.provider,
    network: input.network,
    signer: input.signer,
  });

  if (facts.fingerprint !== input.confirmedFingerprint) {
    await recordAudit(prisma, {
      ...entry('SIGNING_KEY_MISMATCH', input.actorId, input.network, 'CONFIRMATION_STALE'),
      keyFingerprint: facts.fingerprint,
      keyVersion: facts.keyVersion,
    });
    throw new IdentityRegistryError('CONFIRMATION_STALE');
  }

  /*
   * Повторная регистрация другого ключа — не обновление строки.
   *
   * Молча заменить привязку значит стереть единственный след того,
   * что ключ поменялся. Смена проходит через явный отзыв.
   */
  const existing = await prisma.signingIdentity.findUnique({ where: { id: IDENTITY_ID } });
  if (existing && existing.state !== 'UNREGISTERED' && existing.fingerprint !== facts.fingerprint) {
    throw new IdentityRegistryError('IDENTITY_ALREADY_REGISTERED');
  }

  const row = await serializable(async (tx) => {
    const saved = await tx.signingIdentity.upsert({
      where: { id: IDENTITY_ID },
      create: {
        id: IDENTITY_ID,
        provider: input.provider,
        state: 'REGISTERED',
        fingerprint: facts.fingerprint,
        solanaAddress: facts.solanaAddress,
        keyVersion: facts.keyVersion,
        algorithm: facts.algorithm,
        network: input.network,
        registeredBy: input.actorId,
        registeredAt: now,
      },
      update: {
        provider: input.provider,
        state: 'REGISTERED',
        fingerprint: facts.fingerprint,
        solanaAddress: facts.solanaAddress,
        keyVersion: facts.keyVersion,
        algorithm: facts.algorithm,
        network: input.network,
        registeredBy: input.actorId,
        registeredAt: now,
        pausedReason: null,
        pausedAt: null,
      },
    });

    await recordAudit(tx, {
      ...entry('SIGNING_KEY_REGISTERED', input.actorId, input.network, null),
      keyFingerprint: facts.fingerprint,
      keyVersion: facts.keyVersion,
      fromState: existing?.state ?? null,
      toState: 'REGISTERED',
    });
    return saved;
  });

  return {
    state: row.state as SigningIdentityState,
    provider: row.provider,
    fingerprint: row.fingerprint,
    solanaAddress: row.solanaAddress,
    keyVersion: row.keyVersion,
    algorithm: row.algorithm,
    network: row.network,
    registeredAt: row.registeredAt?.toISOString() ?? null,
    pausedReason: row.pausedReason,
  };
}

/**
 * Сверка живого ключа с записанным.
 *
 * Вызывается перед подписью и в диагностике. Расхождение переводит
 * контур в паузу и записывает событие: сменившийся ключ — это либо
 * ротация, о которой не предупредили, либо чужой ключ в
 * конфигурации, и различить их автоматически нельзя.
 *
 * Пауза снимается только повторной регистрацией человеком.
 */
export async function verifyAgainstRegistry(input: {
  facts: SigningIdentityFacts;
  actorId: string | null;
  network: string;
  now?: Date;
}): Promise<{ verdict: ReturnType<typeof checkSigningIdentity>; paused: boolean }> {
  const registered = await prisma.signingIdentity.findUnique({ where: { id: IDENTITY_ID } });

  const verdict = checkSigningIdentity({
    state: (registered?.state ?? 'UNREGISTERED') as SigningIdentityState,
    registered: registered
      ? {
          fingerprint: registered.fingerprint,
          solanaAddress: registered.solanaAddress,
          keyVersion: registered.keyVersion,
          algorithm: registered.algorithm,
        }
      : null,
    observed: input.facts,
    expectedFingerprint: expectedFingerprint(),
  });

  if (!verdictPausesSigning(verdict)) return { verdict, paused: false };

  /*
   * Состояние входит в условие обновления.
   *
   * Иначе два параллельных цикла запишут паузу дважды, и в журнале
   * появится второе событие о том же расхождении — с другой
   * причиной, если между ними ключ сменился ещё раз.
   */
  const changed = await prisma.signingIdentity.updateMany({
    where: { id: IDENTITY_ID, state: { not: 'PAUSED' } },
    data: { state: 'PAUSED', pausedReason: verdict, pausedAt: input.now ?? new Date() },
  });

  if (changed.count === 1) {
    await recordAudit(prisma, {
      ...entry('SIGNING_READINESS_PAUSED', input.actorId, input.network, verdict),
      keyFingerprint: input.facts.fingerprint,
      keyVersion: input.facts.keyVersion,
      fromState: registered?.state ?? null,
      toState: 'PAUSED',
    });
  }
  return { verdict, paused: true };
}

/** Отзыв привязки. Только человеком, с записью в журнал. */
export async function revokeSigningIdentity(input: {
  actorId: string;
  network: string;
  reasonCode: string;
}): Promise<boolean> {
  const changed = await prisma.signingIdentity.updateMany({
    where: { id: IDENTITY_ID, state: { not: 'UNREGISTERED' } },
    data: { state: 'UNREGISTERED', registeredBy: null, registeredAt: null },
  });
  if (changed.count !== 1) return false;

  await recordAudit(prisma, {
    ...entry('SIGNING_KEY_REVOKED', input.actorId, input.network, input.reasonCode),
    toState: 'UNREGISTERED',
  });
  return true;
}

/**
 * Основа записи журнала.
 *
 * Ни идентификатора ресурса, ни сырого ключа: контракт журнала
 * запрещает их поимённо, и собирать запись копированием входа
 * нельзя — копирование протащит любое новое поле.
 */
function entry(
  action: Parameters<typeof recordAudit>[1]['action'],
  actorId: string | null,
  network: string,
  reasonCode: string | null,
) {
  return {
    action,
    actorId,
    userId: null,
    proposalId: null,
    intentId: null,
    network,
    purpose: null,
    fromState: null,
    toState: null,
    policyVersion: null,
    keyFingerprint: null,
    keyVersion: null,
    reasonCode,
  };
}
