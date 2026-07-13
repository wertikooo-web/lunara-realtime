'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

const DEFAULT_DEVICE_ID = 'browser-lab';
const MAX_FACTS_PER_PROFILE = 40;
const RESTRICTIONS_ADDITION_MAX_CHARS = 5000;

const PROFILE_FIELDS = [
    'child_name', 'age_group', 'child_gender', 'interests',
    'important_people', 'calming_things', 'avoided_topics', 'communication_notes',
];
const FIELD_LIMITS = {
    child_name: 40, age_group: 12, child_gender: 12, interests: 200,
    important_people: 200, calming_things: 200, avoided_topics: 200, communication_notes: 500,
};

// Parent-controlled toy/character/content/time settings, separate from the
// child memory profile above. Drives the toy side of the session (voice,
// character, allowed content, time limits) and the parent-addition text
// that gets appended to BASE_RESTRICTIONS (see realtimePrompt.js).
const SETTINGS_TEXT_FIELDS = [
    'toy_name', 'toy_type', 'toy_gender', 'voice_name', 'voice_speed',
    'character_style', 'address_style', 'reply_length', 'energy_level',
    'humor_level', 'initiative_level', 'custom_character_notes',
    'content_mode', 'preferred_themes', 'blocked_themes', 'sensitive_themes',
    'story_length', 'scary_elements',
];
const SETTINGS_TEXT_LIMITS = {
    toy_name: 40, toy_type: 40, toy_gender: 12, voice_name: 40, voice_speed: 12,
    character_style: 40, address_style: 20, reply_length: 20, energy_level: 20,
    humor_level: 20, initiative_level: 20, custom_character_notes: 500,
    content_mode: 30, preferred_themes: 200, blocked_themes: 200, sensitive_themes: 200,
    story_length: 20, scary_elements: 20,
};
const SETTINGS_INT_FIELDS = ['volume_level', 'daily_limit_minutes', 'break_reminder_minutes'];
const SETTINGS_BOOL_FIELDS = ['daily_limit_enabled', 'night_mode_enabled', 'evening_mode_enabled'];
const SETTINGS_TIME_FIELDS = ['night_mode_start', 'night_mode_end', 'evening_mode_start'];
const CONTENT_LABELS = {
    riddles: 'riddles', stories: 'stories', tongueTwisters: 'tongue twisters', jokes: 'jokes',
    miniGames: 'mini-games', educationalActivities: 'educational activities', rolePlay: 'role-play',
    speechDevelopment: 'speech development activities', worldFacts: 'world facts', improvisedContent: 'improvised content',
};

let pool = null;
let ready = false;

function safeText(value, max) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizeDeviceId(value) {
    return String(value || '').trim() || DEFAULT_DEVICE_ID;
}

async function init() {
    if (ready) return;
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw Object.assign(new Error('database_url_missing'), { code: 'database_url_missing' });
    }
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

    await pool.query(`
        CREATE TABLE IF NOT EXISTS child_profiles (
            device_id TEXT PRIMARY KEY,
            child_name TEXT DEFAULT '',
            age_group TEXT DEFAULT '',
            child_gender TEXT DEFAULT '',
            interests TEXT DEFAULT '',
            important_people TEXT DEFAULT '',
            calming_things TEXT DEFAULT '',
            avoided_topics TEXT DEFAULT '',
            communication_notes TEXT DEFAULT '',
            memory_enabled BOOLEAN DEFAULT true,
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now()
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS memory_facts (
            id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL REFERENCES child_profiles(device_id) ON DELETE CASCADE,
            label TEXT NOT NULL,
            value TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('parent', 'auto')),
            created_at TIMESTAMPTZ DEFAULT now()
        );
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS memory_facts_device_id_idx ON memory_facts (device_id, created_at);');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS device_settings (
            device_id TEXT PRIMARY KEY,
            toy_name TEXT DEFAULT 'Луми',
            toy_type TEXT DEFAULT 'bear',
            toy_gender TEXT DEFAULT 'female',
            voice_name TEXT DEFAULT 'Kore',
            voice_speed TEXT DEFAULT 'normal',
            volume_level INTEGER DEFAULT 7,
            character_style TEXT DEFAULT 'kind_friend',
            address_style TEXT DEFAULT 'affectionate',
            reply_length TEXT DEFAULT 'short',
            energy_level TEXT DEFAULT 'balanced',
            humor_level TEXT DEFAULT 'sometimes',
            initiative_level TEXT DEFAULT 'sometimes',
            custom_character_notes TEXT DEFAULT '',
            content_mode TEXT DEFAULT 'library_only',
            allowed_content JSONB DEFAULT '{"riddles":true,"stories":true,"tongueTwisters":true,"jokes":true,"miniGames":true,"educationalActivities":true,"rolePlay":true,"speechDevelopment":true,"worldFacts":true,"improvisedContent":true}',
            preferred_themes TEXT DEFAULT '',
            blocked_themes TEXT DEFAULT '',
            sensitive_themes TEXT DEFAULT '',
            story_length TEXT DEFAULT 'up_to_1min',
            scary_elements TEXT DEFAULT 'off',
            daily_limit_enabled BOOLEAN DEFAULT false,
            daily_limit_minutes INTEGER DEFAULT 0,
            night_mode_enabled BOOLEAN DEFAULT false,
            night_mode_start TEXT DEFAULT '22:00',
            night_mode_end TEXT DEFAULT '07:00',
            break_reminder_minutes INTEGER DEFAULT 0,
            evening_mode_enabled BOOLEAN DEFAULT false,
            evening_mode_start TEXT DEFAULT '20:00',
            restrictions_addition TEXT DEFAULT '',
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now()
        );
    `);

    ready = true;
}

