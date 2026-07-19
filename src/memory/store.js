'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

const DEFAULT_DEVICE_ID = 'browser-lab';
const MAX_FACTS_PER_PROFILE = 40;
const RESTRICTIONS_ADDITION_MAX_CHARS = 16000;
const CUSTOM_PROMPT_MAX_CHARS = 16000;

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
    'toy_name', 'toy_type', 'custom_toy_type', 'toy_gender', 'voice_name', 'voice_speed',
    'character_style', 'address_style', 'reply_length', 'energy_level',
    'humor_level', 'initiative_level', 'custom_character_notes',
    'content_mode', 'preferred_themes', 'blocked_themes', 'sensitive_themes',
    'story_length', 'scary_elements', 'conversation_language', 'timezone', 'city',
];
const SETTINGS_TEXT_LIMITS = {
    toy_name: 40, toy_type: 40, custom_toy_type: 40, toy_gender: 12, voice_name: 40, voice_speed: 12,
    character_style: 40, address_style: 20, reply_length: 20, energy_level: 20,
    humor_level: 20, initiative_level: 20, custom_character_notes: 500,
    content_mode: 30, preferred_themes: 200, blocked_themes: 200, sensitive_themes: 200,
    story_length: 20, scary_elements: 20, conversation_language: 8, timezone: 60, city: 80,
};
const DEFAULT_TIMEZONE = 'Europe/Chisinau';

// Formats a Date as a YYYY-MM-DD string in the given IANA timezone. Falls
// back to UTC if the timezone string is missing/invalid (Intl throws on bad
// zone names) so callers never crash on a bad saved value.
function localDateStringInTz(timezone, date = new Date()) {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || DEFAULT_TIMEZONE }).format(date);
    } catch {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(date);
    }
}
const SETTINGS_INT_FIELDS = ['volume_level', 'daily_limit_minutes', 'break_reminder_minutes'];
const SETTINGS_BOOL_FIELDS = ['daily_limit_enabled', 'night_mode_enabled', 'evening_mode_enabled'];
const SETTINGS_TIME_FIELDS = ['night_mode_start', 'night_mode_end', 'evening_mode_start'];
const CONTENT_LABELS = {
    riddles: 'riddles', stories: 'stories', tongueTwisters: 'tongue twisters', jokes: 'jokes',
    miniGames: 'mini-games', educationalActivities: 'educational activities', rolePlay: 'role-play',
    speechDevelopment: 'speech development activities', worldFacts: 'world facts', improvisedContent: 'improvised content',
    emotionalIntelligence: 'emotional intelligence activities',
    interactiveTales: 'interactive stories and choose-your-own-adventure tales',
    healthyHabits: 'healthy habits and hygiene',
    safetyFirst: 'safety first rules',
    attentionGames: 'attention and logic games',
    goodManners: 'etiquette and good manners',
    adhdNeurogames: 'ADHD attention and self-regulation neurogames',
};

let pool = null;
let ready = false;

function safeText(value, max) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').slice(0, max);
}

