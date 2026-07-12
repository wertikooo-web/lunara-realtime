'use strict';

const crypto = require('crypto');
const http = require('http');
const net = require('net');
const { attachRealtimeServer } = require('../src/realtime/realtimeServer');

const PORT = Number(process.env.REGRESSION_PORT || 3299);
const HOST = '127.0.0.1';
const TIMEOUT_MS = 5000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeClientFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
    const mask = crypto.randomBytes(4);
    let header;

    if (data.length < 126) {
        header = Buffer.alloc(2);
        header[1] = 0x80 | data.length;
    } else if (data.length < 65536) {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(data.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(data.length), 2);
    }

    header[0] = 0x80 | opcode;
    const masked = Buffer.from(data);
    for (let index = 0; index < masked.length; index += 1) {
        masked[index] ^= mask[index % 4];
    }
    return Buffer.concat([header, mask, masked]);
}

function parseServerFrames(state, chunk, onText) {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    while (state.buffer.length >= 2) {
        const opcode = state.buffer[0] & 0x0f;
        let length = state.buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
            if (state.buffer.length < 4) return;
            length = state.buffer.readUInt16BE(2);
            offset = 4;
        } else if (length === 127) {
            if (state.buffer.length < 10) return;
            length = Number(state.buffer.readBigUInt64BE(2));
            offset = 10;
        }
        if (state.buffer.length < offset + length) return;
        const payload = state.buffer.subarray(offset, offset + length);
        state.buffer = state.buffer.subarray(offset + length);
        if (opcode === 0x1) onText(payload.toString('utf8'));
    }
}

