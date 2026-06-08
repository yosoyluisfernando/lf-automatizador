'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');
const windowsSource = fs.readFileSync(path.join(rootDir, 'backend', 'ipc', 'windows.js'), 'utf8');
const encoderUiSource = fs.readFileSync(path.join(rootDir, 'frontend', 'encoder.js'), 'utf8');
const esLocale = JSON.parse(fs.readFileSync(path.join(rootDir, 'locales', 'es.json'), 'utf8'));

const {
    redactSensitiveText,
    rotateLogIfNeeded,
    scrubLogFile,
} = require('../backend/utils/log_security');
const {
    classifyEncoderError,
    validateEncoderConfig,
} = require('../backend/encoder/config');

test('redactSensitiveText removes credentials from URLs, headers, query strings and JSON-like fields', () => {
    const input = [
        'icecast://source:hunter2@example.test:8000/live',
        'Authorization: Basic c291cmNlOmh1bnRlcjI=',
        'https://example.test/admin.cgi?pass=hunter2&mode=updinfo',
        'password=hunter2 token=abc123 clientSecret: "private"',
        '{"password":"json-secret","token":"json-token"}',
        '{\\"password\\":\\"escaped-json-secret\\"}',
    ].join('\n');
    const output = redactSensitiveText(input);

    assert.doesNotMatch(output, /hunter2|c291cmNlOmh1bnRlcjI=|abc123|private|json-secret|json-token|escaped-json-secret/);
    assert.match(output, /\[REDACTED\]/);
    assert.match(output, /icecast:\/\/source:\[REDACTED\]@example\.test/);
});

test('rotateLogIfNeeded keeps a bounded tail when a log grows beyond its limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-log-'));
    const file = path.join(dir, 'encoder.log');
    fs.writeFileSync(file, `${'old-line\n'.repeat(100)}keep-me\n`, 'utf8');

    rotateLogIfNeeded(file, { maxBytes: 200, keepBytes: 80 });

    const output = fs.readFileSync(file, 'utf8');
    assert.match(output, /LOG ROTATED/);
    assert.match(output, /keep-me/);
    assert.ok(Buffer.byteLength(output, 'utf8') < 220);
});

test('scrubLogFile removes secrets already persisted by older builds', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-log-scrub-'));
    const file = path.join(dir, 'encoder.log');
    fs.writeFileSync(file, 'icecast://source:old-secret@example.test:8000/live\n', 'utf8');

    assert.strictEqual(scrubLogFile(file), true);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /old-secret/);
});

test('validateEncoderConfig requires an Icecast mount and normalizes it', () => {
    const missing = validateEncoderConfig({
        serverType: 'icecast', ip: 'radio.test', port: '8000', password: 'secret', codec: 'mp3',
    });
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.category, 'config');

    const valid = validateEncoderConfig({
        serverType: 'icecast', ip: 'radio.test', port: '8000', password: 'secret', mount: 'live', codec: 'mp3',
    });
    assert.strictEqual(valid.ok, true);
    assert.strictEqual(valid.config.mount, '/live');
});

test('validateEncoderConfig requires a positive numeric SID for native SHOUTcast 2', () => {
    const invalid = validateEncoderConfig({
        serverType: 'shoutcast2', ip: 'radio.test', port: '8000', password: 'secret', mount: 'stream', codec: 'aac',
    });
    assert.strictEqual(invalid.ok, false);
    assert.match(invalid.message, /SID/);

    const valid = validateEncoderConfig({
        serverType: 'shoutcast2', ip: 'radio.test', port: '8000', password: 'secret', mount: '2', codec: 'aac',
    });
    assert.strictEqual(valid.ok, true);
    assert.strictEqual(valid.config.mount, '2');
});

test('validateEncoderConfig accepts an optional SHOUTcast admin port and rejects invalid values', () => {
    const valid = validateEncoderConfig({
        serverType: 'shoutcast',
        ip: 'radio.example',
        port: '8001',
        adminPort: '8000',
        password: 'secret',
        codec: 'mp3',
    });
    assert.strictEqual(valid.ok, true);
    assert.strictEqual(valid.config.adminPort, '8000');

    const invalid = validateEncoderConfig({
        serverType: 'shoutcast',
        ip: 'radio.example',
        port: '8001',
        adminPort: 'not-a-port',
        password: 'secret',
        codec: 'mp3',
    });
    assert.strictEqual(invalid.ok, false);
    assert.match(invalid.message, /administrativo/i);
});

