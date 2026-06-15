# Люма.Маркет

PWA-панель владельца для удаленного мониторинга продаж LIFE POS.

## Запуск

```bash
npm install
npm run dev
```

Frontend:

```text
http://localhost:5173
```

Backend:

```text
http://localhost:4000
```

## Интеграция LIFE POS

Backend не хранит общий `LIFE_POS_TOKEN` и `LIFE_POS_ORG_GUID`. Пользователь входит по телефону и паролю LIFE PAY, после чего backend держит его LIFE POS token только в серверной сессии.

На устройстве сохраняется только opaque `sessionToken`. Реальный LIFE POS token хранится на backend в `server/data/sessions.json`, этот файл не должен попадать в Git. По умолчанию сессия живет 30 дней и продлевается при использовании.

Базовый URL API:

```bash
LIFE_POS_API_BASE=https://api.life-pos.ru
SESSION_TTL_DAYS=30
# опционально: SESSION_STORE_PATH=/absolute/path/sessions.json
```

Без пользовательской сессии `/api/summary`, `/api/operations`, `/api/analytics`, `/api/me` возвращают `401`.


Документация Life POS:

https://docs.life-pay.ru/lpos/60/start

## Push-уведомления

Backend умеет принимать уведомления LIFE POS об операциях и пересылать их в Web Push подписки PWA.

Нужные переменные:

```bash
WEB_PUSH_PUBLIC_KEY=...
WEB_PUSH_PRIVATE_KEY=...
WEB_PUSH_SUBJECT=mailto:admin@example.com
LIFE_POS_NOTIFICATIONS_URL=https://example.com/api/life-pos/notifications/<secret>
LIFE_POS_NOTIFICATION_SECRET=<secret>
LUMA_ADMIN_SECRET=...
```

Сгенерировать VAPID-ключи:

```bash
npx web-push generate-vapid-keys
```

Включить расширение уведомлений LIFE POS для организации можно запросом к backend:

```bash
curl -X POST http://localhost:4000/api/life-pos/notifications/configure \
  -H "Content-Type: application/json" \
  -H "X-Luma-Session: <session-token>" \
  -d '{"primaryUrl":"https://example.com/api/life-pos/notifications/<secret>"}'
```

Настройка уведомлений тоже выполняется только от имени авторизованной пользовательской сессии.
