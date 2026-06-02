'use strict';

function normalizeRetentionDays(value = 30) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 30;
    return Math.max(1, Math.min(366, parsed));
}

function cutoffIso(amount, unit = 'days', now = new Date().toISOString()) {
    const stamp = new Date(now);
    const safeStamp = Number.isNaN(stamp.getTime()) ? new Date() : stamp;
    const safeAmount = Math.max(1, Math.min(366, parseInt(amount, 10) || 1));
    const ms = unit === 'hours'
        ? safeAmount * 60 * 60 * 1000
        : normalizeRetentionDays(safeAmount) * 24 * 60 * 60 * 1000;
    return new Date(safeStamp.getTime() - ms).toISOString();
}

class PlaybackHistory {
    constructor(db) {
        this.db = db;
        this.ensureSchema();
    }

    ensureSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS playback_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                title TEXT,
                category TEXT NOT NULL,
                source_folder TEXT,
                played_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_playback_history_category_time
                ON playback_history(category, played_at);
            CREATE INDEX IF NOT EXISTS idx_playback_history_file_time
                ON playback_history(file_path, played_at);
        `);
    }

    record({ filePath, title = '', category = 'music', sourceFolder = '', playedAt = new Date().toISOString() } = {}) {
        if (!filePath || category === 'locution') return { stored: false };
        this.db.prepare(`
            INSERT INTO playback_history (file_path, title, category, source_folder, played_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(String(filePath), String(title || ''), String(category || 'music'), String(sourceFolder || ''), new Date(playedAt).toISOString());
        return { stored: true };
    }

    recentPaths({ category = 'music', days, value, unit = 'days', now = new Date().toISOString() } = {}) {
        const amount = value ?? days ?? 1;
        return this.db.prepare(`
            SELECT file_path
            FROM playback_history
            WHERE category = ? AND played_at >= ?
            GROUP BY file_path
            ORDER BY MAX(played_at) DESC
        `).all(String(category || 'music'), cutoffIso(amount, unit, now)).map(row => row.file_path);
    }

    prune(days = 30, now = new Date().toISOString()) {
        return this.db.prepare('DELETE FROM playback_history WHERE played_at < ?').run(cutoffIso(days, 'days', now)).changes;
    }
}

module.exports = {
    PlaybackHistory,
    normalizeRetentionDays
};
