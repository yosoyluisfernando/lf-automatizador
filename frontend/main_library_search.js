'use strict';

const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');
const { getConfigDir } = require('../backend/utils/app_paths');
const { defaultFileTypes, normalizeFileTypes } = require('./file_types_data');

const configDir = getConfigDir(path.join(__dirname, '..', 'config'), __dirname);
const fileTypesPath = path.join(configDir, 'file_types.json');

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return parsed || fallback;
    } catch (err) {
        return fallback;
    }
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDate(value = '') {
    if (!value) return '-';
    try {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleString('es-ES', { hour12: false });
    } catch (err) {
        return '-';
    }
}

function createMainLibrarySearchController(options = {}) {
    const documentRef = options.document || document;
    const byId = id => documentRef.getElementById(id);
    let fileTypes = [];
    let roots = [];
    let searchTimer = null;
    let searchToken = 0;
    let syncInProgress = false;

    function setStatus(message = '', tone = '') {
        const node = byId('main-library-search-status');
        if (!node) return;
        node.textContent = message;
        node.dataset.tone = tone;
    }

    function setModalMessage(message = '', tone = '') {
        const node = byId('library-index-message');
        if (!node) return;
        node.textContent = message;
        node.dataset.tone = tone;
    }

    function loadFileTypes() {
        fileTypes = normalizeFileTypes(readJson(fileTypesPath, defaultFileTypes));
        renderTypeControls();
    }

    function renderTypeControls() {
        const filter = byId('main-library-type-filter');
        const modalType = byId('library-index-type');
        const filterValue = filter?.value || 'all';
        const modalValue = modalType?.value || '';

        if (filter) {
            filter.innerHTML = '<option value="all">Todo</option><option value="__music">Musica</option>'
                + fileTypes.map(type => `<option value="${escapeHtml(type.id)}">${escapeHtml(type.name)}</option>`).join('');
            filter.value = Array.from(filter.options).some(opt => opt.value === filterValue) ? filterValue : 'all';
        }

        if (modalType) {
            modalType.innerHTML = '<option value="">Musica / sin tipo explicito</option>'
                + fileTypes.map(type => `<option value="${escapeHtml(type.id)}">${escapeHtml(type.name)}</option>`).join('');
            modalType.value = Array.from(modalType.options).some(opt => opt.value === modalValue) ? modalValue : '';
        }
    }

    function getTypeName(typeId = '') {
        if (!typeId) return 'Musica';
        return fileTypes.find(type => type.id === typeId)?.name || typeId;
    }

    function renderRoots() {
        const body = byId('library-index-root-body');
        if (!body) return;
        if (!roots.length) {
            body.innerHTML = '<tr><td colspan="4">No hay carpetas indexadas.</td></tr>';
            return;
        }
        body.innerHTML = roots.map(root => {
            const locked = root.locked || root.source === 'library_root';
            const state = locked ? 'Fija' : (root.enabled ? 'Activa' : 'Inactiva');
            const sub = root.recursive ? ' + subcarpetas' : '';
            return `
                <tr class="${locked ? 'locked' : ''}">
                    <td class="library-index-path" title="${escapeHtml(root.rootPath)}">${escapeHtml(root.rootPath)}</td>
                    <td>${escapeHtml(getTypeName(root.typeId))}</td>
                    <td><span class="library-index-badge">${escapeHtml(state)}${escapeHtml(sub)}</span></td>
                    <td>${escapeHtml(formatDate(root.lastScanAt))}</td>
                </tr>
            `;
        }).join('');
    }

    function setSearchMode(active) {
        const explorer = byId('file-explorer');
        const results = byId('main-library-search-results');
        if (explorer) explorer.style.display = active ? 'none' : '';
        if (results) results.style.display = active ? 'block' : 'none';
    }

    function statusLabel(status = '') {
        const value = String(status || '').toLowerCase();
        if (value === 'treated') return 'Tratada';
        if (value === 'pending') return 'Pendiente';
        if (value === 'changed') return 'Cambiada';
        if (value === 'missing') return 'Faltante';
        return value || '-';
    }

    function resultTitle(result = {}) {
        const title = String(result.title || '').trim();
        const artist = String(result.artist || '').trim();
        if (title && artist) return `${artist} - ${title}`;
        return title || path.basename(result.filePath || '') || 'Sin titulo';
    }

    function renderResults(items = []) {
        const results = byId('main-library-search-results');
        if (!results) return;
        if (!items.length) {
            results.innerHTML = '<div class="library-search-empty">Sin resultados.</div>';
            return;
        }
        results.innerHTML = items.map((item, index) => `
            <div class="library-result-row" data-index="${index}" title="${escapeHtml(item.filePath || '')}" draggable="true">
                <div class="library-result-main">
                    <div class="library-result-title">${escapeHtml(resultTitle(item))}</div>
                    <div class="library-result-meta">${escapeHtml([item.album, item.year, getTypeName(item.typeId)].filter(Boolean).join(' - '))}</div>
                    <div class="library-result-path">${escapeHtml(item.filePath || '')}</div>
                </div>
                <span class="library-result-status">${escapeHtml(statusLabel(item.status))}</span>
            </div>
        `).join('');
        results.querySelectorAll('.library-result-row').forEach(row => {
            row.addEventListener('click', () => {
                results.querySelectorAll('.library-result-row').forEach(node => node.classList.remove('selected'));
                row.classList.add('selected');
            });
            row.addEventListener('dblclick', () => {
                const item = items[Number(row.dataset.index)];
                if (!item?.filePath) return;
                if (typeof options.onAddResult === 'function') options.onAddResult(item);
            });
            row.addEventListener('dragstart', event => {
                const item = items[Number(row.dataset.index)];
                if (!item?.filePath || !event.dataTransfer) return;
                event.dataTransfer.effectAllowed = 'copy';
                event.dataTransfer.setData('application/json', JSON.stringify([item.filePath]));
                event.dataTransfer.setData('text/plain', item.filePath);
                event.dataTransfer.setData('application/x-lf-library-track', JSON.stringify({
                    filePath: item.filePath,
                    title: resultTitle(item),
                    duration: item.duration || 0,
                    typeId: item.typeId || ''
                }));
            });
        });
    }

    async function performSearch() {
        const query = byId('main-library-search-input')?.value?.trim() || '';
        const typeId = byId('main-library-type-filter')?.value || 'all';
        if (!query && typeId === 'all') {
            clearVisualSearch();
            return;
        }
        setSearchMode(true);
        setStatus('Buscando...');
        // La consulta REAL viaja al backend y la búsqueda difusa corre en
        // library_worker (hilo aparte, índice cacheado). Esta interfaz solo
        // pinta los resultados finales: nada de traer miles de filas y
        // filtrarlas aquí (eso congelaba toda la ventana).
        const token = ++searchToken;
        const result = await ipcRenderer.invoke('library-index-search', { query, typeId, limit: 150 });
        if (token !== searchToken) return; // hay una búsqueda más reciente en curso
        if (!result?.success) {
            renderResults([]);
            setStatus(result?.error || 'No se pudo buscar.');
            return;
        }
        const items = Array.isArray(result.results) ? result.results : [];
        renderResults(items);
        setStatus(`${items.length} resultado(s)`);
    }

    function isSearchActive() {
        const query = byId('main-library-search-input')?.value?.trim() || '';
        const typeId = byId('main-library-type-filter')?.value || 'all';
        return Boolean(query) || typeId !== 'all';
    }

    async function refreshActiveSearch() {
        if (!isSearchActive()) return;
        await performSearch();
    }

    function scheduleSearch() {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            performSearch().catch(err => setStatus(err.message || String(err)));
        }, 220);
    }

    async function refreshRoots() {
        const result = await ipcRenderer.invoke('library-index-list-roots');
        if (!result?.success) {
            roots = [];
            renderRoots();
            setModalMessage(result?.error || 'No se pudieron cargar las carpetas.', 'error');
            return result;
        }
        roots = Array.isArray(result.roots) ? result.roots : [];
        renderRoots();
        setStatus(roots.length ? `${roots.length} carpeta(s) indexadas` : '');
        return result;
    }

    async function addFolder() {
        const folder = await ipcRenderer.invoke('dialog:pickFolder', { title: 'Agregar carpeta al indice musical' });
        if (!folder) return;

        const typeId = byId('library-index-type')?.value || '';
        const recursive = byId('library-index-recursive')?.checked !== false;
        setModalMessage('Registrando carpeta...', 'warn');
        // Agregar SOLO registra la carpeta (operación instantánea). El escaneo
        // e importación de metadatos ocurren únicamente cuando el operador
        // pulsa "Actualizar todo": nunca de forma automática.
        const added = await ipcRenderer.invoke('library-index-add-root', {
            rootPath: folder,
            typeId: typeId || null,
            recursive,
            source: 'extra'
        });
        if (!added?.success) {
            setModalMessage(added?.error || 'No se pudo agregar la carpeta.', 'error');
            return;
        }
        await refreshRoots();
        setModalMessage('Carpeta agregada. Pulsa "Actualizar todo" para escanearla e importar sus metadatos.', 'ok');
        setStatus('Carpeta agregada al índice. Usa ↻ para sincronizar.', 'warn');
    }

    // Estado del índice para el cuadro de diagnóstico. Solo conteos (sin
    // escaneo): se muestra al abrir el software y tras cada sincronización.
    async function refreshIndexStatus() {
        try {
            const result = await ipcRenderer.invoke('library-index-status');
            if (syncInProgress) return; // el progreso de sync manda sobre el estado
            if (!result?.success || !result.status) return;
            const status = result.status;
            if (!status.total) {
                setStatus('Índice vacío. Usa ↻ para sincronizar tu música.', 'warn');
                return;
            }
            const pending = (status.byStatus?.pending || 0) + (status.byStatus?.changed || 0);
            const missing = status.byStatus?.missing || 0;
            const parts = [`Índice listo: ${status.total} pistas`];
            if (pending > 0) parts.push(`${pending} pendientes`);
            if (missing > 0) parts.push(`${missing} faltantes`);
            if (status.lastScanAt) parts.push(`últ. sync ${formatDate(status.lastScanAt)}`);
            setStatus(parts.join(' · '), pending > 0 || missing > 0 ? 'warn' : 'ok');
        } catch (err) {}
    }

    function handleSyncProgress(payload = {}) {
        const total = Number(payload.total) || 0;
        const processed = Math.min(Number(payload.processed) || 0, total);
        const percent = total > 0 ? Math.round((processed / total) * 100) : 0;
        const rootInfo = payload.rootCount > 1 ? ` (carpeta ${payload.rootIndex}/${payload.rootCount})` : '';
        const message = total > 0
            ? `Sincronizando índice${rootInfo}... ${percent}% (${processed}/${total})`
            : `Escaneando carpetas${rootInfo}...`;
        setStatus(message, 'warn');
        setModalMessage(message, 'warn');
    }

    async function syncAll() {
        if (syncInProgress) return;
        syncInProgress = true;
        try {
            setModalMessage('Actualizando explorador e indice...', 'warn');
            setStatus('Actualizando explorador...');
            // Orden pedido por el operador: primero refrescar el explorador de
            // archivos, después sincronizar el índice (con progreso visible).
            if (typeof options.onRefreshExplorer === 'function') {
                try {
                    await options.onRefreshExplorer();
                    setStatus('Explorador actualizado. Sincronizando indice...');
                } catch (err) {
                    setStatus('No se pudo actualizar el explorador. Sincronizando indice...');
                }
            }
            const result = await ipcRenderer.invoke('library-index-sync-all');
            await refreshRoots();
            await refreshActiveSearch();
            if (result?.success) {
                const message = `Actualizacion lista. Escaneados: ${result.scanned || 0}, indexados: ${result.indexed || 0}.`;
                setModalMessage(message, 'ok');
                setStatus(message, 'ok');
                syncInProgress = false;
                refreshIndexStatus().catch(() => {});
            } else {
                setModalMessage(result?.error || 'No se pudo actualizar el indice.', 'error');
                setStatus('No se pudo actualizar el indice.', 'error');
            }
        } finally {
            syncInProgress = false;
        }
    }

    function openModal() {
        loadFileTypes();
        refreshRoots().catch(err => setModalMessage(err.message || String(err), 'error'));
        const modal = byId('library-index-modal');
        if (modal) modal.style.display = 'flex';
    }

    function closeModal() {
        const modal = byId('library-index-modal');
        if (modal) modal.style.display = 'none';
    }

    function clearVisualSearch() {
        const input = byId('main-library-search-input');
        if (input) input.value = '';
        renderResults([]);
        setSearchMode(false);
        setStatus('');
    }

    function bind() {
        byId('main-library-settings-btn')?.addEventListener('click', openModal);
        byId('main-library-refresh-btn')?.addEventListener('click', () => syncAll().catch(err => setStatus(err.message || String(err))));
        byId('library-index-add-folder')?.addEventListener('click', () => addFolder().catch(err => setModalMessage(err.message || String(err), 'error')));
        byId('library-index-sync-all')?.addEventListener('click', () => syncAll().catch(err => setModalMessage(err.message || String(err), 'error')));
        byId('library-index-close')?.addEventListener('click', closeModal);
        byId('library-index-modal')?.addEventListener('mousedown', event => {
            if (event.target === byId('library-index-modal')) closeModal();
        });
        byId('main-library-clear-btn')?.addEventListener('click', clearVisualSearch);
        byId('main-library-search-input')?.addEventListener('input', scheduleSearch);
        byId('main-library-type-filter')?.addEventListener('change', () => performSearch().catch(err => setStatus(err.message || String(err))));
        ipcRenderer.on('file-types-data-updated', () => loadFileTypes());
        ipcRenderer.on('library-index-updated', () => {
            refreshRoots()
                .then(refreshActiveSearch)
                .catch(() => {});
        });
        ipcRenderer.on('library-index-sync-progress', (event, payload) => handleSyncProgress(payload || {}));
    }

    function init() {
        loadFileTypes();
        bind();
        refreshRoots().catch(() => {});
        // Al abrir el software solo se informa el estado del índice (conteos);
        // jamás se lanza un análisis o escaneo automático en el arranque.
        refreshIndexStatus().catch(() => {});
    }

    return {
        init,
        refreshRoots,
        syncAll,
        openModal,
        closeModal,
        clearVisualSearch
    };
}

function initMainLibrarySearch(options = {}) {
    const controller = createMainLibrarySearchController(options);
    controller.init();
    return controller;
}

module.exports = {
    createMainLibrarySearchController,
    initMainLibrarySearch
};
