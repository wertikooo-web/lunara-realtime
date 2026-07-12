'use strict';

const crypto = require('crypto');

const MODEL_ID = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const INPUT_MIME_TYPE = 'audio/pcm;rate=16000';
const INPUT_SAMPLE_RATE = 16000;
const BYTES_PER_PCM16_SAMPLE = 2;
const MIN_VALID_PCM_BYTES = 4;
const DEFAULT_TAIL_FRAME_MS = 20;
const MAX_PENDING_AUDIO_BYTES = Number(process.env.GEMINI_PENDING_AUDIO_MAX_BYTES || 512 * 1024);

function makeInstanceId() {
    return `gemini_session_${crypto.randomBytes(6).toString('hex')}`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}


function isRawTraceEnabled() {
    return /^(1|true|yes)$/i.test(String(process.env.GEMINI_RAW_TRACE || ''));
}

function shouldLogRawTracePreview() {
    return /^(1|true|yes)$/i.test(String(process.env.GEMINI_RAW_TRACE_PREVIEW || ''));
}

function sanitizePreview(text) {
    return String(text || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[^\p{L}\p{N}\p{P}\p{Zs}]/gu, '')
        .trim()
        .slice(0, 48);
}

function formatTraceValue(value) {
    if (Array.isArray(value)) return `[${value.join(',')}]`;
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    return String(value);
}

function summarizeRawProviderMessage(message, seq, providerInstanceId) {
    const serverContent = message?.serverContent || null;
    const parts = Array.isArray(serverContent?.modelTurn?.parts) ? serverContent.modelTurn.parts : [];
    const audioParts = [];
    let audioBytesTotal = 0;

    parts.forEach((part, index) => {
        const inlineData = part?.inlineData;
        if (!inlineData?.data) return;
        const bytes = Buffer.byteLength(String(inlineData.data), 'base64');
        audioBytesTotal += bytes;
        audioParts.push({
            path: `serverContent.modelTurn.parts[${index}].inlineData`,
            bytes,
            mimeType: inlineData.mimeType || null,
        });
    });

    const inputText = serverContent?.inputTranscription?.text || '';
    const outputText = serverContent?.outputTranscription?.text || '';
    const interimInputText = serverContent?.interimInputTranscription?.text || '';
    const trace = {
        seq,
        received_at: new Date().toISOString(),
        provider_instance_id: providerInstanceId,
        top_level_keys: Object.keys(message || {}),
        server_content_keys: serverContent ? Object.keys(serverContent) : [],
        has_model_turn: Boolean(serverContent?.modelTurn),
        has_audio: audioParts.length > 0,
        audio_parts_count: audioParts.length,
        audio_bytes_total: audioBytesTotal,
        audio_paths: audioParts.map((part) => part.path),
        audio_mime_types: Array.from(new Set(audioParts.map((part) => part.mimeType).filter(Boolean))),
        has_input_transcription: inputText.length > 0,
        input_transcription_chars: inputText.length,
        has_output_transcription: outputText.length > 0,
        output_transcription_chars: outputText.length,
        has_interim_input_transcription: interimInputText.length > 0,
        interim_input_transcription_chars: interimInputText.length,
        interrupted: Boolean(serverContent?.interrupted),
        turn_complete: Boolean(serverContent?.turnComplete),
        generation_complete: Boolean(serverContent?.generationComplete),
        waiting_for_input: Boolean(serverContent?.waitingForInput),
        turn_complete_reason: serverContent?.turnCompleteReason || null,
    };

    if (shouldLogRawTracePreview()) {
        trace.input_transcription_preview = sanitizePreview(inputText);
        trace.output_transcription_preview = sanitizePreview(outputText);
        trace.interim_input_transcription_preview = sanitizePreview(interimInputText);
    }

    return trace;
}

