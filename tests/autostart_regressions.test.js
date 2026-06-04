'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { applyAutoLaunch, getAutoLaunch, buildSettings } = require('../backend/services/auto_launch');
const { runAutoPlayOnStart, __resetAutoPlayGuardForTests } = require('../frontend/autostart_runtime');

// ── auto_launch ──────────────────────────────────────────────────────────────

test('applyAutoLaunch no toca el sistema en modo desarrollo', () => {
    let called = false;
    const app = { isPackaged: false, setLoginItemSettings: () => { called = true; } };
    const res = applyAutoLaunch(app, true);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'dev');
    assert.strictEqual(called, false);
});

test('applyAutoLaunch registra el inicio en builds empaquetados', () => {
    let received = null;
    const app = { isPackaged: true, setLoginItemSettings: (s) => { received = s; } };
    const res = applyAutoLaunch(app, true);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.enabled, true);
    assert.ok(received);
    assert.strictEqual(received.openAtLogin, true);
    assert.strictEqual(received.name, 'LF Automatizador');
});

test('applyAutoLaunch puede desactivar el inicio', () => {
    let received = null;
    const app = { isPackaged: true, setLoginItemSettings: (s) => { received = s; } };
    applyAutoLaunch(app, false);
    assert.strictEqual(received.openAtLogin, false);
});

test('getAutoLaunch devuelve false en desarrollo sin consultar al SO', () => {
    const app = { isPackaged: false, getLoginItemSettings: () => { throw new Error('no debe llamarse'); } };
    assert.strictEqual(getAutoLaunch(app), false);
});

test('getAutoLaunch refleja el estado real del SO en empaquetado', () => {
    const app = { isPackaged: true, getLoginItemSettings: () => ({ openAtLogin: true }) };
    assert.strictEqual(getAutoLaunch(app), true);
});

test('buildSettings añade la ruta del AppImage solo en Linux con APPIMAGE', () => {
    const prevPlatform = process.platform;
    const prevAppImage = process.env.APPIMAGE;
    try {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        process.env.APPIMAGE = '/tmp/LF.AppImage';
        const s = buildSettings(true);
        assert.strictEqual(s.path, '/tmp/LF.AppImage');
        assert.deepStrictEqual(s.args, []);
    } finally {
        Object.defineProperty(process, 'platform', { value: prevPlatform, configurable: true });
        if (prevAppImage === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = prevAppImage;
    }
});

// ── runAutoPlayOnStart ───────────────────────────────────────────────────────

function makeDeps(overrides = {}) {
    const calls = { resume: 0, ipc: [] };
    return {
        calls,
        opts: {
            generalPrefs: { autoPlayOnStart: true, startEncoderOnAutoPlay: false },
            hasPlayableRows: () => true,
            resumeCurrentPlayback: () => { calls.resume++; },
            ipcRenderer: { send: (ch) => { calls.ipc.push(ch); } },
            logSystem: () => {},
            ...overrides,
        },
    };
}

test('runAutoPlayOnStart no reproduce si la opción está desactivada', () => {
    __resetAutoPlayGuardForTests();
    const { calls, opts } = makeDeps({ generalPrefs: { autoPlayOnStart: false } });
    runAutoPlayOnStart(opts);
    assert.strictEqual(calls.resume, 0);
});

test('runAutoPlayOnStart reproduce cuando está activado y hay pistas', () => {
    __resetAutoPlayGuardForTests();
    const { calls, opts } = makeDeps();
    runAutoPlayOnStart(opts);
    assert.strictEqual(calls.resume, 1);
    assert.deepStrictEqual(calls.ipc, []);
});

test('runAutoPlayOnStart omite la reproducción con playlist vacía', () => {
    __resetAutoPlayGuardForTests();
    const { calls, opts } = makeDeps({ hasPlayableRows: () => false });
    runAutoPlayOnStart(opts);
    assert.strictEqual(calls.resume, 0);
});

test('runAutoPlayOnStart pide arrancar el encoder cuando corresponde', () => {
    __resetAutoPlayGuardForTests();
    const { calls, opts } = makeDeps({ generalPrefs: { autoPlayOnStart: true, startEncoderOnAutoPlay: true } });
    runAutoPlayOnStart(opts);
    assert.strictEqual(calls.resume, 1);
    assert.deepStrictEqual(calls.ipc, ['autoplay-start-encoders']);
});

test('runAutoPlayOnStart solo actúa una vez por arranque', () => {
    __resetAutoPlayGuardForTests();
    const { calls, opts } = makeDeps();
    runAutoPlayOnStart(opts);
    runAutoPlayOnStart(opts);
    assert.strictEqual(calls.resume, 1);
});
