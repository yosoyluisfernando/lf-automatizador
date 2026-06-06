'use strict';
// Controlador de la ventana independiente del Generador de Playlist.
// UI delgada: todo el trabajo (core + datos + carpetas + inserción) lo hace la
// ventana principal vía el relay 'pg-to-main' (ver main.js y render.js).

const { ipcRenderer } = require('electron');
const fs = require('fs');
const npath = require('path');
const os = require('os');
let i18n = null;
try { i18n = require('./i18n'); } catch (e) { i18n = null; }

const $ = (id) => document.getElementById(id);
const pgCmd = (action, payload) => ipcRenderer.invoke('pg-to-main', { action, payload });

// Traducción con fallback REAL: i18n.t() devuelve la clave si no la encuentra,
// y la clave es "truthy"; por eso no sirve `t() || fallback`. Aquí detectamos
// ese caso y usamos el texto en español por defecto.
function T(key, fallback) {
    if (!i18n) return fallback;
    const v = i18n.t(key);
    return (v && v !== key) ? v : fallback;
}

let selectedTab = 0;
let playingTab = -1;
let steps = []; // [{ folder:bool, recursive:bool, label, token }]

function clampInt(id, fallback, min, max) {
    const raw = String($(id)?.value ?? '').replace(/[^\d]/g, '');
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function patternText() { return steps.map(s => s.token).join('\n'); }

function readPrefs() {
    return {
        pattern: patternText(),
        targetMinutes: clampInt('target-min', 60, 5, 360),
        sepArtist: clampInt('sep-artist', 4, 0, 50),
        sepTitle: clampInt('sep-title', 8, 0, 50),
        checkArtist: $('chk-artist').checked,
        checkTitle: $('chk-title').checked
    };
}

function fmtDur(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function quickSummary() {
    $('summary').textContent = `${T('playlist_generator.steps', 'Pasos')}: ${steps.length}\n${T('playlist_generator.objective', 'Objetivo')}: ${clampInt('target-min', 60, 5, 360)} min`;
}

function savePrefs() { pgCmd('save-prefs', readPrefs()).catch(() => {}); }

function folderStepFromToken(token) {
    const m = String(token).match(/^@folder(flat)?:(.+)$/i);
    if (!m) return null;
    const p = m[2].trim();
    const base = p.split(/[\\/]/).filter(Boolean).pop() || p;
    return { folder: true, recursive: !m[1], label: '📁 ' + base + (m[1] ? ' (' + T('playlist_generator.root_only', 'solo raíz') + ')' : ''), token };
}

function locLabel(locType) {
    const map = {
        time: '⏰ ' + T('playlist_generator.loc_time', 'Locución de hora'),
        temperature: '🌡️ ' + T('playlist_generator.loc_temp', 'Locución de temperatura'),
        humidity: '💧 ' + T('playlist_generator.loc_hum', 'Locución de humedad')
    };
    return map[locType] || locType;
}
function locutionStepFromToken(token) {
    const m = String(token).match(/^@loc:(time|temperature|humidity)$/i);
    if (!m) return null;
    const t = m[1].toLowerCase();
    return { locution: true, locType: t, label: locLabel(t), token: '@loc:' + t };
}
function addLocutionStep(locType) {
    steps.push({ locution: true, locType, label: locLabel(locType), token: '@loc:' + locType });
    afterStepsChange();
}

function renderSteps() {
    const box = $('steps');
    box.innerHTML = '';
    steps.forEach((s, i) => {
        const row = document.createElement('div');
        row.className = 'step' + (s.folder ? ' folder' : '') + (s.locution ? ' locution' : '');
        row.draggable = true;
        const idx = document.createElement('span'); idx.className = 'idx'; idx.textContent = (i + 1) + '.';
        const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = s.label; lbl.title = s.token;
        const del = document.createElement('button'); del.className = 'del'; del.textContent = '✕'; del.title = 'Quitar';
        del.addEventListener('click', () => { steps.splice(i, 1); afterStepsChange(); });
        row.append(idx, lbl, del);
        
        row.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', 'step:' + i);
            setTimeout(() => row.style.opacity = '0.5', 0);
        });
        row.addEventListener('dragend', () => {
            row.style.opacity = '1';
            document.querySelectorAll('.step').forEach(r => r.classList.remove('drop-target-top', 'drop-target-bottom'));
            $('steps').classList.remove('drop-active');
        });
        box.appendChild(row);
    });
}

function afterStepsChange() { renderSteps(); quickSummary(); savePrefs(); }

function addCategoryStep(name) { steps.push({ folder: false, label: name, token: name }); afterStepsChange(); }

