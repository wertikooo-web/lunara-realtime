'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { attachRealtimeServer } = require('./realtime/realtimeServer');
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

// Must comfortably fit custom_prompt_text (10000 chars) + restrictions_addition
// (5000 chars) + the rest of a settings payload, with room for JSON escaping
// overhead (e.g. every newline becomes 2 bytes as \n). A too-small limit here
// fails silently on the client (fetch() doesn't throw on HTTP error statuses),
// so err generously rather than tightly.
const MAX_JSON_BODY_BYTES = 64 * 1024;

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

const KNOWN_ENDPOINTS = ['/health', '/', '/lab', '/lab-config', '/parent', '/api/voices', '/api/voice-preview', '/api/memory/:deviceId', '/api/settings/:deviceId', '/api/profiles/:deviceId', '/realtime'];

const server = http.createServer(async (req, res) => {
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

    const memoryMatch = /^\/api\/memory\/([^/]+)(\/facts(?:\/([^/]+))?|\/clear)?\/?$/.exec(req.url);
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

    const settingsMatch = /^\/api\/settings\/([^/]+)\/?$/.exec(req.url);
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

    const profilesMatch = /^\/api\/profiles\/([^/]+)(\/load\/([^/]+))?\/?$/.exec(req.url);
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

    const profileDeleteMatch = /^\/api\/profiles\/([^/]+)\/([^/]+)\/?$/.exec(req.url);
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
