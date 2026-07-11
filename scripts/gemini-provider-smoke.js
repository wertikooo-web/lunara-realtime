'use strict';

const { GeminiLiveProvider, MIN_VALID_PCM_BYTES, MODEL_ID } = require('../src/realtime/geminiLiveProvider');

async function main() {
    const provider = new GeminiLiveProvider({
        apiKey: 'test-key-not-used',
    });
    const first = provider.createSession();
    const second = provider.createSession();

    if (provider.name !== 'gemini') {
        throw new Error('Gemini provider name mismatch');
    }
    if (MODEL_ID !== 'gemini-3.1-flash-live-preview') {
        throw new Error(`Unexpected model id: ${MODEL_ID}`);
    }
    if (first.instanceId === second.instanceId) {
        throw new Error('Gemini provider sessions must be unique');
    }
    for (const method of ['sendAudio', 'endInput', 'interrupt', 'close']) {
        if (typeof first[method] !== 'function') {
            throw new Error(`Missing Gemini session method: ${method}`);
        }
    }

    first.sendAudio(Buffer.alloc(320));
    const emitted = [];
    first.active = {
        generationId: 'generation_smoke',
        responseId: 'response_smoke',
        turnId: 'turn_smoke',
        signal: {
            cancelled: false,
            cancel(reason) {
                this.cancelled = true;
                this.reason = reason;
            },
        },
        startedAt: Date.now(),
        audioStarted: false,
        chunkIndex: 0,
        turnInputBytes: 320,
        sessionInputBytes: 320,
        onEvent(event) {
            emitted.push(event);
        },
        onAudioChunk(event) {
            emitted.push(event);
        },
        log() {},
    };
    first.handleMessage({
        serverContent: {
            modelTurn: {
                parts: [{
                    inlineData: {
                        data: Buffer.alloc(2).toString('base64'),
                    },
                }],
            },
        },
    });
    if (emitted.length !== 0) {
        throw new Error('2-byte PCM chunk must not emit audio events');
    }
    first.handleMessage({
        serverContent: {
            modelTurn: {
                parts: [{
                    inlineData: {
                        data: Buffer.alloc(MIN_VALID_PCM_BYTES).toString('base64'),
                    },
                }],
            },
        },
    });
    if (!emitted.find((event) => event.type === 'audio.start')) {
        throw new Error('Valid PCM chunk must emit audio.start');
    }
    first.interrupt('smoke');
    first.close();
    second.close();
    console.log('[GeminiProviderSmoke] ok');
}

main().catch((error) => {
    console.error(`[GeminiProviderSmoke] failed message="${error.message}"`);
    process.exit(1);
});
