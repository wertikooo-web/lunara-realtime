'use strict';

const { GeminiLiveProvider, MODEL_ID } = require('../src/realtime/geminiLiveProvider');

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
    first.interrupt('smoke');
    first.close();
    second.close();
    console.log('[GeminiProviderSmoke] ok');
}

main().catch((error) => {
    console.error(`[GeminiProviderSmoke] failed message="${error.message}"`);
    process.exit(1);
});
