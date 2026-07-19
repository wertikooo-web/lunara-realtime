# ESP32 Realtime Protocol — аудит и спецификация

Дата аудита: 2026-07-13. Обновлено: 2026-07-19 (исходящие `audio.chunk` ограничены 2048 байтами PCM, чтобы полный JSON помещался в приёмный буфер ESP32 размером 4 КБ).

Источники истины (только код, ничего не выдумано):
- `src/realtime/wsProtocol.js` — свой минимальный WebSocket-сервер (ручная реализация RFC6455, без сторонних библиотек).
- `src/realtime/realtimeServer.js` — вся lifecycle-логика, все исходящие/входящие сообщения.
- `src/realtime/geminiLiveProvider.js` — маппинг на Gemini Live API, реальный формат аудио.
- `src/realtime/mockRealtimeProvider.js` — mock-провайдер (используется локально/в smoke-тестах, НЕ на проде).
- `public/lab.html` — единственный существующий клиент (Browser Lab).
- Реальные production-логи (`railway logs`, сервис `lunara-realtime`, провайдер `gemini`, снято 2026-07-13).

Код в рамках этого аудита не менялся.

---

## Protocol V2 (2026-07-14) — единый режим 24 кГц на устройстве

Версия протокола изменилась с V1. Причина: кодек ESP32 подключён к микрофону и динамику через один общий I2S-интерфейс на одной частоте семплирования — нельзя задать разные частоты для записи и воспроизведения на одном кодеке. Поэтому вместо асимметричного 16/24 на устройстве теперь единый режим 24/24, а ресемплинг входа 24→16кГц для Gemini выполняет **сервер**, потоково.

- **Вход (ESP32 → сервер):** PCM16LE, **16000 Hz или 24000 Hz** (оба поддерживаются), mono, без обёртки, **binary WebSocket frame** (opcode `0x2`). Для ESP32 в режиме 24/24 — 24000 Hz.
- **Обязательное поле в `session.start`:** `sampleRate: 24000` (или `sample_rate: 24000`) определяет, нужен ли ресемплинг. Если поле не передано вовсе — сервер по умолчанию считает вход 16000Hz (pass-through, обратная совместимость со старыми клиентами) и **явно** сообщает об этом в `session.config.applied.input_audio` (не тихое предположение, см. раздел 4.1). Если поле передано, но значение не 16000 и не 24000 — сервер **отклоняет** `session.start` явной ошибкой `unsupported_input_sample_rate`, а не угадывает коэффициент ресемплинга.
- **Точка ресемплинга — прямо в основном realtime pipeline, без preload/monkey-patch слоя.** Валидация частоты (`resolveInputSampleRate()`) и создание ресемплера (`createInputResampler()`) — в `src/realtime/inputAudioResampling.js`, вызывается напрямую из `src/realtime/realtimeServer.js` в обработчике `session.start`. Сам ресемплинг чанков — в обработчике входящих binary WS-фреймов (`onBinary`) того же файла, перед `providerSession.sendAudio()`. DSP-ядро (FIR-фильтр 47 тапов + линейная интерполяция) — в `src/realtime/pcm16Resampler.js`. Состояние ресемплера привязано к одному turn'у: сбрасывается на `input_audio.start` (`startInput()`), полностью сливается (`flush()`) и затем сбрасывается на `input_audio.end` (`endInput()`), сбрасывается на `session.interrupt` и на ошибке декодирования (все точки — прямо в `realtimeServer.js`, не в отдельном скрытом модуле).
- **Выход (сервер → ESP32):** PCM16LE, 24000 Hz, mono, внутри `audio.chunk` как `audio_base64` (Base64), **JSON-фрейм** (opcode `0x1`), НЕ binary frame. Сервер делит крупные ответы Gemini на фрагменты не более 2048 байт PCM каждый, не меняя JSON-схему.
- **Почему выход у Gemini всегда 24kHz** — это НЕ решение этого сервера, а жёсткое ограничение Gemini Live API. Официальная документация Google (`ai.google.dev/gemini-api/docs/live-guide`): *"Input audio is natively 16kHz... Audio output always uses a sample rate of 24kHz."* Раньше это создавало асимметрию 16/24 и на самом устройстве; теперь сервер сам сглаживает эту асимметрию ресемплингом входа, и ESP32 может работать в едином режиме 24/24 на обоих направлениях кодека.
- Совместимость: старые клиенты (Browser Lab, mock), которые не шлют `sampleRate` или шлют `16000`, продолжают работать как раньше — сервер просто пропускает вход без ресемплинга (byte-identical pass-through), поведение не изменилось.

---

## 1. WebSocket endpoint

- **Production URL:** `wss://lunara-realtime-production.up.railway.app/realtime`
- **Локальный URL:** `ws://localhost:3100/realtime` (порт из `PORT`, по умолчанию 3100 — `.env.example:1`, `src/server.js:18`)
- **Протокол:** `wss` на проде (Railway терминирует TLS), `ws` локально. Определяется клиентом по `location.protocol` в `lab.html:477-480` — сам сервер не проверяет схему.
- **Путь:** только `/realtime` принимается на upgrade; всё остальное — `404 Not Found` и закрытие сокета (`src/realtime/realtimeServer.js:154-160`).
- **Query-параметры / headers:** **не требуются и не проверяются**. `acceptWebSocket()` проверяет только обязательный по спецификации WebSocket header `Sec-WebSocket-Key` (`src/realtime/wsProtocol.js:7-12`) — это не авторизация, а часть стандартного WS handshake.
- **Авторизация: отсутствует.** Нет токена, нет API-ключа, нет проверки Origin. Любой клиент, знающий URL, может подключиться и открыть сессию. Это осознанный факт текущего состояния кода, не предположение.
  - **Решение (2026-07-13, от пользователя):** пока в проекте один экземпляр устройства — не критично. На следующем этапе, при переходе к нескольким физическим ESP32-устройствам, авторизацию делать через поля **Device ID + PIN** (эта же схема уже использовалась в старом проекте `lunara-toy-server` — `modules/parentConfig.js`, `hashPin()`/`DEFAULT_PARENT_PIN`). Не реализовано в текущем коде `lunara-realtime` — только зафиксировано как согласованное направление, реализация в разделе 14 п.1 переносится из "открытый вопрос" в "решённое направление, ждёт реализации".
- **deviceId:** `lab.html` отправляет `deviceId: 'browser-lab'` в теле `session.start` (не как query-параметр и не как header) — `public/lab.html:699`. Сервер читает это поле (`src/realtime/realtimeServer.js:1249-1251`) и использует его для подтягивания памяти/настроек из Postgres, если `REALTIME_MEMORY_ENABLED=true`. Если поле не передано — используется дефолт `browser-lab` (`memoryStore.normalizeDeviceId()` без аргумента, `src/realtime/realtimeServer.js:206`; дефолт задан в `src/memory/store.js`).

---

## 2. Формат исходящего аудио (клиент → сервер, PTT input)

Единственный источник истины для формата — то, что реально понимает провайдер (`geminiLiveProvider.js`) и то, что реально шлёт `lab.html`.

| Параметр | Значение | Источник |
|---|---|---|
| Кодек | PCM, без сжатия | `INPUT_MIME_TYPE = 'audio/pcm;rate=16000'` — `src/realtime/geminiLiveProvider.js:7` |
| Sample rate | **16000 Hz** | `INPUT_SAMPLE_RATE = 16000` — `geminiLiveProvider.js:8`; клиент создаёт `AudioContext({ sampleRate: 16000 })` — `lab.html:767` |
| Bits per sample | 16 bit signed | `floatToPcm16()` использует `DataView.setInt16` — `lab.html:794-802` |
| Channels | 1 (моно) | `getUserMedia` без явного `channelCount`, `AudioContext` создан с 1 каналом через `createScriptProcessor(2048, 1, 1)` — `lab.html:769` |
| Порядок байт | **little-endian** | `view.setInt16(index * 2, ..., true)` — третий аргумент `true` = little-endian, `lab.html:799`; сервер декодирует так же (`view.getInt16(index * 2, true)`, `lab.html:1163`, симметрично) |
| Размер фрейма (реально наблюдаемый) | **4096 байт** = 2048 сэмплов × 2 байта | Реальный production-лог: `stage=input_audio_frame ... bytes=4096` (десятки одинаковых строк подряд, снято 2026-07-13); объясняется `ScriptProcessorNode(2048, 1, 1)` в `lab.html:769` — буфер на 2048 сэмплов, `onaudioprocess` файрится каждый раз с этим объёмом |
| Допустимая длительность фрейма | 2048 сэмплов / 16000 Hz = **128 мс** на фрейм (для наблюдаемого размера). Жёсткого ограничения на размер фрейма в коде сервера нет — сервер просто накапливает байты через `onBinary` (`src/realtime/realtimeServer.js:1327-1371`) | — |
| Транспорт | **Binary WebSocket frame** (opcode `0x2`), НЕ JSON/base64 | `ws.send(frame)` с `ArrayBuffer` — `lab.html:774`; сервер: `onBinary(payload)` — `wsProtocol.js:95-96`, `realtimeServer.js:1327` |