function connectWs() {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(PORT, HOST);
        const key = crypto.randomBytes(16).toString('base64');
        let handshake = Buffer.alloc(0);
        let connected = false;
        const parserState = { buffer: Buffer.alloc(0) };
        const events = [];
        const timer = setTimeout(() => reject(new Error('WebSocket regression timeout')), TIMEOUT_MS);

        socket.on('connect', () => {
            socket.write([
                'GET /realtime HTTP/1.1',
                `Host: ${HOST}:${PORT}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Key: ${key}`,
                'Sec-WebSocket-Version: 13',
                '',
                '',
            ].join('\r\n'));
        });

        socket.on('data', (chunk) => {
            if (!connected) {
                handshake = Buffer.concat([handshake, chunk]);
                const marker = handshake.indexOf('\r\n\r\n');
                if (marker === -1) return;
                const head = handshake.subarray(0, marker).toString('utf8');
                if (!head.includes('101 Switching Protocols')) {
                    clearTimeout(timer);
                    reject(new Error(`Handshake failed: ${head}`));
                    socket.destroy();
                    return;
                }
                connected = true;
                const rest = handshake.subarray(marker + 4);
                if (rest.length > 0) {
                    parseServerFrames(parserState, rest, (text) => events.push(JSON.parse(text)));
                }
                clearTimeout(timer);
                resolve({
                    socket,
                    events,
                    sendJson(payload) {
                        socket.write(encodeClientFrame(0x1, JSON.stringify(payload)));
                    },
                    sendBinary(payload) {
                        socket.write(encodeClientFrame(0x2, payload));
                    },
                    waitFor(type, predicate = null, timeoutMs = TIMEOUT_MS) {
                        return new Promise((eventResolve, eventReject) => {
                            const startedAt = Date.now();
                            const interval = setInterval(() => {
                                const match = events.find((event) => (
                                    event.type === type && (!predicate || predicate(event))
                                ));
                                if (match) {
                                    clearInterval(interval);
                                    eventResolve(match);
                                } else if (Date.now() - startedAt > timeoutMs) {
                                    clearInterval(interval);
                                    eventReject(new Error(`Timed out waiting for ${type}`));
                                }
                            }, 20);
                        });
                    },
                    close() {
                        socket.destroy();
                    },
                });
            } else {
                parseServerFrames(parserState, chunk, (text) => events.push(JSON.parse(text)));
            }
        });

        socket.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

class RegressionProvider {
    constructor() {
        this.name = 'regression';
        this.counter = 0;
        this.sessions = [];
    }

    createSession(options = {}) {
        this.counter += 1;
        const session = new RegressionProviderSession(`regression_session_${this.counter}`, options);
        this.sessions.push(session);
        return session;
    }
}

class RegressionProviderSession {
    constructor(instanceId, options = {}) {
        this.name = 'regression';
        this.rotateOnInterrupt = true;
        this.rotateAfterOutputComplete = true;
        this.instanceId = instanceId;
        this.voiceName = options.voiceName || 'RegressionFemale';
        this.voiceConfigSource = options.voiceConfigSource || 'test';
        this.audioBytes = 0;
        this.activeSignal = null;
        this.activeContext = null;
        this.closed = false;
    }

    sendAudio(buffer) {
        if (this.closed) return;
        this.audioBytes += Buffer.isBuffer(buffer) ? buffer.length : 0;
    }

    interrupt(reason = 'interrupt', context = {}) {
        if (this.closed) return;
        if (this.activeSignal && !this.activeSignal.cancelled) {
            this.activeSignal.cancel(reason);
        }
        const interruptedContext = context;
        setTimeout(() => {
            if (this.closed) return;
            const emit = this.activeContext?.onSessionEvent;
            if (!emit || !interruptedContext.interrupted_generation_id) return;
            emit({
                type: 'provider_interrupt_ack',
                interrupted_generation_id: interruptedContext.interrupted_generation_id,
                interrupted_turn_id: interruptedContext.interrupted_turn_id,
                interrupted_response_id: interruptedContext.interrupted_response_id,
                provider_instance_id: this.instanceId,
                current_active_generation_id: this.activeContext?.generationId || null,
                matched: true,
                ignored_for_active_generation: true,
            });
        }, 120);
    }

    destroySession() {
        this.closed = true;
        if (this.activeSignal && !this.activeSignal.cancelled) {
            this.activeSignal.cancel('destroy_session');
        }
    }

    close() {
        this.destroySession();
    }

    beginResponse(context) {
        if (this.closed) return;
        this.activeContext = context;
    }

    async endInput(context) {
        if (this.closed) return;
        this.activeSignal = context.signal;
        this.activeContext = context;
        if (context.turnId === 'timeout_ptt') {
            return;
        }
        if (context.turnId === 'empty_turn_complete_ptt') {
            await sleep(20);
            if (this.closed || context.signal.cancelled) return;
            context.onEvent({
                type: 'response.failed',
                response_id: context.responseId,
                turn_id: context.turnId,
                reason: 'provider_turn_complete_without_model_output',
            });
            return;
        }
        context.onEvent({
            type: 'transcript.user',
            response_id: context.responseId,
            turn_id: context.turnId,
            text: `heard ${context.turnInputBytes}`,
        });
        await sleep(context.turnInputBytes <= 2 ? 5 : 25);
        if (this.closed || context.signal.cancelled) return;
        context.onEvent({
            type: 'audio.start',
            response_id: context.responseId,
            turn_id: context.turnId,
            elapsed_ms: 1,
            format: 'audio/pcm',
            turn_input_bytes: context.turnInputBytes,
            session_input_bytes: context.sessionInputBytes,
        });
        context.onAudioChunk({
            type: 'audio.chunk',
            response_id: context.responseId,
            turn_id: context.turnId,
            chunk_index: 0,
            mime_type: 'audio/pcm',
            sample_rate: 24000,
            audio_base64: Buffer.alloc(8).toString('base64'),
            elapsed_ms: 2,
        });
        await sleep(250);
        if (this.closed || context.signal.cancelled) return;
        context.onEvent({
            type: 'transcript.model',
            response_id: context.responseId,
            turn_id: context.turnId,
            text: 'late text',
        });
        context.onAudioChunk({
            type: 'audio.chunk',
            response_id: context.responseId,
            turn_id: context.turnId,
            chunk_index: 1,
            mime_type: 'audio/pcm',
            sample_rate: 24000,
            audio_base64: Buffer.alloc(8).toString('base64'),
            elapsed_ms: 90,
        });
        context.onEvent({
            type: 'audio.end',
            response_id: context.responseId,
            turn_id: context.turnId,
            elapsed_ms: 100,
        });
    }
}

async function runTurn(client, turnId, bytes, options = {}) {
    client.sendJson({ type: 'input_audio.start', turn_id: turnId, mode: 'push_to_talk' });
    if (bytes > 0) client.sendBinary(Buffer.alloc(bytes, 1));
    client.sendJson({ type: 'input_audio.end' });
    const inputStart = await client.waitFor('input_audio.start', (event) => event.turn_id === turnId);
    const inputEnd = await client.waitFor('input_audio.end', (event) => event.turn_id === turnId);
    const userTranscript = await client.waitFor('transcript.user', (event) => event.turn_id === turnId);
    const responseCreated = await client.waitFor('response.created', (event) => event.turn_id === turnId);
    const audioStart = await client.waitFor('audio.start', (event) => event.turn_id === turnId);
    const audioChunk = await client.waitFor('audio.chunk', (event) => event.turn_id === turnId);
    const audioEnd = options.waitForEnd
        ? await client.waitFor('audio.end', (event) => event.turn_id === turnId)
        : null;
    const createdCount = client.events.filter((event) => (
        event.type === 'response.created' && event.turn_id === turnId
    )).length;
    if (createdCount !== 1) {
        throw new Error(`Expected one response.created for ${turnId}, got ${createdCount}`);
    }
    if (inputStart.response_id !== null) {
        throw new Error(`input_audio.start must not have response_id before model output: ${inputStart.response_id}`);
    }
    if (inputEnd.response_id !== null) {
        throw new Error(`input_audio.end must have response_id=null before model output: ${inputEnd.response_id}`);
    }
    if (userTranscript.response_id !== null) {
        throw new Error(`transcript.user must have response_id=null before model output: ${userTranscript.response_id}`);
    }
    if (!responseCreated.response_id) {
        throw new Error('response.created must create response_id');
    }
    return { inputStart, inputEnd, userTranscript, responseCreated, audioStart, audioChunk, audioEnd };
}

async function main() {
    const originalTimeout = process.env.PTT_TURN_TIMEOUT_MS;
    process.env.PTT_TURN_TIMEOUT_MS = '200';
    const logs = [];
    const originalLog = console.log;
    console.log = (message, ...args) => {
        logs.push(String(message));
        originalLog(message, ...args);
    };

    const provider = new RegressionProvider();
    const server = http.createServer((req, res) => {
        res.writeHead(404);
        res.end();
    });
    attachRealtimeServer(server, {
        providerFactory: (sessionOptions) => provider.createSession(sessionOptions),
        providerMetadata: { provider: 'regression', model: 'regression', defaultVoiceName: 'RegressionFemale' },
    });

    await new Promise((resolve) => server.listen(PORT, HOST, resolve));

    try {
        const client = await connectWs();
        await client.waitFor('session.ready');

        const normal = await runTurn(client, 'normal_ptt', 3200, { waitForEnd: true });
        if (normal.responseCreated.turn_input_bytes !== 3200) {
            throw new Error('Normal PTT turn did not preserve input bytes');
        }
        const normalRotation = await client.waitFor(
            'provider.rotated',
            (event) => event.reason === 'output_generation_complete',
        );
        if (normalRotation.old_provider_instance_id === normalRotation.new_provider_instance_id) {
            throw new Error('Completed output must rotate provider session');
        }
        if (!normalRotation.voice_preserved || normalRotation.old_provider_voice_name !== 'RegressionFemale' || normalRotation.new_provider_voice_name !== 'RegressionFemale') {
            throw new Error('Completed output rotation must preserve voiceName');
        }
        if (!provider.sessions.find((session) => (
            session.instanceId === normalRotation.old_provider_instance_id && session.closed
        ))) {
            throw new Error('Completed output must hard-close the old provider session');
        }
        client.sendBinary(Buffer.alloc(512, 9));
        await sleep(40);
        const rotatedIdleSession = provider.sessions.find((session) => (
            session.instanceId === normalRotation.new_provider_instance_id
        ));
        if (!rotatedIdleSession || rotatedIdleSession.audioBytes !== 0) {
            throw new Error('Stray audio between turns must not reach the fresh provider session');
        }

        const short = await runTurn(client, 'short_ptt', 2, { waitForEnd: true });
        if (!short.userTranscript.text) {
            throw new Error('Short PTT turn did not emit transcript.user');
        }

        const interrupted = await runTurn(client, 'interrupt_ptt', 6400);
        client.sendJson({ type: 'session.interrupt', reason: 'manual_regression' });
        await client.waitFor('response.cancelled', (event) => event.turn_id === 'interrupt_ptt');
        client.sendJson({ type: 'input_audio.start', turn_id: 'after_interrupt_ptt', mode: 'push_to_talk' });
        client.sendBinary(Buffer.alloc(4096, 2));
        const turnBAck = await client.waitFor('input_audio.start', (event) => event.turn_id === 'after_interrupt_ptt');
        const rotation = await client.waitFor('provider.rotated', (event) => event.reason === 'manual_regression');
        if (rotation.old_provider_instance_id === rotation.new_provider_instance_id) {
            throw new Error('Provider rotation must create a new provider instance');
        }
        if (!rotation.voice_preserved || rotation.old_provider_voice_name !== 'RegressionFemale' || rotation.new_provider_voice_name !== 'RegressionFemale') {
            throw new Error('Manual interrupt rotation must preserve voiceName');
        }
        if (provider.sessions.length < 2 || !provider.sessions[0].closed) {
            throw new Error('Old provider session must be hard-closed after manual interruption');
        }
        client.sendJson({ type: 'input_audio.end' });
        const turnB = await client.waitFor('response.created', (event) => event.turn_id === 'after_interrupt_ptt');
        await client.waitFor('audio.end', (event) => event.turn_id === 'after_interrupt_ptt');
        const turnBProviderSession = provider.sessions.find((session) => (
            session.instanceId === rotation.new_provider_instance_id
        ));
        if (!turnBProviderSession || turnBProviderSession.audioBytes !== 4096) {
            throw new Error(`Turn B audio must be routed to the new provider session, got ${turnBProviderSession?.audioBytes}`);
        }
        const turnBCancelled = client.events.find((event) => (
            event.type === 'response.cancelled' && event.turn_id === 'after_interrupt_ptt'
        ));
        if (turnBCancelled) {
            throw new Error('Late provider interrupt ack cancelled the new turn');
        }
        if (!turnB.response_id) {
            throw new Error('Second turn did not receive response after provider interrupt ack');
        }
        await sleep(320);
        const lateAck = client.events.find((event) => (
            event.type === 'provider_interrupt_ack'
            && event.interrupted_generation_id === interrupted.responseCreated.generation_id
        ));
        if (lateAck) {
            throw new Error('Hard-closed old provider session must not emit late provider_interrupt_ack');
        }
        const lateChunks = client.events.filter((event) => (
            event.type === 'audio.chunk'
            && event.generation_id === interrupted.responseCreated.generation_id
            && event.chunk_index === 1
        ));
        if (lateChunks.length !== 0) {
            throw new Error('Late audio.chunk escaped after cancellation');
        }
        const lateModel = client.events.filter((event) => (
            event.type === 'transcript.model'
            && event.generation_id === interrupted.responseCreated.generation_id
        ));
        if (lateModel.length !== 0) {
            throw new Error('Late transcript.model escaped after cancellation');
        }
        if (!logs.some((line) => line.includes('stage=provider_session_rotated') && line.includes('reason=manual_regression'))) {
            throw new Error('Missing provider_session_rotated log for manual interruption');
        }

        client.sendJson({ type: 'input_audio.start', turn_id: 'timeout_ptt', mode: 'push_to_talk' });
        client.sendBinary(Buffer.alloc(1024, 3));
        const timeoutProviderSession = provider.sessions[provider.sessions.length - 1];
        client.sendJson({ type: 'input_audio.end' });
        client.sendBinary(Buffer.alloc(256, 8));
        await sleep(40);
        if (timeoutProviderSession.audioBytes !== 1024) {
            throw new Error('Late audio after input_audio.end must not reach provider');
        }
        const failed = await client.waitFor('response.failed', (event) => event.turn_id === 'timeout_ptt', 2000);
        if (failed.reason !== 'provider_timeout') {
            throw new Error(`Timeout failure reason mismatch: ${failed.reason}`);
        }
        const timeoutRotation = await client.waitFor('provider.rotated', (event) => event.reason === 'provider_timeout', 2000);
        if (timeoutRotation.old_provider_instance_id === timeoutRotation.new_provider_instance_id) {
            throw new Error('Timeout recovery must rotate provider session');
        }
        if (!timeoutRotation.voice_preserved || timeoutRotation.old_provider_voice_name !== 'RegressionFemale' || timeoutRotation.new_provider_voice_name !== 'RegressionFemale') {
            throw new Error('Timeout recovery rotation must preserve voiceName');
        }
        if (!logs.some((line) => line.includes('stage=turn_timeout_recovery_started'))) {
            throw new Error('Missing turn_timeout_recovery_started log');
        }
        if (!logs.some((line) => line.includes('stage=turn_timeout_recovery_completed'))) {
            throw new Error('Missing turn_timeout_recovery_completed log');
        }

        client.sendJson({ type: 'input_audio.start', turn_id: 'empty_turn_complete_ptt', mode: 'push_to_talk' });
        client.sendBinary(Buffer.alloc(2048, 4));
        client.sendJson({ type: 'input_audio.end' });
        const noOutputFailed = await client.waitFor(
            'response.failed',
            (event) => (
                event.turn_id === 'empty_turn_complete_ptt'
                && event.reason === 'provider_turn_complete_without_model_output'
            ),
            2000,
        );
        if (noOutputFailed.response_id) {
            throw new Error('Provider no-output failure must not create response_id');
        }
        const noOutputRotation = await client.waitFor(
            'provider.rotated',
            (event) => event.reason === 'provider_turn_complete_without_model_output',
            2000,
        );
        if (noOutputRotation.old_provider_instance_id === noOutputRotation.new_provider_instance_id) {
            throw new Error('No-output provider failure must rotate provider session');
        }
        if (!noOutputRotation.voice_preserved || noOutputRotation.old_provider_voice_name !== 'RegressionFemale' || noOutputRotation.new_provider_voice_name !== 'RegressionFemale') {
            throw new Error('No-output provider failure rotation must preserve voiceName');
        }

        const afterTimeout = await runTurn(client, 'after_timeout_ptt', 2048, { waitForEnd: true });
        if (!afterTimeout.responseCreated.response_id) {
            throw new Error('Following turn after timeout recovery did not succeed');
        }

        console.log('[PttLifecycleRegression] ok');
        client.close();
    } finally {
        console.log = originalLog;
        if (originalTimeout === undefined) delete process.env.PTT_TURN_TIMEOUT_MS;
        else process.env.PTT_TURN_TIMEOUT_MS = originalTimeout;
        await new Promise((resolve) => {
            server.close(() => resolve());
            setTimeout(resolve, 250);
        });
    }
}

main().catch((error) => {
    console.error(`[PttLifecycleRegression] failed message="${error.message}"`);
    process.exit(1);
});
