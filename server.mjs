import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const BOOKINGS_DIR = path.join(ROOT, 'data');
const BOOKINGS_PATH = path.join(BOOKINGS_DIR, 'demo-bookings.json');
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const MAX_AUDIO_BYTES = 25_000_000;
const MAX_JSON_BYTES = 24 * 1024;
const OPENAI_BASE = 'https://api.openai.com/v1';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const DEMO_SLOTS = [
  { time: '18:30', status: 'available' },
  { time: '19:00', status: 'busy' },
];

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'microphone=(self)');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}

function sendJson(res, status, value) {
  securityHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError(413, 'Размер запроса превышает допустимый предел.', 'PAYLOAD_TOO_LARGE');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new HttpError(413, 'Размер запроса превышает допустимый предел.', 'PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function requireApiKey() {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new HttpError(503, 'AI-сервис не настроен. Добавьте OPENAI_API_KEY в .env.local и перезапустите приложение.', 'PROVIDER_NOT_CONFIGURED');
  }
  return key;
}

function providerMessage(status) {
  if (status === 401 || status === 403) return 'Ключ OpenAI не принят. Проверьте OPENAI_API_KEY в .env.local.';
  if (status === 429) return 'У AI-сервиса временно нет доступной квоты. Проверьте лимиты проекта и повторите позже.';
  if (status >= 500) return 'AI-сервис временно недоступен. Попробуйте повторить реплику позже.';
  return 'AI-сервис не смог обработать запрос. Повторите реплику.';
}

function normalizeProviderError(error) {
  if (error instanceof TypeError && error.message === 'fetch failed') {
    return new HttpError(502, 'Сервер не может подключиться к OpenAI API. Проверьте интернет-доступ, VPN или прокси и повторите попытку.', 'PROVIDER_CONNECTION_FAILED');
  }
  return error;
}

