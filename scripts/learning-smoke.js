'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const { attachRealtimeServer } = require('../src/realtime/realtimeServer');

const PORT = Number(process.env.LEARNING_SMOKE_PORT || 3499);
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
        const timer = setTimeout(() => reject(new Error('learning smoke timeout')), TIMEOUT_MS);

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
                                    eventReject(new Error(`Timed out waiting for event type ${type}`));
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

class LearningToolProvider {
    constructor() {
        this.counter = 0;
        this.sessions = [];
    }
    createSession(options = {}) {
        this.counter += 1;
        const session = new LearningToolProviderSession(`learning_tool_session_${this.counter}`, options);
        this.sessions.push(session);
        return session;
    }
}

class LearningToolProviderSession {
    constructor(instanceId, options = {}) {
        this.name = 'learning-tool-test';
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
            start_zh: 'хочу звук Ж',
            wrong_zh: 'зззз',
            correct_zh: 'жжж',
            next_zh: 'давай дальше',
            skip_zh: 'пропусти это',
            next_again_zh: 'следующее',
            start_en: 'want english animals',
            correct_en: 'cat',
        };
        context.onEvent({ type: 'transcript.user', response_id: context.responseId, turn_id: context.turnId, text: textByTurn[context.turnId] || 'test' });
        
        const gId = context.generationId;
        const rId = context.responseId;
        const tId = context.turnId;
        const instId = this.instanceId;

        // Simulate model calling tools based on user intents
        if (tId === 'start_zh') {
            const result = await this.toolHandlers.learning_start({ args: { moduleId: 'speech_development_zh' }, generationId: gId, responseId: rId, turnId: tId, providerInstanceId: instId });
            this.toolResults.push({ name: 'learning_start', result });
            context.onEvent({ type: 'tool.call', response_id: rId, turn_id: tId, tool_name: 'learning_start' });
            context.onEvent({ type: 'tool.response', response_id: rId, turn_id: tId, tool_names: ['learning_start'] });
            this.emitAudio(context, 'Instruction: ' + result.exercise.instruction);
        } else if (tId === 'next_zh' || tId === 'next_again_zh') {
            const result = await this.toolHandlers.learning_get_next_exercise({ args: {}, generationId: gId, responseId: rId, turnId: tId, providerInstanceId: instId });
            this.toolResults.push({ name: 'learning_get_next_exercise', result });
            context.onEvent({ type: 'tool.call', response_id: rId, turn_id: tId, tool_name: 'learning_get_next_exercise' });
            context.onEvent({ type: 'tool.response', response_id: rId, turn_id: tId, tool_names: ['learning_get_next_exercise'] });
            if (result.exercise) {
                this.emitAudio(context, 'Instruction: ' + result.exercise.instruction);
            } else {
                this.emitAudio(context, 'Finished: ' + result.message);
            }
        } else if (tId === 'skip_zh') {
            const result = await this.toolHandlers.learning_skip_exercise({ args: {}, generationId: gId, responseId: rId, turnId: tId, providerInstanceId: instId });
            this.toolResults.push({ name: 'learning_skip_exercise', result });
            context.onEvent({ type: 'tool.call', response_id: rId, turn_id: tId, tool_name: 'learning_skip_exercise' });
            context.onEvent({ type: 'tool.response', response_id: rId, turn_id: tId, tool_names: ['learning_skip_exercise'] });
            this.emitAudio(context, 'Skipped current task.');
        } else if (tId === 'start_en') {
            const result = await this.toolHandlers.learning_start({ args: { moduleId: 'english_vocabulary_animals' }, generationId: gId, responseId: rId, turnId: tId, providerInstanceId: instId });
            this.toolResults.push({ name: 'learning_start', result });
            context.onEvent({ type: 'tool.call', response_id: rId, turn_id: tId, tool_name: 'learning_start' });
            context.onEvent({ type: 'tool.response', response_id: rId, turn_id: tId, tool_names: ['learning_start'] });
            this.emitAudio(context, 'Instruction: ' + result.exercise.instruction);
        }
    }
    sendActivityResult(result) {
        this.activityResults.push(result);
        if (this.active) {
            this.emitAudio(this.active, result.correct ? 'Correct!' : 'Incorrect. Hint: ' + result.hint);
        }
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
    await sleep(100);
}

