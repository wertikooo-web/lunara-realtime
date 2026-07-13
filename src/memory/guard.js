'use strict';

// Two-stage safety gate for memory writes, ported from the design principles
// in lunara-toy-server's memoryGuard.js — but called as plain functions
// (no source-patching loader like the old memoryGuardPreload.js).
//
// Stage 1 (looksMemorable): cheap pre-filter before any LLM call, requires
// an explicit memory-signal phrase so we never pay for extraction on small talk.
// Stage 2 (filterUnsafeActions): re-checks whatever the LLM extracted, since
// the extractor itself could hallucinate or leak something sensitive.

const MIN_CHARS = 5;
const MIN_WORDS = 2;
const UNIQUE_WORD_RATIO_MIN_WORDS = 7;
const UNIQUE_WORD_RATIO_THRESHOLD = 0.45;

const FILLER_PHRASES = [
    /^(ok|okay|окей|ладно|да|нет|ага|угу|хорошо|спасибо|thanks|thank you)\.?$/i,
    /спасибо за просмотр/i,
    /подпис(ыв)?айтесь/i,
    /субтитры/i,
    /subscribe/i,
    /subtitles?/i,
];

// NB: \b is defined in terms of \w, which does NOT include Cyrillic letters
// in JS regex — a \b before/after a Cyrillic word never matches (both sides
// look "non-word" to the engine). So Cyrillic patterns below intentionally
// skip \b and match the bare substring instead; English ones keep \b.
const SENSITIVE_PATTERNS = [
    /адрес(а|ом|у)?/i,
    /ул(ица|\.)\s?\S+/i,
    /дом\s?\d+/i,
    /телефон\S*/i,
    /\+?\d[\d\s\-()]{6,}\d/,
    /школ[аеу]\S*/i,
    /пароль\S*/i,
    /фамили[юия]/i,
    /password/i,
    /\baddress\b/i,
    /\bphone\s?number\b/i,
    /\bschool\s?name\b/i,
];

const PLAYBACK_GARBAGE_PATTERNS = [
    /(.)\1{6,}/, // long run of a single repeated character
    // \w does not include Cyrillic in JS regex, so this uses an explicit
    // Latin+Cyrillic letter class instead of \w for "same word x3" detection.
    /([a-zA-Zа-яёА-ЯЁ]+)\s+\1\s+\1(?![a-zA-Zа-яёА-ЯЁ])/i,
];

const MEMORY_SIGNAL_PATTERNS = [
    /меня зовут/i,
    /я люблю/i,
    /мне нравится/i,
    /у меня есть/i,
    /мой лучший друг/i,
    /моя лучшая подруга/i,
    /мне \d{1,2} лет/i,
    /mă cheamă/i,
    /îmi place/i,
    /am un[a]?\b/i,
    /my name is/i,
    /i like/i,
    /i love/i,
    /i have a/i,
    /i am \d{1,2} years old/i,
    /my best friend/i,
];

function countWords(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean);
}

function matchesAny(patterns, text) {
    return patterns.some((pattern) => pattern.test(text));
}

function hasLowUniqueWordRatio(words) {
    if (words.length < UNIQUE_WORD_RATIO_MIN_WORDS) return false;
    const unique = new Set(words.map((word) => word.toLowerCase()));
    return unique.size / words.length < UNIQUE_WORD_RATIO_THRESHOLD;
}

// Pre-filter: should we even attempt LLM extraction on this accumulated
// user-turn text? `afterPlaybackMs` guards against the toy "hearing" its
// own TTS output right after it finishes speaking.
function looksMemorable(text, { afterPlaybackMs = null } = {}) {
    const trimmed = String(text || '').trim();
    if (trimmed.length < MIN_CHARS) return false;

    const words = countWords(trimmed);
    if (words.length < MIN_WORDS) return false;

    if (matchesAny(FILLER_PHRASES, trimmed)) return false;
    if (matchesAny(PLAYBACK_GARBAGE_PATTERNS, trimmed)) return false;
    if (matchesAny(SENSITIVE_PATTERNS, trimmed)) return false;
    if (hasLowUniqueWordRatio(words)) return false;
    if (typeof afterPlaybackMs === 'number' && afterPlaybackMs >= 0 && afterPlaybackMs < 800) return false;

    return matchesAny(MEMORY_SIGNAL_PATTERNS, trimmed);
}

// Post-filter: re-check whatever {add, remove} the LLM extractor returned.
// Any individual fact that still trips a sensitive/garbage pattern is
// dropped rather than the whole batch, so one bad item doesn't block the
// rest of an otherwise-fine extraction.
function filterUnsafeActions(actions) {
    const add = Array.isArray(actions?.add) ? actions.add : [];
    const remove = Array.isArray(actions?.remove) ? actions.remove : [];
    let droppedCount = 0;

    const safeAdd = add.filter((fact) => {
        const label = String(fact?.label || '').trim();
        const value = String(fact?.value || '').trim();
        if (!label || !value) {
            droppedCount += 1;
            return false;
        }
        if (
            matchesAny(SENSITIVE_PATTERNS, label)
            || matchesAny(SENSITIVE_PATTERNS, value)
            || matchesAny(FILLER_PHRASES, value)
            || matchesAny(PLAYBACK_GARBAGE_PATTERNS, value)
        ) {
            droppedCount += 1;
            return false;
        }
        return true;
    }).map((fact) => ({
        label: String(fact.label).trim().slice(0, 40),
        value: String(fact.value).trim().slice(0, 120),
    }));

    const safeRemove = remove
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 20);

    return {
        actions: { add: safeAdd, remove: safeRemove },
        droppedCount,
    };
}

module.exports = {
    looksMemorable,
    filterUnsafeActions,
    MEMORY_SIGNAL_PATTERNS,
    SENSITIVE_PATTERNS,
};
