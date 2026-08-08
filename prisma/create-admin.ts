/**
 * Создание или повышение администратора.
 *
 *   DATABASE_URL="..." npm run admin:create -- --email you@example.com
 *   DATABASE_URL="..." npm run admin:create -- --email you@example.com --password 'СвойПароль'
 *
 * Если пользователь с такой почтой уже есть — ему выдаётся роль ADMIN,
 * пароль при этом меняется только когда он передан явно. Так можно
 * повысить существующий аккаунт, не сбрасывая вход.
 *
 * Пароль не принимается из переменной окружения намеренно: значения
 * окружения попадают в логи процессов и историю оболочки чаще, чем
 * аргументы конкретного запуска.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function generatePassword(): string {
  // 24 символа base64url — примерно 144 бита энтропии.
  return randomBytes(18).toString('base64url');
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  const explicitPassword = arg('password');

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('\nУкажите почту:\n');
    console.error("  npm run admin:create -- --email you@example.com\n");
    process.exit(1);
  }

  if (explicitPassword && explicitPassword.length < 10) {
    console.error('\nПароль должен быть не короче 10 символов — так требует форма входа.\n');
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email } });

  // Пароль генерируем только если аккаунта нет или он задан явно.
  const password = explicitPassword ?? (existing ? null : generatePassword());
  const passwordHash = password
    ? await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 })
    : undefined;

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash: passwordHash!,
      role: 'ADMIN',
      // KYC проставляется сразу: без него админ не сможет проверить
      // копитрейдинг на собственном аккаунте.
      kycStatus: 'APPROVED',
    },
    update: {
      role: 'ADMIN',
      kycStatus: 'APPROVED',
      isFrozen: false,
      ...(passwordHash ? { passwordHash } : {}),
    },
  });

  // Смена роли — то, что обязано остаться в журнале: это повышение
  // привилегий, и при разборе инцидента нужно знать, когда оно случилось.
  await prisma.auditLog.create({
    data: {
      actorId: user.id,
      action: existing ? 'user.promote.admin' : 'user.create.admin',
      entity: 'User',
      entityId: user.id,
      after: { email, role: 'ADMIN', via: 'cli' } as never,
    },
  });

  console.log(`\n${existing ? 'Аккаунт повышен до администратора' : 'Администратор создан'}:\n`);
  console.log(`  Почта:  ${email}`);
  if (password) {
    console.log(`  Пароль: ${password}`);
    if (!explicitPassword) {
      console.log('\n  Пароль сгенерирован случайно и нигде не сохранён — скопируйте сейчас.');
    }
  } else {
    console.log('  Пароль: без изменений');
  }
  console.log('\n  Роль:   ADMIN, KYC: APPROVED\n');
  console.log('  Включите двухфакторную защиту после первого входа:');
  console.log('  вход → /auth/2fa/setup. Для аккаунта с доступом к выводам это не опция.\n');
}

main()
  .catch((e) => {
    console.error('\nНе удалось создать администратора:', e?.message ?? e, '\n');
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