function loadStepsFromPattern(text) {
    steps = String(text || '').split(/[\n,>]+/).map(t => t.trim()).filter(Boolean).map(tok => {
        return folderStepFromToken(tok) || locutionStepFromToken(tok) || { folder: false, label: tok, token: tok };
    });
    renderSteps();
}

function renderPalette(cats) {
    const pal = $('palette');
    pal.innerHTML = '';
    (cats || []).forEach(cat => {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.textContent = cat.name;
        if (cat.color) chip.style.color = cat.color;
        chip.addEventListener('click', () => addCategoryStep(cat.name));
        pal.appendChild(chip);
    });
}

function renderTargets() {
    const box = $('pl-targets');
    box.innerHTML = '';
    for (let i = 0; i < 4; i++) {
        const b = document.createElement('button');
        b.className = 'pl-btn' + (i === selectedTab ? ' sel' : '') + (i === playingTab ? ' air' : '');
        b.textContent = `Playlist ${i + 1}` + (i === playingTab ? ' 🔴' : '');
        b.addEventListener('click', () => { selectedTab = i; renderTargets(); });
        box.appendChild(b);
    }
}

async function addFolder() {
    let folderPath = '';
    try { folderPath = await ipcRenderer.invoke('dialog:pickFolder', { title: T('playlist_generator.pick_folder', 'Selecciona una carpeta') }); }
    catch (e) { folderPath = ''; }
    if (!folderPath) return;
    const includeSub = window.confirm(T('playlist_generator.ask_subfolders', '¿Incluir subcarpetas?'));
    const token = (includeSub ? '@folder:' : '@folderflat:') + folderPath;
    const step = folderStepFromToken(token);
    if (step) { steps.push(step); afterStepsChange(); }
}

async function runPreflight() {
    $('summary').textContent = T('playlist_generator.calculating', 'Calculando…');
    savePrefs();
    const r = await pgCmd('preview', readPrefs());
    if (!r || r.error) { $('summary').textContent = T('playlist_generator.cannot_calc', 'No se pudo calcular') + ': ' + (r?.error || '—'); return; }
    const miss = r.missing && Object.keys(r.missing).length ? `\n${T('playlist_generator.warn_missing', 'Faltan')}: ${Object.keys(r.missing).join(', ')}` : '';
    $('summary').textContent = `${T('playlist_generator.would_make', 'Generaría')}: ${r.count} ${T('playlist_generator.tracks', 'pistas')} / ${fmtDur(r.totalSeconds)}${miss}`;
}

async function runGenerate() {
    if (!steps.length) { $('summary').textContent = T('playlist_generator.no_steps', 'Agrega al menos un paso.'); return; }
    savePrefs();
    $('btn-generate').disabled = true;
    $('summary').textContent = T('playlist_generator.generating', 'Generando…');
    const r = await pgCmd('generate', { prefs: readPrefs(), tab: selectedTab, clearList: $('chk-clear').checked });
    $('btn-generate').disabled = false;
    if (!r || r.error) {
        const map = {
            insufficient: T('playlist_generator.err_insufficient', 'No hay suficientes pistas para generar.'),
            'on-air': T('playlist_generator.err_on_air', 'No puedes limpiar una playlist que está al aire.')
        };
        $('summary').textContent = T('playlist_generator.error', 'Error') + ': ' + (map[r?.error] || r?.error || '—');
        return;
    }
    $('summary').textContent = `✅ ${r.count} ${T('playlist_generator.tracks', 'pistas')} / ${fmtDur(r.totalSeconds)} → Playlist ${selectedTab + 1}` + (r.skipped ? ` (${r.skipped} ${T('playlist_generator.skipped', 'omitidas')})` : '');
}

// ── Explorador de carpetas embebido (mismos IPC que la interfaz principal) ──
function explorerLabel(p, isRoot) {
    if (!isRoot) return '📁 ' + (npath.basename(p) || p);
    const lower = String(p).toLowerCase();
    const base = (npath.basename(p) || p).toLowerCase();
    const isLinux = process.platform === 'linux';
    if (!isLinux && (lower.includes('desktop') || base === 'escritorio')) return '💻 ' + T('playlist_generator.desktop', 'Escritorio');
    if (lower.includes('downloads') || base === 'descargas') return '📥 ' + T('playlist_generator.downloads', 'Descargas');
    if (lower.includes('music') || base === 'música' || base === 'musica') return '🎵 ' + T('playlist_generator.music', 'Música');
    if (isLinux && p === os.homedir()) return '🏠 ' + T('playlist_generator.home', 'Inicio');
    if (!isLinux) return '💿 ' + (T('playlist_generator.disk', 'Disco') + ' ' + String(p).replace(/[\\/]/g, ''));
    return '💿 ' + (npath.basename(p) || p);
}

