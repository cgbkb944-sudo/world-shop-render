# WORLD TG SHOP — отдельный сайт

Сайт размещается отдельным Render Web Service из ветки `website-development`. Существующий сервис `world-shop-render` и Telegram Mini App не перенастраиваются.

## Состав
- `website/` — независимый интерфейс сайта.
- `website-server.js` — API сайта и Telegram Login Widget.
- Общая PostgreSQL база с Telegram Mini App.
- Ключи сайта и Mini App используют одни и те же таблицы `activation_keys` и `balance_topup_codes`; повторная активация одноразового ключа блокируется общей базой.

## Переменные Render
В новом сервисе необходимо задать те же значения, что используются существующим backend:
- `DATABASE_URL` — строка подключения к текущей базе WORLD TG SHOP.
- `BOT_TOKEN` — токен текущего Telegram-бота (не публиковать).
- `OWNER_TELEGRAM_ID` — ID владельца (по умолчанию в коде 8127900151).

Не создавайте новую базу данных: сайт должен подключаться к текущей, иначе товары, пользователи, балансы и ключи не будут общими.

## Telegram Login Widget
После создания Render-сервиса скопируйте его домен вида `https://имя-сервиса.onrender.com`. В Telegram откройте `@BotFather`, выберите `/setdomain`, выберите `@World_tg_shop_bot` и укажите только домен без `https://` и без пути. Затем кнопка Telegram Login сможет подтверждать вход на сайте.

## Render
- Runtime: Node
- Build command: `npm install`
- Start command: `node website-server.js`
- Branch: `website-development`
- Plan: Free

Сайт не должен запускать `npm start`: текущий npm start запускает основной процесс миграции Mini App. Используйте отдельную команду запуска выше.

## Важно
Не запускать `migrate.js` на действующей базе. В нём есть историческая одноразовая миграция со сбросом/пересозданием таблиц. `website-server.js` добавляет только таблицу web_sessions через CREATE TABLE IF NOT EXISTS и не меняет/не очищает данные магазина.
