'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CONTENT_PACK_DIR = path.resolve(__dirname, '..', '..', 'data', 'content-packs');

const DEFAULT_PACK_FILES = {
    riddles: ['riddles_ru_v2.json'],
    tongue_twisters: ['tongue_twisters_ru_v2.json'],
    jokes: ['jokes_ru_v2.json'],
    stories: ['stories_ru_v1.json', 'classic_stories_ru_v1.json', 'extra_classic_stories_ru_v1.json'],
};

const TYPE_ALIASES = {
    riddles: 'riddle',
    tongue_twisters: 'tongue_twister',
    jokes: 'joke',
    stories: 'story',
};

const FALLBACK_RIDDLES = {
    ru: {
        id: 'generated_riddle_ru_001',
        type: 'riddle',
        text: '\u0417\u0438\u043c\u043e\u0439 \u0438 \u043b\u0435\u0442\u043e\u043c \u043e\u0434\u043d\u0438\u043c \u0446\u0432\u0435\u0442\u043e\u043c. \u0427\u0442\u043e \u044d\u0442\u043e?',
        answers: ['\u0451\u043b\u043a\u0430', '\u0435\u043b\u043a\u0430'],
        hints: ['\u041e\u043d\u0430 \u0437\u0435\u043b\u0451\u043d\u0430\u044f \u0438 \u043f\u0443\u0448\u0438\u0441\u0442\u0430\u044f.'],
        language: 'ru',
        topic: 'nature',
        source: 'generated_fallback',
    },
};

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\\u0451/g, '\\u0435')
        .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
        .replace(/\\u0451/g, '\\u0435')
        .trim();
}

function normalizeLanguage(lang) {
    const value = String(lang || 'ru').toLowerCase();
    if (value.startsWith('ru')) return 'ru';
    return value || 'ru';
}

function stableHash(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 10);
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeItem(rawItem, fallbackType, pack, index) {
    const text = String(rawItem?.text || '').trim();
    const id = String(rawItem?.id || '').trim();
    const type = String(rawItem?.type || fallbackType || '').trim();
    const answers = Array.isArray(rawItem?.answers)
        ? rawItem.answers.map((answer) => String(answer || '').trim()).filter(Boolean)
        : [];
    const hints = Array.isArray(rawItem?.hints)
        ? rawItem.hints.map((hint) => String(hint || '').trim()).filter(Boolean)
        : [];
    return {
        id: id || `${pack.packId}_${index + 1}`,
        type,
        title: String(rawItem?.title || '').trim(),
        text,
        answers,
        hints,
        language: normalizeLanguage(rawItem?.lang || pack.lang || 'ru'),
        tags: Array.isArray(rawItem?.tags) ? rawItem.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : [],
        topic: String(rawItem?.topic || rawItem?.metadata?.topic || '').trim(),
        metadata: rawItem?.metadata && typeof rawItem.metadata === 'object' ? { ...rawItem.metadata } : {},
        sourcePack: pack.packId,
        source: 'library',
    };
}

function validateItem(item) {
    const issues = [];
    if (!item.id) issues.push('missing_id');
    if (!item.type) issues.push('missing_type');
    if (!item.text) issues.push('empty_text');
    if (item.type === 'riddle' && item.answers.length === 0) issues.push('missing_answers');
    return issues;
}

function loadPack(filePath, logicalType) {
    const data = readJson(filePath);
    const items = Array.isArray(data?.items) ? data.items : [];
    const pack = {
        filePath,
        fileName: path.basename(filePath),
        packId: String(data?.pack_id || path.basename(filePath, '.json')),
        type: String(data?.type || logicalType || '').trim(),
        lang: normalizeLanguage(data?.lang || 'ru'),
        itemCount: items.length,
    };
    const fallbackType = TYPE_ALIASES[logicalType] || pack.type || logicalType;
    return {
        ...pack,
        items: items.map((item, index) => normalizeItem(item, fallbackType, pack, index)),
    };
}