async function main() {
    const provider = new LearningToolProvider();
    const server = http.createServer((req, res) => {
        res.writeHead(404);
        res.end('not found');
    });
    attachRealtimeServer(server, {
        providerFactory: (sessionOptions) => provider.createSession(sessionOptions),
        providerMetadata: { provider: 'learning-tool-test', model: 'test', contentToolsEnabled: true },
    });

    await new Promise((resolve) => server.listen(PORT, HOST, resolve));
    try {
        const client = await connectWs();
        await client.waitFor('session.ready');

        // 1. Start Sound ZH module
        await runTurn(client, 'start_zh');
        await client.waitFor('activity.started', (event) => event.activity_type === 'learning' && event.content_id === 'speech_zh_001');
        assert.strictEqual(provider.sessions[0].toolResults.length, 1);
        assert.strictEqual(provider.sessions[0].toolResults[0].name, 'learning_start');

        // 2. Answer wrong
        await runTurn(client, 'wrong_zh');
        const wrongCheck = await client.waitFor('activity.answer_checked', (event) => event.turn_id === 'wrong_zh');
        assert.strictEqual(wrongCheck.correct, false);
        assert.strictEqual(wrongCheck.attempts, 1);
        assert.ok(wrongCheck.hint && wrongCheck.hint.includes('Прижми язык'));

        // 3. Answer correct
        await runTurn(client, 'correct_zh');
        const correctCheck = await client.waitFor('activity.answer_checked', (event) => event.turn_id === 'correct_zh');
        assert.strictEqual(correctCheck.correct, true);
        assert.strictEqual(correctCheck.completed, true);

        // 4. Get next exercise (should load speech_zh_002)
        await runTurn(client, 'next_zh');
        await client.waitFor('activity.started', (event) => event.activity_type === 'learning' && event.content_id === 'speech_zh_002');
        assert.strictEqual(provider.sessions[0].toolResults[1].name, 'learning_get_next_exercise');

        // 5. Skip exercise
        await runTurn(client, 'skip_zh');
        assert.strictEqual(provider.sessions[0].toolResults[2].name, 'learning_skip_exercise');

        // 6. Get next exercise (should load speech_zh_003)
        await runTurn(client, 'next_again_zh');
        await client.waitFor('activity.started', (event) => event.activity_type === 'learning' && event.content_id === 'speech_zh_003');

        // 7. Get progress info via direct tool handler call to verify values
        const progress = await provider.sessions[0].toolHandlers.learning_get_progress({
            generationId: provider.sessions[0].active.generationId,
            turnId: 'progress_check'
        });
        assert.strictEqual(progress.moduleId, 'speech_development_zh');
        assert.strictEqual(progress.currentIndex, 2); // speech_zh_003 is index 2
        assert.strictEqual(progress.completedCount, 1); // Only speech_zh_001 was completed
        assert.strictEqual(progress.totalExercises, 20);

        // 8. End the sound ZH session
        const finish = await provider.sessions[0].toolHandlers.learning_finish_session({
            generationId: provider.sessions[0].active.generationId,
            turnId: 'finish_check'
        });
        assert.strictEqual(finish.status, 'finished');
        assert.strictEqual(finish.stats.completedCount, 1);

        // 9. Start English vocabulary animals module
        await runTurn(client, 'start_en');
        await client.waitFor('activity.started', (event) => event.activity_type === 'learning' && event.content_id === 'english_animals_001');

        // 10. Verify animal module answer check
        const activeAct = provider.sessions[0].toolResults.find(r => r.name === 'learning_start' && r.result.moduleId === 'english_vocabulary_animals');
        assert.ok(activeAct);

        client.close();
        console.log('[learning-smoke] ok');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
});