Важно: сервер **не проверяет** длину/валидность входящего PCM на входе (никакой проверки чётности длины или диапазона значений для входящего аудио нет — в отличие от исходящего, см. раздел 6). Единственная серверная проверка на входе — есть ли активный turn (см. раздел 10).

**Важно для ESP32 (Protocol V2):** таблица выше описывает формат, который в итоге видит Gemini Live (16000 Hz) — это то, что шлёт Browser Lab напрямую, и то, во что сервер приводит вход перед отправкой в Gemini. ESP32 сам по себе шлёт **24000 Hz** (см. врез Protocol V2 в начале документа) — сервер ресемплирует 24→16 незаметно для этой части протокола, транспорт/порядок байт/binary-frame не меняются, меняется только исходная частота на стороне ESP32 и обязательность поля `sampleRate: 24000` в `session.start`.

---

## 3. Полный lifecycle PTT (по коду `lab.html` + `realtimeServer.js`)

Пронумеровано по фактической последовательности событий:

1. **Подключение** — клиент открывает `wss://.../realtime`. `lab.html:689-733`.
2. **Готовность** — сразу после `open`, клиент шлёт `session.start` (см. раздел 4.1). `lab.html:695-705`.
3. Сервер отвечает `session.ready` **немедленно при подключении**, ещё до обработки `session.start` (`realtimeServer.js:1399-1408` — это последняя строка внутри `createRealtimeSession`, выполняется синхронно на коннект). Обработка `session.start` асинхронна (`realtimeServer.js:1252-1299`) и присылает отдельно `session.config.applied`, когда готово.
4. **Нажатие кнопки (pointerdown)** — клиент коннектится, если ещё не подключён (`onPointerDown`, `lab.html:1273-1298`); иначе стартует turn.
5. **Начало audio activity** — клиент шлёт `input_audio.start` (раздел 4.2), сервер эхо-подтверждает `input_audio.start` с реальными `generation_id`/`turn_id` (`realtimeServer.js:1125-1130`) и инициирует `beginResponse` на провайдере, который для Gemini посылает `activityStart` (manual activity marker, НЕ автоматический VAD — см. раздел 9) при первом реальном аудио-байте (`geminiLiveProvider.js:475-484`).
6. **Поток PCM** — клиент шлёт бинарные фреймы, сервер пересылает их в Gemini как есть (`sendAudioNow`, `geminiLiveProvider.js:464-473`).
7. **Отпускание кнопки (pointerup)** — клиент шлёт `input_audio.end` (раздел 4.3).
8. **Завершение activity** — сервер отправляет "silence tail" — 300 мс тишины (15 фреймов по 20 мс, PCM нули) — *после* `input_audio.end`, затем шлёт Gemini `activityEnd` (`geminiLiveProvider.js:558-621`, реальный лог: `silence_tail_started ... configuredDurationMs=300 frameCount=15`). Это существующий костыль: Gemini не понимает конец хода по паузе в потоке при удержанной кнопке, нужен явный маркер после явной тишины.
9. **Ожидание ответа** — сервер эмитит `response.created`, когда провайдер выдаёт первое событие вывода (`emitResponseCreated`, `realtimeServer.js:859-878`, вызывается из `emitProviderEvent` на `transcript.model`/`audio.start`/`audio.chunk`).
10. **Поток аудио ответа** — `audio.start` → серия `audio.chunk` → `audio.end` (раздел 5, детали формата в разделе 6).
11. **Завершение ответа** — `audio.end`; если `rotationMode === 'per_turn'` (дефолт), сессия с провайдером **пересоздаётся** после каждого хода (`shouldRotateProviderAfterOutputComplete`, `realtimeServer.js:1094-1096`, вызов `rotateProviderSession` на `audio.end`, `realtimeServer.js:965-974`).
12. **Возврат в idle** — клиентская state machine (в `lab.html`, не в протоколе) переходит в `IDLE`, когда `playbackQueue` и `activeSources` пусты (`lab.html:1191-1193`).

### Когда ESP32 может безопасно начинать первую запись

Важное уточнение, отсутствовавшее в первой версии этого документа. `provider.ready` **не гарантирован на первом подключении вообще**: он эмитится только внутри `warmProviderSession()` (`realtimeServer.js:656-704`), а этот вызов происходит только при: восстановлении после таймаута хода (`recoverFromTurnTimeout`), восстановлении после сбоя провайдера (`recoverFromProviderFailure`), подтверждённой смене языка (`applyPendingLanguageSwitchBeforeInput`) и после ротации сразу за `audio.end`. В обработчике `session.start` (`realtimeServer.js:1307-1308`) вызывается только `rotateProviderSession()` + `emitPromptApplied()` — `warmProviderSession()` там **не вызывается**. Значит на первом коннекте `provider.ready` может вообще не прийти до первого хода — **ждать его для разрешения записи нельзя, ESP32 повиснет**.

Реальный порядок готовности: `session.ready` приходит сразу и всегда. `session.config.applied` — после асинхронной обработки `session.start`, когда voice/prompt/childContext/parentRules из БД уже применены к живой provider-сессии (`realtimeServer.js:1281-1308`). Само соединение с Gemini устанавливается лениво, при первом реальном аудио, внутри `beginResponse()` (`geminiLiveProvider.js:648-674`) — это никак не сигнализируется отдельным событием на первом ходу.

`lab.html` сам переходит в `IDLE` (разрешает нажатие PTT) сразу на `session.ready`, **не дожидаясь** `session.config.applied` (`lab.html:1009-1011`) — это гонка в эталонном клиенте: теоретически первый ход может уйти до того, как персонализация (голос/промт/память) из БД подтянулась и была применена к provider-сессии.

**Рекомендация для ESP32 (вывод из кода, не установленное поведение lab.html):** дожидаться `session.config.applied`, а не `session.ready` и не `provider.ready`, прежде чем разрешать первое нажатие PTT. Для последующих ходов в рамках уже установленной сессии этого ждать не нужно — персонализация применяется один раз при `session.start`.

---

## 4. JSON-пакеты ESP32 → server

Формат — TEXT WebSocket frame (opcode `0x1`) с JSON внутри (`wsProtocol.js:116-120`). Разбор входящих на сервере: `handleCommand()`, `realtimeServer.js:1224-1323`.

### 4.1 `session.start`

- **Обязательные поля (по факту, что сервер реально читает):** нет строго обязательных — `payload.type === 'session.start'` достаточно.
- **Необязательные поля, которые сервер читает:**
  - `deviceId` (string) — используется для подтягивания памяти/настроек, только если `REALTIME_MEMORY_ENABLED=true` (`realtimeServer.js:1249-1251, 1264-1281`).
  - `config` (object) — `core_prompt`/`corePrompt`, `child_context`/`childContext`, `parent_rules`/`parentRules` (`src/realtime/realtimePrompt.js:182-189`). **Работает только если `LAB_ALLOW_CUSTOM_PROMPT=true`** на сервере (env-флаг, по умолчанию `false` — `realtimePrompt.js:6`); иначе `config` полностью игнорируется и берутся дефолты/данные из БД.
  - `sampleRate` / `sample_rate` (number, `16000` или `24000`) — **начиная с Protocol V2 это больше не мёртвое поле, и не может быть тихо проигнорировано.** Читается прямо в `realtimeServer.js` (`session.start` handler → `resolveInputSampleRate()` в `src/realtime/inputAudioResampling.js`) и настраивает потоковый ресемплинг входа для этого соединения. Три исхода: (1) значение `16000` или `24000` — используется явно; (2) поле отсутствует — сервер **по умолчанию** считает вход 16000Hz для обратной совместимости, но это явно видно в ответе `session.config.applied.input_audio.sample_rate_source: "assumed_default_no_sample_rate"`, а не тихая догадка; (3) любое другое значение — `session.start` **отклоняется** ошибкой `unsupported_input_sample_rate`, сервер не пытается угадать коэффициент ресемплинга. Для ESP32 в режиме 24/24 это поле обязательно передавать со значением `24000`.
- **Поля, которые клиент шлёт, но сервер НЕ читает вообще (мёртвые поля):** `lang`, `codec` (`lab.html:700-702`) — в `handleCommand` нет ни одного обращения к `payload.lang`/`payload.codec`. ESP32 может их не отправлять.

