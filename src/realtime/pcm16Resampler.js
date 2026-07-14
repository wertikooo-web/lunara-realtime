'use strict';

// Why a hand-rolled resampler instead of a mature dependency (e.g.
// libsamplerate-js, a WASM port of libsamplerate that supports Node and
// exposes a streaming-friendly `full()` API for exactly this kind of
// chunked websocket audio): this project's only conversion is a single
// fixed rational ratio, 24000 -> 16000 (3:2), not general-purpose arbitrary
// rate conversion. A 47-tap FIR low-pass + linear interpolation is the
// textbook-correct construction for that one ratio, small enough to review
// and test exhaustively line-by-line (see pcm-resampler-smoke.js: chunk-
// boundary bit-exactness, anti-alias attenuation, exact output sample
// count, tail-flush correctness), and it avoids adding a WASM binary
// dependency + its build/instantiation overhead for a problem this narrow.
// If a second input rate or a variable/arbitrary ratio is ever needed,
// revisit this decision — a real library becomes the better trade-off once
// the problem stops being "one fixed ratio".
const OUTPUT_SAMPLE_RATE = 16000;
const SUPPORTED_INPUT_SAMPLE_RATES = new Set([16000, 24000]);

// 47-tap Hamming-windowed low-pass filter. Cutoff is 7.2 kHz at 24 kHz input,
// safely below the 8 kHz Nyquist limit of the 16 kHz output.
const FIR_COEFFICIENTS = [
    -0.000651592194021651493,
    -0.000717692775676919423,
    0.00140092091557295659,
    -2.76530975830059829e-18,
    -0.00234459486095091058,
    0.00190634814354763687,
    0.00249070529000993942,
    -0.00520454544604954418,
    7.68990050891437624e-18,
    0.00835623074373490447,
    -0.006432866103336367,
    -0.0079399191681457891,
    0.0157449925782892769,
    -1.48376558083880858e-17,
    -0.023374710770303727,
    0.0176006129682470015,
    0.0215505715053270833,
    -0.0431414747477837854,
    2.10022540357625242e-17,
    0.0707030812467387554,
    -0.0600661998881413597,
    -0.0920686123374271914,
    0.301812098645461047,
    0.600753292509817238,
    0.301812098645461047,
    -0.0920686123374271914,
    -0.0600661998881413528,
    0.0707030812467387693,
    2.10022540357625242e-17,
    -0.0431414747477837854,
    0.0215505715053270833,
    0.0176006129682470085,
    -0.0233747107703037305,
    -1.48376558083880858e-17,
    0.01574499257828927,
    -0.00793991916814579084,
    -0.00643286610333637047,
    0.00835623074373490621,
    7.6899005089143824e-18,
    -0.00520454544604954591,
    0.00249070529000993855,
    0.00190634814354763752,
    -0.00234459486095091058,
    -2.76530975830060099e-18,
    0.0014009209155729581,
    -0.000717692775676919423,
    -0.000651592194021651493,
];

function clampInt16(value) {
    return Math.max(-32768, Math.min(32767, Math.round(value)));
}

class Pcm16MonoResampler {
    constructor({ inputRate = OUTPUT_SAMPLE_RATE, outputRate = OUTPUT_SAMPLE_RATE } = {}) {
        this.inputRate = Number(inputRate);
        this.outputRate = Number(outputRate);
        if (!SUPPORTED_INPUT_SAMPLE_RATES.has(this.inputRate)) {
            throw Object.assign(new Error('unsupported_input_sample_rate'), {
                code: 'unsupported_input_sample_rate',
                inputRate: this.inputRate,
            });
        }
        if (this.outputRate !== OUTPUT_SAMPLE_RATE) {
            throw Object.assign(new Error('unsupported_output_sample_rate'), {
                code: 'unsupported_output_sample_rate',
                outputRate: this.outputRate,
            });
        }
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
            // Preserve the legacy 16 kHz pass-through path byte-for-byte.
            // The Gemini provider keeps its own PCM validation.
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

        for (let offset = 0; offset < bytes.length; offset += 2) {
            this.filterHistory.push(bytes.readInt16LE(offset));
            if (this.filterHistory.length > FIR_COEFFICIENTS.length) this.filterHistory.shift();
            if (this.filterHistory.length < FIR_COEFFICIENTS.length) continue;

            let filtered = 0;
            for (let index = 0; index < FIR_COEFFICIENTS.length; index += 1) {
                filtered += this.filterHistory[index] * FIR_COEFFICIENTS[index];
            }
            this.filteredSamples.push(filtered);
        }

        return this._drainOutput();
    }

    _drainOutput() {
        const output = [];
        const step = this.inputRate / this.outputRate;
        while (this.sourcePosition + 1 < this.filteredSamples.length) {
            const leftIndex = Math.floor(this.sourcePosition);
            const fraction = this.sourcePosition - leftIndex;
            const left = this.filteredSamples[leftIndex];
            const right = this.filteredSamples[leftIndex + 1];
            output.push(clampInt16(left + ((right - left) * fraction)));
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
        if (this.byteCarry !== null) {
            throw Object.assign(new Error('invalid_pcm16_length'), { code: 'invalid_pcm16_length' });
        }
        if (this.inputRate === this.outputRate) {
            this.reset();
            return Buffer.alloc(0);
        }

        // Drain the FIR tail so the final spoken phoneme is not truncated.
        const tail = this.process(Buffer.alloc(FIR_COEFFICIENTS.length * 2));
        this.reset();
        return tail;
    }
}

module.exports = {
    Pcm16MonoResampler,
    OUTPUT_SAMPLE_RATE,
    SUPPORTED_INPUT_SAMPLE_RATES,
};