// Same idea as safeText() but for long-form free text meant to keep its
// paragraph structure (custom_prompt_text, restrictions_addition) — collapses
// horizontal whitespace only and caps runs of blank lines, but does NOT
// flatten newlines into spaces the way safeText() does. Using safeText() on
// these fields was the cause of saved prompts turning into one solid
// unformatted block.
function safeMultilineText(value, max) {
    return String(value == null ? '' : value)
        .replace(/\r\n/g, '\n')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, max);
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
            custom_toy_type TEXT DEFAULT '',
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
            allowed_content JSONB DEFAULT '{"riddles":true,"stories":true,"tongueTwisters":true,"jokes":true,"miniGames":true,"educationalActivities":true,"rolePlay":true,"speechDevelopment":true,"worldFacts":true,"improvisedContent":true,"emotionalIntelligence":true,"interactiveTales":true,"healthyHabits":true,"safetyFirst":true,"attentionGames":true,"goodManners":true,"adhdNeurogames":true}',
            preferred_themes TEXT DEFAULT '',
            blocked_themes TEXT DEFAULT '',
            sensitive_themes TEXT DEFAULT '',
            story_length TEXT DEFAULT 'up_to_1min',
            scary_elements TEXT DEFAULT 'off',
            conversation_language TEXT DEFAULT 'auto',
            daily_limit_enabled BOOLEAN DEFAULT false,
            daily_limit_minutes INTEGER DEFAULT 0,
            night_mode_enabled BOOLEAN DEFAULT false,
            night_mode_start TEXT DEFAULT '22:00',
            night_mode_end TEXT DEFAULT '07:00',
            break_reminder_minutes INTEGER DEFAULT 0,
            evening_mode_enabled BOOLEAN DEFAULT false,
            evening_mode_start TEXT DEFAULT '20:00',
            restrictions_addition TEXT DEFAULT '',
            custom_prompt_enabled BOOLEAN DEFAULT false,
            custom_prompt_text TEXT DEFAULT '',
            timezone TEXT DEFAULT 'Europe/Chisinau',
            city TEXT DEFAULT '',
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now()
        );
    `);
    // device_settings already exists in production — CREATE TABLE IF NOT EXISTS
    // above won't retroactively add columns to an existing table.
    await pool.query(`
        ALTER TABLE device_settings
            ADD COLUMN IF NOT EXISTS custom_prompt_enabled BOOLEAN DEFAULT false,
            ADD COLUMN IF NOT EXISTS custom_prompt_text TEXT DEFAULT '',
            ADD COLUMN IF NOT EXISTS custom_toy_type TEXT DEFAULT '',
            ADD COLUMN IF NOT EXISTS conversation_language TEXT DEFAULT 'auto',
            ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Europe/Chisinau',
            ADD COLUMN IF NOT EXISTS city TEXT DEFAULT '';
    `);

    // Named snapshots a parent can save/load, e.g. one per child sharing the
    // same toy. Simple version: no live "active profile" resolution layer —
    // saving snapshots the current child_profiles + device_settings row for
    // this device_id, loading overwrites that same row (same one
    // session.start already reads). Switching profiles takes effect on the
    // next session.start, not mid-conversation.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS device_profiles (
            id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            name TEXT NOT NULL,
            child_snapshot JSONB DEFAULT '{}',
            settings_snapshot JSONB DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now()
        );
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS device_profiles_device_id_idx ON device_profiles (device_id, created_at);');

    // Real server-side usage tracking backing the "working hours" enforcement
    // (daily limit / night mode / break reminders). One row per realtime
    // connection that actually reached session.start. duration_seconds is
    // accumulated by periodic ticks from realtimeServer.js while the
    // connection is open, plus a final flush on close. usage_date is set
    // explicitly by the caller at insert time using the DEVICE's own
    // timezone (device_settings.timezone, see localDateStringInTz above),
    // not the database/server timezone — so "today" for a daily limit
    // matches the child's actual local day, not UTC.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS usage_sessions (
            id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            started_at TIMESTAMPTZ DEFAULT now(),
            ended_at TIMESTAMPTZ,
            duration_seconds INTEGER DEFAULT 0,
            usage_date DATE NOT NULL
        );
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS usage_sessions_device_date_idx ON usage_sessions (device_id, usage_date);');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS dialogue_turns (
            id SERIAL PRIMARY KEY,
            device_id TEXT NOT NULL REFERENCES child_profiles(device_id) ON DELETE CASCADE,
            session_id TEXT,
            created_at TIMESTAMPTZ DEFAULT now(),
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            text TEXT NOT NULL,
            category TEXT DEFAULT 'chat',
            tone TEXT DEFAULT 'neutral',
            topic TEXT DEFAULT 'limits'
        );
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS dialogue_turns_device_created_idx ON dialogue_turns (device_id, created_at);');

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
        values.push(safeMultilineText(patch.restrictions_addition, RESTRICTIONS_ADDITION_MAX_CHARS));
        setClauses.push(`restrictions_addition = $${values.length}`);
    }
    if ('custom_prompt_enabled' in patch) {
        values.push(!!patch.custom_prompt_enabled);
        setClauses.push(`custom_prompt_enabled = $${values.length}`);
    }
    if ('custom_prompt_text' in patch) {
        values.push(safeMultilineText(patch.custom_prompt_text, CUSTOM_PROMPT_MAX_CHARS));
        setClauses.push(`custom_prompt_text = $${values.length}`);
    }

    if (!setClauses.length) return getOrCreateSettings(id);

    setClauses.push('updated_at = now()');
    const { rows } = await pool.query(
        `UPDATE device_settings SET ${setClauses.join(', ')} WHERE device_id = $1 RETURNING *;`,
        values,
    );
    return rows[0];
}

async function listProfiles(deviceId) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    const { rows } = await pool.query(
        'SELECT id, name, created_at, updated_at FROM device_profiles WHERE device_id = $1 ORDER BY created_at ASC;',
        [id],
    );
    return rows;
}

// Snapshots the current child_profiles + device_settings row for this
// device into a new named profile. Memory facts are intentionally NOT
// included — they stay tied to whatever is actually live on the device,
// not to a saved snapshot.
async function saveProfileSnapshot(deviceId, name) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    const safeName = safeText(name, 40);
    if (!safeName) {
        const error = new Error('profile_name_required');
        error.code = 'profile_name_required';
        throw error;
    }
    const profile = await getOrCreateProfile(id);
    const settings = await getOrCreateSettings(id);
    const profileId = 'p_' + crypto.randomBytes(8).toString('hex');

    const childSnapshot = {};
    for (const field of PROFILE_FIELDS) childSnapshot[field] = profile[field];
    const settingsSnapshot = {};
    for (const field of [...SETTINGS_TEXT_FIELDS, ...SETTINGS_INT_FIELDS, ...SETTINGS_BOOL_FIELDS, ...SETTINGS_TIME_FIELDS]) {
        settingsSnapshot[field] = settings[field];
    }
    settingsSnapshot.allowed_content = settings.allowed_content;
    settingsSnapshot.restrictions_addition = settings.restrictions_addition;
    settingsSnapshot.custom_prompt_enabled = settings.custom_prompt_enabled;
    settingsSnapshot.custom_prompt_text = settings.custom_prompt_text;

    const { rows } = await pool.query(
        `INSERT INTO device_profiles (id, device_id, name, child_snapshot, settings_snapshot)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, name, created_at, updated_at;`,
        [profileId, id, safeName, JSON.stringify(childSnapshot), JSON.stringify(settingsSnapshot)],
    );
    return rows[0];
}

// Overwrites the device's single active child_profiles/device_settings row
// with a saved snapshot. Takes effect on the next session.start, not
// mid-conversation (no live "active profile" resolution layer in this
// simple version).
async function loadProfileSnapshot(deviceId, profileId) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    const { rows } = await pool.query(
        'SELECT * FROM device_profiles WHERE id = $1 AND device_id = $2;',
        [profileId, id],
    );
    const snapshot = rows[0];
    if (!snapshot) {
        const error = new Error('profile_not_found');
        error.code = 'profile_not_found';
        throw error;
    }
    const profile = await updateProfileFields(id, snapshot.child_snapshot || {});
    const settings = await updateSettings(id, snapshot.settings_snapshot || {});
    return { profile, settings };
}

async function deleteProfileSnapshot(deviceId, profileId) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    await pool.query('DELETE FROM device_profiles WHERE id = $1 AND device_id = $2;', [profileId, id]);
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
    toy_type: { bear: 'a bear', bunny: 'a bunny', cat: 'a cat', star: 'a traveling star' },
    voice_speed: {
        slow: 'Speak at a slightly slower, calmer pace than usual.',
        fast: 'Speak at a slightly faster, more energetic pace than usual.',
    },
};

// Called fresh on every session.start (realtimeServer.js) — NOT a one-time
// default for an editable text field. This is what makes character/content/
// time dropdowns in the parent panel actually take effect on save, instead
// of only affecting a frozen text snapshot. The fixed BASE_RESTRICTIONS
// (realtimePrompt.js) is what actually can't be weakened; this block is
// layered on top of it by composeParentRules().
function formatParentRulesAddition(settings) {
    const s = settings || {};
    const lines = [];

    lines.push('TOY');
    const toyName = s.toy_name || 'Lumi';
    const toyKind = s.toy_type === 'custom' && s.custom_toy_type
        ? s.custom_toy_type
        : (STYLE_TEXT.toy_type[s.toy_type] || 'a bear');
    lines.push(`- The toy's name is ${toyName}, appearing as ${toyKind}.`);
    if (s.toy_gender) lines.push(`- Toy character gender: ${s.toy_gender === 'male' ? 'male' : 'female'}.`);
    const paceHint = STYLE_TEXT.voice_speed[s.voice_speed];
    if (paceHint) lines.push(`- ${paceHint}`);

    lines.push('');
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
    // Bug fix: this used to say "Do not proactively introduce", which only
    // stopped the model from bringing the topic up unprompted — it still
    // freely discussed it when the child asked directly. The parent panel
    // labels this field "Запрещённые темы" (forbidden topics), so a direct
    // question must also be refused, not just unprompted mentions.
    if (s.blocked_themes) lines.push(`- These topics are forbidden: ${s.blocked_themes}. Do not discuss or engage with them even if the child asks directly. If asked, gently redirect to a different topic without explaining why.`);
    if (s.sensitive_themes) lines.push(`- Sensitive themes: ${s.sensitive_themes}. Do not mention unless the child raises them directly.`);
    lines.push(`- Story length: ${STYLE_TEXT.story_length[s.story_length] || 'up to about 1 minute'}.`);
    lines.push(`- Scary elements: ${STYLE_TEXT.scary_elements[s.scary_elements] || 'no scary elements at all'}.`);

    if (s.daily_limit_enabled || s.night_mode_enabled || s.evening_mode_enabled) {
        lines.push('');
        lines.push('TIME');
        const tzLabel = s.timezone || DEFAULT_TIMEZONE;
        if (s.daily_limit_enabled && s.daily_limit_minutes) lines.push(`- Daily usage limit: ${s.daily_limit_minutes} minutes. This is enforced by the server itself (the connection will be closed once the limit is reached) — if you are told the session is ending for this reason, say a warm, brief goodbye and do not try to keep playing.`);
        if (s.night_mode_enabled) lines.push(`- Night mode window: ${s.night_mode_start}-${s.night_mode_end} local device time (${tzLabel}). This is enforced by the server itself — new sessions are refused and active ones are ended during that window, you will not normally be asked to talk during it.`);
        if (s.evening_mode_enabled) {
            // _eveningModeActiveNow is computed live by realtimeServer.js against
            // the real current clock time on every session.start, not just
            // whether the toggle is enabled — see composeParentRules() caller.
            lines.push(s._eveningModeActiveNow
                ? `- Evening calm mode is ACTIVE right now (after ${s.evening_mode_start} local device time): use a quieter tone, shorter replies, no energetic games.`
                : `- Evening calm mode is enabled but NOT active right now (it starts at ${s.evening_mode_start} local device time, ${tzLabel}) — use your normal tone.`);
        }
    }

    return lines.join('\n');
}

