const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { normalizeAudioPrefs } = require('./audio_prefs');
const { getConfigDir } = require('../backend/utils/app_paths');

const configDir = getConfigDir(path.join(__dirname, '..', 'config'), __dirname);
const generalPrefsPath = path.join(configDir, 'general_settings.json');
const fileTypesPath = path.join(configDir, 'file_types.json');
const readJson = (filePath, fallback) => { try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (err) { return fallback; } };
const byId = id => document.getElementById(id);
const setChecked = (id, value) => { if (byId(id)) byId(id).checked = value !== false; };

let incidentFilter = 'all';
let currentSnapshot = {
    statuses: {
        air: { value: 'Detenido', tone: 'manual' },
        events: { value: 'Activos', tone: 'ok' },
        encoder: { value: 'Desconectado', tone: 'manual' },
        session: { value: 'Nueva', tone: 'manual' }
    },
    autoCount: 0,
    lastAction: 'Ultima autoaccion: ninguna',
    eventWatch: { summary: 'Sin eventos proximos', items: [] },
    entries: []
};

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function categoryLabel(category) {
    const labels = {
        all: 'Todos',
        air: 'Aire',
        guard: 'Guardia',
        audio: 'Audio',
        events: 'Eventos',
        encoder: 'Encoder',
        session: 'Sesion',
        system: 'Sistema'
    };
    return labels[category] || 'Sistema';
}

function applyStatus(key, data) {
    const card = document.getElementById(`status-${key}`);
    if (!card) return;
    const valueNode = card.querySelector('.incident-status-value');
    if (valueNode) valueNode.innerText = data?.value || '---';
    card.dataset.tone = data?.tone || 'manual';
}

function renderEntries() {
    const logBox = document.getElementById('sys-log');
    if (!logBox) return;
    const previousScrollTop = logBox.scrollTop;
    const keepScrollPosition = previousScrollTop > 8;
    const entries = Array.isArray(currentSnapshot.entries) ? currentSnapshot.entries : [];
    const visibleEntries = entries.filter(entry => incidentFilter === 'all' || entry.category === incidentFilter);
    if (visibleEntries.length === 0) {
        logBox.innerHTML = '<div class="incident-empty">No hay incidencias para este filtro.</div>';
        return;
    }

    logBox.innerHTML = visibleEntries.map(entry => `
        <div class="incident-entry" data-level="${escapeHtml(entry.level || 'info')}" data-file-path="${escapeHtml(entry.filePath || '')}">
            <div class="incident-entry-head">
                <div class="incident-entry-meta">
                    <span class="incident-entry-time">${escapeHtml(entry.time || '--:--:--')}</span>
                    <span class="incident-entry-tag" data-category="${escapeHtml(entry.category || 'system')}">${categoryLabel(entry.category)}</span>
                </div>
            </div>
            <div class="incident-entry-message">${escapeHtml(entry.message || '')}</div>
        </div>
    `).join('');
    logBox.scrollTop = keepScrollPosition ? Math.min(previousScrollTop, logBox.scrollHeight) : 0;
}

function renderEventWatch() {
    const container = document.getElementById('reports-events-timeline');
    const summary = document.getElementById('reports-events-summary');
    if (!container) return;
    const watch = currentSnapshot.eventWatch || {};
    const items = Array.isArray(watch.items) ? watch.items : [];
    if (summary) summary.innerText = watch.summary || 'Sin eventos proximos';
    if (items.length === 0) {
        container.innerHTML = '<div class="event-timeline-empty">No hay eventos programados en vigilancia.</div>';
        return;
    }
    container.innerHTML = items.map(item => {
        const source = item.sourceSummary ? ` · ${escapeHtml(item.sourceSummary)}` : '';
        const meta = `${escapeHtml(item.countdownText || item.message || 'Programado')}${source}`;
        return `
            <div class="event-timeline-item" data-status="${escapeHtml(item.status || 'scheduled')}">
                <div class="event-timeline-time">${escapeHtml(item.time || '--:--')}</div>
                <div>
                    <div class="event-timeline-name">${escapeHtml(item.name || 'Evento sin nombre')}</div>
                    <div class="event-timeline-meta">${meta}</div>
                </div>
                <div class="event-timeline-state">${escapeHtml(item.label || 'PROG')}</div>
            </div>
        `;
    }).join('');
}

