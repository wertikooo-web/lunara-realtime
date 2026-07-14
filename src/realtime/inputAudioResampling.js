'use strict';

// Explicit entry point for microphone-input sample-rate handling, called
// directly from realtimeServer.js's session.start handler and its onBinary
// frame handler (no preload/monkey-patch — see pcm16Resampler.js for the DSP
// itself and the docstring there for why it's hand-rolled instead of an
// external dependency).
const { Pcm16MonoResampler, OUTPUT_SAMPLE_RATE, SUPPORTED_INPUT_SAMPLE_RATES } = require('./pcm16Resampler');

// Gemini Live's actual input requirement — resampling always targets this.
const GEMINI_INPUT_SAMPLE_RATE = OUTPUT_SAMPLE_RATE;

// Resolves the microphone input sample rate a client declared in
// session.start (`sampleRate` or `sample_rate`).
//
// - Explicit, supported value (16000 or 24000) -> used as-is, source
//   'declared'.
// - Missing entirely -> defaults to 16000 (pass-through, Gemini's own native
//   rate) for backward compatibility with clients that predate this field —
//   Browser Lab always sends it, but the realtime-smoke.js harness and the
//   mock-provider-based regression tests do not. This default is NEVER
//   silent: source is 'assumed_default_no_sample_rate', and the caller
//   (realtimeServer.js) must both log it and surface it to the client via
//   session.config.applied so an ESP32 that forgot to send the field sees
//   explicitly what rate the server assumed, instead of silently guessing
//   with no trace anywhere.
// - Present but unsupported (anything other than 16000/24000) -> throws;
//   the caller must reject session.start rather than guess a resampling
//   ratio for an unverified rate.
function resolveInputSampleRate(payload = {}) {
    const raw = payload.sampleRate ?? payload.sample_rate;
    if (raw === undefined || raw === null || raw === '') {
        return { rate: GEMINI_INPUT_SAMPLE_RATE, source: 'assumed_default_no_sample_rate' };
    }
    const rate = Number(raw);
    if (!SUPPORTED_INPUT_SAMPLE_RATES.has(rate)) {
        throw Object.assign(new Error('unsupported_input_sample_rate'), {
            code: 'unsupported_input_sample_rate',
            requestedRate: raw,
        });
    }
    return { rate, source: 'declared' };
}

function createInputResampler(inputRate) {
    return new Pcm16MonoResampler({ inputRate, outputRate: GEMINI_INPUT_SAMPLE_RATE });
}

module.exports = {
    resolveInputSampleRate,
    createInputResampler,
    GEMINI_INPUT_SAMPLE_RATE,
    SUPPORTED_INPUT_SAMPLE_RATES,
};
