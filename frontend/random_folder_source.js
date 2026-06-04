'use strict';

// Fuente de archivos para carpetas aleatorias. Encapsula la lectura (plana o
// recursiva) y el cacheo, para no inflar render.js.
//
// Decisiones clave:
//  - Las listas guardan RUTAS RELATIVAS a la carpeta raiz (no basenames). En
//    modo recursivo dos subcarpetas pueden tener archivos con el mismo nombre;
//    la ruta relativa evita colisiones y permite reconstruir la ruta absoluta
//    con resolveAbsolute(). En modo plano, la ruta relativa coincide con el
//    basename, asi que es compatible con el comportamiento anterior.
//  - El cache se indexa por CLAVE COMPUESTA carpeta+recursivo: una misma carpeta
//    usada en dos filas (una recursiva y otra no) no se pisa entre si.

const fs = require('fs');
const path = require('path');

const SUPPORTED_AUDIO_RE = /\.(mp3|wav|flac|ogg|m4a|aac)$/i;
const CACHE_TTL_MS = 60000;
const MAX_FILES = 100000;

const cache = new Map(); // key -> { files: string[]|null, loadedAt: number, promise: Promise|null }

function isSupportedAudioName(name) {
    return SUPPORTED_AUDIO_RE.test(name || '');
}

function cacheKey(folderPath, recursive) {
    return `${recursive ? 'R' : 'F'}|${folderPath}`;
}

function sortRelative(a, b) {
    return a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });
}

function getCached(folderPath, recursive) {
    const entry = cache.get(cacheKey(folderPath, recursive));
    if (!entry || !Array.isArray(entry.files)) return null;
    if ((Date.now() - entry.loadedAt) > CACHE_TTL_MS) return null;
    return entry.files;
}

async function readRelativeAsync(rootPath, recursive) {
    const out = [];
    const stack = [''];
    while (stack.length > 0 && out.length < MAX_FILES) {
        const rel = stack.pop();
        const abs = rel ? path.join(rootPath, rel) : rootPath;
        let entries;
        try { entries = await fs.promises.readdir(abs, { withFileTypes: true }); } catch (err) { continue; }
        for (const entry of entries) {
            const childRel = rel ? path.join(rel, entry.name) : entry.name;
            if (entry.isDirectory()) {
                if (recursive) stack.push(childRel);
            } else if (entry.isFile() && isSupportedAudioName(entry.name)) {
                out.push(childRel);
                if (out.length >= MAX_FILES) break;
            }
        }
    }
    return out.sort(sortRelative);
}

function readRelativeSync(rootPath, recursive) {
    const out = [];
    const stack = [''];
    while (stack.length > 0 && out.length < MAX_FILES) {
        const rel = stack.pop();
        const abs = rel ? path.join(rootPath, rel) : rootPath;
        let entries;
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (err) { continue; }
        for (const entry of entries) {
            const childRel = rel ? path.join(rel, entry.name) : entry.name;
            if (entry.isDirectory()) {
                if (recursive) stack.push(childRel);
            } else if (entry.isFile() && isSupportedAudioName(entry.name)) {
                out.push(childRel);
                if (out.length >= MAX_FILES) break;
            }
        }
    }
    return out.sort(sortRelative);
}

// Calienta el cache de forma asincrona. Devuelve rutas relativas.
async function warmRandomFolder(folderPath, recursive = false) {
    if (!folderPath) return [];
    const cached = getCached(folderPath, recursive);
    if (cached) return cached;
    const key = cacheKey(folderPath, recursive);
    const existing = cache.get(key);
    if (existing && existing.promise) return existing.promise;
    const promise = readRelativeAsync(folderPath, recursive)
        .then(files => {
            cache.set(key, { files, loadedAt: Date.now(), promise: null });
            return files;
        })
        .catch(() => {
            cache.delete(key);
            return [];
        });
    cache.set(key, { files: null, loadedAt: 0, promise });
    return promise;
}

// Lectura sincrona inmediata (usa cache si esta caliente). Devuelve rutas relativas.
function getRandomFolderFilesFast(folderPath, recursive = false) {
    if (!folderPath) return [];
    const cached = getCached(folderPath, recursive);
    if (cached) return cached;
    try {
        const files = readRelativeSync(folderPath, recursive);
        cache.set(cacheKey(folderPath, recursive), { files, loadedAt: Date.now(), promise: null });
        return files;
    } catch (err) {
        return [];
    }
}

function resolveAbsolute(folderPath, relativePath) {
    return path.join(folderPath, relativePath);
}

function invalidate(folderPath) {
    cache.delete(cacheKey(folderPath, true));
    cache.delete(cacheKey(folderPath, false));
}

module.exports = {
    isSupportedAudioName,
    warmRandomFolder,
    getRandomFolderFilesFast,
    resolveAbsolute,
    invalidate,
    cacheKey,
    CACHE_TTL_MS,
    MAX_FILES
};