function requireReady() {
    if (!ready || !pool) {
        throw Object.assign(new Error('memory_store_not_ready'), { code: 'memory_store_not_ready' });
    }
}

async function getOrCreateProfile(deviceId) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    await pool.query(
        'INSERT INTO child_profiles (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING;',
        [id],
    );
    const { rows } = await pool.query('SELECT * FROM child_profiles WHERE device_id = $1;', [id]);
    return rows[0];
}

async function getFacts(deviceId) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    const { rows } = await pool.query(
        'SELECT id, label, value, source, created_at FROM memory_facts WHERE device_id = $1 ORDER BY created_at ASC;',
        [id],
    );
    return rows;
}

async function getProfileWithFacts(deviceId) {
    const profile = await getOrCreateProfile(deviceId);
    const facts = await getFacts(deviceId);
    return { profile, facts };
}

async function updateProfileFields(deviceId, patch = {}) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    await getOrCreateProfile(id);

    const setClauses = [];
    const values = [id];
    for (const field of PROFILE_FIELDS) {
        if (!(field in patch)) continue;
        values.push(safeText(patch[field], FIELD_LIMITS[field]));
        setClauses.push(`${field} = $${values.length}`);
    }
    if ('memory_enabled' in patch) {
        values.push(!!patch.memory_enabled);
        setClauses.push(`memory_enabled = $${values.length}`);
    }
    if (!setClauses.length) return getOrCreateProfile(id);

    setClauses.push('updated_at = now()');
    const { rows } = await pool.query(
        `UPDATE child_profiles SET ${setClauses.join(', ')} WHERE device_id = $1 RETURNING *;`,
        values,
    );
    return rows[0];
}

async function evictOldestAutoFacts(deviceId, keepUnder = MAX_FACTS_PER_PROFILE) {
    await pool.query(
        `DELETE FROM memory_facts
         WHERE id IN (
             SELECT id FROM memory_facts
             WHERE device_id = $1 AND source = 'auto'
             ORDER BY created_at ASC
             LIMIT GREATEST(0, (SELECT COUNT(*) FROM memory_facts WHERE device_id = $1) - $2)
         );`,
        [normalizeDeviceId(deviceId), keepUnder],
    );
}

async function addFact(deviceId, { label, value, source = 'auto' }) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    await getOrCreateProfile(id);
    const factId = 'f_' + crypto.randomBytes(8).toString('hex');
    const safeLabel = safeText(label, 40);
    const safeValue = safeText(value, 120);
    if (!safeLabel || !safeValue) return null;

    const { rows } = await pool.query(
        `INSERT INTO memory_facts (id, device_id, label, value, source)
         VALUES ($1, $2, $3, $4, $5) RETURNING *;`,
        [factId, id, safeLabel, safeValue, source === 'parent' ? 'parent' : 'auto'],
    );
    await evictOldestAutoFacts(id);
    return rows[0];
}

async function deleteFact(deviceId, factId) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    await pool.query('DELETE FROM memory_facts WHERE device_id = $1 AND id = $2;', [id, factId]);
}

async function clearFacts(deviceId) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    await pool.query('DELETE FROM memory_facts WHERE device_id = $1;', [id]);
}

async function deleteProfile(deviceId) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    await pool.query('DELETE FROM child_profiles WHERE device_id = $1;', [id]);
}

