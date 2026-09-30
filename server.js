/**
 * Сервер-прокси для YandexGPT (Yandex Cloud Foundation Models).
 *
 * Зачем нужен: API-ключ Yandex Cloud НЕЛЬЗЯ хранить на фронтенде —
 * он светился бы в коде страницы и его мог бы украсть любой.
 * Этот сервер:
 *   1. Раздаёт статику (index.html, images, favicon)
 *   2. Принимает POST /api/chat и проксирует запрос в YandexGPT
 *   3. Если ключ не настроен — работает в demo-режиме (заглушки),
 *      чтобы сайт не падал при локальной разработке.
 *
 * Запуск:
 *   cp .env.example .env   # вписать YANDEX_API_KEY и YANDEX_FOLDER_ID
 *   node server.js         # или: npm start
 *
 * Node.js 18+ (используется встроенный fetch, зависимости не нужны).
 */

import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = __dirname;

/* ============================================================
 * Загрузка .env (без внешних зависимостей — свой dotenv)
 * ============================================================ */
function loadDotEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

/* ============================================================
 * Конфигурация (переменные окружения)
 * ============================================================ */
const PORT = Number(process.env.PORT || 3000);

// API-ключ сервисного аккаунта Yandex Cloud (начинается с AQVN...)
const YANDEX_API_KEY = (process.env.YANDEX_API_KEY || '').trim();
// ID каталога (folder) в Yandex Cloud
const YANDEX_FOLDER_ID = (process.env.YANDEX_FOLDER_ID || '').trim();
// Модель: yandexgpt-lite (быстрая/дешёвая), yandexgpt (умнее)
const YANDEX_MODEL = (process.env.YANDEX_MODEL || 'yandexgpt-lite').trim();

const DEMO_MODE = !YANDEX_API_KEY || !YANDEX_FOLDER_ID;

const YANDEX_URL =
  'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

/* ============================================================
 * Системный промпт — личность бота
 * ============================================================ */
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
- Не выдумывай то, чего нет в описании. Про технологии и процесс говори общими словами.
`.trim();

/* ============================================================
 * MIME-типы для статики
 * ============================================================ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/* ============================================================
 * Раздача статики
 * ============================================================ */
async function serveStatic(req, res, urlPath) {
  // Защита от path traversal
  const safePath = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(ROOT, safePath === '/' ? 'index.html' : safePath);

  // Убеждаемся, что итоговый путь остался внутри ROOT
  const rel = relative(ROOT, filePath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    // Для HEAD-запросов тело не отправляем
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
 * YandexGPT: вызов API (без стриминга — надёжнее, без дублей)
 * Получаем полный ответ и отдаём его клиенту по словам,
 * чтобы на странице сохранился эффект «печатающего» текста.
 * ============================================================ */
async function streamYandexGPT(messages, res) {
  const body = {
    modelUri: `gpt://${YANDEX_FOLDER_ID}/${YANDEX_MODEL}`,
    completionOptions: {
      stream: false,
      temperature: 0.3,
      maxTokens: 2000,
    },
    messages,
  };

  const upstream = await fetch(YANDEX_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Api-Key ${YANDEX_API_KEY}`,
      'x-folder-id': YANDEX_FOLDER_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Ошибка YandexGPT (${upstream.status}). Проверьте ключ и folder id в .env.`);
    return;
  }

  const data = await upstream.json();
  const text = data?.result?.alternatives?.[0]?.message?.text?.trim() || '';

  if (!text) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('YandexGPT вернул пустой ответ. Попробуйте ещё раз.');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
  });

  // Отдаём текст порциями, имитируя генерацию
  const words = text.split(/(\s+)/);
  for (let i = 0; i < words.length; i++) {
    res.write(words[i]);
    await sleep(10);
  }
  res.end();
}

/* ============================================================
 * Обработчик /api/chat
 * ============================================================ */
async function handleChat(req, res) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) {
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Слишком длинное сообщение');
    }
  }

  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Невалидный JSON');
  }

  const incoming = Array.isArray(payload.messages) ? payload.messages : [];
  if (incoming.length === 0) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Нет сообщений');
  }

  // Не даём спамить гигантской историей
  const last = incoming.slice(-12);

  // Первым сообщением всегда идёт системный промпт
  const messages = [
    { role: 'system', text: SYSTEM_PROMPT },
    ...last.map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      text: String(m.text || '').slice(0, 4000),
    })),
  ];

  /* ----- Demo-режим: нет ключа → эмулируем ответ заглушкой ----- */
  if (DEMO_MODE) {
    console.warn('[demo] YANDEX_API_KEY не настроен — отвечаю заглушкой.');
    const reply =
      'Я сейчас работаю в demo-режиме: ключ YandexGPT ещё не подключён. ' +
      'Когда владелец сайта добавит API-ключ в .env, я буду отвечать по-настоящему. ' +
      'Пока что расскажу по-быстрому: лендинг — от 30 000 ₽ (3–7 дней), ' +
      'сайт с ИИ-чатом — от 80 000 ₽ (1–2 недели), MVP — от 150 000 ₽ (2–4 недели).';

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    const words = reply.split(' ');
    for (let i = 0; i < words.length; i++) {
      res.write((i === 0 ? '' : ' ') + words[i]);
      await new Promise((r) => setTimeout(r, 25));
    }
    return res.end();
  }

  /* ----- Реальный режим ----- */
  try {
    await streamYandexGPT(messages, res);
  } catch (err) {
    console.error('[proxy]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Внутренняя ошибка сервера');
    } else {
      res.end();
    }
  }
}

/* ============================================================
 * Основной сервер
 * ============================================================ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Небольшая защита от чужих сайтов (если фронт открыт с другого origin)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      return await handleChat(req, res);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return await serveStatic(req, res, url.pathname);
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
  } catch (err) {
    console.error('[server]', err);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ┌───────────────────────────────────────────────┐');
  console.log('  │  StanKrav лендинг + YandexGPT                │');
  console.log(`  │  http://localhost:${String(PORT).padEnd(37)}│`);
  console.log(DEMO_MODE
    ? '  │  Режим: DEMO (ключ не настроен)                  │'
    : `  │  Модель: ${YANDEX_MODEL.padEnd(41)}│`);
  console.log('  └───────────────────────────────────────────────┘');
  console.log('');
});