**Минимальный `session.start` для ESP32** (Protocol V2 — `sampleRate` теперь обязателен, иначе сервер не будет ресемплировать 24kHz-вход и звук на входе Gemini будет испорчен, см. врез Protocol V2 и раздел 4.1 выше):
```json
{ "type": "session.start", "deviceId": "esp32-<серийник устройства>", "sampleRate": 24000 }
```

- **Полный пример JSON от Browser Lab** (как реально шлёт `lab.html:696-704`, шлёт `sampleRate: 16000` — свой родной формат, не ESP32-специфика; `lang`/`codec`/`config` ESP32 слать не обязан):
```json
{
  "type": "session.start",
  "deviceId": "browser-lab",
  "lang": "ru-RU",
  "codec": "pcm16",
  "sampleRate": 16000,
  "config": { "core_prompt": "", "child_context": "", "parent_rules": "" }
}
```
- **Когда отправляется:** сразу после открытия сокета (`lab.html:695-705`); также при `applyPromptByReconnect()` — переподключение после смены prompt-конфига (только в lab, не относится к ESP32).
- **Что делает сервер:** если уже идёт активный ход — отклоняет с ошибкой `session_config_busy` (см. ниже). Иначе асинхронно собирает промпт-блоки, при необходимости подтягивает БД, затем **пересоздаёт provider-сессию** (`rotateProviderSession('session_start_config')`, `realtimeServer.js:1307`) и шлёт `session.config.applied`.
- **Возможные ошибки:** `session_config_busy` (если есть активная генерация в нетерминальном статусе, `realtimeServer.js:1238-1248`); `prompt_config_invalid` (если `config`-текст превышает лимит символов, `realtimeServer.js:1285-1298`).

### 4.2 `input_audio.start`

- **Обязательные поля:** нет строго обязательных.
- **Поля, которые сервер читает:** `turn_id` (string, если не передан — сервер генерирует сам, `id('turn'+turnCounter)`, `realtimeServer.js:1117`), `mode` (по умолчанию `'push_to_talk'`, `realtimeServer.js:1119`).
- **Поле, которое клиент шлёт, но сервер НЕ читает:** `client_generation_id` (`lab.html:844`) — используется только клиентом локально, сервер игнорирует.
- **Пример JSON** (`lab.html:840-845`):
```json
{ "type": "input_audio.start", "turn_id": "trn_abc123", "mode": "push_to_talk", "client_generation_id": "gen_client_xyz" }
```
- **Когда отправляется:** на pointerdown / нажатие PTT-кнопки.
- **Что делает сервер:** отменяет текущий незавершённый ход, если был (`cancelCurrent('new_input')`, `realtimeServer.js:1112`); создаёт новую generation; эхо-шлёт `input_audio.start` клиенту с реальными ID (раздел 5).
- **Возможные ошибки:** нет прямой валидации входа; если это первое сообщение без предварительного коннекта — соединения ещё не будет, ошибка невозможна на уровне протокола.

### 4.3 `input_audio.end`

- **Обязательные поля:** нет.
- **Поля, которые сервер читает:** `end_reason` (string, опционально; в `lab.html` бывает `pointerup`, `pointercancel`, `window_blur`, `visibility_hidden`, `manual_interrupt` — `lab.html:1256, 1319, 1327`; ESP32 может слать любое осмысленное значение, сервер просто передаёт его в лог/эхо, не валидирует по списку).
- **Пример JSON** (`lab.html:875-878`):
```json
{ "type": "input_audio.end", "end_reason": "pointerup" }
```
- **Когда отправляется:** на pointerup / отпускание PTT-кнопки.
- **Что делает сервер:** если `input_audio.start` не было — отвечает ошибкой `input_not_started` (`realtimeServer.js:1165-1173`). Иначе эхо-шлёт `input_audio.end` с реальной длительностью и байтами, запускает таймаут ожидания ответа (`armPttTurnTimeout`, дефолт 4500 мс — `realtimeServer.js:614`), вызывает `providerSession.endInput()`.
- **Возможные ошибки:** `input_not_started` (`code`, `realtimeServer.js:1168-1170`); `provider_error` асинхронно, если у провайдера сбой (`realtimeServer.js:1207-1221`).

### 4.4 `session.interrupt`

- **Обязательные поля:** нет.
- **Поля, которые сервер читает:** `reason` (по умолчанию `'client_interrupt'`, `realtimeServer.js:1306`).
- **Поле, которое клиент шлёт, но сервер НЕ читает:** `client_time_ms` (`lab.html:908`).
- **Пример JSON** (`lab.html:905-909`):
```json
{ "type": "session.interrupt", "reason": "manual_ptt_interrupt", "client_time_ms": 1731234567890 }
```
- **Когда отправляется:** ручное прерывание — в `lab.html` это происходит при новом pointerdown во время состояния `PLAYING` (`manualInterrupt()`, вызывается из `startTurn`, `lab.html:813-815`).
- **Что делает сервер:** отменяет текущую generation, шлёт провайдеру `interrupt()`, эмитит клиенту `response.cancelled` (раздел 5). Точный порядок и вопрос "ждать ли `response.cancelled`" — раздел 8.
- **Возможные ошибки:** нет — если активной генерации нет, `cancelCurrent` просто возвращает `false` и ничего не происходит (`realtimeServer.js:990-996`).

### 4.5 `ping`

- **Поля:** `timestamp_ms` (опционально, эхо возвращается в `pong`).
- **Пример:** `{ "type": "ping", "timestamp_ms": 1731234567890 }`
- **Когда отправляется:** решает клиент (в `lab.html` не используется вообще — нет вызова `ping` нигде в файле; это чисто серверная возможность, доступная, но не задействованная текущим клиентом).
- **Что делает сервер:** отвечает `pong` с тем же `timestamp_ms` (`realtimeServer.js:1311-1315`). Это JSON-уровневый heartbeat, отдельный от стандартного WS ping/pong — подробности в разделе 9.

### Неизвестный `type`

Любой другой `payload.type` → сервер отвечает `{ type: 'error', code: 'unknown_command', message: 'Unknown command type: ...' }` (`realtimeServer.js:1316-1321`).

### Невалидный JSON

Если TEXT-фрейм не парсится как JSON → `{ type: 'error', code: 'invalid_json', message: 'Invalid JSON command' }` (`realtimeServer.js:1226-1234`).

---

## 5. JSON-пакеты server → ESP32

Каждое сообщение сервер оборачивает так: `{ session_id, server_time_ms, ...payload }` (`emit()`, `realtimeServer.js:266-276`) — то есть `session_id` и `server_time_ms` присутствуют **во всех** серверных сообщениях дополнительно к перечисленным ниже полям.

| type | Ключевые поля | Когда шлётся | Реакция прошивки (по аналогии с lab.html) |
|---|---|---|---|
| `session.ready` | `session_id`, `provider`, `provider_instance_id`, `rotation_mode`, `model`, `config`, `lab_prompt` (всегда лёгкий, без исключений — см. врез ниже) | Сразу на коннект (`realtimeServer.js:1399-1408`) | Держать кнопку заблокированной до `session.config.applied` (см. раздел 3) |
| `session.config.applied` | `reason`, `prompt_source`, `input_audio`, `device.volume_level`, `lab_prompt.{allow_custom_prompt,max_chars,current_context,meta}` (лёгкий по умолчанию, см. врез ниже) | После обработки `session.start` (`realtimeServer.js:446-473`) | **Разблокировать PTT-кнопку здесь**, не на `session.ready` — персонализация (голос/промт/память) уже применена |

**Критично для ESP32 — размер пакетов (найдено 2026-07-17 при разборе реального сбоя на устройстве):** `lab_prompt` в обоих событиях **по умолчанию лёгкий** (~сотни байт), но раньше был не лёгким — `session.ready.lab_prompt.defaults` и `session.config.applied.lab_prompt.applied_blocks` содержали **полный текст промта** (core_prompt/child_context/parent_rules) — совокупно **~23.5-23.8 КБ на пакет**, против ~640 байт у `provider.rotated`. Это ровно то, из-за чего у инженера на реальном ESP32 приходил только `provider.rotated`, а `session.ready` и `session.config.applied` пропадали без единой строки в логе целиком: у embedded WebSocket-библиотек (arduinoWebSockets, esp_websocket_client и т.п.) буфер приёма обычно 1-4 КБ по умолчанию — 23-килобайтный фрейм тихо режется или отбрасывается целиком, ошибка при этом никуда не логируется.

**Исправлено в протоколе**: `session.config.applied.lab_prompt.applied_blocks` (полный текст промта) теперь передаётся **только если клиент явно попросил** — новое поле `include_prompt_debug: true` в `session.start`. Без этого поля (или при `false`) пакет остаётся лёгким для любого клиента, включая ESP32 — **ничего специально делать на стороне ESP32 не нужно, поле просто не отправлять**.