const PROFILE_LABELS = {
    child_name: 'Child name',
    age_group: 'Age range',
    child_gender: 'Child gender',
    interests: 'Interests',
    important_people: 'Important people and pets',
    calming_things: 'What helps the child calm down',
    avoided_topics: 'Topics the child fears or dislikes, do not bring up',
    communication_notes: 'Communication notes',
};

// Renders DB state into the exact text that fills the existing
// [CHILD PROFILE / CONFIRMED MEMORY] block (see realtimePrompt.js).
function formatChildContext({ profile, facts }) {
    const lines = [];
    for (const field of PROFILE_FIELDS) {
        const value = profile?.[field];
        if (value) lines.push(`- ${PROFILE_LABELS[field]}: ${value}.`);
    }
    if (Array.isArray(facts) && facts.length) {
        lines.push('Confirmed memory facts from past conversations:');
        facts.slice(-MAX_FACTS_PER_PROFILE).forEach((fact) => {
            lines.push(`- ${fact.label}: ${fact.value}`);
        });
    }
    if (!lines.length) {
        return 'No confirmed memory yet for this profile.';
    }
    lines.push('Use this information naturally only when relevant. Do not recite it as a list. Do not invent facts beyond what is listed here.');
    return lines.join('\n');
}

async function deleteSettings(deviceId) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    await pool.query('DELETE FROM device_settings WHERE device_id = $1;', [id]);
}

async function getOrCreateSettings(deviceId) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    await pool.query(
        'INSERT INTO device_settings (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING;',
        [id],
    );
    const { rows } = await pool.query('SELECT * FROM device_settings WHERE device_id = $1;', [id]);
    return rows[0];
}

function normalizeAllowedContent(value) {
    if (!value || typeof value !== 'object') return null;
    const cleaned = {};
    for (const key of Object.keys(CONTENT_LABELS)) {
        cleaned[key] = !!value[key];
    }
    return cleaned;
}

async function updateSettings(deviceId, patch = {}) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    await getOrCreateSettings(id);

    const setClauses = [];
    const values = [id];

    for (const field of SETTINGS_TEXT_FIELDS) {
        if (!(field in patch)) continue;
        values.push(safeText(patch[field], SETTINGS_TEXT_LIMITS[field]));
        setClauses.push(`${field} = $${values.length}`);
    }
    for (const field of SETTINGS_INT_FIELDS) {
        if (!(field in patch)) continue;
        const num = Number(patch[field]);
        values.push(Number.isFinite(num) ? Math.max(0, Math.trunc(num)) : 0);
        setClauses.push(`${field} = $${values.length}`);
    }
    for (const field of SETTINGS_BOOL_FIELDS) {
        if (!(field in patch)) continue;
        values.push(!!patch[field]);
        setClauses.push(`${field} = $${values.length}`);
    }
    for (const field of SETTINGS_TIME_FIELDS) {
        if (!(field in patch)) continue;
        const value = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch[field] || '')) ? patch[field] : '00:00';
        values.push(value);
        setClauses.push(`${field} = $${values.length}`);
    }
    if ('allowed_content' in patch) {
        const cleaned = normalizeAllowedContent(patch.allowed_content);
        if (cleaned) {
            values.push(JSON.stringify(cleaned));
            setClauses.push(`allowed_content = $${values.length}`);
        }
    }
    if ('restrictions_addition' in patch) {
        values.push(safeText(patch.restrictions_addition, RESTRICTIONS_ADDITION_MAX_CHARS));
        setClauses.push(`restrictions_addition = $${values.length}`);
    }

    if (!setClauses.length) return getOrCreateSettings(id);

    setClauses.push('updated_at = now()');
    const { rows } = await pool.query(
        `UPDATE device_settings SET ${setClauses.join(', ')} WHERE device_id = $1 RETURNING *;`,
        values,
    );
    return rows[0];
}

const STYLE_TEXT = {
    character_style: { kind_friend: 'kind friend', funny_explorer: 'funny explorer', calm_narrator: 'calm storyteller', learning_helper: 'learning helper' },
    address_style: {
        by_name: 'Address the child by name.',
        neutral: 'Use a neutral, friendly address, no nicknames.',
        affectionate: 'Use a warm, affectionate address, but not in every reply.',
        none: 'Do not use direct address at all.',
    },
    reply_length: { very_short: 'Keep replies very short.', short: 'Keep replies short.', normal: 'Normal reply length.' },
    energy_level: { calm: 'calm', balanced: 'balanced', active: 'energetic' },
    humor_level: { rare: 'rarely', sometimes: 'sometimes', often: 'often' },
    initiative_level: {
        waits: 'Wait for the child to start topics, do not suggest activities on your own.',
        sometimes: 'Sometimes suggest an activity, but not after every reply.',
        active: 'Actively suggest activities and keep the child engaged.',
    },
    story_length: { up_to_1min: 'up to about 1 minute', '2_3min': 'about 2-3 minutes', '4_6min': 'about 4-6 minutes' },
    scary_elements: { off: 'no scary elements at all', mild: 'only very mild scary elements', age_appropriate: 'scary elements allowed if age-appropriate' },
};

