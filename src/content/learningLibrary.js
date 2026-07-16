'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeText } = require('./contentLibrary');

const DEFAULT_LEARNING_MODULES_DIR = path.resolve(__dirname, '..', '..', 'data', 'learning-modules');

class LearningLibrary {
    constructor(options = {}) {
        this.modulesDir = options.learningModulesDir || DEFAULT_LEARNING_MODULES_DIR;
        this.modules = new Map();
        this.load();
    }

    load() {
        if (!fs.existsSync(this.modulesDir)) {
            return;
        }
        try {
            const files = fs.readdirSync(this.modulesDir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const filePath = path.join(this.modulesDir, file);
                    const fileContent = fs.readFileSync(filePath, 'utf8');
                    const parsed = JSON.parse(fileContent);
                    const packId = parsed.pack_id || path.basename(file, '.json');
                    
                    this.modules.set(packId, {
                        packId,
                        module: parsed.module,
                        skill: parsed.skill,
                        lang: parsed.lang || 'ru',
                        exercises: Array.isArray(parsed.items) ? parsed.items : []
                    });
                }
            }
        } catch (error) {
            console.error('[LearningLibrary] Error loading learning modules:', error);
        }
    }

    startSession(moduleId) {
        const mod = this.modules.get(moduleId);
        if (!mod) return null;
        return {
            moduleId: mod.packId,
            lang: mod.lang,
            exercises: [...mod.exercises]
        };
    }

    checkLearningAnswer(activity, answerText) {
        if (!activity || activity.type !== 'learning') {
            return { handled: false, correct: false };
        }
        
        const normalizedAnswer = normalizeText(answerText);
        const expected = (activity.expectedAnswers || []).map(ans => normalizeText(ans));
        const accepted = (activity.acceptedVariants || []).map(ans => normalizeText(ans));

        // Check if the answer matches any of the expected answers or accepted variants.
        // If an expected answer has multiple words, we check if the user said all of them/includes them.
        const isExpectedMatch = expected.some(exp => {
            if (!exp) return false;
            return normalizedAnswer === exp || normalizedAnswer.includes(exp);
        });

        const isAcceptedMatch = accepted.some(acc => {
            if (!acc) return false;
            return normalizedAnswer === acc || normalizedAnswer.includes(acc);
        });

        const correct = isExpectedMatch || isAcceptedMatch;
        const attempts = Number(activity.attempts || 0) + 1;
        const maxAttempts = Number(activity.maxAttempts || 3);
        const completed = correct || attempts >= maxAttempts;

        let hint = null;
        if (!correct && !completed) {
            const hints = activity.hints || [];
            // Give specific hint based on current attempt number (0-indexed after adding the new attempt)
            hint = hints[attempts - 1] || hints[0] || null;
        }

        return {
            handled: true,
            correct,
            attempts,
            completed,
            contentId: activity.contentId,
            type: 'learning',
            hint
        };
    }
}

function createLearningLibrary(options = {}) {
    return new LearningLibrary(options);
}

module.exports = {
    LearningLibrary,
    createLearningLibrary,
    DEFAULT_LEARNING_MODULES_DIR
};
