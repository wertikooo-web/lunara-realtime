'use strict';

const assert = require('assert');
const { Pcm16MonoResampler } = require('../src/realtime/pcm16Resampler');

function sinePcm16({ frequency, sampleRate, seconds = 1, amplitude = 0.75 }) {
    const samples = Math.round(sampleRate * seconds);
    const buffer = Buffer.alloc(samples * 2);
    for (let index = 0; index < samples; index += 1) {
        const value = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * amplitude * 32767;
        buffer.writeInt16LE(Math.round(value), index * 2);
    }
    return buffer;
}

function processInChunks(input, inputRate, chunkSizes) {
    const resampler = new Pcm16MonoResampler({ inputRate, outputRate: 16000 });
    const output = [];
    let offset = 0;
    let index = 0;
    while (offset < input.length) {
        const size = Math.min(chunkSizes[index % chunkSizes.length], input.length - offset);
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

const oneKhz = sinePcm16({ frequency: 1000, sampleRate: 24000 });
const streamed = processInChunks(oneKhz, 24000, [4096, 6144, 2048, 8192]);
const whole = processInChunks(oneKhz, 24000, [oneKhz.length]);
assert.deepStrictEqual(streamed, whole, 'chunk boundaries changed resampler output');
assert.strictEqual(streamed.length % 2, 0);
assert.ok(streamed.length / 2 >= 15980 && streamed.length / 2 <= 16040, `unexpected output samples: ${streamed.length / 2}`);
assert.ok(rms(streamed) > 0.45, `1 kHz signal too quiet: ${rms(streamed)}`);

const tenKhz = processInChunks(
    sinePcm16({ frequency: 10000, sampleRate: 24000 }),
    24000,
    [4096, 6144, 2048, 8192],
);
assert.ok(rms(tenKhz) < rms(streamed) * 0.12, `anti-alias filter too weak: low=${rms(streamed)} high=${rms(tenKhz)}`);

const passthroughInput = sinePcm16({ frequency: 1000, sampleRate: 16000, seconds: 0.1 });
const passthrough = new Pcm16MonoResampler({ inputRate: 16000, outputRate: 16000 });
assert.deepStrictEqual(passthrough.process(passthroughInput), passthroughInput);
assert.strictEqual(passthrough.flush().length, 0);

console.log('pcm-resampler-smoke: ok');
