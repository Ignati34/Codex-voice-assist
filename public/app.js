const $ = (selector) => document.querySelector(selector);

const connectionStatus = $('#connectionStatus');
const connectionText = $('#connectionText');
const stageStatus = $('#stageStatus');
const stageText = $('#stageText');
const conversation = $('#conversation');
const welcomeMessage = $('#welcomeMessage');
const sessionButton = $('#sessionButton');
const recordButton = $('#recordButton');
const recordButtonText = $('#recordButtonText');
const composerHint = $('#composerHint');
const errorMessage = $('#errorMessage');
const playbackPanel = $('#playbackPanel');
const playbackLabel = $('#playbackLabel');
const playbackProgress = $('#playbackProgress');
const scheduleResult = $('#scheduleResult');
const clearButton = $('#clearButton');
const bookingForm = $('#bookingForm');
const bookingName = $('#bookingName');
const bookingTime = $('#bookingTime');
const bookingConfirmed = $('#bookingConfirmed');
const bookingSubmit = $('#bookingSubmit');
const bookingStatus = $('#bookingStatus');
const bookingsList = $('#bookingsList');
const bookingCount = $('#bookingCount');

const state = {
  connected: false,
  providerConfigured: false,
  starting: false,
  sessionId: 0,
  turnId: 0,
  history: [],
  recorder: null,
  recordingStream: null,
  chunks: [],
  controller: null,
  currentAnswer: '',
  currentSpeech: null,
  activeAssistantBody: null,
  activeAssistantText: null,
  speechProgressTimer: null,
};

const icons = {
  assistant: '<svg viewBox="0 0 24 24" fill="none"><path d="M3.5 10v4M8 6v12M12 3v18M16 7v10M20.5 10v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.5" stroke="currentColor" stroke-width="1.8"/><path d="M5 20c.7-3.4 3.2-5.2 7-5.2s6.3 1.8 7 5.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

function setStage(stage, label) {
  stageStatus.dataset.state = stage;
  stageText.textContent = label;
}

function setConnection(kind, label) {
  connectionStatus.dataset.state = kind;
  connectionText.textContent = label;
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
  setStage('error', 'Ошибка / соединение прервано');
  if (!state.connected) setConnection('error', 'Соединение прервано');
}

function clearError() {
  errorMessage.textContent = '';
  errorMessage.hidden = true;
}

function setConnected(connected) {
  state.connected = connected;
  recordButton.disabled = !connected;
  sessionButton.textContent = connected ? 'Завершить разговор' : 'Начать разговор';
  sessionButton.classList.toggle('is-connected', connected);
  clearButton.disabled = conversation.querySelectorAll('.message-row').length === 0;
  setConnection(connected ? 'connected' : 'disconnected', connected ? 'Сессия активна' : 'Разговор не начат');
}

function timestamp() {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date());
}

function scrollConversation() {
  conversation.scrollTop = conversation.scrollHeight;
}

function createMessage(role, content = '', { streaming = false, pending = false } = {}) {
  welcomeMessage.hidden = true;
  const row = document.createElement('article');
  row.className = 'message-row';
  row.dataset.role = role;

  const avatar = document.createElement('span');
  avatar.className = role === 'assistant' ? 'assistant-avatar' : 'user-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.innerHTML = icons[role];

  const body = document.createElement('div');
  body.className = 'message-body';
  const top = document.createElement('div');
  top.className = 'message-topline';
  const label = document.createElement('p');
  label.className = 'message-label';
  label.textContent = role === 'assistant' ? 'Помощник' : 'Вы';
  const time = document.createElement('time');
  time.className = 'message-time';
  time.textContent = timestamp();
  top.append(label, time);

  const text = document.createElement('p');
  text.className = 'message-copy';
  if (streaming) text.classList.add('is-streaming');
  text.textContent = pending ? content : content;
  body.append(top, text);
  row.append(avatar, body);
  conversation.append(row);
  clearButton.disabled = false;
  scrollConversation();
  return { row, body, text };
}

