/**
 * Наполнение базы для локальной разработки.
 * Создаёт админа, лидера копитрейдинга, подписчика, котировочные токены
 * и один пример мем-токена.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

const prisma = new PrismaClient();

/**
 * Пароль для тестовых аккаунтов.
 *
 * Раньше он был константой прямо в коде. Пока проект жил локально,
 * это было удобно; в публичном репозитории это учётная запись
 * администратора, пароль от которой знает любой читатель.
 *
 * Теперь: локально — привычный DevPassword123!, в любом другом
 * окружении — случайный пароль, который печатается один раз при
 * заполнении базы. Переопределяется через SEED_PASSWORD.
 */
function resolveSeedPassword(): { password: string; generated: boolean } {
  if (process.env.SEED_PASSWORD) {
    return { password: process.env.SEED_PASSWORD, generated: false };
  }
  if (process.env.NODE_ENV !== 'production' && !process.env.DATABASE_URL?.includes('neon.tech')) {
    return { password: 'DevPassword123!', generated: false };
  }
  return { password: randomBytes(18).toString('base64url'), generated: true };
}

const { password, generated } = resolveSeedPassword();

async function main() {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  await prisma.user.upsert({
    where: { email: 'admin@memex.local' },
    create: { email: 'admin@memex.local', passwordHash, role: 'ADMIN', kycStatus: 'APPROVED' },
    update: { role: 'ADMIN' },
  });

  const leader = await prisma.user.upsert({
    where: { email: 'leader@memex.local' },
    create: { email: 'leader@memex.local', passwordHash, role: 'TRADER', kycStatus: 'APPROVED' },
    update: { role: 'TRADER' },
  });

  const follower = await prisma.user.upsert({
    where: { email: 'user@memex.local' },
    create: { email: 'user@memex.local', passwordHash, role: 'USER', kycStatus: 'APPROVED' },
    update: {},
  });

  // Котировочные токены
  const usdcSol = await prisma.token.upsert({
    where: { chain_address: { chain: 'SOLANA', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } },
    create: {
      chain: 'SOLANA', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      symbol: 'USDC', name: 'USD Coin', decimals: 6, isQuote: true, isVerified: true,
      priceUsd: new Prisma.Decimal(1),
    },
    update: { priceUsd: new Prisma.Decimal(1) },
  });

  const sol = await prisma.token.upsert({
    where: { chain_address: { chain: 'SOLANA', address: 'So11111111111111111111111111111111111111112' } },
    create: {
      chain: 'SOLANA', address: 'So11111111111111111111111111111111111111112',
      symbol: 'SOL', name: 'Solana', decimals: 9, isQuote: true, isVerified: true,
      priceUsd: new Prisma.Decimal(180), liquidityUsd: new Prisma.Decimal(500_000_000),
    },
    update: {},
  });

  // Пример мем-коина
  await prisma.token.upsert({
    where: { chain_address: { chain: 'SOLANA', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' } },
    create: {
      chain: 'SOLANA', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      symbol: 'BONK', name: 'Bonk', decimals: 5, isVerified: true,
      priceUsd: new Prisma.Decimal('0.0000234'),
      liquidityUsd: new Prisma.Decimal(12_000_000),
      volume24hUsd: new Prisma.Decimal(45_000_000),
      holders: 780_000, lpBurnedPct: new Prisma.Decimal(100),
      topHolderPct: new Prisma.Decimal(18), riskScore: 12,
      metricsUpdated: new Date(),
    },
    update: {},
  });

  // Стартовые балансы для paper-режима
  for (const user of [leader, follower]) {
    await prisma.balance.upsert({
      where: { userId_tokenId: { userId: user.id, tokenId: usdcSol.id } },
      create: { userId: user.id, tokenId: usdcSol.id, available: new Prisma.Decimal(10_000) },
      update: { available: new Prisma.Decimal(10_000) },
    });
    await prisma.ledgerEntry.create({
      data: {
        userId: user.id, tokenId: usdcSol.id, type: 'DEPOSIT',
        amount: new Prisma.Decimal(10_000), memo: 'стартовый баланс (seed)',
      },
    });
  }

  // Подписка на копитрейдинг
  await prisma.copySubscription.upsert({
    where: { followerId_leaderId: { followerId: follower.id, leaderId: leader.id } },
    create: {
      followerId: follower.id, leaderId: leader.id,
      sizing: 'PCT_EQUITY', pctEquity: new Prisma.Decimal(5),
      maxOpenPositions: 10, allowedChains: ['SOLANA', 'BNB'],
      performanceFeeBps: 1000, acceptedTermsAt: new Date(),
    },
    update: {},
  });

  console.log('\nГотово. Учётные записи:\n');
  console.log(`  admin@memex.local   (ADMIN — управление платформой)`);
  console.log(`  leader@memex.local  (TRADER — лидер копитрейдинга)`);
  console.log(`  user@memex.local    (USER — подписан на лидера)`);
  console.log(`\n  Пароль: ${password}\n`);

  if (generated) {
    console.log('  Пароль сгенерирован случайно и больше нигде не сохранён —');
    console.log('  скопируйте его сейчас. Задать свой: SEED_PASSWORD=... npm run db:seed\n');
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
