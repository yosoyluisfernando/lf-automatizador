'use strict';

// Gestión del auto-arranque del software al iniciar sesión en el sistema.
// Envuelve `app.setLoginItemSettings` de Electron (Windows: registro de inicio;
// Linux: archivo .desktop en ~/.config/autostart).
//
// Reglas:
//  - Solo se aplica en builds EMPAQUETADOS (app.isPackaged). En desarrollo
//    (`npm start` / electron .) se ignora para no ensuciar el autostart del
//    sistema con rutas apuntando a node/electron.
//  - En AppImage el ejecutable real vive en un punto de montaje temporal, así
//    que hay que pasar explícitamente `process.env.APPIMAGE` como `path`; de lo
//    contrario el registro de autostart apuntaría a una ruta que ya no existe.

const APP_LOGIN_NAME = 'LF Automatizador';

function buildSettings(enabled) {
    const settings = { openAtLogin: !!enabled, name: APP_LOGIN_NAME };
    if (process.platform === 'linux' && process.env.APPIMAGE) {
        settings.path = process.env.APPIMAGE;
        settings.args = [];
    }
    return settings;
}

// Aplica el estado solicitado. Devuelve un resultado describiendo qué pasó para
// que la UI pueda avisar (p. ej. "solo disponible en la versión instalada").
function applyAutoLaunch(app, enabled) {
    if (!app || app.isPackaged !== true) {
        return { ok: false, reason: 'dev' };
    }
    if (typeof app.setLoginItemSettings !== 'function') {
        return { ok: false, reason: 'unsupported' };
    }
    try {
        app.setLoginItemSettings(buildSettings(enabled));
        return { ok: true, enabled: !!enabled };
    } catch (err) {
        return { ok: false, reason: 'error', error: err && err.message ? err.message : String(err) };
    }
}

// Lee el estado real registrado en el sistema operativo.
function getAutoLaunch(app) {
    if (!app || app.isPackaged !== true) return false;
    try {
        return app.getLoginItemSettings().openAtLogin === true;
    } catch (_) {
        return false;
    }
}

module.exports = { applyAutoLaunch, getAutoLaunch, buildSettings, APP_LOGIN_NAME };
