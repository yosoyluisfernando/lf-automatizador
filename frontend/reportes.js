const { ipcRenderer } = require('electron');

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
