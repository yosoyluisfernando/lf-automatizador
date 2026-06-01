'use strict';

const path = require('path');

const PISADOR_IDS = Object.freeze(['p1', 'p2', 'p3', 'p4']);
const SOURCE_KINDS = new Set(['file', 'folder', 'builtin']);
const BUILTIN_NAMES = new Set(['time', 'temperature', 'humidity']);
const OVERFLOW_POLICIES = new Set(['skip', 'truncate-at-intro', 'allow-overlap']);
const QUICK_ADVANCED_POLICIES = new Set(['respect', 'ignore']);
const QUICK_SCOPES = new Set(['row', 'path']);

function normalizePisadorSource(source) {
    if (!source) return null;
    if (typeof source === 'string') {
        const sourcePath = source.trim();
        return sourcePath ? { v: 1, kind: 'file', path: sourcePath } : null;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'v') && source.v !== 1) return null;
    const kind = SOURCE_KINDS.has(source.kind) ? source.kind : '';
    if (!kind) return null;
    if (kind === 'builtin') {
        return BUILTIN_NAMES.has(source.name) ? { v: 1, kind, name: source.name } : null;
    }
    const sourcePath = String(source.path || '').trim();
    return sourcePath ? { v: 1, kind, path: sourcePath } : null;
}

function parsePisadorSource(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (!raw.startsWith('{')) return normalizePisadorSource(raw);
    try {
        return normalizePisadorSource(JSON.parse(raw));
    } catch (err) {
        return normalizePisadorSource(raw);
    }
}

function serializePisadorSource(source) {
    const normalized = normalizePisadorSource(source);
    if (!normalized) return null;
    return normalized.kind === 'file' ? normalized.path : JSON.stringify(normalized);
}

function normalizePisadorOptions(value) {
    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch (err) {
            parsed = {};
        }
    }
    if (parsed && typeof parsed === 'object'
        && Object.prototype.hasOwnProperty.call(parsed, 'v') && parsed.v !== 1) return null;
    const overflowPolicy = OVERFLOW_POLICIES.has(parsed?.overflowPolicy)
        ? parsed.overflowPolicy
        : 'skip';
    return { v: 1, overflowPolicy };
}

function serializePisadorOptions(value) {
    const normalized = normalizePisadorOptions(value);
    return normalized ? JSON.stringify(normalized) : null;
}

function conditionToStorage(condition, manualTime = null) {
    if (condition === 'intro') return { mode: 'end', time: 'intro' };
    if (condition === 'outro') return { mode: 'start', time: 'outro' };
    return { mode: condition === 'end' ? 'end' : 'start', time: manualTime };
}

function storageToCondition(mode, time) {
    if (time === 'intro') return 'intro';
    if (time === 'outro') return 'outro';
    return mode === 'end' ? 'end' : 'start';
}

function validateDynamicAnchor(condition, markers = {}) {
    if (condition !== 'intro' && condition !== 'outro') return { ok: true };
    const raw = markers[condition];
    const seconds = Number(raw);
    const numeric = typeof raw === 'number' || (typeof raw === 'string' && raw.trim());
    return numeric && Number.isFinite(seconds) && seconds > 0
        ? { ok: true, marker: condition, seconds }
        : { ok: false, marker: condition };
}

function normalizeQuickRule(rule) {
    if (rule && typeof rule === 'object'
        && Object.prototype.hasOwnProperty.call(rule, 'v') && rule.v !== 1) return null;
    const source = normalizePisadorSource(rule?.source);
    const rawStartSeconds = rule?.startSeconds;
    const numeric = typeof rawStartSeconds === 'number'
        || (typeof rawStartSeconds === 'string' && rawStartSeconds.trim());
    const startSeconds = Number(rawStartSeconds);
    if (!source || !numeric || !Number.isFinite(startSeconds) || startSeconds < 0) return null;
    return {
        v: 1,
        source,
        startSeconds,
        advancedPolicy: QUICK_ADVANCED_POLICIES.has(rule?.advancedPolicy) ? rule.advancedPolicy : 'respect',
        scope: QUICK_SCOPES.has(rule?.scope) ? rule.scope : 'row'
    };
}

function normalizeRulePathKey(value, platform = process.platform) {
    const resolver = platform === 'win32' ? path.win32 : path.posix;
    const resolved = resolver.resolve(String(value || '').trim());
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

module.exports = {
    PISADOR_IDS,
    parsePisadorSource,
    serializePisadorSource,
    normalizePisadorSource,
    normalizePisadorOptions,
    serializePisadorOptions,
    conditionToStorage,
    storageToCondition,
    validateDynamicAnchor,
    normalizeQuickRule,
    normalizeRulePathKey
};
