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

// Consecutive turns on the same connection must not leak resampler state
// (each input_audio.start resets the filter/interpolation history) and must
// each independently produce a correctly-sized 16kHz output.
{
    const turnOutputs = [];
    const errors = [];
    const transform = createInputAudioTransform({
        onAudio: (chunk) => turnOutputs.push(Buffer.from(chunk)),
        onError: (error) => errors.push(error),
    });
    assert.strictEqual(transform.configure(24000), true);
    for (let turn = 0; turn < 3; turn += 1) {
        turnOutputs.length = 0;
        transform.start();
        const turnInput = sinePcm16({ frequency: 1000, sampleRate: 24000, seconds: 0.5 });
        for (let offset = 0; offset < turnInput.length; offset += 4096) {
            transform.process(turnInput.subarray(offset, Math.min(turnInput.length, offset + 4096)));
        }
        transform.end();
        const turnResampled = Buffer.concat(turnOutputs);
        const samples = turnResampled.length / 2;
        assert.ok(samples >= 7980 && samples <= 8040, `turn ${turn}: unexpected sample count ${samples}`);
    }
    assert.strictEqual(errors.length, 0);
}

// A genuinely malformed turn — an odd total byte count, so one PCM16 sample
// never completes — must surface onError via flush()'s real
// 'invalid_pcm16_length' failure AND leave the resampler clean for the next
// turn, not carry the stuck byteCarry forward. Exercises the actual
// reset-on-error fix in inputResampleBootstrap.js, not a simulated one.
{
    const errors = [];
    const outputs = [];
    const transform = createInputAudioTransform({
        onAudio: (chunk) => outputs.push(Buffer.from(chunk)),
        onError: (error) => errors.push(error),
    });
    assert.strictEqual(transform.configure(24000), true);
    transform.start();
    transform.process(Buffer.from([1, 2, 3])); // odd length -> 1-byte carry left dangling
    transform.end(); // flush() must throw invalid_pcm16_length here
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'invalid_pcm16_length');

    outputs.length = 0;
    transform.start();
    const recoveryInput = sinePcm16({ frequency: 1000, sampleRate: 24000, seconds: 0.2 });
    for (let offset = 0; offset < recoveryInput.length; offset += 4096) {
        transform.process(recoveryInput.subarray(offset, Math.min(recoveryInput.length, offset + 4096)));
    }
    transform.end();
    assert.strictEqual(errors.length, 1, 'recovery turn must not raise another error');
    const recovered = Buffer.concat(outputs);
    const samples = recovered.length / 2;
    assert.ok(samples >= 3180 && samples <= 3220, `recovery turn: unexpected sample count ${samples}`);
}

console.log('input-resample-bootstrap-smoke: ok');