function serializeContentItem(item) {
    if (!item) return null;
    return {
        id: item.id,
        type: item.type,
        text: item.text,
        answers: Array.isArray(item.answers) ? [...item.answers] : [],
        hints: Array.isArray(item.hints) ? [...item.hints] : [],
        language: item.language,
        topic: item.topic || '',
        source: item.source || 'library',
    };
}

function scoreItem(item, options = {}) {
    const query = normalizeText(options.query || options.topic || '');
    const requestedTopic = normalizeText(options.topic || '');
    const requestedTags = (options.tags || []).map(normalizeText).filter(Boolean);
    if (!query && !requestedTopic && requestedTags.length === 0) return 1;

    const searchable = normalizeText([
        item.id,
        item.title,
        item.topic,
        item.tags.join(' '),
        item.answers.join(' '),
        item.text,
    ].join(' '));
    let score = 0;
    if (requestedTopic && normalizeText(item.topic) === requestedTopic) score += 40;
    if (requestedTopic && searchable.includes(requestedTopic)) score += 15;
    for (const tag of requestedTags) {
        if (item.tags.map(normalizeText).includes(tag)) score += 20;
        else if (searchable.includes(tag)) score += 5;
    }
    for (const word of query.split(' ').filter((part) => part.length >= 3)) {
        if (searchable.includes(word)) score += 3;
    }
    return score;
}