test('validateEncoderConfig blocks HE-AAC unless libfdk_aac is confirmed', () => {
    const result = validateEncoderConfig({
        serverType: 'icecast', ip: 'radio.test', port: '8000', password: 'secret', mount: '/live', codec: 'aac_he',
    }, { fdkAvailable: false });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.category, 'codec');
    assert.strictEqual(result.retryable, false);
    assert.match(result.message, /libfdk_aac/);
});

test('classifyEncoderError distinguishes permanent authentication errors from transient network failures', () => {
    assert.deepStrictEqual(
        classifyEncoderError('HTTP error 401 Unauthorized: bad password'),
        { category: 'auth', retryable: false }
    );
    assert.deepStrictEqual(
        classifyEncoderError('connect ECONNREFUSED 127.0.0.1:8000'),
        { category: 'network', retryable: true }
    );
    assert.deepStrictEqual(
        classifyEncoderError('Stream In Use'),
        { category: 'server', retryable: false }
    );
});

test('application logger redacts and rotates persistent messages before append', () => {
    assert.match(mainSource, /redactSensitiveText\(msg\)/);
    assert.match(mainSource, /rotateLogIfNeeded\(primaryLogPath\)/);
    assert.match(mainSource, /scrubPersistentLogOnce\(primaryLogPath\)/);
});

test('encoder preferences cross IPC and use Electron safeStorage in the main process', () => {
    assert.match(mainSource, /safeStorage/);
    assert.match(windowsSource, /ipcMain\.on\('encoder-prefs-load-sync'/);
    assert.match(windowsSource, /ipcMain\.on\('encoder-prefs-save'/);
    assert.match(encoderUiSource, /ipcRenderer\.sendSync\('encoder-prefs-load-sync'\)/);
    assert.match(encoderUiSource, /ipcRenderer\.send\('encoder-prefs-save', data\)/);
    assert.doesNotMatch(encoderUiSource, /writeFileSync\(/);
});

test('encoder backend validates every IPC config before connecting', () => {
    assert.match(windowsSource, /validateEncoderConfig\(rawConfig, \{ fdkAvailable: _fdkAacAvailable === true \}\)/);
    assert.match(windowsSource, /emitEncoderError\(id, validation\.message, validation\)/);
});

test('DNAS2 ICY compatibility sends the configured SID suffix', () => {
    assert.match(windowsSource, /`\$\{config\.password\}:#\$\{mountSid\}`/);
});

test('Icecast metadata authentication uses the configured source user', () => {
    assert.match(windowsSource, /Buffer\.from\(`\$\{conf\.user \|\| 'source'\}:\$\{conf\.password\}`\)/);
});

test('SHOUTcast metadata uses the optional administrative port instead of assuming the source port', () => {
    assert.match(windowsSource, /conf\.adminPort \|\| conf\.port/);
    assert.match(encoderUiSource, /encoder\.srv_admin_port/);
    assert.match(esLocale.encoder.srv_admin_port, /Puerto administrativo/);
});

test('encoder UI stops reconnecting permanent backend failures', () => {
    assert.match(encoderUiSource, /payload\.retryable === false/);
    assert.match(encoderUiSource, /s\.autoReconnect = false/);
    assert.match(encoderUiSource, /clearServerReconnect\(s\)/);
});

test('native SHOUTcast2 selection is wired to Ultravox instead of HTTP PUT', () => {
    assert.match(windowsSource, /config\.serverType === 'shoutcast2' && config\.legacy !== true/);
    assert.match(windowsSource, /const ultravox = new UltravoxSource\(/);
    assert.match(windowsSource, /server\.ultravox = ultravox;/);
    assert.match(encoderUiSource, /encoder\.srv_type_sc2/);
    assert.match(esLocale.encoder.srv_type_sc2, /SHOUTcast 2\.x nativo \(Ultravox 2\.1\)/);
});
