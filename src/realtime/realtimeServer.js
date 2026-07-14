'use strict';

// NOTE ON MICROPHONE AUDIO SAMPLE RATE: ESP32 (and any other client) may
// send microphone audio at 16000Hz or 24000Hz PCM16LE mono binary WS
// frames, declared via `sampleRate`/`sample_rate` in session.start. This
// file resamples 24000Hz input down to Gemini's required 16000Hz input
// explicitly, in-line, right where audio frames are received (see the
// `onBinary` handler below and `startInput`/`endInput`/session.interrupt
// for where the resampler's per-turn state is reset/flushed) — using
// resolveInputSampleRate()/createInputResampler() from
// ./inputAudioResampling.js. There is no preload/monkey-patch layer; the
// conversion point is visible from this file.
const crypto = require('crypto');
const {
    acceptWebSocket,
    createFrameParser,
    sendJson,
    sendPong,
    sendClose,
} = require('./wsProtocol');
const {
    resolveInputSampleRate,
    createInputResampler,
    GEMINI_INPUT_SAMPLE_RATE,
} = require('./inputAudioResampling');
const { MockRealtimeProvider, DEFAULT_CONFIG } = require('./mockRealtimeProvider');
const {
    LAB_ALLOW_CUSTOM_PROMPT,
    LAB_PROMPT_MAX_CHARS,
    buildRealtimeSystemInstruction,
    defaultPromptBlocks,
    sanitizePromptConfig,
    composeParentRules,
} = require('./realtimePrompt');
const { createContentLibrary } = require('../content/contentLibrary');
const memoryStore = require('../memory/store');
const memoryGuard = require('../memory/guard');
const { extractMemoryActions } = require('../memory/extractor');

function memoryEnabledFromEnv() {
    return /^(1|true|yes|on|enabled)$/i.test(String(process.env.REALTIME_MEMORY_ENABLED || ''));
}

function id(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

const VALID_ROTATION_MODES = new Set(['per_turn', 'errors_only']);
const DEFAULT_ROTATION_MODE = 'per_turn';
const configuredTurnReplayBytes = Number(process.env.REALTIME_TURN_REPLAY_MAX_BYTES);
const MAX_TURN_REPLAY_BYTES = Number.isFinite(configuredTurnReplayBytes)
    ? Math.max(0, configuredTurnReplayBytes)
    : 512 * 1024;
let warnedInvalidRotationMode = false;

function areContentToolsEnabled(value = process.env.REALTIME_CONTENT_TOOLS) {
    return /^(1|true|yes|on|enabled)$/i.test(String(value || ''));
}

function normalizeProviderVoiceName(voiceName) {
    return String(voiceName || '').trim();
}

function normalizeRotationMode(value) {
    const mode = String(value || process.env.GEMINI_ROTATION_MODE || DEFAULT_ROTATION_MODE).trim().toLowerCase();
    if (VALID_ROTATION_MODES.has(mode)) return mode;
    if (!warnedInvalidRotationMode) {
        warnedInvalidRotationMode = true;
        console.warn('[Realtime] Unknown GEMINI_ROTATION_MODE=' + JSON.stringify(mode) + '. Falling back to ' + DEFAULT_ROTATION_MODE + '.');
    }
    return DEFAULT_ROTATION_MODE;
}

const LANGUAGE_PATTERNS = [
    { language: 'uk', pattern: /[\u0404\u0406\u0407\u0490\u0454\u0456\u0457\u0491]/u, weight: 5 },
    { language: 'ru', pattern: /[\u0400-\u04FF]/u, weight: 3 },
    { language: 'ro', pattern: /[\u0103\u00E2\u00EE\u0219\u021B\u0102\u00C2\u00CE\u0218\u021A]/u, weight: 4 },
    { language: 'en', pattern: /\b(the|and|you|hello|please|story|game|speak|english|what|why|how)\b/i, weight: 2 },
    { language: 'ro', pattern: /\b(spune|vreau|buna|salut|joc|poveste|romana|vorbeste)\b/i, weight: 3 },
];
const MIN_LANGUAGE_SWITCH_SIGNIFICANT_WORDS = Number(process.env.LANGUAGE_SWITCH_MIN_WORDS || 3);
const LANGUAGE_SWITCH_CONFIRMATIONS = Number(process.env.LANGUAGE_SWITCH_CONFIRMATIONS || 2);
const LANGUAGE_NOISE_WORDS = new Set([
    'ok', 'okay', 'yes', 'yeah', 'no', 'not', 'the', 'and', 'you', 'please',
    '\u0434\u0430', '\u043d\u0435\u0442', '\u0430\u0433\u0430', '\u0443\u0433\u0443', '\u043d\u0443', '\u043e\u0439', '\u044d\u0439', '\u0430\u043b\u043b\u043e',
    'lumi', 'lunara', 'google', 'gemini',
]);

function languageSignificantWords(text) {
    return (String(text || '').toLowerCase().match(/[\p{L}]+/gu) || [])
        .filter((word) => word.length >= 3 && !LANGUAGE_NOISE_WORDS.has(word));
}

function detectLikelyLanguage(text) {
    const sample = String(text || '').trim();
    if (sample.length < 4) return null;
    const scores = new Map();
    for (const { language, pattern, weight } of LANGUAGE_PATTERNS) {
        if (pattern.test(sample)) {
            scores.set(language, (scores.get(language) || 0) + weight);
        }
    }
    const asciiLetters = sample.match(/[a-z]/gi)?.length || 0;
    const cyrillicLetters = sample.match(/[\u0400-\u04FF]/gu)?.length || 0;
    if (asciiLetters >= 8 && asciiLetters > cyrillicLetters * 2) {
        scores.set('en', (scores.get('en') || 0) + 2);
    }
    const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0 || ranked[0][1] < 3) return null;
    if (ranked[1] && ranked[0][1] - ranked[1][1] < 2) return null;
    return ranked[0][0];
}

function detectLanguageSignal(text) {
    const language = detectLikelyLanguage(text);
    if (!language) return null;
    const significantWordCount = languageSignificantWords(text).length;
    return {
        language,
        significantWordCount,
        confident: significantWordCount >= MIN_LANGUAGE_SWITCH_SIGNIFICANT_WORDS,
    };
}

// ---- Working-hours enforcement time helpers -----------------------------
// Compared against the DEVICE's own timezone (device_settings.timezone,
// defaults to memoryStore.DEFAULT_TIMEZONE), not the server container's
// clock — a parent sets night mode to "22:00" meaning 22:00 where the toy
// actually is, regardless of which region Railway happens to run the
// service in.
function timeStringToMinutes(str) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(str || ''));
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
}

// Returns minutes-since-midnight for `now` as seen in `timezone`. Falls back
// to the server's own local clock if the timezone string is missing/invalid.
function nowMinutes(timezone, now = new Date()) {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: timezone || memoryStore.DEFAULT_TIMEZONE,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(now);
        const hour = Number(parts.find((p) => p.type === 'hour')?.value);
        const minute = Number(parts.find((p) => p.type === 'minute')?.value);
        if (Number.isFinite(hour) && Number.isFinite(minute)) return hour * 60 + minute;
    } catch {
        // fall through to server-local clock below
    }
    return now.getHours() * 60 + now.getMinutes();
}

// Handles overnight windows (e.g. 22:00-07:00) as well as same-day ones.
function isWithinNightWindow(settings, now = new Date()) {
    if (!settings || !settings.night_mode_enabled) return false;
    const start = timeStringToMinutes(settings.night_mode_start);
    const end = timeStringToMinutes(settings.night_mode_end);
    if (start == null || end == null) return false;
    const cur = nowMinutes(settings.timezone, now);
    if (start === end) return false;
    if (start < end) return cur >= start && cur < end;
    return cur >= start || cur < end; // wraps past midnight
}

// Soft toggle: active from evening_mode_start until local midnight.
function isEveningModeActive(settings, now = new Date()) {
    if (!settings || !settings.evening_mode_enabled) return false;
    const start = timeStringToMinutes(settings.evening_mode_start);
    if (start == null) return false;
    return nowMinutes(settings.timezone, now) >= start;
}

// Formats `now` as a friendly "YYYY-MM-DD, HH:MM (Weekday), TIMEZONE" string
// in the device's own timezone, for the [CURRENT CONTEXT] prompt block —
// lets the model correctly answer "what day/time is it".
function formatLocalDateTime(timezone, now = new Date()) {
    const tz = timezone || memoryStore.DEFAULT_TIMEZONE;
    try {
        const formatted = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
            weekday: 'long',
        }).format(now);
        return `${formatted} (${tz})`;
    } catch {
        return `${now.toISOString()} (UTC)`;
    }
}

