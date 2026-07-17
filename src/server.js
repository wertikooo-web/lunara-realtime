'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { attachRealtimeServer, getDeviceConnectionStatus } = require('./realtime/realtimeServer');
const { MockRealtimeProvider, DEFAULT_CONFIG } = require('./realtime/mockRealtimeProvider');
const { GeminiLiveProvider, MODEL_ID: GEMINI_MODEL_ID, DEFAULT_GEMINI_LIVE_VOICE } = require('./realtime/geminiLiveProvider');
const {
    LAB_ALLOW_CUSTOM_PROMPT,
    LAB_PROMPT_MAX_CHARS,
    buildRealtimeSystemInstruction,
    defaultPromptBlocks,
} = require('./realtime/realtimePrompt');
const { GEMINI_VOICES, DEFAULT_VOICE_NAME } = require('./geminiVoices');
const { synthesizeVoicePreview, MAX_PREVIEW_TEXT_CHARS } = require('./voicePreview');
const memoryStore = require('./memory/store');

const MEMORY_ENABLED = /^(1|true|yes|on|enabled)$/i.test(String(process.env.REALTIME_MEMORY_ENABLED || ''));
let memoryReadyPromise = null;
function ensureMemoryReady() {
    if (!MEMORY_ENABLED) {
        return Promise.reject(Object.assign(new Error('memory_disabled'), { code: 'memory_disabled' }));
    }
    if (!memoryReadyPromise) memoryReadyPromise = memoryStore.init();
    return memoryReadyPromise;
}

const PORT = Number(process.env.PORT || 3100);
const provider = process.env.REALTIME_PROVIDER || 'mock';
const publicDir = path.join(__dirname, '..', 'public');

function createProviderFactory() {
    if (provider === 'gemini') {
        const geminiProvider = new GeminiLiveProvider();
        return {
            metadata: {
                provider,
                model: GEMINI_MODEL_ID,
                defaultVoiceName: DEFAULT_GEMINI_LIVE_VOICE,
                defaultVoiceConfigSource: process.env.GEMINI_LIVE_VOICE ? 'env' : 'default',
            },
            createSession: (sessionOptions = {}) => geminiProvider.createSession(sessionOptions),
        };
    }

    const mockProvider = new MockRealtimeProvider(DEFAULT_CONFIG);
    return {
        metadata: {
            provider: 'mock',
            model: 'mock',
        },
        createSession: (sessionOptions = {}) => mockProvider.createSession(sessionOptions),
    };
}

const providerFactory = createProviderFactory();

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(body);
}

// Must comfortably fit custom_prompt_text (16000 chars) + restrictions_addition
// (16000 chars) + the rest of a settings payload. Cyrillic text is ~2 bytes/char
// in UTF-8, and JSON escaping doubles every newline (\n -> 2 bytes), so two
// 16000-char Cyrillic fields alone can approach ~70KB before the rest of the
// payload. A too-small limit here fails silently on the client (fetch()
// doesn't throw on HTTP error statuses), so err generously rather than tightly.
const MAX_JSON_BODY_BYTES = 256 * 1024;

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let received = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            received += chunk.length;
            if (received > MAX_JSON_BODY_BYTES) {
                reject(Object.assign(new Error('body_too_large'), { code: 'body_too_large' }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (error) {
                reject(Object.assign(new Error('invalid_json'), { code: 'invalid_json' }));
            }
        });
        req.on('error', reject);
    });
}

const KNOWN_ENDPOINTS = ['/health', '/', '/lab', '/lab-config', '/parent', '/icons/:filename', '/api/voices', '/api/voice-preview', '/api/memory/:deviceId', '/api/settings/:deviceId', '/api/profiles/:deviceId', '/api/analytics/:deviceId', '/api/transcripts/:deviceId', '/api/transcripts/:deviceId/export', '/api/session-status/:deviceId', '/realtime'];

