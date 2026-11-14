# WORLD TG SHOP — безопасный запуск v2

## Важно перед запуском
В прежнем `server.js` были опубликованы секреты платёжных интеграций. Считайте их скомпрометированными: немедленно отзовите/перевыпустите токен Crypto Pay и ключ RollyPay в кабинетах провайдеров. Не переносите старые значения в новый `.env` и не отправляйте их в чат.

## Новая база данных
1. Создайте отдельную пустую PostgreSQL-базу.
2. Сделайте резервную копию старой базы, если она существует.
3. Выполните `psql "$DATABASE_URL" -f database/schema.sql`.
4. Не удаляйте старую базу, пока не сверены пользователи, товары и финансовые остатки.
5. Новая схема намеренно не создаёт тестовых ключей, товаров или балансов.

## Переменные окружения
Скопируйте `.env.example` в `.env` на сервере (не в Git), заполните DATABASE_URL, BOT_TOKEN, OWNER_TELEGRAM_ID и APP_ORIGIN. Установите секреты только в панели хостинга или secret manager.

## Telegram Mini App
Backend обязан валидировать Telegram WebApp initData на каждом API-запросе. Не доверяйте telegram_id, admin_id, seller_id или роли, присланным браузером. Для локальной разработки вне Telegram авторизация намеренно не должна обходиться фиктивным пользователем.

## Платежи
Не включайте автоматическое зачисление денег, пока для конкретного провайдера не реализованы и не проверены: подпись webhook по официальной документации, проверка суммы/валюты/идентификатора платежа, защита от повторной обработки и атомарная запись в БД. Нельзя считать клиентский redirect подтверждением оплаты.
TON/USDT перевод без проверяемого chain-indexer — только `manual_review`; QR-код и комментарий сами по себе не доказывают оплату.

## Релиз
1. Установите зависимости: `npm ci` (после добавления lock-файла) или `npm install`.
2. Проверьте `npm start` и `GET /health`.
3. Протестируйте Telegram auth, роли, блокировки, создание товара, покупку и каждый webhook на тестовых учётных данных.
4. Настройте HTTPS, ограничение запросов, резервное копирование PostgreSQL и мониторинг.
5. Откройте PR из ветки `security-hardening-v2`; не сливайте в main до проверки.

## Ограничение текущего этапа
Схема БД и безопасные требования к развёртыванию подготовлены. Платёжные адаптеры нельзя безопасно активировать без актуальных спецификаций Crypto Pay/RollyPay и тестовых реквизитов; не включайте зачисление по неподписанным webhook.


## Payment integrations

Configure these values in Render Environment (never commit real credentials):
- \`CRYPTO_PAY_API_TOKEN\`: Crypto Pay app token. The shop creates invoices priced in RUB; Crypto Pay calculates the live crypto amount and accepts TON or USDT.
- \`CRYPTO_PAY_WEBHOOK_SECRET\`: generate a long random string for the private webhook URL path. Set the Crypto Pay webhook URL to \`https://YOUR_DOMAIN/webhooks/cryptobot/THAT_SECRET\`. The request signature is verified with the Crypto Pay API token.
- \`ROLLYPAY_API_KEY\` and \`ROLLYPAY_WEBHOOK_SECRET\`: RollyPay cashier API key and webhook signing secret. Set the cashier callback URL to \`https://YOUR_DOMAIN/webhooks/rollypay\`.
- \`TON_WALLET_ADDRESS\`: public store wallet for native TON and official USDT Jetton on TON.
- \`TONCENTER_API_KEY\`: recommended TON Center API v3 key to avoid public API rate limits.
- \`APP_ORIGIN\`: public Mini App origin used for payment return redirects.

The user enters a RUB amount. Crypto Pay creates a RUB fiat invoice and calculates the accepted crypto amount on its checkout page. RollyPay receives the RUB amount and supplies its payment page for SBP or card. Direct TON / USDT payments are quoted from the current valid Crypto Pay asset-to-RUB rate, and the invoice expires after 20 minutes.

For direct transfers, the server assigns a unique exact amount (smallest-unit suffix) to each invoice, so a shared wallet address can identify simultaneous payments without depending on a comment/memo. TON deposits are monitored through TON Center API v3. The server checks the recipient, amount, official USDT master contract, successful transaction and masterchain inclusion before crediting the user. Repeated webhook deliveries and repeated chain scans cannot credit the same payment twice.

Before enabling production deposits, deploy the new empty PostgreSQL schema on a separate staging database, configure all provider webhooks, test Crypto Pay and RollyPay sandbox flows, and send small test TON and official USDT deposits. The old database must remain untouched until staging tests pass.


## Roles and owner console

The configured owner Telegram ID is `8127900151`. Set `OWNER_TELEGRAM_ID=8127900151` in Render Environment before deploying. Owner access is assigned only after Telegram Mini App initData is validated by the server; a browser-supplied role or ID is never trusted.

The owner console provides service totals, seller list and seller details (products, sales/orders and transaction ledger), role assignment, balance adjustment and account bans. The owner can generate one-time activation codes for `admin`, `support` and `seller` roles. Codes are stored as SHA-256 hashes and can be used once. Admin and seller accounts can publish products; only the owner can access owner statistics, change roles, adjust balances or ban accounts.
