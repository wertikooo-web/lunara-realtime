'use strict';

const DEFAULT_CONFIG = {
    processingDelayMs: Number(process.env.MOCK_PROCESSING_DELAY_MS || 650),
    chunkIntervalMs: Number(process.env.MOCK_CHUNK_INTERVAL_MS || 220),
    chunkDurationMs: Number(process.env.MOCK_CHUNK_DURATION_MS || 260),
    chunkCount: Number(process.env.MOCK_CHUNK_COUNT || 8),
    sampleRate: Number(process.env.MOCK_SAMPLE_RATE || 16000),
    toneHz: Number(process.env.MOCK_TONE_HZ || 440),
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeWavTone({ sampleRate, durationMs, frequencyHz, amplitude = 0.22 }) {
    const samples = Math.max(1, Math.floor(sampleRate * durationMs / 1000));
    const dataSize = samples * 2;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    for (let index = 0; index < samples; index += 1) {
        const fadeIn = Math.min(1, index / Math.max(1, samples * 0.08));
        const fadeOut = Math.min(1, (samples - index) / Math.max(1, samples * 0.12));
        const envelope = Math.min(fadeIn, fadeOut);
        const value = Math.sin(2 * Math.PI * frequencyHz * index / sampleRate) * amplitude * envelope;
        buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.floor(value * 32767))), 44 + index * 2);
    }

    return buffer;
}

class MockRealtimeProvider {
    constructor(config = {}) {
        this.config = {
            ...DEFAULT_CONFIG,
            ...config,
        };
        this.name = 'mock';
        this.instanceCounter = 0;
    }

    createSession(options = {}) {
        this.instanceCounter += 1;
        return new MockRealtimeProviderSession({
            config: this.config,
            providerName: this.name,
            instanceId: `mock_session_${this.instanceCounter}`,
            systemInstructionText: options.systemInstructionText,
            systemInstructionMeta: options.systemInstructionMeta,
            promptSource: options.promptSource,
            rotationReason: options.rotationReason,
        });
    }
}

class MockRealtimeProviderSession {
    constructor({
        config,
        providerName,
        instanceId,
        systemInstructionText,
        systemInstructionMeta,
        promptSource,
        rotationReason,
    }) {
        this.config = config;
        this.name = providerName;
        this.instanceId = instanceId;
        this.systemInstructionText = systemInstructionText || '';
        this.systemInstructionMeta = systemInstructionMeta || {};
        this.promptSource = promptSource || 'default';
        this.rotationReason = rotationReason || 'initial';
        this.closed = false;
        this.activeSignal = null;
        this.inputBytes = 0;
    }

    sendAudio(buffer) {
        if (this.closed) return;
        this.inputBytes += Buffer.isBuffer(buffer) ? buffer.length : 0;
    }

    interrupt(reason = 'interrupt') {
        if (this.activeSignal && !this.activeSignal.cancelled) {
            this.activeSignal.cancelled = true;
            this.activeSignal.reason = reason;
            this.activeSignal.cancelledAt = Date.now();
        }
    }

    close() {
        this.closed = true;
        this.interrupt('close');
    }

    async endInput({ responseId, turnId, turnInputBytes, sessionInputBytes, signal, onEvent, onAudioChunk, log }) {
        this.activeSignal = signal;
        const startedAt = Date.now();
        log('response_processing_started', {
            responseId,
            turnId,
            providerInstanceId: this.instanceId,
            turnInputBytes,
            sessionInputBytes,
        });
        await sleep(this.config.processingDelayMs);
        if (this.closed || signal.cancelled) return;

        onEvent({
            type: 'audio.start',
            response_id: responseId,
            turn_id: turnId,
            elapsed_ms: Date.now() - startedAt,
            format: 'audio/wav',
            provider_instance_id: this.instanceId,
            turn_input_bytes: turnInputBytes,
            session_input_bytes: sessionInputBytes,
        });
        log('audio_start', { responseId, turnId, elapsedMs: Date.now() - startedAt });

        for (let index = 0; index < this.config.chunkCount; index += 1) {
            if (this.closed || signal.cancelled) return;
            const tone = makeWavTone({
                sampleRate: this.config.sampleRate,
                durationMs: this.config.chunkDurationMs,
                frequencyHz: this.config.toneHz + index * 28,
            });
            onAudioChunk({
                type: 'audio.chunk',
                response_id: responseId,
                turn_id: turnId,
                chunk_index: index,
                chunk_count: this.config.chunkCount,
                mime_type: 'audio/wav',
                audio_base64: tone.toString('base64'),
                elapsed_ms: Date.now() - startedAt,
            });
            log('audio_chunk', { responseId, turnId, chunkIndex: index, elapsedMs: Date.now() - startedAt });
            await sleep(this.config.chunkIntervalMs);
        }

        if (this.closed || signal.cancelled) return;
        onEvent({
            type: 'audio.end',
            response_id: responseId,
            turn_id: turnId,
            elapsed_ms: Date.now() - startedAt,
        });
        log('audio_end', { responseId, turnId, elapsedMs: Date.now() - startedAt });
        this.activeSignal = null;
        this.inputBytes = 0;
    }

    async sendText(text, context) {
        context.onEvent({
            type: 'transcript.model',
            response_id: context.responseId,
            turn_id: context.turnId,
            text: `Mock response to: ${String(text).slice(0, 120)}`,
        });
        return this.endInput(context);
    }
}

module.exports = {
    MockRealtimeProvider,
    DEFAULT_CONFIG,
};
