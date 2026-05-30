module.exports = function(context) {
    const { ipcMain, db,   writeLog } = context;

    function safeJsonParse(value, fallback = []) {
        try {
            const parsed = JSON.parse(value || JSON.stringify(fallback));
            return Array.isArray(parsed) ? parsed : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function notifyWindow(win, channel, payload) {
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    }

    function notifyEventGroupsChanged() {
        notifyWindow(context.mainWindow, 'refresh-event-groups');
        notifyWindow(context.eventEditorWindow, 'refresh-event-groups');
        notifyWindow(context.calendarWindow, 'refresh-event-groups');
    }

    function notifyEventsChanged(payload) {
        notifyWindow(context.mainWindow, 'refresh-events', payload);
        notifyWindow(context.calendarWindow, 'refresh-events', payload);
    }

    ipcMain.handle('db-get-groups', () => {
        try { return db.prepare("SELECT * FROM event_groups").all().map(r => ({ id: r.id, name: r.name, colorBg: r.color_bg, colorText: r.color_text, readonly: r.is_readonly === 1 })); }
        catch(e) { return []; }
    });

    ipcMain.handle('db-save-groups', (e, groups) => {
        try {
            const normalizedGroups = Array.isArray(groups) ? groups.filter(g => g && g.id && g.name && String(g.name).trim()) : [];
            if (!normalizedGroups.some(g => g.id === 'g_general')) {
                normalizedGroups.unshift({ id: 'g_general', name: 'General', colorBg: '#222225', colorText: '#00a8ff', readonly: true });
            }
            const currentIds = normalizedGroups.map(g => g.id);
            const placeholders = currentIds.map(() => '?').join(',');
            const insertStmt = db.prepare("INSERT INTO event_groups (id, name, color_bg, color_text, is_readonly) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, color_bg=excluded.color_bg, color_text=excluded.color_text");
            db.transaction(() => {
                if (currentIds.length > 0) {
                    db.prepare(`UPDATE events SET group_id = 'g_general' WHERE group_id IS NULL OR group_id = '' OR group_id NOT IN (${placeholders})`).run(...currentIds);
                    db.prepare(`DELETE FROM event_groups WHERE is_readonly = 0 AND id NOT IN (${placeholders})`).run(...currentIds);
                }
                for (let g of normalizedGroups) insertStmt.run(g.id, g.name, g.colorBg || '#222225', g.colorText || '#00a8ff', (g.readonly || g.id === 'g_general') ? 1 : 0);
            })();
            notifyEventGroupsChanged();
            notifyEventsChanged();
            return { success: true };
        } catch(err) {
            writeLog("Error save groups: "+ err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('db-get-events', () => {
        try {
            return db.prepare("SELECT * FROM events").all().map(r => ({ id: r.id, name: r.name, group: r.group_id, sourceType: r.source_type, filePath: r.file_path, primaryTime: r.primary_time, otherHours: safeJsonParse(r.other_hours), dayMode: r.day_mode, specificDays: safeJsonParse(r.specific_days), targetWeeks: safeJsonParse(r.target_weeks), validityStart: r.validity_start, validityEnd: r.validity_end, action: r.action, execution: r.execution, priority: r.priority || 'normal', colorText: r.color_text, colorBg: r.color_bg, requirePlaying: r.require_playing === 1, maxDelayActive: r.max_delay_active === 1, maxDelayMinutes: r.max_delay_minutes, maxDelaySeconds: r.max_delay_seconds, maxDelayTime: r.max_delay_time, maxDelayAction: r.max_delay_action, cyclicActive: r.cyclic_active === 1, cyclicInterval: r.cyclic_interval, cyclicUnit: r.cyclic_unit, cyclicLimit: r.cyclic_limit, lastFired: r.last_fired }));
        } catch(e) { return []; }
    });

    ipcMain.on('save-event', (e, savedEvent) => {
        try {
            const parseNum = (val) => (val !== '' && val !== null && val !== undefined && !isNaN(val)) ? parseFloat(val) : null;
            const stmt = db.prepare(`INSERT INTO events (id, name, group_id, source_type, file_path, primary_time, other_hours, day_mode, specific_days, target_weeks, validity_start, validity_end, action, execution, priority, color_text, color_bg, require_playing, max_delay_active, max_delay_minutes, max_delay_seconds, max_delay_time, max_delay_action, cyclic_active, cyclic_interval, cyclic_unit, cyclic_limit, last_fired) VALUES (@id, @name, @group, @sourceType, @filePath, @primaryTime, @otherHours, @dayMode, @specificDays, @targetWeeks, @validityStart, @validityEnd, @action, @execution, @priority, @colorText, @colorBg, @requirePlaying, @maxDelayActive, @maxDelayMinutes, @maxDelaySeconds, @maxDelayTime, @maxDelayAction, @cyclicActive, @cyclicInterval, @cyclicUnit, @cyclicLimit, @lastFired) ON CONFLICT(id) DO UPDATE SET name=@name, group_id=@group, source_type=@sourceType, file_path=@filePath, primary_time=@primaryTime, other_hours=@otherHours, day_mode=@dayMode, specific_days=@specificDays, target_weeks=@targetWeeks, validity_start=@validityStart, validity_end=@validityEnd, action=@action, execution=@execution, priority=@priority, color_text=@colorText, color_bg=@colorBg, require_playing=@requirePlaying, max_delay_active=@maxDelayActive, max_delay_minutes=@maxDelayMinutes, max_delay_seconds=@maxDelaySeconds, max_delay_time=@maxDelayTime, max_delay_action=@maxDelayAction, cyclic_active=@cyclicActive, cyclic_interval=@cyclicInterval, cyclic_unit=@cyclicUnit, cyclic_limit=@cyclicLimit, last_fired=@lastFired`);
            stmt.run({ id: savedEvent.id, name: savedEvent.name, group: savedEvent.group, sourceType: savedEvent.sourceType, filePath: savedEvent.filePath, primaryTime: savedEvent.primaryTime, otherHours: JSON.stringify(savedEvent.otherHours||[]), dayMode: savedEvent.dayMode, specificDays: JSON.stringify(savedEvent.specificDays||[]), targetWeeks: JSON.stringify(savedEvent.targetWeeks||[]), validityStart: savedEvent.validityStart || null, validityEnd: savedEvent.validityEnd || null, action: savedEvent.action, execution: savedEvent.execution, priority: savedEvent.priority || 'normal', colorText: savedEvent.colorText, colorBg: savedEvent.colorBg, requirePlaying: savedEvent.requirePlaying ? 1 : 0, maxDelayActive: savedEvent.maxDelayActive ? 1 : 0, maxDelayMinutes: parseNum(savedEvent.maxDelayMinutes) || 0, maxDelaySeconds: parseNum(savedEvent.maxDelaySeconds) || 0, maxDelayTime: parseNum(savedEvent.maxDelayTime) || 0, maxDelayAction: savedEvent.maxDelayAction, cyclicActive: savedEvent.cyclicActive ? 1 : 0, cyclicInterval: parseNum(savedEvent.cyclicInterval) || 0, cyclicUnit: savedEvent.cyclicUnit, cyclicLimit: parseNum(savedEvent.cyclicLimit) || 0, lastFired: savedEvent.lastFired || null });
            notifyEventsChanged(savedEvent);
            if (context.eventEditorWindow && !context.eventEditorWindow.isDestroyed()) context.eventEditorWindow.close();
        } catch (err) { writeLog("Error guardando evento: " + err); }
    });

    ipcMain.on('db-save-events-full', (e, events) => {
        try {
            db.transaction(() => {
                db.prepare('DELETE FROM events').run();
                const stmt = db.prepare(`INSERT INTO events (id, name, group_id, source_type, file_path, primary_time, other_hours, day_mode, specific_days, target_weeks, validity_start, validity_end, action, execution, priority, color_text, color_bg, require_playing, max_delay_active, max_delay_minutes, max_delay_seconds, max_delay_time, max_delay_action, cyclic_active, cyclic_interval, cyclic_unit, cyclic_limit, last_fired) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
                for(let ev of events) {
                    stmt.run(ev.id, ev.name, ev.group||'g_general', ev.sourceType, ev.filePath, ev.primaryTime, JSON.stringify(ev.otherHours||[]), ev.dayMode, JSON.stringify(ev.specificDays||[]), JSON.stringify(ev.targetWeeks||[]), ev.validityStart, ev.validityEnd, ev.action, ev.execution, ev.priority || 'normal', ev.colorText, ev.colorBg, ev.requirePlaying?1:0, ev.maxDelayActive?1:0, ev.maxDelayMinutes, ev.maxDelaySeconds, ev.maxDelayTime, ev.maxDelayAction, ev.cyclicActive?1:0, ev.cyclicInterval, ev.cyclicUnit, ev.cyclicLimit, ev.lastFired);
                }
            })();
        } catch(err) { writeLog("Error save-events-full: " + err); }
    });

    // ====================================================================
    // PARRILLA DE PROGRAMACIÃ“N (schedule_programs)
    // ====================================================================

    ipcMain.handle('db-get-schedule', () => {
        try {
            return db.prepare("SELECT * FROM schedule_programs ORDER BY start_time").all().map(r => ({
                id: r.id,
                name: r.name,
                host: r.host,
                style: r.style,
                dayMode: r.day_mode,
                specificDays: JSON.parse(r.specific_days || '[]'),
                startTime: r.start_time,
                endTime: r.end_time,
                colorBg: r.color_bg,
                colorText: r.color_text,
                notes: r.notes,
                enabled: r.enabled === 1,
                sortOrder: r.sort_order,
                createdAt: r.created_at,
                updatedAt: r.updated_at
            }));
        } catch (e) {
            writeLog("Error db-get-schedule: " + e);
            return [];
        }
    });

    ipcMain.on('db-save-schedule-item', (e, item) => {
        try {
            const now = new Date().toISOString();
            const stmt = db.prepare(`INSERT INTO schedule_programs
                (id, name, host, style, day_mode, specific_days, start_time, end_time, color_bg, color_text, notes, enabled, sort_order, created_at, updated_at)
                VALUES (@id, @name, @host, @style, @dayMode, @specificDays, @startTime, @endTime, @colorBg, @colorText, @notes, @enabled, @sortOrder, @createdAt, @updatedAt)
                ON CONFLICT(id) DO UPDATE SET
                    name=@name, host=@host, style=@style, day_mode=@dayMode, specific_days=@specificDays,
                    start_time=@startTime, end_time=@endTime, color_bg=@colorBg, color_text=@colorText,
                    notes=@notes, enabled=@enabled, sort_order=@sortOrder, updated_at=@updatedAt`);
            stmt.run({
                id: item.id,
                name: item.name,
                host: item.host || '',
                style: item.style || 'musical',
                dayMode: item.dayMode || 'specific',
                specificDays: JSON.stringify(item.specificDays || []),
                startTime: item.startTime,
                endTime: item.endTime,
                colorBg: item.colorBg || '#34495e',
                colorText: item.colorText || '#ffffff',
                notes: item.notes || '',
                enabled: item.enabled !== false ? 1 : 0,
                sortOrder: item.sortOrder || 0,
                createdAt: item.createdAt || now,
                updatedAt: now
            });
            // Notificar a la ventana del calendario si estÃ¡ abierta
            if (context.calendarWindow && !context.calendarWindow.isDestroyed()) {
                context.calendarWindow.webContents.send('refresh-schedule');
            }
        } catch (err) {
            writeLog("Error db-save-schedule-item: " + err);
        }
    });

    ipcMain.handle('db-delete-schedule-item', (e, id) => {
        try {
            db.prepare("DELETE FROM schedule_programs WHERE id = ?").run(id);
            if (context.calendarWindow && !context.calendarWindow.isDestroyed()) {
                context.calendarWindow.webContents.send('refresh-schedule');
            }
            return { success: true };
        } catch (err) {
            writeLog("Error db-delete-schedule-item: " + err);
            return { success: false, error: err.message };
        }
    });

    // ====================================================================
    // RELOJ DE EVENTOS — Main Process (libera el hilo del renderer)
    // La comprobación de hora y el cálculo de tiempos expandidos corren
    // aquí; el renderer solo recibe un aviso y ejecuta la acción en DOM.
    // ====================================================================

    let localEventsDB = [];
    const _expandedTimesCache = new Map(); // evId → { key, times }

    function _pad(n) { return n.toString().padStart(2, '0'); }

    function _isDateValidForEvent(d, ev) {
        if (ev.dayMode === 'specific' && ev.specificDays && ev.specificDays.length > 0) {
            if (!ev.specificDays.includes(d.getDay())) return false;
        }
        const testDate = new Date(d.getTime()); testDate.setHours(0, 0, 0, 0);
        if (ev.validityStart) { const start = new Date(ev.validityStart + 'T00:00:00'); if (testDate < start) return false; }
        if (ev.validityEnd)   { const end   = new Date(ev.validityEnd   + 'T00:00:00'); if (testDate > end)   return false; }
        if (ev.dayMode === 'monthlyWeeks') {
            if (!ev.targetWeeks || ev.targetWeeks.length === 0) return false;
            const dom = d.getDate();
            const weekIds = [Math.min(5, Math.ceil(dom / 7))];
            const plusSeven = new Date(d.getTime()); plusSeven.setDate(dom + 7);
            if (plusSeven.getMonth() !== d.getMonth()) weekIds.push(5);
            if (!ev.targetWeeks.some(week => weekIds.includes(week))) return false;
        }
        return true;
    }

    function _getExpandedEventTimesCached(ev) {
        const cacheKey = `${ev.primaryTime}|${JSON.stringify(ev.otherHours)}|${ev.cyclicActive}|${ev.cyclicInterval}|${ev.cyclicUnit}|${ev.cyclicLimit}`;
        const cached = _expandedTimesCache.get(ev.id);
        if (cached && cached.key === cacheKey) return cached.times;
        const baseTimes = [ev.primaryTime];
        if (ev.otherHours && ev.otherHours.length > 0) {
            const [, pM, pS] = ev.primaryTime.split(':');
            ev.otherHours.forEach(hNum => baseTimes.push(`${_pad(hNum)}:${pM}:${pS}`));
        }
        const allTimes = new Set(baseTimes);
        if (ev.cyclicActive && ev.cyclicInterval > 0 && ev.cyclicLimit > 0) {
            baseTimes.forEach(bt => {
                const [h, m, s] = bt.split(':').map(Number);
                for (let i = 1; i <= ev.cyclicLimit; i++) {
                    const d = new Date(); d.setHours(h, m, s, 0);
                    if (ev.cyclicUnit === 'minutes') d.setMinutes(d.getMinutes() + ev.cyclicInterval * i);
                    else if (ev.cyclicUnit === 'hours') d.setHours(d.getHours() + ev.cyclicInterval * i);
                    allTimes.add(`${_pad(d.getHours())}:${_pad(d.getMinutes())}:${_pad(d.getSeconds())}`);
                }
            });
        }
        const times = Array.from(allTimes);
        _expandedTimesCache.set(ev.id, { key: cacheKey, times });
        return times;
    }

    function _getEventFireId(ev, timeStr, date) {
        if (!ev || !timeStr || !date) return null;
        if (ev.dayMode === 'once') return `${ev.id}_${timeStr}`;
        return `${ev.id}_${timeStr}_${date.toDateString()}`;
    }

    // El renderer envía su copia de eventsMasterDB cada vez que la modifica
    ipcMain.on('events-clock-sync', (e, events) => {
        localEventsDB = Array.isArray(events) ? events.map(ev => Object.assign({}, ev)) : [];
    });

    // Reloj de disparo: corre en Main Process, no compite con el render de Chromium
    setInterval(() => {
        if (!localEventsDB.length) return;
        const win = context.mainWindow;
        if (!win || win.isDestroyed()) return;

        const now = new Date();
        const currentStr = `${_pad(now.getHours())}:${_pad(now.getMinutes())}:${_pad(now.getSeconds())}`;

        for (const ev of localEventsDB) {
            if (!ev.primaryTime) continue;
            if (!_isDateValidForEvent(now, ev)) continue;
            const expandedTimes = _getExpandedEventTimesCached(ev);
            for (const tTime of expandedTimes) {
                if (currentStr !== tTime) continue;
                const fireId = _getEventFireId(ev, tTime, now);
                if (ev.lastFired === fireId) continue; // ya disparado en esta ocurrencia
                ev.lastFired = fireId; // marcar localmente para no re-disparar en el siguiente tick
                const ignoreId = `${ev.id}_${tTime}_${now.toDateString()}`;
                win.webContents.send('event-clock-tick', { evId: ev.id, timeStr: tTime, nowMs: now.getTime(), fireId, ignoreId });
            }
        }
    }, 1000);
};
