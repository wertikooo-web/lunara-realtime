'use strict';

// Canonical list of the 30 prebuilt Gemini Live / TTS voices, per
// https://ai.google.dev/gemini-api/docs/speech-generation. Google does not
// publish a gender for these voices, only a tone characteristic — do not
// invent a gender split here, the parent panel intentionally has none.
const GEMINI_VOICES = [
    { name: 'Zephyr', characteristic: 'Bright' },
    { name: 'Puck', characteristic: 'Upbeat' },
    { name: 'Charon', characteristic: 'Informative' },
    { name: 'Kore', characteristic: 'Firm' },
    { name: 'Fenrir', characteristic: 'Excitable' },
    { name: 'Leda', characteristic: 'Youthful' },
    { name: 'Orus', characteristic: 'Firm' },
    { name: 'Aoede', characteristic: 'Breezy' },
    { name: 'Callirrhoe', characteristic: 'Easy-going' },
    { name: 'Autonoe', characteristic: 'Bright' },
    { name: 'Enceladus', characteristic: 'Breathy' },
    { name: 'Iapetus', characteristic: 'Clear' },
    { name: 'Umbriel', characteristic: 'Easy-going' },
    { name: 'Algieba', characteristic: 'Smooth' },
    { name: 'Despina', characteristic: 'Smooth' },
    { name: 'Erinome', characteristic: 'Clear' },
    { name: 'Algenib', characteristic: 'Gravelly' },
    { name: 'Rasalgethi', characteristic: 'Informative' },
    { name: 'Laomedeia', characteristic: 'Upbeat' },
    { name: 'Achernar', characteristic: 'Soft' },
    { name: 'Alnilam', characteristic: 'Firm' },
    { name: 'Schedar', characteristic: 'Even' },
    { name: 'Gacrux', characteristic: 'Mature' },
    { name: 'Pulcherrima', characteristic: 'Forward' },
    { name: 'Achird', characteristic: 'Friendly' },
    { name: 'Zubenelgenubi', characteristic: 'Casual' },
    { name: 'Vindemiatrix', characteristic: 'Gentle' },
    { name: 'Sadachbia', characteristic: 'Lively' },
    { name: 'Sadaltager', characteristic: 'Knowledgeable' },
    { name: 'Sulafat', characteristic: 'Warm' },
];

const GEMINI_VOICE_NAMES = GEMINI_VOICES.map((voice) => voice.name);
const DEFAULT_VOICE_NAME = 'Kore';

function isValidVoiceName(voiceName) {
    return GEMINI_VOICE_NAMES.includes(String(voiceName || ''));
}

module.exports = {
    GEMINI_VOICES,
    GEMINI_VOICE_NAMES,
    DEFAULT_VOICE_NAME,
    isValidVoiceName,
};
