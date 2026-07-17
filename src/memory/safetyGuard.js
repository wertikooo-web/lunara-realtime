'use strict';

// Cheap pre-filter for the post-hoc output safety classifier
// (safetyClassifier.js) — same two-stage shape as guard.js's memory
// pipeline (cheap regex gate before any LLM call), but the opposite bias:
// guard.js's looksMemorable() errs toward skipping the LLM call (a missed
// memory fact is low-stakes), this one errs toward firing it (a missed
// safety check is not). A false positive here just costs one extra cheap
// classifier call; a false negative skips the safety net entirely.

const SELF_HARM_SIGNAL_PATTERNS = [
    /порез/i, /порежь/i, /навреди(ть)? себе/i, /причини.{0,12}(себе )?боль/i, /самоповрежд/i,
    /покончи/i, /не хочу жить/i, /умереть хочу/i, /хочу умереть/i,
    /suicide/i, /self.?harm/i,
    /cut(ting)?\s+(yourself|himself|herself|themselves|myself)/i,
    /hurt(ing)?\s+(yourself|himself|herself|themselves|myself)/i,
    /kill(ing)?\s+(myself|yourself|himself|herself|themselves)/i,
];

const SEXUAL_CONTENT_SIGNAL_PATTERNS = [
    /секс/i, /гол(ый|ая|ые|ышом)/i, /обнажен/i, /интимн/i, /гениталии/i, /половой орган/i,
    /мастурб/i, /порно/i,
    /\bsex(ual)?\b/i, /\bnaked\b/i, /\bnude\b/i, /\bgenitals?\b/i, /\bporn\b/i,
];

function matchesAny(patterns, text) {
    return patterns.some((pattern) => pattern.test(text));
}

// Pre-filter: is this completed assistant reply worth spending an LLM
// classifier call on? Only ever called on the toy's own spoken output
// (assistantTranscriptBuffer in realtimeServer.js), never on the child's
// words — flagging what a child SAYS as "unsafe" is not the goal here.
function looksRisky(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    return matchesAny(SELF_HARM_SIGNAL_PATTERNS, trimmed) || matchesAny(SEXUAL_CONTENT_SIGNAL_PATTERNS, trimmed);
}

module.exports = {
    looksRisky,
    SELF_HARM_SIGNAL_PATTERNS,
    SEXUAL_CONTENT_SIGNAL_PATTERNS,
};
