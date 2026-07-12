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

function id(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
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
    };
}

function attachRealtimeServer(server, options = {}) {
    const defaultProvider = new MockRealtimeProvider(options.mockConfig || DEFAULT_CONFIG);
    const providerFactory = options.providerFactory || (() => defaultProvider.createSession());
    const providerMetadata = options.providerMetadata || { provider: 'mock', model: 'mock' };

    server.on('upgrade', (req, socket) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname !== '/realtime') {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }

        if (!acceptWebSocket(req, socket)) return;
        createRealtimeSession(socket, providerFactory(), providerMetadata);
    });
}

function createRealtimeSession(socket, providerSession, providerMetadata = {}) {
    const sessionId = id('session');
    const connectedAt = Date.now();
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

    function droppedProviderEvent(generation, eventType, reason) {
        log('dropped_provider_event', {
            generationId: generation?.generationId || 'none',
            responseId: generation?.responseId || 'none',
            eventType,
            reason,
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
                generation.timeoutLogged = true;
                log('ptt_turn_timeout', {
                    generationId: generation.generationId,
                    responseId: generation.responseId,
                    turnId: generation.turnId,
                    timeoutMs,
                    turnInputBytes: inputBytes,
                    sessionInputBytes,
                });
            }
        }, timeoutMs);
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
        if (generation.status === 'cancelled' || generation.status === 'completed') {
            if (modelOutputEvents.has(eventType)) {
                droppedProviderEvent(generation, eventType, 'terminal_generation');
            }
            return false;
        }
        if (startsGenerationEvents.has(eventType)) {
            emitResponseCreated(generation, eventType);
        }
        if (eventType === 'response.cancelled') {
            generation.status = 'cancelled';
            clearGenerationTimeout(generation);
        }
        if (eventType === 'audio.end') {
            generation.status = 'completed';
            clearGenerationTimeout(generation);
        }
        return emit({
            ...payload,
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
        });
    }

    function cancelCurrent(reason) {
        if (!currentGeneration || currentGeneration.status === 'cancelled' || currentGeneration.status === 'completed') return;
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
        cancelCurrent('new_input');
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
        });
    }

    function endInput() {
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
        });
        log('input_audio_end', {
            turnId: currentTurnId,
            durationMs: recordingDurationMs,
            turnInputBytes: inputBytes,
            sessionInputBytes,
            generationId: currentGeneration.generationId,
            responseId: currentGeneration.responseId,
        });

        const generationForStream = currentGeneration;
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
            if (!readySent) {
                emit({
                    type: 'session.ready',
                    session_id: sessionId,
                    provider: providerSession.name || 'mock',
                    provider_instance_id: providerSession.instanceId || null,
                    model: providerMetadata.model || null,
                    config: DEFAULT_CONFIG,
                });
            }
            log('session_start_received');
        } else if (payload.type === 'input_audio.start') {
            startInput(payload);
        } else if (payload.type === 'input_audio.end') {
            endInput();
        } else if (payload.type === 'session.interrupt') {
            cancelCurrent(payload.reason || 'client_interrupt');
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
        model: providerMetadata.model || null,
        config: DEFAULT_CONFIG,
    });
    log('session_ready', {
        provider: providerSession.name || 'mock',
        providerInstanceId: providerSession.instanceId || 'unknown',
    });
}

module.exports = {
    attachRealtimeServer,
};
