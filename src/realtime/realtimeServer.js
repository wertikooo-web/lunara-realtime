'use strict';

const crypto = require('crypto');
const {
    acceptWebSocket,
    createFrameParser,
    sendJson,
    sendPong,
    sendClose,
} = require('./wsProtocol');
const { MockRealtimeProvider, DEFAULT_CONFIG } = require('./mockRealtimeProvider');
const {
    LAB_ALLOW_CUSTOM_PROMPT,
    LAB_PROMPT_MAX_CHARS,
    buildRealtimeSystemInstruction,
    defaultPromptBlocks,
    sanitizePromptConfig,
} = require('./realtimePrompt');

function id(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

const VALID_ROTATION_MODES = new Set(['per_turn', 'errors_only']);
const DEFAULT_ROTATION_MODE = 'per_turn';
let warnedInvalidRotationMode = false;

function normalizeProviderVoiceName(voiceName) {
    return String(voiceName || '').trim();
}

function normalizeRotationMode(value) {
    const mode = String(value || process.env.GEMINI_ROTATION_MODE || DEFAULT_ROTATION_MODE).trim().toLowerCase();
    if (VALID_ROTATION_MODES.has(mode)) return mode;
    if (!warnedInvalidRotationMode) {
        warnedInvalidRotationMode = true;
        console.warn('[Realtime] Unknown GEMINI_ROTATION_MODE=' + JSON.stringify(mode) + '. Falling back to ' + DEFAULT_ROTATION_MODE + '.');
    }
    return DEFAULT_ROTATION_MODE;
}

function createCancellation() {
    return {
        cancelled: false,
        reason: null,
        cancelledAt: 0,
        cancel(reason) {
            this.cancelled = true;
            this.reason = reason;
            this.cancelledAt = Date.now();
        },
    };
}

function createGeneration({ turnId }) {
    return {
        turnId,
        generationId: id('generation'),
        responseId: null,
        status: 'pending',
        responseCreatedSent: false,
        cancel: createCancellation(),
        timeoutTimer: null,
        timeoutLogged: false,
        inputEndedAt: 0,
        firstInputTranscriptionAt: 0,
        firstModelEventAt: 0,
        firstValidAudioAt: 0,
    };
}

function attachRealtimeServer(server, options = {}) {
    const defaultProvider = new MockRealtimeProvider(options.mockConfig || DEFAULT_CONFIG);
    const providerFactory = options.providerFactory || ((sessionOptions = {}) => defaultProvider.createSession(sessionOptions));
    const providerMetadata = options.providerMetadata || { provider: 'mock', model: 'mock' };

    server.on('upgrade', (req, socket) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname !== '/realtime') {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }

        if (!acceptWebSocket(req, socket)) return;
        createRealtimeSession(socket, providerFactory, providerMetadata);
    });
}

