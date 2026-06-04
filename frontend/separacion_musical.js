'use strict';

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('../backend/utils/app_paths');
const { normalizeAudioPrefs } = require('./audio_prefs');
const musicSeparation = require('./music_separation_rules');

const configDir = getConfigDir(path.join(__dirname, '..', 'config'), __dirname);
const generalPrefsPath = path.join(configDir, 'general_settings.json');
const readJson = (filePath, fallback) => { try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (err) { return fallback; } };
const byId = id => document.getElementById(id);

// Estado en memoria de las reglas por carpeta, indexado por clave normalizada.
// Cada entrada conserva `path` (la ruta original, para mostrar) ademas de los
// posibles overrides songHours / artistEnabled / artistHours.
let folderRules = {};
let selectedKey = null;

function clampField(input, min, max) {
    if (input.value === '') return; // vacio = heredar
    let v = parseInt(input.value, 10);
    if (!Number.isFinite(v)) { input.value = ''; return; }
    v = Math.max(min, Math.min(max, v));
    input.value = String(v);
}

function loadGlobal() {
    const prefs = normalizeAudioPrefs(readJson(generalPrefsPath, {}));
    byId('global-song-hours').value = prefs.musicRandomProtectionValue;
    byId('global-artist-enabled').checked = prefs.musicArtistSeparationEnabled === true;
    byId('global-artist-hours').value = prefs.musicArtistSeparationHours;
    byId('global-subfolders').value = prefs.randomIncludeSubfolders;
    syncArtistHoursState();
}

function syncArtistHoursState() {
    byId('global-artist-hours').disabled = !byId('global-artist-enabled').checked;
}

function loadFolderRules() {
    const raw = musicSeparation.readFolderRules();
    folderRules = {};
    Object.keys(raw).forEach(key => {
        const entry = raw[key] || {};
        folderRules[key] = {
            path: entry.path || key,
            songHours: musicSeparation.clampSongHours(entry.songHours),
            artistEnabled: entry.artistEnabled === true ? true : (entry.artistEnabled === false ? false : null),
            artistHours: musicSeparation.clampArtistHours(entry.artistHours)
        };
    });
    renderFolderTable();
}

function renderFolderTable() {
    const body = byId('folder-rules-body');
    body.innerHTML = '';
    const keys = Object.keys(folderRules);
    byId('folder-empty').style.display = keys.length ? 'none' : 'block';
    byId('btn-del-folder').disabled = !selectedKey || !folderRules[selectedKey];

    keys.forEach(key => {
        const entry = folderRules[key];
        const tr = document.createElement('tr');
        if (key === selectedKey) tr.classList.add('selected');
        tr.addEventListener('click', event => {
            if (event.target.tagName === 'INPUT') return; // no robar foco a inputs
            selectedKey = key;
            renderFolderTable();
        });

        const tdPath = document.createElement('td');
        tdPath.className = 'folder-path';
        tdPath.textContent = entry.path;
        tdPath.title = entry.path;

        const tdSong = document.createElement('td');
        const songInput = document.createElement('input');
        songInput.type = 'number';
        songInput.min = String(musicSeparation.SONG_MIN_HOURS);
        songInput.max = String(musicSeparation.SONG_MAX_HOURS);
        songInput.placeholder = 'global';
        if (entry.songHours != null) songInput.value = entry.songHours;
        songInput.addEventListener('change', () => {
            clampField(songInput, musicSeparation.SONG_MIN_HOURS, musicSeparation.SONG_MAX_HOURS);
            entry.songHours = songInput.value === '' ? null : parseInt(songInput.value, 10);
        });
        tdSong.appendChild(songInput);

        const tdArtistOn = document.createElement('td');
        const artistChk = document.createElement('input');
        artistChk.type = 'checkbox';
        // null (heredar) se muestra desmarcado; el usuario marca para forzar on.
        artistChk.checked = entry.artistEnabled === true;
        artistChk.addEventListener('change', () => {
            entry.artistEnabled = artistChk.checked ? true : false;
        });
        tdArtistOn.appendChild(artistChk);

        const tdArtistHours = document.createElement('td');
        const artistInput = document.createElement('input');
        artistInput.type = 'number';
        artistInput.min = String(musicSeparation.ARTIST_MIN_HOURS);
        artistInput.max = String(musicSeparation.ARTIST_MAX_HOURS);
        artistInput.placeholder = 'global';
        if (entry.artistHours != null) artistInput.value = entry.artistHours;
        artistInput.addEventListener('change', () => {
            clampField(artistInput, musicSeparation.ARTIST_MIN_HOURS, musicSeparation.ARTIST_MAX_HOURS);
            entry.artistHours = artistInput.value === '' ? null : parseInt(artistInput.value, 10);
        });
        tdArtistHours.appendChild(artistInput);

        tr.appendChild(tdPath);
        tr.appendChild(tdSong);
        tr.appendChild(tdArtistOn);
        tr.appendChild(tdArtistHours);
        body.appendChild(tr);
    });
}