function clearConversation() {
  for (const row of conversation.querySelectorAll('.message-row')) row.remove();
  welcomeMessage.hidden = false;
  state.history = [];
  state.currentAnswer = '';
  state.activeAssistantBody = null;
  state.activeAssistantText = null;
  scheduleResult.hidden = true;
  playbackPanel.hidden = true;
  playbackProgress.style.width = '0%';
  clearError();
  clearButton.disabled = true;
  setStage(state.connected ? 'idle' : 'done', state.connected ? 'Готов к разговору' : 'Разговор завершён');
}

function stopCurrentAudio() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  state.currentSpeech = null;
  clearInterval(state.speechProgressTimer);
  state.speechProgressTimer = null;
  playbackProgress.style.width = '0%';
}

function cancelCurrentTurn() {
  state.turnId += 1;
  if (state.controller) state.controller.abort();
  state.controller = null;
  stopCurrentAudio();
  if (state.activeAssistantText) state.activeAssistantText.classList.remove('is-streaming');
  state.activeAssistantBody = null;
  state.activeAssistantText = null;
  playbackPanel.hidden = true;
  return state.turnId;
}

function stopRecordingStream() {
  if (state.recordingStream) {
    for (const track of state.recordingStream.getTracks()) track.stop();
    state.recordingStream = null;
  }
}

function getRecordingMimeType() {
  if (!window.MediaRecorder) return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
}

async function startSession() {
  if (state.connected || state.starting) return;
  state.starting = true;
  sessionButton.disabled = true;
  clearError();
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const health = await response.json();
    if (!response.ok) throw new Error('Локальный сервер недоступен. Перезапустите приложение.');
    state.providerConfigured = Boolean(health.providerConfigured);
    if (!state.providerConfigured) throw new Error('AI-сервис не настроен. Добавьте OPENAI_API_KEY в .env.local и перезапустите приложение.');
    state.sessionId += 1;
    cancelCurrentTurn();
    clearConversation();
    state.history = [];
    setConnected(true);
    setStage('idle', 'Готов к разговору');
    composerHint.textContent = 'Запись отправляется после остановки. Микрофон работает только во время реплики.';
    createMessage('assistant', 'Разговор начат. Спросите о свободном времени — я сначала проверю расписание.');
  } catch (error) {
    showError(error.message || 'Не удалось подключиться к приложению. Повторите попытку.');
  } finally {
    state.starting = false;
    sessionButton.disabled = false;
  }
}

function finishSession() {
  const recorder = state.recorder;
  state.sessionId += 1;
  cancelCurrentTurn();
  if (recorder && recorder.state !== 'inactive') {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    try { recorder.stop(); } catch { /* Поток уже остановлен браузером. */ }
  }
  state.recorder = null;
  state.chunks = [];
  stopRecordingStream();
  recordButton.classList.remove('is-recording');
  recordButtonText.textContent = 'Начать запись реплики';
  setConnected(false);
  setStage('done', 'Разговор завершён');
  composerHint.textContent = 'Микрофон и воспроизведение остановлены. Новый разговор начнётся с чистой историей.';
  clearError();
}

function stopRecording(submit = true) {
  const recorder = state.recorder;
  if (!recorder || recorder.state === 'inactive') return;
  const sessionId = state.sessionId;
  const turnId = state.turnId;
  recordButton.classList.remove('is-recording');
  recordButtonText.textContent = 'Начать запись реплики';
  recordButton.disabled = !state.connected;
  if (submit) setStage('processing', 'Обрабатывает просьбу / проверяет расписание');
  recorder.onstop = () => {
    const blob = new Blob(state.chunks, { type: recorder.mimeType || 'audio/webm' });
    state.chunks = [];
    state.recorder = null;
    stopRecordingStream();
    if (submit && state.connected && sessionId === state.sessionId && turnId === state.turnId) {
      if (!blob.size) {
        showError('Запись пустая. Нажмите кнопку и произнесите реплику ещё раз.');
      } else {
        void processAudio(blob, recorder.mimeType || blob.type, sessionId, turnId);
      }
    } else if (state.connected) {
      setStage('idle', 'Готов к разговору');
    }
  };
  try { recorder.stop(); } catch { stopRecordingStream(); }
}

