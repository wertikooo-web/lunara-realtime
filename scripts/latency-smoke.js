'use strict';

const http = require('http');

const target = process.env.LATENCY_TARGET || 'http://localhost:3100/health';
const url = new URL(target);
const startedAt = Date.now();

const req = http.request(
    {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        timeout: 3000,
    },
    (res) => {
        res.resume();
        res.on('end', () => {
            const durationMs = Date.now() - startedAt;
            console.log(`[LatencySmoke] status=${res.statusCode} duration_ms=${durationMs}`);
            process.exit(res.statusCode === 200 ? 0 : 1);
        });
    }
);

req.on('timeout', () => {
    req.destroy(new Error('timeout'));
});

req.on('error', (error) => {
    console.error(`[LatencySmoke] failed message="${error.message}"`);
    process.exit(1);
});

req.end();