const server = http.createServer(async (req, res) => {
    // req.url includes the query string (e.g. "/api/analytics/browser-lab?period=today").
    // Every :deviceId route below is matched via a `[^/]+` capture group,
    // which is greedy and does NOT stop at `?` — matching against raw
    // req.url let a query string get silently absorbed into the captured
    // deviceId (e.g. deviceId became the literal string
    // "browser-lab?period=today"), so calls with different query params
    // silently read/wrote completely different device rows in Postgres.
    // Found live while testing the new /api/transcripts export endpoint
    // (which reuses this same route-matching style) — confirmed via a
    // direct regex test, not assumed. Route matching now happens against
    // the parsed pathname only; query params are still read from
    // `url.searchParams` exactly as before in each handler.
    const pathname = new URL(req.url, 'http://localhost').pathname;

    if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, {
            ok: true,
            service: 'lunara-realtime-lab',
            provider,
            model: providerFactory.metadata.model,
            endpoints: KNOWN_ENDPOINTS,
        });
    }

    if (req.method === 'GET' && req.url === '/') {
        return sendJson(res, 200, {
            name: 'Lunara Realtime Lab',
            status: 'realtime-ready',
            provider,
            model: providerFactory.metadata.model,
            endpoints: KNOWN_ENDPOINTS,
            next: 'Open /lab in a browser and test streaming.',
        });
    }

    if (req.method === 'GET' && req.url === '/lab-config') {
        const defaults = defaultPromptBlocks();
        const prompt = buildRealtimeSystemInstruction({
            ...defaults,
            currentContext: {
                mode: 'push_to_talk',
                recentTurns: [],
            },
        });
        return sendJson(res, 200, {
            ok: true,
            allow_custom_prompt: LAB_ALLOW_CUSTOM_PROMPT,
            max_chars: LAB_PROMPT_MAX_CHARS,
            defaults,
            current_context: prompt.blocks.currentContext,
            meta: prompt.meta,
        });
    }

    if (req.method === 'GET' && req.url === '/lab') {
        const filePath = path.join(publicDir, 'lab.html');
        fs.createReadStream(filePath)
            .on('error', () => sendJson(res, 500, { ok: false, error: 'lab_not_available' }))
            .once('open', () => {
                res.writeHead(200, {
                    'content-type': 'text/html; charset=utf-8',
                    'cache-control': 'no-store',
                });
            })
            .pipe(res);
        return undefined;
    }

    if (req.method === 'GET' && req.url === '/parent') {
        const filePath = path.join(publicDir, 'parent.html');
        fs.createReadStream(filePath)
            .on('error', () => sendJson(res, 500, { ok: false, error: 'parent_not_available' }))
            .once('open', () => {
                res.writeHead(200, {
                    'content-type': 'text/html; charset=utf-8',
                    'cache-control': 'no-store',
                });
            })
            .pipe(res);
        return undefined;
    }

    // Static icon files referenced by parent.html (hero badge, favicon) —
    // this server has no generic static-file middleware, so each served
    // subdirectory needs an explicit route. Restricted to a basename match
    // (no path separators) so req.url can't escape public/icons/.
    const iconMatch = /^\/icons\/([a-zA-Z0-9_-]+\.(?:png|svg|jpg|jpeg|webp))$/.exec(pathname);
    if (req.method === 'GET' && iconMatch) {
        const filePath = path.join(publicDir, 'icons', iconMatch[1]);
        const contentType = filePath.endsWith('.svg') ? 'image/svg+xml' : `image/${path.extname(filePath).slice(1)}`;
        fs.createReadStream(filePath)
            .on('error', () => sendJson(res, 404, { ok: false, error: 'icon_not_found' }))
            .once('open', () => {
                res.writeHead(200, {
                    'content-type': contentType,
                    'cache-control': 'public, max-age=86400',
                });
            })
            .pipe(res);
        return undefined;
    }

    if (req.method === 'GET' && req.url === '/api/voices') {
        return sendJson(res, 200, {
            ok: true,
            default_voice: DEFAULT_VOICE_NAME,
            voices: GEMINI_VOICES,
        });
    }

    if (req.method === 'POST' && req.url === '/api/voice-preview') {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            return sendJson(res, error.code === 'body_too_large' ? 413 : 400, { ok: false, error: error.code || 'invalid_request' });
        }
        try {
            const preview = await synthesizeVoicePreview({
                voiceName: body.voice_name || body.voiceName,
                text: body.text,
            });
            return sendJson(res, 200, {
                ok: true,
                voice_name: preview.voiceName,
                mime_type: preview.mimeType,
                sample_rate: preview.sampleRate,
                audio_base64: preview.audioBase64,
            });
        } catch (error) {
            const code = error.code || 'voice_preview_failed';
            const statusCode = code === 'gemini_api_key_missing' ? 503 : 502;
            return sendJson(res, statusCode, { ok: false, error: code, max_chars: MAX_PREVIEW_TEXT_CHARS });
        }
    }

    const memoryMatch = /^\/api\/memory\/([^/]+)(\/facts(?:\/([^/]+))?|\/clear)?\/?$/.exec(pathname);
    if (memoryMatch) {
        const deviceId = memoryStore.normalizeDeviceId(decodeURIComponent(memoryMatch[1]));
        const subPath = memoryMatch[2] || '';
        const factId = memoryMatch[3] ? decodeURIComponent(memoryMatch[3]) : null;

        try {
            await ensureMemoryReady();

            if (req.method === 'GET' && !subPath) {
                const { profile, facts } = await memoryStore.getProfileWithFacts(deviceId);
                return sendJson(res, 200, { ok: true, profile, facts });
            }

            if (req.method === 'PUT' && !subPath) {
                const body = await readJsonBody(req);
                const profile = await memoryStore.updateProfileFields(deviceId, body);
                return sendJson(res, 200, { ok: true, profile });
            }

            if (req.method === 'POST' && subPath === '/facts') {
                const body = await readJsonBody(req);
                const fact = await memoryStore.addFact(deviceId, { label: body.label, value: body.value, source: 'parent' });
                if (!fact) return sendJson(res, 400, { ok: false, error: 'label_and_value_required' });
                return sendJson(res, 200, { ok: true, fact });
            }

            if (req.method === 'DELETE' && subPath.startsWith('/facts/') && factId) {
                await memoryStore.deleteFact(deviceId, factId);
                return sendJson(res, 200, { ok: true });
            }

            if (req.method === 'POST' && subPath === '/clear') {
                await memoryStore.clearFacts(deviceId);
                return sendJson(res, 200, { ok: true });
            }

            if (req.method === 'DELETE' && !subPath) {
                await memoryStore.deleteProfile(deviceId);
                return sendJson(res, 200, { ok: true });
            }

            return sendJson(res, 404, { ok: false, error: 'not_found' });
        } catch (error) {
            const code = error.code || 'memory_request_failed';
            const statusCode = code === 'memory_disabled' ? 503
                : code === 'body_too_large' ? 413
                    : code === 'invalid_json' ? 400
                        : 500;
            return sendJson(res, statusCode, { ok: false, error: code });
        }
    }

    const settingsMatch = /^\/api\/settings\/([^/]+)\/?$/.exec(pathname);
    if (settingsMatch) {
        const deviceId = memoryStore.normalizeDeviceId(decodeURIComponent(settingsMatch[1]));
        try {
            await ensureMemoryReady();

            if (req.method === 'GET') {
                const settings = await memoryStore.getOrCreateSettings(deviceId);
                return sendJson(res, 200, {
                    ok: true,
                    settings,
                    generated_restrictions_addition: memoryStore.formatParentRulesAddition(settings),
                });
            }

            if (req.method === 'PUT') {
                const body = await readJsonBody(req);
                const settings = await memoryStore.updateSettings(deviceId, body);
                return sendJson(res, 200, { ok: true, settings });
            }

            if (req.method === 'DELETE') {
                await memoryStore.deleteSettings(deviceId);
                return sendJson(res, 200, { ok: true });
            }

            return sendJson(res, 404, { ok: false, error: 'not_found' });
        } catch (error) {
            const code = error.code || 'settings_request_failed';
            const statusCode = code === 'memory_disabled' ? 503
                : code === 'body_too_large' ? 413
                    : code === 'invalid_json' ? 400
                        : 500;
            return sendJson(res, statusCode, { ok: false, error: code });
        }
    }

    // Real live connection status for a device's realtime session(s) — the
    // parent panel polls this to show whether Browser Lab/ESP32 is actually
    // connected right now, instead of the hardcoded "not connected" text it
    // had before. No memory/DB dependency — reads realtimeServer.js's
    // in-process connection registry directly.
    const sessionStatusMatch = /^\/api\/session-status\/([^/]+)\/?$/.exec(pathname);
    if (sessionStatusMatch && req.method === 'GET') {
        const deviceId = memoryStore.normalizeDeviceId(decodeURIComponent(sessionStatusMatch[1]));
        return sendJson(res, 200, { ok: true, ...getDeviceConnectionStatus(deviceId) });
    }

    const analyticsMatch = /^\/api\/analytics\/([^/]+)\/?$/.exec(pathname);
    if (analyticsMatch && req.method === 'GET') {
        const deviceId = memoryStore.normalizeDeviceId(decodeURIComponent(analyticsMatch[1]));
        const urlParams = new URL(req.url, 'http://localhost').searchParams;
        const period = urlParams.get('period') || '7d';
        const from = urlParams.get('from') || '';
        const to = urlParams.get('to') || '';

        try {
            await ensureMemoryReady();
            const settings = await memoryStore.getOrCreateSettings(deviceId);
            const timezone = settings.timezone || memoryStore.DEFAULT_TIMEZONE;
            
            const [usage, dialogueAnalytics] = await Promise.all([
                memoryStore.getUsageMinutesToday(deviceId, timezone).then(async (todayMinutes) => {
                    const remaining = settings.daily_limit_enabled 
                        ? Math.max(0, (settings.daily_limit_minutes || 0) - todayMinutes) 
                        : null;
                    return {
                        allowed: !settings.daily_limit_enabled || todayMinutes < (settings.daily_limit_minutes || 0),
                        reason: null,
                        used_minutes: todayMinutes,
                        daily_limit_minutes: settings.daily_limit_minutes || 0,
                        remaining_minutes: remaining,
                        rest_schedule_enabled: !!settings.rest_schedule_enabled,
                        rest_until: null,
                        quiet_hours_enabled: !!settings.quiet_hours_enabled,
                        quiet_hours_start: settings.quiet_hours_start || '22:00',
                        quiet_hours_end: settings.quiet_hours_end || '07:00'
                    };
                }),
                memoryStore.getDialogueAnalytics(deviceId, timezone, { period, from, to })
            ]);
            
            return sendJson(res, 200, {
                ok: true,
                ...dialogueAnalytics,
                usage
            });
        } catch (error) {
            // Previously this fell back to hardcoded fake numbers
            // (today_turns: 2, etc.) with ok:true, so a real DB/query
            // failure was invisible to the parent — they'd see plausible-
            // looking stats with no indication they weren't real. A failed
            // request must look like a failure, not like data.
            console.warn('[Server] Analytics request failed:', error.message);
            const code = error.code || 'analytics_request_failed';
            const statusCode = code === 'memory_disabled' ? 503 : 500;
            return sendJson(res, statusCode, { ok: false, error: code });
        }
    }

    // Full conversation transcript for a parent — day/week/month/year/all-time/
    // custom range, same period semantics as /api/analytics (shared
    // resolvePeriodRange() in store.js). Two routes: the base one for
    // on-screen viewing in the panel, /export for triggering a file
    // download (txt or json).
    const transcriptExportMatch = /^\/api\/transcripts\/([^/]+)\/export\/?$/.exec(pathname);
    const transcriptMatch = !transcriptExportMatch && /^\/api\/transcripts\/([^/]+)\/?$/.exec(pathname);
    if ((transcriptMatch || transcriptExportMatch) && req.method === 'GET') {
        const deviceId = memoryStore.normalizeDeviceId(decodeURIComponent((transcriptMatch || transcriptExportMatch)[1]));
        const urlParams = new URL(req.url, 'http://localhost').searchParams;
        const period = urlParams.get('period') || '7d';
        const from = urlParams.get('from') || '';
        const to = urlParams.get('to') || '';
        const format = (urlParams.get('format') || 'json').toLowerCase() === 'txt' ? 'txt' : 'json';

        try {
            await ensureMemoryReady();
            const settings = await memoryStore.getOrCreateSettings(deviceId);
            const timezone = settings.timezone || memoryStore.DEFAULT_TIMEZONE;
            const result = await memoryStore.getDialogueTurns(deviceId, timezone, { period, from, to });

            if (!transcriptExportMatch) {
                return sendJson(res, 200, { ok: true, ...result });
            }

            // Filenames only ever come from server-computed deviceId/period/
            // date values (never echoed straight from user input), and are
            // further restricted to a safe charset — no header/path
            // injection surface even though these values are already safe.
            const safeDeviceId = deviceId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
            const baseName = `lumi-transcript-${safeDeviceId}-${result.period_from}_${result.period_to}`;

            if (format === 'txt') {
                const lines = [
                    `Расшифровка разговоров: ${deviceId}`,
                    `Период: ${result.period_from} — ${result.period_to}`,
                    result.truncated ? `(Показаны первые ${result.turns.length} реплик — период больше лимита экспорта, сузьте диапазон для полной расшифровки)` : '',
                    '',
                ].filter(Boolean);
                for (const turn of result.turns) {
                    const who = turn.role === 'user' ? 'Ребёнок' : 'Луми';
                    const ts = new Date(turn.created_at).toISOString().replace('T', ' ').slice(0, 19);
                    lines.push(`[${ts}] ${who}: ${turn.text}`);
                }
                const body = lines.join('\n');
                res.writeHead(200, {
                    'content-type': 'text/plain; charset=utf-8',
                    'content-disposition': `attachment; filename="${baseName}.txt"`,
                    'cache-control': 'no-store',
                });
                return res.end(body);
            }

            const body = JSON.stringify(result, null, 2);
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'content-disposition': `attachment; filename="${baseName}.json"`,
                'cache-control': 'no-store',
            });
            return res.end(body);
        } catch (error) {
            const code = error.code || 'transcript_request_failed';
            const statusCode = code === 'memory_disabled' ? 503 : 500;
            return sendJson(res, statusCode, { ok: false, error: code });
        }
    }

    const profilesMatch = /^\/api\/profiles\/([^/]+)(\/load\/([^/]+))?\/?$/.exec(pathname);
    if (profilesMatch) {
        const deviceId = memoryStore.normalizeDeviceId(decodeURIComponent(profilesMatch[1]));
        const loadProfileId = profilesMatch[3] ? decodeURIComponent(profilesMatch[3]) : null;

        try {
            await ensureMemoryReady();

            if (req.method === 'GET' && !loadProfileId) {
                const profiles = await memoryStore.listProfiles(deviceId);
                return sendJson(res, 200, { ok: true, profiles });
            }

            if (req.method === 'POST' && !loadProfileId) {
                const body = await readJsonBody(req);
                const profile = await memoryStore.saveProfileSnapshot(deviceId, body.name);
                return sendJson(res, 200, { ok: true, profile });
            }

            if (req.method === 'POST' && loadProfileId) {
                const { profile, settings } = await memoryStore.loadProfileSnapshot(deviceId, loadProfileId);
                return sendJson(res, 200, { ok: true, profile, settings });
            }

            return sendJson(res, 404, { ok: false, error: 'not_found' });
        } catch (error) {
            const code = error.code || 'profiles_request_failed';
            const statusCode = code === 'memory_disabled' ? 503
                : code === 'body_too_large' ? 413
                    : code === 'invalid_json' ? 400
                        : code === 'profile_name_required' ? 400
                            : code === 'profile_not_found' ? 404
                                : 500;
            return sendJson(res, statusCode, { ok: false, error: code });
        }
    }

    const profileDeleteMatch = /^\/api\/profiles\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
    if (profileDeleteMatch && req.method === 'DELETE') {
        const deviceId = memoryStore.normalizeDeviceId(decodeURIComponent(profileDeleteMatch[1]));
        const profileId = decodeURIComponent(profileDeleteMatch[2]);
        try {
            await ensureMemoryReady();
            await memoryStore.deleteProfileSnapshot(deviceId, profileId);
            return sendJson(res, 200, { ok: true });
        } catch (error) {
            const code = error.code || 'profiles_request_failed';
            const statusCode = code === 'memory_disabled' ? 503 : 500;
            return sendJson(res, statusCode, { ok: false, error: code });
        }
    }

    return sendJson(res, 404, {
        ok: false,
        error: 'not_found',
    });
});

attachRealtimeServer(server, {
    providerFactory: providerFactory.createSession,
    providerMetadata: providerFactory.metadata,
});

server.listen(PORT, () => {
    console.log(`[RealtimeLab] listening port=${PORT} provider=${provider}`);
});
