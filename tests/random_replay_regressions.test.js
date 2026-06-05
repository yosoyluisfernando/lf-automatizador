'use strict';

// Regresión: re-marcar manualmente como "siguiente" la MISMA carpeta aleatoria
// que está sonando debe permitir re-dispararla (otra pista al azar), en lugar de
// tratarla como pointer residual y saltar a la fila siguiente.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const rootDir = path.join(__dirname, '..');

function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `No se encontro function ${name}`);
    let parenDepth = 0;
    let afterParams = -1;
    for (let i = source.indexOf('(', start); i < source.length; i++) {
        if (source[i] === '(') parenDepth++;
        else if (source[i] === ')') {
            parenDepth--;
            if (parenDepth === 0) { afterParams = i + 1; break; }
        }
    }
    if (afterParams < 0) throw new Error(`No se pudo encontrar los parámetros de function ${name}`);
    const braceStart = source.indexOf('{', afterParams);
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}') depth--;
        if (depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`No se pudo extraer function ${name}`);
}

function runPlayNextWithManualRandomReplay(rowDataset) {
    const source = fs.readFileSync(path.join(rootDir, 'frontend', 'render.js'), 'utf8');
    const playNextSource = extractFunction(source, 'playNext');
    const nextRow = { id: 'next-track', dataset: {}, parentNode: {}, closest: () => tbody };
    const randomRow = {
        id: 'random-current',
        dataset: rowDataset,
        parentNode: {},
        nextElementSibling: nextRow,
        closest: () => tbody,
    };
    const tbody = { firstElementChild: randomRow };
    let played = null;
    let stopped = false;
    const context = {
        console,
        crossfadeTriggered: false,
        crossfadeTriggeredForRow: null,
        playbackFatalHalt: false,
        getUpcomingEventWithinPreHold: () => null,
        queuedNextRow: randomRow,
        currentPlayingRow: randomRow,
        document: { body: { contains: row => row === randomRow || row === nextRow } },
        generalPrefs: { modeLoopPlaylist: false },
        isRowAfterAnchor: () => false,
        resolveNextOperationalRow: row => row,
        resolvePriorityNextRow: row => row,
        tbodys: [tbody],
        pgmTab: 0,
        playRow: row => { played = row; },
        stopAll: () => { stopped = true; },
    };
    vm.createContext(context);
    vm.runInContext(`${playNextSource}; playNext(false);`, context);
    return { played, stopped, randomRow, nextRow };
}

test('playNext re-dispara la carpeta aleatoria actual cuando se marca manualmente como siguiente', () => {
    const { played, stopped, randomRow } = runPlayNextWithManualRandomReplay({ type: 'random', manualNext: 'true' });
    assert.strictEqual(played, randomRow);
    assert.strictEqual(stopped, false);
});

test('playNext NO re-dispara la fila actual si no es aleatoria (aunque esté marcada manual)', () => {
    const { played, nextRow } = runPlayNextWithManualRandomReplay({ type: 'normal', manualNext: 'true' });
    assert.strictEqual(played, nextRow);
});

test('playNext NO re-dispara una carpeta aleatoria actual si no fue marcada manualmente', () => {
    const { played, nextRow } = runPlayNextWithManualRandomReplay({ type: 'random' });
    assert.strictEqual(played, nextRow);
});
