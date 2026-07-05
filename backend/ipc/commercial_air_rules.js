module.exports = function registerCommercialAirRules(context) {
    const { ipcMain, db, writeLog } = context;

    function normalizeDay(day) {
        const value = Number(day);
        return Number.isInteger(value) && value >= 0 && value <= 6 ? String(value) : '1';
    }

    function normalizeTime(time) {
        const match = String(time || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
        return match ? `${match[1]}:${match[2]}` : '10:00';
    }

    function parseSlots(json) {
        try {
            const raw = JSON.parse(json || '{}');
            return Object.fromEntries(Object.entries(raw).map(([day, times]) => [
                normalizeDay(day),
                [...new Set((Array.isArray(times) ? times : []).map(normalizeTime))].sort()
            ]));
        } catch (err) {
            return {};
        }
    }

    function encodeSlots(slots) {
        const clean = {};
        Object.entries(slots || {}).forEach(([day, times]) => {
            const normalized = [...new Set((Array.isArray(times) ? times : []).map(normalizeTime))].sort();
            if (normalized.length) clean[normalizeDay(day)] = normalized;
        });
        return JSON.stringify(clean);
    }

    function rowToDto(row) {
        return {
            assetPath: row.asset_path,
            enabled: row.enabled !== 0,
            daySlots: parseSlots(row.day_slots_json),
            validityStart: row.validity_start || '',
            validityEnd: row.validity_end || '',
            priority: row.priority || 'normal',
            notes: row.notes || ''
        };
    }

    function getRule(assetPath) {
        const row = db.prepare('SELECT * FROM commercial_air_rules WHERE asset_path = ?').get(assetPath);
        return row ? rowToDto(row) : {
            assetPath,
            enabled: true,
            daySlots: {},
            validityStart: '',
            validityEnd: '',
            priority: 'normal',
            notes: ''
        };
    }

    function saveRule(rule) {
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO commercial_air_rules (asset_path, enabled, day_slots_json, validity_start, validity_end, priority, notes, created_at, updated_at)
            VALUES (@assetPath, @enabled, @daySlotsJson, @validityStart, @validityEnd, @priority, @notes, @createdAt, @updatedAt)
            ON CONFLICT(asset_path) DO UPDATE SET enabled=@enabled, day_slots_json=@daySlotsJson, validity_start=@validityStart, validity_end=@validityEnd, priority=@priority, notes=@notes, updated_at=@updatedAt`).run({
            assetPath: rule.assetPath,
            enabled: rule.enabled === false ? 0 : 1,
            daySlotsJson: encodeSlots(rule.daySlots),
            validityStart: rule.validityStart || null,
            validityEnd: rule.validityEnd || null,
            priority: rule.priority || 'normal',
            notes: rule.notes || '',
            createdAt: now,
            updatedAt: now
        });
    }

    function readAllRules() {
        return db.prepare('SELECT * FROM commercial_air_rules ORDER BY asset_path COLLATE NOCASE').all().map(rowToDto);
    }

    ipcMain.handle('commercial-get-air-rules', () => {
        try {
            return readAllRules();
        } catch (err) {
            writeLog('Error commercial-get-air-rules: ' + err.message);
            return [];
        }
    });

    ipcMain.handle('commercial-toggle-air-slot', (e, payload = {}) => {
        try {
            const assetPaths = [...new Set((Array.isArray(payload.assetPaths) ? payload.assetPaths : []).filter(Boolean))];
            if (!assetPaths.length) return { success: false, error: 'Selecciona al menos un comercial' };
            const day = normalizeDay(payload.day);
            const time = normalizeTime(payload.time);
            const rules = assetPaths.map(getRule);
            const allHaveSlot = rules.every(rule => (rule.daySlots[day] || []).includes(time));

            db.transaction(() => {
                rules.forEach(rule => {
                    const times = new Set(rule.daySlots[day] || []);
                    if (allHaveSlot) times.delete(time);
                    else times.add(time);
                    rule.daySlots[day] = [...times].sort();
                    saveRule(rule);
                });
            })();

            return { success: true, rules: readAllRules(), action: allHaveSlot ? 'removed' : 'added' };
        } catch (err) {
            writeLog('Error commercial-toggle-air-slot: ' + err.message);
            return { success: false, error: err.message };
        }
    });

    function applyToggle(assetPaths, slots) {
        const rules = assetPaths.map(getRule);
        const allHaveSlots = rules.every(rule => slots.every(slot => (rule.daySlots[slot.day] || []).includes(slot.time)));
        db.transaction(() => {
            rules.forEach(rule => {
                slots.forEach(slot => {
                    const times = new Set(rule.daySlots[slot.day] || []);
                    if (allHaveSlots) times.delete(slot.time);
                    else times.add(slot.time);
                    rule.daySlots[slot.day] = [...times].sort();
                });
                saveRule(rule);
            });
        })();
        return { success: true, rules: readAllRules(), action: allHaveSlots ? 'removed' : 'added' };
    }

    ipcMain.handle('commercial-toggle-air-day', (e, payload = {}) => {
        try {
            const assetPaths = [...new Set((Array.isArray(payload.assetPaths) ? payload.assetPaths : []).filter(Boolean))];
            const times = (Array.isArray(payload.times) ? payload.times : []).map(normalizeTime);
            if (!assetPaths.length) return { success: false, error: 'Selecciona al menos un comercial' };
            if (!times.length) return { success: false, error: 'No hay horarios configurados' };
            const day = normalizeDay(payload.day);
            return applyToggle(assetPaths, times.map(time => ({ day, time })));
        } catch (err) {
            writeLog('Error commercial-toggle-air-day: ' + err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('commercial-toggle-air-time', (e, payload = {}) => {
        try {
            const assetPaths = [...new Set((Array.isArray(payload.assetPaths) ? payload.assetPaths : []).filter(Boolean))];
            if (!assetPaths.length) return { success: false, error: 'Selecciona al menos un comercial' };
            const time = normalizeTime(payload.time);
            return applyToggle(assetPaths, ['0', '1', '2', '3', '4', '5', '6'].map(day => ({ day, time })));
        } catch (err) {
            writeLog('Error commercial-toggle-air-time: ' + err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('commercial-save-air-rule-meta', (e, payload = {}) => {
        try {
            const assetPaths = [...new Set((Array.isArray(payload.assetPaths) ? payload.assetPaths : []).filter(Boolean))];
            if (!assetPaths.length) return { success: false, error: 'Selecciona al menos un comercial' };
            const meta = payload.meta || {};
            db.transaction(() => {
                assetPaths.forEach(assetPath => {
                    const rule = getRule(assetPath);
                    if ('enabled' in meta) rule.enabled = meta.enabled !== false;
                    if ('validityStart' in meta) rule.validityStart = meta.validityStart || '';
                    if ('validityEnd' in meta) rule.validityEnd = meta.validityEnd || '';
                    if ('priority' in meta) rule.priority = meta.priority || 'normal';
                    if ('notes' in meta) rule.notes = meta.notes || '';
                    saveRule(rule);
                });
            })();
            return { success: true, rules: readAllRules() };
        } catch (err) {
            writeLog('Error commercial-save-air-rule-meta: ' + err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('commercial-get-generated-slot', (e, payload = {}) => {
        try {
            const day = normalizeDay(payload.day);
            const time = normalizeTime(payload.time);
            const paths = readAllRules()
                .filter(rule => rule.enabled && (rule.daySlots[day] || []).includes(time))
                .map(rule => rule.assetPath);
            if (!paths.length) return { day, time, items: [] };
            const placeholders = paths.map(() => '?').join(',');
            const rows = db.prepare(`SELECT file_path, title, client_name, campaign_name, duration FROM commercial_assets WHERE file_path IN (${placeholders}) ORDER BY title COLLATE NOCASE`).all(...paths);
            return {
                day,
                time,
                items: rows.map(row => ({
                    filePath: row.file_path,
                    title: row.client_name || row.campaign_name || row.title || row.file_path,
                    duration: Number(row.duration) || 0
                }))
            };
        } catch (err) {
            writeLog('Error commercial-get-generated-slot: ' + err.message);
            return { day: '1', time: '10:00', items: [], error: err.message };
        }
    });
};