function renderExplorerTree(items, container, isRoot = false) {
    const ul = document.createElement('ul');
    if (isRoot) ul.className = 'root';
    items.forEach(p => {
        let isDir = false;
        try { isDir = fs.statSync(p).isDirectory(); } catch (e) { return; }
        if (!isDir) return; // solo carpetas
        const li = document.createElement('li');
        const div = document.createElement('div');
        div.className = 'tree-item';
        div.draggable = true;
        div.dataset.path = p;
        div.innerHTML = '<span class="tree-toggle">+</span><span class="nm"></span>';
        div.querySelector('.nm').textContent = explorerLabel(p, isRoot);
        div.querySelector('.nm').title = p;
        div.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', p);
            e.dataTransfer.effectAllowed = 'copy';
        });
        const toggle = div.querySelector('.tree-toggle');
        const expand = () => {
            const existing = li.querySelector('ul');
            if (existing) {
                const show = existing.style.display === 'none';
                existing.style.display = show ? 'block' : 'none';
                toggle.textContent = show ? '-' : '+';
                return;
            }
            try {
                const kids = fs.readdirSync(p).map(c => npath.join(p, c));
                renderExplorerTree(kids, li);
                toggle.textContent = '-';
            } catch (err) { /* sin permiso / vacío */ }
        };
        toggle.addEventListener('click', (e) => { e.stopPropagation(); expand(); });
        div.addEventListener('dblclick', (e) => { e.stopPropagation(); expand(); });
        li.appendChild(div);
        ul.appendChild(li);
    });
    container.appendChild(ul);
}

function renderTypeShortcuts(container, types) {
    if (!types || !types.length) return;
    const ul = document.createElement('ul');
    ul.className = 'root';
    types.forEach(type => {
        const li = document.createElement('li');
        const div = document.createElement('div');
        div.className = 'tree-item';
        const root = type.shortcutRoot;
        let configured = false;
        if (root) {
            try { configured = fs.statSync(root).isDirectory(); } catch (e) {}
        }
        
        if (configured) {
            div.dataset.path = root;
            div.draggable = true;
            div.title = root;
            div.innerHTML = `<span class="tree-toggle">+</span><span class="icon-folder" style="color:${type.color || ''}">📂</span> <span class="nm"></span>`;
            div.querySelector('.nm').textContent = type.name;
            div.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', root);
                e.dataTransfer.effectAllowed = 'copy';
            });
            const toggle = div.querySelector('.tree-toggle');
            const expand = () => {
                const existing = li.querySelector('ul');
                if (existing) {
                    const show = existing.style.display === 'none';
                    existing.style.display = show ? 'block' : 'none';
                    toggle.textContent = show ? '-' : '+';
                    return;
                }
                try {
                    const kids = fs.readdirSync(root).map(c => npath.join(root, c));
                    renderExplorerTree(kids, li);
                    toggle.textContent = '-';
                } catch (err) {}
            };
            toggle.addEventListener('click', (e) => { e.stopPropagation(); expand(); });
            div.addEventListener('dblclick', (e) => { e.stopPropagation(); expand(); });
        } else {
            div.style.opacity = '0.6';
            div.title = T('playlist_generator.unconfigured_shortcut', 'Acceso directo no configurado');
            div.innerHTML = `<span class="tree-toggle" style="visibility:hidden">+</span><span class="icon-folder" style="color:${type.color || ''}">⭐</span> <span class="nm"></span>`;
            div.querySelector('.nm').textContent = `${type.name} (${T('playlist_generator.unconfigured', 'no configurado')})`;
        }
        li.appendChild(div);
        ul.appendChild(li);
    });
    container.appendChild(ul);
}

async function loadExplorer() {
    const tree = $('explorer-tree');
    tree.innerHTML = '';
    let drives = [];
    let paths = {};
    let fileTypes = [];
    try { drives = await ipcRenderer.invoke('get-system-drives') || []; } catch (e) {}
    try { paths = await ipcRenderer.invoke('get-default-paths') || {}; } catch (e) {}
    try {
        const typesResponse = await pgCmd('file-types');
        if (Array.isArray(typesResponse)) {
            fileTypes = typesResponse.filter(t => t && t.id !== 't_time' && t.showShortcut === true);
        }
    } catch (e) {}

    const isLinux = process.platform === 'linux';
    const roots = [];
    if (!isLinux && paths.desktop) roots.push(paths.desktop);
    if (paths.downloads) roots.push(paths.downloads);
    if (paths.music) roots.push(paths.music);
    if (isLinux && paths.home) roots.push(paths.home);
    
    renderExplorerTree(roots, tree, true);
    renderTypeShortcuts(tree, fileTypes);
    renderExplorerTree(drives, tree, true);
}