// Auto-generates the default text for the panel's editable "restrictions
// addition" field from the structured toy/character/content/time settings.
// This is only ever a starting point a parent can edit/reset — the fixed
// BASE_RESTRICTIONS (realtimePrompt.js) is what actually can't be weakened.
function formatParentRulesAddition(settings) {
    const s = settings || {};
    const lines = [];
    lines.push('STYLE');
    lines.push(`- Character: ${STYLE_TEXT.character_style[s.character_style] || 'kind friend'}.`);
    lines.push(`- ${STYLE_TEXT.reply_length[s.reply_length] || 'Keep replies short.'}`);
    lines.push(`- Tone: ${STYLE_TEXT.energy_level[s.energy_level] || 'balanced'}.`);
    lines.push(`- Use humor ${STYLE_TEXT.humor_level[s.humor_level] || 'sometimes'}.`);
    const address = STYLE_TEXT.address_style[s.address_style];
    if (address) lines.push(`- ${address}`);
    const initiative = STYLE_TEXT.initiative_level[s.initiative_level];
    if (initiative) lines.push(`- ${initiative}`);
    if (s.custom_character_notes) lines.push(`- Additional parent notes on character (preference only): ${s.custom_character_notes}`);

    lines.push('');
    lines.push('CONTENT');
    const allowed = s.allowed_content || {};
    const enabled = Object.keys(CONTENT_LABELS).filter((k) => allowed[k]).map((k) => CONTENT_LABELS[k]);
    const disabled = Object.keys(CONTENT_LABELS).filter((k) => allowed[k] === false).map((k) => CONTENT_LABELS[k]);
    if (enabled.length) lines.push(`- Allowed content types: ${enabled.join(', ')}.`);
    if (disabled.length) lines.push(`- Do not offer: ${disabled.join(', ')}.`);
    lines.push(`- Content source mode: ${s.content_mode === 'library_only' ? 'only the verified content library, do not improvise new stories/riddles' : 'verified library plus model-generated content is allowed'}.`);
    if (s.preferred_themes) lines.push(`- Preferred themes: ${s.preferred_themes}.`);
    if (s.blocked_themes) lines.push(`- Do not proactively introduce: ${s.blocked_themes}.`);
    if (s.sensitive_themes) lines.push(`- Sensitive themes: ${s.sensitive_themes}. Do not mention unless the child raises them directly.`);
    lines.push(`- Story length: ${STYLE_TEXT.story_length[s.story_length] || 'up to about 1 minute'}.`);
    lines.push(`- Scary elements: ${STYLE_TEXT.scary_elements[s.scary_elements] || 'no scary elements at all'}.`);

    if (s.daily_limit_enabled || s.night_mode_enabled || s.evening_mode_enabled) {
        lines.push('');
        lines.push('TIME');
        if (s.daily_limit_enabled && s.daily_limit_minutes) lines.push(`- Daily usage limit: ${s.daily_limit_minutes} minutes (soft reminder only, not enforced by this server yet).`);
        if (s.night_mode_enabled) lines.push(`- Night mode: quietly decline play between ${s.night_mode_start} and ${s.night_mode_end}, suggest resting.`);
        if (s.evening_mode_enabled) lines.push(`- Evening calm mode after ${s.evening_mode_start}: quieter tone, shorter replies, no energetic games.`);
    }

    return lines.join('\n');
}

module.exports = {
    init,
    normalizeDeviceId,
    getOrCreateProfile,
    getFacts,
    getProfileWithFacts,
    updateProfileFields,
    addFact,
    deleteFact,
    clearFacts,
    deleteProfile,
    getOrCreateSettings,
    updateSettings,
    deleteSettings,
    formatParentRulesAddition,
    RESTRICTIONS_ADDITION_MAX_CHARS,
    formatChildContext,
    PROFILE_FIELDS,
    MAX_FACTS_PER_PROFILE,
};
