'use strict';

const crypto = require('crypto');

const MODEL_ID = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const INPUT_MIME_TYPE = 'audio/pcm;rate=16000';
const INPUT_SAMPLE_RATE = 16000;
const BYTES_PER_PCM16_SAMPLE = 2;
const MIN_VALID_PCM_BYTES = 4;
const DEFAULT_TAIL_FRAME_MS = 20;

function makeInstanceId() {
    return `gemini_session_${crypto.randomBytes(6).toString('hex')}`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeErrorMessage(error) {
    return String(error?.message || error || 'Gemini Live error')
        .replace(/key=[^&\s]+/gi, 'key=[redacted]')
        .replace(/api[_-]?key["']?\s*[:=]\s*["']?[^"',\s]+/gi, 'apiKey=[redacted]');
}

class GeminiLiveProvider {
    constructor(options = {}) {
        this.name = 'gemini';
        this.model = options.model || MODEL_ID;
        this.apiKey = options.apiKey || process.env.GEMINI_API_KEY || '';
    }

    createSession() {
        return new GeminiLiveProviderSession({
            apiKey: this.apiKey,
            model: this.model,
            instanceId: makeInstanceId(),
        });
    }
}

class GeminiLiveProviderSession {
    constructor({ apiKey, model, instanceId }) {
        this.name = 'gemini';
        this.model = model;
        this.apiKey = apiKey;
        this.instanceId = instanceId;
        this.closed = false;
        this.ready = false;
        this.session = null;
        this.connectPromise = null;
        this.active = null;
        this.pendingAudio = [];
        this.inputBytes = 0;
        this.sessionInputBytes = 0;
    }

    async connect(log = () => {}) {
        if (this.connectPromise) return this.connectPromise;
        if (!this.apiKey) {
            throw new Error('GEMINI_API_KEY is required for REALTIME_PROVIDER=gemini');
        }

        this.connectPromise = (async () => {
            const { ActivityHandling, GoogleGenAI, Modality } = await import('@google/genai');
            const ai = new GoogleGenAI({ apiKey: this.apiKey });
            const session = await ai.live.connect({
                model: this.model,
                callbacks: {
                    onopen: () => {
                        this.ready = true;
                        log('gemini_open', {
                            providerInstanceId: this.instanceId,
                            model: this.model,
                        });
                    },
                    onmessage: (message) => this.handleMessage(message),
                    onerror: (error) => {
                        const message = safeErrorMessage(error);
                        this.active?.onEvent?.({
                            type: 'error',
                            response_id: this.active?.responseId,
                            turn_id: this.active?.turnId,
                            code: 'provider_error',
                            provider: this.name,
                            message,
                        });
                        log('gemini_error', { providerInstanceId: this.instanceId, message });
                    },
                    onclose: (event) => {
                        this.ready = false;
                        log('gemini_close', {
                            providerInstanceId: this.instanceId,
                            reason: safeErrorMessage(event?.reason || 'closed'),
                        });
                    },
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    realtimeInputConfig: {
                        automaticActivityDetection: {
                            disabled: false,
                            silenceDurationMs: Number(process.env.GEMINI_VAD_SILENCE_MS || 350),
                            prefixPaddingMs: Number(process.env.GEMINI_VAD_PREFIX_PADDING_MS || 100),
                        },
                        activityHandling: ActivityHandling.NO_INTERRUPTION,
                    },
                    systemInstruction: {
                        parts: [{
                            text: 'You are Lumi, a warm child-safe voice companion. Reply briefly and naturally in the user language.',
                        }],
                    },
                },
            });
            this.session = session;
            this.flushPendingAudio();
            return session;
        })();

        return this.connectPromise;
    }

    sendAudio(buffer) {
        if (this.closed) return;
        const chunk = Buffer.from(buffer);
        this.inputBytes += chunk.length;
        this.sessionInputBytes += chunk.length;
        if (!this.session) {
            this.pendingAudio.push(chunk);
            this.connect().catch(() => {});
            return;
        }
        this.sendAudioNow(chunk);
    }

    flushPendingAudio() {
        while (!this.closed && this.session && this.pendingAudio.length > 0) {
            this.sendAudioNow(this.pendingAudio.shift());
        }
    }

    sendAudioNow(buffer) {
        this.session.sendRealtimeInput({
            audio: {
                data: buffer.toString('base64'),
                mimeType: INPUT_MIME_TYPE,
            },
        });
    }

    async endInput(context) {
        if (this.closed) return;
        this.active = this.active || {};
        Object.assign(this.active, context, {
            startedAt: this.active.startedAt || Date.now(),
            audioStarted: this.active.audioStarted || false,
            chunkIndex: this.active.chunkIndex || 0,
        });
        context.log('gemini_response_waiting', {
            responseId: context.responseId,
            turnId: context.turnId,
            providerInstanceId: this.instanceId,
            turnInputBytes: context.turnInputBytes,
            sessionInputBytes: context.sessionInputBytes,
            model: this.model,
        });
        await this.connect(context.log);
        this.flushPendingAudio();
        if (context.mode === 'push_to_talk') {
            await this.sendSilenceTail(context);
        }
        // With server-side VAD enabled, input_audio.end is only a UI marker.
        // Gemini decides turn boundaries from the live audio stream.
    }

    isTailActive(context) {
        return (
            !this.closed
            && this.session
            && !context.signal?.cancelled
            && this.active?.generationId === context.generationId
            && (typeof context.isGenerationActive !== 'function' || context.isGenerationActive())
        );
    }

    async sendSilenceTail(context) {
        if (!this.session || this.closed) return;
        const configuredDurationMs = Math.max(0, Number(process.env.PTT_SILENCE_TAIL_MS || 300));
        const frameDurationMs = Math.max(1, Number(process.env.PTT_SILENCE_FRAME_MS || DEFAULT_TAIL_FRAME_MS));
        if (configuredDurationMs <= 0 || frameDurationMs <= 0) return;
        const frameCount = Math.max(1, Math.ceil(configuredDurationMs / frameDurationMs));
        const frameBytes = Math.floor(INPUT_SAMPLE_RATE * frameDurationMs / 1000) * BYTES_PER_PCM16_SAMPLE;
        const totalBytes = frameBytes * frameCount;
        if (frameBytes <= 0) return;
        context.log('silence_tail_started', {
            generationId: context.generationId,
            turnId: context.turnId,
            configuredDurationMs,
            sampleRate: INPUT_SAMPLE_RATE,
            frameDurationMs,
            frameCount,
            frameBytes,
            totalBytes,
            mode: context.mode,
            providerInstanceId: this.instanceId,
        });
        context.onEvent?.({
            type: 'silence_tail_started',
            response_id: null,
            generation_id: context.generationId,
            turn_id: context.turnId,
            configured_duration_ms: configuredDurationMs,
            sample_rate: INPUT_SAMPLE_RATE,
            frame_duration_ms: frameDurationMs,
            frame_count: frameCount,
            frame_bytes: frameBytes,
            total_bytes: totalBytes,
        });

        const startedAt = Date.now();
        let sentFrames = 0;
        let sentBytes = 0;
        let aborted = false;
        let abortReason = null;

        for (let index = 0; index < frameCount; index += 1) {
            if (!this.isTailActive(context)) {
                aborted = true;
                abortReason = context.signal?.reason || 'inactive_generation';
                break;
            }
            this.sendAudioNow(Buffer.alloc(frameBytes, 0));
            sentFrames += 1;
            sentBytes += frameBytes;
            const nextFrameAt = startedAt + (index + 1) * frameDurationMs;
            await sleep(Math.max(0, nextFrameAt - Date.now()));
        }

        if (!aborted && this.isTailActive(context)) {
            try {
                this.session.sendRealtimeInput({ audioStreamEnd: true });
            } catch (error) {
                aborted = true;
                abortReason = safeErrorMessage(error);
            }
        } else if (!aborted) {
            aborted = true;
            abortReason = context.signal?.reason || 'inactive_generation';
        }

        const elapsedMs = Date.now() - startedAt;
        context.log('silence_tail_completed', {
            generationId: context.generationId,
            turnId: context.turnId,
            sentFrames,
            sentBytes,
            elapsedMs,
            aborted,
            abortReason: abortReason || '',
            mode: context.mode,
            providerInstanceId: this.instanceId,
        });
        context.onEvent?.({
            type: 'silence_tail_completed',
            response_id: null,
            generation_id: context.generationId,
            turn_id: context.turnId,
            sent_frames: sentFrames,
            sent_bytes: sentBytes,
            elapsed_ms: elapsedMs,
            aborted,
            abort_reason: abortReason || null,
        });
    }

    beginResponse(context) {
        if (this.closed) return;
        this.active = {
            ...context,
            startedAt: Date.now(),
            audioStarted: false,
            chunkIndex: 0,
        };
        this.connect(context.log).then(() => {
            this.flushPendingAudio();
        }).catch((error) => {
            context.onEvent({
                type: 'error',
                response_id: context.responseId,
                turn_id: context.turnId,
                code: 'provider_error',
                provider: this.name,
                message: safeErrorMessage(error),
            });
        });
    }

    interrupt(reason = 'interrupt') {
        if (this.active?.signal && !this.active.signal.cancelled) {
            this.active.signal.cancel(reason);
        }
        this.active = null;
        if (this.session?.sendRealtimeInput) {
            try {
                this.session.sendRealtimeInput({ text: '[Interrupted by user]' });
            } catch (error) {
                // Ignore provider interrupt best-effort failures.
            }
        }
    }

    close() {
        this.closed = true;
        this.interrupt('close');
        this.pendingAudio = [];
        if (this.session?.close) {
            this.session.close();
        }
    }

    handleMessage(message) {
        if (!this.active || this.closed || this.active.signal.cancelled) return;
        const content = message?.serverContent;
        if (!content) return;

        if (content.interrupted) {
            this.active.onEvent({
                type: 'response.cancelled',
                response_id: this.active.responseId,
                turn_id: this.active.turnId,
                reason: 'provider_interrupted',
                provider: this.name,
            });
            this.active = null;
            return;
        }

        if (content.inputTranscription?.text) {
            this.active.onEvent({
                type: 'transcript.user',
                response_id: this.active.responseId,
                turn_id: this.active.turnId,
                text: content.inputTranscription.text,
            });
        }

        if (content.outputTranscription?.text) {
            this.active.onEvent({
                type: 'transcript.model',
                response_id: this.active.responseId,
                turn_id: this.active.turnId,
                text: content.outputTranscription.text,
            });
        }

        const parts = content.modelTurn?.parts || [];
        for (const part of parts) {
            const audioBase64 = part.inlineData?.data;
            if (!audioBase64 || this.active.signal.cancelled) continue;
            const audioBytes = Buffer.byteLength(audioBase64, 'base64');
            if (audioBytes < MIN_VALID_PCM_BYTES || audioBytes % BYTES_PER_PCM16_SAMPLE !== 0) {
                this.active.log('dropped_provider_event', {
                    generationId: this.active.generationId,
                    responseId: this.active.responseId,
                    eventType: 'audio.chunk',
                    reason: 'invalid_pcm',
                    bytes: audioBytes,
                });
                continue;
            }
            if (!this.active.audioStarted) {
                this.active.audioStarted = true;
                this.active.onEvent({
                    type: 'audio.start',
                    response_id: this.active.responseId,
                    turn_id: this.active.turnId,
                    elapsed_ms: Date.now() - this.active.startedAt,
                    format: 'audio/pcm',
                    sample_rate: 24000,
                    provider_instance_id: this.instanceId,
                    turn_input_bytes: this.active.turnInputBytes,
                    session_input_bytes: this.active.sessionInputBytes,
                });
            }

            const chunkIndex = this.active.chunkIndex;
            this.active.chunkIndex += 1;
            this.active.onAudioChunk({
                type: 'audio.chunk',
                response_id: this.active.responseId,
                turn_id: this.active.turnId,
                chunk_index: chunkIndex,
                mime_type: 'audio/pcm',
                sample_rate: 24000,
                audio_base64: audioBase64,
                elapsed_ms: Date.now() - this.active.startedAt,
            });
        }

        if (content.turnComplete) {
            this.active.onEvent({
                type: 'audio.end',
                response_id: this.active.responseId,
                turn_id: this.active.turnId,
                elapsed_ms: Date.now() - this.active.startedAt,
            });
            this.active = null;
            this.inputBytes = 0;
        }
    }
}

module.exports = {
    GeminiLiveProvider,
    MODEL_ID,
    MIN_VALID_PCM_BYTES,
};