function addFolderStepFromPath(folderPath, recursive) {
    const token = (recursive ? '@folder:' : '@folderflat:') + folderPath;
    const step = folderStepFromToken(token);
    if (step) { steps.push(step); afterStepsChange(); }
}

async function init() {
    try { if (i18n && i18n.applyToDOM) i18n.applyToDOM(document); } catch (e) {}

    const prefs = await pgCmd('saved-prefs');
    const def = await pgCmd('default-pattern');
    if (prefs && !prefs.error) {
        loadStepsFromPattern(prefs.pattern || def || '');
        $('target-min').value = prefs.targetMinutes || 60;
        $('sep-artist').value = prefs.sepArtist ?? 4;
        $('sep-title').value = prefs.sepTitle ?? 8;
        $('chk-artist').checked = prefs.checkArtist ?? true;
        $('chk-title').checked = prefs.checkTitle ?? true;
    } else {
        loadStepsFromPattern(def || '');
    }

    const cats = await pgCmd('categories');
    if (Array.isArray(cats)) renderPalette(cats);

    const tabInfo = await pgCmd('playing-tab');
    if (tabInfo && !tabInfo.error) { playingTab = Number.isInteger(tabInfo.playingTab) ? tabInfo.playingTab : -1; selectedTab = playingTab >= 0 ? playingTab : 0; }
    renderTargets();
    quickSummary();

    ['target-min', 'sep-artist', 'sep-title'].forEach(id => $(id).addEventListener('input', quickSummary));
    ['target-min', 'sep-artist', 'sep-title'].forEach(id => $(id).addEventListener('change', savePrefs));
    ['chk-artist', 'chk-title'].forEach(id => $(id).addEventListener('change', () => { quickSummary(); savePrefs(); }));
    $('btn-add-folder').addEventListener('click', addFolder);
    $('loc-time') && $('loc-time').addEventListener('click', () => addLocutionStep('time'));
    $('loc-temp') && $('loc-temp').addEventListener('click', () => addLocutionStep('temperature'));
    $('loc-hum') && $('loc-hum').addEventListener('click', () => addLocutionStep('humidity'));
    $('btn-preflight').addEventListener('click', runPreflight);
    $('btn-generate').addEventListener('click', runGenerate);
    $('btn-close').addEventListener('click', () => window.close());

    // Zona de drop unificada: permite soltar dentro y fuera de la lista para reordenar o añadir.
    const colRules = document.querySelector('.col-rules');
    
    function getDropTarget(clientY) {
        const box = $('steps');
        const children = Array.from(box.children);
        if (children.length === 0) return { index: 0, element: null, position: 'inside' };
        for (let i = 0; i < children.length; i++) {
            const rect = children[i].getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) return { index: i, element: children[i], position: 'top' };
        }
        return { index: children.length, element: children[children.length - 1], position: 'bottom' };
    }

    colRules.addEventListener('dragover', (e) => { 
        e.preventDefault(); 
        e.dataTransfer.dropEffect = 'move';
        
        const target = getDropTarget(e.clientY);
        document.querySelectorAll('.step').forEach(r => r.classList.remove('drop-target-top', 'drop-target-bottom'));
        if (target.element) {
            $('steps').classList.remove('drop-active');
            target.element.classList.add('drop-target-' + target.position);
        } else {
            $('steps').classList.add('drop-active');
        }
    });
    
    colRules.addEventListener('dragleave', (e) => { 
        // Cleanup handled by dragend and drop
    });
    
    colRules.addEventListener('drop', (e) => {
        e.preventDefault();
        document.querySelectorAll('.step').forEach(r => r.classList.remove('drop-target-top', 'drop-target-bottom'));
        $('steps').classList.remove('drop-active');
        
        const dragData = e.dataTransfer.getData('text/plain');
        if (!dragData) return;
        
        const target = getDropTarget(e.clientY);
        let toIndex = target.index;

        if (dragData.startsWith('step:')) {
            const fromIndex = parseInt(dragData.split(':')[1], 10);
            if (fromIndex !== toIndex && fromIndex !== toIndex - 1) {
                const movedItem = steps.splice(fromIndex, 1)[0];
                if (fromIndex < toIndex) toIndex--;
                steps.splice(toIndex, 0, movedItem);
                afterStepsChange();
            }
        } else {
            const step = folderStepFromToken(($('chk-include-sub').checked ? '@folder:' : '@folderflat:') + dragData);
            if (step) { steps.splice(toIndex, 0, step); afterStepsChange(); }
        }
    });

    loadExplorer();
    ipcRenderer.on('file-types-data-updated', () => loadExplorer());
}

document.addEventListener('DOMContentLoaded', init);
