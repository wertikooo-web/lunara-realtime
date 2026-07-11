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

function attachRealtimeServer(server, options = {}) {
    const defaultProvider = new MockRealtimeProvider(options.mockConfig || DEFAULT_CONFIG);
    const providerFactory = options.providerFactory || (() => defaultProvider.createSession());

    server.on('upgrade', (req, socket) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname !== '/realtime') {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }

        if (!acceptWebSocket(req, socket)) return;
        createRealtimeSession(socket, providerFactory());
    });
}

function createRealtimeSession(socket, providerSession) {
    const sessionId = id('session');
    const connectedAt = Date.now();
    let currentTurnId = null;
    let currentResponseId = null;
    let currentCancel = null;
    let inputStartedAt = 0;
    let inputEndedAt = 0;
    let inputBytes = 0;
    let turnCounter = 0;
    let socketClosed = false;
    let providerClosed = false;

    function log(stage, extra = {}) {
        const details = Object.entries(extra)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
        console.log(`[Realtime] session=${sessionId} stage=${stage} ${details}`.trim());
    }

    function emit(payload) {
        if (socketClosed || socket.destroyed) return false;
        return sendJson(socket, {
            session_id: sessionId,
            server_time_ms: Date.now(),
            ...payload,
        });
    }

    function cancelCurrent(reason) {
        if (!currentCancel || currentCancel.cancelled) return;
        currentCancel.cancel(reason);
        providerSession.interrupt(reason);
        const cancelledResponseId = currentResponseId;
        const cancelledTurnId = currentTurnId;
        const cancelLatencyMs = Date.now() - currentCancel.cancelledAt;
        emit({
            type: 'response.cancelled',
            response_id: cancelledResponseId,
            turn_id: cancelledTurnId,
            reason,
            cancel_latency_ms: cancelLatencyMs,
        });
        log('response_cancelled', {
            responseId: cancelledResponseId,
            turnId: cancelledTurnId,
            reason,
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
        currentResponseId = null;
        currentCancel = null;
        inputStartedAt = Date.now();
        inputEndedAt = 0;
        inputBytes = 0;
        emit({
            type: 'input_audio.start',
            turn_id: currentTurnId,
        });
        log('input_audio_start', { turnId: currentTurnId });
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
        currentResponseId = id('response');
        currentCancel = createCancellation();

        emit({
            type: 'input_audio.end',
            turn_id: currentTurnId,
            duration_ms: recordingDurationMs,
            bytes: inputBytes,
        });
        emit({
            type: 'response.created',
            response_id: currentResponseId,
            turn_id: currentTurnId,
            input_bytes: inputBytes,
        });
        log('input_audio_end', {
            turnId: currentTurnId,
            durationMs: recordingDurationMs,
            bytes: inputBytes,
            responseId: currentResponseId,
        });

        const responseIdForStream = currentResponseId;
        const turnIdForStream = currentTurnId;
        const cancelForStream = currentCancel;

        providerSession.endInput({
            responseId: responseIdForStream,
            turnId: turnIdForStream,
            signal: cancelForStream,
            onEvent(payload) {
                emit(payload);
                if (
                    payload.type === 'audio.end'
                    && currentResponseId === responseIdForStream
                    && currentTurnId === turnIdForStream
                ) {
                    currentCancel = null;
                }
            },
            onAudioChunk: emit,
            log,
        }).catch((error) => {
            emit({
                type: 'error',
                response_id: responseIdForStream,
                turn_id: turnIdForStream,
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
            emit({
                type: 'session.ready',
                session_id: sessionId,
                provider: providerSession.name || 'mock',
                provider_instance_id: providerSession.instanceId || null,
                config: DEFAULT_CONFIG,
            });
            log('session_ready_again');
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
            providerSession.sendAudio(payload);
            log('input_audio_frame', {
                turnId: currentTurnId || 'none',
                bytes: payload.length,
                totalBytes: inputBytes,
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
