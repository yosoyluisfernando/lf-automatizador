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

    // Detalle de canciones recientes (ruta + ultima hora) para elegir "la menos
    // reciente" cuando una carpeta agota su pozo de canciones no repetidas.
    ipcMain.handle('playback-history-recent-songs', (event, payload = {}) => ({
        success: true,
        songs: history.recentSongs(payload)
    }));

    // Artistas reproducidos dentro de la ventana de separacion por artista.
    ipcMain.handle('playback-history-recent-artists', (event, payload = {}) => ({
        success: true,
        artists: history.recentArtists(payload)
    }));
};
