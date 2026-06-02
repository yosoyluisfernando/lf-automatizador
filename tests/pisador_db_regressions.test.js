'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const dbSource = fs.readFileSync(path.join(root, 'database.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const librarySource = fs.readFileSync(path.join(root, 'backend', 'ipc', 'library.js'), 'utf8');

test('tracks schema adds P4 and per-pisador options idempotently', () => {
    [
        'p1_options TEXT',
        'p2_options TEXT',
        'p3_options TEXT',
        'p4_active INTEGER',
        'p4_mode TEXT',
        'p4_time TEXT',
        'p4_file TEXT',
        'p4_options TEXT'
    ].forEach(column => assert.match(dbSource, new RegExp(column.replace(' ', '\\s+'))));
});

test('legacy phora migrates once into builtin time P4 without deleting legacy columns', () => {
    assert.match(dbSource, /pisador_p4_time_migrated/);
    assert.match(dbSource, /builtin.*time/);
    assert.match(dbSource, /phora_active\s*=\s*1/);
    assert.doesNotMatch(dbSource, /DROP COLUMN\s+phora/i);
});

test('main and library IPC carry P4 options and source', () => {
    for (const source of [mainSource, librarySource]) {
        assert.match(source, /p1_options/);
        assert.match(source, /p2_options/);
        assert.match(source, /p3_options/);
        assert.match(source, /p4_active/);
        assert.match(source, /p4_mode/);
        assert.match(source, /p4_time/);
        assert.match(source, /p4_file/);
        assert.match(source, /p4_options/);
    }
});

test('changed files clear the fourth pisador timing state', () => {
    assert.match(mainSource, /p4_active:\s*false/);
    assert.match(mainSource, /p4_time:\s*null/);
});
