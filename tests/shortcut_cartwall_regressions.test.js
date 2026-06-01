'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');
const cartwallIpcSource = fs.readFileSync(path.join(rootDir, 'backend', 'ipc', 'cartwall.js'), 'utf8');
const renderSource = fs.readFileSync(path.join(rootDir, 'frontend', 'render.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(rootDir, 'frontend', 'settings.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(rootDir, 'frontend', 'index.html'), 'utf8');
const shortcutManager = require('../frontend/shortcut_manager');

test('shortcut scope is user-selectable and defaults to contextual safe mode', () => {
    assert.match(settingsHtml, /id="sel-keyboard-shortcut-scope"/);
    assert.match(settingsHtml, /value="contextual"/);
    assert.match(settingsHtml, /Contextual seguro/);
    assert.match(settingsHtml, /value="main-window"/);
    assert.match(settingsHtml, /value="application"/);
    assert.match(renderSource, /keyboardShortcutScope:\s*'contextual'/);
});

test('native menu labels do not register application accelerators directly', () => {
    assert.match(mainSource, /registerAccelerator:\s*false/);
    assert.doesNotMatch(mainSource, /if\s*\(uiPrefs\.cartwall\)\s*\{\s*uiPrefs\.cartwall\s*=\s*false/);
});

test('docked cartwall has a hide button and fallback only runs while panel is visible', () => {
    assert.match(indexHtml, /id="btn-hide-cartwall"/);
    assert.match(renderSource, /if\s*\(!isDockedCartwallVisible\(\)\)\s*return false/);
});

test('cartwall backend persists the last visible docked or floating mode', () => {
    assert.match(cartwallIpcSource, /cartwallLastMode/);
    assert.match(cartwallIpcSource, /\['docked',\s*'floating'\]\.includes\(mode\)/);
    assert.match(cartwallIpcSource, /mode:\s*context\.uiPrefs\.cartwall\s*\?\s*'docked'\s*:\s*'hidden'/);
});

test('legacy visible docked preference migrates to the docked last mode', () => {
    assert.match(mainSource, /if\s*\(uiPrefs\.cartwall\)\s*uiPrefs\.cartwallLastMode\s*=\s*'docked'/);
});

test('View menu remains checked while the floating cartwall window is open', () => {
    assert.match(mainSource, /checked:\s*!!cartwallWindow\s*\|\|\s*uiPrefs\.cartwall/);
});

test('application-wide shortcuts use the guarded webContents router', () => {
    assert.match(mainSource, /shortcut-editable-focus/);
    assert.match(mainSource, /shortcut-scope-updated/);
    assert.match(mainSource, /before-input-event/);
    assert.match(mainSource, /dispatch-configured-shortcut/);
});

test('editable shortcut targets include standard fields and contenteditable elements', () => {
    assert.strictEqual(shortcutManager.isEditableShortcutTarget({ tagName: 'INPUT' }), true);
    assert.strictEqual(shortcutManager.isEditableShortcutTarget({ tagName: 'TEXTAREA' }), true);
    assert.strictEqual(shortcutManager.isEditableShortcutTarget({ tagName: 'SELECT' }), true);
    assert.strictEqual(shortcutManager.isEditableShortcutTarget({ tagName: 'DIV', isContentEditable: true }), true);
    assert.strictEqual(shortcutManager.isEditableShortcutTarget({ tagName: 'BUTTON' }), false);
});
