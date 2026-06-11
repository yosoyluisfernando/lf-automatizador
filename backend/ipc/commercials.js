module.exports = function(context) {
    const { ipcMain, db, path, dialog,   scanCommercialPathsInWorker, writeLog } = context;

    function getCommercialAssetState(row) {
        const now = new Date().toISOString();
        if (!row) return 'draft';
        if (row.enabled === 0) return 'paused';
        if ((row.status || 'draft') === 'draft') return 'draft';
        if (row.validity_end && row.validity_end < now) return 'expired';
        if (row.validity_start && row.validity_start > now) return 'upcoming';
        return 'active';
    }

    function commercialBillingForCategory(category) {
        if (category === 'paid') return 'paid';
        if (category === 'unpaid') return 'courtesy';
        if (category === 'station_promo' || category === 'jingle' || category === 'legal_id' || category === 'sweep') return 'internal';
        if (category === 'psa') return 'psa';
        return 'other';
    }

    function commercialAssetToDto(row) {
        return {
            filePath: row.file_path,
            title: row.title || path.basename(row.file_path || ''),
            rootType: row.root_type || 'commercials',
            category: row.category || 'paid',
            commercialType: row.commercial_type || row.category || 'paid',
            billingMode: row.billing_mode || commercialBillingForCategory(row.category || 'paid'),
            clientName: row.client_name || '',
            campaignName: row.campaign_name || '',
            contractCode: row.contract_code || '',
            folderPath: row.folder_path || '',
            duration: row.duration || 0,
            enabled: row.enabled !== 0,
            status: row.status || 'draft',
            computedStatus: getCommercialAssetState(row),
            enteredAt: row.entered_at || row.created_at || '',
            firstAirAt: row.first_air_at || '',
            validityStart: row.validity_start || '',
            validityEnd: row.validity_end || '',
            lastAiredAt: row.last_aired_at || '',
            airCount: row.air_count || 0,
            rotationWeight: row.rotation_weight || 1,
            commercialPriority: row.commercial_priority || 'normal',
            dailyLimit: row.daily_limit || 0,
            separationRule: row.separation_rule || 'category',
            frequencyRule: row.frequency_rule || 'manual',
            copyNotes: row.copy_notes || '',
            trafficNotes: row.traffic_notes || '',
            notes: row.notes || ''
        };
    }

    ipcMain.handle('commercial-get-blocks', () => {
        try {
            const blocks = db.prepare("SELECT * FROM commercial_blocks ORDER BY COALESCE(primary_time, '99:99:99'), name COLLATE NOCASE").all();
            const itemsStmt = db.prepare('SELECT * FROM commercial_block_items WHERE block_id = ? ORDER BY sort_order ASC');
            return blocks.map(block => ({
                id: block.id,
                name: block.name,
                mode: block.mode || 'basic',
                enabled: block.enabled !== 0,
                priority: block.priority || 'normal',
                action: block.action || 'temp',
                execution: block.execution || 'wait',
                primaryTime: block.primary_time || '',
                repeatActive: block.repeat_active === 1,
                repeatInterval: block.repeat_interval || 0,
                repeatUnit: block.repeat_unit || 'minutes',
                validityStart: block.validity_start || null,
                validityEnd: block.validity_end || null,
                notes: block.notes || '',
                items: itemsStmt.all(block.id).map(item => ({
                    id: item.id,
                    sourceType: item.source_type || 'file',
                    filePath: item.file_path,
                    title: item.title || path.basename(item.file_path || ''),
                    duration: item.duration || 0,
                    temp: item.temp !== 0
                }))
            }));
        } catch (err) {
            writeLog('Error commercial-get-blocks: ' + err.message);
            return [];
        }
    });

    ipcMain.handle('commercial-save-block', (e, block) => {
        try {
            const now = new Date().toISOString();
            const safeBlock = block || {};
            const id = safeBlock.id || `com_${Date.now()}`;
            const items = Array.isArray(safeBlock.items) ? safeBlock.items : [];
            db.transaction(() => {
                db.prepare(`INSERT INTO commercial_blocks (id, name, mode, enabled, priority, action, execution, primary_time, repeat_active, repeat_interval, repeat_unit, validity_start, validity_end, notes, created_at, updated_at)
                    VALUES (@id, @name, @mode, @enabled, @priority, @action, @execution, @primaryTime, @repeatActive, @repeatInterval, @repeatUnit, @validityStart, @validityEnd, @notes, @createdAt, @updatedAt)
                    ON CONFLICT(id) DO UPDATE SET name=@name, mode=@mode, enabled=@enabled, priority=@priority, action=@action, execution=@execution, primary_time=@primaryTime, repeat_active=@repeatActive, repeat_interval=@repeatInterval, repeat_unit=@repeatUnit, validity_start=@validityStart, validity_end=@validityEnd, notes=@notes, updated_at=@updatedAt`).run({
                    id,
                    name: safeBlock.name || 'Bloque comercial',
                    mode: safeBlock.mode === 'advanced' ? 'advanced' : 'basic',
                    enabled: safeBlock.enabled === false ? 0 : 1,
                    priority: safeBlock.priority || 'normal',
                    action: safeBlock.action || 'temp',
                    execution: safeBlock.execution || 'wait',
                    primaryTime: safeBlock.primaryTime || null,
                    repeatActive: safeBlock.repeatActive ? 1 : 0,
                    repeatInterval: parseInt(safeBlock.repeatInterval, 10) || 0,
                    repeatUnit: safeBlock.repeatUnit || 'minutes',
                    validityStart: safeBlock.validityStart || null,
                    validityEnd: safeBlock.validityEnd || null,
                    notes: safeBlock.notes || '',
                    createdAt: safeBlock.createdAt || now,
                    updatedAt: now
                });
                db.prepare('DELETE FROM commercial_block_items WHERE block_id = ?').run(id);
                const itemStmt = db.prepare(`INSERT INTO commercial_block_items (id, block_id, sort_order, source_type, file_path, title, duration, temp, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                items.forEach((item, index) => {
                    if (!item || !item.filePath) return;
                    itemStmt.run(item.id || `${id}_item_${Date.now()}_${index}`, id, index, item.sourceType || 'file', item.filePath, item.title || path.basename(item.filePath), Number(item.duration) || 0, item.temp === false ? 0 : 1, now, now);
                });
            })();
            return { success: true, id };
        } catch (err) {
            writeLog('Error commercial-save-block: ' + err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('commercial-delete-block', (e, id) => {
        try {
            db.transaction(() => {
                db.prepare('DELETE FROM commercial_block_items WHERE block_id = ?').run(id);
                db.prepare('DELETE FROM commercial_blocks WHERE id = ?').run(id);
            })();
            return { success: true };
        } catch (err) {
            writeLog('Error commercial-delete-block: ' + err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('commercial-dialog-add-files', async () => {
        const res = await dialog.showOpenDialog(context.commercialManagerWindow || context.mainWindow, { title: 'Agregar comerciales', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio', extensions: ['mp3','wav','ogg','flac','m4a','aac','aiff','aif','mp2'] }] });
        return (!res.canceled && res.filePaths.length > 0) ? res.filePaths : [];
    });

    ipcMain.handle('commercial-get-settings', () => {
        try {
            const rows = db.prepare('SELECT key, value FROM commercial_settings').all();
            const settings = rows.reduce((acc, row) => { acc[row.key] = row.value; return acc; }, {});
            
            // Integración desde la raíz con el Gestor de Tipos de Archivo
            const fs = require('fs');
            const fileTypesPath = path.join(context.configDir, 'file_types.json');
            if (fs.existsSync(fileTypesPath)) {
                try {
                    const fileTypes = JSON.parse(fs.readFileSync(fileTypesPath, 'utf8'));
                    const comType = fileTypes.find(t => t.id === 't_comercial');
                    if (comType && comType.shortcutRoot) settings.commercialsRoot = comType.shortcutRoot;
                    const jingType = fileTypes.find(t => t.id === 't_station_id');
                    if (jingType && jingType.shortcutRoot) settings.jinglesRoot = jingType.shortcutRoot;
                } catch (e) {}
            }
            return settings;
        } catch (err) {
            writeLog('Error commercial-get-settings: ' + err.message);
            return {};
        }
    });

    ipcMain.handle('commercial-set-root', async (e, rootType) => {
        try {
            const safeType = rootType === 'jingles' ? 'jingles' : 'commercials';
            const res = await dialog.showOpenDialog(context.commercialManagerWindow || context.mainWindow, { title: safeType === 'jingles' ? 'Seleccionar raiz de jingles' : 'Seleccionar raiz de comerciales', properties: ['openDirectory'] });
            if (res.canceled || res.filePaths.length === 0) return { success: false };
            const selectedPath = res.filePaths[0];
            
            db.prepare('INSERT INTO commercial_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${safeType}Root`, selectedPath);
            
            // Integración desde la raíz con el Gestor de Tipos de Archivo
            const fs = require('fs');
            const fileTypesPath = path.join(context.configDir, 'file_types.json');
            if (fs.existsSync(fileTypesPath)) {
                try {
                    const fileTypes = JSON.parse(fs.readFileSync(fileTypesPath, 'utf8'));
                    const targetId = safeType === 'commercials' ? 't_comercial' : 't_station_id';
                    let typeObj = fileTypes.find(t => t.id === targetId);
                    if (!typeObj) {
                        typeObj = { id: targetId, showShortcut: true };
                        fileTypes.push(typeObj);
                    }
                    typeObj.shortcutRoot = selectedPath;
                    fs.writeFileSync(fileTypesPath, JSON.stringify(fileTypes, null, 2), 'utf8');
                    
                    if (context.mainWindow) {
                        context.mainWindow.webContents.send('file-types-data-updated');
                    }
                } catch (e) {
                    writeLog('Error saving file_types.json: ' + e.message);
                }
            }
            
            return { success: true, path: selectedPath };
        } catch (err) {
            writeLog('Error commercial-set-root: ' + err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('commercial-get-categories', () => {
        try {
            return db.prepare('SELECT id, name, color, is_builtin, sort_order FROM commercial_categories ORDER BY sort_order, name COLLATE NOCASE').all().map(row => ({
                id: row.id,
                name: row.name,
                color: row.color || '#00a8ff',
                isBuiltin: row.is_builtin === 1,
                sortOrder: row.sort_order || 0
            }));
        } catch (err) {
            writeLog('Error commercial-get-categories: ' + err.message);
            return [];
        }
    });

    ipcMain.handle('commercial-save-category', (e, category = {}) => {
        try {
            const rawName = String(category.name || '').trim();
            if (!rawName) return { success: false, error: 'Nombre requerido' };
            const id = String(category.id || rawName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `cat_${Date.now()}`).slice(0, 64);
            const existing = db.prepare('SELECT is_builtin FROM commercial_categories WHERE id = ?').get(id);
            if (existing?.is_builtin === 1) return { success: false, error: 'Las categorias predeterminadas no se renombran aqui' };
            const now = new Date().toISOString();
            db.prepare(`INSERT INTO commercial_categories (id, name, color, is_builtin, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, 0, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color, updated_at=excluded.updated_at`)
                .run(id, rawName, category.color || '#00a8ff', category.sortOrder || 50, now, now);
            return { success: true, id };
        } catch (err) {
            writeLog('Error commercial-save-category: ' + err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('commercial-delete-category', (e, id) => {
        try {
            const row = db.prepare('SELECT is_builtin FROM commercial_categories WHERE id = ?').get(id);
            if (!row) return { success: true };
            if (row.is_builtin === 1) return { success: false, error: 'Categoria predeterminada' };
            db.transaction(() => {
                db.prepare("UPDATE commercial_assets SET category = 'other', updated_at = ? WHERE category = ?").run(new Date().toISOString(), id);
                db.prepare('DELETE FROM commercial_categories WHERE id = ?').run(id);
            })();
            return { success: true };
        } catch (err) {
            writeLog('Error commercial-delete-category: ' + err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('commercial-get-assets', (e, filters = {}) => {
        try {
            const where = [];
            const args = [];
            const now = new Date().toISOString();
            if (filters.rootType && filters.rootType !== 'all') { where.push('root_type = ?'); args.push(filters.rootType); }
            if (filters.category && filters.category !== 'all') { where.push('category = ?'); args.push(filters.category); }
            if (filters.status && filters.status !== 'all') {
                if (filters.status === 'active') {
                    where.push("enabled = 1 AND COALESCE(status, 'draft') != 'draft' AND (validity_start IS NULL OR validity_start = '' OR validity_start <= ?) AND (validity_end IS NULL OR validity_end = '' OR validity_end >= ?)");
                    args.push(now, now);
                } else if (filters.status === 'upcoming') {
                    where.push("enabled = 1 AND validity_start IS NOT NULL AND validity_start != '' AND validity_start > ?");
                    args.push(now);
                } else if (filters.status === 'expiring') {
                    const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
                    where.push("enabled = 1 AND COALESCE(status, 'draft') != 'draft' AND validity_end IS NOT NULL AND validity_end != '' AND validity_end >= ? AND validity_end <= ?");
                    args.push(now, soon);
                } else if (filters.status === 'expired') {
                    where.push("(COALESCE(status, '') = 'expired' OR (validity_end IS NOT NULL AND validity_end != '' AND validity_end < ?))");
                    args.push(now);
                } else if (filters.status === 'draft') {
                    where.push("COALESCE(status, 'draft') = 'draft'");
                } else if (filters.status === 'paused') {
                    where.push('enabled = 0');
                }
            }
            if (filters.search) {
                where.push('(title LIKE ? OR file_path LIKE ? OR client_name LIKE ? OR campaign_name LIKE ? OR contract_code LIKE ?)');
                args.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
            }
            const sql = `SELECT * FROM commercial_assets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY category, title COLLATE NOCASE LIMIT 3000`;
            return db.prepare(sql).all(...args).map(commercialAssetToDto);
        } catch (err) {
            writeLog('Error commercial-get-assets: ' + err.message);
            return [];
        }
    });

    ipcMain.handle('commercial-import-paths', async (e, payload = {}) => {
        try {
            const paths = Array.isArray(payload.paths) ? payload.paths : [];
            const rootType = payload.rootType === 'jingles' ? 'jingles' : 'commercials';
            const category = payload.category || (rootType === 'jingles' ? 'jingle' : 'paid');
            const assets = await scanCommercialPathsInWorker(paths);
            const now = new Date().toISOString();
            const stmt = db.prepare(`INSERT INTO commercial_assets (file_path, title, root_type, category, commercial_type, billing_mode, folder_path, duration, enabled, status, entered_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?, ?)
                ON CONFLICT(file_path) DO UPDATE SET title=excluded.title, root_type=excluded.root_type, category=excluded.category, commercial_type=excluded.commercial_type, billing_mode=excluded.billing_mode, folder_path=excluded.folder_path, updated_at=excluded.updated_at`);
            const logStmt = db.prepare('INSERT INTO commercial_logs (id, asset_path, action, message, at, meta_json) VALUES (?, ?, ?, ?, ?, ?)');
            db.transaction(() => {
                assets.forEach(asset => {
                    stmt.run(asset.filePath, asset.title, rootType, category, category, commercialBillingForCategory(category), asset.folderPath, 0, now, now, now);
                    logStmt.run(`log_${Date.now()}_${Math.random().toString(16).slice(2)}`, asset.filePath, 'import', 'Importado a biblioteca comercial', now, JSON.stringify({ rootType, category }));
                });
            })();
            return { success: true, count: assets.length };
        } catch (err) {
            writeLog('Error commercial-import-paths: ' + err.message);
            return { success: false, error: err.message, count: 0 };
        }
    });

    ipcMain.handle('commercial-scan-root', async (e, payload = {}) => {
        const settings = db.prepare('SELECT key, value FROM commercial_settings').all().reduce((acc, row) => { acc[row.key] = row.value; return acc; }, {});
        const rootType = payload.rootType === 'jingles' ? 'jingles' : 'commercials';
        const root = settings[`${rootType}Root`];
        if (!root) return { success: false, error: 'Raiz no configurada', count: 0 };
        return await (async () => {
            const category = payload.category || (rootType === 'jingles' ? 'jingle' : 'paid');
            const assets = await scanCommercialPathsInWorker([root]);
            const now = new Date().toISOString();
            const stmt = db.prepare(`INSERT INTO commercial_assets (file_path, title, root_type, category, commercial_type, billing_mode, folder_path, duration, enabled, status, entered_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?, ?)
                ON CONFLICT(file_path) DO UPDATE SET title=excluded.title, root_type=excluded.root_type, category=COALESCE(commercial_assets.category, excluded.category), folder_path=excluded.folder_path, updated_at=excluded.updated_at`);
            db.transaction(() => {
                assets.forEach(asset => stmt.run(asset.filePath, asset.title, rootType, category, category, commercialBillingForCategory(category), asset.folderPath, 0, now, now, now));
            })();
            return { success: true, count: assets.length };
        })();
    });

    ipcMain.handle('commercial-update-assets-category', (e, payload = {}) => {
        try {
            const paths = Array.isArray(payload.paths) ? payload.paths : [];
            if (paths.length === 0) return { success: true, count: 0 };
            const category = payload.category || 'paid';
            const stmt = db.prepare('UPDATE commercial_assets SET category = ?, updated_at = ? WHERE file_path = ?');
            const now = new Date().toISOString();
            db.transaction(() => paths.forEach(filePath => stmt.run(category, now, filePath)))();
            return { success: true, count: paths.length };
        } catch (err) {
            writeLog('Error commercial-update-assets-category: ' + err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('commercial-save-asset-metadata', (e, asset = {}) => {
        try {
            if (!asset.filePath) return { success: false, error: 'Archivo requerido' };
            const now = new Date().toISOString();
            const current = db.prepare('SELECT file_path FROM commercial_assets WHERE file_path = ?').get(asset.filePath);
            if (!current) return { success: false, error: 'El archivo no existe en la biblioteca comercial' };
            db.prepare(`UPDATE commercial_assets SET
                title = ?, category = ?, commercial_type = ?, billing_mode = ?, client_name = ?, campaign_name = ?, contract_code = ?,
                enabled = ?, status = ?, entered_at = ?, first_air_at = ?, validity_start = ?, validity_end = ?,
                rotation_weight = ?, commercial_priority = ?, daily_limit = ?, separation_rule = ?, frequency_rule = ?,
                copy_notes = ?, traffic_notes = ?, notes = ?, updated_at = ?
                WHERE file_path = ?`).run(
                    asset.title || path.basename(asset.filePath),
                    asset.category || 'other',
                    asset.commercialType || asset.category || 'other',
                    asset.billingMode || commercialBillingForCategory(asset.category || 'other'),
                    asset.clientName || '',
                    asset.campaignName || '',
                    asset.contractCode || '',
                    asset.enabled === false ? 0 : 1,
                    asset.status || 'draft',
                    asset.enteredAt || now,
                    asset.firstAirAt || null,
                    asset.validityStart || null,
                    asset.validityEnd || null,
                    Math.max(1, parseInt(asset.rotationWeight, 10) || 1),
                    asset.commercialPriority || 'normal',
                    Math.max(0, parseInt(asset.dailyLimit, 10) || 0),
                    asset.separationRule || 'category',
                    asset.frequencyRule || 'manual',
                    asset.copyNotes || '',
                    asset.trafficNotes || '',
                    asset.notes || '',
                    now,
                    asset.filePath
                );
            db.prepare('INSERT INTO commercial_logs (id, asset_path, action, message, at, meta_json) VALUES (?, ?, ?, ?, ?, ?)')
                .run(`log_${Date.now()}_${Math.random().toString(16).slice(2)}`, asset.filePath, 'metadata', 'Ficha comercial actualizada', now, JSON.stringify({ status: asset.status, category: asset.category }));
            return { success: true };
        } catch (err) {
            writeLog('Error commercial-save-asset-metadata: ' + err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('commercial-get-asset-logs', (e, filePath) => {
        try {
            if (!filePath) return [];
            return db.prepare('SELECT action, message, at, meta_json FROM commercial_logs WHERE asset_path = ? ORDER BY at DESC LIMIT 80').all(filePath).map(row => ({
                action: row.action || '',
                message: row.message || '',
                at: row.at || '',
                meta: row.meta_json || ''
            }));
        } catch (err) {
            writeLog('Error commercial-get-asset-logs: ' + err.message);
            return [];
        }
    });
};
