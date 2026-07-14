'use strict';

// Loaded with Node's -r flag before src/server.js. It wraps the existing
// WebSocket frame parser so device microphone audio is normalized before the
// realtime server sees it. This keeps the main realtime state machine and its
// provider retry/replay logic unchanged.

const wsProtocol = require('./wsProtocol');
const { Pcm16MonoResampler, OUTPUT_SAMPLE_RATE, SUPPORTED_INPUT_SAMPLE_RATES } = require('./pcm16Resampler');

const originalCreateFrameParser = wsProtocol.createFrameParser;

function createInputAudioTransform({ onAudio, onError = () => {} }) {
    let inputRate = OUTPUT_SAMPLE_RATE;
    let resampler = new Pcm16MonoResampler({ inputRate, outputRate: OUTPUT_SAMPLE_RATE });
    let inputActive = false;

    function configure(sampleRate) {
        const requested = Number(sampleRate || OUTPUT_SAMPLE_RATE);
        if (!SUPPORTED_INPUT_SAMPLE_RATES.has(requested)) {
            const error = Object.assign(new Error('unsupported_input_sample_rate'), {
                code: 'unsupported_input_sample_rate',
                sampleRate: requested,
            });
            onError(error);
            return false;
        }
        inputRate = requested;
        resampler = new Pcm16MonoResampler({ inputRate, outputRate: OUTPUT_SAMPLE_RATE });
        return true;
    }

    function start() {
        resampler.reset();
        inputActive = true;
    }

    function process(chunk) {
        if (!inputActive) {
            onAudio(chunk);
            return;
        }
        try {
            const output = resampler.process(chunk);
            if (output.length > 0) onAudio(output);
        } catch (error) {
            // A malformed/odd-length PCM chunk leaves the resampler's internal
            // byte-carry/filter-history state inconsistent for the rest of this
            // turn — reset immediately so the NEXT input_audio.start begins
            // clean rather than potentially propagating corrupted state.
            inputActive = false;
            resampler.reset();
            onError(error);
        }
    }

    function end() {
        if (!inputActive) return;
        inputActive = false;
        try {
            const tail = resampler.flush();
            if (tail.length > 0) onAudio(tail);
        } catch (error) {
            resampler.reset();
            onError(error);
        }
    }

    function reset() {
        inputActive = false;
        resampler.reset();
    }

    return {
        configure,
        start,
        process,
        end,
        reset,
        get inputRate() {
            return inputRate;
        },
    };
}

wsProtocol.createFrameParser = function createResamplingFrameParser(callbacks = {}) {
    const originalOnText = callbacks.onText || (() => {});
    const originalOnBinary = callbacks.onBinary || (() => {});
    const originalOnError = callbacks.onError || (() => {});

    const transform = createInputAudioTransform({
        onAudio: originalOnBinary,
        onError: originalOnError,
    });

    return originalCreateFrameParser({
        ...callbacks,
        onText(raw) {
            let payload;
            try {
                payload = JSON.parse(raw);
            } catch (_) {
                originalOnText(raw);
                return;
            }

            if (payload.type === 'session.start') {
                const sampleRate = payload.sampleRate ?? payload.sample_rate ?? OUTPUT_SAMPLE_RATE;
                if (!transform.configure(sampleRate)) return;
            } else if (payload.type === 'input_audio.start') {
                transform.start();
            } else if (payload.type === 'input_audio.end') {
                // Tail must reach the provider before realtimeServer handles endInput().
                transform.end();
            } else if (payload.type === 'session.interrupt') {
                transform.reset();
            }

            originalOnText(raw);
        },
        onBinary(chunk) {
            transform.process(chunk);
        },
    });
};

module.exports = {
    createInputAudioTransform,
};
