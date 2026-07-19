'use strict';

const http = require('http');
const { spawn } = require('child_process');

const PORT = Number(process.env.SMOKE_PORT || 3198);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function get(pathname) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: PORT,
            path: pathname,
            method: 'GET',
            timeout: 3000,
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    body,
                });
            });
        });

        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
    });
}

async function main() {
    const child = spawn(process.execPath, ['src/server.js'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PORT: String(PORT),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));

    try {
        await sleep(250);
        const health = await get('/health');
        if (health.statusCode !== 200 || !health.body.includes('lunara-realtime-lab')) {
            throw new Error(`Bad /health response: ${health.statusCode}`);
        }

        const lab = await get('/lab');
        if (lab.statusCode !== 200 || !lab.body.includes('pttButton')) {
            throw new Error(`Bad /lab response: ${lab.statusCode}`);
        }

        const parentForDevice = await get('/parent?deviceId=smoke-device-123');
        if (parentForDevice.statusCode !== 200 || !parentForDevice.body.includes('deviceIdInput')) {
            throw new Error(`Bad /parent?deviceId response: ${parentForDevice.statusCode}`);
        }

        console.log('[HttpSmoke] ok');
    } finally {
        child.kill();
    }
}

main().catch((error) => {
    console.error(`[HttpSmoke] failed message="${error.message}"`);
    process.exit(1);
});