// ---- Weather (best-effort, no API key: Open-Meteo) -----------------------
// Geocodes the parent-entered city once, then fetches current conditions.
// Cached in-process for WEATHER_TTL_MS per city so we don't hit Open-Meteo
// on every session.start. Never blocks/fails the session — any error just
// means no weather line is added to the prompt.
const WEATHER_TTL_MS = 30 * 60 * 1000;
const weatherCache = new Map(); // city (lowercased) -> { text, expiresAt }
const WEATHER_CODE_TEXT = {
    0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
    45: 'fog', 48: 'fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
    61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow',
    75: 'heavy snow', 80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers',
    95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};

async function fetchWeather(city) {
    const key = String(city || '').trim().toLowerCase();
    if (!key) return null;
    const cached = weatherCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.text;
    try {
        const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`);
        const geo = await geoRes.json();
        const place = geo?.results?.[0];
        if (!place) return null;
        const forecastRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code`);
        const forecast = await forecastRes.json();
        const current = forecast?.current;
        if (!current || typeof current.temperature_2m !== 'number') return null;
        const description = WEATHER_CODE_TEXT[current.weather_code] || 'unknown conditions';
        const text = `${place.name}: ${Math.round(current.temperature_2m)}°C, ${description}.`;
        weatherCache.set(key, { text, expiresAt: Date.now() + WEATHER_TTL_MS });
        return text;
    } catch {
        return null;
    }
}

function createCancellation() {
    return {
        cancelled: false,
        reason: null,
        cancelledAt: 0,
        cancel(reason) {
            this.cancelled = true;
            this.reason = reason;
            this.cancelledAt = Date.now();
        },
    };
}

function createGeneration({ turnId }) {
    return {
        turnId,
        generationId: id('generation'),
        responseId: null,
        status: 'pending',
        responseCreatedSent: false,
        cancel: createCancellation(),
        timeoutTimer: null,
        timeoutLogged: false,
        providerRetryAttempted: false,
        inputEndedAt: 0,
        firstInputTranscriptionAt: 0,
        firstModelEventAt: 0,
        firstValidAudioAt: 0,
        userTranscriptBuffer: '',
        memoryExtractionStarted: false,
    };
}

// ---- Live connection registry (per deviceId) ------------------------------
// Lets HTTP endpoints (server.js GET /api/session-status/:deviceId) answer
// "is this device's realtime session currently connected right now" — the
// parent panel previously had no way to know this at all (its "Realtime-
// соединение"/"Gemini Live" status chips were hardcoded static text, always
// showing "not connected" regardless of whether Browser Lab or a real ESP32
// was actually connected). deviceId -> Map<sessionId, connectionInfo>;
// connectionInfo is a live, mutated-in-place object so provider/ready
// updates don't require re-registering.
const activeConnectionsByDevice = new Map();

function registerConnection(deviceId, sessionId, connectionInfo) {
    if (!activeConnectionsByDevice.has(deviceId)) activeConnectionsByDevice.set(deviceId, new Map());
    activeConnectionsByDevice.get(deviceId).set(sessionId, connectionInfo);
}

function unregisterConnection(deviceId, sessionId) {
    const bucket = activeConnectionsByDevice.get(deviceId);
    if (!bucket) return;
    bucket.delete(sessionId);
    if (bucket.size === 0) activeConnectionsByDevice.delete(deviceId);
}

function getDeviceConnectionStatus(deviceId) {
    const bucket = activeConnectionsByDevice.get(memoryStore.normalizeDeviceId(deviceId));
    if (!bucket || bucket.size === 0) return { connected: false, sessions: 0, gemini_ready: false };
    let geminiReady = false;
    for (const info of bucket.values()) {
        if (info.provider === 'gemini' && info.ready) geminiReady = true;
    }
    return { connected: true, sessions: bucket.size, gemini_ready: geminiReady };
}

function attachRealtimeServer(server, options = {}) {
    const defaultProvider = new MockRealtimeProvider(options.mockConfig || DEFAULT_CONFIG);
    const providerFactory = options.providerFactory || ((sessionOptions = {}) => defaultProvider.createSession(sessionOptions));
    const providerMetadata = options.providerMetadata || { provider: 'mock', model: 'mock' };

    if (memoryEnabledFromEnv()) {
        memoryStore.init()
            .then(() => console.log('[Realtime] memory store ready'))
            .catch((error) => console.error('[Realtime] memory store init failed:', error.message));
    }

    server.on('upgrade', (req, socket) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname !== '/realtime') {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }

        if (!acceptWebSocket(req, socket)) return;
        createRealtimeSession(socket, providerFactory, providerMetadata);
    });
}

