'use strict';

// Integration-level smoke test for the input resampling PIPELINE wiring in
// realtimeServer.js (session.start sample-rate validation, onBinary
// resampling, and reset/flush at turn/interrupt/close boundaries). Complements
// scripts/pcm-resampler-smoke.js, which covers the DSP itself in isolation
// (chunk-boundary bit-exactness, anti-aliasing, exact output sample count,
// tail-flush correctness) — this file proves those guarantees actually hold
// once wired into the real WebSocket session lifecycle, with no preload/
// monkey-patch layer (attachRealtimeServer is used directly, same as
// scripts/ptt-lifecycle-regression.js).

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const { attachRealtimeServer } = require('../src/realtime/realtimeServer');

const PORT = Number(process.env.RESAMPLE_PIPELINE_PORT || 3299 + 1);
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
        const timer = setTimeout(() => reject(new Error('WebSocket pipeline smoke timeout')), TIMEOUT_MS);

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
                clearTimeout(timer);
                resolve({
                    events,
                    sendJson(payload) {
                        socket.write(encodeClientFrame(0x1, JSON.stringify(payload)));
                    },
                    sendBinary(payload) {
                        socket.write(encodeClientFrame(0x2, payload));
                    },
                    // sinceIndex lets callers ignore events already seen from
                    // an earlier action on the same long-lived connection
                    // (e.g. a second session.start's session.config.applied,
                    // which would otherwise spuriously match the first one).
                    waitFor(type, predicate = null, timeoutMs = TIMEOUT_MS, sinceIndex = 0) {
                        return new Promise((eventResolve, eventReject) => {
                            const startedAt = Date.now();
                            const interval = setInterval(() => {
                                const match = events.slice(sinceIndex).find((event) => (
                                    event.type === type && (!predicate || predicate(event))
                                ));
                                if (match) {
                                    clearInterval(interval);
                                    eventResolve(match);
                                } else if (Date.now() - startedAt > timeoutMs) {
                                    clearInterval(interval);
                                    eventReject(new Error(`Timed out waiting for ${type}`));
                                }
                            }, 15);
                        });
                    },
                    eventCount() {
                        return events.length;
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

// Minimal fake provider: no rotation flags set (rotateOnInterrupt/
// rotateAfterOutputComplete both undefined/falsy), so the SAME session
// instance is reused across every turn on a connection — this test only
// cares about what bytes reach sendAudio(), not about output audio, so
// endInput() just completes the turn shortly after with a bare audio.end.
class CapturingProviderSession {
    constructor(instanceId) {
        this.name = 'capture';
        this.instanceId = instanceId;
        this.voiceName = 'CaptureVoice';
        this.voiceConfigSource = 'test';
        this.systemInstructionText = '';
        this.systemInstructionMeta = {};
        this.promptSource = 'test';
        this.rotationReason = 'initial';
        this.receivedAudio = [];
        this.closed = false;
    }

    async connect() {}

    sendAudio(buffer) {
        if (this.closed) return;
        this.receivedAudio.push(Buffer.from(buffer));
    }

    beginResponse(context) {
        this.activeContext = context;
    }

    async endInput(context) {
        if (this.closed) return;
        setTimeout(() => {
            if (this.closed || context.signal.cancelled) return;
            context.onEvent({ type: 'audio.end', cause: 'turnComplete' });
        }, 5);
    }

    interrupt() {}

    sendActivityResult() {}

    close() {
        this.closed = true;
    }
}

function sinePcm16({ frequency, sampleRate, seconds = 1 }) {
    const samples = Math.round(sampleRate * seconds);
    const buffer = Buffer.alloc(samples * 2);
    for (let index = 0; index < samples; index += 1) {
        buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 20000), index * 2);
    }
    return buffer;
}

// Each call uses a unique turn_id and matches waitFor() against it
// specifically — the client's `events` array accumulates every event for
// the lifetime of the connection, so without a turn_id predicate a second
// turn's waitFor('audio.end') could spuriously match a PREVIOUS turn's
// already-received event.
async function sendTurnAudio(client, input, chunkSize = 3200) {
    const turnId = `turn_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    client.sendJson({ type: 'input_audio.start', turn_id: turnId });
    await client.waitFor('input_audio.start', (event) => event.turn_id === turnId);
    for (let offset = 0; offset < input.length; offset += chunkSize) {
        client.sendBinary(input.subarray(offset, Math.min(input.length, offset + chunkSize)));
    }
    client.sendJson({ type: 'input_audio.end' });
    await client.waitFor('audio.end', (event) => event.turn_id === turnId);
}

function totalBytes(session) {
    return session.receivedAudio.reduce((sum, chunk) => sum + chunk.length, 0);
}

async function main() {
    let session = null;
    const server = http.createServer((req, res) => {
        res.writeHead(404).end();
    });
    attachRealtimeServer(server, {
        providerFactory: () => {
            session = new CapturingProviderSession('capture_' + Math.random().toString(16).slice(2));
            return session;
        },
        providerMetadata: { provider: 'capture', model: 'capture' },
    });
    await new Promise((resolve) => server.listen(PORT, HOST, resolve));

    try {
        // --- 1. Missing sampleRate: defaults to 16000 pass-through, and the
        //        default is surfaced non-silently in session.config.applied.
        {
            const client = await connectWs();
            client.sendJson({ type: 'session.start', deviceId: 'pipeline-missing-rate' });
            const applied = await client.waitFor('session.config.applied');
            assert.strictEqual(applied.input_audio.sample_rate, 16000);
            assert.strictEqual(applied.input_audio.sample_rate_source, 'assumed_default_no_sample_rate');

            session.receivedAudio = [];
            const input = sinePcm16({ frequency: 1000, sampleRate: 16000, seconds: 0.2 });
            await sendTurnAudio(client, input);
            const received = Buffer.concat(session.receivedAudio);
            assert.deepStrictEqual(received, input, 'missing sampleRate must be byte-identical pass-through at 16000');
            client.close();
        }

        // --- 2. sampleRate: 24000 (camelCase) is resampled to ~16000Hz duration.
        {
            const client = await connectWs();
            client.sendJson({ type: 'session.start', deviceId: 'pipeline-camel-24k', sampleRate: 24000 });
            const applied = await client.waitFor('session.config.applied');
            assert.strictEqual(applied.input_audio.sample_rate, 24000);
            assert.strictEqual(applied.input_audio.sample_rate_source, 'declared');

            session.receivedAudio = [];
            const input = sinePcm16({ frequency: 1000, sampleRate: 24000, seconds: 0.5 });
            await sendTurnAudio(client, input);
            const samples = totalBytes(session) / 2;
            assert.ok(samples >= 7980 && samples <= 8040, `camelCase 24000: unexpected sample count ${samples}`);
            client.close();
        }

        // --- 3. sample_rate: 24000 (snake_case) behaves identically.
        {
            const client = await connectWs();
            client.sendJson({ type: 'session.start', deviceId: 'pipeline-snake-24k', sample_rate: 24000 });
            const applied = await client.waitFor('session.config.applied');
            assert.strictEqual(applied.input_audio.sample_rate, 24000);
            assert.strictEqual(applied.input_audio.sample_rate_source, 'declared');

            session.receivedAudio = [];
            const input = sinePcm16({ frequency: 1000, sampleRate: 24000, seconds: 0.5 });
            await sendTurnAudio(client, input);
            const samples = totalBytes(session) / 2;
            assert.ok(samples >= 7980 && samples <= 8040, `snake_case 24000: unexpected sample count ${samples}`);
            client.close();
        }

        // --- 4. Explicit sampleRate: 16000 stays a byte-identical pass-through.
        {
            const client = await connectWs();
            client.sendJson({ type: 'session.start', deviceId: 'pipeline-explicit-16k', sampleRate: 16000 });
            await client.waitFor('session.config.applied');

            session.receivedAudio = [];
            const input = sinePcm16({ frequency: 1000, sampleRate: 16000, seconds: 0.2 });
            await sendTurnAudio(client, input);
            const received = Buffer.concat(session.receivedAudio);
            assert.deepStrictEqual(received, input, 'explicit 16000 must be byte-identical pass-through');
            client.close();
        }

        // --- 5. Unsupported sample rate is rejected with a clear error, not guessed.
        {
            const client = await connectWs();
            client.sendJson({ type: 'session.start', deviceId: 'pipeline-unsupported', sampleRate: 44100 });
            const error = await client.waitFor('error', (event) => event.code === 'unsupported_input_sample_rate');
            assert.ok(error.message.includes('44100'), 'error message should mention the rejected rate');
            // Connection stays usable: a follow-up session.start with a
            // supported rate must succeed normally.
            const sinceIndex = client.eventCount();
            client.sendJson({ type: 'session.start', deviceId: 'pipeline-unsupported', sampleRate: 16000 });
            const applied = await client.waitFor('session.config.applied', null, TIMEOUT_MS, sinceIndex);
            assert.strictEqual(applied.input_audio.sample_rate, 16000);
            client.close();
        }

        // --- 6. session.interrupt resets resampler state; the NEXT turn is
        //        unaffected by whatever was left mid-flight in the interrupted one.
        {
            const client = await connectWs();
            client.sendJson({ type: 'session.start', deviceId: 'pipeline-interrupt-reset', sampleRate: 24000 });
            await client.waitFor('session.config.applied');

            session.receivedAudio = [];
            client.sendJson({ type: 'input_audio.start', turn_id: 'interrupted_turn' });
            await client.waitFor('input_audio.start');
            const partial = sinePcm16({ frequency: 1000, sampleRate: 24000, seconds: 0.1 });
            client.sendBinary(partial);
            await sleep(30);
            client.sendJson({ type: 'session.interrupt', reason: 'test_interrupt' });
            await sleep(30);

            session.receivedAudio = [];
            const input = sinePcm16({ frequency: 1000, sampleRate: 24000, seconds: 0.3 });
            await sendTurnAudio(client, input);
            const samples = totalBytes(session) / 2;
            assert.ok(samples >= 4780 && samples <= 4830, `post-interrupt turn: unexpected sample count ${samples}`);
            client.close();
        }

        // --- 7. Two consecutive normal turns each flush their own tail
        //        correctly and don't leak state into each other.
        {
            const client = await connectWs();
            client.sendJson({ type: 'session.start', deviceId: 'pipeline-consecutive', sampleRate: 24000 });
            await client.waitFor('session.config.applied');

            for (let turn = 0; turn < 2; turn += 1) {
                session.receivedAudio = [];
                const input = sinePcm16({ frequency: 1000, sampleRate: 24000, seconds: 0.25 });
                await sendTurnAudio(client, input);
                const samples = totalBytes(session) / 2;
                assert.ok(samples >= 3980 && samples <= 4020, `turn ${turn}: unexpected sample count ${samples}`);
            }
            client.close();
        }

        console.log('input-resample-pipeline-smoke: ok');
    } finally {
        server.close();
    }
}

main().catch((error) => {
    console.error('input-resample-pipeline-smoke: FAILED', error);
    process.exit(1);
});
