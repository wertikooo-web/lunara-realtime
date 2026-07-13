'use strict';

const fs = require('fs');

const html = fs.readFileSync('public/lab.html', 'utf8');

function requireIncludes(needle, message) {
    if (!html.includes(needle)) {
        throw new Error(message || `Missing: ${needle}`);
    }
}

function requireNotIncludes(needle, message) {
    if (html.includes(needle)) {
        throw new Error(message || `Forbidden: ${needle}`);
    }
}

function sectionBetween(start, end) {
    const startIndex = html.indexOf(start);
    if (startIndex === -1) throw new Error(`Missing section start: ${start}`);
    const endIndex = html.indexOf(end, startIndex + start.length);
    if (endIndex === -1) throw new Error(`Missing section end after ${start}: ${end}`);
    return html.slice(startIndex, endIndex);
}

function requireSectionIncludes(section, needle, message) {
    if (!section.includes(needle)) {
        throw new Error(message || `Missing in section: ${needle}`);
    }
}

const pointerDown = sectionBetween('function onPointerDown(event)', 'function onPointerUp(event)');
const pointerUp = sectionBetween('function onPointerUp(event)', 'function onPointerCancel(event)');
const pointerCancel = sectionBetween('function onPointerCancel(event)', 'function onLostPointerCapture(event)');
const finishPointerTurn = sectionBetween('function finishPointerTurn(event, endReason)', 'function onPointerDown(event)');
const endTurn = sectionBetween('function endTurn(reason, pointerInfo = {})', 'function manualInterrupt()');
const canPressPtt = sectionBetween('function canPressPtt()', 'function updateIds()');
const setState = sectionBetween('function setState(next, hint = \'\')', 'function stateClass(state)');
const renderPttButton = sectionBetween('function renderPttButton()', 'function stateClass(state)');

requireSectionIncludes(pointerDown, 'event.preventDefault();', 'pointerdown must prevent default browser selection/dragging');
requireSectionIncludes(pointerDown, 'capturePointer(event);', 'pointerdown must capture the pointer');
requireSectionIncludes(pointerDown, 'renderPttButton();', 'pointerdown must immediately render the held visual state');
requireIncludes('pttButton.setPointerCapture(event.pointerId);', 'Hold-to-Talk must use pointer capture');
requireIncludes("logLine('ptt_pointer_down'", 'pointerdown diagnostic log is required');

requireSectionIncludes(pointerUp, "finishPointerTurn(event, 'pointerup');", 'pointerup must finish the PTT turn');
requireSectionIncludes(pointerCancel, "finishPointerTurn(event, 'pointercancel');", 'pointercancel must emergency-finish the PTT turn');
requireIncludes('ptt_pointer_cancel', 'pointercancel diagnostic log is required');
requireIncludes("logLine('ptt_lost_pointer_capture'", 'lostpointercapture diagnostic log is required');
requireIncludes("window.addEventListener('blur', onWindowBlur);", 'window blur safety handler is required');
requireIncludes("document.addEventListener('visibilitychange', onVisibilityChange);", 'visibility hidden safety handler is required');

requireSectionIncludes(finishPointerTurn, 'if (!isActivePointer(event)) return;', 'pointerup/cancel must ignore non-active pointers');
requireSectionIncludes(finishPointerTurn, 'releasePointerCapture(event);', 'pointerup/cancel must release pointer capture');

requireSectionIncludes(endTurn, 'if (pttEndSent) return;', 'input_audio.end must be duplicate-guarded');
requireSectionIncludes(endTurn, 'renderPttButton();', 'ending the turn must refresh the button after pointer state changes');
requireSectionIncludes(endTurn, "type: 'input_audio.end'", 'endTurn must send input_audio.end');
requireSectionIncludes(endTurn, 'end_reason: reason', 'input_audio.end must carry safe end_reason diagnostics');
requireSectionIncludes(endTurn, "logLine('ptt_end_sent'", 'endTurn must log ptt_end_sent');
requireSectionIncludes(canPressPtt, 'lifecycleState === STATES.LISTENING', 'PTT must stay enabled during active LISTENING hold');
requireSectionIncludes(canPressPtt, 'isRecording || pointerHeld', 'LISTENING button enablement must require active recording/held pointer');
requireSectionIncludes(setState, 'renderPttButton();', 'setState must not render the PTT button directly from lifecycle state');
requireSectionIncludes(renderPttButton, 'pointerHeld || isRecording', 'PTT visual state must prioritize physical hold over realtime lifecycle state');
requireSectionIncludes(renderPttButton, 'STATES.LISTENING', 'Held PTT must remain visually in LISTENING state');

requireNotIncludes("addEventListener('pointerleave'", 'pointerleave must not end Hold-to-Talk');
requireNotIncludes('addEventListener("pointerleave"', 'pointerleave must not end Hold-to-Talk');
requireNotIncludes("addEventListener('mouseleave'", 'mouseleave must not end Hold-to-Talk');
requireNotIncludes('addEventListener("mouseleave"', 'mouseleave must not end Hold-to-Talk');
requireNotIncludes('endReason: \'mouseleave\'', 'mouseleave is not an allowed endReason');
requireNotIncludes('endReason: "mouseleave"', 'mouseleave is not an allowed endReason');
requireNotIncludes('MAX_RECORDING', 'No MAX_RECORDING auto-stop should exist in Browser Lab');
requireNotIncludes('MAX_SPEECH', 'No MAX_SPEECH auto-stop should exist in Browser Lab');
requireNotIncludes('RECORDING_TIMEOUT', 'No RECORDING_TIMEOUT auto-stop should exist in Browser Lab');
requireNotIncludes('MediaRecorder', 'Browser Lab PTT must not use MediaRecorder stop/timeslice');

const forbiddenAutoStops = [
    '15000',
    '30000',
    '15_000',
    '30_000',
];
for (const token of forbiddenAutoStops) {
    requireNotIncludes(token, `Hold-to-Talk must not auto-stop around ${token} ms`);
}

console.log('[PttButtonSmoke] ok');
