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

Сейчас backend отдает демо-данные. Когда появится боевой доступ, добавь переменные:

```bash
LIFE_POS_API_BASE=https://api.life-pos.ru
LIFE_POS_TOKEN=...
LIFE_POS_ORG_GUID=...
```

Токен и учетные данные LIFE POS должны храниться только на backend.


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

Если используется серверный LIFE_POS_TOKEN без пользовательской сессии:

```bash
curl -X POST http://localhost:4000/api/life-pos/notifications/configure \
  -H "Content-Type: application/json" \
  -H "X-Luma-Admin-Secret: <admin-secret>" \
  -d '{}'
```