function chooseNext(items, cursorState, key, options = {}) {
    const language = normalizeLanguage(options.language || 'ru');
    const excludeIds = new Set((options.excludeIds || []).map(String));
    const languagePool = items.filter((item) => item.language === language && !excludeIds.has(item.id));
    const fallbackPool = items.filter((item) => !excludeIds.has(item.id));
    const basePool = languagePool.length > 0 ? languagePool : fallbackPool;
    if (basePool.length === 0) return null;

    const hasSemanticFilter = Boolean(options.query || options.topic || (options.tags || []).length > 0);
    let pool = basePool;
    if (hasSemanticFilter) {
        const scored = basePool
            .map((item) => ({ item, score: scoreItem(item, options) }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score);
        if (scored.length === 0) return null;
        pool = scored.filter((entry) => entry.score === scored[0].score).map((entry) => entry.item);
    }

    const cursor = cursorState[key] || 0;
    const picked = pool[cursor % pool.length];
    cursorState[key] = cursor + 1;
    return serializeContentItem(picked);
}

function generatedFallbackRiddle(options = {}) {
    const language = normalizeLanguage(options.language || 'ru');
    const base = FALLBACK_RIDDLES[language] || FALLBACK_RIDDLES.ru;
    const topic = String(options.topic || base.topic || '').trim();
    const idSuffix = topic ? stableHash(`${language}:${topic}`) : base.id.replace(/^generated_riddle_[a-z]+_/, '');
    return {
        ...base,
        id: topic ? `generated_riddle_${language}_${idSuffix}` : base.id,
        topic: topic || base.topic,
        source: 'generated_fallback',
    };
}

class ContentLibrary {
    constructor(options = {}) {
        this.contentPackDir = options.contentPackDir || DEFAULT_CONTENT_PACK_DIR;
        this.packFiles = options.packFiles || DEFAULT_PACK_FILES;
        this.enableGeneratedFallback = options.enableGeneratedFallback !== false;
        this.cursors = {};
        this.packs = [];
        this.itemsByType = {
            riddle: [],
            tongue_twister: [],
            joke: [],
            story: [],
        };
        this.diagnostics = {
            totalItems: 0,
            counts: { riddles: 0, tongue_twisters: 0, jokes: 0, stories: 0 },
            duplicateIds: [],
            emptyItems: [],
            invalidItems: [],
            packs: [],
        };
        this.load();
    }

    load() {
        const seenIds = new Map();
        for (const [logicalType, files] of Object.entries(this.packFiles)) {
            for (const fileName of files) {
                const filePath = path.join(this.contentPackDir, fileName);
                const loadedPack = loadPack(filePath, logicalType);
                this.packs.push(loadedPack);
                this.diagnostics.packs.push({
                    fileName: loadedPack.fileName,
                    packId: loadedPack.packId,
                    logicalType,
                    itemCount: loadedPack.itemCount,
                });

                for (const item of loadedPack.items) {
                    const issues = validateItem(item);
                    if (!item.text) {
                        this.diagnostics.emptyItems.push({ id: item.id, fileName: loadedPack.fileName });
                    }
                    if (issues.length > 0) {
                        this.diagnostics.invalidItems.push({ id: item.id, fileName: loadedPack.fileName, issues });
                        continue;
                    }
                    if (seenIds.has(item.id)) {
                        this.diagnostics.duplicateIds.push({ id: item.id, firstFile: seenIds.get(item.id), duplicateFile: loadedPack.fileName });
                    } else {
                        seenIds.set(item.id, loadedPack.fileName);
                    }
                    if (!this.itemsByType[item.type]) {
                        this.itemsByType[item.type] = [];
                    }
                    this.itemsByType[item.type].push(item);
                    this.diagnostics.totalItems += 1;
                }
            }
        }
        this.diagnostics.counts = {
            riddles: this.itemsByType.riddle.length,
            tongue_twisters: this.itemsByType.tongue_twister.length,
            jokes: this.itemsByType.joke.length,
            stories: this.itemsByType.story.length,
        };
    }

    getDiagnostics() {
        return JSON.parse(JSON.stringify(this.diagnostics));
    }

    getRiddle(options = {}) {
        const item = chooseNext(this.itemsByType.riddle, this.cursors, 'riddle', options);
        if (item) return item;
        if (!this.enableGeneratedFallback) return null;
        return generatedFallbackRiddle(options);
    }

    getTongueTwister(options = {}) {
        return chooseNext(this.itemsByType.tongue_twister, this.cursors, 'tongue_twister', options);
    }

    getJoke(options = {}) {
        return chooseNext(this.itemsByType.joke, this.cursors, 'joke', options);
    }

    getStory(options = {}) {
        return chooseNext(this.itemsByType.story, this.cursors, 'story', options);
    }

    checkRiddleAnswer(activity, answerText) {
        if (!activity || activity.type !== 'riddle') {
            return { handled: false, correct: false };
        }
        const normalizedAnswer = normalizeText(answerText);
        const expectedAnswers = Array.isArray(activity.expectedAnswers) ? activity.expectedAnswers : [];
        const correct = expectedAnswers.some((answer) => {
            const normalizedExpected = normalizeText(answer);
            if (!normalizedExpected) return false;
            return normalizedAnswer === normalizedExpected
                || normalizedAnswer.split(' ').includes(normalizedExpected);
        });
        const attempts = correct ? Number(activity.attempts || 0) : Number(activity.attempts || 0) + 1;
        return {
            handled: true,
            correct,
            attempts,
            completed: correct,
            contentId: activity.contentId,
            type: 'riddle',
            hint: !correct && attempts >= 2 ? '\u042d\u0442\u043e \u0447\u0442\u043e-\u0442\u043e \u0438\u0437 \u043e\u0442\u0432\u0435\u0442\u0430 \u043d\u0430 \u0437\u0430\u0433\u0430\u0434\u043a\u0443. \u041c\u043e\u0436\u043d\u043e \u043f\u043e\u043f\u0440\u043e\u0431\u043e\u0432\u0430\u0442\u044c \u0435\u0449\u0451 \u0440\u0430\u0437.' : null,
        };
    }
}

function createContentLibrary(options = {}) {
    return new ContentLibrary(options);
}

module.exports = {
    ContentLibrary,
    createContentLibrary,
    normalizeText,
    normalizeLanguage,
    serializeContentItem,
    DEFAULT_CONTENT_PACK_DIR,
    DEFAULT_PACK_FILES,
};
