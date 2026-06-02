'use strict';

const path = require('path');
const { ipcRenderer } = require('electron');

let currentFilePath = '';
let currentTrack = {};
const byId = id => document.getElementById(id);

ipcRenderer.on('load-file-metadata', async (event, filePath) => {
    currentFilePath = String(filePath || '');
    const parsed = path.parse(currentFilePath);
    byId('file-name').value = parsed.name;
    byId('file-extension').textContent = parsed.ext;
    currentTrack = await ipcRenderer.invoke('lib-get-db-track', currentFilePath) || {};
    byId('meta-title').value = currentTrack.customTitle || '';
    byId('meta-artist').value = currentTrack.customArtist || '';
    byId('meta-album').value = currentTrack.album || '';
    byId('meta-genre').value = currentTrack.genre || '';
    byId('meta-year').value = currentTrack.year || '';
});

async function save() {
    const requestedName = byId('file-name').value.trim();
    if (!requestedName) throw new Error('El nombre del archivo no puede quedar vacio.');
    if (requestedName !== path.parse(currentFilePath).name) {
        const renamed = await ipcRenderer.invoke('lib-rename-track-file', { filePath: currentFilePath, baseName: requestedName });
        if (!renamed?.success) throw new Error(renamed?.error || 'No se pudo renombrar el archivo.');
        currentFilePath = renamed.filePath;
    }
    const result = await ipcRenderer.invoke('lib-save-db-track', {
        ...currentTrack,
        filePath: currentFilePath,
        customTitle: byId('meta-title').value,
        customArtist: byId('meta-artist').value,
        album: byId('meta-album').value,
        genre: byId('meta-genre').value,
        year: byId('meta-year').value
    });
    if (!result?.success) throw new Error(result?.error || 'No se pudieron guardar los metadatos.');
    ipcRenderer.send('refresh-manual-cues');
}

byId('btn-save').addEventListener('click', async () => {
    try { await save(); window.close(); }
    catch (err) { byId('status').textContent = err.message || String(err); }
});
byId('btn-cancel').addEventListener('click', () => window.close());
byId('btn-advanced').addEventListener('click', () => {
    ipcRenderer.send('open-audio-editor', currentFilePath);
    window.close();
});
