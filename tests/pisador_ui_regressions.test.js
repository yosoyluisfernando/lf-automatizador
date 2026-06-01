'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const editorHtml = fs.readFileSync(path.join(root, 'frontend', 'audio_editor.html'), 'utf8');
const editorJs = fs.readFileSync(path.join(root, 'frontend', 'audio_editor.js'), 'utf8');

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
