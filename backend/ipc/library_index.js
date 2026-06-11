'use strict';

const path = require('path');
const { createLibraryIndexService } = require('../services/library_index');

module.exports = function registerLibraryIndexIpc(context) {
    const { ipcMain, db, fs, configDir, writeLog, runLibraryWorkerTask } = context;
    const service = createLibraryIndexService({ db, fs, configDir });

    // El trabajo pesado (escaneo, tags, búsqueda difusa) corre en
    // library_worker: si corriera aquí bloquearía el event loop del proceso
    // principal (todas las ventanas congeladas y falsos timeouts de RustAudio).
    // La instancia local `service` queda como red de seguridad y para las
    // operaciones baratas (listar/agregar raíces).
    async function runInWorker(action, payload, fallback) {
        try {
            const result = await runLibraryWorkerTask(action, payload);
            if (result && result.success !== false) return result;
            writeLog?.(`${action}: worker fallo (${result?.error || 'sin detalle'}); usando proceso principal.`);
        } catch (err) {
            writeLog?.(`${action}: worker fallo (${err.message}); usando proceso principal.`);
        }
        return fallback();
    }

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

    ipcMain.handle('library-index-sync-root', async (event, rootPath) => {
        try {
            ensureLibraryRoot();
            return await runInWorker('library-index-sync-root', { rootPath }, () => service.syncRoot(rootPath));
        } catch (err) {
            writeLog?.(`Error library-index-sync-root: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('library-index-sync-all', async () => {
        try {
            ensureLibraryRoot();
            return await runInWorker('library-index-sync-all', {}, () => service.syncAllRoots());
        } catch (err) {
            writeLog?.(`Error library-index-sync-all: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('library-index-search', async (event, payload = {}) => {
        try {
            ensureLibraryRoot();
            const result = await runInWorker('library-index-search', payload || {}, () => ({ success: true, results: service.search(payload) }));
            return { success: true, results: Array.isArray(result.results) ? result.results : [] };
        } catch (err) {
            writeLog?.(`Error library-index-search: ${err.message}`);
            return { success: false, error: err.message, results: [] };
        }
    });

    // Estado ligero para el cuadro de diagnóstico (al abrir el software y tras
    // cada sincronización). Solo conteos: jamás dispara un escaneo de disco.
    ipcMain.handle('library-index-status', async () => {
        try {
            ensureLibraryRoot();
            const result = await runInWorker('library-index-status', {}, () => ({ success: true, status: service.getStatus() }));
            return { success: true, status: result.status || null };
        } catch (err) {
            writeLog?.(`Error library-index-status: ${err.message}`);
            return { success: false, error: err.message, status: null };
        }
    });
};
