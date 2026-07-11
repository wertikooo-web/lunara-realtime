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

function createFrameParser(handlers) {
    let buffer = Buffer.alloc(0);

    function parse() {
        while (buffer.length >= 2) {
            const first = buffer[0];
            const second = buffer[1];
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

            if (opcode === 0x1) {
                handlers.onText?.(payload.toString('utf8'));
            } else if (opcode === 0x2) {
                handlers.onBinary?.(payload);
            } else if (opcode === 0x8) {
                handlers.onClose?.();
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

