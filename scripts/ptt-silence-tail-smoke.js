'use strict';

const { GeminiLiveProvider } = require('../src/realtime/geminiLiveProvider');

const INPUT_SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

function expectedBytes(durationMs) {
    return Math.floor(INPUT_SAMPLE_RATE * durationMs / 1000) * BYTES_PER_SAMPLE;
}

function runCase(durationMs) {
    process.env.PTT_SILENCE_TAIL_MS = String(durationMs);
    const provider = new GeminiLiveProvider({ apiKey: 'test-key-not-used' });
    const session = provider.createSession();
    const sent = [];
    const logs = [];
    session.session = {
        sendRealtimeInput(payload) {
            sent.push(payload);
        },
    };
    session.sendSilenceTail({
        mode: 'push_to_talk',
        log(stage, payload) {
            logs.push({ stage, payload });
        },
    });

    const audioPayloads = sent.filter((payload) => payload.audio);
    const manualActivityPayloads = sent.filter((payload) => payload.activityStart || payload.activityEnd || payload.audioStreamEnd);
    if (manualActivityPayloads.length !== 0) {
        throw new Error(`Manual activity payload emitted for ${durationMs}ms`);
    }

    if (durationMs === 0) {
        if (audioPayloads.length !== 0) throw new Error('0ms tail must not send audio');
        return;
    }

    if (audioPayloads.length !== 1) {
        throw new Error(`Expected one silence tail for ${durationMs}ms, got ${audioPayloads.length}`);
    }
    const bytes = Buffer.byteLength(audioPayloads[0].audio.data, 'base64');
    if (bytes !== expectedBytes(durationMs)) {
        throw new Error(`Bad tail size for ${durationMs}ms: ${bytes}`);
    }
    const logEntry = logs.find((entry) => entry.stage === 'silence_tail_sent');
    if (!logEntry || logEntry.payload.duration_ms !== durationMs || logEntry.payload.bytes !== bytes) {
        throw new Error(`Missing silence_tail_sent log for ${durationMs}ms`);
    }
}

for (const durationMs of [0, 200, 300, 500]) {
    runCase(durationMs);
}

console.log('[PttSilenceTailSmoke] ok');