`session.ready.lab_prompt.defaults` убран **безусловно, для всех клиентов, включая Lab** — не по флагу. Причина: `session.ready` шлётся сразу при подключении сокета, **до** того как клиент вообще успел отправить `session.start` — на этот момент сервер физически не может знать про `include_prompt_debug` из ещё не полученного сообщения. `lab.html` не пострадал: полный дефолтный текст промта он и раньше в основном брал из отдельного `GET /lab-config` при загрузке страницы, а обработчик `session.ready` в `lab.html` уже был написан с фолбэком (`payload.lab_prompt.defaults || labPrompt.defaults` — сохраняет то, что уже загружено, если в событии пусто), так что регрессии нет.

`lab.html` — единственный клиент, которому нужен полный текст (для текстовых полей CORE/CHILD/PARENT в отладочной панели), поэтому он теперь явно шлёт `include_prompt_debug: true` в `session.start` (`lab.html:888`), что отражается только в `session.config.applied`. Реализация: `promptDebugRequested` в `realtimeServer.js` (читается из `session.start`, по умолчанию `false` — никогда не тихое предположение "true").
| `input_audio.start` | `turn_id`, `generation_id`, `response_id: null` | Эхо на клиентский `input_audio.start`, с реальными ID (`realtimeServer.js:1125-1130`) | Обновить текущие ID (`lab.html:995-997`) |
| `input_audio.end` | `turn_id`, `generation_id`, `response_id`, `duration_ms`, `turn_input_bytes`, `session_input_bytes`, `end_reason` | Эхо на клиентский `input_audio.end` (`realtimeServer.js:1181-1190`) | Информационное |
| `response.created` | `generation_id`, `response_id`, `turn_id`, `cause`, `turn_input_bytes`, `session_input_bytes` | Когда провайдер начал отвечать (`realtimeServer.js:869-877`) | Переход в WAITING→получен первый признак ответа |
| `transcript.user` | `text`, `generation_id`, `response_id`, `turn_id` | STT-фрагмент пользовательской реплики от Gemini, **инкрементальными кусками, не финальной строкой** (см. раздел 6 про накопление) | `lab.html` просто показывает последний фрагмент как текст (`lab.html:1012-1019`) — **не готовый механизм для финального текста** |
| `transcript.model` | `text`, ... | Фрагмент текстовой транскрипции ответа модели | Аналогично, инкрементально |
| `audio.start` | `format: 'audio/pcm'`, `sample_rate: 24000`, `elapsed_ms`, `provider_instance_id`, `turn_input_bytes`, `session_input_bytes` | Первый валидный аудио-байт ответа (`geminiLiveProvider.js:929-942`) | Начать буферизацию/подготовку плеера, LED → speaking |
| `audio.chunk` | `chunk_index`, `mime_type: 'audio/pcm'`, `sample_rate: 24000`, `audio_base64`, `elapsed_ms` | Каждый чанк аудио ответа; не более **2048 байт декодированного PCM** (~2732 символа Base64, полный JSON около 3 КБ) | Декодировать и проигрывать строго по `chunk_index` |
| `audio.end` | `elapsed_ms`, `cause` (`'generationComplete'` или `'turnComplete'`) | Конец аудио-ответа (`geminiLiveProvider.js:1054-1089`) | Доиграть очередь, вернуться в IDLE, LED → idle |
| `response.cancelled` | `generation_id`, `response_id`, `turn_id`, `reason`, `cancel_latency_ms` | При `session.interrupt` (`realtimeServer.js:1009-1016`) | Информационное подтверждение постфактум — **не блокирует** начало нового хода, см. раздел 8 |
| `response.failed` | `generation_id`, `response_id`, `turn_id`, `reason` | Таймаут (`realtimeServer.js:723-730`), сбой провайдера (`realtimeServer.js:766-773`), внутренние causes типа `provider_turn_closed_before_output`/`provider_turn_complete_without_model_output` (`geminiLiveProvider.js:975-1001`) | Сбросить состояние, вернуться в IDLE, можно показать "ошибка, попробуй снова" |
| `provider.ready` | `reason`, `provider`, `provider_instance_id` | После (пере)подключения к провайдеру — **не гарантирован на первом коннекте**, только на восстановлении/ротации (см. раздел 3) — `realtimeServer.js:698-703` | `lab.html` использует, чтобы вернуться в IDLE после ротации, если не идёт запись/воспроизведение (`lab.html:1052-1053`) |
| `provider.rotated` | `old_provider_instance_id`, `new_provider_instance_id`, `voice_preserved`, `*_hash`, `*_preserved`, `rotation_mode`, счётчики | Каждая пересоздача provider-сессии (`realtimeServer.js:1066-1087`) | Диагностическое; `lab.html` явно не обрабатывает (падает в общий `logLine`) |
| `language.switch_detected` | `from_language`, `to_language`, `significant_word_count`, `confirmation_count`, `reason`, `action` | Автодетект смены языка ребёнка (`realtimeServer.js:495-505`) | Диагностическое |
| `activity.started` | `activity_type: 'riddle'`, `content_id`, `generation_id`, `turn_id` | Вызов инструмента загадки (`realtimeServer.js:378-384`) | Диагностическое, только если контент-тулы включены (`REALTIME_CONTENT_TOOLS`) |
| `activity.answer_checked` | `activity_type`, `content_id`, `correct`, `attempts`, `completed`, `hint` | Проверка ответа на загадку (`realtimeServer.js:417-428`) | Диагностическое |
| `tool.call` / `tool.response` | `tool_name`/`tool_names`, `provider_instance_id` | Вызов и ответ function-calling инструмента у Gemini (`geminiLiveProvider.js:785-791, 828-834`) | Диагностическое, безопасно игнорировать |
| `provider_interrupt_ack` | `interrupted_generation_id`, `interrupted_turn_id`, `interrupted_response_id`, `matched`, `elapsed_ms` | Gemini подтвердил interruption (`geminiLiveProvider.js:719-729`) | Диагностическое |
| `silence_tail_started` / `silence_tail_completed` | `configured_duration_ms`/`sent_frames`, `sent_bytes`, `aborted`, `abort_reason` | Отправка тишины после `input_audio.end` (`geminiLiveProvider.js:579-590, 635-645`) | Диагностическое |
| `pong` | `timestamp_ms` | Ответ на JSON `ping` (`realtimeServer.js:1312-1315`) | — |
| `error` | `code`, `message`, доп. поля по коду | См. коды в разделе 4 и 10 | Обработать по `code`, часто → ERROR-состояние |

**Ничего из этого не влияет напрямую на LED/кнопку "по протоколу"** — сервер не шлёт отдельных LED-команд. Маппинг на LED/UX (раздел 11) — это интерпретация lifecycle-состояний клиентом, а не отдельный канал управления.

---

## 6. Binary packets

- **Направление:** входящее аудио — ESP32 → сервер (raw PCM16LE, **24kHz** на стороне ESP32 по Protocol V2, mono, без обёртки — см. врез Protocol V2 и раздел 2; сервер потоково ресемплирует в 16kHz перед отправкой в Gemini). Исходящее аудио ответа — **НЕ бинарные фреймы**, а base64 **внутри JSON** (`audio_base64` в `audio.chunk`, раздел 5).
- **Как отличить input от output:** это не один канал — вход идёт бинарными WS-фреймами (opcode `0x2`) от клиента к серверу; выход идёт текстовыми WS-фреймами (opcode `0x1`, JSON) от сервера к клиенту. Разделение по направлению и по транспорту одновременно, путаницы в коде нет.
- **Формат аудио ответа:** `mime_type: 'audio/pcm'`, **sample_rate: 24000** (не 16000, как вход!) — `geminiLiveProvider.js:952-953`. PCM16, little-endian (декодер `lab.html:1148-1166` читает `getInt16(..., true)`). Моно (создаётся `audioContext.createBuffer(1, samples, sampleRate)`, `lab.html:1159`).
  - **Почему 24000, а не 16000 симметрично со входом:** это захардкоженная в коде константа (`geminiLiveProvider.js:938, 953`), но не потому, что сервер сам так решил — Gemini Live **всегда** генерирует ответное аудио на 24kHz, вне зависимости от частоты входа; это задокументированное ограничение самого Gemini Live API (`ai.google.dev/gemini-api/docs/live-guide`: *"Audio output always uses a sample rate of 24kHz"*), не настраивается ни клиентом, ни этим сервером. Код даже не читает `part.inlineData.mimeType` из ответа Gemini (где Google тоже прислал бы `rate=24000`) — просто полагается на то, что это значение всегда одно и то же.
