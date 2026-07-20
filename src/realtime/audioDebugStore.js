'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function enabled(value) {
    return /^(1|true|yes|on|enabled)$/i.test(String(value || ''));
}

function safePart(value) {
    return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) || 'unknown';
}

function wavBuffer(pcm, sampleRate) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

class AudioDebugStore {
    constructor(options = {}) {
        this.enabled = options.enabled ?? enabled(process.env.AUDIO_DEBUG_CAPTURE_ENABLED);
        this.deviceId = String(options.deviceId ?? process.env.AUDIO_DEBUG_DEVICE_ID ?? '').trim();
        this.token = String(options.token ?? process.env.AUDIO_DEBUG_TOKEN ?? '');
        this.rootDir = path.resolve(options.rootDir || process.env.AUDIO_DEBUG_CAPTURE_DIR || path.join(process.cwd(), 'tmp', 'audio-debug'));
        this.maxTurns = Math.max(1, Number(options.maxTurns ?? process.env.AUDIO_DEBUG_MAX_TURNS) || 20);
        this.maxTurnSeconds = Math.max(1, Number(options.maxTurnSeconds ?? process.env.AUDIO_DEBUG_MAX_TURN_SECONDS) || 30);
        this.retentionMs = Math.max(1, Number(options.retentionHours ?? process.env.AUDIO_DEBUG_RETENTION_HOURS) || 24) * 60 * 60 * 1000;
        this.maxRawBytes = this.maxTurnSeconds * 24000 * 2;
        this.active = new Map();
    }

    isConfigured() {
        return this.enabled && Boolean(this.deviceId) && this.token.length >= 24;
    }

    shouldCapture(deviceId) {
        return this.isConfigured() && String(deviceId) === this.deviceId;
    }

    authorize(req) {
        if (!this.isConfigured()) return false;
        const supplied = String(req.headers['x-audio-debug-token'] || '').trim();
        const suppliedBytes = Buffer.from(supplied);
        const tokenBytes = Buffer.from(this.token);
        if (suppliedBytes.length !== tokenBytes.length) return false;
        return crypto.timingSafeEqual(suppliedBytes, tokenBytes);
    }

    begin({ deviceId, sessionId, turnId, inputSampleRate }) {
        if (!this.shouldCapture(deviceId)) return null;
        const captureId = `${Date.now()}-${safePart(turnId)}`;
        const capture = {
            captureId, deviceId: safePart(deviceId), sessionId: safePart(sessionId), turnId: safePart(turnId),
            inputSampleRate, startedAt: new Date().toISOString(), raw: [], resampled: [], rawBytes: 0, resampledBytes: 0,
            truncated: false,
        };
        this.active.set(captureId, capture);
        return captureId;
    }

    appendRaw(captureId, chunk) {
        const capture = this.active.get(captureId);
        if (!capture || capture.truncated) return;
        const remaining = this.maxRawBytes - capture.rawBytes;
        if (remaining <= 0) { capture.truncated = true; return; }
        const copy = Buffer.from(chunk.subarray(0, remaining));
        capture.raw.push(copy);
        capture.rawBytes += copy.length;
        if (copy.length < chunk.length) capture.truncated = true;
    }

    appendResampled(captureId, chunk) {
        const capture = this.active.get(captureId);
        if (!capture || capture.truncated || !chunk.length) return;
        const maxBytes = this.maxTurnSeconds * 16000 * 2;
        const remaining = maxBytes - capture.resampledBytes;
        if (remaining <= 0) { capture.truncated = true; return; }
        const copy = Buffer.from(chunk.subarray(0, remaining));
        capture.resampled.push(copy);
        capture.resampledBytes += copy.length;
        if (copy.length < chunk.length) capture.truncated = true;
    }

    async finish(captureId, metadata = {}) {
        const capture = this.active.get(captureId);
        if (!capture) return null;
        this.active.delete(captureId);
        const dir = path.join(this.rootDir, capture.deviceId, capture.captureId);
        await fs.promises.mkdir(dir, { recursive: true });
        const raw = Buffer.concat(capture.raw);
        const resampled = Buffer.concat(capture.resampled);
        const completeMetadata = {
            captureId: capture.captureId, deviceId: capture.deviceId, sessionId: capture.sessionId,
            turnId: capture.turnId, startedAt: capture.startedAt, completedAt: new Date().toISOString(),
            rawSampleRate: capture.inputSampleRate, resampledSampleRate: 16000,
            rawPcmBytes: raw.length, resampledPcmBytes: resampled.length, truncated: capture.truncated,
            ...metadata,
        };
        await Promise.all([
            fs.promises.writeFile(path.join(dir, 'raw.wav'), wavBuffer(raw, capture.inputSampleRate)),
            fs.promises.writeFile(path.join(dir, 'resampled.wav'), wavBuffer(resampled, 16000)),
            fs.promises.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(completeMetadata, null, 2)),
        ]);
        await this.cleanup(capture.deviceId);
        return completeMetadata;
    }

    async list(deviceId) {
        if (String(deviceId) !== this.deviceId) return [];
        await this.cleanup(safePart(deviceId));
        const dir = path.join(this.rootDir, safePart(deviceId));
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
        const results = [];
        for (const entry of entries.filter((item) => item.isDirectory())) {
            try {
                const metadata = JSON.parse(await fs.promises.readFile(path.join(dir, entry.name, 'metadata.json'), 'utf8'));
                results.push(metadata);
            } catch {}
        }
        return results.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
    }

    filePath(deviceId, captureId, kind) {
        if (String(deviceId) !== this.deviceId || !['raw', 'resampled'].includes(kind)) return null;
        return path.join(this.rootDir, safePart(deviceId), safePart(captureId), `${kind}.wav`);
    }

    async remove(deviceId, captureId) {
        if (String(deviceId) !== this.deviceId) return false;
        const dir = path.join(this.rootDir, safePart(deviceId), safePart(captureId));
        try { await fs.promises.rm(dir, { recursive: true }); return true; } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw error;
        }
    }

    async cleanup(deviceId = safePart(this.deviceId)) {
        const dir = path.join(this.rootDir, safePart(deviceId));
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        const directories = [];
        for (const entry of entries.filter((item) => item.isDirectory())) {
            const fullPath = path.join(dir, entry.name);
            const stat = await fs.promises.stat(fullPath);
            if (Date.now() - stat.mtimeMs > this.retentionMs) await fs.promises.rm(fullPath, { recursive: true });
            else directories.push({ fullPath, mtimeMs: stat.mtimeMs });
        }
        directories.sort((a, b) => b.mtimeMs - a.mtimeMs);
        await Promise.all(directories.slice(this.maxTurns).map((entry) => fs.promises.rm(entry.fullPath, { recursive: true })));
    }
}

module.exports = { AudioDebugStore, wavBuffer };
