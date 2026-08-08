# Многоступенчатая сборка: в финальный образ не попадают devDependencies,
# исходники и кэш npm. Итоговый размер — порядка 200 МБ вместо 1.5 ГБ.

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat python3 make g++ openssl
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --ignore-scripts

FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
# npm поднимает зависимости воркспейсов в корневой node_modules,
# отдельного packages/core/node_modules обычно нет — копировать его нельзя,
# сборка упадёт на несуществующем пути.
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate --schema=prisma/schema.prisma \
 && npm run build -w @memex/core \
 && npm run build -w @memex/api

FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl tini \
 && addgroup -g 1001 nodejs \
 && adduser -u 1001 -G nodejs -s /bin/sh -D memex

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
EXPOSE 4000

# tini как PID 1 — иначе SIGTERM не доходит до Node и контейнер
# убивается по таймауту, обрывая транзакции на полпути.
ENTRYPOINT ["/sbin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
