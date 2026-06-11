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
            return db.prepare("SELECT * FROM events").all().map(r => ({
                id: r.id, name: r.name, group: r.group_id, sourceType: r.source_type, filePath: r.file_path,
                primaryTime: r.primary_time, otherHours: safeJsonParse(r.other_hours), dayMode: r.day_mode,
                specificDays: safeJsonParse(r.specific_days), targetWeeks: safeJsonParse(r.target_weeks),
                validityStart: r.validity_start, validityEnd: r.validity_end, action: r.action,
                execution: r.execution, priority: r.priority || 'normal', colorText: r.color_text, colorBg: r.color_bg,
                requirePlaying: r.require_playing === 1, maxDelayActive: r.max_delay_active === 1,
                maxDelayMinutes: r.max_delay_minutes, maxDelaySeconds: r.max_delay_seconds,
                maxDelayTime: r.max_delay_time, maxDelayAction: r.max_delay_action,
                cyclicActive: r.cyclic_active === 1, cyclicInterval: r.cyclic_interval,
                cyclicUnit: r.cyclic_unit, cyclicLimit: r.cyclic_limit, lastFired: r.last_fired,
                // Campos de stream_url
                streamUrl:            r.stream_url            || '',
                streamStopSeconds:    Number(r.stream_stop_seconds)   || 0,
                streamConnectTimeout: Number(r.stream_connect_timeout) || 10,
                streamMaxRetries:     Number(r.stream_max_retries)     || 3,
                streamMetadataMode:   r.stream_metadata_mode   || 'icy',
                streamCustomMetadata: r.stream_custom_metadata || '',
                // Campos de locuciÃ³n y pisador
                locutionType:         r.locution_type          || 'time',
                eventDuckingVolume:   Number(r.event_ducking_volume) || 20,
                eventDuckingFade:     Number(r.event_ducking_fade)   || 500
            }));
        } catch(e) { return []; }
    });

    const parseEventNumber = (val) => (val !== '' && val !== null && val !== undefined && !isNaN(val)) ? parseFloat(val) : null;

    function saveEventToDb(savedEvent = {}) {
        const stmt = db.prepare(`
            INSERT INTO events (
                id, name, group_id, source_type, file_path, primary_time, other_hours, day_mode,
                specific_days, target_weeks, validity_start, validity_end, action, execution, priority,
                color_text, color_bg, require_playing, max_delay_active, max_delay_minutes, max_delay_seconds,
                max_delay_time, max_delay_action, cyclic_active, cyclic_interval, cyclic_unit, cyclic_limit,
                last_fired,
                stream_url, stream_stop_seconds, stream_connect_timeout, stream_max_retries,
                stream_metadata_mode, stream_custom_metadata,
                locution_type, event_ducking_volume, event_ducking_fade
            ) VALUES (
                @id, @name, @group, @sourceType, @filePath, @primaryTime, @otherHours, @dayMode,
                @specificDays, @targetWeeks, @validityStart, @validityEnd, @action, @execution, @priority,
                @colorText, @colorBg, @requirePlaying, @maxDelayActive, @maxDelayMinutes, @maxDelaySeconds,
                @maxDelayTime, @maxDelayAction, @cyclicActive, @cyclicInterval, @cyclicUnit, @cyclicLimit,
                @lastFired,
                @streamUrl, @streamStopSeconds, @streamConnectTimeout, @streamMaxRetries,
                @streamMetadataMode, @streamCustomMetadata,
                @locutionType, @eventDuckingVolume, @eventDuckingFade
            )
            ON CONFLICT(id) DO UPDATE SET
                name=@name, group_id=@group, source_type=@sourceType, file_path=@filePath,
                primary_time=@primaryTime, other_hours=@otherHours, day_mode=@dayMode,
                specific_days=@specificDays, target_weeks=@targetWeeks, validity_start=@validityStart,
                validity_end=@validityEnd, action=@action, execution=@execution, priority=@priority,
                color_text=@colorText, color_bg=@colorBg, require_playing=@requirePlaying,
                max_delay_active=@maxDelayActive, max_delay_minutes=@maxDelayMinutes,
                max_delay_seconds=@maxDelaySeconds, max_delay_time=@maxDelayTime,
                max_delay_action=@maxDelayAction, cyclic_active=@cyclicActive,
                cyclic_interval=@cyclicInterval, cyclic_unit=@cyclicUnit, cyclic_limit=@cyclicLimit,
                last_fired=@lastFired,
                stream_url=@streamUrl, stream_stop_seconds=@streamStopSeconds,
                stream_connect_timeout=@streamConnectTimeout, stream_max_retries=@streamMaxRetries,
                stream_metadata_mode=@streamMetadataMode, stream_custom_metadata=@streamCustomMetadata,
                locution_type=@locutionType, event_ducking_volume=@eventDuckingVolume,
                event_ducking_fade=@eventDuckingFade
        `);
        stmt.run({
            id: savedEvent.id,
            name: savedEvent.name,
            group: savedEvent.group || 'g_general',
            sourceType: savedEvent.sourceType || 'file',
            filePath: savedEvent.filePath || '',
            primaryTime: savedEvent.primaryTime,
            otherHours: JSON.stringify(savedEvent.otherHours || []),
            dayMode: savedEvent.dayMode || 'daily',
            specificDays: JSON.stringify(savedEvent.specificDays || []),
            targetWeeks: JSON.stringify(savedEvent.targetWeeks || []),
            validityStart: savedEvent.validityStart || null,
            validityEnd: savedEvent.validityEnd || null,
            action: savedEvent.action || 'add',
            execution: savedEvent.execution || 'interrupt',
            priority: savedEvent.priority || 'normal',
            colorText: savedEvent.colorText || '#ffffff',
            colorBg: savedEvent.colorBg || '#1a1a1c',
            requirePlaying: savedEvent.requirePlaying ? 1 : 0,
            maxDelayActive: savedEvent.maxDelayActive ? 1 : 0,
            maxDelayMinutes: parseEventNumber(savedEvent.maxDelayMinutes) ?? 0,
            maxDelaySeconds: parseEventNumber(savedEvent.maxDelaySeconds) ?? 0,
            maxDelayTime: parseEventNumber(savedEvent.maxDelayTime) ?? 0,
            maxDelayAction: savedEvent.maxDelayAction || 'omit',
            cyclicActive: savedEvent.cyclicActive ? 1 : 0,
            cyclicInterval: parseEventNumber(savedEvent.cyclicInterval) ?? 0,
            cyclicUnit: savedEvent.cyclicUnit || 'minutes',
            cyclicLimit: parseEventNumber(savedEvent.cyclicLimit) ?? 0,
            lastFired: savedEvent.lastFired || null,
            streamUrl: savedEvent.streamUrl || null,
            streamStopSeconds: parseEventNumber(savedEvent.streamStopSeconds) ?? 0,
            streamConnectTimeout: parseEventNumber(savedEvent.streamConnectTimeout) ?? 10,
            streamMaxRetries: parseEventNumber(savedEvent.streamMaxRetries) ?? 3,
            streamMetadataMode: savedEvent.streamMetadataMode || 'icy',
            streamCustomMetadata: savedEvent.streamCustomMetadata || null,
            locutionType: savedEvent.locutionType || 'time',
            eventDuckingVolume: parseEventNumber(savedEvent.eventDuckingVolume) ?? 20,
            eventDuckingFade: parseEventNumber(savedEvent.eventDuckingFade) ?? 500
        });
    }

    function saveEventsFullToDb(events) {
        db.transaction(() => {
            db.prepare('DELETE FROM events').run();
            for (const ev of (Array.isArray(events) ? events : [])) saveEventToDb(ev);
        })();
    }

    ipcMain.handle('save-event', (e, savedEvent) => {
        try {
            saveEventToDb(savedEvent);
            notifyEventsChanged(savedEvent);
            if (context.eventEditorWindow && !context.eventEditorWindow.isDestroyed()) context.eventEditorWindow.close();
            return { success: true };
        } catch (err) {
            writeLog("Error guardando evento: " + err);
            return { success: false, error: err.message || String(err) };
        }
    });

    ipcMain.handle('db-save-events-full', (e, events) => {
        try {
            saveEventsFullToDb(events);
            notifyEventsChanged();
            return { success: true };
        } catch(err) {
            writeLog("Error save-events-full: " + err);
            return { success: false, error: err.message || String(err) };
        }
    });

    ipcMain.handle('db-update-event-last-fired', (e, payload = {}) => {
        try {
            if (!payload.id) return { success: false, error: 'Missing event id' };
            db.prepare('UPDATE events SET last_fired = ? WHERE id = ?').run(payload.lastFired || null, payload.id);
            notifyEventsChanged({ id: payload.id, lastFired: payload.lastFired || null, partial: true });
            return { success: true };
        } catch (err) {
            writeLog("Error update-event-last-fired: " + err);
            return { success: false, error: err.message || String(err) };
        }
    });

    ipcMain.on('save-event', (e, savedEvent) => {
        try {
            saveEventToDb(savedEvent);
            notifyEventsChanged(savedEvent);
            if (context.eventEditorWindow && !context.eventEditorWindow.isDestroyed()) context.eventEditorWindow.close();
        } catch (err) { writeLog("Error guardando evento: " + err); }
    });

    ipcMain.on('db-save-events-full', (e, events) => {
        try {
            saveEventsFullToDb(events);
            notifyEventsChanged();
        } catch(err) { writeLog("Error save-events-full: " + err); }
    });

    // ====================================================================
    // PARRILLA DE PROGRAMACIÃƒâ€œN (schedule_programs)
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
            // Notificar a la ventana del calendario si estÃƒÂ¡ abierta
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
};