// ---- Usage tracking (real server-side time enforcement) ----------------
//
// Day boundary: usage_date is set explicitly at row creation using the
// DEVICE's own timezone (device_settings.timezone, defaults to
// 'Europe/Chisinau' — see localDateStringInTz above), not UTC and not the
// server container's timezone. Night mode / evening mode windows are also
// compared against this same device timezone (see isWithinNightWindow /
// isEveningModeActive in realtimeServer.js), so "today" and "22:00" both
// mean the child's actual local day/time, not the server's.

async function startUsageSession(deviceId, timezone) {
    requireReady();
    const usageId = 'u_' + crypto.randomBytes(8).toString('hex');
    const id = normalizeDeviceId(deviceId);
    const usageDate = localDateStringInTz(timezone);
    await pool.query(
        `INSERT INTO usage_sessions (id, device_id, usage_date) VALUES ($1, $2, $3);`,
        [usageId, id, usageDate],
    );
    return usageId;
}

async function addUsageSeconds(usageSessionId, seconds) {
    requireReady();
    if (!usageSessionId || !Number.isFinite(seconds) || seconds <= 0) return;
    await pool.query(
        `UPDATE usage_sessions SET duration_seconds = duration_seconds + $2, ended_at = now() WHERE id = $1;`,
        [usageSessionId, Math.round(seconds)],
    );
}