async function startRecording() {
  if (!state.connected) return;
  clearError();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showError('Браузер не поддерживает запись микрофона. Откройте приложение в современном браузере.');
    return;
  }

  // Нажатие записи во время ответа является перебиванием: старый звук и генерация отменяются.
  cancelCurrentTurn();
  const turnId = state.turnId + 1;
  state.turnId = turnId;
  const sessionId = state.sessionId;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (!state.connected || sessionId !== state.sessionId || turnId !== state.turnId) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const mimeType = getRecordingMimeType();
    if (!mimeType && MediaRecorder.isTypeSupported && !MediaRecorder.isTypeSupported('')) {
      for (const track of stream.getTracks()) track.stop();
      showError('Браузер не поддерживает формат записи. Попробуйте другой современный браузер.');
      return;
    }
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    state.recordingStream = stream;
    state.recorder = recorder;
    state.chunks = [];
    recorder.ondataavailable = (event) => { if (event.data?.size) state.chunks.push(event.data); };
    recorder.onerror = () => {
      stopRecordingStream();
      state.recorder = null;
      recordButton.classList.remove('is-recording');
      recordButtonText.textContent = 'Начать запись реплики';
      showError('Не удалось записать звук. Проверьте микрофон и попробуйте ещё раз.');
    };
    recorder.start(250);
    recordButton.classList.add('is-recording');
    recordButtonText.textContent = 'Остановить запись';
    recordButton.disabled = false;
    setStage('listening', 'Слушает пользователя');
    composerHint.textContent = 'Говорите после сигнала. Нажмите «Остановить запись», когда закончите.';
  } catch (error) {
    stopRecordingStream();
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      showError('Доступ к микрофону запрещён. Разрешите микрофон для localhost в настройках браузера и попробуйте ещё раз.');
    } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      showError('Микрофон не найден. Подключите микрофон и повторите попытку.');
    } else {
      showError('Не удалось начать запись. Проверьте микрофон и повторите попытку.');
    }
  }
}

