'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

const DEFAULT_DEVICE_ID = 'browser-lab';
const MAX_FACTS_PER_PROFILE = 40;

const PROFILE_FIELDS = [
    'child_name', 'age_group', 'child_gender', 'interests',
    'important_people', 'calming_things', 'avoided_topics', 'communication_notes',
];
const FIELD_LIMITS = {
    child_name: 40, age_group: 12, child_gender: 12, interests: 200,
    important_people: 200, calming_things: 200, avoided_topics: 200, communication_notes: 500,
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
    formatChildContext,
    PROFILE_FIELDS,
    MAX_FACTS_PER_PROFILE,
};
