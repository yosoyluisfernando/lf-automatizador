'use strict';

// Fuente unica de los "Tipos de Archivo" (file_types.json). La comparten
// settings.js (pestana Excepciones Mezclar), render.js (color/categoria en la
// playlist) y la ventana del Gestor de Tipos de Archivos, para que todos hablen
// el mismo idioma. Antes este bloque estaba duplicado en settings.js y render.js.

// Perfil de fades/mezcla por defecto que hereda cada tipo nuevo.
const defaultFadeProfile = {
    fadeinActive: false,
    fadein: 0,
    mixActive: true,
    mix: 0.6,
    mixDbActive: true,
    mixDb: -14,
    fadeoutStopActive: true,
    fadeoutStop: 2,
    fadeoutNextActive: true,
    fadeoutNext: 0.6,
    mixFadeoutActive: false
};

// Tipos por defecto (readonly: no se pueden borrar). 'amp' y 'voice' se
// conservan porque siguen cableados en reproduccion: 'amp' aplica ganancia en dB
// (getCrossfadeConfig) y 'voice' marca el tipo como locucion (categoria de
// historial). El Gestor no los expone en su interfaz, pero el dato persiste.
const defaultFileTypes = [
    { id: 't_comercial', name: 'Comercial', color: '#ff0000', identifier: 'comercial', searchIn: 'all', amp: 0, report: true, history: false, voice: false, readonly: true, showShortcut: true, ...defaultFadeProfile },
    { id: 't_time', name: 'Locuciones', color: '#2ecc71', identifier: 'locucion', aliases: ['saytime', 'time_locution', 'temperature_locution', 'humidity_locution'], searchIn: 'all', amp: 0, report: true, history: false, voice: true, readonly: true, ...defaultFadeProfile },
    { id: 't_station_id', name: 'Station ID', color: '#3498db', identifier: 'id', searchIn: 'all', amp: 0, report: true, history: false, voice: false, readonly: true, showShortcut: true, ...defaultFadeProfile },
    { id: 't_pisador', name: 'Pisadores', color: '#b56ad9', identifier: 'pisador', searchIn: 'all', amp: 0, report: true, history: false, voice: false, readonly: true, showShortcut: true, ...defaultFadeProfile }
];

// Mezcla los tipos guardados en disco con los defaults: los readonly siempre
// recuperan su nombre/identificador/aliases oficiales; los tipos del usuario se
// anaden tal cual (preservando sus campos). Logica identica a la que vivia
// duplicada en settings.js y render.js.
function normalizeFileTypes(types) {
    const loadedTypes = Array.isArray(types) ? types : [];
    const byId = new Map(loadedTypes.map(typeData => [typeData.id, typeData]));
    const builtInIds = new Set(defaultFileTypes.map(typeData => typeData.id));
    const normalized = defaultFileTypes.map(defaultType => {
        const stored = byId.get(defaultType.id) || {};
        const migrated = {
            ...defaultType,
            ...stored,
            name: defaultType.name,
            identifier: defaultType.identifier,
            aliases: defaultType.aliases || [],
            readonly: true,
            mixFadeoutActive: stored.mixFadeoutActive === true
        };
        delete migrated.mixFadeout;
        return migrated;
    });
    loadedTypes.forEach(typeData => {
        if (!typeData?.id || builtInIds.has(typeData.id)) return;
        const migrated = { ...typeData, mixFadeoutActive: typeData.mixFadeoutActive === true };
        delete migrated.mixFadeout;
        normalized.push(migrated);
    });
    return normalized;
}

module.exports = { defaultFadeProfile, defaultFileTypes, normalizeFileTypes };
