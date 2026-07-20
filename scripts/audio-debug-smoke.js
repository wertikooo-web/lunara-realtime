'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AudioDebugStore } = require('../src/realtime/audioDebugStore');

async function main() {
    const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lunara-audio-debug-'));
    try {
        const store = new AudioDebugStore({
            enabled: true, deviceId: 'device-test', token: '123456789012345678901234', rootDir,
            maxTurns: 2, maxTurnSeconds: 2, retentionHours: 1,
        });
        const captureId = store.begin({ deviceId: 'device-test', sessionId: 'session-1', turnId: 'turn-1', inputSampleRate: 24000 });
        const raw = Buffer.alloc(4800, 7);
        const resampled = Buffer.alloc(3200, 5);
        store.appendRaw(captureId, raw);
        store.appendResampled(captureId, resampled);
        const metadata = await store.finish(captureId, { durationMs: 100, deliveryRatio: 1 });
        assert.equal(metadata.rawPcmBytes, raw.length);
        assert.equal(metadata.resampledPcmBytes, resampled.length);
        const listed = await store.list('device-test');
        assert.equal(listed.length, 1);
        const rawWav = await fs.promises.readFile(store.filePath('device-test', captureId, 'raw'));
        const resampledWav = await fs.promises.readFile(store.filePath('device-test', captureId, 'resampled'));
        assert.equal(rawWav.toString('ascii', 0, 4), 'RIFF');
        assert.equal(rawWav.readUInt32LE(24), 24000);
        assert.equal(rawWav.readUInt32LE(40), raw.length);
        assert.equal(resampledWav.readUInt32LE(24), 16000);
        assert.equal(resampledWav.readUInt32LE(40), resampled.length);
        assert.equal(await store.remove('device-test', captureId), true);
        assert.equal((await store.list('device-test')).length, 0);
        console.log('[AudioDebugSmoke] ok');
    } finally {
        await fs.promises.rm(rootDir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
