# Многоступенчатая сборка: в финальный образ не попадают devDependencies,
# исходники и кэш npm.
#
# База — Debian slim, а не Alpine. Причина: argon2 и движок Prisma
# распространяются готовыми бинарями под glibc. На musl (Alpine) их
# приходится собирать из исходников — это несколько минут сборки на
# каждый деплой и регулярные падения из-за отсутствующих заголовков.

FROM node:22-slim AS deps
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# npm ci восстанавливает дерево строго по package-lock.json, поэтому ему
# нужны package.json ВСЕХ воркспейсов, объявленных в корневом package.json.
# Пропущенный apps/web ломал установку: lock-файл содержит @memex/web,
# а на диске его нет — npm считает дерево рассинхронизированным.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# --ignore-scripts отключает postinstall-хуки: они непредсказуемы и на этом
# этапе всё равно не имеют доступа к исходникам (схемы Prisma ещё нет).
RUN npm ci --ignore-scripts

# argon2 — нативный модуль, и его бинарь ставится именно install-скриптом.
# Без явной пересборки приложение падает на первом же хешировании пароля
# с ошибкой «Could not locate the bindings file».
RUN npm rebuild argon2

FROM node:22-slim AS build
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Запас памяти для компилятора: сборщики на бесплатных тарифах дают
# около 512 МБ, а tsc на проекте с крупными пакетами типов упирается
# в предел кучи и падает с кодом 2 без внятного сообщения.
ENV NODE_OPTIONS=--max-old-space-size=1536

RUN npx prisma generate --schema=prisma/schema.prisma \
 && npm run build -w @memex/core \
 && npm run build -w @memex/api

FROM node:22-slim AS runner
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1001 memex \
 && useradd -u 1001 -g memex -m -s /bin/sh memex

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./

USER memex
EXPOSE 10000

# tini как PID 1 — иначе SIGTERM не доходит до Node, контейнер убивается
# по таймауту и обрывает транзакции на полпути.
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["node", "apps/api/dist/server.js"]
