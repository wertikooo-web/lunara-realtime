'use strict';

const EXTRACTION_MODEL = process.env.MEMORY_EXTRACTION_MODEL || 'gemini-2.5-flash';
const MAX_INPUT_CHARS = 800;

const SYSTEM_INSTRUCTION = [
    'You extract short, stable, child-safe facts from one turn of a conversation between a child and a talking toy.',
    'Return strict JSON: {"add":[{"label":"...","value":"..."}],"remove":["label or existing fact text"]}.',
    'Only extract facts the child stated about themselves: name, age, likes, pets, friends, family members, favorite things, interests.',
    'Never extract: surname, address, phone number, school name, passwords, medical information, or anything not explicitly said.',
    'If the child corrects or contradicts a previous fact (e.g. says a different name), add the new value and put the old label in "remove".',
    'If nothing memorable and safe was said, return {"add":[],"remove":[]}.',
    'label must be a short 1-3 word category in English (e.g. "Name", "Pet", "Favorite color"). value is the fact itself, keep the child\'s own language.',
    'Never invent facts. Only use what is explicitly present in the text.',
].join('\n');

function buildResponseSchema() {
    return {
        type: 'object',
        properties: {
            add: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        label: { type: 'string' },
                        value: { type: 'string' },
                    },
                    required: ['label', 'value'],
                },
            },
            remove: {
                type: 'array',
                items: { type: 'string' },
            },
        },
        required: ['add', 'remove'],
    };
}

// One-shot (non-live) extraction call, separate from the Gemini Live session
// driving the actual conversation. Never called on assistant/model text —
// only on the accumulated user-turn transcript, and only after guard.looksMemorable().
async function extractMemoryActions({ text, apiKey } = {}) {
    const key = apiKey || process.env.GEMINI_API_KEY || '';
    if (!key) {
        const error = new Error('gemini_api_key_missing');
        error.code = 'gemini_api_key_missing';
        throw error;
    }
    const input = String(text || '').trim().slice(0, MAX_INPUT_CHARS);
    if (!input) return { add: [], remove: [] };

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey: key });

    const response = await ai.models.generateContent({
        model: EXTRACTION_MODEL,
        contents: [{ role: 'user', parts: [{ text: input }] }],
        config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: buildResponseSchema(),
        },
    });

    let parsed;
    try {
        parsed = JSON.parse(response.text || '{}');
    } catch (error) {
        return { add: [], remove: [] };
    }

    return {
        add: Array.isArray(parsed.add) ? parsed.add : [],
        remove: Array.isArray(parsed.remove) ? parsed.remove : [],
    };
}

module.exports = {
    extractMemoryActions,
    EXTRACTION_MODEL,
    MAX_INPUT_CHARS,
};
