# Развёртывание

## Локально

Нужны Node 20+ и Docker Desktop.

```bash
npm install
npm run setup             # сгенерирует .env с секретами
docker compose up -d      # postgres + redis
npm run db:generate       # Prisma Client
npm run db:push           # схема в базу
npm run db:seed           # тестовые аккаунты и токены
npm run dev               # api :4000 + web :3000 + воркеры
```

Открыть http://localhost:3000/login и войти как `admin@memex.local` /
`DevPassword123!` — на странице входа в dev-режиме есть кнопки автозаполнения.

Порядок важен: `db:generate` создаёт Prisma Client, без него API не стартует.
`npm run dev` собирает `@memex/core` перед запуском, потому что API и веб
импортируют его из `dist`, а не из исходников.

Если порт занят: API читает `API_PORT` из `.env`, веб запускается через
`npm run dev:web -- -p 3001`.

## Что выбрать для облака

| Вариант | Кому подходит | Порядок цены | Минусы |
|---|---|---|---|
| **Railway** | быстрее всего поднять | ~$20–30/мес | дороже при росте |
| **Render** | нужен готовый blueprint | ~$25/мес | холодный старт на free-плане |
| **Fly.io** | нужна близость к RPC-узлам | ~$15–25/мес | больше ручной работы |
| **Vercel (веб) + Railway (API)** | лучший CDN для фронта | ~$20/мес | два дашборда |
| **VPS + docker compose** | полный контроль, дешевле | ~$12–20/мес | обновления и бэкапы на вас |

Для торговой платформы важна близость к RPC-провайдеру: задержка в 200 мс
на пути до Solana RPC — это проскальзывание на реальных деньгах. Если
выбираете регион, берите тот же, где находится ваш узел (обычно Frankfurt
или Virginia).

## Railway

```bash
npm i -g @railway/cli
railway login
railway init

railway add --database postgres
railway add --database redis

# Секреты
railway variables set JWT_SECRET="$(openssl rand -base64 48)"
railway variables set EXECUTION_MODE=paper
railway variables set PERFORMANCE_FEE_BPS=1000
railway variables set NODE_ENV=production
railway variables set CORS_ORIGINS=https://memexdex.com,https://www.memexdex.com

railway up
```

`DATABASE_URL` и `REDIS_URL` Railway подставляет автоматически.
Воркеры добавляются вторым сервисом из того же репозитория
с командой запуска `node apps/api/dist/workers/index.js`.

## Подключение своего домена

Раскладка: фронтенд на корневом домене, API на поддомене. Так не нужен
reverse proxy, и сертификаты платформа выпускает сама.

| Запись | Имя | Значение | Куда ведёт |
|---|---|---|---|
| CNAME | `www` | `<web-сервис>.up.railway.app` | Next.js |
| CNAME | `api` | `<api-сервис>.up.railway.app` | Fastify |
| ALIAS/ANAME | `@` | `<web-сервис>.up.railway.app` | Next.js |

Корневой домен (`@`) нельзя направить обычным CNAME — это запрещено
стандартом DNS. Нужна запись ALIAS или ANAME; их поддерживают Cloudflare,
Namecheap и большинство современных регистраторов. Если ваш регистратор
такого не умеет — переведите NS-записи на Cloudflare, там это бесплатно.

После добавления доменов в дашборде Railway (Settings → Networking →
Custom Domain) обязательно обновите две переменные, иначе фронт и API
не увидят друг друга:

```bash
railway variables set CORS_ORIGINS=https://memexdex.com,https://www.memexdex.com
# для веб-сервиса — это build-time переменная, Next вшивает её в бандл:
railway variables set NEXT_PUBLIC_API_URL=https://api.memexdex.com/api/v1
```

Веб-сервис после смены `NEXT_PUBLIC_API_URL` нужно пересобрать — простого
рестарта недостаточно, значение попадает в статические файлы на этапе сборки.

Проверка, что всё сошлось:

```bash
curl https://api.memexdex.com/health
# {"ok":true,"mode":"paper",...}

curl -I -H "Origin: https://memexdex.com" https://api.memexdex.com/health | grep -i access-control
# должен вернуться заголовок access-control-allow-origin
```

Если второй запрос ничего не выводит — `CORS_ORIGINS` задан неверно,
и браузер будет блокировать все запросы фронтенда при пустых логах API.

## Render

В репозитории лежит `render.yaml`. В дашборде: **New → Blueprint** →
выбрать репозиторий. Render создаст API, воркер, Postgres и Redis.
Вручную нужно задать только `AWS_KMS_KEY_ID` и `ZEROX_API_KEY`
(помечены `sync: false`).

## Vercel для фронтенда

```bash
cd apps/web
vercel --prod
```

Переменная окружения: `NEXT_PUBLIC_API_URL=https://api.memexdex.com/api/v1`.
Домен фронтенда добавьте в `CORS_ORIGINS` на стороне API, иначе браузер
заблокирует запросы.

## VPS одной командой

```bash
git clone <репозиторий> && cd memex-dex
cp .env.example .env && nano .env      # заполнить секреты
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec api \
  npx prisma migrate deploy --schema=prisma/schema.prisma
```

## Миграции вместо db:push

`db:push` годится только для разработки — он меняет схему без истории
и может молча удалить колонку с данными. Перед первым деплоем:

```bash
npx prisma migrate dev --name init --schema=prisma/schema.prisma
```

Дальше на всех окружениях — `prisma migrate deploy`. Он уже прописан
в `railway.json` и `render.yaml`.

## Обязательное перед боевым запуском

`KMS_PROVIDER=local` в production завершает процесс с ошибкой — это
намеренная защита. Локальный мастер-ключ лежит в переменной окружения,
и утечка дампа окружения означает потерю всех средств пользователей.
Заведите ключ в AWS KMS (или GCP KMS) и реализуйте `AwsKms` в
`apps/api/src/lib/crypto.ts` — там уже готовы сигнатуры методов.

Оставляйте `EXECUTION_MODE=paper`, пока не пройдены пункты из
`docs/LEGAL-RISK.md`. В paper-режиме работает всё, кроме отправки
транзакций в сеть, — это позволяет проверить экономику на реальных
котировках без движения денег.
