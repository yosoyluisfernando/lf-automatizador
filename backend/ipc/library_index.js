'use strict';

const path = require('path');
const { createLibraryIndexService } = require('../services/library_index');

module.exports = function registerLibraryIndexIpc(context) {
    const { ipcMain, db, fs, configDir, writeLog } = context;
    const service = createLibraryIndexService({ db, fs, configDir });

    function readJson(filePath, fallback) {
        try {
            if (!fs.existsSync(filePath)) return fallback;
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return parsed && typeof parsed === 'object' ? parsed : fallback;
        } catch (err) {
            return fallback;
        }
    }

    function getConfiguredLibraryRoot() {
        const prefs = readJson(path.join(configDir, 'library_prefs.json'), {});
        return String(prefs.persistentRoot || '').trim();
    }

    function ensureLibraryRoot() {
        const rootPath = getConfiguredLibraryRoot();
        if (!rootPath || !fs.existsSync(rootPath)) return null;
        const result = service.addRoot({
            rootPath,
            source: 'library_root',
            recursive: true,
            locked: true,
            enabled: true
        });
        return result.success ? result.root : null;
    }

    function notifyIndexChanged() {
        try {
            context.mainWindow?.webContents?.send?.('library-index-updated');
            context.libraryWindow?.webContents?.send?.('library-index-updated');
        } catch (err) {}
    }

    function notifyTypeAssignmentsChanged() {
        try {
            context.mainWindow?.webContents?.send?.('file-types-data-updated');
            context.libraryWindow?.webContents?.send?.('file-types-data-updated');
            context.fileTypesManagerWindow?.webContents?.send?.('file-types-data-updated');
        } catch (err) {}
    }

    ipcMain.handle('library-index-list-roots', () => {
        try {
            ensureLibraryRoot();
            return { success: true, roots: service.listRoots() };
        } catch (err) {
            writeLog?.(`Error library-index-list-roots: ${err.message}`);
            return { success: false, error: err.message, roots: [] };
        }
    });

    ipcMain.handle('library-index-add-root', (event, payload = {}) => {
        try {
            ensureLibraryRoot();
            const result = service.addRoot(payload);
            if (result.success) {
                notifyIndexChanged();
                if (payload.typeId) notifyTypeAssignmentsChanged();
            }
            return result;
        } catch (err) {
            writeLog?.(`Error library-index-add-root: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('library-index-sync-root', (event, rootPath) => {
        try {
            ensureLibraryRoot();
            return service.syncRoot(rootPath);
        } catch (err) {
            writeLog?.(`Error library-index-sync-root: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('library-index-sync-all', () => {
        try {
            ensureLibraryRoot();
            return service.syncAllRoots();
        } catch (err) {
            writeLog?.(`Error library-index-sync-all: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('library-index-search', (event, payload = {}) => {
        try {
            ensureLibraryRoot();
            return { success: true, results: service.search(payload) };
        } catch (err) {
            writeLog?.(`Error library-index-search: ${err.message}`);
            return { success: false, error: err.message, results: [] };
        }
    });
};
