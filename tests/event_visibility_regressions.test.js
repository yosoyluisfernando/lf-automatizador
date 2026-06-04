'use strict';

// Regresión: un evento recién creado con una hora del día ya pasada NO debe
// marcarse como "emitido hoy" si nunca se disparó. Antes, prePopulateEmittedToday
// marcaba como emitido cualquier evento cuya hora ya hubiera pasado, haciéndolo
// desaparecer de la lista (y de la ejecución). Ahora se exige que ev.lastFired
// coincida con el fireId real de esa ocurrencia.
//
// El test carga las FUNCIONES REALES de frontend/render.js en un sandbox y las
// corre contra eventos sintéticos a una hora fija.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'render.js'), 'utf8');

function matchDelims(s, i, open, close) {
    let depth = 0, str = null, line = false, block = false;
    for (; i < s.length; i++) {
        const c = s[i], n = s[i + 1];
        if (line) { if (c === '\n') line = false; continue; }
        if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
        if (str) { if (c === '\\') { i++; continue; } if (c === str) str = null; continue; }
        if (c === '/' && n === '/') { line = true; i++; continue; }
        if (c === '/' && n === '*') { block = true; i++; continue; }
        if (c === '"' || c === "'" || c === '`') { str = c; continue; }
        if (c === open) depth++; else if (c === close) { depth--; if (depth === 0) return i; }
    }
    throw new Error('sin balancear');
}
function extractFunction(s, name) {
    const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(s);
    assert.ok(m, 'no se encontró ' + name + ' en render.js');
    const p = s.indexOf('(', m.index);
    const pe = matchDelims(s, p, '(', ')');
    const b = s.indexOf('{', pe + 1);
    return s.slice(m.index, matchDelims(s, b, '{', '}') + 1);
}

function buildContext(fixedMs) {
    const fns = ['isDateValidForEvent', 'getExpandedEventTimes', 'getEventFireId', 'prePopulateEmittedToday']
        .map(n => extractFunction(src, n)).join('\n\n');
    const FakeDate = class extends Date {
        constructor(...a) { if (a.length === 0) super(fixedMs); else super(...a); }
        static now() { return fixedMs; }
    };
    const sandbox = {
        eventsMasterDB: [], emittedEventsToday: [],
        console, Date: FakeDate, Set, Array, Math, String, Number, JSON, parseInt, parseFloat
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(fns + '\nglobalThis.__pre = prePopulateEmittedToday;', ctx);
    return sandbox;
}

test('prePopulateEmittedToday solo marca como emitido lo que realmente se disparó hoy', () => {
    const now = new Date(2026, 5, 4, 14, 0, 0); // 4/6/2026 14:00
    const today = now.toDateString();
    const sandbox = buildContext(now.getTime());

    sandbox.eventsMasterDB = [
        // Disparado HOY a las 08:00 → debe quedar en "emitidos".
        { id: 'ev_firedToday', dayMode: 'daily', primaryTime: '08:00:00', otherHours: [],
          lastFired: `ev_firedToday_08:00:00_${today}` },
        // Recién creado, hora ya pasada, NUNCA disparado → debe seguir VISIBLE.
        { id: 'ev_newPast', dayMode: 'once', primaryTime: '12:00:00', otherHours: [], lastFired: null },
        // Disparado en un día ANTERIOR (no hoy) → no es "emitido hoy", debe verse.
        { id: 'ev_firedOldDay', dayMode: 'daily', primaryTime: '09:00:00', otherHours: [],
          lastFired: 'ev_firedOldDay_09:00:00_Mon May 25 2026' },
        // Hora futura hoy → no emitido.
        { id: 'ev_future', dayMode: 'once', primaryTime: '20:00:00', otherHours: [], lastFired: null }
    ];

    sandbox.__pre();
    const emittedIds = new Set(sandbox.emittedEventsToday.map(e => e.ev.id));

    assert.ok(emittedIds.has('ev_firedToday'), 'el evento disparado hoy debe estar en emitidos');
    assert.ok(!emittedIds.has('ev_newPast'), 'el evento nuevo sin disparar NO debe ocultarse (era el bug)');
    assert.ok(!emittedIds.has('ev_firedOldDay'), 'un disparo de otro día no es "emitido hoy"');
    assert.ok(!emittedIds.has('ev_future'), 'un evento futuro no está emitido');
});

test('render.js exige lastFired===getEventFireId antes de marcar un evento como emitido', () => {
    assert.match(
        src,
        /function prePopulateEmittedToday[\s\S]*?ev\.lastFired === getEventFireId\(ev, tStr, d\)/,
        'la guarda de lastFired debe estar presente en prePopulateEmittedToday'
    );
});

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');

test('el menú de filtro expone el toggle "Separar emitidos hoy" bajo "Próximo a emitir"', () => {
    assert.match(indexHtml, /id="ef-sort-next"[\s\S]*?id="ef-show-emitted"/, 'ef-show-emitted debe ir después de ef-sort-next');
    assert.match(src, /id === 'ef-show-emitted'[\s\S]*?eventsShowEmitted = !eventsShowEmitted/, 'el handler debe alternar eventsShowEmitted');
    assert.match(src, /let eventsShowEmitted = generalPrefs\.eventsShowEmitted !== false/, 'pref con default activo');
});

test('separar emitidos solo aplica a vistas de hoy (no en Todos ni en otros días)', () => {
    // La separación se calcula con: toggle activo Y modo distinto de 'all' Y no 'day_'.
    assert.match(
        src,
        /const separateEmitted = eventsShowEmitted\s*&&\s*eventsFilterMode !== 'all'\s*&&\s*!eventsFilterMode\.startsWith\('day_'\)/,
        'separateEmitted debe excluir "all" y los días específicos'
    );
    // El filtro acepta un evento emitido si todavía tiene ocurrencias hoy (eventos repetitivos).
    assert.match(
        src,
        /!separateEmitted \|\| !emittedIds\.has\(ev\.id\) \|\| hasOccurrenceRemainingToday\(ev\)/,
        'un evento que ya sonó pero se repite hoy debe seguir en la lista principal'
    );
    // El apartado "Emitidos hoy" se renderiza solo bajo separateEmitted.
    assert.match(src, /if \(separateEmitted\) \{[\s\S]*?Emitidos hoy/, 'la sección "Emitidos hoy" se gatea con separateEmitted');
});

test('hasOccurrenceRemainingToday existe y usa getNextAbsoluteOccurrence comparando con hoy', () => {
    assert.match(
        src,
        /function hasOccurrenceRemainingToday[\s\S]*?getNextAbsoluteOccurrence\(ev, false\)[\s\S]*?toDateString\(\)/,
        'debe comparar la próxima ocurrencia con la fecha de hoy'
    );
});
