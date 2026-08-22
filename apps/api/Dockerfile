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
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# --ignore-scripts отключает postinstall-хуки: они непредсказуемы и на этом
# этапе всё равно не имеют доступа к исходникам (схемы Prisma ещё нет).
RUN npm ci --ignore-scripts

# argon2 — нативный модуль, и его бинарь ставится именно install-скриптом.
# Без явной пересборки приложение падает на первом же хешировании пароля.
RUN npm rebuild argon2

# Каталоги вложенных зависимостей должны существовать, даже когда npm всё
# поднял в корень: COPY с несуществующим путём обрывает сборку.
RUN mkdir -p apps/api/node_modules packages/core/node_modules

FROM node:22-slim AS build
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Копируется всё дерево зависимостей целиком, включая вложенные
# node_modules воркспейсов.
#
# Иначе теряются пакеты, которые npm не смог поднять в корень из-за
# конфликта версий: @fastify/jwt 10 требует fastify-plugin 6, тогда как
# в корне стоит 5, и он оседает в apps/api/node_modules. Сборка падала
# с «Cannot find module '@fastify/jwt'», а следом сыпались все места
# с req.user — расширение типов объявлено внутри этого модуля.
COPY --from=deps /app ./

# .dockerignore исключает node_modules, поэтому исходники накладываются
# поверх, не затирая установленные зависимости.
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
# Вложенные зависимости воркспейса нужны и в рантайме — там лежит
# в том числе @fastify/jwt.
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/entrypoint.sh ./apps/api/entrypoint.sh
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./

USER memex
EXPOSE 10000

# tini как PID 1 — иначе SIGTERM не доходит до Node, контейнер убивается
# по таймауту и обрывает транзакции на полпути.
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["sh", "apps/api/entrypoint.sh"]
