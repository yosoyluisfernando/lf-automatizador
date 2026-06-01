'use strict';

const fs = require('fs');
const path = require('path');

const NO_SECURE_STORAGE_WARNING = 'El sistema operativo no ofrece almacenamiento seguro: las contrasenas del encoder no se guardaron. Deben ingresarse de nuevo al abrir la aplicacion.';

function hasSecureStorage(safeStorage) {
    try {
        if (!safeStorage || safeStorage.isEncryptionAvailable() !== true) return false;
        if (typeof safeStorage.getSelectedStorageBackend === 'function'
            && safeStorage.getSelectedStorageBackend() === 'basic_text') {
            return false;
        }
        return typeof safeStorage.encryptString === 'function'
            && typeof safeStorage.decryptString === 'function';
    } catch (_) {
        return false;
    }
}

function extractPassword(server = {}) {
    if (typeof server.pass === 'string') return server.pass;
    if (typeof server.password === 'string') return server.password;
    return '';
}

function protectServer(server = {}, safeStorage) {
    const password = extractPassword(server);
    const clean = { ...server };
    delete clean.pass;
    delete clean.password;
    delete clean.passEncrypted;
    if (password && hasSecureStorage(safeStorage)) {
        clean.passEncrypted = safeStorage.encryptString(password).toString('base64');
    }
    return clean;
}

function protectEncoderPrefs(prefs = {}, safeStorage) {
    const secure = hasSecureStorage(safeStorage);
    const servers = Array.isArray(prefs.servers)
        ? prefs.servers.map(server => protectServer(server, safeStorage))
        : prefs.servers;
    const protectedPrefs = { ...prefs, servers };
    const legacyPassword = extractPassword(prefs);
    delete protectedPrefs.pass;
    delete protectedPrefs.password;
    delete protectedPrefs.passEncrypted;
    if (legacyPassword && secure) {
        protectedPrefs.passEncrypted = safeStorage.encryptString(legacyPassword).toString('base64');
    }
    const hasPassword = legacyPassword || (Array.isArray(prefs.servers) && prefs.servers.some(extractPassword));
    return {
        prefs: protectedPrefs,
        warning: hasPassword && !secure ? NO_SECURE_STORAGE_WARNING : '',
    };
}

function unprotectServer(server = {}, safeStorage) {
    const clean = { ...server };
    const plaintext = extractPassword(server);
    let warning = '';
    let migrated = !!plaintext;
    delete clean.password;
    delete clean.passEncrypted;
    if (server.passEncrypted) {
        try {
            clean.pass = hasSecureStorage(safeStorage)
                ? safeStorage.decryptString(Buffer.from(server.passEncrypted, 'base64'))
                : '';
            if (!clean.pass) warning = NO_SECURE_STORAGE_WARNING;
        } catch (_) {
            clean.pass = '';
            warning = 'No se pudo descifrar una contrasena guardada del encoder. Ingresela de nuevo.';
        }
    } else {
        clean.pass = plaintext;
    }
    return { server: clean, warning, migrated };
}

function unprotectEncoderPrefs(stored = {}, safeStorage) {
    let warning = '';
    let migrated = false;
    const prefs = { ...stored };
    if (Array.isArray(stored.servers)) {
        prefs.servers = stored.servers.map(server => {
            const result = unprotectServer(server, safeStorage);
            warning ||= result.warning;
            migrated ||= result.migrated;
            return result.server;
        });
    }
    const legacy = unprotectServer(stored, safeStorage);
    delete prefs.password;
    delete prefs.passEncrypted;
    if (stored.passEncrypted || stored.pass || stored.password) {
        prefs.pass = legacy.server.pass;
        warning ||= legacy.warning;
        migrated ||= legacy.migrated;
    }
    return { prefs, warning, migrated };
}

function saveEncoderPrefs({ filePath, prefs = {}, safeStorage, fileSystem = fs } = {}) {
    try {
        const protectedResult = protectEncoderPrefs(prefs, safeStorage);
        fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.tmp`;
        fileSystem.writeFileSync(tempPath, JSON.stringify(protectedResult.prefs, null, 2), 'utf8');
        fileSystem.renameSync(tempPath, filePath);
        return { success: true, warning: protectedResult.warning };
    } catch (err) {
        try { fileSystem.unlinkSync(`${filePath}.tmp`); } catch (_) {}
        return { success: false, error: err.message || String(err) };
    }
}

function loadEncoderPrefs({ filePath, safeStorage, fileSystem = fs } = {}) {
    try {
        if (!fileSystem.existsSync(filePath)) return { prefs: {}, warning: '', migrated: false };
        const stored = JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
        const result = unprotectEncoderPrefs(stored, safeStorage);
        if (result.migrated) {
            const saved = saveEncoderPrefs({ filePath, prefs: result.prefs, safeStorage, fileSystem });
            if (!saved.success) {
                const scrubbed = saveEncoderPrefs({ filePath, prefs: result.prefs, safeStorage: null, fileSystem });
                result.warning ||= scrubbed.success
                    ? `No se pudo cifrar la contrasena migrada; se elimino del archivo guardado. ${saved.error || ''}`.trim()
                    : `No se pudo sanear la configuracion antigua del encoder: ${saved.error || scrubbed.error || ''}`.trim();
            } else {
                result.warning ||= saved.warning || '';
            }
        }
        return result;
    } catch (err) {
        return { prefs: {}, warning: `No se pudo leer la configuracion del encoder: ${err.message || err}`, migrated: false };
    }
}

module.exports = {
    NO_SECURE_STORAGE_WARNING,
    hasSecureStorage,
    loadEncoderPrefs,
    protectEncoderPrefs,
    saveEncoderPrefs,
    unprotectEncoderPrefs,
};