async function endUsageSession(usageSessionId) {
    requireReady();
    if (!usageSessionId) return;
    await pool.query(`UPDATE usage_sessions SET ended_at = now() WHERE id = $1;`, [usageSessionId]);
}

// Sum of duration_seconds for the current calendar day in the device's own
// timezone, in minutes (rounded down). Includes the still-open session
// row's ticks so far.
async function getUsageMinutesToday(deviceId, timezone) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    const usageDate = localDateStringInTz(timezone);
    const { rows } = await pool.query(
        `SELECT COALESCE(SUM(duration_seconds), 0) AS total_seconds
         FROM usage_sessions
         WHERE device_id = $1 AND usage_date = $2::date;`,
        [id, usageDate],
    );
    return Math.floor(Number(rows[0]?.total_seconds || 0) / 60);
}

async function getRecentUsageSessions(deviceId, limit = 15) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    const { rows } = await pool.query(
        `SELECT id, started_at, ended_at, duration_seconds, usage_date
         FROM usage_sessions WHERE device_id = $1
         ORDER BY started_at DESC LIMIT $2;`,
        [id, limit],
    );
    return rows;
}

// Per-day totals (minutes) for the last N days including today (in the
// device's own timezone), oldest first.
async function getDailyUsageMinutes(deviceId, timezone, days = 7) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    const todayKey = localDateStringInTz(timezone);
    const oldestKey = localDateStringInTz(timezone, new Date(Date.now() - (days - 1) * 86400000));
    const { rows } = await pool.query(
        `SELECT usage_date, COALESCE(SUM(duration_seconds), 0) AS total_seconds
         FROM usage_sessions
         WHERE device_id = $1 AND usage_date >= $2::date AND usage_date <= $3::date
         GROUP BY usage_date
         ORDER BY usage_date ASC;`,
        [id, oldestKey, todayKey],
    );
    const byDate = new Map(rows.map((r) => [String(r.usage_date), Math.floor(Number(r.total_seconds) / 60)]));
    const out = [];
    for (let i = days - 1; i >= 0; i -= 1) {
        const key = localDateStringInTz(timezone, new Date(Date.now() - i * 86400000));
        out.push({ date: key, minutes: byDate.get(key) || 0 });
    }
    return out;
}