- **Валидация на сервере (только для исходящего аудио от Gemini, НЕ входящего от клиента):** чанк с audio отбрасывается, если `audioBytes < 4` или `audioBytes % 2 !== 0` (`MIN_VALID_PCM_BYTES = 4`, `BYTES_PER_PCM16_SAMPLE = 2`, `geminiLiveProvider.js:913-928`).
- **Максимальный исходящий чанк:** `MAX_OUTBOUND_PCM_CHUNK_BYTES = 2048`. Более крупный PCM от Gemini сервер декодирует и делит на последовательные `audio.chunk`; каждый фрагмент сохраняет PCM16LE-выравнивание, а `chunk_index` увеличивается для каждого фактически отправленного фрагмента. При 24 kHz mono это примерно 42.7 мс аудио на полный чанк. Вместе с Base64 и служебными полями полный JSON остаётся меньше типичного 4-КБ приёмного буфера ESP32.
- **Требование к ESP32:** парсить WebSocket TEXT payload по переданной библиотекой длине, не через `strlen()` и не предполагая завершающий `\0`. Если библиотека отдаёт одно WS-сообщение несколькими callback-фрагментами, сначала собрать его полностью по её признакам `final/index/total length`, и только затем запускать JSON parser.
- **mock-провайдер (не прод!) шлёт WAV** (`mime_type: 'audio/wav'`, с полным RIFF/WAVE-заголовком — `mockRealtimeProvider.js:16-44, 148`), это только для локальной разработки без Gemini API key. **На проде всегда `audio/pcm`.**

Формат зафиксирован как Protocol V1 (см. врез в начале документа).

---

## 7. Состояния прошивки — предложенная state machine

Запрошенный в задаче набор (`DISCONNECTED, CONNECTING, IDLE, LISTENING, WAITING_RESPONSE, PLAYING, INTERRUPTING, ERROR, RECONNECTING`) **не совпадает буквально** с набором в `lab.html` — там `STATES = { DISCONNECTED, IDLE, LISTENING, ENDING_TURN, WAITING_PROVIDER, PLAYING, INTERRUPTING, ERROR }` (`lab.html:351-360`) — нет отдельных `CONNECTING`/`RECONNECTING`/`WAITING_RESPONSE` (у lab.html это `WAITING_PROVIDER`), и есть промежуточное `ENDING_TURN`, которого в запрошенном списке нет.

Ниже — состояния из запрошенного списка, дополненные `ENDING_TURN` из реального клиента (рекомендуется сохранить, так как это реальный промежуточный шаг между "отпустил кнопку" и "запрос ушёл"), с точным описанием переходов из `lab.html`. **Важно (уточнение раздела 3):** переход `CONNECTING → IDLE` ниже показан по `session.ready`, как это делает `lab.html`, но для ESP32 рекомендуется делать этот переход по `session.config.applied`, чтобы не попасть в гонку с персонализацией из БД.

| Состояние | Разрешённые входящие события | Разрешённые действия ESP32 | Переход |
|---|---|---|---|
| **DISCONNECTED** | — | Подключиться | На `pointerdown` или явный коннект → **CONNECTING** (`lab.html:1280-1282` — коннект прямо из pointerdown, если состояние `DISCONNECTED`) |
| **CONNECTING** | `session.ready`, затем `session.config.applied` | Ждать | `lab.html` переходит в **IDLE** уже на `session.ready` (`lab.html:1010`); ESP32 рекомендуется дождаться `session.config.applied` (см. раздел 3) |
| **IDLE** | `input_audio.start` (от пользователя, т.е. нажатие) | Отправить `input_audio.start`, начать писать PCM | На нажатие PTT → **LISTENING** (`lab.html:847`) |
| **LISTENING** | поток PCM исходящий | Слать бинарные PCM-фреймы | На отпускание кнопки → **ENDING_TURN** (`lab.html:890`) |
| **ENDING_TURN** | — | Ждать (80 мс искусственная пауза в `lab.html:891-896`, не требование протокола) | → **WAITING_RESPONSE** |
| **WAITING_RESPONSE** | `transcript.user`, `response.created`, `audio.start`, `response.failed` | Ждать, таймаут 5000 мс на клиенте (`lab.html:937-949`) / 4500 мс на сервере (`realtimeServer.js:614`) | На первый `audio.chunk` → **PLAYING** (`lab.html:1126-1134`); на `response.failed` → **IDLE** (`lab.html:1050`) |
| **PLAYING** | `audio.chunk`, `audio.end`, новое нажатие PTT (barge-in) | Проигрывать чанки | На пустую очередь после `audio.end` → **IDLE** (`lab.html:1037, 1191-1193`); на новое нажатие → **INTERRUPTING** (`lab.html:813-815`, `899-918`) |
| **INTERRUPTING** | — | Остановить плеер немедленно, отправить `session.interrupt`, **сразу же** начать новый ход | Переходит в **LISTENING** немедленно, не дожидаясь `response.cancelled` (`lab.html:1293` — `startTurn` вызывается сразу же после `manualInterrupt()`; подробности — раздел 8) |
| **ERROR** | `error`, `close` сокета | Показать ошибку, ждать reconnect | Кнопка "Reconnect" доступна (`lab.html:263, 619`) |
| **RECONNECTING** | — | Пересоздать сокет | В `lab.html` это не отдельное состояние — `reconnect()` синхронно вызывает `disconnect()` → **DISCONNECTED**, затем через `setTimeout(connect, 200)` → **CONNECTING** (`lab.html:751-756`) |

---

## 8. Barge-in (прерывание ответа новым нажатием)

Точная последовательность из `lab.html` + `realtimeServer.js`:

1. Ребёнок нажимает кнопку, пока состояние `PLAYING`.
2. Клиент **сразу** вызывает `manualInterrupt()` (`lab.html:813-815, 899-918`), **до** отправки `session.interrupt` на сервер:
   - Добавляет текущий `generation_id`/`response_id` в локальные Set'ы `cancelledGenerations`/`cancelledResponses` (`lab.html:902-903`) — это чисто клиентский механизм фильтрации "опоздавших" сообщений.
   - **Локально останавливает воспроизведение немедленно**: `clearPlayback('manual_interrupt')` — `stop()` на всех активных `AudioBufferSourceNode`, полностью очищает `playbackQueue` и `activeSources` (`lab.html:968-981`). Это происходит **до** какого-либо ответа сервера — задержки сети не влияют на скорость остановки звука на клиенте.
3. Затем отправляется `session.interrupt` (`lab.html:905-909`, поля — раздел 4.4) — **fire-and-forget**, без ожидания ответа.
4. **Клиент НЕ ждёт `response.cancelled`.** Сразу вслед за `manualInterrupt()`, синхронно в том же вызове `startTurn()`, идёт проверка состояния (`lifecycleState` уже `INTERRUPTING`, что разрешено списком `[STATES.IDLE, STATES.INTERRUPTING, STATES.ERROR]`, `lab.html:816`) и немедленный старт нового хода — `input_audio.start` уходит без паузы на подтверждение сервера (`lab.html:808-816`, весь блок синхронный до `await ensureMic()`, который ждёт микрофон, а не сервер).
5. Сервер параллельно: `cancelCurrent(reason)` — помечает текущую generation `cancelled`, вызывает `providerSession.interrupt()` (шлёт Gemini `sendRealtimeInput({ text: '[Interrupted by user]' })`, `geminiLiveProvider.js:695-701`), эмитит `response.cancelled` клиенту (`realtimeServer.js:990-1024`) — это событие приходит **уже после** того, как клиент начал слушать новый ход, и используется только как постфактум-подтверждение в UI/метриках, не как gate.
6. Если у провайдера `rotateOnInterrupt === true` (для Gemini — всегда `true`, `geminiLiveProvider.js:236`) — сервер **пересоздаёт** provider-сессию (`rotateProviderSession(reason)`, `realtimeServer.js:1113-1115`).
7. **Как не проиграть запоздалый старый ответ (без ожидания `response.cancelled`):** двойная защита именно потому, что ждать нечего.
   - На клиенте: `isLateEvent(payload)` проверяет `cancelledGenerations`/`cancelledResponses` Set, а также несовпадение `generation_id`/`response_id` с текущими — если совпадение "просрочено", событие дропается (`lab.html:1081-1088`, применяется в `handleAudioChunk`, `audio.start`, `audio.end`, `transcript.model`).
   - На сервере: `emitProviderEvent` при `generation.status` в `cancelled/completed/failed` дропает "model output events" (`transcript.model`, `audio.start`, `audio.chunk`, `audio.end`) через `droppedProviderEvent()`, **не пересылая клиенту** (`realtimeServer.js:902-907`).
