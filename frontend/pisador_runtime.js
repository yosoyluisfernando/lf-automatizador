'use strict';

function sum(values) {
    return values.reduce((total, value) => total + value, 0);
}

function applicablePisadores({ advanced = [], quickRule = null }) {
    const activeAdvanced = advanced.filter(item => item?.active);
    if (!quickRule) return activeAdvanced;
    const quick = {
        id: 'quick',
        active: true,
        mode: 'start',
        time: String(quickRule.startSeconds),
        source: quickRule.source,
        options: { overflowPolicy: 'skip' }
    };
    if (quickRule.advancedPolicy === 'ignore') return [quick];
    return activeAdvanced.length ? activeAdvanced : [quick];
}

async function measurePaths(paths, getDuration, { skipInvalid = false } = {}) {
    const measured = [];
    for (const filePath of paths) {
        try {
            const duration = Number(await getDuration(filePath));
            if (!Number.isFinite(duration) || duration <= 0) throw new Error('duracion no disponible');
            measured.push({ filePath, duration });
        } catch (err) {
            if (!skipInvalid) throw err;
        }
    }
    return measured;
}

function markerFor(item, markers = {}) {
    const dynamic = item.time === 'intro' || item.time === 'outro';
    const marker = Number(dynamic ? markers[item.time] : item.time);
    return {
        marker,
        available: Number.isFinite(marker) && (!dynamic || marker > 0)
    };
}

async function resolvePaths(item, context, deps, warnings, marker) {
    if (item.source?.kind === 'file') return item.source.path ? [item.source.path] : [];
    if (item.source?.kind === 'builtin') return (await deps.resolveBuiltin(item.source)).filter(Boolean);
    if (item.source?.kind !== 'folder') return [];

    const files = (await deps.listFolderFiles(item.source.path)).filter(Boolean);
    if (!files.length || item.mode !== 'end') return files.length ? [deps.chooseRandom(files)] : [];

    const space = Math.max(0, marker - Number(context.startOffset || 0));
    const measured = await measurePaths(files, deps.getDuration, { skipInvalid: true });
    const fitting = measured.filter(entry => entry.duration <= space).map(entry => entry.filePath);
    if (fitting.length) return [deps.chooseRandom(fitting)];

    warnings.push(`${item.id}: no cabe ningun audio antes del punto de anclaje.`);
    if ((item.options?.overflowPolicy || 'skip') === 'skip') return [];
    const fallback = measured.map(entry => entry.filePath);
    return fallback.length ? [deps.chooseRandom(fallback)] : [];
}

async function prepareOne(item, context, deps, warnings) {
    const startOffset = Number(context.startOffset || 0);
    const { marker, available } = markerFor(item, context.markers);
    if (!available) {
        warnings.push(`${item.id}: marcador no disponible.`);
        return null;
    }

    const paths = await resolvePaths(item, context, deps, warnings, marker);
    if (!paths.length) {
        if (!warnings.some(warning => warning.startsWith(`${item.id}:`))) {
            warnings.push(`${item.id}: fuente no disponible.`);
        }
        return null;
    }

    const duration = sum((await measurePaths(paths, deps.getDuration)).map(entry => entry.duration));
    const overflowPolicy = item.options?.overflowPolicy || 'skip';
    let absoluteTrigger = item.mode === 'end' ? marker - duration : marker;
    let stopAt = null;

    if (item.mode !== 'end' && absoluteTrigger < startOffset) {
        warnings.push(`${item.id}: el punto de disparo ya paso.`);
        return null;
    }
    if (item.mode === 'end' && absoluteTrigger < startOffset) {
        if (overflowPolicy === 'skip') {
            warnings.push(`${item.id}: el audio no cabe antes del punto de anclaje.`);
            return null;
        }
        absoluteTrigger = startOffset;
        if (overflowPolicy === 'truncate-at-intro') stopAt = marker;
    }

    const plan = {
        id: item.id,
        playerId: `overlay-${context.sessionId}-${item.id}`,
        resolvedPaths: paths,
        duration,
        triggerTime: Math.max(0, absoluteTrigger - startOffset),
        stopAt,
        fired: false
    };
    const result = paths.length > 1
        ? await deps.preloadSequence(plan)
        : await deps.preloadFile(plan);
    if (!result?.ok) {
        warnings.push(`${item.id}: fallo de precarga.`);
        return null;
    }
    return plan;
}

async function prepareOverlaySession(context, deps) {
    const warnings = [];
    const plans = [];
    for (const item of applicablePisadores(context)) {
        try {
            const plan = await prepareOne(item, context, deps, warnings);
            if (plan) plans.push(plan);
        } catch (err) {
            warnings.push(`${item.id}: no se pudo preparar (${err.message || err}).`);
        }
    }
    return { sessionId: context.sessionId, plans, warnings };
}

module.exports = {
    applicablePisadores,
    prepareOverlaySession
};
