'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const editorHtml = fs.readFileSync(path.join(root, 'frontend', 'audio_editor.html'), 'utf8');
const editorJs = fs.readFileSync(path.join(root, 'frontend', 'audio_editor.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const renderJs = fs.readFileSync(path.join(root, 'frontend', 'render.js'), 'utf8');

test('advanced editor renders four uniform pisador rows', () => {
    assert.match(editorHtml, /id="pisadores-list"/);
    assert.match(editorJs, /PISADOR_IDS/);
    assert.doesNotMatch(editorHtml, /mode-phora/);
});

test('advanced editor exposes the approved condition order and source types', () => {
    assert.match(editorJs, /Inicia en[\s\S]*Termina en[\s\S]*Termina en Intro[\s\S]*Inicia en Outro/);
    assert.match(editorJs, /Archivo especifico[\s\S]*Carpeta aleatoria[\s\S]*Locucion de hora[\s\S]*Temperatura[\s\S]*Humedad/);
});

test('advanced editor validates dynamic anchors and exposes overflow settings', () => {
    assert.match(editorJs, /validateDynamicAnchor/);
    assert.match(editorHtml, /id="pisador-overflow-modal"/);
    assert.match(editorJs, /overflowPolicy/);
});

test('advanced editor selects folders through the portable folder dialog', () => {
    assert.match(editorJs, /kind === 'folder' \? 'dialog:selectFolder' : 'dialog:openFile'/);
});

test('playlist exposes quick automatic pisador modal and serializes row metadata', () => {
    assert.match(indexHtml, /id="pm-auto-pisador"/);
    assert.match(indexHtml, /id="auto-pisador-modal"/);
    assert.match(indexHtml, /id="auto-pisador-scope-row"/);
    assert.match(renderJs, /automaticPisadorRule/);
    assert.match(renderJs, /automatic_sweeper_rules\.json/);
    assert.match(renderJs, /normalizeQuickRuleForRowType/);
});

test('quick pisador modal explains loaded scope, deletes explicitly and confirms second zero', () => {
    assert.match(indexHtml, /id="auto-pisador-loaded-scope"/);
    assert.match(indexHtml, /id="auto-pisador-clear"[^>]*>Eliminar<\/button>/);
    assert.match(renderJs, /resolveEffectiveQuickRule/);
    assert.match(renderJs, /quickRuleNeedsZeroConfirmation/);
    assert.match(renderJs, /window\.confirm/);
});

test('renderer prepares, plays and clears overlay sessions instead of rerolling folders at trigger time', () => {
    assert.match(renderJs, /prepareOverlaySession/);
    assert.match(renderJs, /clearPreparedOverlaySession/);
    assert.match(renderJs, /registerRustOverlayRuntime/);
    assert.match(renderJs, /finishRustOverlayRuntime/);
    assert.match(renderJs, /commandRustControlPlane\('play'/);
    assert.doesNotMatch(renderJs, /playOverlayDrop\(mc\[`p\$\{i\}_file`\]\)/);
});

test('program ducking is applied as a factor inside the Rust deck-gain mirror so the reconcile cannot undo it', () => {
    // Causa raíz del bug del pisador: el duck se escribía directo sobre el gain
    // del deck y el siguiente ciclo de syncRustPlaylistControlPlane lo pisaba con
    // el gain "intended". El gain espejado DEBE multiplicar por programDuckFactor.
    assert.match(renderJs, /let programDuckFactor = 1\b/);
    assert.match(
        renderJs,
        /function getRustPlaylistMirrorGain[\s\S]*?base \* programDuckFactor/,
        'getRustPlaylistMirrorGain debe aplicar el factor de duck'
    );
});

test('ducking drives the global factor and fades decks via the engine, not a per-deck snapshot', () => {
    assert.match(renderJs, /function applyRustPlaylistDucking[\s\S]*?programDuckFactor = targetFactor/);
    assert.match(renderJs, /function removeRustPlaylistDucking[\s\S]*?programDuckFactor = 1/);
    assert.match(renderJs, /scheduleRustPlaylistGainRamp\(id, intended \* fromFactor/);
    // El snapshot per-deck que peleaba con el reconcile quedó eliminado.
    assert.doesNotMatch(renderJs, /rustPlaylistPreDuckingGains/);
});

test('duck volume/fade are captured at apply time so the prefs restore never races the duck', () => {
    assert.match(renderJs, /activeDuckParams = \{ vol: duckVol, fadeSecs \}/);
    assert.match(renderJs, /function removeRustPlaylistDucking[\s\S]*?activeDuckParams\?\.fadeSecs/);
});

test('temporary duck diagnostics were removed after confirming the root cause', () => {
    assert.doesNotMatch(renderJs, /DUCK-DIAG/);
});
