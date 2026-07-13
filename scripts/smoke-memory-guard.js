'use strict';

const assert = require('assert');
const { looksMemorable, filterUnsafeActions } = require('../src/memory/guard');

function check(label, condition) {
    assert.ok(condition, `[MemoryGuardSmoke] FAILED: ${label}`);
    console.log(`[MemoryGuardSmoke] ok: ${label}`);
}

// --- looksMemorable: should pass ---
check('explicit name signal passes', looksMemorable('Меня зовут Лёша, у меня есть кот Барсик'));
check('explicit like signal passes', looksMemorable('Я люблю играть в футбол с папой'));
check('english signal passes', looksMemorable('My name is Emma and I have a dog named Rex'));

// --- looksMemorable: should reject ---
check('too short rejected', !looksMemorable('да'));
check('filler phrase rejected', !looksMemorable('спасибо'));
check('no explicit signal rejected', !looksMemorable('сегодня хорошая погода на улице'));
check('sensitive address rejected', !looksMemorable('меня зовут Лёша, я живу на улица Ленина дом 5'));
check('sensitive phone rejected', !looksMemorable('у меня есть номер телефона +373 60 123 456'));
check('playback garbage repeated char rejected', !looksMemorable('меня зовут ааааааааа'));
check('playback garbage repeated word rejected', !looksMemorable('меня зовут собака собака собака'));
check('right after playback rejected', !looksMemorable('меня зовут Лёша', { afterPlaybackMs: 200 }));
check('well after playback allowed', looksMemorable('меня зовут Лёша', { afterPlaybackMs: 5000 }));

// --- filterUnsafeActions ---
const clean = filterUnsafeActions({
    add: [{ label: 'Name', value: 'Лёша' }, { label: 'Pet', value: 'кот Барсик' }],
    remove: [],
});
check('clean facts survive filter', clean.actions.add.length === 2 && clean.droppedCount === 0);

const dirty = filterUnsafeActions({
    add: [
        { label: 'Name', value: 'Лёша' },
        { label: 'Address', value: 'улица Ленина дом 5' },
        { label: 'Empty', value: '' },
    ],
    remove: [],
});
check('unsafe fact dropped', dirty.actions.add.length === 1 && dirty.actions.add[0].label === 'Name');
check('dropped count reported', dirty.droppedCount === 2);

console.log('[MemoryGuardSmoke] all checks passed');