function classifyTurnHeuristically(text) {
    const lower = String(text || '').toLowerCase();
    
    // 1. Classify Category
    let category = 'chat';
    if (lower.includes('сказк') || lower.includes('расскаж') || lower.includes('истори')) {
        category = 'stories';
    } else if (lower.includes('загад') || lower.includes('отгад')) {
        category = 'riddles';
    } else if (lower.includes('скороговор')) {
        category = 'tongue_twisters';
    } else if (lower.includes('игр') || lower.includes('поигра')) {
        category = 'mini_games';
    } else if (lower.includes('счита') || lower.includes('посчит') || lower.includes('цифр') || lower.includes('букв') || lower.includes('слож')) {
        category = 'learning';
    } else if (lower.includes('представ') || lower.includes('космонавт') || lower.includes('герой') || lower.includes('рол')) {
        category = 'roleplay';
    } else if (lower.includes('повтор') || lower.includes('звук') || lower.includes('букв')) {
        category = 'speech_development';
    }

    // 2. Classify Tone
    let tone = 'neutral';
    if (lower.includes('!') || lower.includes('ура') || lower.includes('класс') || lower.includes('круто')) {
        tone = 'happy';
    } else if (lower.includes('пожалуйста') || lower.includes('спасибо') || lower.includes('помоги')) {
        tone = 'supportive';
    } else if (lower.includes('?')) {
        tone = 'curious';
    }

    // 3. Classify Topic
    let topic = 'limits';
    if (lower.includes('животн') || lower.includes('кошк') || lower.includes('собак') || lower.includes('звер')) {
        topic = 'animals';
    } else if (lower.includes('космос') || lower.includes('звезд') || lower.includes('лун') || lower.includes('планет')) {
        topic = 'space';
    } else if (lower.includes('ед') || lower.includes('конфет') || lower.includes('яблок') || lower.includes('суп')) {
        topic = 'food';
    } else if (lower.includes('друг') || lower.includes('дружб') || lower.includes('вместе')) {
        topic = 'friendship';
    }

    return { category, tone, topic };
}

