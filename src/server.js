'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { attachRealtimeServer } = require('./realtime/realtimeServer');

const PORT = Number(process.env.PORT || 3100);
const provider = process.env.REALTIME_PROVIDER || 'mock';
const publicDir = path.join(__dirname, '..', 'public');

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
            endpoints: ['/health', '/', '/lab', '/realtime'],
        });
    }

    if (req.method === 'GET' && req.url === '/') {
        return sendJson(res, 200, {
            name: 'Lunara Realtime Lab',
            status: 'mock-realtime-ready',
            endpoints: ['/health', '/lab', '/realtime'],
            next: 'Open /lab in a browser and test mock streaming.',
        });
    }

    if (req.method === 'GET' && req.url === '/lab') {
        const filePath = path.join(publicDir, 'lab.html');
        fs.createReadStream(filePath)
            .on('error', () => sendJson(res, 500, { ok: false, error: 'lab_not_available' }))
            .once('open', () => {
                res.writeHead(200, {
                    'content-type': 'text/html; charset=utf-8',
                    'cache-control': 'no-store',
                });
            })
            .pipe(res);
        return undefined;
    }

    return sendJson(res, 404, {
        ok: false,
        error: 'not_found',
    });
});

attachRealtimeServer(server);

server.listen(PORT, () => {
    console.log(`[RealtimeLab] listening port=${PORT} provider=${provider}`);
});
