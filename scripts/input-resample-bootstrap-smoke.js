'use strict';

const assert = require('assert');
const { createInputAudioTransform } = require('../src/realtime/inputResampleBootstrap');

function sinePcm16({ frequency, sampleRate, seconds = 1 }) {
    const samples = Math.round(sampleRate * seconds);
    const buffer = Buffer.alloc(samples * 2);
    for (let index = 0; index < samples; index += 1) {
        buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 20000), index * 2);
    }
    return buffer;
}

const output = [];
const errors = [];
const transform = createInputAudioTransform({
    onAudio: (chunk) => output.push(Buffer.from(chunk)),
    onError: (error) => errors.push(error),
});
assert.strictEqual(transform.configure(24000), true);
transform.start();
const input = sinePcm16({ frequency: 1000, sampleRate: 24000 });
for (let offset = 0; offset < input.length; offset += 4096) {
    transform.process(input.subarray(offset, Math.min(input.length, offset + 4096)));
}
transform.end();
const resampled = Buffer.concat(output);
assert.strictEqual(errors.length, 0);
assert.ok(resampled.length / 2 >= 15980 && resampled.length / 2 <= 16040);

const passthroughOutput = [];
const passthrough = createInputAudioTransform({ onAudio: (chunk) => passthroughOutput.push(Buffer.from(chunk)) });
assert.strictEqual(passthrough.configure(16000), true);
passthrough.start();
const original = sinePcm16({ frequency: 1000, sampleRate: 16000, seconds: 0.1 });
passthrough.process(original);
passthrough.end();
assert.deepStrictEqual(Buffer.concat(passthroughOutput), original);

console.log('input-resample-bootstrap-smoke: ok');
