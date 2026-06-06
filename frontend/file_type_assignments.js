'use strict';

// Opciones por ruta para los Tipos de Archivo (carpetas/archivos que el usuario
// asocia a un tipo). El "que tipo" sigue viviendo en explicit_types.json (mapa
// ruta -> typeId, formato intacto que leen render.js, main.js y library_worker).
// Aqui solo guardamos el "como se comporta" cada ruta, en un archivo paralelo:
//
//   config/file_type_options.json
//   {
//     "C:\\Radio\\Comerciales": { "kind": "folder", "includeSubfolders": true, "ignoreSeparation": true, "saveToHistory": true },
//     "C:\\Radio\\id.mp3":       { "kind": "file",   "ignoreSeparation": true, "saveToHistory": false }
//   }
//
// La comparten render.js (color/separacion/historial) y la ventana del Gestor.

const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('../backend/utils/app_paths');

const configDir = getConfigDir(path.join(__dirname, '..', 'config'), __dirname);
const optionsPath = path.join(configDir, 'file_type_options.json');

// Valores recomendados que vienen marcados por defecto en el modal de preguntas.
function defaultOptions(kind = 'folder') {
    return {
        kind: kind === 'file' ? 'file' : 'folder',
        includeSubfolders: kind !== 'file',
        ignoreSeparation: true,
        saveToHistory: true
    };
}

function normalizeOptions(raw = {}, kind) {
    const resolvedKind = raw.kind === 'file' || kind === 'file' ? 'file' : 'folder';
    return {
        kind: resolvedKind,
        // Solo las carpetas pueden incluir subcarpetas; en archivos siempre false.
        includeSubfolders: resolvedKind === 'folder' && raw.includeSubfolders === true,
        ignoreSeparation: raw.ignoreSeparation !== false,
        saveToHistory: raw.saveToHistory !== false
    };
}

function readOptions() {
    try {
        const parsed = JSON.parse(fs.readFileSync(optionsPath, 'utf-8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
        return {};
    }
}

function writeOptions(map) {
    const safe = map && typeof map === 'object' ? map : {};
    try { fs.writeFileSync(optionsPath, JSON.stringify(safe, null, 2)); } catch (err) {}
    return safe;
}

// Lectura puntual de una ruta (sin herencia). Devuelve null si no hay registro.
function getOptions(routePath, map = null) {
    if (!routePath) return null;
    const source = map || readOptions();
    const raw = source[routePath];
    return raw ? normalizeOptions(raw, raw.kind) : null;
}

function setOptions(routePath, opts = {}, map = null) {
    if (!routePath) return map || readOptions();
    const source = map || readOptions();
    source[routePath] = normalizeOptions(opts, opts.kind);
    if (!map) writeOptions(source);
    return source;
}

function removeOptions(routePath, map = null) {
    const source = map || readOptions();
    if (routePath && source[routePath]) {
        delete source[routePath];
        if (!map) writeOptions(source);
    }
    return source;
}

// ¿La carpeta asignada propaga su tipo a las subcarpetas anidadas? Por defecto
// false, para conservar el comportamiento previo de las asignaciones antiguas
// (que solo coloreaban los hijos directos). Las nuevas, hechas desde el modal,
// guardan includeSubfolders: true explicitamente.
function includesSubfolders(routePath, map = null) {
    return getOptions(routePath, map)?.includeSubfolders === true;
}

function ignoresSeparation(routePath, map = null) {
    return getOptions(routePath, map)?.ignoreSeparation === true;
}

// Devuelve true/false si hay registro explicito; null si la ruta no tiene
// opciones (para que el llamador caiga en el comportamiento por tipo).
function savesToHistory(routePath, map = null) {
    const opts = getOptions(routePath, map);
    return opts ? opts.saveToHistory === true : null;
}

module.exports = {
    optionsPath,
    defaultOptions,
    normalizeOptions,
    readOptions,
    writeOptions,
    getOptions,
    setOptions,
    removeOptions,
    includesSubfolders,
    ignoresSeparation,
    savesToHistory
};
