'use strict';

const assert = require('assert');
const { createContentLibrary } = require('../src/content/contentLibrary');

const library = createContentLibrary();
const diagnostics = library.getDiagnostics();

assert.strictEqual(diagnostics.totalItems, 677, 'loader should see 677 content records');
assert.deepStrictEqual(diagnostics.counts, {
    riddles: 100,
    tongue_twisters: 100,
    jokes: 111,
    stories: 366,
});
assert.strictEqual(diagnostics.duplicateIds.length, 0, 'content packs should not have duplicate ids');
assert.strictEqual(diagnostics.emptyItems.length, 0, 'content packs should not have empty records');
assert.strictEqual(diagnostics.invalidItems.length, 0, 'content packs should not have invalid records');

const riddle = library.getRiddle({ topic: 'лягушка' });
assert(riddle && riddle.type === 'riddle', 'getRiddle should return a riddle');
assert.strictEqual(riddle.source, 'library', 'semantic riddle hit should come from library');
assert(riddle.answers.includes('лягушка'), 'semantic riddle hit should match expected answer');

const fallbackRiddle = library.getRiddle({ topic: 'zzzz-not-found-topic' });
assert(fallbackRiddle && fallbackRiddle.type === 'riddle', 'getRiddle should return fallback riddle');
assert.strictEqual(fallbackRiddle.source, 'generated_fallback', 'missing riddle should use controlled fallback');
assert(fallbackRiddle.answers.length > 0, 'fallback riddle should include server-side answers');

const story = library.getStory();
const joke = library.getJoke();
const tongueTwister = library.getTongueTwister();
assert(story && story.type === 'story' && story.id, 'getStory should return a story');
assert(joke && joke.type === 'joke' && joke.id, 'getJoke should return a joke');
assert(tongueTwister && tongueTwister.type === 'tongue_twister' && tongueTwister.id, 'getTongueTwister should return a tongue twister');

const diagnosticsAgain = createContentLibrary().getDiagnostics();
assert.strictEqual(diagnosticsAgain.totalItems, 677, 'repeat loader run should not create duplicates');
assert.strictEqual(diagnosticsAgain.duplicateIds.length, 0, 'repeat loader run should remain duplicate-free');

console.log('[content-library-smoke] ok', JSON.stringify(diagnostics.counts));
