module.exports = function(context) {
    const {
        ipcMain, fs, dialog, cwConfigPath, BrowserWindow,
        saveUiPrefs, syncCartwallMenuState
    } = context;

    function createDefaultButton(id) {
        return {
            id,
            label: String(id),
            file: '',
            type: 'audio',
            folder: '',
            name: '',
            bg: '',
            text: '#FFFFFF',
            vol: 1,
            loop: false,
            stopOther: false,
            overlap: false,
            restart: false,
            shortcut: ''
        };
    }

    function normalizeButton(rawButton, id) {
        const defaults = createDefaultButton(id);
        const button = { ...defaults, ...(rawButton || {}) };
        button.id = id;
        button.label = String(button.label || id);
        button.file = button.file || '';
        button.type = ['audio', 'time', 'temperature', 'humidity'].includes(button.type) ? button.type : 'audio';
        button.folder = button.folder || '';
        button.name = button.name || '';
        button.bg = button.bg || '';
        button.text = button.text || '#FFFFFF';
        button.vol = Number.isFinite(Number(button.vol)) ? Number(button.vol) : 1;
        button.loop = !!button.loop;
        button.stopOther = !!button.stopOther;
        button.overlap = !!button.overlap;
        button.restart = !!button.restart;
        button.shortcut = button.shortcut || '';
        return button;
    }

    function normalizePalette(rawPalette, index) {
        const palette = {
            nombre: rawPalette?.nombre || `Botonera ${index + 1}`,
            rows: Number(rawPalette?.rows) || 5,
            cols: Number(rawPalette?.cols) || 5,
            audioOut: rawPalette?.audioOut || 'global',
            shortcut: rawPalette?.shortcut || '',
            tabBg: rawPalette?.tabBg || '#3a3f44',
            tabText: rawPalette?.tabText || '#cccccc',
            botones: []
        };
        palette.rows = Math.max(1, Math.min(20, palette.rows));
        palette.cols = Math.max(1, Math.min(20, palette.cols));
        const sourceButtons = Array.isArray(rawPalette?.botones) ? rawPalette.botones : [];
        const total = palette.rows * palette.cols;
        for (let i = 0; i < total; i++) {
            palette.botones.push(normalizeButton(sourceButtons[i], i + 1));
        }
        return palette;
    }

    function normalizeProfile(rawProfile, index = 0) {
        const profile = {
            id: rawProfile?.id || (index === 0 ? 'default' : `profile_${Date.now()}_${index}`),
            name: rawProfile?.name || (index === 0 ? 'Principal' : `Perfil ${index + 1}`),
            bg: rawProfile?.bg || '#008c3a',
            text: rawProfile?.text || '#ffffff',
            config: {
                outMain: rawProfile?.config?.outMain || 'default',
                outPre: rawProfile?.config?.outPre || 'default',
                keys: {
                    stopAll: rawProfile?.config?.keys?.stopAll || '',
                    next: rawProfile?.config?.keys?.next || '',
                    prev: rawProfile?.config?.keys?.prev || ''
                }
            },
            paletas: []
        };
        const sourcePalettes = Array.isArray(rawProfile?.paletas) && rawProfile.paletas.length > 0
            ? rawProfile.paletas
            : [{ nombre: 'Botonera 1', rows: 5, cols: 5, botones: [] }];
        profile.paletas = sourcePalettes.map((palette, paletteIndex) => normalizePalette(palette, paletteIndex));
        return profile;
    }

    function normalizeCartwallState(rawState) {
        const state = rawState && typeof rawState === 'object' ? rawState : {};
        const rawProfiles = Array.isArray(state.profiles) && state.profiles.length > 0
            ? state.profiles
            : [normalizeProfile(null, 0)];
        const profiles = rawProfiles.map((profile, index) => normalizeProfile(profile, index));
        const activeProfileId = profiles.some(profile => profile.id === state.activeProfileId)
            ? state.activeProfileId
            : profiles[0].id;
        return { activeProfileId, profiles };
    }

    let cartwallUiState = {
        activeProfileId: null,
        activeTabIndex: 0,
        mode: context.uiPrefs.cartwall ? 'docked' : 'hidden'
    };

    function getPersistedCartwallState() {
        if (fs.existsSync(cwConfigPath)) {
            try { return normalizeCartwallState(JSON.parse(fs.readFileSync(cwConfigPath, 'utf-8'))); }
            catch (e) { return normalizeCartwallState(null); }
        }
        return normalizeCartwallState(null);
    }

    function normalizeCartwallUiState(partial = {}, persistedState = getPersistedCartwallState()) {
        const profiles = persistedState.profiles || [];
        const requestedProfileId = partial.activeProfileId || cartwallUiState.activeProfileId || persistedState.activeProfileId;
        const activeProfile = profiles.find(profile => profile.id === requestedProfileId) || profiles[0];
        const activeProfileId = activeProfile?.id || 'default';
        const tabCount = Math.max(1, activeProfile?.paletas?.length || 1);
        const requestedTab = Number.isInteger(partial.activeTabIndex)
            ? partial.activeTabIndex
            : cartwallUiState.activeTabIndex;
        const activeTabIndex = Math.max(0, Math.min(tabCount - 1, Number.isInteger(requestedTab) ? requestedTab : 0));
        const requestedMode = partial.mode || cartwallUiState.mode || 'hidden';
        const mode = ['hidden', 'docked', 'floating'].includes(requestedMode) ? requestedMode : 'hidden';
        return { activeProfileId, activeTabIndex, mode };
    }

    function broadcastCartwallUiState(skipSender = null) {
        if (context.mainWindow && !context.mainWindow.isDestroyed() && context.mainWindow.webContents !== skipSender) {
            context.mainWindow.webContents.send('cartwall-ui-state', cartwallUiState);
        }
        if (context.cartwallWindow && !context.cartwallWindow.isDestroyed() && context.cartwallWindow.webContents !== skipSender) {
            context.cartwallWindow.webContents.send('cartwall-ui-state', cartwallUiState);
        }
    }

    function updateCartwallUiState(partial = {}, skipSender = null) {
        cartwallUiState = normalizeCartwallUiState(partial);
        if (Object.prototype.hasOwnProperty.call(partial, 'mode')) {
            const mode = cartwallUiState.mode;
            context.uiPrefs.cartwall = mode === 'docked';
            if (['docked', 'floating'].includes(mode)) context.uiPrefs.cartwallLastMode = mode;
            saveUiPrefs();
            syncCartwallMenuState(mode !== 'hidden');
        }
        broadcastCartwallUiState(skipSender);
        return cartwallUiState;
    }

    // ============================================================================
    // FASE 3: MANEJO DEL CARTWALL (PERFILES E IPC)
    // ============================================================================
    ipcMain.handle('get-cartwall-profiles', () => {
        return getPersistedCartwallState();
    });

    ipcMain.handle('save-cartwall-profiles', (event, data) => {
        const normalized = normalizeCartwallState(data);
        fs.writeFileSync(cwConfigPath, JSON.stringify(normalized, null, 2));
        cartwallUiState = normalizeCartwallUiState({ activeProfileId: normalized.activeProfileId }, normalized);
        if (context.mainWindow && !context.mainWindow.isDestroyed()) context.mainWindow.webContents.send('sync-cartwall-state');
        if (context.cartwallWindow && !context.cartwallWindow.isDestroyed() && event.sender !== context.cartwallWindow.webContents) context.cartwallWindow.webContents.send('sync-cartwall-state');
        broadcastCartwallUiState(event.sender);
        return true;
    });

    ipcMain.handle('get-cartwall-ui-state', () => {
        cartwallUiState = normalizeCartwallUiState();
        return cartwallUiState;
    });

    ipcMain.on('set-cartwall-ui-state', (event, partial) => {
        updateCartwallUiState(partial, event.sender);
    });

    ipcMain.on('open-cartwall-window', () => {
        if (context.cartwallWindow) {
            if (context.cartwallWindow.isMinimized()) context.cartwallWindow.restore();
            context.cartwallWindow.focus();
            updateCartwallUiState({ mode: 'floating' });
            return;
        }
        context.cartwallDockRequested = false;
        updateCartwallUiState({ mode: 'floating' });
        context.cartwallWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'console.png')), 
            width: 800, height: 600, title: 'Botonera de efectos flotante',
            autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false }
        });
        context.cartwallWindow.loadFile('frontend/cartwall.html');
        context.cartwallWindow.on('closed', () => { 
            const shouldDock = context.cartwallDockRequested;
            context.cartwallDockRequested = false;
            context.cartwallWindow = null; 
            updateCartwallUiState({ mode: shouldDock ? 'docked' : 'hidden' });
            if (context.mainWindow && !context.mainWindow.isDestroyed()) {
                context.mainWindow.webContents.send(shouldDock ? 'cartwall-docked' : 'cartwall-floating-closed');
            }
        });
    });

    ipcMain.on('cartwall-dock', () => {
        if (!context.cartwallWindow) return;
        context.cartwallDockRequested = true;
        context.cartwallWindow.close();
    });

    ipcMain.on('cartwall-hide', () => {
        if (context.cartwallWindow && !context.cartwallWindow.isDestroyed()) {
            context.cartwallDockRequested = false;
            context.cartwallWindow.close();
            return;
        }
        updateCartwallUiState({ mode: 'hidden' });
    });

    ipcMain.on('remote-cw-play', (e, btnInfo) => {
        if (context.mainWindow && !context.mainWindow.isDestroyed()) context.mainWindow.webContents.send('remote-cw-play', btnInfo);
    });

    ipcMain.on('remote-cw-stop', (e, btnId) => {
        if (context.mainWindow && !context.mainWindow.isDestroyed()) context.mainWindow.webContents.send('remote-cw-stop', btnId);
    });

    ipcMain.on('remote-cw-stopall', () => {
        if (context.mainWindow && !context.mainWindow.isDestroyed()) context.mainWindow.webContents.send('remote-cw-stopall');
    });

    ipcMain.on('remote-cw-stop-tab', (e, tabIndex) => {
        if (context.mainWindow && !context.mainWindow.isDestroyed()) context.mainWindow.webContents.send('remote-cw-stop-tab', tabIndex);
    });

    ipcMain.on('remote-cw-move-button', (e, payload) => {
        if (context.mainWindow && !context.mainWindow.isDestroyed()) context.mainWindow.webContents.send('remote-cw-move-button', payload);
    });

    ipcMain.on('cartwall-play-state', (e, payload) => {
        if (context.cartwallWindow && !context.cartwallWindow.isDestroyed()) context.cartwallWindow.webContents.send('cartwall-play-state', payload);
    });

    ipcMain.on('cartwall-progress', (e, payload) => {
        if (context.cartwallWindow && !context.cartwallWindow.isDestroyed()) context.cartwallWindow.webContents.send('cartwall-progress', payload);
    });

    ipcMain.handle('preguntar-eliminar-perfil', async (event, nombre) => {
        const res = await dialog.showMessageBox(context.cartwallWindow || context.mainWindow, {
            type: 'warning',
            buttons: ['Eliminar', 'Exportar (.bdeplf) y Eliminar', 'Cancelar'],
            title: 'Eliminar Perfil',
            message: `¿Qué deseas hacer con el perfil "${nombre}"?`,
            cancelId: 2
        });
        return res.response; 
    });

    ipcMain.handle('importar-bdeplf', async () => {
        const currentWin = context.cartwallWindow || context.mainWindow;
        const res = await dialog.showOpenDialog(currentWin, {
            title: 'Importar Perfil',
            properties: ['openFile'],
            filters: [{ name: 'Perfil de botonera de efectos', extensions: ['bdeplf'] }]
        });
        if (!res.canceled && res.filePaths.length > 0) {
            try {
                const parsed = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf-8'));
                if (Array.isArray(parsed?.profiles)) {
                    const normalizedState = normalizeCartwallState(parsed);
                    return normalizedState.profiles.find(profile => profile.id === normalizedState.activeProfileId) || normalizedState.profiles[0];
                }
                return normalizeProfile(parsed);
            } 
            catch (e) { return null; }
        }
        return null;
    });

    ipcMain.handle('exportar-bdeplf', async (event, data) => {
        const currentWin = context.cartwallWindow || context.mainWindow;
        const res = await dialog.showSaveDialog(currentWin, {
            title: 'Exportar Perfil',
            defaultPath: `${data.name}.bdeplf`,
            filters: [{ name: 'Perfil de botonera de efectos', extensions: ['bdeplf'] }]
        });
        if (!res.canceled && res.filePath) {
            fs.writeFileSync(res.filePath, JSON.stringify(normalizeProfile(data), null, 2));
            return true;
        }
        return false;
    });
};