async function processAudio(blob, mimeType, sessionId, turnId) {
  const controller = new AbortController();
  state.controller = controller;
  setStage('processing', 'Распознаёт речь / проверяет расписание');
  const userMessage = createMessage('user', 'Распознаю запись…', { pending: true });
  try {
    const transcription = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': (mimeType || blob.type || 'audio/webm').split(';', 1)[0] },
      body: blob,
      signal: controller.signal,
    });
    const transcribed = await transcription.json().catch(() => ({}));
    if (!transcription.ok) throw new Error(transcribed.error || 'Не удалось распознать запись. Повторите реплику.');
    if (sessionId !== state.sessionId || turnId !== state.turnId) return;
    const transcript = String(transcribed.transcript || '').trim();
    if (!transcript) throw new Error('Не удалось разобрать слова в записи. Попробуйте ещё раз.');
    userMessage.text.textContent = transcript;
    state.history.push({ role: 'user', content: transcript });
    setStage('processing', 'Обрабатывает просьбу / проверяет расписание');
    composerHint.textContent = 'Расшифровка готова. Проверяю расписание перед ответом.';

    const answerResponse = await fetch('/api/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, history: state.history.slice(0, -1) }),
      signal: controller.signal,
    });
    if (!answerResponse.ok) {
      const data = await answerResponse.json().catch(() => ({}));
      throw new Error(data.error || 'Не удалось получить ответ. Повторите реплику.');
    }
    if (!answerResponse.body) throw new Error('Браузер не поддерживает потоковый ответ. Повторите реплику в другом браузере.');

    let assistantText = '';
    let assistantMessage = null;
    let streamError = '';
    setStage('streaming', 'Готовит текстовый ответ');
    await readSse(answerResponse.body, (event, data) => {
      if (sessionId !== state.sessionId || turnId !== state.turnId) return;
      if (event === 'schedule') updateSchedule(data);
      if (event === 'delta' && typeof data.text === 'string') {
        assistantText += data.text;
        if (!assistantMessage) {
          assistantMessage = createMessage('assistant', '', { streaming: true });
          state.activeAssistantBody = assistantMessage.body;
          state.activeAssistantText = assistantMessage.text;
        }
        assistantMessage.text.textContent = assistantText;
        scrollConversation();
      }
      if (event === 'error') streamError = data.message || 'Ответ прервался. Повторите реплику.';
    });
    if (sessionId !== state.sessionId || turnId !== state.turnId) return;
    if (streamError) throw new Error(streamError);
    if (!assistantText.trim()) throw new Error('AI-сервис вернул пустой ответ. Повторите реплику.');
    assistantMessage?.text.classList.remove('is-streaming');
    state.activeAssistantBody = null;
    state.activeAssistantText = null;
    state.history.push({ role: 'assistant', content: assistantText });
    speakAnswer(assistantText);
  } catch (error) {
    if (error.name === 'AbortError' || sessionId !== state.sessionId || turnId !== state.turnId) return;
    if (userMessage.text.textContent === 'Распознаю запись…') userMessage.text.textContent = 'Запись не распознана';
    showError(error.message || 'Соединение прервалось. Повторите реплику.');
  } finally {
    if (state.controller === controller) state.controller = null;
  }
}

async function readSse(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  while (!ended) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let eventName = 'message';
      const data = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      try { onEvent(eventName, JSON.parse(data.join('\n'))); } catch { /* Пропускаем некорректный SSE-фрагмент. */ }
    }
    ended = done;
  }
}

function updateSchedule(result) {
  scheduleResult.hidden = false;
  const label = result.display_label || (result.day_offset === 2 ? 'Послезавтра' : result.day_offset === 1 ? 'Завтра' : 'Запрошенная дата');
  let text;
  if (result.status === 'no_data') {
    text = `Проверка: ${label}. Данных в учебном расписании нет.`;
  } else if (result.status === 'needs_clarification') {
    text = 'Не удалось определить дату. Помощник должен уточнить её.';
  } else if (result.requested_status === 'busy') {
    text = `${label}, ${result.requested_time} — занято. Проверены демонстрационные слоты.`;
  } else if (result.requested_status === 'available') {
    text = `${label}, ${result.requested_time} — свободно. Чтобы создать демонстрационную запись, подтвердите форму справа.`;
    bookingTime.value = result.requested_time;
  } else if (result.requested_status === 'not_listed') {
    text = `${label}, ${result.requested_time} не указан в демонстрационном расписании.`;
  } else {
    const available = (result.available_slots || []).join(', ') || 'подходящих свободных слотов в данных нет';
    const busy = (result.busy_slots || []).join(', ') || 'нет';
    text = `${label}: свободно ${available}; занято ${busy}.`;
  }
  scheduleResult.textContent = text;
}

function setBookingStatus(message, stateName = '') {
  bookingStatus.textContent = message;
  if (stateName) bookingStatus.dataset.state = stateName;
  else delete bookingStatus.dataset.state;
}

function formatBookingDate(dateValue) {
  const date = new Date(`${dateValue}T12:00:00`);
  if (Number.isNaN(date.valueOf())) return dateValue;
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(date);
}

