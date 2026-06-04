'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { PlaybackHistory, normalizeRetentionDays } = require('../backend/playback_history');

function openMemoryDb(t) {
    try {
        return new Database(':memory:');
    } catch (err) {
        t.skip(`better-sqlite3 requiere la ABI de Electron en este entorno: ${err.code || err.message}`);
        return null;
    }
}

test('playback history retention is clamped to the approved physical-memory range', () => {
    // Piso aprobado: 30 dias (la memoria fisica respalda las reglas de separacion).
    assert.strictEqual(normalizeRetentionDays(), 30);
    assert.strictEqual(normalizeRetentionDays(0), 30);
    assert.strictEqual(normalizeRetentionDays(1), 30);
    assert.strictEqual(normalizeRetentionDays(45), 45);
    assert.strictEqual(normalizeRetentionDays(800), 366);
});

test('playback history stores useful audio classes but skips locutions', t => {
    const db = openMemoryDb(t);
    if (!db) return;
    const history = new PlaybackHistory(db);
    history.record({ filePath: '/music/song.mp3', title: 'Song', category: 'music' });
    history.record({ filePath: '/spots/spot.mp3', title: 'Spot', category: 'commercial' });
    history.record({ filePath: '/voice/hour.mp3', title: 'Hour', category: 'locution' });

    const rows = db.prepare('SELECT file_path, category FROM playback_history ORDER BY id').all();
    assert.deepStrictEqual(rows, [
        { file_path: '/music/song.mp3', category: 'music' },
        { file_path: '/spots/spot.mp3', category: 'commercial' },
    ]);
});

test('recent music lookup supports anti-repeat and prune removes expired rows', t => {
    const db = openMemoryDb(t);
    if (!db) return;
    const history = new PlaybackHistory(db);
    history.record({ filePath: '/music/recent.mp3', category: 'music', playedAt: '2026-06-01T10:00:00.000Z' });
    history.record({ filePath: '/music/old.mp3', category: 'music', playedAt: '2026-05-01T10:00:00.000Z' });

    assert.deepStrictEqual(history.recentPaths({ category: 'music', days: 1, now: '2026-06-01T12:00:00.000Z' }), ['/music/recent.mp3']);
    history.prune(30, '2026-06-01T12:00:00.000Z');
    assert.deepStrictEqual(db.prepare('SELECT file_path FROM playback_history').all(), [{ file_path: '/music/recent.mp3' }]);
});

test('recent songs expose last-played time for least-recently-played fallback', t => {
    const db = openMemoryDb(t);
    if (!db) return;
    const history = new PlaybackHistory(db);
    history.record({ filePath: '/m/a.mp3', category: 'music', playedAt: '2026-06-01T08:00:00.000Z' });
    history.record({ filePath: '/m/b.mp3', category: 'music', playedAt: '2026-06-01T11:00:00.000Z' });
    history.record({ filePath: '/m/a.mp3', category: 'music', playedAt: '2026-06-01T09:00:00.000Z' });

    const songs = history.recentSongs({ category: 'music', value: 12, unit: 'hours', now: '2026-06-01T12:00:00.000Z' });
    const map = new Map(songs.map(row => [row.filePath, row.lastPlayed]));
    // a.mp3 conserva su reproduccion mas reciente (09:00), b.mp3 (11:00).
    assert.strictEqual(map.get('/m/a.mp3'), '2026-06-01T09:00:00.000Z');
    assert.strictEqual(map.get('/m/b.mp3'), '2026-06-01T11:00:00.000Z');
    // La menos reciente es a.mp3 (sono hace mas tiempo).
    const oldest = [...map.entries()].sort((x, y) => x[1].localeCompare(y[1]))[0][0];
    assert.strictEqual(oldest, '/m/a.mp3');
});

test('recent artists track separation window and ignore blank artists', t => {
    const db = openMemoryDb(t);
    if (!db) return;
    const history = new PlaybackHistory(db);
    history.record({ filePath: '/m/a.mp3', category: 'music', artist: 'Soda Stereo', playedAt: '2026-06-01T11:30:00.000Z' });
    history.record({ filePath: '/m/b.mp3', category: 'music', artist: '', playedAt: '2026-06-01T11:40:00.000Z' });
    history.record({ filePath: '/m/c.mp3', category: 'music', artist: 'Soda Stereo', playedAt: '2026-05-01T11:40:00.000Z' });

    const artists = history.recentArtists({ category: 'music', value: 1, unit: 'hours', now: '2026-06-01T12:00:00.000Z' });
    assert.deepStrictEqual(artists.map(row => row.artist), ['Soda Stereo']);
});

test('incident report exposes separate visual and physical-history controls behind a settings button', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'settings.html'), 'utf8');
    const reportsHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'reportes.html'), 'utf8');
    const reportsJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'reportes.js'), 'utf8');
    assert.doesNotMatch(html, /id="history-retention-days"/);
    assert.match(reportsHtml, /id="btn-report-settings"/);
    assert.match(reportsHtml, /id="history-retention-days"[^>]*min="30"[^>]*max="366"/);
    assert.match(reportsHtml, /id="report-retention-unit"/);
    assert.match(reportsHtml, /id="report-persist-on-restart"/);
    assert.match(reportsJs, /historyRetentionDays/);
    assert.match(reportsJs, /historyMusicEnabled/);
});

test('renderer records physical playback history and breaks an exhausted random-folder rule', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'render.js'), 'utf8');
    // Separacion de cancion y de artista consultan el historial fisico por ventana.
    assert.match(js, /playback-history-recent-songs/);
    assert.match(js, /playback-history-recent-artists/);
    assert.match(js, /playback-history-record/);
    assert.match(js, /agoto las canciones no repetidas/);
    assert.match(js, /reportRetentionUnit === 'hours'/);
});
