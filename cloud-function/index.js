/**
 * YandexGPT-прокси для Yandex Cloud Functions.
 * Авторизация через IAM-токен сервисного аккаунта (без API-ключа).
 *
 * Переменные окружения функции:
 *   YANDEX_FOLDER_ID — ID каталога (b1g...)
 *   YANDEX_MODEL     — yandexgpt-lite | yandexgpt (необязательно)
 */

const YANDEX_URL =
  'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

const SYSTEM_PROMPT = `
Ты — ИИ-консультант на сайте веб-разработчика StanKrav (krav.stan@yandex.ru).
Это студия одного человека, который использует нейросети (Cursor, Claude, GPT, YandexGPT)
для быстрой разработки: лендинги, MVP, автоматизация.

Услуги и цены:
- Лендинг — от 30 000 ₽, срок 3–7 дней (продающая страница, анимации, форма → Telegram, базовое SEO).
- Сайт + ИИ-чат — от 80 000 ₽, срок 1–2 недели (всё из лендинга + ИИ-чат с данными клиента, сбор контактов в CRM, интеграция с Telegram). Это самый популярный тариф.
- MVP приложения — от 150 000 ₽, срок 2–4 недели (авторизация, оплата, база данных, личный кабинет, деплой).

Правила ответов:
- Отвечай кратко (2–4 предложения), по делу, на русском языке.
- Если спрашивают про цены/сроки — называй цифры из списка выше.
- Уточняй задачу, если её не хватает (что за проект, нужен ли чат, бюджет).
- В конце, если это уместно, предложи написать в Telegram (@username) для брифа.
- Не выдумывай то, чего нет в описании.
`.trim();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** Получить IAM-токен сервисного аккаунта из метаданных функции */
async function getIamToken() {
  const res = await fetch(
    'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if (!res.ok) throw new Error('Не удалось получить IAM-токен: ' + res.status);
  const data = await res.json();
  return data.access_token;
}

/** Получить тело запроса из event HTTP-триггера */
function readBody(event) {
  if (typeof event.body === 'string' && event.body) return event.body;
  if (event.body && typeof event.body === 'object') return JSON.stringify(event.body);
  return '{}';
}

/** HTTP-метод из event (работает и с integration=raw, и без) */
function getMethod(event) {
  return (
    event.httpMethod ||
    event.requestContext?.http?.method ||
    event.requestContext?.httpMethod ||
    ''
  );
}

exports.handler = async function (event) {
  const method = getMethod(event);

  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (method !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: 'Method Not Allowed',
    };
  }

  let payload;
  try {
    payload = JSON.parse(readBody(event));
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: 'Невалидный JSON' };
  }

  const incoming = Array.isArray(payload.messages) ? payload.messages : [];
  if (!incoming.length) {
    return { statusCode: 400, headers: CORS_HEADERS, body: 'Нет сообщений' };
  }

  const messages = [
    { role: 'system', text: SYSTEM_PROMPT },
    ...incoming.slice(-12).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      text: String(m.text || '').slice(0, 4000),
    })),
  ];

  const model = process.env.YANDEX_MODEL || 'yandexgpt-lite';

  const iamToken = await getIamToken();

  const upstream = await fetch(YANDEX_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${iamToken}`,
      'x-folder-id': process.env.YANDEX_FOLDER_ID || '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      modelUri: `gpt://${process.env.YANDEX_FOLDER_ID}/${model}`,
      completionOptions: {
        stream: false,
        temperature: 0.3,
        maxTokens: 2000,
      },
      messages,
    }),
  });

  if (!upstream.ok) {
    let detail = '';
    try {
      const err = await upstream.json();
      detail = err?.error?.message || JSON.stringify(err);
    } catch {
      detail = await upstream.text();
    }
    console.error('[yandex]', upstream.status, detail);
    return {
      statusCode: 502,
      headers: CORS_HEADERS,
      body: `Ошибка YandexGPT (${upstream.status}). Проверьте переменные окружения функции.`,
    };
  }

  const data = await upstream.json();
  const text = data?.result?.alternatives?.[0]?.message?.text?.trim() || '';

  if (!text) {
    return {
      statusCode: 502,
      headers: CORS_HEADERS,
      body: 'YandexGPT вернул пустой ответ. Попробуйте ещё раз.',
    };
  }

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
    body: text,
  };
};