function renderSnapshot() {
    const counter = document.getElementById('incident-auto-count');
    if (counter) counter.innerText = `AUTO ${currentSnapshot.autoCount || 0}`;

    const lastAction = document.getElementById('incident-last-action');
    if (lastAction) lastAction.innerText = currentSnapshot.lastAction || 'Ultima autoaccion: ninguna';

    const statuses = currentSnapshot.statuses || {};
    applyStatus('air', statuses.air);
    applyStatus('events', statuses.events);
    applyStatus('encoder', statuses.encoder);
    applyStatus('session', statuses.session);
    renderEventWatch();
    renderEntries();
}

ipcRenderer.on('incident-sync-update', (event, snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return;
    currentSnapshot = snapshot;
    renderSnapshot();
});

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.incident-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            incidentFilter = btn.dataset.filter || 'all';
            document.querySelectorAll('.incident-filter').forEach(node => node.classList.toggle('active', node === btn));
            renderEntries();
        });
    });

    const btnRefresh = document.getElementById('btn-refresh-reports');
    if (btnRefresh) btnRefresh.addEventListener('click', () => { ipcRenderer.send('incident-request-sync'); });

    const overlay = byId('report-settings-overlay');
    const loadReportSettings = () => {
        const prefs = normalizeAudioPrefs(readJson(generalPrefsPath, {}));
        const types = readJson(fileTypesPath, []);
        const getType = id => types.find(item => item.id === id) || {};
        setChecked('report-music-enabled', prefs.reportMusicEnabled);
        setChecked('history-music-enabled', prefs.historyMusicEnabled);
        setChecked('report-commercial-enabled', getType('t_comercial').report);
        setChecked('history-commercial-enabled', getType('t_comercial').history);
        setChecked('report-station-enabled', getType('t_station_id').report);
        setChecked('history-station-enabled', getType('t_station_id').history);
        setChecked('report-locution-enabled', getType('t_time').report);
        byId('history-retention-days').value = prefs.historyRetentionDays;
        byId('music-random-protection-days').value = prefs.musicRandomProtectionDays;
        byId('report-persist-on-restart').checked = prefs.reportPersistOnRestart;
        byId('report-retention-value').value = prefs.reportRetentionValue;
        byId('report-retention-unit').value = prefs.reportRetentionUnit;
    };
    byId('btn-report-settings').addEventListener('click', () => { loadReportSettings(); overlay.style.display = 'flex'; });
    byId('btn-report-settings-cancel').addEventListener('click', () => { overlay.style.display = 'none'; });
    byId('btn-report-settings-save').addEventListener('click', () => {
        const prefs = normalizeAudioPrefs({
            ...readJson(generalPrefsPath, {}),
            reportMusicEnabled: byId('report-music-enabled').checked,
            historyMusicEnabled: byId('history-music-enabled').checked,
            historyRetentionDays: byId('history-retention-days').value,
            musicRandomProtectionDays: byId('music-random-protection-days').value,
            reportPersistOnRestart: byId('report-persist-on-restart').checked,
            reportRetentionValue: byId('report-retention-value').value,
            reportRetentionUnit: byId('report-retention-unit').value
        });
        const types = readJson(fileTypesPath, []);
        const updateType = (id, report, history) => {
            const type = types.find(item => item.id === id);
            if (type) { type.report = report; type.history = history; }
        };
        updateType('t_comercial', byId('report-commercial-enabled').checked, byId('history-commercial-enabled').checked);
        updateType('t_station_id', byId('report-station-enabled').checked, byId('history-station-enabled').checked);
        updateType('t_time', byId('report-locution-enabled').checked, false);
        fs.writeFileSync(generalPrefsPath, JSON.stringify(prefs, null, 2));
        fs.writeFileSync(fileTypesPath, JSON.stringify(types, null, 2));
        ipcRenderer.send('settings-updated', {});
        overlay.style.display = 'none';
    });

    const logBox = document.getElementById('sys-log');
    if (logBox) logBox.addEventListener('contextmenu', async event => {
        const entry = event.target.closest('.incident-entry');
        const filePath = entry?.dataset?.filePath || '';
        if (!filePath) return;
        event.preventDefault();
        const action = await ipcRenderer.invoke('show-context-menu', [{ id: 'show-folder', label: 'Mostrar en carpeta' }]);
        if (action === 'show-folder') await ipcRenderer.invoke('file:show-in-folder', filePath);
    });

    renderSnapshot();
    ipcRenderer.send('incident-request-sync');
});
