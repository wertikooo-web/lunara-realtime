'use strict';

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptWebSocket(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
        socket.destroy();
        return false;
    }

    const accept = crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');
    socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
    ].join('\r\n'));
    return true;
}

function encodeFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
    const length = data.length;
    let header;

    if (length < 126) {
        header = Buffer.alloc(2);
        header[1] = length;
    } else if (length < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }

    header[0] = 0x80 | opcode;
    return Buffer.concat([header, data]);
}

// A fragmented message (FIN=0 first frame, opcode 0x0 continuation frames,
// FIN=1 final frame) previously fell through every branch below silently:
// opcode 0x0 matched nothing and its payload was dropped, and the FIN bit
// was never even read, so a FIN=0 text/binary frame was dispatched
// immediately as if it were the whole message. A constrained WebSocket
// client (embedded devices, small TX buffers) fragmenting a message would
// therefore have it silently lost or truncated, with zero error on either
// side. Found while investigating a report that session.interrupt sometimes
// doesn't appear to reach the server from real ESP32 hardware.
const MAX_FRAGMENTED_MESSAGE_BYTES = 8 * 1024 * 1024;

function createFrameParser(handlers) {
    let buffer = Buffer.alloc(0);
    let fragmentedOpcode = null;
    let fragmentedChunks = [];
    let fragmentedBytes = 0;

    function resetFragmentation() {
        fragmentedOpcode = null;
        fragmentedChunks = [];
        fragmentedBytes = 0;
    }

    function dispatch(opcode, payload) {
        if (opcode === 0x1) {
            handlers.onText?.(payload.toString('utf8'));
        } else if (opcode === 0x2) {
            handlers.onBinary?.(payload);
        }
    }

    function parse() {
        while (buffer.length >= 2) {
            const first = buffer[0];
            const second = buffer[1];
            const fin = (first & 0x80) !== 0;
            const opcode = first & 0x0f;
            const masked = (second & 0x80) !== 0;
            let length = second & 0x7f;
            let offset = 2;

            if (length === 126) {
                if (buffer.length < offset + 2) return;
                length = buffer.readUInt16BE(offset);
                offset += 2;
            } else if (length === 127) {
                if (buffer.length < offset + 8) return;
                const bigLength = buffer.readBigUInt64BE(offset);
                if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
                    handlers.onError?.(new Error('Frame too large'));
                    return;
                }
                length = Number(bigLength);
                offset += 8;
            }

            const maskLength = masked ? 4 : 0;
            if (buffer.length < offset + maskLength + length) return;

            let mask;
            if (masked) {
                mask = buffer.subarray(offset, offset + 4);
                offset += 4;
            }

            const payload = Buffer.from(buffer.subarray(offset, offset + length));
            buffer = buffer.subarray(offset + length);

            if (masked) {
                for (let index = 0; index < payload.length; index += 1) {
                    payload[index] ^= mask[index % 4];
                }
            }

            handlers.onFrame?.({ opcode, fin, length: payload.length });

            if (opcode === 0x1 || opcode === 0x2) {
                if (fin) {
                    dispatch(opcode, payload);
                } else {
                    resetFragmentation();
                    fragmentedOpcode = opcode;
                    fragmentedChunks.push(payload);
                    fragmentedBytes += payload.length;
                }
                continue;
            }

            if (opcode === 0x0) {
                if (fragmentedOpcode === null) {
                    handlers.onError?.(new Error('Unexpected continuation frame'));
                    continue;
                }
                fragmentedChunks.push(payload);
                fragmentedBytes += payload.length;
                if (fragmentedBytes > MAX_FRAGMENTED_MESSAGE_BYTES) {
                    handlers.onError?.(new Error('Fragmented message too large'));
                    resetFragmentation();
                    continue;
                }
                if (fin) {
                    const complete = Buffer.concat(fragmentedChunks, fragmentedBytes);
                    const finishedOpcode = fragmentedOpcode;
                    resetFragmentation();
                    dispatch(finishedOpcode, complete);
                }
                continue;
            }

            if (opcode === 0x8) {
                if (payload.length === 1) {
                    handlers.onError?.(new Error('Invalid WebSocket close payload'));
                    return;
                }
                const code = payload.length >= 2 ? payload.readUInt16BE(0) : null;
                const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
                handlers.onClose?.({ code, reason });
                return;
            } else if (opcode === 0x9) {
                handlers.onPing?.(payload);
            } else if (opcode === 0xa) {
                handlers.onPong?.(payload);
            }
        }
    }

    return {
        push(chunk) {
            buffer = Buffer.concat([buffer, chunk]);
            parse();
        },
    };
}

function sendJson(socket, payload) {
    if (socket.destroyed) return false;
    socket.write(encodeFrame(0x1, JSON.stringify(payload)));
    return true;
}

function sendBinary(socket, payload) {
    if (socket.destroyed) return false;
    socket.write(encodeFrame(0x2, payload));
    return true;
}

function sendPong(socket, payload) {
    if (socket.destroyed) return false;
    socket.write(encodeFrame(0xA, payload));
    return true;
}

function sendClose(socket) {
    if (socket.destroyed) return;
    socket.write(encodeFrame(0x8, Buffer.alloc(0)));
    socket.end();
}

module.exports = {
    acceptWebSocket,
    createFrameParser,
    sendJson,
    sendBinary,
    sendPong,
    sendClose,
};
