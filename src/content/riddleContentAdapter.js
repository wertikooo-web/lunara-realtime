'use strict';

const { createContentLibrary, normalizeText, DEFAULT_CONTENT_PACK_DIR } = require('./contentLibrary');

class RiddleContentAdapter {
    constructor(options = {}) {
        this.library = options.library || createContentLibrary(options);
    }

    getRiddle(options = {}) {
        return this.library.getRiddle(options);
    }

    checkAnswer(activity, answerText) {
        return this.library.checkRiddleAnswer(activity, answerText);
    }
}

function createRiddleContentAdapter(options = {}) {
    return new RiddleContentAdapter(options);
}

module.exports = {
    createRiddleContentAdapter,
    normalizeText,
    DEFAULT_RIDDLE_PACK_PATH: DEFAULT_CONTENT_PACK_DIR,
};
