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
    'story_length', 'scary_elements', 'timezone', 'city',
];
const SETTINGS_TEXT_LIMITS = {
    toy_name: 40, toy_type: 40, custom_toy_type: 40, toy_gender: 12, voice_name: 40, voice_speed: 12,
    character_style: 40, address_style: 20, reply_length: 20, energy_level: 20,
    humor_level: 20, initiative_level: 20, custom_character_notes: 500,
    content_mode: 30, preferred_themes: 200, blocked_themes: 200, sensitive_themes: 200,
    story_length: 20, scary_elements: 20, timezone: 60, city: 80,
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
            allowed_content JSONB DEFAULT '{"riddles":true,"stories":true,"tongueTwisters":true,"jokes":true,"miniGames":true,"educationalActivities":true,"rolePlay":true,"speechDevelopment":true,"worldFacts":true,"improvisedContent":true,"emotionalIntelligence":true,"interactiveTales":true}',
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
};