function renderDemoData(data) {
  const bookings = Array.isArray(data.bookings) ? data.bookings : [];
  const slots = Array.isArray(data.slots) ? data.slots : [];
  bookingCount.textContent = String(bookings.length);

  for (const slot of slots) {
    const suffix = slot.time === '18:30' ? '1830' : slot.time === '19:00' ? '1900' : '';
    if (!suffix) continue;
    const row = document.querySelector(`[data-slot="tomorrow-${suffix}"]`);
    const status = row?.querySelector('.slot-status');
    if (!status) continue;
    const free = slot.status === 'available';
    status.textContent = free ? 'Свободно' : 'Занято';
    status.classList.toggle('is-free', free);
    status.classList.toggle('is-busy', !free);
  }

  const previousTime = bookingTime.value;
  bookingTime.replaceChildren(new Option('Выберите свободное время', ''));
  for (const slot of slots) {
    const option = new Option(`${slot.time} · ${slot.status === 'available' ? 'свободно' : 'занято'}`, slot.time);
    option.disabled = slot.status !== 'available';
    bookingTime.add(option);
  }
  if (slots.some((slot) => slot.time === previousTime && slot.status === 'available')) bookingTime.value = previousTime;
  bookingSubmit.disabled = !slots.some((slot) => slot.status === 'available');

  bookingsList.replaceChildren();
  if (!bookings.length) {
    const empty = document.createElement('li');
    empty.className = 'booking-empty';
    empty.textContent = 'Пока нет демонстрационных записей.';
    bookingsList.append(empty);
    return;
  }

  for (const booking of bookings) {
    const item = document.createElement('li');
    item.className = 'booking-item';
    const detail = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = booking.clientName;
    const when = document.createElement('span');
    when.textContent = `${formatBookingDate(booking.date)}, ${booking.time}`;
    detail.append(name, when);
    const cancel = document.createElement('button');
    cancel.className = 'booking-cancel';
    cancel.type = 'button';
    cancel.dataset.bookingId = booking.id;
    cancel.textContent = 'Отменить';
    cancel.setAttribute('aria-label', `Отменить запись: ${booking.clientName}`);
    item.append(detail, cancel);
    bookingsList.append(item);
  }
}

async function loadDemoData() {
  try {
    const response = await fetch('/api/bookings', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Не удалось загрузить список записей.');
    renderDemoData(data);
  } catch (error) {
    setBookingStatus(error.message || 'Не удалось загрузить список записей.', 'error');
  }
}

function speakAnswer(text) {
  state.currentAnswer = text;
  playbackPanel.hidden = false;
  playbackProgress.style.width = '0%';
  playbackLabel.textContent = 'Воспроизводит ответ';
  if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) {
    setStage('error', 'Ошибка / соединение прервано');
    showError('В этом браузере нет синтеза речи. Текст ответа сохранён; откройте приложение в браузере с поддержкой озвучивания.');
    return;
  }
  stopCurrentAudio();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ru-RU';
  utterance.rate = 1;
  const voices = window.speechSynthesis.getVoices();
  utterance.voice = voices.find((voice) => voice.lang.toLowerCase().startsWith('ru')) || null;
  state.currentSpeech = utterance;
  utterance.onstart = () => {
    setStage('speaking', 'Воспроизводит ответ');
    playbackLabel.textContent = 'Воспроизводит ответ';
    const startedAt = Date.now();
    const estimatedMs = Math.max(2_500, text.length * 72);
    clearInterval(state.speechProgressTimer);
    state.speechProgressTimer = setInterval(() => {
      const progress = Math.min(94, ((Date.now() - startedAt) / estimatedMs) * 100);
      playbackProgress.style.width = `${progress}%`;
    }, 180);
  };
  utterance.onboundary = (event) => {
    if (event.charIndex && text.length) playbackProgress.style.width = `${Math.min(96, event.charIndex / text.length * 100)}%`;
  };
  utterance.onend = () => {
    if (state.currentSpeech !== utterance) return;
    clearInterval(state.speechProgressTimer);
    state.speechProgressTimer = null;
    state.currentSpeech = null;
    playbackProgress.style.width = '100%';
    playbackLabel.textContent = 'Ответ завершён';
    setStage('idle', 'Готов к следующей реплике');
  };
  utterance.onerror = (event) => {
    if (event.error === 'canceled' || event.error === 'interrupted') return;
    clearInterval(state.speechProgressTimer);
    state.speechProgressTimer = null;
    state.currentSpeech = null;
    playbackLabel.textContent = 'Не удалось озвучить ответ';
    setStage('error', 'Ошибка / соединение прервано');
    errorMessage.textContent = 'Текст ответа доступен. Проверьте настройки голосового синтезатора устройства.';
    errorMessage.hidden = false;
  };
  window.speechSynthesis.speak(utterance);
}