function createRealtimeSession(socket, providerFactory, providerMetadata = {}) {
    const sessionId = id('session');
    const connectedAt = Date.now();
    let sessionVoiceName = normalizeProviderVoiceName(providerMetadata.defaultVoiceName || providerMetadata.voiceName);
    let sessionVoiceConfigSource = sessionVoiceName
        ? (providerMetadata.defaultVoiceConfigSource || (providerMetadata.defaultVoiceName ? 'default' : 'metadata'))
        : 'provider_default';
    let promptBlocks = defaultPromptBlocks();
    let promptSource = 'default';
    const recentTurns = [];
    let currentTurnId = null;
    let currentGeneration = null;
    let inputStartedAt = 0;
    let inputEndedAt = 0;
    let inputBytes = 0;
    let currentInputChunks = [];
    let currentInputBufferedBytes = 0;
    let sessionInputBytes = 0;
    let currentMode = 'push_to_talk';
    let turnCounter = 0;
    let socketClosed = false;
    let providerClosed = false;
    let readySent = false;
    const rotationMode = normalizeRotationMode(providerMetadata.rotationMode);
    let providerSessionReuseCount = 0;
    let providerRotationCount = 0;
    let promptApplyCount = 0;
    let lateProviderEventsDropped = 0;
    let sessionLanguage = null;
    let pendingLanguageSwitch = null;
    let pendingLanguageCandidate = null;
    const contentToolsEnabled = areContentToolsEnabled(providerMetadata.contentToolsEnabled);
    const contentLibrary = providerMetadata.contentLibrary || createContentLibrary(providerMetadata.contentLibraryOptions || {});
    let activeActivity = null;
    // Set from device_settings.allowed_content at session.start (see below).
    // null means "no device settings fetched yet / memory disabled" — content
    // tools are not gated in that case, matching pre-memory behavior.
    let allowedContentSettings = null;
    // Live date/time/weather for the [CURRENT CONTEXT] prompt block, refreshed
    // on every session.start from device_settings.timezone/city (see below).
    let cachedLocalDateTime = null;
    let cachedWeatherText = null;
    // ---- Microphone input resampling state ----
    // Configured explicitly on every session.start from
    // resolveInputSampleRate() (sampleRate/sample_rate in the payload).
    // inputResampler is a fresh Pcm16MonoResampler for the currently
    // declared inputSampleRate; at 16000 it's a byte-identical pass-through,
    // at 24000 it actually resamples down to GEMINI_INPUT_SAMPLE_RATE.
    // Reset points: startInput() (new turn), endInput() (flush the tail
    // before providerSession.endInput()), session.interrupt, and on a
    // decode error (see onBinary below) — see requirements in
    // inputAudioResampling.js/pcm16Resampler.js.
    let inputSampleRate = GEMINI_INPUT_SAMPLE_RATE;
    let inputSampleRateSource = 'assumed_default_no_sample_rate';
    let inputResampler = createInputResampler(inputSampleRate);
    let providerSession = providerFactory(buildProviderSessionOptions('initial'));
    let deviceId = memoryStore.normalizeDeviceId();
    const memoryEnabledFlag = memoryEnabledFromEnv();

    // Live connection status for this device (see registry above) — mutated
    // in place as the provider rotates / becomes ready, moved between
    // device buckets if session.start declares a different deviceId.
    const connectionInfo = { provider: providerSession.name || 'mock', ready: false };
    registerConnection(deviceId, sessionId, connectionInfo);

    // ---- Usage tracking / working-hours enforcement state ----
    // usageSessionId is created lazily on the first successful session.start
    // (once we know the real deviceId) and reused across rotations within
    // this same socket connection. lastUsageTickAt anchors the periodic
    // flush so we only ever add the seconds actually elapsed, even if a
    // tick is delayed under load.
    let usageSessionId = null;
    let usageSessionStartedAt = 0;
    let lastUsageTickAt = 0;
    let cachedDeviceSettings = null;
    let lastBreakReminderMinuteMark = 0;
    let usageTickTimer = null;
    let sessionBlocked = false;

    async function flushUsageTicks(finalFlush = false) {
        if (!memoryEnabledFlag || !usageSessionId) return;
        const now = Date.now();
        const elapsedSeconds = lastUsageTickAt ? (now - lastUsageTickAt) / 1000 : 0;
        lastUsageTickAt = now;
        try {
            if (elapsedSeconds > 0) {
                await memoryStore.addUsageSeconds(usageSessionId, elapsedSeconds);
            }
            if (finalFlush) {
                await memoryStore.endUsageSession(usageSessionId);
            }
        } catch (error) {
            log('usage_tick_error', { message: error.message });
        }
    }

    // Runs on every session.start and on a periodic timer while a session
    // is open. Returns { blocked, reason, message } — blocked=true means the
    // caller must refuse/terminate the connection right now.
    async function evaluateUsagePolicy() {
        if (!memoryEnabledFlag) return { blocked: false };
        const settings = cachedDeviceSettings || await fetchDeviceSettings(deviceId);
        if (!settings) return { blocked: false };
        cachedDeviceSettings = settings;

        if (isWithinNightWindow(settings, new Date())) {
            return {
                blocked: true,
                reason: 'night_mode',
                message: `It's quiet hours (${settings.night_mode_start}-${settings.night_mode_end}). Time to rest — try again after night mode ends.`,
            };
        }
        if (settings.daily_limit_enabled && settings.daily_limit_minutes > 0) {
            const usedMinutes = await memoryStore.getUsageMinutesToday(deviceId, settings.timezone);
            if (usedMinutes >= settings.daily_limit_minutes) {
                return {
                    blocked: true,
                    reason: 'daily_limit',
                    message: `Today's play time limit of ${settings.daily_limit_minutes} minutes has been reached. See you tomorrow!`,
                };
            }
        }
        return { blocked: false };
    }

    function maybeSendBreakReminder(settings) {
        if (!settings || !settings.break_reminder_minutes || settings.break_reminder_minutes <= 0) return;
        if (!usageSessionStartedAt) return;
        const elapsedMinutes = (Date.now() - usageSessionStartedAt) / 60000;
        const mark = Math.floor(elapsedMinutes / settings.break_reminder_minutes);
        if (mark > 0 && mark > lastBreakReminderMinuteMark) {
            lastBreakReminderMinuteMark = mark;
            emit({
                type: 'break_reminder',
                minutes_elapsed: Math.floor(elapsedMinutes),
                break_reminder_minutes: settings.break_reminder_minutes,
                message: 'You have been playing for a while — how about a short break?',
            });
            log('break_reminder_sent', { deviceId, elapsedMinutes: Math.floor(elapsedMinutes) });
        }
    }

    async function enforcementTick() {
        if (!memoryEnabledFlag || !usageSessionId || sessionBlocked || socketClosed) return;
        await flushUsageTicks(false);
        const policy = await evaluateUsagePolicy();
        if (policy.blocked) {
            terminateForPolicy(policy);
            return;
        }
        maybeSendBreakReminder(cachedDeviceSettings);
    }

    function terminateForPolicy(policy) {
        if (sessionBlocked) return;
        sessionBlocked = true;
        emit({
            type: 'session.blocked',
            reason: policy.reason,
            message: policy.message,
        });
        log('session_blocked', { deviceId, reason: policy.reason });
        flushUsageTicks(true).finally(() => {
            closeProvider('policy_' + policy.reason);
            sendClose(socket);
        });
    }

    usageTickTimer = setInterval(() => {
        enforcementTick().catch((error) => log('enforcement_tick_error', { message: error.message }));
    }, 20000);
    if (typeof usageTickTimer.unref === 'function') usageTickTimer.unref();

    async function fetchChildContext(forDeviceId) {
        try {
            const { profile, facts } = await memoryStore.getProfileWithFacts(forDeviceId);
            if (profile && profile.memory_enabled === false) return null;
            return memoryStore.formatChildContext({ profile, facts });
        } catch (error) {
            log('memory_fetch_error', { deviceId: forDeviceId, message: error.message });
            return null;
        }
    }

    async function fetchDeviceSettings(forDeviceId) {
        try {
            return await memoryStore.getOrCreateSettings(forDeviceId);
        } catch (error) {
            log('settings_fetch_error', { deviceId: forDeviceId, message: error.message });
            return null;
        }
    }

    // Fire-and-forget: never blocks the voice reply. Runs guard.looksMemorable()
    // first so most turns never reach the LLM extraction call at all.
    function maybeExtractMemory(generation) {
        if (!memoryEnabledFlag || generation.memoryExtractionStarted) return;
        generation.memoryExtractionStarted = true;
        const text = generation.userTranscriptBuffer;
        const afterPlaybackMs = generation.firstValidAudioAt ? Date.now() - generation.firstValidAudioAt : null;
        if (!memoryGuard.looksMemorable(text, { afterPlaybackMs })) return;

        (async () => {
            try {
                const { profile } = await memoryStore.getProfileWithFacts(deviceId);
                if (profile && profile.memory_enabled === false) return;
                const raw = await extractMemoryActions({ text });
                const { actions, droppedCount } = memoryGuard.filterUnsafeActions(raw);
                if (droppedCount) {
                    log('memory_guard_dropped', { deviceId, droppedCount });
                }
                for (const fact of actions.add) {
                    await memoryStore.addFact(deviceId, { label: fact.label, value: fact.value, source: 'auto' });
                }
                if (actions.add.length) {
                    log('memory_facts_added', { deviceId, count: actions.add.length });
                }
            } catch (error) {
                log('memory_extraction_error', { deviceId, message: error.message });
            }
        })();
    }

    function log(stage, extra = {}) {
        const details = Object.entries(extra)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
        console.log(`[Realtime] session=${sessionId} stage=${stage} ${details}`.trim());
    }

    function emit(payload) {
        if (socketClosed || socket.destroyed) return false;
        if (payload.type === 'session.ready') {
            readySent = true;
            connectionInfo.ready = true;
            connectionInfo.provider = providerSession.name || connectionInfo.provider;
        }
        return sendJson(socket, {
            session_id: sessionId,
            server_time_ms: Date.now(),
            ...payload,
        });
    }

    function rememberTurn(role, text) {
        const clean = String(text || '').trim();
        if (!clean) return;
        recentTurns.push({ role, text: clean.slice(0, 240) });
        while (recentTurns.length > 12) recentTurns.shift();
    }

    function buildPromptBundle() {
        return buildRealtimeSystemInstruction({
            ...promptBlocks,
            currentContext: {
                mode: currentMode,
                sessionLanguage: sessionLanguage || 'auto',
                languageInstruction: sessionLanguage
                    ? `Continue in the last clearly understood child language: ${sessionLanguage}. Keep the same voice identity.`
                    : 'No stable child language has been established yet. Follow the last clearly understood child utterance.',
                recentTurns,
                localDateTime: cachedLocalDateTime,
                weather: cachedWeatherText,
            },
        });
    }

    function buildProviderSessionOptions(rotationReason) {
        const prompt = buildPromptBundle();
        return {
            voiceName: sessionVoiceName || undefined,
            voiceConfigSource: sessionVoiceConfigSource,
            systemInstructionText: prompt.text,
            systemInstructionMeta: prompt.meta,
            promptSource,
            rotationReason,
            rotationMode,
            contentToolsEnabled,
            toolHandlers: contentToolsEnabled ? {
                get_riddle: handleGetRiddleTool,
            } : {},
        };
    }

    function handleGetRiddleTool({ args = {}, generationId, turnId, providerInstanceId }) {
        if (!currentGeneration || currentGeneration.generationId !== generationId) {
            log('riddle_tool_rejected', {
                reason: 'stale_generation',
                generationId: generationId || 'none',
                activeGenerationId: currentGeneration?.generationId || 'none',
                providerInstanceId: providerInstanceId || 'unknown',
            });
            return { error: 'stale_generation' };
        }
        if (activeActivity?.type === 'riddle') {
            log('riddle_tool_rejected', {
                reason: 'active_riddle_in_progress',
                generationId,
                turnId,
                contentId: activeActivity.contentId,
                providerInstanceId: providerInstanceId || 'unknown',
            });
            return {
                error: 'active_riddle_in_progress',
                active_activity_type: activeActivity.type,
                content_id: activeActivity.contentId,
            };
        }

        const riddle = contentLibrary.getRiddle({
            language: args.language || sessionLanguage || 'ru',
            topic: args.topic || args.query || '',
            query: args.topic || args.query || '',
            tags: Array.isArray(args.tags) ? args.tags : [],
        });
        if (!riddle) {
            log('riddle_tool_rejected', {
                reason: 'no_riddle_available',
                generationId,
                turnId,
                providerInstanceId: providerInstanceId || 'unknown',
            });
            return { error: 'no_riddle_available' };
        }

        activeActivity = {
            type: 'riddle',
            contentId: riddle.id,
            expectedAnswers: [...riddle.answers],
            hints: Array.isArray(riddle.hints) ? [...riddle.hints] : [],
            language: riddle.language,
            topic: riddle.topic || '',
            source: riddle.source || 'library',
            attempts: 0,
            generationId,
            turnId,
        };
        log('riddle_tool_selected', {
            generationId,
            turnId,
            contentId: riddle.id,
            answerCount: riddle.answers.length,
            source: riddle.source || 'library',
            topic: riddle.topic || '',
            providerInstanceId: providerInstanceId || 'unknown',
        });
        emit({
            type: 'activity.started',
            activity_type: 'riddle',
            content_id: riddle.id,
            generation_id: generationId,
            turn_id: turnId,
        });
        return {
            id: riddle.id,
            type: riddle.type || 'riddle',
            text: riddle.text,
            answers: Array.isArray(riddle.answers) ? riddle.answers : [],
            hints: Array.isArray(riddle.hints) ? riddle.hints : [],
            language: riddle.language,
            topic: riddle.topic || '',
            source: riddle.source || 'library',
        };
    }

    function maybeHandleActiveActivityAnswer(generation, text) {
        if (!activeActivity || activeActivity.type !== 'riddle') return false;
        if (!generation || generation !== currentGeneration) return false;
        const result = contentLibrary.checkRiddleAnswer(activeActivity, text);
        if (!result.handled) return false;

        const contentId = activeActivity.contentId;
        activeActivity.attempts = result.attempts;
        if (result.completed) {
            activeActivity = null;
        }

        log('riddle_answer_checked', {
            generationId: generation.generationId,
            turnId: generation.turnId,
            contentId,
            correct: result.correct,
            attempts: result.attempts,
            completed: result.completed,
        });
        emit({
            type: 'activity.answer_checked',
            activity_type: 'riddle',
            content_id: contentId,
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
            correct: result.correct,
            attempts: result.attempts,
            completed: result.completed,
            hint: result.hint || null,
        });
        if (typeof providerSession?.sendActivityResult === 'function') {
            providerSession.sendActivityResult(result);
        }
        return true;
    }
    function safePromptPayload() {
        const prompt = buildPromptBundle();
        return {
            allow_custom_prompt: LAB_ALLOW_CUSTOM_PROMPT,
            max_chars: LAB_PROMPT_MAX_CHARS,
            source: promptSource,
            defaults: defaultPromptBlocks(),
            current_context: prompt.blocks.currentContext,
            meta: prompt.meta,
        };
    }

    function emitPromptApplied(reason) {
        const prompt = buildPromptBundle();
        emit({
            type: 'session.config.applied',
            reason,
            prompt_source: promptSource,
            // Non-silent surface for the microphone input sample-rate the
            // server is using for THIS connection — lets an ESP32 that
            // forgot to send sampleRate see explicitly what was assumed,
            // instead of the assumption being invisible.
            input_audio: {
                sample_rate: inputSampleRate,
                sample_rate_source: inputSampleRateSource,
                gemini_input_sample_rate: GEMINI_INPUT_SAMPLE_RATE,
            },
            lab_prompt: {
                allow_custom_prompt: LAB_ALLOW_CUSTOM_PROMPT,
                max_chars: LAB_PROMPT_MAX_CHARS,
                current_context: prompt.blocks.currentContext,
                meta: prompt.meta,
                // Actual text that was applied to this session (may come from
                // device_settings/child_profiles in Postgres, not just the
                // client-sent config or hardcoded defaults) — lets the Lab UI
                // show what's really driving the model instead of only hashes.
                applied_blocks: {
                    core_prompt: prompt.blocks.corePrompt,
                    child_context: prompt.blocks.childContext,
                    parent_rules: prompt.blocks.parentRules,
                },
            },
        });
        log('prompt_config_applied', {
            reason,
            promptSource,
            promptChars: prompt.meta.promptChars,
            promptHash: prompt.meta.promptHash,
            corePromptChars: prompt.meta.corePrompt.chars,
            corePromptHash: prompt.meta.corePrompt.hash,
            childContextChars: prompt.meta.childContext.chars,
            childContextHash: prompt.meta.childContext.hash,
            parentRulesChars: prompt.meta.parentRules.chars,
            parentRulesHash: prompt.meta.parentRules.hash,
            currentContextChars: prompt.meta.currentContext.chars,
            currentContextHash: prompt.meta.currentContext.hash,
        });
    }

    function scheduleLanguageSwitch(previousLanguage, nextLanguage, generation, signal, reason, confirmationCount) {
        sessionLanguage = nextLanguage;
        pendingLanguageSwitch = {
            from: previousLanguage,
            to: nextLanguage,
            detectedAt: Date.now(),
            generationId: generation?.generationId || null,
            turnId: generation?.turnId || null,
        };
        pendingLanguageCandidate = null;
        log('language_switch_detected', {
            generationId: generation?.generationId || 'none',
            turnId: generation?.turnId || 'none',
            from: previousLanguage,
            to: nextLanguage,
            significantWordCount: signal.significantWordCount,
            confirmationCount,
            reason,
            action: 'rotate_before_next_turn',
        });
        emit({
            type: 'language.switch_detected',
            from_language: previousLanguage,
            to_language: nextLanguage,
            generation_id: generation?.generationId || null,
            turn_id: generation?.turnId || null,
            significant_word_count: signal.significantWordCount,
            confirmation_count: confirmationCount,
            reason,
            action: 'rotate_before_next_turn',
        });
    }

    function noteUserLanguage(text, generation) {
        const signal = detectLanguageSignal(text);
        if (!signal) return;
        const detectedLanguage = signal.language;
        const previousLanguage = sessionLanguage;
        if (!previousLanguage) {
            if (!signal.confident) {
                pendingLanguageCandidate = pendingLanguageCandidate?.language === detectedLanguage
                    ? { language: detectedLanguage, count: pendingLanguageCandidate.count + 1 }
                    : { language: detectedLanguage, count: 1 };
                if (pendingLanguageCandidate.count < LANGUAGE_SWITCH_CONFIRMATIONS) {
                    log('language_candidate_waiting', {
                        generationId: generation?.generationId || 'none',
                        turnId: generation?.turnId || 'none',
                        language: detectedLanguage,
                        significantWordCount: signal.significantWordCount,
                        confirmationCount: pendingLanguageCandidate.count,
                        action: 'wait_for_confirmation',
                    });
                    return;
                }
            }
            sessionLanguage = detectedLanguage;
            pendingLanguageCandidate = null;
            log('language_detected', {
                generationId: generation?.generationId || 'none',
                turnId: generation?.turnId || 'none',
                language: detectedLanguage,
                significantWordCount: signal.significantWordCount,
                confirmationCount: signal.confident ? 1 : LANGUAGE_SWITCH_CONFIRMATIONS,
                action: signal.confident ? 'set_initial' : 'set_initial_confirmed',
            });
            return;
        }
        if (previousLanguage === detectedLanguage) {
            pendingLanguageCandidate = null;
            return;
        }
        if (signal.confident) {
            scheduleLanguageSwitch(previousLanguage, detectedLanguage, generation, signal, 'confident_transcript', 1);
            return;
        }
        pendingLanguageCandidate = pendingLanguageCandidate?.from === previousLanguage && pendingLanguageCandidate?.to === detectedLanguage
            ? { from: previousLanguage, to: detectedLanguage, count: pendingLanguageCandidate.count + 1 }
            : { from: previousLanguage, to: detectedLanguage, count: 1 };
        log('language_switch_candidate', {
            generationId: generation?.generationId || 'none',
            turnId: generation?.turnId || 'none',
            from: previousLanguage,
            to: detectedLanguage,
            significantWordCount: signal.significantWordCount,
            confirmationCount: pendingLanguageCandidate.count,
            action: 'wait_for_confirmation',
        });
        if (pendingLanguageCandidate.count >= LANGUAGE_SWITCH_CONFIRMATIONS) {
            scheduleLanguageSwitch(
                previousLanguage,
                detectedLanguage,
                generation,
                signal,
                'consecutive_confirmation',
                pendingLanguageCandidate.count,
            );
        }
    }

    function applyPendingLanguageSwitchBeforeInput() {
        if (!pendingLanguageSwitch) return;
        const languageSwitch = pendingLanguageSwitch;
        pendingLanguageSwitch = null;
        log('language_switch_rotation_started', {
            from: languageSwitch.from,
            to: languageSwitch.to,
            previousGenerationId: languageSwitch.generationId || 'none',
            previousTurnId: languageSwitch.turnId || 'none',
            providerInstanceId: providerSession?.instanceId || 'unknown',
        });
        rotateProviderSession('language_switch');
        warmProviderSession('language_switch').catch((error) => {
            log('provider_warm_error', {
                reason: 'language_switch',
                message: error.message,
            });
        });
    }

    function droppedProviderEvent(generation, eventType, reason) {
        lateProviderEventsDropped += 1;
        log('dropped_provider_event', {
            generationId: generation?.generationId || 'none',
            responseId: generation?.responseId || 'none',
            eventType,
            reason,
            lateProviderEventsDropped,
        });
    }

    function clearGenerationTimeout(generation) {
        if (!generation?.timeoutTimer) return;
        clearTimeout(generation.timeoutTimer);
        generation.timeoutTimer = null;
    }

    function armPttTurnTimeout(generation) {
        if (!generation || currentMode !== 'push_to_talk') return;
        clearGenerationTimeout(generation);
        const timeoutMs = Math.max(0, Number(process.env.PTT_TURN_TIMEOUT_MS || 4500));
        if (timeoutMs <= 0) return;
        generation.timeoutTimer = setTimeout(() => {
            if (
                generation.status === 'pending'
                && !generation.responseCreatedSent
                && !generation.cancel.cancelled
            ) {
                recoverFromTurnTimeout(generation, timeoutMs).catch((error) => {
                    log('turn_timeout_recovery_error', {
                        generationId: generation.generationId,
                        turnId: generation.turnId,
                        message: error.message,
                    });
                });
            }
        }, timeoutMs);
    }

    function buildProviderContext(generation) {
        return {
            generationId: generation.generationId,
            responseId: generation.responseId,
            turnId: generation.turnId,
            turnInputBytes: inputBytes,
            sessionInputBytes,
            mode: currentMode,
            signal: generation.cancel,
            onSessionEvent: (event) => emit(event),
            isGenerationActive: () => (
                currentGeneration === generation
                && generation.status !== 'cancelled'
                && generation.status !== 'completed'
                && generation.status !== 'failed'
                && !generation.cancel.cancelled
            ),
            onEvent: (event) => emitProviderEvent(generation, event),
            onAudioChunk: (event) => emitProviderEvent(generation, event),
            log,
        };
    }

    async function warmProviderSession(reason) {
        if (typeof providerSession?.connect !== 'function') return;
        await providerSession.connect(log);
        promptApplyCount += 1;
        log('provider_ready', {
            reason,
            provider: providerSession.name || 'provider',
            providerInstanceId: providerSession.instanceId || 'unknown',
            voiceName: providerSession.voiceName || sessionVoiceName || 'none',
            rotationMode,
            promptApplyCount,
        });
        log('provider_voice_config', {
            clientSessionId: sessionId,
            providerInstanceId: providerSession.instanceId || 'unknown',
            voiceName: providerSession.voiceName || sessionVoiceName || 'none',
            configSource: providerSession.voiceConfigSource || sessionVoiceConfigSource,
            inheritedFromPreviousProvider: reason !== 'initial',
            rotationReason: reason,
            rotationMode,
            providerRotationCount,
            promptApplyCount,
        });
        log('provider_prompt_config', {
            clientSessionId: sessionId,
            providerInstanceId: providerSession.instanceId || 'unknown',
            promptSource: providerSession.promptSource || promptSource,
            rotationReason: providerSession.rotationReason || reason,
            promptChars: providerSession.systemInstructionMeta?.promptChars || 0,
            promptHash: providerSession.systemInstructionMeta?.promptHash || 'none',
            corePromptChars: providerSession.systemInstructionMeta?.corePrompt?.chars || 0,
            corePromptHash: providerSession.systemInstructionMeta?.corePrompt?.hash || 'none',
            childContextChars: providerSession.systemInstructionMeta?.childContext?.chars || 0,
            childContextHash: providerSession.systemInstructionMeta?.childContext?.hash || 'none',
            parentRulesChars: providerSession.systemInstructionMeta?.parentRules?.chars || 0,
            parentRulesHash: providerSession.systemInstructionMeta?.parentRules?.hash || 'none',
            rotationMode,
            providerRotationCount,
            promptApplyCount,
            currentContextChars: providerSession.systemInstructionMeta?.currentContext?.chars || 0,
            currentContextHash: providerSession.systemInstructionMeta?.currentContext?.hash || 'none',
        });
        emit({
            type: 'provider.ready',
            reason,
            provider: providerSession.name || 'provider',
            provider_instance_id: providerSession.instanceId || null,
        });
    }

    async function recoverFromTurnTimeout(generation, timeoutMs) {
        if (generation !== currentGeneration) {
            droppedProviderEvent(generation, 'ptt_turn_timeout', 'stale_generation');
            return;
        }
        generation.timeoutLogged = true;
        generation.status = 'failed';
        generation.cancel.cancel('provider_timeout');
        clearGenerationTimeout(generation);
        log('ptt_turn_timeout', {
            generationId: generation.generationId,
            responseId: generation.responseId,
            turnId: generation.turnId,
            timeoutMs,
            turnInputBytes: inputBytes,
            sessionInputBytes,
        });
        emit({
            type: 'response.failed',
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
            reason: 'provider_timeout',
            timeout_ms: timeoutMs,
        });

        const startedAt = Date.now();
        const oldProviderInstanceId = providerSession?.instanceId || 'unknown';
        log('turn_timeout_recovery_started', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
        });
        rotateProviderSession('provider_timeout');
        await warmProviderSession('provider_timeout');
        log('turn_timeout_recovery_completed', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
            newProviderInstanceId: providerSession?.instanceId || 'unknown',
            elapsedMs: Date.now() - startedAt,
        });
    }

    async function recoverFromProviderFailure(generation, reason, payload = {}) {
        if (generation !== currentGeneration) {
            droppedProviderEvent(generation, 'response.failed', 'stale_generation');
            return;
        }
        if (await retryGenerationOnFreshProvider(generation, reason)) {
            return;
        }
        generation.status = 'failed';
        generation.cancel.cancel(reason);
        clearGenerationTimeout(generation);
        log('response_failed', {
            generationId: generation.generationId,
            responseId: generation.responseId,
            turnId: generation.turnId,
            reason,
            providerInstanceId: providerSession?.instanceId || 'unknown',
        });
        emit({
            ...payload,
            type: 'response.failed',
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
            reason,
        });

        const startedAt = Date.now();
        const oldProviderInstanceId = providerSession?.instanceId || 'unknown';
        log('turn_timeout_recovery_started', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
            reason,
        });
        rotateProviderSession(reason);
        await warmProviderSession(reason);
        log('turn_timeout_recovery_completed', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
            newProviderInstanceId: providerSession?.instanceId || 'unknown',
            elapsedMs: Date.now() - startedAt,
            reason,
        });
    }

    async function retryGenerationOnFreshProvider(generation, reason) {
        const retryableReasons = new Set([
            'provider_turn_closed_before_output',
            'provider_turn_closed_during_input',
        ]);
        if (!retryableReasons.has(reason)) return false;
        if (generation.providerRetryAttempted) return false;
        if (!generation.inputEndedAt) return false;
        if (generation.responseCreatedSent) return false;
        if (currentInputChunks.length === 0 || currentInputBufferedBytes <= 0) return false;
        if (generation.cancel.cancelled || generation.status === 'cancelled' || generation.status === 'completed') return false;

        generation.providerRetryAttempted = true;
        clearGenerationTimeout(generation);
        const oldProviderInstanceId = providerSession?.instanceId || 'unknown';
        const startedAt = Date.now();
        log('provider_turn_retry_started', {
            generationId: generation.generationId,
            turnId: generation.turnId,
            reason,
            oldProviderInstanceId,
            replayChunks: currentInputChunks.length,
            replayBytes: currentInputBufferedBytes,
        });

        rotateProviderSession(reason);
        generation.cancel = createCancellation();
        generation.status = 'pending';
        const retryContext = buildProviderContext(generation);
        if (typeof providerSession.beginResponse === 'function') {
            providerSession.beginResponse(retryContext);
        }
        for (const chunk of currentInputChunks) {
            if (generation !== currentGeneration || generation.cancel.cancelled) {
                droppedProviderEvent(generation, 'provider_retry_audio', 'stale_generation');
                return true;
            }
            providerSession.sendAudio(chunk);
        }
        armPttTurnTimeout(generation);
        providerSession.endInput(retryContext).catch((error) => {
            recoverFromProviderFailure(generation, 'provider_retry_error', {
                type: 'response.failed',
                reason: 'provider_retry_error',
                message: error.message,
            }).catch((recoveryError) => {
                log('turn_retry_recovery_error', {
                    generationId: generation.generationId,
                    turnId: generation.turnId,
                    message: recoveryError.message,
                });
            });
        });
        log('provider_turn_retry_dispatched', {
            generationId: generation.generationId,
            turnId: generation.turnId,
            reason,
            oldProviderInstanceId,
            newProviderInstanceId: providerSession?.instanceId || 'unknown',
            replayChunks: currentInputChunks.length,
            replayBytes: currentInputBufferedBytes,
            elapsedMs: Date.now() - startedAt,
        });
        return true;
    }

    function emitResponseCreated(generation, cause) {
        if (!generation || generation.responseCreatedSent) return;
        if (generation.status === 'cancelled' || generation.status === 'completed') {
            droppedProviderEvent(generation, 'response.created', 'terminal_generation');
            return;
        }
        generation.responseId = generation.responseId || id('response');
        clearGenerationTimeout(generation);
        generation.responseCreatedSent = true;
        generation.status = 'active';
        emit({
            type: 'response.created',
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
            cause,
            turn_input_bytes: inputBytes,
            session_input_bytes: sessionInputBytes,
        });
    }

    function emitProviderEvent(generation, payload) {
        if (!generation) return false;
        const eventType = payload?.type || 'unknown';
        const modelOutputEvents = new Set(['transcript.model', 'audio.start', 'audio.chunk', 'audio.end']);
        const startsGenerationEvents = new Set(['transcript.model', 'audio.start', 'audio.chunk']);
        if (eventType === 'provider_interrupt_ack') {
            return emit(payload);
        }
        if (eventType === 'provider.dropped_event') {
            droppedProviderEvent(generation, payload.event_type || 'unknown', payload.reason || 'provider_dropped_event');
            return true;
        }
        if (eventType === 'response.failed') {
            recoverFromProviderFailure(generation, payload.reason || 'provider_failed', payload).catch((error) => {
                log('turn_timeout_recovery_error', {
                    generationId: generation.generationId,
                    turnId: generation.turnId,
                    message: error.message,
                });
            });
            return true;
        }
        if (generation.status === 'cancelled' || generation.status === 'completed' || generation.status === 'failed') {
            if (modelOutputEvents.has(eventType)) {
                droppedProviderEvent(generation, eventType, 'terminal_generation');
            }
            return false;
        }
        if (eventType === 'transcript.user') {
            // Gemini streams inputTranscription as incremental fragments, not one
            // final string — accumulate every fragment for this generation so
            // memory extraction (triggered later, at audio.end) sees the full
            // user turn, not just the first partial chunk.
            generation.userTranscriptBuffer += String(payload.text || '');
        }
        if (eventType === 'transcript.user' && generation.inputEndedAt && !generation.firstInputTranscriptionAt) {
            rememberTurn('user', payload.text);
            noteUserLanguage(payload.text, generation);
            generation.firstInputTranscriptionAt = Date.now();
            log('provider_input_transcription_received', {
                generationId: generation.generationId,
                turnId: generation.turnId,
                inputEndToInputTranscriptionMs: generation.firstInputTranscriptionAt - generation.inputEndedAt,
            });
            maybeHandleActiveActivityAnswer(generation, payload.text);
        }
        if (startsGenerationEvents.has(eventType) && generation.inputEndedAt && !generation.firstModelEventAt) {
            generation.firstModelEventAt = Date.now();
            log('provider_first_model_event', {
                generationId: generation.generationId,
                turnId: generation.turnId,
                eventType,
                inputEndToFirstModelEventMs: generation.firstModelEventAt - generation.inputEndedAt,
            });
        }
        if (eventType === 'audio.start' && generation.inputEndedAt && !generation.firstValidAudioAt) {
            generation.firstValidAudioAt = Date.now();
            log('provider_first_valid_audio', {
                generationId: generation.generationId,
                turnId: generation.turnId,
                inputEndToFirstValidAudioMs: generation.firstValidAudioAt - generation.inputEndedAt,
            });
        }
        if (eventType === 'transcript.model') {
            rememberTurn('assistant', payload.text);
        }
        if (startsGenerationEvents.has(eventType)) {
            emitResponseCreated(generation, eventType);
        }
        if (eventType === 'response.cancelled') {
            generation.status = 'cancelled';
            clearGenerationTimeout(generation);
        }
        const shouldRotateAfterAudioEnd = eventType === 'audio.end' && shouldRotateProviderAfterOutputComplete();
        if (eventType === 'audio.end') {
            generation.status = 'completed';
            clearGenerationTimeout(generation);
            maybeExtractMemory(generation);
        }
        const emitted = emit({
            ...payload,
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
        });
        if (shouldRotateAfterAudioEnd && generation === currentGeneration) {
            rotateProviderSession(payload.cause === 'turnComplete'
                ? 'output_turn_complete'
                : 'output_generation_complete');
            warmProviderSession('output_complete').catch((error) => {
                log('provider_warm_error', {
                    reason: 'output_complete',
                    message: error.message,
                });
            });
        } else if (eventType === 'audio.end' && generation === currentGeneration && rotationMode === 'errors_only') {
            providerSessionReuseCount += 1;
            log('provider_session_reused', {
                reason: payload.cause || 'audio_end',
                providerInstanceId: providerSession?.instanceId || 'unknown',
                providerSessionReuseCount,
                providerRotationCount,
                promptApplyCount,
                turnCount: turnCounter,
                lateProviderEventsDropped,
            });
        }
        return emitted;
    }

    function cancelCurrent(reason) {
        if (
            !currentGeneration
            || currentGeneration.status === 'cancelled'
            || currentGeneration.status === 'completed'
            || currentGeneration.status === 'failed'
        ) return false;
        const cancelRequestedAt = Date.now();
        currentGeneration.cancel.cancel(reason);
        providerSession.interrupt(reason, {
            interrupted_generation_id: currentGeneration.generationId,
            interrupted_turn_id: currentGeneration.turnId,
            interrupted_response_id: currentGeneration.responseId,
            provider_instance_id: providerSession.instanceId || null,
            interrupt_requested_at: cancelRequestedAt,
        });
        currentGeneration.status = 'cancelled';
        clearGenerationTimeout(currentGeneration);
        const cancelLatencyMs = Date.now() - cancelRequestedAt;
        emit({
            type: 'response.cancelled',
            generation_id: currentGeneration.generationId,
            response_id: currentGeneration.responseId,
            turn_id: currentGeneration.turnId,
            reason,
            cancel_latency_ms: cancelLatencyMs,
        });
        log('response_cancelled', {
            generationId: currentGeneration.generationId,
            responseId: currentGeneration.responseId,
            turnId: currentGeneration.turnId,
            reason,
            cancelLatencyMs,
        });
        return true;
    }

    function rotateProviderSession(reason) {
        providerRotationCount += 1;
        const oldProviderSession = providerSession;
        const oldProviderInstanceId = oldProviderSession?.instanceId || 'unknown';
        const oldProviderVoiceName = oldProviderSession?.voiceName || sessionVoiceName || 'none';
        try {
            if (typeof oldProviderSession.destroySession === 'function') {
                oldProviderSession.destroySession(reason);
            } else {
                oldProviderSession.close();
            }
        } catch (error) {
            log('provider_rotation_close_error', {
                reason,
                providerInstanceId: oldProviderInstanceId,
                message: error.message,
            });
        }
        providerSession = providerFactory(buildProviderSessionOptions(reason));
        connectionInfo.provider = providerSession.name || connectionInfo.provider;
        const oldPromptMeta = oldProviderSession?.systemInstructionMeta || {};
        const newPromptMeta = providerSession.systemInstructionMeta || {};
        log('provider_session_rotated', {
            reason,
            oldProviderInstanceId,
            newProviderInstanceId: providerSession.instanceId || 'unknown',
            provider: providerSession.name || 'provider',
            oldProviderVoiceName,
            newProviderVoiceName: providerSession.voiceName || sessionVoiceName || 'none',
            voicePreserved: oldProviderVoiceName === (providerSession.voiceName || sessionVoiceName || 'none'),
            oldPromptHash: oldPromptMeta.promptHash || 'none',
            newPromptHash: newPromptMeta.promptHash || 'none',
            corePromptPreserved: oldPromptMeta.corePrompt?.hash === newPromptMeta.corePrompt?.hash,
            childContextPreserved: oldPromptMeta.childContext?.hash === newPromptMeta.childContext?.hash,
            parentRulesPreserved: oldPromptMeta.parentRules?.hash === newPromptMeta.parentRules?.hash,
            rotationMode,
            providerRotationCount,
            providerSessionReuseCount,
            promptApplyCount,
        });
        emit({
            type: 'provider.rotated',
            reason,
            old_provider_instance_id: oldProviderInstanceId,
            new_provider_instance_id: providerSession.instanceId || null,
            provider: providerSession.name || 'provider',
            old_provider_voice_name: oldProviderVoiceName,
            new_provider_voice_name: providerSession.voiceName || sessionVoiceName || null,
            voice_preserved: oldProviderVoiceName === (providerSession.voiceName || sessionVoiceName || 'none'),
            old_prompt_hash: oldPromptMeta.promptHash || null,
            new_prompt_hash: newPromptMeta.promptHash || null,
            core_prompt_hash: newPromptMeta.corePrompt?.hash || null,
            child_context_hash: newPromptMeta.childContext?.hash || null,
            parent_rules_hash: newPromptMeta.parentRules?.hash || null,
            core_prompt_preserved: oldPromptMeta.corePrompt?.hash === newPromptMeta.corePrompt?.hash,
            child_context_preserved: oldPromptMeta.childContext?.hash === newPromptMeta.childContext?.hash,
            parent_rules_preserved: oldPromptMeta.parentRules?.hash === newPromptMeta.parentRules?.hash,
            rotation_mode: rotationMode,
            provider_rotation_count: providerRotationCount,
            provider_session_reuse_count: providerSessionReuseCount,
            prompt_apply_count: promptApplyCount,
        });
    }

    function shouldRotateProviderOnInterrupt() {
        return Boolean(providerSession?.rotateOnInterrupt);
    }

    function shouldRotateProviderAfterOutputComplete() {
        return rotationMode === 'per_turn' && Boolean(providerSession?.rotateAfterOutputComplete);
    }

    function closeProvider(reason) {
        if (providerClosed) return;
        providerClosed = true;
        inputResampler.reset();
        cancelCurrent(reason);
        providerSession.close();
        log('provider_session_closed', {
            reason,
            provider: providerSession.name || 'provider',
            providerInstanceId: providerSession.instanceId || 'unknown',
        });
    }

    function startInput(payload = {}) {
        applyPendingLanguageSwitchBeforeInput();
        const cancelledActiveGeneration = cancelCurrent('new_input');
        if (cancelledActiveGeneration && shouldRotateProviderOnInterrupt()) {
            rotateProviderSession('new_input_after_cancel');
        }
        turnCounter += 1;
        currentTurnId = payload.turn_id || id(`turn${turnCounter}`);
        currentGeneration = createGeneration({ turnId: currentTurnId });
        currentMode = payload.mode || 'push_to_talk';
        inputStartedAt = Date.now();
        inputEndedAt = 0;
        inputBytes = 0;
        currentInputChunks = [];
        currentInputBufferedBytes = 0;
        // Fresh resampler state for this turn — filter history/interpolation
        // position from a previous turn must never bleed into this one.
        inputResampler.reset();
        emit({
            type: 'input_audio.start',
            turn_id: currentTurnId,
            generation_id: currentGeneration.generationId,
            response_id: null,
        });
        const generationForStream = currentGeneration;
        const responseIdForStream = currentGeneration.responseId;
        const turnIdForStream = currentTurnId;
        if (typeof providerSession.beginResponse === 'function') {
            providerSession.beginResponse({
                generationId: generationForStream.generationId,
                responseId: responseIdForStream,
                turnId: turnIdForStream,
                turnInputBytes: inputBytes,
                sessionInputBytes,
                mode: currentMode,
                signal: generationForStream.cancel,
                onSessionEvent: (event) => emit(event),
                isGenerationActive: () => (
                    currentGeneration === generationForStream
                    && generationForStream.status !== 'cancelled'
                    && generationForStream.status !== 'completed'
                    && !generationForStream.cancel.cancelled
                ),
                onEvent: (event) => emitProviderEvent(generationForStream, event),
                onAudioChunk: (event) => emitProviderEvent(generationForStream, event),
                log,
            });
        }
        log('input_audio_start', {
            turnId: currentTurnId,
            generationId: currentGeneration.generationId,
            responseId: currentGeneration.responseId,
            mode: currentMode,
            rotationMode,
            turnCount: turnCounter,
        });
    }

    function endInput(payload = {}) {
        if (!currentTurnId || !inputStartedAt) {
            emit({
                type: 'error',
                code: 'input_not_started',
                message: 'input_audio.end received before input_audio.start',
            });
            return;
        }

        // Drain the resampler's FIR tail (a few samples always remain
        // buffered internally waiting for enough history to filter) BEFORE
        // resetting its state — otherwise the last handful of milliseconds
        // of every turn would be silently dropped. Only meaningful at
        // 24000Hz input; at 16000 flush() is a no-op returning empty.
        try {
            const tail = inputResampler.flush();
            if (tail.length > 0) {
                inputBytes += tail.length;
                sessionInputBytes += tail.length;
                if (currentInputBufferedBytes + tail.length <= MAX_TURN_REPLAY_BYTES) {
                    currentInputChunks.push(tail);
                    currentInputBufferedBytes += tail.length;
                }
                providerSession.sendAudio(tail);
                log('input_audio_tail_flushed', {
                    turnId: currentTurnId,
                    tailBytes: tail.length,
                });
            }
        } catch (error) {
            log('input_resample_flush_error', { turnId: currentTurnId, message: error.message });
            emit({
                type: 'error',
                code: 'input_resample_error',
                turn_id: currentTurnId,
                message: error.message,
            });
        } finally {
            inputResampler.reset();
        }

        inputEndedAt = Date.now();
        const recordingDurationMs = inputEndedAt - inputStartedAt;
        if (!currentGeneration) {
            currentGeneration = createGeneration({ turnId: currentTurnId });
        }

        emit({
            type: 'input_audio.end',
            turn_id: currentTurnId,
            generation_id: currentGeneration.generationId,
            response_id: currentGeneration.responseId,
            duration_ms: recordingDurationMs,
            turn_input_bytes: inputBytes,
            session_input_bytes: sessionInputBytes,
            end_reason: payload.end_reason || null,
        });
        log('input_audio_end', {
            turnId: currentTurnId,
            durationMs: recordingDurationMs,
            turnInputBytes: inputBytes,
            sessionInputBytes,
            generationId: currentGeneration.generationId,
            responseId: currentGeneration.responseId,
            endReason: payload.end_reason || 'unknown',
        });

        const generationForStream = currentGeneration;
        generationForStream.inputEndedAt = inputEndedAt;
        armPttTurnTimeout(generationForStream);

        const endInputContext = buildProviderContext(generationForStream);

        providerSession.endInput(endInputContext).catch((error) => {
            emit({
                type: 'error',
                generation_id: generationForStream.generationId,
                response_id: generationForStream.responseId,
                turn_id: generationForStream.turnId,
                code: 'provider_error',
                provider: providerSession.name || 'provider',
                message: error.message,
            });
            log('provider_error', {
                provider: providerSession.name || 'provider',
                message: error.message,
            });
        });
    }

    function handleCommand(raw) {
        let payload;
        try {
            payload = JSON.parse(raw);
        } catch (error) {
            emit({
                type: 'error',
                code: 'invalid_json',
                message: 'Invalid JSON command',
            });
            return;
        }

        if (payload.type === 'session.start') {
            if (
                currentGeneration
                && !['completed', 'cancelled', 'failed'].includes(currentGeneration.status)
            ) {
                emit({
                    type: 'error',
                    code: 'session_config_busy',
                    message: 'Prompt config can be changed only while the realtime session is idle.',
                });
                return;
            }
            // Microphone input sample-rate gate: an explicit, unsupported
            // rate is rejected outright (never guessed). A MISSING rate
            // falls back to 16000 pass-through for backward compatibility
            // with clients that predate this field, but that fallback is
            // never silent — logged here and echoed back in
            // session.config.applied's input_audio block below.
            try {
                const resolved = resolveInputSampleRate(payload);
                inputSampleRate = resolved.rate;
                inputSampleRateSource = resolved.source;
                inputResampler = createInputResampler(inputSampleRate);
                log('input_sample_rate_configured', {
                    deviceId,
                    rate: inputSampleRate,
                    source: inputSampleRateSource,
                });
            } catch (error) {
                emit({
                    type: 'error',
                    code: error.code || 'unsupported_input_sample_rate',
                    message: `Unsupported sampleRate ${error.requestedRate} in session.start. Supported values: 16000, 24000.`,
                });
                log('input_sample_rate_rejected', { deviceId, requestedRate: error.requestedRate });
                return;
            }
            if (payload.deviceId) {
                const nextDeviceId = memoryStore.normalizeDeviceId(payload.deviceId);
                if (nextDeviceId !== deviceId) {
                    unregisterConnection(deviceId, sessionId);
                    deviceId = nextDeviceId;
                    registerConnection(deviceId, sessionId, connectionInfo);
                }
            }
            (async () => {
                try {
                    // Working-hours enforcement gate: refuse the session.start
                    // outright (before touching the provider at all) if night
                    // mode is currently active or today's daily limit is already
                    // used up. This is a hard server-side check, not a prompt hint.
                    if (memoryEnabledFlag) {
                        cachedDeviceSettings = await fetchDeviceSettings(deviceId);
                        const policy = await evaluateUsagePolicy();
                        if (policy.blocked) {
                            sessionBlocked = true;
                            emit({
                                type: 'session.blocked',
                                reason: policy.reason,
                                message: policy.message,
                            });
                            log('session_start_blocked', { deviceId, reason: policy.reason });
                            return;
                        }
                        sessionBlocked = false;
                        if (!usageSessionId) {
                            usageSessionId = await memoryStore.startUsageSession(deviceId);
                            usageSessionStartedAt = Date.now();
                            lastUsageTickAt = Date.now();
                            lastBreakReminderMinuteMark = 0;
                            log('usage_session_started', { deviceId, usageSessionId });
                        }
                    }

                    const sanitized = sanitizePromptConfig(payload.config || {}, {
                        allowCustomPrompt: LAB_ALLOW_CUSTOM_PROMPT,
                    });
                    promptBlocks = sanitized.blocks;
                    promptSource = sanitized.source;

                    // Server-fetched confirmed memory always wins over anything the
                    // client sent — a client must never be able to fake "confirmed
                    // memory" for itself. childContext from DB is a hard override,
                    // not merged with sanitized.blocks.childContext.
                    if (memoryEnabledFlag) {
                        const [dbChildContext, dbSettings] = await Promise.all([
                            fetchChildContext(deviceId),
                            Promise.resolve(cachedDeviceSettings),
                        ]);
                        if (dbChildContext) {
                            promptBlocks = { ...promptBlocks, childContext: dbChildContext };
                        }
                        if (dbSettings) {
                            // Rebuilt fresh from current device_settings columns on every
                            // session.start (not a frozen snapshot) — this is what makes
                            // character/content/time dropdowns in the parent panel take
                            // effect on save, not just after a manual "regenerate" click.
                            // restrictions_addition is now a free-text addendum on top of
                            // the generated block, not the only carrier of these settings.
                            const settingsWithLiveTime = {
                                ...dbSettings,
                                _eveningModeActiveNow: isEveningModeActive(dbSettings, new Date()),
                            };
                            const generated = memoryStore.formatParentRulesAddition(settingsWithLiveTime);
                            const parentAddition = [generated, dbSettings.restrictions_addition]
                                .map((part) => String(part || '').trim())
                                .filter(Boolean)
                                .join('\n\n');
                            promptBlocks = { ...promptBlocks, parentRules: composeParentRules(parentAddition) };
                            if (dbSettings.custom_prompt_enabled && dbSettings.custom_prompt_text) {
                                promptBlocks = { ...promptBlocks, corePrompt: dbSettings.custom_prompt_text };
                                log('session_custom_core_prompt_applied', { deviceId, chars: dbSettings.custom_prompt_text.length });
                            }
                            const dbVoiceName = normalizeProviderVoiceName(dbSettings.voice_name);
                            if (dbVoiceName && dbVoiceName !== sessionVoiceName) {
                                sessionVoiceName = dbVoiceName;
                                sessionVoiceConfigSource = 'device_settings';
                                log('session_voice_applied', { deviceId, voiceName: sessionVoiceName });
                            }
                            cachedLocalDateTime = formatLocalDateTime(dbSettings.timezone, new Date());
                            cachedWeatherText = dbSettings.city ? await fetchWeather(dbSettings.city) : null;
                        }
                    }

                    rotateProviderSession('session_start_config');
                    emitPromptApplied('session.start');
                } catch (error) {
                    emit({
                        type: 'error',
                        code: 'prompt_config_invalid',
                        message: error.code || error.message,
                        max_chars: error.maxChars || LAB_PROMPT_MAX_CHARS,
                        chars: error.chars || 0,
                    });
                    log('prompt_config_invalid', {
                        message: error.code || error.message,
                        maxChars: error.maxChars || LAB_PROMPT_MAX_CHARS,
                        chars: error.chars || 0,
                    });
                }
            })();
            log('session_start_received');
        } else if (payload.type === 'input_audio.start') {
            startInput(payload);
        } else if (payload.type === 'input_audio.end') {
            endInput(payload);
        } else if (payload.type === 'session.interrupt') {
            const reason = payload.reason || 'client_interrupt';
            inputResampler.reset();
            const cancelledActiveGeneration = cancelCurrent(reason);
            if (cancelledActiveGeneration && shouldRotateProviderOnInterrupt()) {
                rotateProviderSession(reason);
            }
        } else if (payload.type === 'ping') {
            emit({
                type: 'pong',
                timestamp_ms: payload.timestamp_ms || Date.now(),
            });
        } else {
            emit({
                type: 'error',
                code: 'unknown_command',
                message: `Unknown command type: ${payload.type || 'missing'}`,
            });
        }
    }

    const parser = createFrameParser({
        onText: handleCommand,
        onBinary(payload) {
            if (
                !currentGeneration
                || !inputStartedAt
                || inputEndedAt
                || currentGeneration.status === 'completed'
                || currentGeneration.status === 'cancelled'
                || currentGeneration.status === 'failed'
            ) {
                log('dropped_input_audio_frame', {
                    reason: 'no_active_input',
                    bytes: payload.length,
                    turnId: currentTurnId || 'none',
                    generationId: currentGeneration?.generationId || 'none',
                    providerInstanceId: providerSession?.instanceId || 'unknown',
                });
                return;
            }
            // Resample 24000Hz ESP32 input down to Gemini's 16000Hz before
            // anything downstream sees it (byte counters, the replay buffer
            // used by retryGenerationOnFreshProvider(), and the provider
            // itself all operate on the POST-resample stream — replaying
            // raw 24kHz bytes into Gemini on retry would be just as wrong
            // as sending them the first time). At 16000 this is a
            // byte-identical pass-through.
            let resampled;
            try {
                resampled = inputResampler.process(payload);
            } catch (error) {
                inputResampler.reset();
                log('input_resample_error', {
                    turnId: currentTurnId || 'none',
                    generationId: currentGeneration?.generationId || 'none',
                    message: error.message,
                });
                emit({
                    type: 'error',
                    code: 'input_resample_error',
                    generation_id: currentGeneration?.generationId,
                    turn_id: currentTurnId,
                    message: error.message,
                });
                return;
            }
            if (resampled.length === 0) return; // buffered internally, nothing to forward yet
            inputBytes += resampled.length;
            sessionInputBytes += resampled.length;
            if (currentInputBufferedBytes + resampled.length <= MAX_TURN_REPLAY_BYTES) {
                currentInputChunks.push(resampled);
                currentInputBufferedBytes += resampled.length;
            } else if (currentInputBufferedBytes <= MAX_TURN_REPLAY_BYTES) {
                log('input_replay_buffer_full', {
                    bytes: resampled.length,
                    bufferedBytes: currentInputBufferedBytes,
                    maxReplayBytes: MAX_TURN_REPLAY_BYTES,
                    turnId: currentTurnId || 'none',
                    generationId: currentGeneration?.generationId || 'none',
                });
                currentInputBufferedBytes = MAX_TURN_REPLAY_BYTES + 1;
                currentInputChunks = [];
            }
            providerSession.sendAudio(resampled);
            log('input_audio_frame', {
                turnId: currentTurnId || 'none',
                bytes: payload.length,
                resampledBytes: resampled.length,
                turnInputBytes: inputBytes,
                sessionInputBytes,
                provider: providerSession.name || 'provider',
                providerInstanceId: providerSession.instanceId || 'unknown',
            });
        },
        onPing(payload) {
            sendPong(socket, payload);
        },
        onClose() {
            closeProvider('client_close');
            sendClose(socket);
        },
        onError(error) {
            emit({
                type: 'error',
                code: 'ws_parse_error',
                message: error.message,
            });
        },
    });

    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('error', (error) => {
        closeProvider('socket_error');
        log('socket_error', { message: error.message });
    });
    socket.on('close', () => {
        socketClosed = true;
        closeProvider('disconnect');
        unregisterConnection(deviceId, sessionId);
        if (usageTickTimer) clearInterval(usageTickTimer);
        flushUsageTicks(true).catch((error) => log('usage_final_flush_error', { message: error.message }));
        log('disconnect', { connectedMs: Date.now() - connectedAt });
    });

    emit({
        type: 'session.ready',
        session_id: sessionId,
        provider: providerSession.name || 'mock',
        provider_instance_id: providerSession.instanceId || null,
        rotation_mode: rotationMode,
        model: providerMetadata.model || null,
        config: DEFAULT_CONFIG,
        lab_prompt: safePromptPayload(),
    });
    log('session_ready', {
        provider: providerSession.name || 'mock',
        providerInstanceId: providerSession.instanceId || 'unknown',
        rotationMode,
    });
}

module.exports = {
    attachRealtimeServer,
    detectLikelyLanguage,
    getDeviceConnectionStatus,
};