function logRawProviderMessage(summary) {
    const fields = Object.entries(summary)
        .map(([key, value]) => `${key}=${formatTraceValue(value)}`)
        .join(' ');
    console.log(`provider_raw_message ${fields}`);
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
        this.rotateOnInterrupt = true;
        this.rotateAfterOutputComplete = true;
        this.model = model;
        this.apiKey = apiKey;
        this.instanceId = instanceId;
        this.closed = false;
        this.ready = false;
        this.session = null;
        this.connectPromise = null;
        this.active = null;
        this.pendingInterrupt = null;
        this.pendingAudio = [];
        this.pendingAudioBytes = 0;
        this.bufferingLogged = false;
        this.inputBytes = 0;
        this.sessionInputBytes = 0;
        this.rawTraceSeq = 0;
    }

    async connect(log = () => {}) {
        if (this.connectPromise) return this.connectPromise;
        if (!this.apiKey) {
            throw new Error('GEMINI_API_KEY is required for REALTIME_PROVIDER=gemini');
        }

        this.connectPromise = (async () => {
            log('provider_connect_started', {
                providerInstanceId: this.instanceId,
                model: this.model,
            });
            const { ActivityHandling, GoogleGenAI, Modality } = await import('@google/genai');
            const ai = new GoogleGenAI({ apiKey: this.apiKey });
            const session = await ai.live.connect({
                model: this.model,
                callbacks: {
                    onopen: () => {
                        if (this.closed) return;
                        this.ready = true;
                        log('gemini_open', {
                            providerInstanceId: this.instanceId,
                            model: this.model,
                        });
                    },
                    onmessage: (message) => this.handleMessage(message),
                    onerror: (error) => {
                        if (this.closed) return;
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
                        if (this.closed) return;
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
            if (this.closed) {
                try {
                    session.close();
                } catch (error) {
                    // The wrapper was destroyed while connect() was in flight.
                }
                return session;
            }
            this.session = session;
            this.ready = true;
            log('provider_ready', {
                providerInstanceId: this.instanceId,
                model: this.model,
            });
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
            if (this.pendingAudioBytes + chunk.length > MAX_PENDING_AUDIO_BYTES) {
                this.active?.log?.('input_buffer_dropped', {
                    providerInstanceId: this.instanceId,
                    bytes: chunk.length,
                    pendingBytes: this.pendingAudioBytes,
                    maxPendingBytes: MAX_PENDING_AUDIO_BYTES,
                });
                return;
            }
            if (!this.bufferingLogged) {
                this.bufferingLogged = true;
                this.active?.log?.('input_buffer_started', {
                    providerInstanceId: this.instanceId,
                    maxPendingBytes: MAX_PENDING_AUDIO_BYTES,
                });
            }
            this.pendingAudio.push(chunk);
            this.pendingAudioBytes += chunk.length;
            this.connect().catch(() => {});
            return;
        }
        this.sendAudioNow(chunk);
    }

    flushPendingAudio() {
        const chunkCount = this.pendingAudio.length;
        const bytes = this.pendingAudioBytes;
        while (!this.closed && this.session && this.pendingAudio.length > 0) {
            const chunk = this.pendingAudio.shift();
            this.pendingAudioBytes -= chunk.length;
            this.sendAudioNow(chunk);
        }
        if (chunkCount > 0) {
            this.active?.log?.('input_buffer_flushed', {
                providerInstanceId: this.instanceId,
                chunks: chunkCount,
                bytes,
            });
        }
    }

    sendAudioNow(buffer) {
        if (this.closed || !this.session) return;
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
            modelOutputStarted: this.active.modelOutputStarted || false,
            inputEnded: true,
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
            modelOutputStarted: false,
            inputEnded: false,
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

    interrupt(reason = 'interrupt', context = {}) {
        const interrupted = this.active;
        this.pendingInterrupt = {
            interrupted_generation_id: context.interrupted_generation_id || interrupted?.generationId || null,
            interrupted_turn_id: context.interrupted_turn_id || interrupted?.turnId || null,
            interrupted_response_id: context.interrupted_response_id || interrupted?.responseId || null,
            provider_instance_id: context.provider_instance_id || this.instanceId,
            interrupt_requested_at: context.interrupt_requested_at || Date.now(),
            onSessionEvent: interrupted?.onSessionEvent || null,
            log: interrupted?.log || (() => {}),
        };
        if (
            this.active?.signal
            && !this.active.signal.cancelled
            && typeof this.active.signal.cancel === 'function'
        ) {
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

    handleProviderInterrupted() {
        const interrupt = this.pendingInterrupt;
        const currentActiveGenerationId = this.active?.generationId || null;

        if (!interrupt?.interrupted_generation_id) {
            const log = this.active?.log || (() => {});
            log('dropped_provider_event', {
                providerInstanceId: this.instanceId,
                eventType: 'provider_interrupted',
                reason: 'unmatched_provider_interrupt',
                currentActiveGenerationId: currentActiveGenerationId || 'none',
            });
            return;
        }

        const event = {
            type: 'provider_interrupt_ack',
            interrupted_generation_id: interrupt.interrupted_generation_id,
            interrupted_turn_id: interrupt.interrupted_turn_id,
            interrupted_response_id: interrupt.interrupted_response_id,
            provider_instance_id: interrupt.provider_instance_id,
            current_active_generation_id: currentActiveGenerationId,
            matched: true,
            ignored_for_active_generation: true,
            elapsed_ms: Date.now() - interrupt.interrupt_requested_at,
        };

        const emit = this.active?.onSessionEvent || interrupt.onSessionEvent;
        if (emit) emit(event);
        const log = this.active?.log || interrupt.log || (() => {});
        log('provider_interrupt_ack', {
            interruptedGenerationId: event.interrupted_generation_id,
            interruptedResponseId: event.interrupted_response_id || 'none',
            currentActiveGenerationId: event.current_active_generation_id || 'none',
            matched: event.matched,
            ignoredForActiveGeneration: event.ignored_for_active_generation,
            elapsedMs: event.elapsed_ms,
            providerInstanceId: this.instanceId,
        });
        this.pendingInterrupt = null;
    }

    close() {
        this.destroySession('close');
    }

    destroySession(reason = 'destroy_session') {
        this.closed = true;
        if (this.active?.signal && !this.active.signal.cancelled && typeof this.active.signal.cancel === 'function') {
            this.active.signal.cancel(reason);
        }
        this.active = null;
        this.pendingInterrupt = null;
        this.pendingAudio = [];
        this.pendingAudioBytes = 0;
        this.bufferingLogged = false;
        const ws = this.session?.conn?.ws;
        try {
            if (ws?.removeAllListeners) ws.removeAllListeners();
            if (ws?.terminate) ws.terminate();
            else if (ws?.close) ws.close();
            else if (this.session?.close) this.session.close();
        } catch (error) {
            // Best-effort hard close; session is already marked closed locally.
        }
        this.session = null;
        this.connectPromise = null;
        this.ready = false;
    }

    handleMessage(message) {
        if (this.closed) return;
        if (isRawTraceEnabled()) {
            this.rawTraceSeq += 1;
            logRawProviderMessage(summarizeRawProviderMessage(message, this.rawTraceSeq, this.instanceId));
        }
        if (message?.setupComplete) {
            const log = this.active?.log || (() => {});
            log('provider_setup_complete', {
                providerInstanceId: this.instanceId,
                model: this.model,
            });
        }
        const content = message?.serverContent;
        if (!content) return;

        if (content.interrupted) {
            this.handleProviderInterrupted();
            return;
        }

        if (!this.active || this.active.signal.cancelled) return;

        if (content.inputTranscription?.text) {
            this.active.onEvent({
                type: 'transcript.user',
                response_id: this.active.responseId,
                turn_id: this.active.turnId,
                text: content.inputTranscription.text,
            });
        }

        if (content.outputTranscription?.text) {
            this.active.modelOutputStarted = true;
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
                this.active.modelOutputStarted = true;
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

        if (content.generationComplete) {
            this.emitOutputEnd('generationComplete');
            return;
        }

        if (content.turnComplete) {
            if (!this.active.modelOutputStarted) {
                if (this.active.inputEnded) {
                    this.active.onEvent({
                        type: 'response.failed',
                        response_id: this.active.responseId,
                        turn_id: this.active.turnId,
                        reason: 'provider_turn_complete_without_model_output',
                        provider_instance_id: this.instanceId,
                    });
                    this.active = null;
                    this.inputBytes = 0;
                    return;
                }
                this.active.log('dropped_provider_event', {
                    generationId: this.active.generationId,
                    responseId: this.active.responseId,
                    eventType: 'audio.end',
                    reason: 'turn_complete_without_model_output',
                    providerInstanceId: this.instanceId,
                });
                return;
            }
            this.emitOutputEnd('turnComplete');
        }
    }

    emitOutputEnd(cause) {
        if (!this.active) return;
        if (!this.active.modelOutputStarted) {
            if (this.active.inputEnded) {
                this.active.onEvent({
                    type: 'response.failed',
                    response_id: this.active.responseId,
                    turn_id: this.active.turnId,
                    reason: `provider_${cause}_without_model_output`,
                    provider_instance_id: this.instanceId,
                });
                this.active = null;
                this.inputBytes = 0;
                return;
            }
            this.active.log('dropped_provider_event', {
                generationId: this.active.generationId,
                responseId: this.active.responseId,
                eventType: 'audio.end',
                reason: `${cause}_without_model_output`,
                providerInstanceId: this.instanceId,
            });
            return;
        }
        this.active.onEvent({
            type: 'audio.end',
            response_id: this.active.responseId,
            turn_id: this.active.turnId,
            elapsed_ms: Date.now() - this.active.startedAt,
            cause,
        });
        this.active = null;
        this.inputBytes = 0;
    }
}

module.exports = {
    GeminiLiveProvider,
    MODEL_ID,
    MIN_VALID_PCM_BYTES,
};
