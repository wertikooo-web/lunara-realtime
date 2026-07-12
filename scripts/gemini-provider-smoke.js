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
    first.handleMessage({
        serverContent: {
            generationComplete: true,
        },
    });
    const generationEnd = emitted.find((event) => event.type === 'audio.end' && event.cause === 'generationComplete');
    if (!generationEnd) {
        throw new Error('generationComplete must emit audio.end for active model output');
    }
    const lateEvents = [];
    first.active = {
        generationId: 'generation_late',
        responseId: null,
        turnId: 'turn_late',
        signal: { cancelled: false },
        startedAt: Date.now(),
        audioStarted: false,
        modelOutputStarted: false,
        chunkIndex: 0,
        onEvent(event) {
            lateEvents.push(event);
        },
        onAudioChunk(event) {
            lateEvents.push(event);
        },
        log() {},
    };
    first.handleMessage({
        serverContent: {
            turnComplete: true,
        },
    });
    if (lateEvents.length !== 0 || first.active?.generationId !== 'generation_late') {
        throw new Error('turnComplete without model output must not finish the current active turn');
    }
    const buffered = provider.createSession();
    const bufferLogs = [];
    buffered.active = {
        log(stage, fields) {
            bufferLogs.push({ stage, fields });
        },
    };
    buffered.sendAudio(Buffer.alloc(12));
    if (buffered.pendingAudio.length !== 1 || buffered.pendingAudioBytes !== 12) {
        throw new Error('Audio sent before setupComplete must be buffered');
    }
    const sentPayloads = [];
    buffered.session = {
        sendRealtimeInput(payload) {
            sentPayloads.push(payload);
        },
    };
    buffered.flushPendingAudio();
    if (sentPayloads.length !== 1 || buffered.pendingAudioBytes !== 0) {
        throw new Error('Buffered audio must flush after provider session is ready');
    }
    if (!bufferLogs.find((entry) => entry.stage === 'input_buffer_started')) {
        throw new Error('Buffering must log input_buffer_started');
    }
    if (!bufferLogs.find((entry) => entry.stage === 'input_buffer_flushed')) {
        throw new Error('Buffering must log input_buffer_flushed');
    }
    first.interrupt('smoke');
    const ackEvents = [];
    first.active = {
        generationId: 'generation_new',
        responseId: null,
        turnId: 'turn_new',
        signal: {
            cancelled: false,
        },
        onSessionEvent(event) {
            ackEvents.push(event);
        },
        log() {},
    };
    first.pendingInterrupt = {
        interrupted_generation_id: 'generation_old',
        interrupted_turn_id: 'turn_old',
        interrupted_response_id: 'response_old',
        provider_instance_id: first.instanceId,
        interrupt_requested_at: Date.now() - 25,
        onSessionEvent(event) {
            ackEvents.push(event);
        },
        log() {},
    };
    first.handleMessage({
        serverContent: {
            interrupted: true,
        },
    });
    const ack = ackEvents.find((event) => event.type === 'provider_interrupt_ack');
    if (!ack) {
        throw new Error('Provider interrupt ack must be emitted');
    }
    if (ack.interrupted_generation_id !== 'generation_old') {
        throw new Error(`Provider ack attached to wrong generation: ${ack.interrupted_generation_id}`);
    }
    if (ack.current_active_generation_id !== 'generation_new') {
        throw new Error(`Provider ack must report current active generation: ${ack.current_active_generation_id}`);
    }
    if (first.active?.generationId !== 'generation_new' || first.active.signal.cancelled) {
        throw new Error('Provider interrupt ack must not cancel the new active generation');
    }
    const originalTraceFlag = process.env.GEMINI_RAW_TRACE;
    const originalTracePreviewFlag = process.env.GEMINI_RAW_TRACE_PREVIEW;
    const originalConsoleLog = console.log;
    const traceLines = [];
    const secretTranscript = 'Sensitive child transcript must not be logged';
    const audioPayload = Buffer.alloc(MIN_VALID_PCM_BYTES).toString('base64');
    try {
        process.env.GEMINI_RAW_TRACE = 'true';
        delete process.env.GEMINI_RAW_TRACE_PREVIEW;
        console.log = (line) => traceLines.push(String(line));
        const traceSession = provider.createSession();
        traceSession.handleMessage({
            serverContent: {
                modelTurn: {
                    parts: [{
                        inlineData: {
                            mimeType: 'audio/pcm;rate=24000',
                            data: audioPayload,
                        },
                    }],
                },
                inputTranscription: {
                    text: secretTranscript,
                },
                outputTranscription: {
                    text: 'short model text',
                },
                interrupted: true,
                turnComplete: true,
                generationComplete: true,
                waitingForInput: false,
                turnCompleteReason: 'TURN_COMPLETE_REASON_UNSPECIFIED',
            },
        });
    } finally {
        console.log = originalConsoleLog;
        if (originalTraceFlag === undefined) delete process.env.GEMINI_RAW_TRACE;
        else process.env.GEMINI_RAW_TRACE = originalTraceFlag;
        if (originalTracePreviewFlag === undefined) delete process.env.GEMINI_RAW_TRACE_PREVIEW;
        else process.env.GEMINI_RAW_TRACE_PREVIEW = originalTracePreviewFlag;
    }
    const rawTrace = traceLines.find((line) => line.includes('provider_raw_message'));
    if (!rawTrace) {
        throw new Error('GEMINI_RAW_TRACE=true must emit provider_raw_message');
    }
    if (!rawTrace.includes('audio_bytes_total=4') || !rawTrace.includes('audio_parts_count=1')) {
        throw new Error(`Raw trace did not include audio metadata: ${rawTrace}`);
    }
    if (!rawTrace.includes('input_transcription_chars=45') || !rawTrace.includes('output_transcription_chars=16')) {
        throw new Error(`Raw trace did not include transcript lengths: ${rawTrace}`);
    }
    if (rawTrace.includes(audioPayload) || rawTrace.includes(secretTranscript)) {
        throw new Error('Raw trace must not include base64 audio or full transcript');
    }
    first.close();
    second.close();
    console.log('[GeminiProviderSmoke] ok');
}

main().catch((error) => {
    console.error(`[GeminiProviderSmoke] failed message="${error.message}"`);
    process.exit(1);
});
