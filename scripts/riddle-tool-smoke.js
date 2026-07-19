'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const { attachRealtimeServer } = require('../src/realtime/realtimeServer');

const PORT = Number(process.env.RIDDLE_TOOL_PORT || 3399);
const HOST = '127.0.0.1';
const TIMEOUT_MS = 6000;

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
    } else {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(data.length, 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.from(data);
    for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
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
        const timer = setTimeout(() => reject(new Error('riddle tool smoke timeout')), TIMEOUT_MS);

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
                if (rest.length > 0) parseServerFrames(parserState, rest, (text) => events.push(JSON.parse(text)));
                clearTimeout(timer);
                resolve({
                    socket,
                    events,
                    sendJson(payload) { socket.write(encodeClientFrame(0x1, JSON.stringify(payload))); },
                    sendBinary(payload) { socket.write(encodeClientFrame(0x2, payload)); },
                    waitFor(type, predicate = null, timeoutMs = TIMEOUT_MS) {
                        return new Promise((eventResolve, eventReject) => {
                            const startedAt = Date.now();
                            const interval = setInterval(() => {
                                const match = events.find((event) => event.type === type && (!predicate || predicate(event)));
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
                    close() { socket.destroy(); },
                });
            } else {
                parseServerFrames(parserState, chunk, (text) => events.push(JSON.parse(text)));
            }
        });
        socket.on('error', reject);
    });
}

class RiddleToolProvider {
    constructor() {
        this.counter = 0;
        this.sessions = [];
    }
    createSession(options = {}) {
        this.counter += 1;
        const session = new RiddleToolProviderSession(`riddle_tool_session_${this.counter}`, options);
        this.sessions.push(session);
        return session;
    }
}

class RiddleToolProviderSession {
    constructor(instanceId, options = {}) {
        this.name = 'riddle-tool-test';
        this.instanceId = instanceId;
        this.voiceName = 'TestVoice';
        this.voiceConfigSource = 'test';
        this.systemInstructionMeta = options.systemInstructionMeta || {};
        this.promptSource = options.promptSource || 'test';
        this.rotationReason = options.rotationReason || 'initial';
        this.rotateOnInterrupt = false;
        this.rotateAfterOutputComplete = false;
        this.toolHandlers = options.toolHandlers || {};
        this.toolResults = [];
        this.activityResults = [];
    }
    async connect() { return this; }
    close() {}
    destroySession() {}
    interrupt() {}
    sendAudio() {}
    beginResponse(context) { this.active = context; }
    async endInput(context) {
        const textByTurn = {
            ask_riddle: '\u0417\u0430\u0433\u0430\u0434\u0430\u0439 \u0437\u0430\u0433\u0430\u0434\u043a\u0443 \u043f\u0440\u043e \u043b\u044f\u0433\u0443\u0448\u043a\u0443',
            ask_again_active: '\u0415\u0449\u0451 \u043e\u0434\u043d\u0443 \u0437\u0430\u0433\u0430\u0434\u043a\u0443',
            wrong_answer: '\u043a\u0430\u043c\u0435\u043d\u044c',
            correct_answer: '\u043b\u044f\u0433\u0443\u0448\u043a\u0430',
            ask_after_complete: '\u0417\u0430\u0433\u0430\u0434\u0430\u0439 \u0437\u0430\u0433\u0430\u0434\u043a\u0443',
            greeting_misfire: '\u041b\u0443\u043d\u0430\u0440\u0430, \u043f\u0440\u0438\u0432\u0435\u0442',
        };
        if (context.turnId !== 'ask_again_active') {
            context.onEvent({ type: 'transcript.user', response_id: context.responseId, turn_id: context.turnId, text: textByTurn[context.turnId] || 'test' });
        }
        if (context.turnId === 'ask_riddle' || context.turnId === 'ask_again_active' || context.turnId === 'ask_after_complete' || context.turnId === 'greeting_misfire') {
            const result = await this.toolHandlers.get_riddle({
                args: context.turnId === 'ask_riddle' ? { topic: '\u043b\u044f\u0433\u0443\u0448\u043a\u0430', language: 'ru' } : { language: 'ru' },
                generationId: context.generationId,
                responseId: context.responseId,
                turnId: context.turnId,
                providerInstanceId: this.instanceId,
            });
            this.toolResults.push(result);
            context.onEvent({ type: 'tool.call', response_id: context.responseId, turn_id: context.turnId, tool_name: 'get_riddle' });
            context.onEvent({ type: 'tool.response', response_id: context.responseId, turn_id: context.turnId, tool_names: ['get_riddle'] });
            if (!result.error) this.emitAudio(context, 'Riddle: ' + result.text);
        }
    }
    sendActivityResult(result) {
        this.activityResults.push(result);
        if (this.active) this.emitAudio(this.active, result.correct ? 'Correct.' : 'Not yet, try again.');
        return true;
    }
    emitAudio(context, text) {
        context.onEvent({ type: 'transcript.model', response_id: context.responseId, turn_id: context.turnId, text });
        context.onAudioChunk({ type: 'audio.start', response_id: context.responseId, turn_id: context.turnId, elapsed_ms: 1 });
        context.onAudioChunk({ type: 'audio.chunk', response_id: context.responseId, turn_id: context.turnId, chunk_index: 0, audio_base64: Buffer.alloc(16, 1).toString('base64') });
        context.onAudioChunk({ type: 'audio.end', response_id: context.responseId, turn_id: context.turnId, cause: 'test' });
    }
}

async function runTurn(client, turnId) {
    client.sendJson({ type: 'input_audio.start', turn_id: turnId });
    client.sendBinary(Buffer.alloc(3200, 1));
    client.sendJson({ type: 'input_audio.end' });
    await sleep(80);
}

async function main() {
    const provider = new RiddleToolProvider();
    const server = http.createServer((req, res) => {
        res.writeHead(404);
        res.end('not found');
    });
    attachRealtimeServer(server, {
        providerFactory: (sessionOptions) => provider.createSession(sessionOptions),
        providerMetadata: { provider: 'riddle-tool-test', model: 'test', contentToolsEnabled: true },
    });

    await new Promise((resolve) => server.listen(PORT, HOST, resolve));
    try {
        const client = await connectWs();
        await client.waitFor('session.ready');
        await runTurn(client, 'ask_riddle');
        await client.waitFor('activity.started', (event) => event.content_id === 'riddle_ru_v2_001');
        assert.strictEqual(provider.sessions[0].toolResults.length, 1, 'first riddle request should call get_riddle once');
        assert.strictEqual(provider.sessions[0].toolResults[0].source, 'library', 'first riddle should come from library');
        await runTurn(client, 'ask_again_active');
        assert.strictEqual(provider.sessions[0].toolResults[1].error, 'active_riddle_in_progress', 'new riddle should be blocked while active');
        await runTurn(client, 'wrong_answer');
        const wrong = await client.waitFor('activity.answer_checked', (event) => event.turn_id === 'wrong_answer');
        assert.strictEqual(wrong.correct, false, 'wrong answer should be marked incorrect');
        assert.strictEqual(wrong.attempts, 1, 'wrong answer should increment attempts');
        await runTurn(client, 'correct_answer');
        const correct = await client.waitFor('activity.answer_checked', (event) => event.turn_id === 'correct_answer');
        assert.strictEqual(correct.correct, true, 'correct answer should be marked correct');
        assert.strictEqual(correct.completed, true, 'correct answer should complete activity');
        await runTurn(client, 'ask_after_complete');
        await client.waitFor('activity.started', (event) => event.turn_id === 'ask_after_complete');
        assert.strictEqual(provider.sessions[0].toolResults.length, 3, 'new riddle should be allowed after completion');
        await runTurn(client, 'greeting_misfire');
        assert.strictEqual(provider.sessions[0].toolResults[3].error, 'riddle_not_requested', 'greeting must not start a riddle');

        client.close();
        console.log('[riddle-tool-smoke] ok');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
});