async function addFolder() {
    const folderPath = await ipcRenderer.invoke('dialog:selectFolder');
    if (!folderPath) return;
    const key = musicSeparation.normalizeFolderKey(folderPath);
    if (!folderRules[key]) {
        folderRules[key] = { path: folderPath, songHours: null, artistEnabled: null, artistHours: null };
    }
    selectedKey = key;
    renderFolderTable();
}

function deleteSelected() {
    if (selectedKey && folderRules[selectedKey]) {
        delete folderRules[selectedKey];
        selectedKey = null;
        renderFolderTable();
    }
}

function save() {
    // ── Global ──
    const songHours = Math.max(1, Math.min(48, parseInt(byId('global-song-hours').value, 10) || 12));
    const artistHours = Math.max(1, Math.min(48, parseInt(byId('global-artist-hours').value, 10) || 1));
    byId('global-song-hours').value = songHours;
    byId('global-artist-hours').value = artistHours;

    const prefs = normalizeAudioPrefs({
        ...readJson(generalPrefsPath, {}),
        musicRandomProtectionValue: songHours,
        musicRandomProtectionUnit: 'hours',
        musicArtistSeparationEnabled: byId('global-artist-enabled').checked,
        musicArtistSeparationHours: artistHours,
        randomIncludeSubfolders: byId('global-subfolders').value
    });
    fs.writeFileSync(generalPrefsPath, JSON.stringify(prefs, null, 2));

    // ── Reglas por carpeta ── (se descartan campos vacios = heredan global)
    const out = {};
    Object.keys(folderRules).forEach(key => {
        const entry = folderRules[key];
        const rule = { path: entry.path };
        const song = musicSeparation.clampSongHours(entry.songHours);
        if (song != null) rule.songHours = song;
        if (entry.artistEnabled === true || entry.artistEnabled === false) rule.artistEnabled = entry.artistEnabled;
        const artist = musicSeparation.clampArtistHours(entry.artistHours);
        if (artist != null) rule.artistHours = artist;
        out[key] = rule;
    });
    musicSeparation.writeFolderRules(out);

    // Sincronizacion bidireccional con Reportes y el renderer principal.
    ipcRenderer.send('settings-updated', {});
    window.close();
}

byId('global-artist-enabled').addEventListener('change', syncArtistHoursState);
byId('global-song-hours').addEventListener('change', () => clampField(byId('global-song-hours'), 1, 48));
byId('global-artist-hours').addEventListener('change', () => clampField(byId('global-artist-hours'), 1, 48));
byId('btn-add-folder').addEventListener('click', addFolder);
byId('btn-del-folder').addEventListener('click', deleteSelected);
byId('btn-save').addEventListener('click', save);
byId('btn-cancel').addEventListener('click', () => window.close());

// Si la config global cambia desde Reportes mientras esta ventana esta abierta,
// reflejamos los valores globales (no pisa ediciones de la tabla por carpeta).
ipcRenderer.on('settings-updated', () => loadGlobal());

loadGlobal();
loadFolderRules();
