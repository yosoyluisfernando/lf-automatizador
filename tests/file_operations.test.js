'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { buildRenamedAudioPath, renameFilePreservingExtension } = require('../backend/file_operations');

test('audio rename preserves the original extension and rejects embedded paths', () => {
    assert.strictEqual(
        buildRenamedAudioPath('C:\\Music\\Original.mp3', 'Nuevo nombre', path.win32),
        'C:\\Music\\Nuevo nombre.mp3'
    );
    assert.throws(() => buildRenamedAudioPath('/music/original.flac', '../escape', path.posix), /nombre/i);
    assert.throws(() => buildRenamedAudioPath('/music/original.flac', 'otra/carpeta', path.posix), /nombre/i);
});

test('audio rename moves the file without overwriting an existing destination', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-rename-'));
    const oldPath = path.join(tempDir, 'old.mp3');
    const occupiedPath = path.join(tempDir, 'occupied.mp3');
    fs.writeFileSync(oldPath, 'audio');
    fs.writeFileSync(occupiedPath, 'occupied');

    assert.throws(() => renameFilePreservingExtension(fs, path, oldPath, 'occupied'), /existe/i);
    const renamedPath = renameFilePreservingExtension(fs, path, oldPath, 'new');

    assert.strictEqual(renamedPath, path.join(tempDir, 'new.mp3'));
    assert.strictEqual(fs.existsSync(oldPath), false);
    assert.strictEqual(fs.readFileSync(renamedPath, 'utf8'), 'audio');
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('playlist exposes physical-file editing and native reveal controls', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
    const render = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'render.js'), 'utf8');
    const editorHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'audio_editor.html'), 'utf8');
    const editorJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'audio_editor.js'), 'utf8');
    const reportsJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'reportes.js'), 'utf8');
    const uiIpc = fs.readFileSync(path.join(__dirname, '..', 'backend', 'ipc', 'ui.js'), 'utf8');

    assert.match(html, /id="pm-edit-name">Editar archivo y metadatos/);
    assert.match(html, /id="pm-show-folder">Mostrar en carpeta/);
    assert.match(render, /function getPhysicalTrackPathForRow\(/);
    assert.match(render, /ipcRenderer\.invoke\('file:show-in-folder'/);
    assert.match(editorHtml, /id="meta-filename"/);
    assert.match(editorJs, /lib-rename-track-file/);
    assert.match(uiIpc, /shell\.showItemInFolder/);
    assert.match(reportsJs, /file:show-in-folder/);
    assert.match(reportsJs, /Mostrar en carpeta/);
});

test('playlist metadata action opens a compact editor separate from the advanced track editor', () => {
    const render = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'render.js'), 'utf8');
    const uiIpc = fs.readFileSync(path.join(__dirname, '..', 'backend', 'ipc', 'ui.js'), 'utf8');
    const compactHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'file_metadata_editor.html'), 'utf8');
    const compactJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'file_metadata_editor.js'), 'utf8');

    assert.match(render, /pm-edit-name[\s\S]*open-file-metadata-editor/);
    assert.match(uiIpc, /open-file-metadata-editor/);
    assert.match(compactHtml, /Editar archivo y metadatos/);
    assert.doesNotMatch(compactHtml, /meta-remix/);
    assert.match(compactJs, /open-audio-editor/);
    assert.match(compactJs, /lib-rename-track-file/);
    assert.match(compactJs, /lib-save-db-track/);
});
