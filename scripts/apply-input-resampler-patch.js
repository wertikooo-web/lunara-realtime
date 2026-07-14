'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function read(rel) {
    return fs.readFileSync(path.join(root, rel), 'utf8');
}

function write(rel, content) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
}

function replaceOnce(source, needle, replacement, label) {
    const first = source.indexOf(needle);
    if (first < 0) throw new Error(`Patch point not found: ${label}`);
    if (source.indexOf(needle, first + needle.length) >= 0) {
        throw new Error(`Patch point is not unique: ${label}`);
    }
    return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

const resamplerModule = `'use strict';

const SUPPORTED_INPUT_SAMPLE_RATES = new Set([16000, 24000]);
const OUTPUT_SAMPLE_RATE = 16000;
const FIR_COEFFICIENTS = [
    0.0021363083082881285,
    -0.006329071985784151,
    0,
    0.03309154226409727,
    -0.040024781231921755,
    -0.07727610846566217,
    0.28867610641826896,
    0.5994520093854274,
    0.28867610641826896,
    -0.07727610846566217,
    -0.04002478123192176,
    0.033091542264097315,
    0,
    -0.006329071985784145,
    0.0021363083082881285,
];

function clampInt16(value) {
    return Math.max(-32768, Math.min(32767, Math.round(value)));
}

class Pcm16MonoResampler {
    constructor({ inputRate = OUTPUT_SAMPLE_RATE, outputRate = OUTPUT_SAMPLE_RATE } = {}) {
        if (!SUPPORTED_INPUT_SAMPLE_RATES.has(Number(inputRate))) {
            throw new Error('unsupported_input_sample_rate');
        }
        if (Number(outputRate) !== OUTPUT_SAMPLE_RATE) {
            throw new Error('unsupported_output_sample_rate');
        }
        this.inputRate = Number(inputRate);
        this.outputRate = Number(outputRate);
        this.reset();
    }

    reset() {
        this.byteCarry = null;
        this.filterHistory = [];
        this.filteredSamples = [];
        this.sourcePosition = 0;
    }

    process(input) {
        const chunk = Buffer.from(input || []);
        if (chunk.length === 0) return Buffer.alloc(0);

        if (this.inputRate === this.outputRate) {
            if (chunk.length % 2 !== 0) throw new Error('invalid_pcm16_length');
            return Buffer.from(chunk);
        }

        let bytes = chunk;
        if (this.byteCarry !== null) {
            bytes = Buffer.concat([Buffer.from([this.byteCarry]), bytes]);
            this.byteCarry = null;
        }
        if (bytes.length % 2 !== 0) {
            this.byteCarry = bytes[bytes.length - 1];
            bytes = bytes.subarray(0, bytes.length - 1);
        }
        if (bytes.length === 0) return Buffer.alloc(0);

        const newFiltered = [];
        for (let offset = 0; offset < bytes.length; offset += 2) {
            const sample = bytes.readInt16LE(offset);
            this.filterHistory.push(sample);
            if (this.filterHistory.length > FIR_COEFFICIENTS.length) this.filterHistory.shift();
            if (this.filterHistory.length < FIR_COEFFICIENTS.length) continue;

            let filtered = 0;
            for (let index = 0; index < FIR_COEFFICIENTS.length; index += 1) {
                filtered += this.filterHistory[index] * FIR_COEFFICIENTS[index];
            }
            newFiltered.push(filtered);
        }

        if (newFiltered.length === 0) return Buffer.alloc(0);
        this.filteredSamples.push(...newFiltered);

        const step = this.inputRate / this.outputRate;
        const output = [];
        while (this.sourcePosition + 1 < this.filteredSamples.length) {
            const leftIndex = Math.floor(this.sourcePosition);
            const fraction = this.sourcePosition - leftIndex;
            const left = this.filteredSamples[leftIndex];
            const right = this.filteredSamples[leftIndex + 1];
            output.push(clampInt16(left + (right - left) * fraction));
            this.sourcePosition += step;
        }

        const consumed = Math.floor(this.sourcePosition);
        if (consumed > 0) {
            this.filteredSamples.splice(0, consumed);
            this.sourcePosition -= consumed;
        }

        const result = Buffer.allocUnsafe(output.length * 2);
        output.forEach((sample, index) => result.writeInt16LE(sample, index * 2));
        return result;
    }

    flush() {
        if (this.inputRate === this.outputRate) {
            if (this.byteCarry !== null) throw new Error('invalid_pcm16_length');
            this.reset();
            return Buffer.alloc(0);
        }
        if (this.byteCarry !== null) throw new Error('invalid_pcm16_length');

        const tail = this.process(Buffer.alloc(FIR_COEFFICIENTS.length * 2));
        this.reset();
        return tail;
    }
}

module.exports = {
    Pcm16MonoResampler,
    SUPPORTED_INPUT_SAMPLE_RATES,
    OUTPUT_SAMPLE_RATE,
};
`;

const smokeTest = `'use strict';

const assert = require('assert');
const { Pcm16MonoResampler } = require('../src/realtime/pcm16Resampler');

function sinePcm16({ frequency, sampleRate, seconds = 1, amplitude = 0.75 }) {
    const samples = Math.round(sampleRate * seconds);
    const buffer = Buffer.alloc(samples * 2);
    for (let index = 0; index < samples; index += 1) {
        const value = Math.sin(2 * Math.PI * frequency * index / sampleRate) * amplitude * 32767;
        buffer.writeInt16LE(Math.round(value), index * 2);
    }
    return buffer;
}

function processInChunks(input, chunkSizes) {
    const resampler = new Pcm16MonoResampler({ inputRate: 24000, outputRate: 16000 });
    const output = [];
    let offset = 0;
    let index = 0;
    while (offset < input.length) {
        let size = chunkSizes[index % chunkSizes.length];
        size = Math.min(size, input.length - offset);
        if (size % 2 !== 0) size -= 1;
        if (size <= 0) size = Math.min(2, input.length - offset);
        output.push(resampler.process(input.subarray(offset, offset + size)));
        offset += size;
        index += 1;
    }
    output.push(resampler.flush());
    return Buffer.concat(output);
}

function rms(buffer) {
    let sum = 0;
    const samples = buffer.length / 2;
    for (let offset = 0; offset < buffer.length; offset += 2) {
        const value = buffer.readInt16LE(offset) / 32768;
        sum += value * value;
    }
    return Math.sqrt(sum / Math.max(1, samples));
}

const low = processInChunks(sinePcm16({ frequency: 1000, sampleRate: 24000 }), [6144, 2048, 4096, 1024]);
const high = processInChunks(sinePcm16({ frequency: 10000, sampleRate: 24000 }), [6144, 2048, 4096, 1024]);

assert.strictEqual(low.length % 2, 0);
assert.ok(low.length / 2 >= 15980 && low.length / 2 <= 16020, `unexpected output samples: ${low.length / 2}`);
assert.ok(rms(low) > 0.45, `1kHz signal too quiet: ${rms(low)}`);
assert.ok(rms(high) < rms(low) * 0.15, `anti-alias filter too weak: low=${rms(low)} high=${rms(high)}`);

const passthrough = new Pcm16MonoResampler({ inputRate: 16000, outputRate: 16000 });
const original = sinePcm16({ frequency: 1000, sampleRate: 16000, seconds: 0.1 });
assert.deepStrictEqual(passthrough.process(original), original);

console.log('pcm-resampler-smoke: ok');
`;

const protocolDoc = `# ESP32 audio format for Realtime Protocol V1

## Fixed hardware mode

- Codec and I2S on ESP32: PCM16LE, mono, 24000 Hz for microphone and speaker.
- ESP32 sends microphone audio as binary WebSocket frames at 24000 Hz.
- In \`session.start\`, ESP32 must send \`sampleRate: 24000\`.
- The server performs stateful streaming resampling 24000 -> 16000 before sending audio to Gemini Live.
- Gemini output remains native PCM16LE mono 24000 Hz and is sent back unchanged in \`audio.chunk\`.

Minimal session start:

\`\`\`json
{
  "type": "session.start",
  "deviceId": "YOUR_DEVICE_ID",
  "sampleRate": 24000
}
\`\`\`

Browser Lab continues to send 16000 Hz and uses the pass-through path.
`;

write('src/realtime/pcm16Resampler.js', resamplerModule);
write('scripts/pcm-resampler-smoke.js', smokeTest);
write('docs/ESP32_AUDIO_PROTOCOL_V1.md', protocolDoc);

let server = read('src/realtime/realtimeServer.js');
server = replaceOnce(
    server,
    "const { extractMemoryActions } = require('../memory/extractor');\n",
    "const { extractMemoryActions } = require('../memory/extractor');\nconst { Pcm16MonoResampler, SUPPORTED_INPUT_SAMPLE_RATES, OUTPUT_SAMPLE_RATE } = require('./pcm16Resampler');\n",
    'resampler import',
);
server = replaceOnce(
    server,
    "    const memoryEnabledFlag = memoryEnabledFromEnv();\n",
    "    const memoryEnabledFlag = memoryEnabledFromEnv();\n    let clientInputSampleRate = OUTPUT_SAMPLE_RATE;\n    let inputResampler = new Pcm16MonoResampler({ inputRate: clientInputSampleRate, outputRate: OUTPUT_SAMPLE_RATE });\n",
    'session resampler state',
);
server = replaceOnce(
    server,
    "    function startInput(payload = {}) {\n",
    "    function bufferProviderInputChunk(chunk) {\n        if (!chunk || chunk.length === 0) return;\n        if (currentInputBufferedBytes + chunk.length <= MAX_TURN_REPLAY_BYTES) {\n            const replayChunk = Buffer.from(chunk);\n            currentInputChunks.push(replayChunk);\n            currentInputBufferedBytes += replayChunk.length;\n        } else if (currentInputBufferedBytes <= MAX_TURN_REPLAY_BYTES) {\n            log('input_replay_buffer_full', {\n                bytes: chunk.length,\n                bufferedBytes: currentInputBufferedBytes,\n                maxReplayBytes: MAX_TURN_REPLAY_BYTES,\n                turnId: currentTurnId || 'none',\n                generationId: currentGeneration?.generationId || 'none',\n            });\n            currentInputBufferedBytes = MAX_TURN_REPLAY_BYTES + 1;\n            currentInputChunks = [];\n        }\n    }\n\n    function sendProviderInputChunk(chunk) {\n        if (!chunk || chunk.length === 0) return;\n        bufferProviderInputChunk(chunk);\n        providerSession.sendAudio(chunk);\n    }\n\n    function startInput(payload = {}) {\n",
    'provider input helpers',
);
server = replaceOnce(
    server,
    "        currentInputBufferedBytes = 0;\n        emit({\n",
    "        currentInputBufferedBytes = 0;\n        inputResampler.reset();\n        emit({\n",
    'reset resampler per turn',
);
server = replaceOnce(
    server,
    "            response_id: null,\n        });\n",
    "            response_id: null,\n            input_sample_rate: clientInputSampleRate,\n            provider_sample_rate: OUTPUT_SAMPLE_RATE,\n        });\n",
    'input start sample rates',
);
server = replaceOnce(
    server,
    "        const endInputContext = buildProviderContext(generationForStream);\n\n        providerSession.endInput(endInputContext).catch((error) => {\n",
    "        const endInputContext = buildProviderContext(generationForStream);\n        try {\n            const finalProviderAudio = inputResampler.flush();\n            sendProviderInputChunk(finalProviderAudio);\n        } catch (error) {\n            emit({\n                type: 'error',\n                generation_id: generationForStream.generationId,\n                response_id: generationForStream.responseId,\n                turn_id: generationForStream.turnId,\n                code: 'invalid_input_pcm',\n                message: error.message,\n            });\n            return;\n        }\n\n        providerSession.endInput(endInputContext).catch((error) => {\n",
    'flush resampler on input end',
);
server = replaceOnce(
    server,
    "            if (payload.deviceId) {\n                deviceId = memoryStore.normalizeDeviceId(payload.deviceId);\n            }\n            (async () => {\n",
    "            if (payload.deviceId) {\n                deviceId = memoryStore.normalizeDeviceId(payload.deviceId);\n            }\n            const requestedSampleRate = Number(payload.sampleRate || payload.sample_rate || OUTPUT_SAMPLE_RATE);\n            if (!SUPPORTED_INPUT_SAMPLE_RATES.has(requestedSampleRate)) {\n                emit({\n                    type: 'error',\n                    code: 'input_sample_rate_unsupported',\n                    message: 'Supported input sample rates are 16000 and 24000 Hz.',\n                    sample_rate: requestedSampleRate,\n                });\n                return;\n            }\n            clientInputSampleRate = requestedSampleRate;\n            inputResampler = new Pcm16MonoResampler({ inputRate: clientInputSampleRate, outputRate: OUTPUT_SAMPLE_RATE });\n            log('input_sample_rate_configured', {\n                clientInputSampleRate,\n                providerInputSampleRate: OUTPUT_SAMPLE_RATE,\n                resampling: clientInputSampleRate !== OUTPUT_SAMPLE_RATE,\n            });\n            (async () => {\n",
    'session start sample rate',
);
server = replaceOnce(
    server,
    "            inputBytes += payload.length;\n            sessionInputBytes += payload.length;\n            if (currentInputBufferedBytes + payload.length <= MAX_TURN_REPLAY_BYTES) {\n                const replayChunk = Buffer.from(payload);\n                currentInputChunks.push(replayChunk);\n                currentInputBufferedBytes += replayChunk.length;\n            } else if (currentInputBufferedBytes <= MAX_TURN_REPLAY_BYTES) {\n                log('input_replay_buffer_full', {\n                    bytes: payload.length,\n                    bufferedBytes: currentInputBufferedBytes,\n                    maxReplayBytes: MAX_TURN_REPLAY_BYTES,\n                    turnId: currentTurnId || 'none',\n                    generationId: currentGeneration?.generationId || 'none',\n                });\n                currentInputBufferedBytes = MAX_TURN_REPLAY_BYTES + 1;\n                currentInputChunks = [];\n            }\n            providerSession.sendAudio(payload);\n            log('input_audio_frame', {\n                turnId: currentTurnId || 'none',\n                bytes: payload.length,\n",
    "            inputBytes += payload.length;\n            sessionInputBytes += payload.length;\n            let providerPayload;\n            try {\n                providerPayload = inputResampler.process(payload);\n            } catch (error) {\n                emit({\n                    type: 'error',\n                    code: 'invalid_input_pcm',\n                    message: error.message,\n                    turn_id: currentTurnId || null,\n                    generation_id: currentGeneration?.generationId || null,\n                });\n                return;\n            }\n            sendProviderInputChunk(providerPayload);\n            log('input_audio_frame', {\n                turnId: currentTurnId || 'none',\n                bytes: payload.length,\n                providerBytes: providerPayload.length,\n                inputSampleRate: clientInputSampleRate,\n                providerSampleRate: OUTPUT_SAMPLE_RATE,\n",
    'binary input resampling',
);
write('src/realtime/realtimeServer.js', server);

const packageJson = JSON.parse(read('package.json'));
packageJson.scripts = packageJson.scripts || {};
packageJson.scripts['smoke:pcm-resampler'] = 'node scripts/pcm-resampler-smoke.js';
write('package.json', JSON.stringify(packageJson, null, 2) + '\n');

fs.rmSync(path.join(root, 'scripts/apply-input-resampler-patch.js'), { force: true });
fs.rmSync(path.join(root, '.github/workflows/apply-input-resampler-patch.yml'), { force: true });

console.log('input resampler patch applied');