8. **Сброс старых чанков:** явного "flush"-сообщения в протоколе нет — сброс это следствие (а) клиентского `clearPlayback()` (очистка локальной очереди) и (б) серверного дропа опоздавших событий до их отправки. Никакого специального пакета `flush`/`clear_buffer` в протоколе не существует — **это нужно решить инженеру** (см. раздел 14), если для ESP32 потребуется явный сигнал очистки буфера.

**Итог для ESP32:** ждать `response.cancelled` перед стартом нового хода — не нужно и не соответствует референсному поведению. Останавливать локальное воспроизведение нужно немедленно, синхронно, до отправки `session.interrupt`.

---

## 9. Reconnect

- **Heartbeat / ping-pong — два независимых механизма, оба реализованы на сервере уже сейчас:**
  1. **JSON-уровень:** клиент шлёт `{"type":"ping","timestamp_ms":...}` (раздел 4.5) → сервер отвечает `{"type":"pong","timestamp_ms":...}` с тем же значением (`realtimeServer.js:1311-1315`).
  2. **WS-протокол:** стандартный ping-фрейм (opcode `0x9`) → сервер отвечает стандартным pong-фреймом (opcode `0xA`) через `sendPong()` (`wsProtocol.js:100-101, 128-132`, обработчик `realtimeServer.js:1372-1374`).
  - **`lab.html` не использует ни один из них** — ни `setInterval` с JSON `ping`, ни явных WS ping-фреймов в файле нет. Оба варианта одинаково рабочие и доступны ESP32 уже сейчас; выбор конкретного — на усмотрение инженера (см. раздел 14 п.6), код не диктует предпочтение.
- **Timeout:** нет server-side idle-timeout на уровне сокета в коде (`wsProtocol.js` не закрывает соединение по неактивности, ни для JSON, ни для WS ping/pong). Единственный таймаут — `PTT_TURN_TIMEOUT_MS` (сервер, 4500 мс дефолт, `realtimeServer.js:614`) и клиентский аналог 5000 мс (`lab.html:937`) — это таймаут ожидания **ответа на ход**, а не таймаут соединения или heartbeat. Значение таймаута простоя (когда считать сокет мёртвым и начинать reconnect) код не определяет — это решение инженера, не выведено из существующего поведения.
- **Backoff:** отсутствует. `reconnect()` в `lab.html` ждёт фиксированные **200 мс** и переподключается — без экспоненциального backoff и без ограничения числа попыток (`lab.html:751-756`).
- **Восстановление после Wi-Fi loss:** протокол это не решает — при разрыве сокета (`close`/`error`) клиент переходит в `ERROR`, вся серверная сессия (генерация, provider-сессия, deviceId в памяти closure) **уничтожается** (`socket.on('close', ...)` → `closeProvider('disconnect')`, `realtimeServer.js:1393-1397`).
- **Можно ли продолжить старую сессию или нужна новая:** **всегда нужна новая**, с новым `session.start`. `sessionId` генерируется заново на каждый коннект (`id('session')`, `realtimeServer.js:168`), нет никакого resume-токена или session-id, который клиент мог бы переиспользовать. Все in-memory состояния (recentTurns, promptBlocks, providerSession) теряются безвозвратно при разрыве — единственное, что переживает разрыв, это данные в Postgres (child_profiles/memory_facts/device_settings), которые заново подтягиваются по `deviceId` при новом `session.start`.

---

## 10. Ограничения

| Что | Значение | Источник |
|---|---|---|
| Макс. буфер входного аудио для replay (retry) | `REALTIME_TURN_REPLAY_MAX_BYTES`, дефолт **512 КБ** (`512 * 1024`) | `realtimeServer.js:35-38` |
| Что при overflow этого буфера | Replay-буфер **сбрасывается** (`currentInputChunks = []`), но живой поток в Gemini продолжает идти нормально — просто retry после сбоя провайдера станет невозможен для этого хода | `realtimeServer.js:1351-1361` |
| Макс. буфер аудио до готовности provider-сессии | `GEMINI_PENDING_AUDIO_MAX_BYTES`, дефолт **512 КБ** | `geminiLiveProvider.js:14, 423-431` |
| Что при overflow этого буфера | Новые входящие чанки **отбрасываются** (`input_buffer_dropped`), уже отправленные — нет | `geminiLiveProvider.js:423-430` |
| Макс. длина промпт-блока (core/child/parent) | `LAB_PROMPT_MAX_CHARS`, дефолт **24000** символов на каждый из блоков (`core_prompt`/`child_context`/`parent_rules`) — поднят с исходных 8000 → 16000 → 24000, чтобы вместить `parent_rules` в худшем случае (база + сгенерированный TOY/STYLE/CONTENT/TIME блок + `restrictions_addition` до 16000 символов ≈ 18000). Это ограничение промпта, не голосового ввода | `src/realtime/realtimePrompt.js` |
| Ограничение длины `custom_prompt_text` и родительского дополнения `restrictions_addition` | **16000** символов у каждого (было 10000/5000) | `src/memory/store.js` (`CUSTOM_PROMPT_MAX_CHARS`, `RESTRICTIONS_ADDITION_MAX_CHARS`) |
| Макс. размер тела HTTP-запроса к `/api/*` (панель, не относится к `/realtime`) | **256 КБ** (`MAX_JSON_BODY_BYTES`), поднят с исходных 8 КБ → 64 КБ → 256 КБ — два поля по 16000 символов кириллицы в UTF-8 с JSON-экранированием переносов строк сами по себе приближаются к ~70 КБ | `src/server.js` |
| Таймаут ожидания начала ответа (turn timeout) | `PTT_TURN_TIMEOUT_MS`, дефолт **4500 мс** | `realtimeServer.js:614` |
| Что при коротком/пустом аудио | Нет отдельной проверки минимальной длительности на сервере для **входящего** аудио. Для исходящего (ответ) — есть `isPlayableBuffer()` на клиенте, отбрасывает буфер короче 5 мс или полностью тихий (`lab.html:1139-1146`) — это клиентская, не серверная проверка |
| Invalid PCM (исходящее от Gemini) | Отбрасывается, если байт < 4 или нечётное число байт; логируется раз в `GEMINI_INVALID_PCM_LOG_EVERY` (дефолт 20) раз, чтобы не спамить лог | `geminiLiveProvider.js:914-927`, `.env` — но переменная не в `.env.example`, дефолт в коде |
| Invalid PCM (входящее от клиента) | **Нет валидации вообще** — сервер передаёт что получил как есть в Gemini | — |
| Server timeout / сбой провайдера | Автоматический retry на новой provider-сессии для конкретных причин (`provider_turn_closed_before_output`, `provider_turn_closed_during_input`), иначе — `response.failed` клиенту и ротация | `realtimeServer.js:793-857`, `965-987` |
| WS message framing | Парсер сервера **не проверяет FIN-бит** (`first & 0x0f` без учёта `0x80`, `wsProtocol.js:53-55`) — предполагается, что каждое сообщение приходит **одним** WS-фреймом, без continuation-фреймов. ESP32-клиент обязан слать несегментированные фреймы | `wsProtocol.js:93-104` |
| Максимальный размер одного WS-фрейма | Не ограничен явно в парсере (поддерживает вплоть до `Number.MAX_SAFE_INTEGER` через 64-битную длину), но нет практического стресс-теста на это — не гарантия, а факт отсутствия ограничения в коде | `wsProtocol.js:64-73` |
| Маскирование фреймов клиент→сервер | Сервер поддерживает и корректно демаскирует, если бит `masked` установлен (`wsProtocol.js:56, 78-91`) — по RFC6455 клиент **обязан** маскировать все свои фреймы; сервер не отклоняет немаскированные фреймы явно, но корректность не гарантируется, если ESP32 этого не сделает |

---

## 11. LED/UX mapping

**В протоколе нет отдельного канала для LED.** Ниже — маппинг состояний lifecycle-машины (раздел 7) на визуальные состояния, взятый из реального CSS/JS в `lab.html` (кнопка меняет цвет, что является прямым аналогом LED-состояний):

| Lifecycle-состояние | Цвет в lab.html | CSS-класс | Источник |
|---|---|---|---|
| IDLE | зелёный (`--good: #22c55e`) | `.ptt-button.idle` | `lab.html:105, 17` |
| LISTENING | красный (`--bad: #ef4444`) | `.ptt-button.listening` | `lab.html:106, 18` |
| ENDING_TURN / WAITING_RESPONSE | серый (`#334155`) | `.ptt-button.ending`, `.ptt-button.waiting` | `lab.html:107-108` |
| PLAYING | синий (`--speak: #2563eb`) | `.ptt-button.playing` | `lab.html:109, 20` |
| INTERRUPTING | оранжевый (`--warn: #f59e0b`) | `.ptt-button.interrupting` | `lab.html:110, 19` |
| ERROR | красный (`--bad`) | `.ptt-button.error` | `lab.html:111` |
| DISCONNECTED | нейтральный (текст "Reconnect", кнопка задизейблена) | — | `lab.html:263` |

