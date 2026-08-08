#!/usr/bin/env node
/**
 * Первичная настройка проекта: генерация секретов и .env.
 * Идемпотентен — существующий .env не перезаписывается.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const ENV = '.env';

if (existsSync(ENV)) {
  console.log('.env уже существует — пропускаю генерацию.');
  console.log('Чтобы пересоздать: удалите .env и запустите npm run setup снова.');
  process.exit(0);
}

if (!existsSync('.env.example')) {
  console.error('Не найден .env.example — запускайте из корня проекта.');
  process.exit(1);
}

let env = readFileSync('.env.example', 'utf8');

// Секреты генерируются локально и никуда не отправляются.
env = env.replace(
  /^JWT_SECRET=.*$/m,
  `JWT_SECRET=${randomBytes(48).toString('base64')}`,
);
env = env.replace(
  /^KMS_LOCAL_MASTER_KEY=.*$/m,
  `KMS_LOCAL_MASTER_KEY=${randomBytes(32).toString('base64')}`,
);

writeFileSync(ENV, env);

console.log('Создан .env со сгенерированными секретами.');
console.log('');
console.log('Дальше:');
console.log('  docker compose up -d      # postgres (redis не обязателен)');
console.log('  npm run db:generate       # Prisma Client — без него API не стартует');
console.log('  npm run db:push           # схема в базу');
console.log('  npm run db:seed           # тестовые данные');
console.log('  npm run dev               # api + web + воркеры');
