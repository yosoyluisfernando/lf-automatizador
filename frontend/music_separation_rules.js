'use strict';

// Logica compartida de "Reglas de Separacion Musical" (sin DOM). La usan tanto
// la ventana de Reglas como render.js y reportes.js para hablar el mismo idioma:
//  - Configuracion global (separacion de cancion / artista) vive en general_settings.json.
//  - Reglas por carpeta (prioridad sobre la global) viven en music_separation_folders.json.

const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('../backend/utils/app_paths');
const { normalizeAudioPrefs } = require('./audio_prefs');

const configDir = getConfigDir(path.join(__dirname, '..', 'config'), __dirname);
const folderRulesPath = path.join(configDir, 'music_separation_folders.json');

const SONG_MIN_HOURS = 1;
const SONG_MAX_HOURS = 48;
const ARTIST_MIN_HOURS = 1;
const ARTIST_MAX_HOURS = 48;

function clampHours(value, min, max) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(min, Math.min(max, parsed));
}

function clampSongHours(value) { return clampHours(value, SONG_MIN_HOURS, SONG_MAX_HOURS); }
function clampArtistHours(value) { return clampHours(value, ARTIST_MIN_HOURS, ARTIST_MAX_HOURS); }

// Comparacion de artistas: minusculas, sin acentos, sin espacios redundantes.
function normalizeArtist(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

// Clave de carpeta estable entre sesiones y plataformas. En Windows el sistema
// de archivos no distingue mayusculas, asi que normalizamos a minusculas alli.
function normalizeFolderKey(folderPath) {
    if (!folderPath) return '';
    let resolved;
    try { resolved = path.resolve(String(folderPath)); } catch (err) { resolved = String(folderPath); }
    resolved = resolved.replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readFolderRules() {
    try {
        const parsed = JSON.parse(fs.readFileSync(folderRulesPath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
        return {};
    }
}

function writeFolderRules(rules) {
    const safe = rules && typeof rules === 'object' ? rules : {};
    fs.writeFileSync(folderRulesPath, JSON.stringify(safe, null, 2));
    return safe;
}

// Una entrada de carpeta puede sobreescribir cada campo o dejarlo en null/undefined
// para heredar del global.
function normalizeFolderRule(rule = {}) {
    const out = {};
    const song = clampSongHours(rule.songHours);
    if (song != null) out.songHours = song;
    if (rule.artistEnabled === true || rule.artistEnabled === false) out.artistEnabled = rule.artistEnabled;
    const artist = clampArtistHours(rule.artistHours);
    if (artist != null) out.artistHours = artist;
    return out;
}

// Configuracion global derivada de las prefs ya normalizadas.
function getGlobalRules(prefs) {
    const p = normalizeAudioPrefs(prefs || {});
    return {
        songHours: clampSongHours(p.musicRandomProtectionValue) ?? 12,
        artistEnabled: p.musicArtistSeparationEnabled === true,
        artistHours: clampArtistHours(p.musicArtistSeparationHours) ?? 1,
        includeSubfolders: p.randomIncludeSubfolders
    };
}

// Regla efectiva para una carpeta: lo especifico pisa lo global.
function getEffectiveRules(folderPath, prefs, folderRules = null) {
    const global = getGlobalRules(prefs);
    const rules = folderRules || readFolderRules();
    const entry = normalizeFolderRule(rules[normalizeFolderKey(folderPath)] || {});
    return {
        songHours: entry.songHours != null ? entry.songHours : global.songHours,
        artistEnabled: entry.artistEnabled != null ? entry.artistEnabled : global.artistEnabled,
        artistHours: entry.artistHours != null ? entry.artistHours : global.artistHours,
        source: {
            song: entry.songHours != null ? 'folder' : 'global',
            artist: (entry.artistEnabled != null || entry.artistHours != null) ? 'folder' : 'global'
        }
    };
}

module.exports = {
    folderRulesPath,
    SONG_MIN_HOURS, SONG_MAX_HOURS, ARTIST_MIN_HOURS, ARTIST_MAX_HOURS,
    clampSongHours, clampArtistHours,
    normalizeArtist, normalizeFolderKey,
    readFolderRules, writeFolderRules, normalizeFolderRule,
    getGlobalRules, getEffectiveRules
};