Отдельного "disconnected"-цвета в CSS нет — кнопка просто неактивна с дефолтным видом. Для реальной игрушки это открытый вопрос дизайна (раздел 14).

---

## 12. Минимальный пример сессии (из реального production-лога, 2026-07-13, session `session_8bb1879a2311e86a`, провайдер `gemini`)

```text
→ (JSON)   session.start { deviceId: "browser-lab", config: {...} }
← (JSON)   session.ready { session_id: "session_8bb1879a2311e86a", provider: "gemini", model: "gemini-3.1-flash-live-preview", ... }
← (JSON)   session.config.applied { reason: "session.start", prompt_source: "default" | "lab", ... }
           // ESP32: только теперь разрешать первое нажатие PTT — см. раздел 3

→ (JSON)   input_audio.start { turn_id: "trn_mrjlcuok_c12436", mode: "push_to_talk" }
← (JSON)   input_audio.start { turn_id: "trn_mrjlcuok_c12436", generation_id: "generation_df86bfe7a52abb43", response_id: null }

→ (binary) PCM16LE 16kHz mono, 4096 bytes   × 47 фреймов (реально в этом логе — снят с Browser Lab до Protocol V2; для ESP32 замени на PCM16LE **24kHz** mono, см. врез Protocol V2)

→ (JSON)   input_audio.end { end_reason: "pointerup" }
← (JSON)   input_audio.end { turn_id: "trn_mrjlcuok_c12436", generation_id: "generation_df86bfe7a52abb43", duration_ms: 5968, turn_input_bytes: 192512 }

  [сервер шлёт Gemini activityEnd после 300мс тишины — silence_tail, см. раздел 3 п.8]

← (JSON)   transcript.user { text: "...", generation_id: "generation_df86bfe7a52abb43" }   // фрагмент, ~593мс после input_audio.end
← (JSON)   response.created { generation_id: "generation_df86bfe7a52abb43", response_id: "response_...", cause: "transcript.model" }
← (JSON)   transcript.model { text: "..." }
← (JSON)   audio.start { format: "audio/pcm", sample_rate: 24000 }
← (JSON)   audio.chunk { chunk_index: 0, mime_type: "audio/pcm", sample_rate: 24000, audio_base64: "..." }
← (JSON)   audio.chunk { chunk_index: 1, ... }
  ...
← (JSON)   audio.end { cause: "generationComplete" }

  [провайдер-сессия пересоздаётся: provider_session_reused либо provider.rotated, в зависимости от rotationMode]
```

Точные тайминги из этого же лога: `inputEndToInputTranscriptionMs=593`, `inputEndToFirstModelEventMs=1249`, `inputEndToFirstValidAudioMs=1250` — то есть от отпускания кнопки до первого звука ответа прошло **~1.25 секунды** в этом конкретном примере (сильно зависит от длины реплики и загрузки Gemini).

---

## 13. Таблица совместимости

| Поле / поведение | Browser Lab (`lab.html`) | Требование к ESP32-реализации |
|---|---|---|
| Захват аудио | Web Audio API, `getUserMedia` + `ScriptProcessorNode(2048,1,1)`, **16kHz** (свой формат, не меняется) | Любой источник PCM16LE **24kHz** mono (Protocol V2, кодек ESP32 работает 24/24); размер фрейма не регламентирован протоколом |
| Формат исходящего фрейма | `ArrayBuffer` через `ws.send()` | Обязательно **бинарный** WS-фрейм (opcode `0x2`), не JSON/base64 |
| `deviceId` | Хардкод `'browser-lab'` | ESP32 должен слать свой (стабильный на устройство) `deviceId`, иначе будет делить память/настройки с Browser Lab через дефолт `browser-lab` |
| `lang`/`codec` в `session.start` | Отправляются, сервер игнорирует | Можно не отправлять |
| `sampleRate`/`sample_rate` в `session.start` | Отправляется `16000` (свой родной формат) | **Обязательно `24000`** — без этого поля сервер не ресемплирует вход и звук будет испорчен (см. раздел 4.1 и врез Protocol V2) |
| Момент разблокировки PTT | На `session.ready` (гонка с персонализацией, см. раздел 3) | На `session.config.applied` |
| Прогрев/удержание кнопки | Pointer Events API (`pointerdown/up/cancel`, `lostpointercapture`) + обработка `window blur`/`visibilitychange` как принудительного отпускания | ESP32 должен сам решить аналог для физической кнопки — минимум debounce и защита от "залипания" при потере сети |
| Декодирование ответа | Web Audio API `AudioContext.createBuffer` + ручной PCM16→Float32 (`lab.html:1148-1166`) | ESP32 должен уметь декодировать PCM16LE 24000Hz mono напрямую в DAC/I2S |
| Barge-in | Клиентская мгновенная остановка плеера + серверный `session.interrupt`, **без ожидания `response.cancelled`** (раздел 8) | Обязательно реализовать оба уровня защиты от опоздавших событий — иначе будет слышен "хвост" старого ответа при сетевой задержке |
| Reconnect | Fixed 200ms delay, без backoff, без лимита попыток, новая сессия каждый раз | Рекомендуется добавить backoff на стороне ESP32 (сервер этого не требует и не ограничивает) |
| Ping/pong | Оба механизма (JSON и WS-протокольный) реализованы на сервере, ни один не используется клиентом | Выбор варианта — на усмотрение инженера, оба одинаково поддержаны уже сейчас |
| Auth | Нет ни на сервере, ни в `lab.html` | Решено, не реализовано — Device ID + PIN, см. раздел 14 п.1 |
| Voice/prompt config | `lab.html` шлёт кастомный prompt в `session.start.config`, работает только при `LAB_ALLOW_CUSTOM_PROMPT=true` | ESP32, скорее всего, НЕ должен слать `config` вообще — сервер и так подтягивает `parentRules`/`childContext`/`voice_name`/`custom_prompt_text` из Postgres по `deviceId`, если `REALTIME_MEMORY_ENABLED=true` (уже включено на проде) |

---

## 14. Итоговый статус

### Что уже точно реализовано и стабильно работает (проверено production-логами)
- Полный PTT lifecycle: start → PCM stream → end → silence tail → activityEnd → ответ → audio.end → ротация сессии.
- Streaming ответа чанками (`audio.chunk`) с реальным `mime_type: 'audio/pcm'`, `sample_rate: 24000`.
- Barge-in с двухуровневой защитой от "просроченных" событий (клиент + сервер), без ожидания `response.cancelled`.
- Автовосстановление при таймауте/сбое провайдера (retry на свежей provider-сессии для ряда причин).
- Автодетект языка ребёнка и ротация сессии при смене языка.
- Серверная память/настройки (Postgres) уже подключены и работают на проде: `deviceId` → `childContext`/`parentRules`/`voice_name`/`custom_prompt_text` при `session.start`.

### Что пока Browser Lab-specific (не часть протокола, а поведение конкретного клиента)
- Web Audio API захват/декодирование.
- Pointer Events для PTT-кнопки, обработка `blur`/`visibilitychange` как отпускания.
- Локальные Set'ы `cancelledGenerations`/`cancelledResponses` для фильтрации поздних событий (клиентский паттерн, не протокольное требование, но настоятельно рекомендуется повторить).
- Разблокировка PTT на `session.ready` вместо `session.config.applied` — гонка в самом `lab.html`, не копировать буквально (раздел 3).
- UI prompt-редактор (`corePromptInput`/`childContextInput`/`parentRulesInput`) — не нужен ESP32, так как сервер сам берёт эти блоки из БД.
- Reconnect без backoff — это слабость самого lab.html, не требование протокола.

### Что ещё нужно добавить на сервере для ESP32 (не сделано сегодня)
- Никакой явной поддержки бинарного стриминга **ответа** (сейчас это base64-в-JSON, что даёт ~33% оверхеда трафика — для Wi-Fi/ESP32 может быть значимо).
- Никакого heartbeat/keepalive, который клиент обязан использовать — оба варианта `ping`/`pong` (JSON и WS-протокольный) есть, но не обязательны и не используются существующим клиентом.
- Никакой авторизации/идентификации устройства на уровне соединения (решение принято, реализация — нет, см. п.1 ниже).
- Нет явного "flush audio buffer" пакета — сброс плейбека сейчас чисто клиентская реализация.
- allowed_content (разрешённые типы контента из панели) сейчас **не влияет** на `get_riddle`-тул в коде — это отдельная незавершённая работа, не относится к ESP32-протоколу напрямую, но важно знать, что не всё, что видно в панели, реально гейтит поведение сервера.

