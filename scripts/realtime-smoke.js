'use strict';

const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');

const PORT = Number(process.env.SMOKE_PORT || 3199);
const HOST = '127.0.0.1';
const TIMEOUT_MS = 8000;

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

        const timer = setTimeout(() => reject(new Error('WebSocket smoke timeout')), TIMEOUT_MS);

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
                    waitFor(type, timeoutMs = TIMEOUT_MS) {
                        return new Promise((eventResolve, eventReject) => {
                            const startedAt = Date.now();
                            const interval = setInterval(() => {
                                const match = events.find((event) => event.type === type);
                                if (match) {
                                    clearInterval(interval);
                                    eventResolve(match);
                                } else if (Date.now() - startedAt > timeoutMs) {
                                    clearInterval(interval);
                                    eventReject(new Error(`Timed out waiting for ${type}`));
                                }
                            }, 25);
                        });
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

async function main() {
    const child = spawn(process.execPath, ['src/server.js'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PORT: String(PORT),
            MOCK_PROCESSING_DELAY_MS: '80',
            MOCK_CHUNK_INTERVAL_MS: '30',
            MOCK_CHUNK_DURATION_MS: '50',
            MOCK_CHUNK_COUNT: '3',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));

    try {
        await sleep(250);
        const client = await connectWs();
        await client.waitFor('session.ready');
        client.sendJson({ type: 'input_audio.start', turn_id: 'smoke_turn_1' });
        client.sendBinary(Buffer.alloc(3200, 1));
        client.sendJson({ type: 'input_audio.end' });
        await client.waitFor('response.created');
        await client.waitFor('audio.start');
        await client.waitFor('audio.chunk');
        client.sendJson({ type: 'session.interrupt', reason: 'smoke_interrupt' });
        await client.waitFor('response.cancelled');
        client.socket.end();
        console.log('[RealtimeSmoke] ok');
    } finally {
        child.kill();
    }
}

main().catch((error) => {
    console.error(`[RealtimeSmoke] failed message="${error.message}"`);
    process.exit(1);
});
