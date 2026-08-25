import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Настройки Prisma CLI.
 *
 * Раньше seed лежал в `package.json#prisma`; Prisma 6 считает этот способ
 * устаревшим и предупреждает о его удалении в Prisma 7.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