function stopSpeech() {
  if (!state.currentSpeech) return;
  stopCurrentAudio();
  playbackLabel.textContent = 'Воспроизведение остановлено';
  setStage(state.connected ? 'idle' : 'done', state.connected ? 'Готов к следующей реплике' : 'Разговор завершён');
}

function showView(view) {
  const isDialog = view === 'dialog';
  document.querySelector('[data-panel="dialog"]').hidden = !isDialog;
  document.querySelector('[data-panel="flow"]').hidden = isDialog;
  for (const button of document.querySelectorAll('.nav-item[data-view]')) {
    const active = button.dataset.view === view;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (isDialog) scrollConversation();
}

sessionButton.addEventListener('click', () => {
  if (state.connected) finishSession();
  else void startSession();
});

recordButton.addEventListener('click', () => {
  if (state.recorder?.state === 'recording') stopRecording(true);
  else void startRecording();
});

$('#stopSpeechButton').addEventListener('click', stopSpeech);
$('#replayButton').addEventListener('click', () => {
  if (state.currentAnswer && state.connected) speakAnswer(state.currentAnswer);
});
clearButton.addEventListener('click', () => {
  if (!state.connected) return;
  cancelCurrentTurn();
  clearConversation();
  setStage('idle', 'Готов к разговору');
});

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => showView(button.dataset.view));
}

bookingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!bookingForm.reportValidity()) return;
  bookingSubmit.disabled = true;
  setBookingStatus('Сохраняю демонстрационную запись…');
  try {
    const response = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: bookingName.value,
        time: bookingTime.value,
        confirmed: bookingConfirmed.checked,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Не удалось сохранить запись.');
    renderDemoData(data);
    bookingForm.reset();
    setBookingStatus('Демонстрационная запись добавлена в список.', 'success');
  } catch (error) {
    setBookingStatus(error.message || 'Не удалось сохранить запись.', 'error');
    await loadDemoData();
  } finally {
    bookingSubmit.disabled = !bookingTime.querySelector('option:not(:disabled)[value]:not([value=""])');
  }
});

bookingsList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-booking-id]');
  if (!button || !window.confirm('Отменить эту демонстрационную запись?')) return;
  button.disabled = true;
  setBookingStatus('Отменяю запись…');
  try {
    const response = await fetch(`/api/bookings/${encodeURIComponent(button.dataset.bookingId)}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Не удалось отменить запись.');
    renderDemoData(data);
    setBookingStatus('Демонстрационная запись отменена.', 'success');
  } catch (error) {
    setBookingStatus(error.message || 'Не удалось отменить запись.', 'error');
    await loadDemoData();
  }
});

window.addEventListener('beforeunload', () => {
  state.sessionId += 1;
  cancelCurrentTurn();
  if (state.recorder && state.recorder.state !== 'inactive') {
    try { state.recorder.stop(); } catch { /* Выход со страницы закрывает поток. */ }
  }
  stopRecordingStream();
});

fetch('/api/health', { cache: 'no-store' })
  .then((response) => response.json())
  .then((health) => {
    state.providerConfigured = Boolean(health.providerConfigured);
    if (!state.providerConfigured) composerHint.textContent = 'Для распознавания и ответа настройте OPENAI_API_KEY в .env.local.';
  })
  .catch(() => { composerHint.textContent = 'Сервер не отвечает. Запустите приложение командой npm start.'; });

void loadDemoData();