### Места, которые требуют решения инженера (осознанно не решено в этом аудите)
1. **Авторизация ESP32↔сервер** — решено (2026-07-13): **Device ID + PIN**, по аналогии со старым `lunara-toy-server`. Пока не реализовано (один экземпляр устройства, не критично сейчас). Реализация нужна перед выпуском второго физического устройства: как минимум — проверка PIN при `session.start` (или отдельным handshake-сообщением до него), хранение хэша PIN в Postgres (`device_settings` или отдельная таблица), процедура смены/восстановления PIN.
2. **Формат передачи ответа** — оставить base64-в-JSON (проще) или перейти на чистый бинарный поток для ответа тоже (эффективнее по трафику, но требует протокольного изменения — сейчас сервер шлёт ответ только текстовым JSON-фреймом).
3. **Reconnect-стратегия** — экспоненциальный backoff, лимит попыток, поведение при долгом отсутствии сети (буферизовать локально? игнорировать?).
4. **`deviceId`-схема для реальных устройств** — как каждое физическое ESP32-устройство получает свой стабильный `deviceId` (сейчас это работает только для одного захардкоженного `'browser-lab'`).
5. **Явный сигнал сброса аудио-буфера** при barge-in — нужен ли отдельный пакет, или клиентской остановки плеера + серверного дропа "просроченных" событий (раздел 8) достаточно.
6. **Heartbeat-политика** — JSON `ping`/`pong` или стандартный WS-протокольный ping/pong (оба реализованы на сервере, раздел 9), какой конкретно таймаут простоя считать разрывом соединения — код этого не диктует, решение целиком за инженером.
7. **Ограничение размера входного PCM-фрейма** — сейчас никак не регламентировано и не провалидировано сервером; для ESP32 стоит выбрать конкретный размер и задокументировать явно, а не полагаться на 4096-байтовый паттерн Browser Lab.

---

## Индекс файлов, использованных в аудите

- `src/realtime/wsProtocol.js` — WS handshake, framing, `sendJson`/`sendBinary`/`sendPong`/`sendClose`.
- `src/realtime/realtimeServer.js` — вся серверная lifecycle-логика, `handleCommand`, `emitProviderEvent`, `rotateProviderSession`, `warmProviderSession`, memory/settings integration.
- `src/realtime/geminiLiveProvider.js` — маппинг на Gemini Live API, формат аудио, `handleMessage`, tool calling, activity markers.
- `src/realtime/mockRealtimeProvider.js` — mock-провайдер (для сравнения, не прод).
- `src/realtime/realtimePrompt.js` — лимиты промпта (`LAB_PROMPT_MAX_CHARS`, сейчас 24000), `LAB_ALLOW_CUSTOM_PROMPT`.
- `src/memory/store.js` — `RESTRICTIONS_ADDITION_MAX_CHARS`, `CUSTOM_PROMPT_MAX_CHARS`, дефолт `deviceId`.
- `src/server.js` — `/realtime` upgrade routing, `PORT`, `MAX_JSON_BODY_BYTES` (сейчас 256 КБ).
- `public/lab.html` — единственный существующий клиент, полный референс UX/lifecycle.
- `.env.example` — доступные env-переменные (часть из них, `GEMINI_VAD_SILENCE_MS`/`GEMINI_VAD_PREFIX_PADDING_MS`, **не используются нигде в коде** — мёртвые настройки, не вводить в заблуждение).
- Реальные production-логи сервиса `lunara-realtime` (Railway), сессия `session_8bb1879a2311e86a`, снято 2026-07-13.

---

## Changelog

- **2026-07-14:** уточнены 5 пунктов по запросу перед передачей инженеру — момент разблокировки PTT (`session.config.applied`, не `session.ready`/`provider.ready`, с объяснением почему `provider.ready` не гарантирован на первом коннекте), минимальный `session.start` для ESP32, Protocol V1 зафиксирован явным врезом, точный порядок barge-in без ожидания `response.cancelled`, heartbeat как два независимых уже реализованных механизма (JSON и WS-протокольный). Заодно актуализированы значения `LAB_PROMPT_MAX_CHARS` (8000 → 16000) и `MAX_JSON_BODY_BYTES` (8 КБ → 64 КБ), изменившиеся в коде после исходного аудита от 2026-07-13.
- **2026-07-14 (2):** отвечено на вопрос инженера — почему вход 16kHz, а выход 24kHz. Подтверждено официальной документацией Gemini Live API: выход **всегда** 24kHz независимо от частоты входа, это ограничение платформы, не решение сервера. Добавлено во врез Protocol V1 и в раздел 6. Также актуализированы `CUSTOM_PROMPT_MAX_CHARS`/`RESTRICTIONS_ADDITION_MAX_CHARS` (16000 каждый) и `LAB_PROMPT_MAX_CHARS` (24000), `MAX_JSON_BODY_BYTES` (256 КБ) — изменились в коде после предыдущего обновления документа.
- **2026-07-14 (3) — Protocol V2:** ESP32 переведён на единый режим PCM16LE 24000 Hz mono на входе (кодек+I2S работают на одной частоте для микрофона и динамика — нельзя задать 16/24 асимметрично на одном кодеке). Сервер потоково ресемплирует вход 24→16kHz перед Gemini. Первая реализация использовала preload-обёртку (`node -r`), подключённую вне основного pipeline — это было признано архитектурным недостатком при ревью (место преобразования было не видно из `realtimeServer.js`, а `sampleRate`/`sample_rate` в разделах 4.1/13 документа по-прежнему ошибочно значился как мёртвое поле, что могло привести к порче звука на реальном ESP32).
- **2026-07-14 (4) — рефакторинг по итогам ревью:** preload/monkey-patch слой (`src/realtime/inputResampleBootstrap.js`, флаг `-r` в `package.json`) полностью удалён. Ресемплинг теперь явно вызывается из `realtimeServer.js`: валидация частоты и создание ресемплера — `resolveInputSampleRate()`/`createInputResampler()` в новом `src/realtime/inputAudioResampling.js`; сам ресемплинг — прямо в обработчике `onBinary` перед `providerSession.sendAudio()`; сброс/слив состояния — в `startInput()`, `endInput()`, обработчике `session.interrupt` и `closeProvider()`, все в одном файле. Отсутствие `sampleRate` в `session.start` теперь явно, не тихо: сервер по-прежнему по умолчанию считает вход 16000Hz для обратной совместимости, но это видно в `session.config.applied.input_audio.sample_rate_source`; значение, отличное от 16000/24000, отклоняется явной ошибкой `unsupported_input_sample_rate` вместо угадывания коэффициента. Самописный DSP-ресемплер (`pcm16Resampler.js`) сохранён — обоснование см. в комментарии в начале файла (единственная нужная задача — фиксированное соотношение 3:2, зрелая WASM-библиотека (`libsamplerate-js`) была найдена и оценена, но не добавлена как зависимость без явного отдельного решения пользователя о конкретном пакете. Тесты: `npm run smoke:pcm-resampler` (DSP-ядро: идентичность потокового/целого прогона, антиалиасинг, точная длительность, корректный flush хвоста — без изменений) и новый `npm run smoke:input-resample-pipeline` (интеграционный: WS-подключение напрямую через `attachRealtimeServer`, без preload — отсутствие `sampleRate`, `sampleRate: 24000`, `sample_rate: 24000`, pass-through на 16000, отказ на неподдерживаемой частоте с последующим успешным повтором, сброс состояния после `session.interrupt`, независимость последовательных turn'ов) — оба зелёные.
- **2026-07-17 — найдена реальная причина, по которой ESP32 в поле видел только `provider.rotated`, а `session.ready`/`session.config.applied` не приходили вовсе (обработчик у инженера был подключён корректно, до открытия соединения — не гонка событий).** Замерены реальные размеры пакетов: `provider.rotated` ≈ 640 байт, `session.ready` ≈ 23.5 КБ, `session.config.applied` ≈ 23.8 КБ — потому что оба несли полный текст промта (`lab_prompt.defaults` / `lab_prompt.applied_blocks`: core_prompt + child_context + parent_rules целиком, нужно только отладочным текстовым полям `lab.html`). У embedded WS-библиотек буфер приёма обычно 1-4 КБ — фрейм на 23 КБ тихо отбрасывается целиком, без единой строки в логе. Исправлено: оба тяжёлых блока теперь передаются только если клиент явно попросил новым полем `session.start.include_prompt_debug: true`; без этого поля (в т.ч. для ESP32, которому его отправлять не нужно) оба пакета остаются лёгкими для всех клиентов. `lab.html` обновлён — теперь явно шлёт `include_prompt_debug: true` (`lab.html:888`), иначе сам лишился бы предпросмотра промта в отладочной панели. См. врез в разделе про исходящие сообщения сервера выше.