async function saveDialogueTurn(deviceId, sessionId, role, text) {
    if (!ready || !pool) return;
    const { category, tone, topic } = classifyTurnHeuristically(text);
    const id = normalizeDeviceId(deviceId);
    await pool.query(
        `INSERT INTO dialogue_turns (device_id, session_id, role, text, category, tone, topic)
         VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [id, sessionId || null, role, text, category, tone, topic]
    );
}

// Computes the UTC instant of local midnight (00:00:00) for `dateStr`
// (YYYY-MM-DD) in `timezone`. Needed because "today"/"неделя"/etc. day
// boundaries must be the DEVICE's local midnight, not UTC midnight —
// appending a literal "+00" to a local date string (the previous approach)
// silently asserted every device is in UTC. Found live: a device
// configured for Europe/Chisinau (UTC+3 in summer) had a conversation at
// 21:38 UTC on day N, which is already 00:38 local time on day N+1 — a
// naive "date + 00:00:00+00" query for "today" (day N+1, UTC-interpreted)
// excluded that row entirely, even though it unambiguously happened
// "today" from the device's own local perspective.
//
// Method: guess the UTC instant equal to dateStr's UTC midnight, read what
// wall-clock time that instant shows in `timezone` (via Intl, no library),
// and shift by the difference — a standard technique for timezone-aware
// midnight conversion using only the platform's built-in Intl API.
function localMidnightUtcMs(timezone, dateStr) {
    const guessMs = Date.parse(dateStr + 'T00:00:00.000Z');
    let parts;
    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone || DEFAULT_TIMEZONE, hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(new Date(guessMs));
    } catch {
        return guessMs; // invalid timezone string -> fall back to UTC, same as localDateStringInTz's own fallback
    }
    const map = {};
    parts.forEach((p) => { if (p.type !== 'literal') map[p.type] = p.value; });
    const localReadingAsUtcMs = Date.UTC(
        Number(map.year), Number(map.month) - 1, Number(map.day),
        Number(map.hour), Number(map.minute), Number(map.second),
    );
    const offsetMs = localReadingAsUtcMs - guessMs;
    return guessMs - offsetMs;
}

function addDaysToDateStr(dateStr, days) {
    const ms = Date.parse(dateStr + 'T00:00:00.000Z') + days * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
}

// Shared period-name -> date-range resolver, used by both
// getDialogueAnalytics() and getDialogueTurns() (the full-transcript
// export) so "неделя"/"месяц"/"год"/"всё время"/"свой период" mean
// exactly the same date range in the analytics summary and in the
// transcript a parent downloads for that same period — one definition,
// not two independently-maintained ones.
const PERIOD_NAMES = ['today', 'yesterday', '7d', '30d', 'year', 'all', 'custom'];

function resolvePeriodRange(timezone, options = {}) {
    const todayStr = localDateStringInTz(timezone);
    const todayParts = todayStr.split('-');
    const today = new Date(Date.UTC(Number(todayParts[0]), Number(todayParts[1]) - 1, Number(todayParts[2])));

    const period = PERIOD_NAMES.includes(options.period) ? options.period : '7d';
    let fromDateStr = '';
    let toDateStr = todayStr;

    if (period === 'today') {
        fromDateStr = todayStr;
        toDateStr = todayStr;
    } else if (period === 'yesterday') {
        const yest = new Date(today.getTime() - 86400000);
        fromDateStr = localDateStringInTz(timezone, yest);
        toDateStr = fromDateStr;
    } else if (period === '7d') {
        const oldest = new Date(today.getTime() - 6 * 86400000);
        fromDateStr = localDateStringInTz(timezone, oldest);
    } else if (period === '30d') {
        const oldest = new Date(today.getTime() - 29 * 86400000);
        fromDateStr = localDateStringInTz(timezone, oldest);
    } else if (period === 'year') {
        const oldest = new Date(today.getTime() - 364 * 86400000);
        fromDateStr = localDateStringInTz(timezone, oldest);
    } else if (period === 'all') {
        fromDateStr = '1970-01-01';
    } else if (period === 'custom') {
        fromDateStr = options.from || todayStr;
        toDateStr = options.to || todayStr;
    }

    // periodEndExclusive = local midnight of the day AFTER toDateStr, so
    // callers use `created_at < periodEndExclusive` — correctly includes
    // every instant of toDateStr in the device's own timezone, with no
    // last-second-of-the-day edge case and no UTC-vs-local mismatch.
    return {
        period,
        todayStr,
        fromDateStr,
        toDateStr,
        periodStart: new Date(localMidnightUtcMs(timezone, fromDateStr)).toISOString(),
        periodEndExclusive: new Date(localMidnightUtcMs(timezone, addDaysToDateStr(toDateStr, 1))).toISOString(),
    };
}

async function getDialogueAnalytics(deviceId, timezone, options = {}) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    const { period, todayStr, fromDateStr, toDateStr, periodStart, periodEndExclusive } = resolvePeriodRange(timezone, options);
    const tz = timezone || DEFAULT_TIMEZONE;

    const todayStart = new Date(localMidnightUtcMs(tz, todayStr)).toISOString();
    const todayEndExclusive = new Date(localMidnightUtcMs(tz, addDaysToDateStr(todayStr, 1))).toISOString();

    const [
        todayTurnsRes,
        todayAnswersRes,
        turnsPeriodRes,
        answersPeriodRes,
        categoriesRes,
        tonesRes,
        topicsRes,
        durationRes,
        dailyTurnsRes,
        dailyDurationRes
    ] = await Promise.all([
        pool.query(`SELECT COUNT(*) as count FROM dialogue_turns WHERE device_id = $1 AND role = 'user' AND created_at >= $2::timestamptz AND created_at < $3::timestamptz;`, [id, todayStart, todayEndExclusive]),
        pool.query(`SELECT COUNT(*) as count FROM dialogue_turns WHERE device_id = $1 AND role = 'assistant' AND created_at >= $2::timestamptz AND created_at < $3::timestamptz;`, [id, todayStart, todayEndExclusive]),
        pool.query(`SELECT COUNT(*) as count FROM dialogue_turns WHERE device_id = $1 AND role = 'user' AND created_at >= $2::timestamptz AND created_at < $3::timestamptz;`, [id, periodStart, periodEndExclusive]),
        pool.query(`SELECT COUNT(*) as count FROM dialogue_turns WHERE device_id = $1 AND role = 'assistant' AND created_at >= $2::timestamptz AND created_at < $3::timestamptz;`, [id, periodStart, periodEndExclusive]),
        pool.query(`SELECT category, COUNT(*) as count FROM dialogue_turns WHERE device_id = $1 AND role = 'user' AND created_at >= $2::timestamptz AND created_at < $3::timestamptz GROUP BY category ORDER BY count DESC;`, [id, periodStart, periodEndExclusive]),
        pool.query(`SELECT tone, COUNT(*) as count FROM dialogue_turns WHERE device_id = $1 AND role = 'user' AND created_at >= $2::timestamptz AND created_at < $3::timestamptz GROUP BY tone ORDER BY count DESC;`, [id, periodStart, periodEndExclusive]),
        pool.query(`SELECT topic, COUNT(*) as count FROM dialogue_turns WHERE device_id = $1 AND role = 'user' AND created_at >= $2::timestamptz AND created_at < $3::timestamptz GROUP BY topic ORDER BY count DESC;`, [id, periodStart, periodEndExclusive]),
        pool.query(`SELECT COALESCE(SUM(duration_seconds), 0) as total_seconds FROM usage_sessions WHERE device_id = $1 AND usage_date >= $2::date AND usage_date <= $3::date;`, [id, fromDateStr, toDateStr]),
        // created_at is converted to the device's own local date (not the
        // database session's timezone, which is UTC on Railway) so a
        // conversation just after local midnight is grouped under the
        // correct local day, not the previous UTC day.
        pool.query(`SELECT (created_at AT TIME ZONE $4)::date as usage_date, COUNT(CASE WHEN role='user' THEN 1 END) as turns, COUNT(CASE WHEN role='assistant' THEN 1 END) as answers FROM dialogue_turns WHERE device_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz GROUP BY usage_date;`, [id, periodStart, periodEndExclusive, tz]),
        pool.query(`SELECT usage_date, COALESCE(SUM(duration_seconds), 0) as total_seconds FROM usage_sessions WHERE device_id = $1 AND usage_date >= $2::date AND usage_date <= $3::date GROUP BY usage_date;`, [id, fromDateStr, toDateStr])
    ]);

    const categories = categoriesRes.rows.map(r => ({ category: r.category, count: Number(r.count) }));
    const tones = tonesRes.rows.map(r => ({ tone: r.tone, count: Number(r.count) }));
    const topics = topicsRes.rows.map(r => ({ topic: r.topic, count: Number(r.count) }));
    
    const dailyMap = new Map();
    dailyTurnsRes.rows.forEach(r => {
        const dStr = localDateStringInTz(timezone, new Date(r.usage_date));
        dailyMap.set(dStr, { usage_date: dStr, turns: Number(r.turns), answers: Number(r.answers), duration_minutes: 0 });
    });
    dailyDurationRes.rows.forEach(r => {
        const dStr = localDateStringInTz(timezone, new Date(r.usage_date));
        const val = dailyMap.get(dStr) || { usage_date: dStr, turns: 0, answers: 0, duration_minutes: 0 };
        val.duration_minutes = Math.floor(Number(r.total_seconds) / 60);
        dailyMap.set(dStr, val);
    });

    const daily = Array.from(dailyMap.values()).sort((a, b) => a.usage_date.localeCompare(b.usage_date));

    return {
        today: todayStr,
        period,
        period_from: fromDateStr,
        period_to: toDateStr,
        today_turns: Number(todayTurnsRes.rows[0]?.count || 0),
        today_answers: Number(todayAnswersRes.rows[0]?.count || 0),
        turns_period: Number(turnsPeriodRes.rows[0]?.count || 0),
        answers_period: Number(answersPeriodRes.rows[0]?.count || 0),
        duration_minutes_period: Math.floor(Number(durationRes.rows[0]?.total_seconds || 0) / 60),
        categories,
        tones,
        topics,
        daily
    };
}

// Full text transcript for a parent to read/download — every saved turn
// (both the child's words and Lumi's replies) in chronological order for
// the resolved period, via the exact same resolvePeriodRange() used by
// getDialogueAnalytics() so "неделя"/"год"/"свой период" mean the same
// date range in both places.
//
// TRANSCRIPT_ROW_CAP guards against one pathological unbounded query (a
// device with years of daily use and no cleanup) rather than a realistic
// concern — a full year of daily use is on the order of a few thousand
// rows (see docs sizing note in the parent panel), nowhere near this cap
// in practice. `truncated: true` tells the caller (and the parent-facing
// UI) explicitly when the cap was hit, instead of silently returning a
// partial transcript that looks complete.
const TRANSCRIPT_ROW_CAP = 20000;

async function getDialogueTurns(deviceId, timezone, options = {}) {
    requireReady();
    const id = normalizeDeviceId(deviceId);
    const { period, fromDateStr, toDateStr, periodStart, periodEndExclusive } = resolvePeriodRange(timezone, options);

    const { rows } = await pool.query(
        `SELECT id, session_id, created_at, role, text, category, tone, topic
         FROM dialogue_turns
         WHERE device_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
         ORDER BY created_at ASC, id ASC
         LIMIT $4;`,
        [id, periodStart, periodEndExclusive, TRANSCRIPT_ROW_CAP + 1],
    );

    const truncated = rows.length > TRANSCRIPT_ROW_CAP;
    const turns = (truncated ? rows.slice(0, TRANSCRIPT_ROW_CAP) : rows).map((row) => ({
        id: row.id,
        session_id: row.session_id,
        created_at: row.created_at,
        role: row.role,
        text: row.text,
        category: row.category,
        tone: row.tone,
        topic: row.topic,
    }));

    return {
        period,
        period_from: fromDateStr,
        period_to: toDateStr,
        turns,
        truncated,
    };
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
    CUSTOM_PROMPT_MAX_CHARS,
    listProfiles,
    saveProfileSnapshot,
    loadProfileSnapshot,
    deleteProfileSnapshot,
    formatChildContext,
    PROFILE_FIELDS,
    MAX_FACTS_PER_PROFILE,
    startUsageSession,
    addUsageSeconds,
    endUsageSession,
    getUsageMinutesToday,
    getRecentUsageSessions,
    getDailyUsageMinutes,
    localDateStringInTz,
    DEFAULT_TIMEZONE,
    saveDialogueTurn,
    getDialogueAnalytics,
    getDialogueTurns,
};
