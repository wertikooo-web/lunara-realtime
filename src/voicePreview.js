'use strict';

const { isValidVoiceName, DEFAULT_VOICE_NAME } = require('./geminiVoices');

const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const MAX_PREVIEW_TEXT_CHARS = 300;
const DEFAULT_PREVIEW_TEXT = 'Привет! Меня зовут Луми. Давай поиграем?';

function extractSampleRate(mimeType) {
    const match = /rate=(\d+)/.exec(String(mimeType || ''));
    return match ? Number(match[1]) : 24000;
}

// One-shot (non-live) Gemini TTS call used only for the parent panel's
// "listen to voice" preview button. Separate from GeminiLiveProvider, which
// drives the actual realtime WebSocket session.
async function synthesizeVoicePreview({ voiceName, text, apiKey } = {}) {
    const resolvedVoice = isValidVoiceName(voiceName) ? voiceName : DEFAULT_VOICE_NAME;
    const resolvedText = String(text || DEFAULT_PREVIEW_TEXT).trim().slice(0, MAX_PREVIEW_TEXT_CHARS) || DEFAULT_PREVIEW_TEXT;
    const key = apiKey || process.env.GEMINI_API_KEY || '';

    if (!key) {
        const error = new Error('gemini_api_key_missing');
        error.code = 'gemini_api_key_missing';
        throw error;
    }

    const { GoogleGenAI, Modality } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey: key });

    const response = await ai.models.generateContent({
        model: TTS_MODEL,
        contents: [{ role: 'user', parts: [{ text: resolvedText }] }],
        config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: resolvedVoice },
                },
            },
        },
    });

    const part = response?.candidates?.[0]?.content?.parts?.find((item) => item.inlineData);
    const audioBase64 = part?.inlineData?.data || response?.data;
    if (!audioBase64) {
        const error = new Error('empty_audio_response');
        error.code = 'empty_audio_response';
        throw error;
    }

    return {
        voiceName: resolvedVoice,
        mimeType: 'audio/pcm',
        sampleRate: extractSampleRate(part?.inlineData?.mimeType),
        audioBase64,
    };
}

module.exports = {
    synthesizeVoicePreview,
    TTS_MODEL,
    DEFAULT_PREVIEW_TEXT,
    MAX_PREVIEW_TEXT_CHARS,
};
