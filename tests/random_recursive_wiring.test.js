'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const render = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'render.js'), 'utf8');

test('dataset.recursive is persisted across all four serialization points', () => {
    // serializePlaylistRow (sesiones)
    assert.match(render, /recursive: row\.dataset\.recursive === 'true'/);
    // handleSavePlaylist (.LFPlay)
    assert.match(render, /recursive: r\.dataset\.recursive === 'true'/);
    // normalizePlaylistItem (lectura tolerante)
    assert.match(render, /item\.recursive === true \|\| item\.recursive === 'true'/);
    // loadPlaylistRowsInChunks / loader de sesion (reaplica el flag a filas random)
    assert.match(render, /rowType === 'random' && \(item\.recursive === true \|\| item\.recursive === 'true'\)/);
});

test('random selection honors the per-row recursive flag', () => {
    assert.match(render, /row\.dataset\.recursive === 'true'/);
    assert.match(render, /takeRandomFolderFileAvoidingRecentMusic\(folderPath, recursive\)/);
});

test('subfolder dialog policy resolves ask/always/never', () => {
    assert.match(render, /resolveRandomFolderRecursion/);
    assert.match(render, /policy === 'always'/);
    assert.match(render, /policy === 'never'/);
    assert.match(render, /askIncludeSubfolders/);
    // "No volver a preguntar" persiste el predeterminado global.
    assert.match(render, /randomIncludeSubfolders = recursive \? 'always' : 'never'/);
});

test('artist separation relaxation ladder and least-recently-played fallback exist', () => {
    assert.match(render, /pickLeastRecentlyPlayed/);
    assert.match(render, /Separacion por artista relajada temporalmente/);
    assert.match(render, /musicSeparation\.getEffectiveRules/);
});

test('separation rules window is reachable from the Tools menu', () => {
    const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(mainJs, /openMusicSeparationWindow/);
    assert.match(mainJs, /Reglas de separación musical/);
    assert.match(mainJs, /separacion_musical\.html/);
});
