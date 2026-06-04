'use strict';

// IPC del proceso principal para las opciones de "Sistema e Interfaz":
//  - set-auto-launch / get-auto-launch: auto-arranque del software con el SO.
//
// El auto-play (reproducción automática al abrir) y el arranque del encoder se
// resuelven en el renderer y en backend/ipc/windows.js respectivamente; aquí
// solo vive lo que requiere hablar con el sistema operativo.

const path = require('path');
const { applyAutoLaunch, getAutoLaunch } = require('../services/auto_launch');

module.exports = function (context) {
    const { ipcMain, app, configDir, fs } = context;
    const generalPrefsPath = path.join(configDir, 'general_settings.json');

    function readAutoStartPref() {
        try {
            const raw = JSON.parse(fs.readFileSync(generalPrefsPath, 'utf-8'));
            return !!(raw && raw.autoStartWithSystem === true);
        } catch (_) {
            return false;
        }
    }

    // El renderer (ventana de Ajustes) pide aplicar el cambio al conmutar el
    // interruptor. Devolvemos el resultado para que la UI avise si solo está
    // disponible en la versión instalada (dev) o si hubo un error.
    ipcMain.handle('set-auto-launch', (_e, enabled) => applyAutoLaunch(app, !!enabled));

    ipcMain.handle('get-auto-launch', () => ({
        enabled: getAutoLaunch(app),
        packaged: app.isPackaged === true,
    }));

    // Reconciliación al arrancar: si el usuario dejó activado el auto-arranque,
    // re-aplicamos el registro. Es idempotente y, sobre todo, refresca la ruta
    // del ejecutable (imprescindible en AppImage, cuyo path cambia en cada
    // ejecución). Diferido a whenReady por seguridad de plataforma.
    app.whenReady().then(() => {
        try {
            if (app.isPackaged && readAutoStartPref()) applyAutoLaunch(app, true);
        } catch (_) { /* no-op */ }
    });
};
