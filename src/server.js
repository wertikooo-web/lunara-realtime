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

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, {
            ok: true,
            service: 'lunara-realtime-lab',
            provider,
            model: providerFactory.metadata.model,
            endpoints: ['/health', '/', '/lab', '/lab-config', '/realtime'],
        });
    }

    if (req.method === 'GET' && req.url === '/') {
        return sendJson(res, 200, {
            name: 'Lunara Realtime Lab',
            status: 'realtime-ready',
            provider,
            model: providerFactory.metadata.model,
            endpoints: ['/health', '/lab', '/lab-config', '/realtime'],
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
