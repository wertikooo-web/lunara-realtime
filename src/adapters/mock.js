'use strict';

function startSession(options = {}) {
    return {
        id: `mock-${Date.now()}`,
        provider: 'mock',
        options,
        startedAt: Date.now(),
    };
}

function sendAudioFrame(session, frame) {
    return {
        sessionId: session.id,
        accepted: true,
        bytes: Buffer.isBuffer(frame) ? frame.length : 0,
    };
}

function sendText(session, text) {
    return {
        sessionId: session.id,
        accepted: true,
        text,
    };
}

function closeSession(session) {
    return {
        sessionId: session.id,
        closed: true,
        durationMs: Date.now() - session.startedAt,
    };
}

module.exports = {
    name: 'mock',
    startSession,
    sendAudioFrame,
    sendText,
    closeSession,
};

