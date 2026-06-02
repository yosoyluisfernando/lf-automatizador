'use strict';

const { PlaybackHistory, normalizeRetentionDays } = require('../playback_history');

module.exports = function registerPlaybackHistoryIpc(context) {
    const { ipcMain, db } = context;
    const history = new PlaybackHistory(db);

    ipcMain.handle('playback-history-record', (event, payload = {}) => {
        const result = history.record(payload);
        history.prune(normalizeRetentionDays(payload.retentionDays));
        return { success: true, ...result };
    });

    ipcMain.handle('playback-history-recent-paths', (event, payload = {}) => ({
        success: true,
        paths: history.recentPaths(payload)
    }));
};
