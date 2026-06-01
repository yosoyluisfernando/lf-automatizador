'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
    loadEncoderPrefs,
    saveEncoderPrefs,
} = require('../backend/encoder/prefs');

function makeSafeStorage(backend = 'dpapi') {
    return {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => backend,
        encryptString: text => Buffer.from(`sealed:${text}`, 'utf8'),
        decryptString: buffer => buffer.toString('utf8').replace(/^sealed:/, ''),
    };
}

test('encoder prefs persist server passwords encrypted and restore them for runtime use', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-encoder-prefs-'));
    const filePath = path.join(dir, 'encoder_prefs.json');
    const saved = saveEncoderPrefs({
        filePath,
        safeStorage: makeSafeStorage(),
        prefs: { servers: [{ id: '7', ip: 'radio.test', pass: 'hunter2' }] },
    });

    assert.strictEqual(saved.success, true);
    const onDisk = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(onDisk, /hunter2/);
    assert.match(onDisk, /passEncrypted/);

    const loaded = loadEncoderPrefs({ filePath, safeStorage: makeSafeStorage() });
    assert.strictEqual(loaded.prefs.servers[0].pass, 'hunter2');
});

test('encoder prefs migrate old plaintext passwords without keeping plaintext on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-encoder-migrate-'));
    const filePath = path.join(dir, 'encoder_prefs.json');
    fs.writeFileSync(filePath, JSON.stringify({
        servers: [{ id: '1', ip: 'legacy.test', password: 'old-secret' }],
    }), 'utf8');

    const loaded = loadEncoderPrefs({ filePath, safeStorage: makeSafeStorage() });

    assert.strictEqual(loaded.prefs.servers[0].pass, 'old-secret');
    assert.strictEqual(loaded.migrated, true);
    const onDisk = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(onDisk, /old-secret/);
    assert.match(onDisk, /passEncrypted/);
});

test('encoder prefs never write plaintext passwords when OS secure storage is unavailable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-encoder-no-secure-store-'));
    const filePath = path.join(dir, 'encoder_prefs.json');
    const saved = saveEncoderPrefs({
        filePath,
        safeStorage: { isEncryptionAvailable: () => false },
        prefs: { servers: [{ id: '1', pass: 'session-only' }] },
    });

    assert.strictEqual(saved.success, true);
    assert.match(saved.warning, /no se guardaron/i);
    assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /session-only/);
});

test('encoder prefs reject Linux basic_text backend for password persistence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-encoder-basic-text-'));
    const filePath = path.join(dir, 'encoder_prefs.json');
    saveEncoderPrefs({
        filePath,
        safeStorage: makeSafeStorage('basic_text'),
        prefs: { servers: [{ id: '1', pass: 'must-not-persist' }] },
    });

    assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /must-not-persist|passEncrypted/);
});

test('failed plaintext migration scrubs the old password instead of leaving it on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-encoder-failed-migrate-'));
    const filePath = path.join(dir, 'encoder_prefs.json');
    fs.writeFileSync(filePath, JSON.stringify({
        servers: [{ id: '1', password: 'must-be-scrubbed' }],
    }), 'utf8');
    const safeStorage = makeSafeStorage();
    safeStorage.encryptString = () => { throw new Error('simulated secure storage failure'); };

    const loaded = loadEncoderPrefs({ filePath, safeStorage });

    assert.strictEqual(loaded.prefs.servers[0].pass, 'must-be-scrubbed');
    assert.match(loaded.warning, /no se pudo|no se guardaron/i);
    assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /must-be-scrubbed/);
});
