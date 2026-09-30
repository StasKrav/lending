# StanKrav — лендинг с ИИ-чатом на YandexGPT

Лендинг веб-разработчика с работающим ИИ-консультантом. Чат отвечает на вопросы
о услугах, ценах и сроках **реальной нейросетью YandexGPT** (Yandex Cloud
Foundation Models).

```
index.html     — лендинг + чат-виджет (фронтенд)
server.js      — сервер: раздаёт статику + проксирует запросы в YandexGPT
.env.example   — шаблон настроек (скопировать в .env)
package.json   — npm start / npm run dev
```

## Быстрый старт

```bash
cp .env.example .env   # вписать ключи (см. ниже)
npm start              # или: node server.js
```

Открыть **http://localhost:3000** — в правом нижнем углу чат 💬.

Без ключа сервер работает в **demo-режиме** и отвечает заглушкой, чтобы сайт
не падал. Для «настоящего» ИИ нужно настроить ключ.

## Как получить API-ключ Yandex Cloud (один раз)

1. Зайдите в **[Yandex Cloud Console](https://console.cloud.yandex.ru/)**,
   авторизуйтесь через Яндекс ID. Подтвердите платёжный аккаунт (нужна карта,
   но есть пробный грант ~4000 ₽ на 60 дней — на чат этого хватит надолго).
2. Создайте **каталог (folder)**, если его нет. Скопируйте его ID —
   это `YANDEX_FOLDER_ID` (строка вида `b1gxxxxxxxxxxxxxxxx`).
3. В каталоге создайте **сервисный аккаунт**:
   * Cloud → IAM и Access Management → Сервисные аккаунты → **Создать**.
   * Роль: `ai.languageModels.user` (доступ к YandexGPT).
4. Для сервисного аккаунта создайте **API-ключ**:
   * Кнопка ⋯ у аккаунта → **Создать API-ключ** → скопируйте строку
     вида `AQVNxxxxxxxxxxxxxxxx...`. Это `YANDEX_API_KEY`.
5. Впишите оба значения в файл `.env`:

   ```env
   YANDEX_API_KEY=AQVN...
   YANDEX_FOLDER_ID=b1g...
   YANDEX_MODEL=yandexgpt-lite
   PORT=3000
   ```

6. Перезапустите сервер: `npm start`. В логе появится «Модель: yandexgpt-lite»
   вместо «Режим: DEMO».

> ⚠️ Файл `.env` попал в `.gitignore` — ключ никогда не попадёт в git.
> Никогда не вставляйте ключ в `index.html` или другой клиентский код.

## Модели

| Модель | Когда |
|---|---|
| `yandexgpt-lite` (по умолчанию) | быстрая и дешёвая, хватает для консультаций |
| `yandexgpt` | умнее, лучше для сложных вопросов, дороже |

Меняется в `.env`: `YANDEX_MODEL=yandexgpt`.

## Что делает сервер

* Раздаёт статику (`index.html`, `images/`, `favicon.svg`).
* `POST /api/chat` принимает `{ "messages": [{role, text}, ...] }`,
  подставляет системный промпт (личность бота, цены, правила ответов) и
  проксирует запрос в `llm.api.cloud.yandex.net` **со стримингом** —
  текст прилетает на страницу по мере генерации.
* Ограничивает историю последними 12 сообщениями и длиной текста.
* Если ключ не задан — честно отвечает в demo-режиме.

## Деплой на Yandex Cloud (Object Storage + Cloud Function)

Ваш сайт лежит в **Object Storage** (`*.website.yandexcloud.net`) — он умеет
отдавать только статику и не выполняет код. Поэтому бэкенд для чата
поднимается как **публичная Cloud Function** (HTTP-триггеры для функций
в Yandex Cloud упразднены, функция вызывается напрямую по HTTPS).

### Часть 1. Создать Cloud Function (прокси к YandexGPT)

1. В консоли: **Serverless → Functions → Создать функцию** (имя, например
   `yandexgpt-proxy`).
2. В редакторе кода вставьте содержимое файла
   [`cloud-function/index.js`](cloud-function/index.js).
3. Создайте версию функции:
   - runtime: **Node.js 18+**;
   - timeout: **60 сек** (YandexGPT отвечает не мгновенно);
   - memory: 256 МБ;
   - переменные окружения: `YANDEX_API_KEY`, `YANDEX_FOLDER_ID`,
     `YANDEX_MODEL` (те же значения, что в вашем `.env`).
4. Сделайте функцию **публичной**: Cloud Functions → ваша функция →
   страница **«Обзор»** → включите опцию **«Публичная функция»**
   (иначе вызовы потребуют IAM-токен). Через CLI:
   ```bash
   yc serverless function allow-unauthenticated-invoke yandexgpt-proxy
   ```
5. URL вызова функции — `https://functions.yandexcloud.net/<ID_функции>`
   (ID функции виден на странице функции; также есть поле
   «Ссылка для вызова»). Проверьте:
   ```bash
   curl -X POST https://functions.yandexcloud.net/<ID_функции> \
     -H "Content-Type: application/json" \
     -d '{"messages":[{"role":"user","text":"Привет"}]}'
   ```
   Ответ должен прийти от YandexGPT.

### Часть 2. Загрузить статику в Object Storage

В бакет сайта загрузите (перезапишите):

| Файл | Куда |
|---|---|
| `index.html` | корень бакета |
| `images/app1.png`, `app2.png`, `app3.png` | `images/` |
| `favicon.svg` | корень бакета |

Способы: веб-консоль Object Storage («Загрузить») или CLI
(`s3cmd` / `aws s3 cp` / `yc storage cp`).

### Часть 3. Прописать адрес функции в index.html

В [`index.html`](index.html) найдите константу `API_URL` (в блоке кода чата)
и замените плейсхолдер на ваш реальный URL функции:

```js
const API_URL = ... ? '/api/chat' : 'https://functions.yandexcloud.net/<ID_функции>';
```

Затем загрузите обновлённый `index.html` в бакет ещё раз.

> Локально (`localhost`) чат продолжит работать через `server.js` и `/api/chat` —
> переключать ничего не нужно, это автоопределение.

### Часть 4. Готово

Откройте https://stankrav.website.yandexcloud.net/ и проверьте чат 💬.

## Альтернативный деплой (обычный сервер)

Если есть VPS/VDS с Node.js 18+ — просто скопируйте проект и запустите:

```bash
npm start   # порт 3000
```

Через обратный прокси (nginx/Caddy) пробросьте домен на порт 3000.
Этот вариант проще, если у вас уже есть сервер.

## Структура ответа YandexGPT (для отладки)

Стриминг возвращает JSON Lines вида:

```json
{"result":{"alternatives":[{"message":{"role":"assistant","text":"Привет!"},"status":"ALTERNATIVE_STATUS_PARTIAL"}]}}
```

Сервер достаёт поле `text` и отдаёт браузеру чистый поток текста.