function createRealtimeSession(socket, providerFactory, providerMetadata = {}) {
    const sessionId = id('session');
    const connectedAt = Date.now();
    const sessionVoiceName = normalizeProviderVoiceName(providerMetadata.defaultVoiceName || providerMetadata.voiceName);
    const sessionVoiceConfigSource = sessionVoiceName
        ? (providerMetadata.defaultVoiceConfigSource || (providerMetadata.defaultVoiceName ? 'default' : 'metadata'))
        : 'provider_default';
    let promptBlocks = defaultPromptBlocks();
    let promptSource = 'default';
    const recentTurns = [];
    let currentTurnId = null;
    let currentGeneration = null;
    let inputStartedAt = 0;
    let inputEndedAt = 0;
    let inputBytes = 0;
    let sessionInputBytes = 0;
    let currentMode = 'push_to_talk';
    let turnCounter = 0;
    let socketClosed = false;
    let providerClosed = false;
    let readySent = false;
    const rotationMode = normalizeRotationMode(providerMetadata.rotationMode);
    let providerSessionReuseCount = 0;
    let providerRotationCount = 0;
    let promptApplyCount = 0;
    let lateProviderEventsDropped = 0;
    let providerSession = providerFactory(buildProviderSessionOptions('initial'));

    function log(stage, extra = {}) {
        const details = Object.entries(extra)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
        console.log(`[Realtime] session=${sessionId} stage=${stage} ${details}`.trim());
    }

    function emit(payload) {
        if (socketClosed || socket.destroyed) return false;
        if (payload.type === 'session.ready') {
            readySent = true;
        }
        return sendJson(socket, {
            session_id: sessionId,
            server_time_ms: Date.now(),
            ...payload,
        });
    }

    function rememberTurn(role, text) {
        const clean = String(text || '').trim();
        if (!clean) return;
        recentTurns.push({ role, text: clean.slice(0, 240) });
        while (recentTurns.length > 12) recentTurns.shift();
    }

    function buildPromptBundle() {
        return buildRealtimeSystemInstruction({
            ...promptBlocks,
            currentContext: {
                mode: currentMode,
                recentTurns,
            },
        });
    }

    function buildProviderSessionOptions(rotationReason) {
        const prompt = buildPromptBundle();
        return {
            voiceName: sessionVoiceName || undefined,
            voiceConfigSource: sessionVoiceConfigSource,
            systemInstructionText: prompt.text,
            systemInstructionMeta: prompt.meta,
            promptSource,
            rotationReason,
            rotationMode,
        };
    }

    function safePromptPayload() {
        const prompt = buildPromptBundle();
        return {
            allow_custom_prompt: LAB_ALLOW_CUSTOM_PROMPT,
            max_chars: LAB_PROMPT_MAX_CHARS,
            source: promptSource,
            defaults: defaultPromptBlocks(),
            current_context: prompt.blocks.currentContext,
            meta: prompt.meta,
        };
    }

    function emitPromptApplied(reason) {
        const prompt = buildPromptBundle();
        emit({
            type: 'session.config.applied',
            reason,
            prompt_source: promptSource,
            lab_prompt: {
                allow_custom_prompt: LAB_ALLOW_CUSTOM_PROMPT,
                max_chars: LAB_PROMPT_MAX_CHARS,
                current_context: prompt.blocks.currentContext,
                meta: prompt.meta,
            },
        });
        log('prompt_config_applied', {
            reason,
            promptSource,
            promptChars: prompt.meta.promptChars,
            promptHash: prompt.meta.promptHash,
            corePromptChars: prompt.meta.corePrompt.chars,
            corePromptHash: prompt.meta.corePrompt.hash,
            childContextChars: prompt.meta.childContext.chars,
            childContextHash: prompt.meta.childContext.hash,
            parentRulesChars: prompt.meta.parentRules.chars,
            parentRulesHash: prompt.meta.parentRules.hash,
            currentContextChars: prompt.meta.currentContext.chars,
            currentContextHash: prompt.meta.currentContext.hash,
        });
    }

    function droppedProviderEvent(generation, eventType, reason) {
        lateProviderEventsDropped += 1;
        log('dropped_provider_event', {
            generationId: generation?.generationId || 'none',
            responseId: generation?.responseId || 'none',
            eventType,
            reason,
            lateProviderEventsDropped,
        });
    }

    function clearGenerationTimeout(generation) {
        if (!generation?.timeoutTimer) return;
        clearTimeout(generation.timeoutTimer);
        generation.timeoutTimer = null;
    }

    function armPttTurnTimeout(generation) {
        if (!generation || currentMode !== 'push_to_talk') return;
        clearGenerationTimeout(generation);
        const timeoutMs = Math.max(0, Number(process.env.PTT_TURN_TIMEOUT_MS || 8000));
        if (timeoutMs <= 0) return;
        generation.timeoutTimer = setTimeout(() => {
            if (
                generation.status === 'pending'
                && !generation.responseCreatedSent
                && !generation.cancel.cancelled
            ) {
                recoverFromTurnTimeout(generation, timeoutMs).catch((error) => {
                    log('turn_timeout_recovery_error', {
                        generationId: generation.generationId,
                        turnId: generation.turnId,
                        message: error.message,
                    });
                });
            }
        }, timeoutMs);
    }

    async function warmProviderSession(reason) {
        if (typeof providerSession?.connect !== 'function') return;
        await providerSession.connect(log);
        promptApplyCount += 1;
        log('provider_ready', {
            reason,
            provider: providerSession.name || 'provider',
            providerInstanceId: providerSession.instanceId || 'unknown',
            voiceName: providerSession.voiceName || sessionVoiceName || 'none',
            rotationMode,
            promptApplyCount,
        });
        log('provider_voice_config', {
            clientSessionId: sessionId,
            providerInstanceId: providerSession.instanceId || 'unknown',
            voiceName: providerSession.voiceName || sessionVoiceName || 'none',
            configSource: providerSession.voiceConfigSource || sessionVoiceConfigSource,
            inheritedFromPreviousProvider: reason !== 'initial',
            rotationReason: reason,
            rotationMode,
            providerRotationCount,
            promptApplyCount,
        });
        log('provider_prompt_config', {
            clientSessionId: sessionId,
            providerInstanceId: providerSession.instanceId || 'unknown',
            promptSource: providerSession.promptSource || promptSource,
            rotationReason: providerSession.rotationReason || reason,
            promptChars: providerSession.systemInstructionMeta?.promptChars || 0,
            promptHash: providerSession.systemInstructionMeta?.promptHash || 'none',
            corePromptChars: providerSession.systemInstructionMeta?.corePrompt?.chars || 0,
            corePromptHash: providerSession.systemInstructionMeta?.corePrompt?.hash || 'none',
            childContextChars: providerSession.systemInstructionMeta?.childContext?.chars || 0,
            childContextHash: providerSession.systemInstructionMeta?.childContext?.hash || 'none',
            parentRulesChars: providerSession.systemInstructionMeta?.parentRules?.chars || 0,
            parentRulesHash: providerSession.systemInstructionMeta?.parentRules?.hash || 'none',
            rotationMode,
            providerRotationCount,
            promptApplyCount,
            currentContextChars: providerSession.systemInstructionMeta?.currentContext?.chars || 0,
            currentContextHash: providerSession.systemInstructionMeta?.currentContext?.hash || 'none',
        });
        emit({
            type: 'provider.ready',
            reason,
            provider: providerSession.name || 'provider',
            provider_instance_id: providerSession.instanceId || null,
        });
    }

    async function recoverFromTurnTimeout(generation, timeoutMs) {
        if (generation !== currentGeneration) {
            droppedProviderEvent(generation, 'ptt_turn_timeout', 'stale_generation');
            return;
        }
        generation.timeoutLogged = true;
        generation.status = 'failed';
        generation.cancel.cancel('provider_timeout');
        clearGenerationTimeout(generation);
        log('ptt_turn_timeout', {
            generationId: generation.generationId,
            responseId: generation.responseId,
            turnId: generation.turnId,
            timeoutMs,
            turnInputBytes: inputBytes,
            sessionInputBytes,
        });
        emit({
            type: 'response.failed',
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
            reason: 'provider_timeout',
            timeout_ms: timeoutMs,
        });

        const startedAt = Date.now();
        const oldProviderInstanceId = providerSession?.instanceId || 'unknown';
        log('turn_timeout_recovery_started', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
        });
        rotateProviderSession('provider_timeout');
        await warmProviderSession('provider_timeout');
        log('turn_timeout_recovery_completed', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
            newProviderInstanceId: providerSession?.instanceId || 'unknown',
            elapsedMs: Date.now() - startedAt,
        });
    }

    async function recoverFromProviderFailure(generation, reason, payload = {}) {
        if (generation !== currentGeneration) {
            droppedProviderEvent(generation, 'response.failed', 'stale_generation');
            return;
        }
        generation.status = 'failed';
        generation.cancel.cancel(reason);
        clearGenerationTimeout(generation);
        log('response_failed', {
            generationId: generation.generationId,
            responseId: generation.responseId,
            turnId: generation.turnId,
            reason,
            providerInstanceId: providerSession?.instanceId || 'unknown',
        });
        emit({
            ...payload,
            type: 'response.failed',
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
            reason,
        });

        const startedAt = Date.now();
        const oldProviderInstanceId = providerSession?.instanceId || 'unknown';
        log('turn_timeout_recovery_started', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
            reason,
        });
        rotateProviderSession(reason);
        await warmProviderSession(reason);
        log('turn_timeout_recovery_completed', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
            newProviderInstanceId: providerSession?.instanceId || 'unknown',
            elapsedMs: Date.now() - startedAt,
            reason,
        });
    }

    function emitResponseCreated(generation, cause) {
        if (!generation || generation.responseCreatedSent) return;
        if (generation.status === 'cancelled' || generation.status === 'completed') {
            droppedProviderEvent(generation, 'response.created', 'terminal_generation');
            return;
        }
        generation.responseId = generation.responseId || id('response');
        clearGenerationTimeout(generation);
        generation.responseCreatedSent = true;
        generation.status = 'active';
        emit({
            type: 'response.created',
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
            cause,
            turn_input_bytes: inputBytes,
            session_input_bytes: sessionInputBytes,
        });
    }

    function emitProviderEvent(generation, payload) {
        if (!generation) return false;
        const eventType = payload?.type || 'unknown';
        const modelOutputEvents = new Set(['transcript.model', 'audio.start', 'audio.chunk', 'audio.end']);
        const startsGenerationEvents = new Set(['transcript.model', 'audio.start', 'audio.chunk']);
        if (eventType === 'provider_interrupt_ack') {
            return emit(payload);
        }
        if (eventType === 'response.failed') {
            recoverFromProviderFailure(generation, payload.reason || 'provider_failed', payload).catch((error) => {
                log('turn_timeout_recovery_error', {
                    generationId: generation.generationId,
                    turnId: generation.turnId,
                    message: error.message,
                });
            });
            return true;
        }
        if (generation.status === 'cancelled' || generation.status === 'completed' || generation.status === 'failed') {
            if (modelOutputEvents.has(eventType)) {
                droppedProviderEvent(generation, eventType, 'terminal_generation');
            }
            return false;
        }
        if (eventType === 'transcript.user' && generation.inputEndedAt && !generation.firstInputTranscriptionAt) {
            rememberTurn('user', payload.text);
            generation.firstInputTranscriptionAt = Date.now();
            log('provider_input_transcription_received', {
                generationId: generation.generationId,
                turnId: generation.turnId,
                inputEndToInputTranscriptionMs: generation.firstInputTranscriptionAt - generation.inputEndedAt,
            });
        }
        if (startsGenerationEvents.has(eventType) && generation.inputEndedAt && !generation.firstModelEventAt) {
            generation.firstModelEventAt = Date.now();
            log('provider_first_model_event', {
                generationId: generation.generationId,
                turnId: generation.turnId,
                eventType,
                inputEndToFirstModelEventMs: generation.firstModelEventAt - generation.inputEndedAt,
            });
        }
        if (eventType === 'audio.start' && generation.inputEndedAt && !generation.firstValidAudioAt) {
            generation.firstValidAudioAt = Date.now();
            log('provider_first_valid_audio', {
                generationId: generation.generationId,
                turnId: generation.turnId,
                inputEndToFirstValidAudioMs: generation.firstValidAudioAt - generation.inputEndedAt,
            });
        }
        if (eventType === 'transcript.model') {
            rememberTurn('assistant', payload.text);
        }
        if (startsGenerationEvents.has(eventType)) {
            emitResponseCreated(generation, eventType);
        }
        if (eventType === 'response.cancelled') {
            generation.status = 'cancelled';
            clearGenerationTimeout(generation);
        }
        const shouldRotateAfterAudioEnd = eventType === 'audio.end' && shouldRotateProviderAfterOutputComplete();
        if (eventType === 'audio.end') {
            generation.status = 'completed';
            clearGenerationTimeout(generation);
        }
        const emitted = emit({
            ...payload,
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
        });
        if (shouldRotateAfterAudioEnd && generation === currentGeneration) {
            rotateProviderSession(payload.cause === 'turnComplete'
                ? 'output_turn_complete'
                : 'output_generation_complete');
            warmProviderSession('output_complete').catch((error) => {
                log('provider_warm_error', {
                    reason: 'output_complete',
                    message: error.message,
                });
            });
        } else if (eventType === 'audio.end' && generation === currentGeneration && rotationMode === 'errors_only') {
            providerSessionReuseCount += 1;
            log('provider_session_reused', {
                reason: payload.cause || 'audio_end',
                providerInstanceId: providerSession?.instanceId || 'unknown',
                providerSessionReuseCount,
                providerRotationCount,
                promptApplyCount,
                turnCount: turnCounter,
                lateProviderEventsDropped,
            });
        }
        return emitted;
    }

    function cancelCurrent(reason) {
        if (
            !currentGeneration
            || currentGeneration.status === 'cancelled'
            || currentGeneration.status === 'completed'
            || currentGeneration.status === 'failed'
        ) return false;
        const cancelRequestedAt = Date.now();
        currentGeneration.cancel.cancel(reason);
        providerSession.interrupt(reason, {
            interrupted_generation_id: currentGeneration.generationId,
            interrupted_turn_id: currentGeneration.turnId,
            interrupted_response_id: currentGeneration.responseId,
            provider_instance_id: providerSession.instanceId || null,
            interrupt_requested_at: cancelRequestedAt,
        });
        currentGeneration.status = 'cancelled';
        clearGenerationTimeout(currentGeneration);
        const cancelLatencyMs = Date.now() - cancelRequestedAt;
        emit({
            type: 'response.cancelled',
            generation_id: currentGeneration.generationId,
            response_id: currentGeneration.responseId,
            turn_id: currentGeneration.turnId,
            reason,
            cancel_latency_ms: cancelLatencyMs,
        });
        log('response_cancelled', {
            generationId: currentGeneration.generationId,
            responseId: currentGeneration.responseId,
            turnId: currentGeneration.turnId,
            reason,
            cancelLatencyMs,
        });
        return true;
    }

    function rotateProviderSession(reason) {
        providerRotationCount += 1;
        const oldProviderSession = providerSession;
        const oldProviderInstanceId = oldProviderSession?.instanceId || 'unknown';
        const oldProviderVoiceName = oldProviderSession?.voiceName || sessionVoiceName || 'none';
        try {
            if (typeof oldProviderSession.destroySession === 'function') {
                oldProviderSession.destroySession(reason);
            } else {
                oldProviderSession.close();
            }
        } catch (error) {
            log('provider_rotation_close_error', {
                reason,
                providerInstanceId: oldProviderInstanceId,
                message: error.message,
            });
        }
        providerSession = providerFactory(buildProviderSessionOptions(reason));
        const oldPromptMeta = oldProviderSession?.systemInstructionMeta || {};
        const newPromptMeta = providerSession.systemInstructionMeta || {};
        log('provider_session_rotated', {
            reason,
            oldProviderInstanceId,
            newProviderInstanceId: providerSession.instanceId || 'unknown',
            provider: providerSession.name || 'provider',
            oldProviderVoiceName,
            newProviderVoiceName: providerSession.voiceName || sessionVoiceName || 'none',
            voicePreserved: oldProviderVoiceName === (providerSession.voiceName || sessionVoiceName || 'none'),
            oldPromptHash: oldPromptMeta.promptHash || 'none',
            newPromptHash: newPromptMeta.promptHash || 'none',
            corePromptPreserved: oldPromptMeta.corePrompt?.hash === newPromptMeta.corePrompt?.hash,
            childContextPreserved: oldPromptMeta.childContext?.hash === newPromptMeta.childContext?.hash,
            parentRulesPreserved: oldPromptMeta.parentRules?.hash === newPromptMeta.parentRules?.hash,
            rotationMode,
            providerRotationCount,
            providerSessionReuseCount,
            promptApplyCount,
        });
        emit({
            type: 'provider.rotated',
            reason,
            old_provider_instance_id: oldProviderInstanceId,
            new_provider_instance_id: providerSession.instanceId || null,
            provider: providerSession.name || 'provider',
            old_provider_voice_name: oldProviderVoiceName,
            new_provider_voice_name: providerSession.voiceName || sessionVoiceName || null,
            voice_preserved: oldProviderVoiceName === (providerSession.voiceName || sessionVoiceName || 'none'),
            old_prompt_hash: oldPromptMeta.promptHash || null,
            new_prompt_hash: newPromptMeta.promptHash || null,
            core_prompt_hash: newPromptMeta.corePrompt?.hash || null,
            child_context_hash: newPromptMeta.childContext?.hash || null,
            parent_rules_hash: newPromptMeta.parentRules?.hash || null,
            core_prompt_preserved: oldPromptMeta.corePrompt?.hash === newPromptMeta.corePrompt?.hash,
            child_context_preserved: oldPromptMeta.childContext?.hash === newPromptMeta.childContext?.hash,
            parent_rules_preserved: oldPromptMeta.parentRules?.hash === newPromptMeta.parentRules?.hash,
            rotation_mode: rotationMode,
            provider_rotation_count: providerRotationCount,
            provider_session_reuse_count: providerSessionReuseCount,
            prompt_apply_count: promptApplyCount,
        });
    }

    function shouldRotateProviderOnInterrupt() {
        return Boolean(providerSession?.rotateOnInterrupt);
    }

    function shouldRotateProviderAfterOutputComplete() {
        return rotationMode === 'per_turn' && Boolean(providerSession?.rotateAfterOutputComplete);
    }

    function closeProvider(reason) {
        if (providerClosed) return;
        providerClosed = true;
        cancelCurrent(reason);
        providerSession.close();
        log('provider_session_closed', {
            reason,
            provider: providerSession.name || 'provider',
            providerInstanceId: providerSession.instanceId || 'unknown',
        });
    }

    function startInput(payload = {}) {
        const cancelledActiveGeneration = cancelCurrent('new_input');
        if (cancelledActiveGeneration && shouldRotateProviderOnInterrupt()) {
            rotateProviderSession('new_input_after_cancel');
        }
        turnCounter += 1;
        currentTurnId = payload.turn_id || id(`turn${turnCounter}`);
        currentGeneration = createGeneration({ turnId: currentTurnId });
        currentMode = payload.mode || 'push_to_talk';
        inputStartedAt = Date.now();
        inputEndedAt = 0;
        inputBytes = 0;
        emit({
            type: 'input_audio.start',
            turn_id: currentTurnId,
            generation_id: currentGeneration.generationId,
            response_id: null,
        });
        const generationForStream = currentGeneration;
        const responseIdForStream = currentGeneration.responseId;
        const turnIdForStream = currentTurnId;
        if (typeof providerSession.beginResponse === 'function') {
            providerSession.beginResponse({
                generationId: generationForStream.generationId,
                responseId: responseIdForStream,
                turnId: turnIdForStream,
                turnInputBytes: inputBytes,
                sessionInputBytes,
                mode: currentMode,
                signal: generationForStream.cancel,
                onSessionEvent: (event) => emit(event),
                isGenerationActive: () => (
                    currentGeneration === generationForStream
                    && generationForStream.status !== 'cancelled'
                    && generationForStream.status !== 'completed'
                    && !generationForStream.cancel.cancelled
                ),
                onEvent: (event) => emitProviderEvent(generationForStream, event),
                onAudioChunk: (event) => emitProviderEvent(generationForStream, event),
                log,
            });
        }
        log('input_audio_start', {
            turnId: currentTurnId,
            generationId: currentGeneration.generationId,
            responseId: currentGeneration.responseId,
            mode: currentMode,
            rotationMode,
            turnCount: turnCounter,
        });
    }

    function endInput(payload = {}) {
        if (!currentTurnId || !inputStartedAt) {
            emit({
                type: 'error',
                code: 'input_not_started',
                message: 'input_audio.end received before input_audio.start',
            });
            return;
        }

        inputEndedAt = Date.now();
        const recordingDurationMs = inputEndedAt - inputStartedAt;
        if (!currentGeneration) {
            currentGeneration = createGeneration({ turnId: currentTurnId });
        }

        emit({
            type: 'input_audio.end',
            turn_id: currentTurnId,
            generation_id: currentGeneration.generationId,
            response_id: currentGeneration.responseId,
            duration_ms: recordingDurationMs,
            turn_input_bytes: inputBytes,
            session_input_bytes: sessionInputBytes,
            end_reason: payload.end_reason || null,
        });
        log('input_audio_end', {
            turnId: currentTurnId,
            durationMs: recordingDurationMs,
            turnInputBytes: inputBytes,
            sessionInputBytes,
            generationId: currentGeneration.generationId,
            responseId: currentGeneration.responseId,
            endReason: payload.end_reason || 'unknown',
        });

        const generationForStream = currentGeneration;
        generationForStream.inputEndedAt = inputEndedAt;
        armPttTurnTimeout(generationForStream);

        const endInputContext = {
            generationId: generationForStream.generationId,
            responseId: generationForStream.responseId,
            turnId: generationForStream.turnId,
            turnInputBytes: inputBytes,
            sessionInputBytes,
            mode: currentMode,
            signal: generationForStream.cancel,
            onSessionEvent: (event) => emit(event),
            isGenerationActive: () => (
                currentGeneration === generationForStream
                && generationForStream.status !== 'cancelled'
                && generationForStream.status !== 'completed'
                && !generationForStream.cancel.cancelled
            ),
            onEvent: (event) => emitProviderEvent(generationForStream, event),
            onAudioChunk: (event) => emitProviderEvent(generationForStream, event),
            log,
        };

        providerSession.endInput(endInputContext).catch((error) => {
            emit({
                type: 'error',
                generation_id: generationForStream.generationId,
                response_id: generationForStream.responseId,
                turn_id: generationForStream.turnId,
                code: 'provider_error',
                provider: providerSession.name || 'provider',
                message: error.message,
            });
            log('provider_error', {
                provider: providerSession.name || 'provider',
                message: error.message,
            });
        });
    }

    function handleCommand(raw) {
        let payload;
        try {
            payload = JSON.parse(raw);
        } catch (error) {
            emit({
                type: 'error',
                code: 'invalid_json',
                message: 'Invalid JSON command',
            });
            return;
        }

        if (payload.type === 'session.start') {
            if (
                currentGeneration
                && !['completed', 'cancelled', 'failed'].includes(currentGeneration.status)
            ) {
                emit({
                    type: 'error',
                    code: 'session_config_busy',
                    message: 'Prompt config can be changed only while the realtime session is idle.',
                });
                return;
            }
            try {
                const sanitized = sanitizePromptConfig(payload.config || {}, {
                    allowCustomPrompt: LAB_ALLOW_CUSTOM_PROMPT,
                });
                promptBlocks = sanitized.blocks;
                promptSource = sanitized.source;
                rotateProviderSession('session_start_config');
                emitPromptApplied('session.start');
            } catch (error) {
                emit({
                    type: 'error',
                    code: 'prompt_config_invalid',
                    message: error.code || error.message,
                    max_chars: error.maxChars || LAB_PROMPT_MAX_CHARS,
                    chars: error.chars || 0,
                });
                log('prompt_config_invalid', {
                    message: error.code || error.message,
                    maxChars: error.maxChars || LAB_PROMPT_MAX_CHARS,
                    chars: error.chars || 0,
                });
            }
            log('session_start_received');
        } else if (payload.type === 'input_audio.start') {
            startInput(payload);
        } else if (payload.type === 'input_audio.end') {
            endInput(payload);
        } else if (payload.type === 'session.interrupt') {
            const reason = payload.reason || 'client_interrupt';
            const cancelledActiveGeneration = cancelCurrent(reason);
            if (cancelledActiveGeneration && shouldRotateProviderOnInterrupt()) {
                rotateProviderSession(reason);
            }
        } else if (payload.type === 'ping') {
            emit({
                type: 'pong',
                timestamp_ms: payload.timestamp_ms || Date.now(),
            });
        } else {
            emit({
                type: 'error',
                code: 'unknown_command',
                message: `Unknown command type: ${payload.type || 'missing'}`,
            });
        }
    }

    const parser = createFrameParser({
        onText: handleCommand,
        onBinary(payload) {
            if (
                !currentGeneration
                || !inputStartedAt
                || inputEndedAt
                || currentGeneration.status === 'completed'
                || currentGeneration.status === 'cancelled'
                || currentGeneration.status === 'failed'
            ) {
                log('dropped_input_audio_frame', {
                    reason: 'no_active_input',
                    bytes: payload.length,
                    turnId: currentTurnId || 'none',
                    generationId: currentGeneration?.generationId || 'none',
                    providerInstanceId: providerSession?.instanceId || 'unknown',
                });
                return;
            }
            inputBytes += payload.length;
            sessionInputBytes += payload.length;
            providerSession.sendAudio(payload);
            log('input_audio_frame', {
                turnId: currentTurnId || 'none',
                bytes: payload.length,
                turnInputBytes: inputBytes,
                sessionInputBytes,
                provider: providerSession.name || 'provider',
                providerInstanceId: providerSession.instanceId || 'unknown',
            });
        },
        onPing(payload) {
            sendPong(socket, payload);
        },
        onClose() {
            closeProvider('client_close');
            sendClose(socket);
        },
        onError(error) {
            emit({
                type: 'error',
                code: 'ws_parse_error',
                message: error.message,
            });
        },
    });

    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('error', (error) => {
        closeProvider('socket_error');
        log('socket_error', { message: error.message });
    });
    socket.on('close', () => {
        socketClosed = true;
        closeProvider('disconnect');
        log('disconnect', { connectedMs: Date.now() - connectedAt });
    });

    emit({
        type: 'session.ready',
        session_id: sessionId,
        provider: providerSession.name || 'mock',
        provider_instance_id: providerSession.instanceId || null,
        rotation_mode: rotationMode,
        model: providerMetadata.model || null,
        config: DEFAULT_CONFIG,
        lab_prompt: safePromptPayload(),
    });
    log('session_ready', {
        provider: providerSession.name || 'mock',
        providerInstanceId: providerSession.instanceId || 'unknown',
        rotationMode,
    });
}

module.exports = {
    attachRealtimeServer,
};
