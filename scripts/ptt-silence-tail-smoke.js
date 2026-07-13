'use strict';

const { GeminiLiveProvider } = require('../src/realtime/geminiLiveProvider');

const INPUT_SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

function expectedBytes(durationMs) {
    return Math.floor(INPUT_SAMPLE_RATE * durationMs / 1000) * BYTES_PER_SAMPLE;
}

async function runCase(durationMs) {
    process.env.PTT_SILENCE_TAIL_MS = String(durationMs);
    process.env.PTT_SILENCE_FRAME_MS = '20';
    const provider = new GeminiLiveProvider({ apiKey: 'test-key-not-used' });
    const session = provider.createSession();
    const sent = [];
    const logs = [];
    session.session = {
        sendRealtimeInput(payload) {
            sent.push(payload);
        },
    };
    session.active = {
        generationId: 'generation_tail_smoke',
        turnId: 'turn_tail_smoke',
        log(stage, payload) {
            logs.push({ stage, payload });
        },
    };
    await session.sendSilenceTail({
        generationId: 'generation_tail_smoke',
        turnId: 'turn_tail_smoke',
        mode: 'push_to_talk',
        signal: {
            cancelled: false,
        },
        isGenerationActive() {
            return true;
        },
        log(stage, payload) {
            logs.push({ stage, payload });
        },
        onEvent(event) {
            logs.push({ stage: event.type, payload: event });
        },
    });

    const audioPayloads = sent.filter((payload) => payload.audio);
    const activityStartPayloads = sent.filter((payload) => payload.activityStart);
    const activityEndPayloads = sent.filter((payload) => payload.activityEnd);

    if (durationMs === 0) {
        if (audioPayloads.length !== 0) throw new Error('0ms tail must not send audio');
        return;
    }

    const expectedFrameCount = Math.ceil(durationMs / 20);
    if (audioPayloads.length !== expectedFrameCount) {
        throw new Error(`Expected ${expectedFrameCount} silence frames for ${durationMs}ms, got ${audioPayloads.length}`);
    }
    const bytes = audioPayloads.reduce((sum, payload) => sum + Buffer.byteLength(payload.audio.data, 'base64'), 0);
    if (bytes !== expectedBytes(durationMs)) {
        throw new Error(`Bad total tail size for ${durationMs}ms: ${bytes}`);
    }
    if (activityStartPayloads.length !== 1) {
        throw new Error(`Expected one activityStart for ${durationMs}ms, got ${activityStartPayloads.length}`);
    }
    if (activityEndPayloads.length !== 1) {
        throw new Error(`Expected one activityEnd for ${durationMs}ms, got ${activityEndPayloads.length}`);
    }
    if (sent.some((payload) => payload.audioStreamEnd)) {
        throw new Error('Manual PTT must not send audioStreamEnd');
    }
    const started = logs.find((entry) => entry.stage === 'silence_tail_started');
    const completed = logs.find((entry) => entry.stage === 'silence_tail_completed');
    if (
        !started
        || started.payload.configuredDurationMs !== durationMs
        || started.payload.frameDurationMs !== 20
        || started.payload.frameCount !== expectedFrameCount
        || started.payload.totalBytes !== bytes
    ) {
        throw new Error(`Missing silence_tail_started log for ${durationMs}ms`);
    }
    if (
        !completed
        || completed.payload.sentFrames !== expectedFrameCount
        || completed.payload.sentBytes !== bytes
        || completed.payload.aborted !== false
    ) {
        throw new Error(`Missing silence_tail_completed log for ${durationMs}ms`);
    }
    if (durationMs === 300 && (completed.payload.elapsedMs < 250 || completed.payload.elapsedMs > 450)) {
        throw new Error(`Bad paced elapsed for 300ms tail: ${completed.payload.elapsedMs}`);
    }
}

async function main() {
    for (const durationMs of [0, 200, 300, 500]) {
        await runCase(durationMs);
    }
    console.log('[PttSilenceTailSmoke] ok');
}

main().catch((error) => {
    console.error(`[PttSilenceTailSmoke] failed message="${error.message}"`);
    process.exit(1);
});
