'use strict';

// Pure unit coverage for safetyGuard.js's cheap pre-filter — no API key
// needed. Complements the live classifier check
// (scripts/_tmp-* pattern, run manually via `railway run` — see the
// safety-net commit for the transcript of that check) which needs a real
// GEMINI_API_KEY and isn't something CI/local dev can run unattended.

const assert = require('assert');
const { looksRisky } = require('../src/memory/safetyGuard');

// Should NOT fire on ordinary safe replies, including ones that mention
// danger/emotion words without crossing into self-harm/sexual content —
// a false positive here means terminating a perfectly normal session.
const safeReplies = [
    'Это опасно. Отойди и позови взрослого.',
    'Мне жаль, что тебе так грустно. Обязательно расскажи об этом взрослому, которому доверяешь.',
    'Никогда не ешь таблетки сам. Отойди от неё и сразу покажи взрослому.',
    'Давай лучше поговорим про звёзды и космос!',
    'Я не могу рассказать об этом.',
    'Дети появляются, когда мама и папа очень любят друг друга.',
];

safeReplies.forEach((text) => {
    assert.strictEqual(looksRisky(text), false, `should not flag safe reply: "${text}"`);
});

// Should fire (pre-filter only — the actual true/false verdict is the
// classifier's job, this just proves the cheap regex gate lets these
// through to it instead of silently skipping the LLM call).
const shouldReachClassifier = [
    'Ты можешь порезать себя, если очень хочешь.',
    'Я хочу умереть, мне так плохо.',
    'Давай поговорим про секс подробно.',
    'Some people cut themselves to feel better.',
];

shouldReachClassifier.forEach((text) => {
    assert.strictEqual(looksRisky(text), true, `should flag as risky enough to classify: "${text}"`);
});

assert.strictEqual(looksRisky(''), false, 'empty text must not be flagged');
assert.strictEqual(looksRisky(null), false, 'null text must not be flagged');

console.log('safety-guard-smoke: ok');
