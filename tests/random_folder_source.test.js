'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const src = require('../frontend/random_folder_source');

function makeTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-random-'));
    fs.writeFileSync(path.join(root, 'a.mp3'), 'x');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x'); // ignorado
    fs.mkdirSync(path.join(root, 'sub1'));
    fs.mkdirSync(path.join(root, 'sub2', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub1', 'song.mp3'), 'x');
    fs.writeFileSync(path.join(root, 'sub2', 'song.mp3'), 'x');   // mismo basename que sub1
    fs.writeFileSync(path.join(root, 'sub2', 'deep', 'b.flac'), 'x');
    return root;
}

test('flat read returns only top-level audio as relative basenames', () => {
    const root = makeTree();
    try {
        const files = src.getRandomFolderFilesFast(root, false);
        assert.deepStrictEqual(files, ['a.mp3']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('recursive read walks nested subfolders without basename collisions', () => {
    const root = makeTree();
    try {
        const files = src.getRandomFolderFilesFast(root, true);
        const abs = files.map(rel => src.resolveAbsolute(root, rel)).sort();
        // 1 raiz + 2 con mismo nombre en subcarpetas distintas + 1 anidado = 4
        assert.strictEqual(files.length, 4);
        // Las dos canciones 'song.mp3' deben sobrevivir como rutas distintas.
        assert.ok(abs.includes(path.join(root, 'sub1', 'song.mp3')));
        assert.ok(abs.includes(path.join(root, 'sub2', 'song.mp3')));
        assert.ok(abs.includes(path.join(root, 'sub2', 'deep', 'b.flac')));
        // Todas las rutas reconstruidas existen en disco.
        for (const p of abs) assert.ok(fs.existsSync(p), `${p} deberia existir`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('flat and recursive caches do not collide for the same folder', () => {
    const root = makeTree();
    try {
        const flat = src.getRandomFolderFilesFast(root, false);
        const rec = src.getRandomFolderFilesFast(root, true);
        assert.strictEqual(flat.length, 1);
        assert.strictEqual(rec.length, 4);
        // Releer en caliente devuelve lo mismo (claves separadas).
        assert.strictEqual(src.getRandomFolderFilesFast(root, false).length, 1);
        assert.strictEqual(src.getRandomFolderFilesFast(root, true).length, 4);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('async warm matches sync read', async () => {
    const root = makeTree();
    try {
        src.invalidate(root);
        const warm = await src.warmRandomFolder(root, true);
        assert.strictEqual(warm.length, 4);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
