const CommercialData = (() => {
    const { ipcRenderer } = require('electron');
    const path = require('path');

    const audioExts = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.aiff', '.aif', '.mp2']);

    const typeLabels = {
        commercial: 'COM',
        promo: 'PROMO',
        courtesy: 'CORT',
        public_service: 'SERV',
        government: 'GOB',
        social: 'SOC',
        station_id: 'ID',
        jingle: 'JINGLE',
        sweeper: 'PIS',
        temporary: 'TEMP',
        other: 'OTRO',
        paid: 'COM',
        jingle_legacy: 'JINGLE'
    };

    const legacyTypes = {
        paid: 'commercial',
        station_promo: 'promo',
        unpaid: 'courtesy',
        psa: 'public_service',
        legal_id: 'station_id',
        sweep: 'sweeper'
    };

    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[ch]));
    }

    function basename(filePath) {
        return path.basename(filePath || '');
    }

    function normalizeType(type) {
        const raw = type || 'commercial';
        return legacyTypes[raw] || (typeLabels[raw] ? raw : 'other');
    }

    function typeLabel(asset) {
        const normalized = normalizeType(asset?.commercialType || asset?.category);
        return typeLabels[normalized] || 'OTRO';
    }

    function isJingle(asset) {
        const normalized = normalizeType(asset?.commercialType || asset?.category);
        return asset?.rootType === 'jingles' || ['station_id', 'jingle', 'sweeper'].includes(normalized);
    }

    function assetStatus(asset) {
        if (!asset || asset.enabled === false) return 'paused';
        const computed = asset.computedStatus || asset.status || 'draft';
        if (computed !== 'active') return computed;
        if (asset.validityEnd) {
            const end = new Date(asset.validityEnd).getTime();
            const now = Date.now();
            const soon = now + (7 * 24 * 60 * 60 * 1000);
            if (Number.isFinite(end) && end >= now && end <= soon) return 'expiring';
        }
        return computed;
    }

    function assetTitle(asset) {
        return asset?.clientName || asset?.campaignName || asset?.title || basename(asset?.filePath);
    }

    function secondsToClock(seconds) {
        const total = Math.max(0, Math.round(Number(seconds) || 0));
        const min = Math.floor(total / 60);
        const sec = total % 60;
        return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }

    function audioPathsFromFileList(fileList) {
        return [...fileList]
            .map(file => file.path)
            .filter(Boolean)
            .filter(filePath => audioExts.has(path.extname(filePath).toLowerCase()));
    }

    async function loadSnapshot(filters = {}) {
        const [settings, categories, rawAssets, airRules] = await Promise.all([
            ipcRenderer.invoke('commercial-get-settings'),
            ipcRenderer.invoke('commercial-get-categories'),
            ipcRenderer.invoke('commercial-get-assets', filters),
            ipcRenderer.invoke('commercial-get-air-rules')
        ]);
        return {
            settings: settings || {},
            scheduleConfig: normalizeScheduleConfig(settings?.scheduleConfig),
            categories: Array.isArray(categories) ? categories : [],
            assets: Array.isArray(rawAssets) ? rawAssets : [],
            airRules: Array.isArray(airRules) ? airRules.map(normalizeAirRule) : []
        };
    }

    function normalizeAirRule(rule) {
        return {
            assetPath: rule?.assetPath || '',
            enabled: rule?.enabled !== false,
            daySlots: normalizeDaySlots(rule?.daySlots),
            validityStart: rule?.validityStart || '',
            validityEnd: rule?.validityEnd || '',
            priority: rule?.priority || 'normal',
            notes: rule?.notes || ''
        };
    }

    function normalizeDaySlots(daySlots) {
        const clean = {};
        Object.entries(daySlots || {}).forEach(([day, times]) => {
            const dayNum = Number(day);
            if (!Number.isInteger(dayNum) || dayNum < 0 || dayNum > 6) return;
            clean[String(dayNum)] = [...new Set((Array.isArray(times) ? times : [])
                .map(time => String(time || '').slice(0, 5))
                .filter(time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)))].sort();
        });
        return clean;
    }

    async function chooseRoot() {
        return ipcRenderer.invoke('commercial-set-root', 'commercials');
    }

    async function scanRoot(category) {
        return ipcRenderer.invoke('commercial-scan-root', { rootType: 'commercials', category });
    }

    async function importPaths(paths, category) {
        return ipcRenderer.invoke('commercial-import-paths', {
            paths,
            rootType: 'commercials',
            category
        });
    }

    async function chooseFiles() {
        return ipcRenderer.invoke('commercial-dialog-add-files');
    }

    async function saveScheduleConfig(config) {
        return ipcRenderer.invoke('commercial-save-schedule-config', normalizeScheduleConfig(config));
    }

    async function toggleAirSlot(assetPaths, day, time) {
        return ipcRenderer.invoke('commercial-toggle-air-slot', { assetPaths, day, time });
    }

    async function toggleAirDay(assetPaths, day, times) {
        return ipcRenderer.invoke('commercial-toggle-air-day', { assetPaths, day, times });
    }

    async function toggleAirTime(assetPaths, time) {
        return ipcRenderer.invoke('commercial-toggle-air-time', { assetPaths, time });
    }

    async function saveAirRuleMeta(assetPaths, meta) {
        return ipcRenderer.invoke('commercial-save-air-rule-meta', { assetPaths, meta });
    }

    async function getGeneratedSlot(day, time) {
        return ipcRenderer.invoke('commercial-get-generated-slot', { day, time });
    }

    function normalizeScheduleConfig(config) {
        let raw = config;
        if (typeof raw === 'string') {
            try { raw = JSON.parse(raw); } catch (err) { raw = null; }
        }
        const hours = Array.isArray(raw?.hours) ? raw.hours : [6, 7, 8, 9, 10, 11, 12, 14, 20];
        const minutes = Array.isArray(raw?.minutes) ? raw.minutes : [0, 30];
        return {
            hours: [...new Set(hours.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 23))].sort((a, b) => a - b),
            minutes: [...new Set(minutes.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 59))].sort((a, b) => a - b),
            second: Math.max(0, Math.min(59, Number(raw?.second) || 0))
        };
    }

    function preview(filePath) {
        if (filePath) ipcRenderer.send('open-preview', filePath);
    }

    return {
        esc,
        basename,
        typeLabel,
        isJingle,
        assetStatus,
        assetTitle,
        secondsToClock,
        audioPathsFromFileList,
        loadSnapshot,
        chooseRoot,
        scanRoot,
        importPaths,
        chooseFiles,
        saveScheduleConfig,
        toggleAirSlot,
        toggleAirDay,
        toggleAirTime,
        saveAirRuleMeta,
        getGeneratedSlot,
        normalizeScheduleConfig,
        preview
    };
})();
