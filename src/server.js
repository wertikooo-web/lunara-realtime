'use strict';

const http = require('http');

const PORT = Number(process.env.PORT || 3100);
const provider = process.env.REALTIME_PROVIDER || 'mock';

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(body);
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, {
            ok: true,
            service: 'lunara-realtime-lab',
            provider,
        });
    }

    if (req.method === 'GET' && req.url === '/') {
        return sendJson(res, 200, {
            name: 'Lunara Realtime Lab',
            status: 'scaffold',
            endpoints: ['/health', '/'],
            next: 'Add mock full-duplex WebSocket loop before provider adapters.',
        });
    }

    return sendJson(res, 404, {
        ok: false,
        error: 'not_found',
    });
});

server.listen(PORT, () => {
    console.log(`[RealtimeLab] listening port=${PORT} provider=${provider}`);
});