async function openAiJson(url, key, body, signal) {
  const response = await fetch(`${OPENAI_BASE}${url}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body,
    signal,
  });
  if (!response.ok) {
    throw new HttpError(response.status === 429 ? 429 : 502, providerMessage(response.status), 'PROVIDER_ERROR');
  }
  return response;
}

const transcriptionTypes = new Map([
  ['audio/webm', ['webm', 'audio/webm']],
  ['audio/mp4', ['m4a', 'audio/mp4']],
  ['audio/ogg', ['ogg', 'audio/ogg']],
  ['audio/wav', ['wav', 'audio/wav']],
  ['audio/x-wav', ['wav', 'audio/wav']],
  ['audio/mpeg', ['mp3', 'audio/mpeg']],
]);

async function transcribe(req, res) {
  const key = requireApiKey();
  const rawType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  const typeInfo = transcriptionTypes.get(rawType);
  if (!typeInfo) throw new HttpError(415, 'Этот формат аудио не поддерживается. Попробуйте другой браузер или формат записи.', 'UNSUPPORTED_AUDIO');

  const audio = await readBody(req, MAX_AUDIO_BYTES);
  if (!audio.length) throw new HttpError(400, 'Запись пустая. Запишите реплику ещё раз.', 'EMPTY_AUDIO');

  const form = new FormData();
  form.append('file', new Blob([audio], { type: typeInfo[1] }), `voice.${typeInfo[0]}`);
  form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe');
  form.append('response_format', 'json');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  res.on('close', () => controller.abort());
  try {
    const response = await openAiJson('/audio/transcriptions', key, form, controller.signal);
    const data = await response.json();
    const transcript = typeof data.text === 'string' ? data.text.trim() : '';
    if (!transcript) throw new HttpError(422, 'Не удалось разобрать слова в записи. Попробуйте говорить чуть ближе к микрофону.', 'EMPTY_TRANSCRIPT');
    sendJson(res, 200, { transcript });
  } catch (error) {
    if (error.name === 'AbortError' && !res.writableEnded) {
      throw new HttpError(504, 'Распознавание заняло слишком много времени. Повторите запись.', 'TRANSCRIPTION_TIMEOUT');
    }
    throw normalizeProviderError(error);
  } finally {
    clearTimeout(timer);
  }
}

function cleanHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-8).flatMap((item) => {
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') return [];
    const content = item.content.trim().slice(0, 1_200);
    return content ? [{ role: item.role, content }] : [];
  });
}

function validTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
}

function tomorrowDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function readBookings() {
  if (!existsSync(BOOKINGS_PATH)) return [];
  const value = JSON.parse(readFileSync(BOOKINGS_PATH, 'utf8'));
  return Array.isArray(value) ? value.filter((item) => item && typeof item.id === 'string') : [];
}

function saveBookings(bookings) {
  mkdirSync(BOOKINGS_DIR, { recursive: true });
  writeFileSync(BOOKINGS_PATH, `${JSON.stringify(bookings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function getDemoSlots(bookings = readBookings()) {
  const date = tomorrowDate();
  return DEMO_SLOTS.map((slot) => ({
    ...slot,
    status: bookings.some((booking) => booking.date === date && booking.time === slot.time) ? 'busy' : slot.status,
  }));
}

function createDemoBooking(payload) {
  const clientName = typeof payload.clientName === 'string'
    ? payload.clientName.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 80)
    : '';
  const time = validTime(payload.time);
  if (payload.confirmed !== true) throw new HttpError(400, 'Подтвердите создание демонстрационной записи.', 'BOOKING_CONFIRMATION_REQUIRED');
  if (!clientName) throw new HttpError(400, 'Укажите имя клиента.', 'CLIENT_NAME_REQUIRED');
  if (!time) throw new HttpError(400, 'Выберите корректное время.', 'INVALID_BOOKING_TIME');
  if (time !== '18:30') throw new HttpError(409, 'Это время занято или отсутствует в демонстрационном расписании.', 'SLOT_UNAVAILABLE');

  const bookings = readBookings();
  if (bookings.some((booking) => booking.date === tomorrowDate() && booking.time === time)) {
    throw new HttpError(409, 'Это время уже заняли. Обновите расписание и выберите другой слот.', 'SLOT_ALREADY_BOOKED');
  }

  const booking = {
    id: crypto.randomUUID(),
    clientName,
    date: tomorrowDate(),
    dayOffset: 1,
    time,
    createdAt: new Date().toISOString(),
  };
  saveBookings([booking, ...bookings]);
  return booking;
}

function cancelDemoBooking(id) {
  const bookings = readBookings();
  const booking = bookings.find((item) => item.id === id);
  if (!booking) throw new HttpError(404, 'Запись не найдена. Обновите список.', 'BOOKING_NOT_FOUND');
  saveBookings(bookings.filter((item) => item.id !== id));
  return booking;
}

function checkSchedule({ day_offset, after_time, requested_time }) {
  const dayOffset = Number.isInteger(day_offset) && day_offset >= 1 && day_offset <= 365 ? day_offset : null;
  const after = validTime(after_time);
  const requested = validTime(requested_time);
  const invalidTime = (after_time !== null && after === null) || (requested_time !== null && requested === null) || (after && requested);
  if (invalidTime) {
    return { status: 'needs_clarification', reason: 'Время распознано неоднозначно. Нужно уточнить время, которое следует проверить.' };
  }
  if (!dayOffset) {
    return { status: 'needs_clarification', reason: 'Дата не определена. Нужно уточнить, на какой день проверить расписание.' };
  }
  if (dayOffset !== 1) {
    return { status: 'no_data', day_offset: dayOffset, reason: 'В демонстрационном расписании есть данные только на завтра. На запрошенный день сведений нет.' };
  }

  const slots = getDemoSlots();

  if (requested) {
    const exact = slots.find((slot) => slot.time === requested);
    return {
      status: 'checked',
      day_offset: 1,
      requested_time: requested,
      requested_status: exact?.status || 'not_listed',
      alternatives: slots,
    };
  }

  const filtered = after ? slots.filter((slot) => slot.time >= after) : slots;
  return {
    status: 'checked',
    day_offset: 1,
    after_time: after,
    slots: filtered,
    available_slots: filtered.filter((slot) => slot.status === 'available').map((slot) => slot.time),
    busy_slots: filtered.filter((slot) => slot.status === 'busy').map((slot) => slot.time),
  };
}

const scheduleTool = {
  type: 'function',
  name: 'check_schedule',
  description: 'Read-only lookup in the small fictional consultation schedule. Never create or change an appointment. Use day_offset 1 for tomorrow, 2 for the day after tomorrow. Set after_time when the person requests a range, or requested_time for one exact time. Use null when the transcript does not make a field clear.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      day_offset: { type: ['integer', 'null'], minimum: 1, maximum: 365 },
      after_time: { type: ['string', 'null'], description: '24-hour HH:MM, or null if not requested.' },
      requested_time: { type: ['string', 'null'], description: 'Exact requested time in 24-hour HH:MM, or null if not requested.' },
    },
    required: ['day_offset', 'after_time', 'requested_time'],
    additionalProperties: false,
  },
};

const parseInstructions = [
  'You parse Russian speech for a fictional study consultation schedule.',
  'You must call check_schedule exactly once for every user turn.',
  'Relative dates are offsets from the user local date: tomorrow is 1, the day after tomorrow is 2.',
  'For “tomorrow after six”, return day_offset 1 and after_time 18:00. For “tomorrow at seven”, return requested_time 19:00.',
  'When the date is not clear, use null for day_offset. Do not infer availability, create appointments, or answer the user in this step.',
].join(' ');

const answerInstructions = [
  'Ты голосовой помощник учебной консультации. Отвечай по-русски, коротко и естественно.',
  'Используй только результат check_schedule. Не придумывай слоты, даты, причины и действия.',
  'Если status=checked и запрошен диапазон, назови известные свободные и занятые слоты, подходящие диапазону.',
  'Если время свободно, скажи, что для создания демонстрационной записи клиент должен указать имя и подтвердить форму справа.',
  'Если точное время занято, скажи это и можешь предложить подтверждённый свободный вариант из alternatives.',
  'Если status=no_data, скажи, что данных на эту дату нет и доступность подтвердить нельзя; предложи другую дату или попробовать позже.',
  'Если status=needs_clarification, задай один короткий уточняющий вопрос.',
  'Не утверждай, что запись оформлена: она сохраняется только после отдельного явного подтверждения клиента в форме приложения.',
].join(' ');

async function respond(req, res) {
  const key = requireApiKey();
  const body = await readBody(req, MAX_JSON_BYTES);
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Не удалось прочитать запрос. Повторите реплику.', 'INVALID_JSON');
  }
  if (typeof payload.transcript !== 'string' || !payload.transcript.trim() || payload.transcript.length > 2_500) {
    throw new HttpError(400, 'Текст запроса пустой или слишком длинный.', 'INVALID_TRANSCRIPT');
  }

  const input = [...cleanHistory(payload.history), { role: 'user', content: payload.transcript.trim() }];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const intentResponse = await fetch(`${OPENAI_BASE}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_TEXT_MODEL || 'gpt-6-luna',
        store: false,
        instructions: parseInstructions,
        input,
        tools: [scheduleTool],
        tool_choice: { type: 'function', name: 'check_schedule' },
        parallel_tool_calls: false,
        max_output_tokens: 160,
      }),
      signal: controller.signal,
    });
    if (!intentResponse.ok) throw new HttpError(intentResponse.status === 429 ? 429 : 502, providerMessage(intentResponse.status), 'PROVIDER_ERROR');
    const intent = await intentResponse.json();
    const call = Array.isArray(intent.output) ? intent.output.find((item) => item.type === 'function_call' && item.name === 'check_schedule') : null;
    if (!call || typeof call.call_id !== 'string') throw new HttpError(502, 'AI-сервис не вернул результат разбора запроса. Повторите реплику.', 'INVALID_TOOL_CALL');

    let args;
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      throw new HttpError(502, 'AI-сервис вернул некорректные параметры проверки. Повторите реплику.', 'INVALID_TOOL_ARGUMENTS');
    }
    const schedule = checkSchedule(args);
    if (args.day_offset === 1 && (args.after_time === '18:00' || args.requested_time === '19:00')) {
      schedule.display_label = 'Завтра';
    } else if (args.day_offset === 2) {
      schedule.display_label = 'Послезавтра';
    }

    const answerInput = [
      ...input,
      ...intent.output,
      { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(schedule) },
    ];
    const answerResponse = await fetch(`${OPENAI_BASE}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_TEXT_MODEL || 'gpt-6-luna',
        store: false,
        instructions: answerInstructions,
        input: answerInput,
        stream: true,
        max_output_tokens: 220,
      }),
      signal: controller.signal,
    });
    if (!answerResponse.ok) throw new HttpError(answerResponse.status === 429 ? 429 : 502, providerMessage(answerResponse.status), 'PROVIDER_ERROR');

    securityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: schedule\ndata: ${JSON.stringify(schedule)}\n\n`);

    const decoder = new TextDecoder();
    let buffer = '';
    let sawCompleted = false;
    for await (const chunk of answerResponse.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        const raw = dataLine.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let event;
        try { event = JSON.parse(raw); } catch { continue; }
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          res.write(`event: delta\ndata: ${JSON.stringify({ text: event.delta })}\n\n`);
        } else if (event.type === 'response.completed') {
          sawCompleted = true;
          res.write('event: done\ndata: {}\n\n');
        } else if (event.type === 'error' || event.type === 'response.failed') {
          res.write(`event: error\ndata: ${JSON.stringify({ message: 'AI-сервис не смог завершить ответ. Повторите реплику.' })}\n\n`);
        }
      }
    }
    if (!sawCompleted && !res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'Соединение с AI-сервисом прервалось. Повторите реплику.' })}\n\n`);
    }
    if (!res.writableEnded) res.end();
  } catch (error) {
    error = normalizeProviderError(error);
    if (error.name === 'AbortError') {
      if (!res.headersSent) throw new HttpError(504, 'Обработка заняла слишком много времени. Повторите реплику.', 'AI_TIMEOUT');
      return;
    }
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: error.message || 'Обработка не удалась. Повторите реплику.' })}\n\n`);
        res.end();
      }
      return;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return sendJson(res, 400, { error: 'Некорректный путь.' }); }
  const requested = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)) return sendJson(res, 404, { error: 'Страница не найдена.' });
  let info;
  try { info = await stat(resolved); } catch { return sendJson(res, 404, { error: 'Страница не найдена.' }); }
  if (!info.isFile()) return sendJson(res, 404, { error: 'Страница не найдена.' });
  securityHeaders(res);
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(resolved)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(resolved).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/health') {
      return sendJson(res, 200, { ok: true, providerConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()) });
    }
    if (req.method === 'GET' && req.url === '/api/bookings') {
      const bookings = readBookings();
      return sendJson(res, 200, { bookings, slots: getDemoSlots(bookings), date: tomorrowDate() });
    }
    if (req.method === 'POST' && req.url === '/api/bookings') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8'));
      } catch {
        throw new HttpError(400, 'Не удалось прочитать данные записи.', 'INVALID_JSON');
      }
      const booking = createDemoBooking(payload || {});
      const bookings = readBookings();
      return sendJson(res, 201, { booking, bookings, slots: getDemoSlots(bookings) });
    }
    const bookingCancelMatch = req.method === 'DELETE' ? req.url?.match(/^\/api\/bookings\/([0-9a-f-]{36})$/i) : null;
    if (bookingCancelMatch) {
      cancelDemoBooking(bookingCancelMatch[1]);
      const bookings = readBookings();
      return sendJson(res, 200, { bookings, slots: getDemoSlots(bookings) });
    }
    if (req.method === 'POST' && req.url === '/api/transcribe') return await transcribe(req, res);
    if (req.method === 'POST' && req.url === '/api/respond') return await respond(req, res);
    if (req.url?.startsWith('/api/')) return sendJson(res, 404, { error: 'API-маршрут не найден.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Метод не поддерживается.' });
    return await serveStatic(req, res);
  } catch (error) {
    error = normalizeProviderError(error);
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const status = Number.isInteger(error.status) ? error.status : 500;
    const message = error instanceof HttpError ? error.message : 'Внутренняя ошибка приложения. Попробуйте ещё раз.';
    if (status >= 500) {
      console.error(JSON.stringify({
        event: 'request_error',
        route: req.url,
        error: error.name || 'Error',
        code: error.code || error.cause?.code || 'INTERNAL_ERROR',
        status,
      }));
    }
    sendJson(res, status, { error: message, code: error.code || 'INTERNAL_ERROR' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Voice consultation assistant listening on http://localhost:${PORT}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT in .env.local to another port.`);
  } else {
    console.error('Could not start the local server.');
  }
  process.exitCode = 1;
});
