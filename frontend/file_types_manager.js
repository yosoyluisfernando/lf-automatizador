'use strict';

// Ventana "Gestor de Tipos de Archivo". Izquierda: lista de tipos (defaults +
// del usuario). Derecha: propiedades del tipo (nombre/identificador/color) y la
// gestion de carpetas/archivos asignados a ese tipo, con sus opciones (incluir
// subcarpetas / ignorar separacion / guardar en historial).
//
// Fuente de la verdad:
//   - file_types.json        -> tipos (compartido con render.js / Ajustes)
//   - explicit_types.json     -> ruta -> typeId (formato intacto)
//   - file_type_options.json  -> ruta -> { kind, includeSubfolders, ignoreSeparation, saveToHistory }

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('../backend/utils/app_paths');
const { defaultFileTypes, normalizeFileTypes } = require('./file_types_data');
const fileTypeAssignments = require('./file_type_assignments');
const i18n = require('./i18n');

const configDir = getConfigDir(path.join(__dirname, '..', 'config'), __dirname);
const fileTypesPath = path.join(configDir, 'file_types.json');
const explicitTypesPath = path.join(configDir, 'explicit_types.json');
const generalPrefsPath = path.join(configDir, 'general_settings.json');
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } };
const byId = id => document.getElementById(id);

let fileTypes = [];
let explicitTypes = {};
let optionsDB = {};
let selectedTypeId = null;
let selectedAssignPath = null;

// Contexto del modal de opciones (Añadir / Modificar)
let optModalContext = null;

// ── Carga / guardado ───────────────────────────────────────────────────────
function loadAll() {
    fileTypes = normalizeFileTypes(readJson(fileTypesPath, defaultFileTypes));
    explicitTypes = readJson(explicitTypesPath, {}) || {};
    optionsDB = fileTypeAssignments.readOptions();
}

// Guarda los tipos preservando los campos que el Gestor no edita (perfil de
// fades/mezcla que administra la pestaña "Excepciones Mezclar" de Ajustes).
function saveFileTypes() {
    const disk = normalizeFileTypes(readJson(fileTypesPath, defaultFileTypes));
    const diskById = new Map(disk.map(t => [t.id, t]));
    const merged = fileTypes.map(t => {
        const base = diskById.get(t.id);
        if (!base) return t; // tipo nuevo aun no presente en disco
        return { ...base, name: t.name, identifier: t.identifier, color: t.color, aliases: t.aliases, shortcutRoot: t.shortcutRoot, shortcutSub: t.shortcutSub, showShortcut: t.showShortcut };
    });
    try { fs.writeFileSync(fileTypesPath, JSON.stringify(merged, null, 2)); } catch (e) {}
    fileTypes = normalizeFileTypes(merged);
}

function saveExplicit() { try { fs.writeFileSync(explicitTypesPath, JSON.stringify(explicitTypes, null, 2)); } catch (e) {} }
function saveOptions() { fileTypeAssignments.writeOptions(optionsDB); }

// Avisa al proceso main para que la ventana principal recargue y recoloree.
function notifyDataChanged() { try { ipcRenderer.send('file-types-data-changed'); } catch (e) {} }

// ── Utilidades ───────────────────────────────────────────────────────────
function getSelectedType() { return fileTypes.find(t => t.id === selectedTypeId) || null; }

function inferKind(p) {
    const opt = optionsDB[p];
    if (opt && (opt.kind === 'folder' || opt.kind === 'file')) return opt.kind;
    try { return fs.statSync(p).isDirectory() ? 'folder' : 'file'; } catch (e) { return 'file'; }
}

// Solo rutas reales del sistema de archivos. Filtra claves virtuales internas
// de explicit_types.json (p. ej. "temperature_locution"/"humidity_locution",
// que mapean las locuciones de clima a su tipo) para no mostrarlas ni migrarlas.
function isRealPath(p) { return /[\\/]/.test(p) || /^[a-zA-Z]:/.test(p); }

function assignmentsForType(typeId) {
    return Object.keys(explicitTypes)
        .filter(p => explicitTypes[p] === typeId && isRealPath(p))
        .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
}

// "Pendiente": asignacion creada antes (existe en explicit_types.json) que aun
// no tiene opciones nuevas en file_type_options.json. Se respeta su color (como
// siempre) pero todavia no aplica subcarpetas/separacion/historial nuevos.
function isPending(p) { return isRealPath(p) && !optionsDB[p] && Object.prototype.hasOwnProperty.call(explicitTypes, p); }
function countPending() { return Object.keys(explicitTypes).filter(p => isRealPath(p) && !optionsDB[p]).length; }
function firstTypeWithPending() {
    const p = Object.keys(explicitTypes).find(k => isRealPath(k) && !optionsDB[k]);
    return p ? explicitTypes[p] : null;
}

// ── Render: lista de tipos ─────────────────────────────────────────────────
function renderTypeList() {
    const ul = byId('type-list');
    ul.innerHTML = '';
    fileTypes.forEach(t => {
        const li = document.createElement('li');
        if (t.id === selectedTypeId) li.classList.add('selected');
        const dot = document.createElement('span');
        dot.textContent = t.name;
        dot.style.color = t.color || '#e0e0e0';
        li.appendChild(dot);
        if (t.readonly) {
            const lock = document.createElement('span');
            lock.className = 'lock';
            lock.textContent = '🔒';
            li.appendChild(lock);
        }
        li.addEventListener('click', () => selectType(t.id));
        ul.appendChild(li);
    });
}

function selectType(typeId) {
    selectedTypeId = typeId;
    selectedAssignPath = null;
    renderTypeList();
    renderProperties();
    renderAssignments();
    const t = getSelectedType();
    byId('btn-del-type').disabled = !t || t.readonly === true;
}

// ── Render: propiedades del tipo ───────────────────────────────────────────
function renderProperties() {
    const t = getSelectedType();
    const nameEl = byId('type-name');
    const idEl = byId('type-identifier');
    const colorEl = byId('type-color');
    if (!t) {
        nameEl.value = ''; idEl.value = ''; colorEl.value = '#ffffff';
        nameEl.disabled = idEl.disabled = colorEl.disabled = true;
        const rEl = byId('type-root'); if (rEl) rEl.value = '';
        const sEl = byId('type-show-shortcut'); if (sEl) { sEl.checked = false; sEl.disabled = true; }
        const pb = byId('btn-pick-root'); if (pb) pb.disabled = true;
        const cb = byId('btn-clear-root'); if (cb) cb.disabled = true;
        return;
    }
    nameEl.value = t.name || '';
    idEl.value = t.identifier || '';
    colorEl.value = /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : '#ffffff';
    // Los tipos por defecto conservan nombre/identificador/color oficiales.
    const lock = t.readonly === true;
    nameEl.disabled = lock;
    idEl.disabled = lock;
    // El color es editable en TODOS los tipos excepto Locuciones (hora).
    const colorLock = t.id === 't_time';
    colorEl.disabled = colorLock;
    const resetColorBtn = byId('btn-reset-color'); if (resetColorBtn) resetColorBtn.disabled = colorLock;

    // Carpeta raíz + "mostrar acceso directo" (editable incluso en tipos por
    // defecto). Locuciones: bloqueado (se configura en Ajustes; sin acceso directo).
    const rootEl = byId('type-root');
    const showEl = byId('type-show-shortcut');
    const pickBtn = byId('btn-pick-root');
    const clearBtn = byId('btn-clear-root');
    const isLocution = t.id === 't_time';
    if (rootEl) rootEl.value = t.shortcutRoot || '';
    if (showEl) { showEl.checked = t.showShortcut === true; showEl.disabled = isLocution; }
    if (pickBtn) pickBtn.disabled = isLocution;
    if (clearBtn) clearBtn.disabled = isLocution || !t.shortcutRoot;
    const noteRow = byId('row-shortcut-note'); if (noteRow) noteRow.style.display = isLocution ? '' : 'none';
    const showRow = byId('row-show-shortcut'); if (showRow) showRow.style.display = isLocution ? 'none' : '';
}

function commitPropertyEdits() {
    const t = getSelectedType();
    if (!t) return;
    if (!t.readonly) {
        t.name = byId('type-name').value.trim() || t.name;
        t.identifier = byId('type-identifier').value.trim();
    }
    // El color es editable en todos los tipos excepto Locuciones (hora).
    if (t.id !== 't_time') {
        const c = byId('type-color').value;
        if (/^#[0-9a-f]{6}$/i.test(c)) t.color = c;
    }
}

// ── Render: tabla de asignaciones ──────────────────────────────────────────
function renderAssignments() {
    const body = byId('assign-body');
    const empty = byId('assign-empty');
    body.innerHTML = '';
    const paths = selectedTypeId ? assignmentsForType(selectedTypeId) : [];
    empty.style.display = paths.length ? 'none' : 'block';

    const yes = i18n.t('file_types_manager.yes') || 'Sí';
    const no = i18n.t('file_types_manager.no') || 'No';
    const type = getSelectedType();
    paths.forEach(p => {
        const kind = inferKind(p);
        const pending = isPending(p);
        // Pendiente: mostrar el estado REAL (todavia sin opciones nuevas), para
        // que la tabla no prometa comportamientos que aun no estan aplicados.
        const opt = pending
            ? { kind, includeSubfolders: false, ignoreSeparation: false, saveToHistory: type?.history === true }
            : (fileTypeAssignments.getOptions(p, optionsDB) || fileTypeAssignments.normalizeOptions({ kind }, kind));
        const tr = document.createElement('tr');
        if (pending) tr.classList.add('pending');
        if (p === selectedAssignPath) tr.classList.add('selected');

        const tdPath = document.createElement('td');
        tdPath.className = 'folder-path';
        if (pending) {
            const tag = document.createElement('span');
            tag.className = 'pending-tag';
            tag.textContent = '⚠';
            tag.title = i18n.t('file_types_manager.pending_hint') || 'Pendiente de configurar';
            tdPath.appendChild(tag);
        }
        tdPath.appendChild(document.createTextNode(p));
        tr.appendChild(tdPath);

        const tdKind = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = 'badge ' + (kind === 'folder' ? 'folder' : 'file');
        badge.textContent = kind === 'folder'
            ? (i18n.t('file_types_manager.kind_folder') || 'Carpeta')
            : (i18n.t('file_types_manager.kind_file') || 'Archivo');
        tdKind.appendChild(badge);
        tr.appendChild(tdKind);

        const tdSub = document.createElement('td');
        tdSub.innerHTML = kind === 'folder'
            ? (opt.includeSubfolders ? `<span class="yes">${yes}</span>` : `<span class="no">${no}</span>`)
            : '<span class="no">—</span>';
        tr.appendChild(tdSub);

        const tdSep = document.createElement('td');
        tdSep.innerHTML = opt.ignoreSeparation ? `<span class="yes">${yes}</span>` : `<span class="no">${no}</span>`;
        tr.appendChild(tdSep);

        const tdHist = document.createElement('td');
        tdHist.innerHTML = opt.saveToHistory ? `<span class="yes">${yes}</span>` : `<span class="no">${no}</span>`;
        tr.appendChild(tdHist);

        tr.addEventListener('click', () => {
            selectedAssignPath = p;
            renderAssignments();
        });
        tr.addEventListener('dblclick', () => openOptModal('modify', [{ path: p, kind }]));
        body.appendChild(tr);
    });

    const hasSel = !!selectedAssignPath && paths.includes(selectedAssignPath);
    byId('btn-mod-assign').disabled = !hasSel;
    byId('btn-del-assign').disabled = !hasSel;
}

// ── Modal de opciones ──────────────────────────────────────────────────────
function openOptModal(mode, targets) {
    const clean = (targets || []).filter(t => t && t.path);
    if (!clean.length || !selectedTypeId) return;
    optModalContext = { mode, targets: clean };
    const t = getSelectedType();
    const hasFolder = clean.some(x => x.kind === 'folder');

    byId('opt-title').textContent = mode === 'modify'
        ? (i18n.t('modals.assign_type.title_modify') || 'Modificar asignación')
        : (i18n.t('modals.assign_type.title') || 'Asignar tipo de archivo');

    const target = byId('opt-target');
    target.textContent = '';
    const b = document.createElement('b');
    b.style.color = t?.color || '#fff';
    b.textContent = t?.name || selectedTypeId;
    target.appendChild(b);
    const detail = clean.length > 1
        ? `  —  ${i18n.t('modals.assign_type.items_count', { count: clean.length }) || (clean.length + ' elementos')}`
        : `  —  ${clean[0].path}`;
    target.appendChild(document.createTextNode(detail));

    // Valores: en "modify" se cargan los existentes; en "add" los recomendados.
    const subRow = byId('opt-subfolders-row');
    const subChk = byId('opt-subfolders');
    const ignoreChk = byId('opt-ignore-sep');
    const histChk = byId('opt-save-history');

    // En "modify" sobre una asignacion YA configurada se cargan sus valores.
    // En "add" o sobre una pendiente (sin opciones aun) se ofrecen los
    // recomendados, para que configurarla por primera vez sea un clic en Aceptar.
    const editingExisting = mode === 'modify' && clean.length === 1 && optionsDB[clean[0].path];
    if (editingExisting) {
        const existing = fileTypeAssignments.getOptions(clean[0].path, optionsDB);
        subChk.checked = existing.includeSubfolders === true;
        ignoreChk.checked = existing.ignoreSeparation === true;
        histChk.checked = existing.saveToHistory === true;
    } else {
        subChk.checked = hasFolder;
        ignoreChk.checked = true;
        histChk.checked = true;
    }

    subChk.disabled = !hasFolder;
    subRow.classList.toggle('disabled', !hasFolder);

    byId('opt-modal').style.display = 'flex';
}

function closeOptModal() {
    byId('opt-modal').style.display = 'none';
    optModalContext = null;
}

function applyOptModal() {
    if (!optModalContext || !selectedTypeId) return;
    const { targets } = optModalContext;
    const includeSub = byId('opt-subfolders').checked;
    const ignoreSep = byId('opt-ignore-sep').checked;
    const saveHist = byId('opt-save-history').checked;
    targets.forEach(({ path: p, kind }) => {
        explicitTypes[p] = selectedTypeId;
        fileTypeAssignments.setOptions(p, {
            kind,
            includeSubfolders: kind === 'folder' ? includeSub : false,
            ignoreSeparation: ignoreSep,
            saveToHistory: saveHist
        }, optionsDB);
    });
    saveExplicit();
    saveOptions();
    notifyDataChanged();
    closeOptModal();
    renderAssignments();
    updateMigrateNotice();
}

// ── Añadir / modificar / eliminar asignaciones ─────────────────────────────

// ¿La ruta ya pertenece a OTRO tipo (asignación directa o dentro de una carpeta
// asignada con subcarpetas de otro tipo)? Devuelve el typeId en conflicto o null.
function findConflictingType(p) {
    if (explicitTypes[p] && explicitTypes[p] !== selectedTypeId) return explicitTypes[p];
    const norm = pp => String(pp).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const target = norm(p);
    for (const [assignedPath, typeId] of Object.entries(explicitTypes)) {
        if (typeId === selectedTypeId || !isRealPath(assignedPath)) continue;
        const opt = optionsDB[assignedPath];
        const isFolder = opt ? opt.kind === 'folder' : (() => { try { return fs.statSync(assignedPath).isDirectory(); } catch (e) { return false; } })();
        if (!isFolder) continue;
        const includeSub = opt ? opt.includeSubfolders !== false : true;
        const ap = norm(assignedPath);
        if (target === ap) return typeId;
        if (includeSub && target.startsWith(ap + '/')) return typeId;
    }
    return null;
}

// Avisa si algún ítem ya pertenece a otro tipo y pregunta si moverlo. Devuelve
// false si el usuario cancela (no se agrega).
async function checkConflictAndConfirm(items) {
    for (const item of items) {
        const conflictId = findConflictingType(item.path);
        if (conflictId) {
            const conflictName = (fileTypes.find(t => t.id === conflictId) || {}).name || conflictId;
            const move = await ipcRenderer.invoke('dialog:confirm',
                `"${item.path}" ya pertenece al tipo "${conflictName}".\n\n¿Mover a "${getSelectedType()?.name || ''}"?  (Cancelar = no agregar)`);
            if (!move) return false;
        }
    }
    return true;
}

async function addFolder() {
    if (!selectedTypeId) return;
    const folder = await ipcRenderer.invoke('dialog:pickFolder', { title: i18n.t('file_types_manager.pick_folder_title') || 'Seleccionar carpeta' });
    if (!folder) return;
    if (!(await checkConflictAndConfirm([{ path: folder, kind: 'folder' }]))) return;
    openOptModal('add', [{ path: folder, kind: 'folder' }]);
}

async function addFile() {
    if (!selectedTypeId) return;
    const files = await ipcRenderer.invoke('dialog:pickAudioFiles', { title: i18n.t('file_types_manager.pick_file_title') || 'Seleccionar archivo de audio' });
    const list = Array.isArray(files) ? files.filter(Boolean) : (files ? [files] : []);
    if (!list.length) return;
    const items = list.map(p => ({ path: p, kind: 'file' }));
    if (!(await checkConflictAndConfirm(items))) return;
    openOptModal('add', items);
}

function modifySelected() {
    if (!selectedAssignPath) return;
    openOptModal('modify', [{ path: selectedAssignPath, kind: inferKind(selectedAssignPath) }]);
}

async function deleteSelected() {
    if (!selectedAssignPath) return;
    const ok = await ipcRenderer.invoke('dialog:confirm', i18n.t('file_types_manager.confirm_delete_assign') || '¿Eliminar la asignación seleccionada?');
    if (!ok) return;
    delete explicitTypes[selectedAssignPath];
    fileTypeAssignments.removeOptions(selectedAssignPath, optionsDB);
    selectedAssignPath = null;
    saveExplicit();
    saveOptions();
    notifyDataChanged();
    renderAssignments();
    updateMigrateNotice();
}

// ── Añadir / eliminar tipos ────────────────────────────────────────────────
function addType() {
    const newId = 't_' + Date.now();
    fileTypes.push({
        id: newId,
        name: i18n.t('file_types_manager.new_type') || 'Nuevo Tipo',
        color: '#ffffff', identifier: '', searchIn: 'all', amp: 0, report: false, history: false, voice: false, readonly: false
    });
    saveFileTypes();
    notifyDataChanged();
    selectType(newId);
    byId('type-name').focus();
    byId('type-name').select();
}

async function deleteType() {
    const t = getSelectedType();
    if (!t || t.readonly) return;
    const ok = await ipcRenderer.invoke('dialog:confirm', i18n.t('file_types_manager.confirm_delete_type', { name: t.name }) || `¿Eliminar el tipo "${t.name}" y sus asignaciones?`);
    if (!ok) return;
    // Quitar el tipo y limpiar sus asignaciones huérfanas.
    assignmentsForType(t.id).forEach(p => {
        delete explicitTypes[p];
        fileTypeAssignments.removeOptions(p, optionsDB);
    });
    fileTypes = fileTypes.filter(x => x.id !== t.id);
    saveFileTypes();
    saveExplicit();
    saveOptions();
    notifyDataChanged();
    selectedTypeId = fileTypes[0]?.id || null;
    selectType(selectedTypeId);
    updateMigrateNotice();
}

// ── Aviso de migracion (asignaciones previas sin opciones) ─────────────────
// Aparece al abrir el Gestor si hay asignaciones creadas antes que aun no
// tienen opciones. "Sí" = revisar una por una (el usuario configura cada una
// con el modal); "No"/Ahora no = dejarlas tal cual (sin tocar comportamiento).
let noticeDismissed = false;
function updateMigrateNotice() {
    const n = countPending();
    const banner = byId('migrate-notice');
    if (n > 0 && !noticeDismissed) {
        byId('migrate-notice-text').textContent = i18n.t('file_types_manager.migrate_notice', { count: n })
            || `Hay ${n} carpeta(s)/archivo(s) con tipo asignado de antes que aún no tienen configuración. ¿Revisarlos ahora?`;
        banner.style.display = 'flex';
    } else {
        banner.style.display = 'none';
    }
}

// ── Footer ──────────────────────────────────────────────────────────────────
function applyChanges() {
    commitPropertyEdits();
    saveFileTypes();
    notifyDataChanged();
    renderTypeList();
}

// ── Sincronizacion entrante (la ventana principal cambio asignaciones) ──────
ipcRenderer.on('file-types-data-updated', () => {
    const keepType = selectedTypeId;
    const keepAssign = selectedAssignPath;
    loadAll();
    if (!fileTypes.some(t => t.id === keepType)) selectedTypeId = fileTypes[0]?.id || null;
    else selectedTypeId = keepType;
    selectedAssignPath = keepAssign;
    renderTypeList();
    renderProperties();
    renderAssignments();
    updateMigrateNotice();
});

// ── Wiring ───────────────────────────────────────────────────────────────────
async function pickShortcutRoot() {
    const t = getSelectedType();
    if (!t || t.id === 't_time') return;
    let folder = '';
    try { folder = await ipcRenderer.invoke('dialog:pickFolder', { title: 'Carpeta raíz de ' + t.name }); } catch (e) { folder = ''; }
    if (!folder) return;
    // Si cambiamos de raíz, soltar la asignación de la raíz anterior.
    if (t.shortcutRoot && t.shortcutRoot !== folder) {
        delete explicitTypes[t.shortcutRoot];
        fileTypeAssignments.removeOptions(t.shortcutRoot, optionsDB);
    }
    t.shortcutRoot = folder;
    t.shortcutSub = true; // raíz de tipo: siempre incluye subcarpetas.
    // La raíz se asigna como carpeta de ESTE tipo: su contenido toma el tipo
    // (color/separación) y aparece en "Carpetas y archivos asignados".
    explicitTypes[folder] = t.id;
    fileTypeAssignments.setOptions(folder, { kind: 'folder', includeSubfolders: true, ignoreSeparation: true, saveToHistory: false }, optionsDB);
    saveFileTypes();
    saveExplicit();
    saveOptions();
    notifyDataChanged();
    renderProperties();
    renderAssignments();
}
function clearShortcutRoot() {
    const t = getSelectedType();
    if (!t || t.id === 't_time') return;
    const old = t.shortcutRoot;
    if (old) {
        delete explicitTypes[old];
        fileTypeAssignments.removeOptions(old, optionsDB);
    }
    delete t.shortcutRoot; delete t.shortcutSub;
    saveFileTypes();
    saveExplicit();
    saveOptions();
    notifyDataChanged();
    renderProperties();
    renderAssignments();
}
function toggleShowShortcut() {
    const t = getSelectedType();
    if (!t || t.id === 't_time') return;
    t.showShortcut = byId('type-show-shortcut').checked === true;
    saveFileTypes();
    notifyDataChanged();
}

function applyColorChange() {
    const t = getSelectedType();
    if (!t || t.id === 't_time') return;
    const c = byId('type-color').value;
    if (!/^#[0-9a-f]{6}$/i.test(c)) return;
    t.color = c;
    saveFileTypes();
    notifyDataChanged();
    renderTypeList();
}
function resetTypeColor() {
    const t = getSelectedType();
    if (!t || t.id === 't_time') return;
    const def = (defaultFileTypes.find(d => d.id === t.id) || {}).color;
    const color = /^#[0-9a-f]{6}$/i.test(def || '') ? def : '#e0e0e0';
    t.color = color;
    const colorEl = byId('type-color'); if (colorEl) colorEl.value = color;
    saveFileTypes();
    notifyDataChanged();
    renderTypeList();
}

byId('btn-add-type').addEventListener('click', addType);
byId('type-color') && byId('type-color').addEventListener('change', applyColorChange);
byId('btn-reset-color') && byId('btn-reset-color').addEventListener('click', resetTypeColor);
byId('btn-pick-root') && byId('btn-pick-root').addEventListener('click', pickShortcutRoot);
byId('btn-clear-root') && byId('btn-clear-root').addEventListener('click', clearShortcutRoot);
byId('type-show-shortcut') && byId('type-show-shortcut').addEventListener('change', toggleShowShortcut);
byId('btn-del-type').addEventListener('click', deleteType);
byId('btn-add-folder').addEventListener('click', addFolder);
byId('btn-add-file').addEventListener('click', addFile);
byId('btn-mod-assign').addEventListener('click', modifySelected);
byId('btn-del-assign').addEventListener('click', deleteSelected);
byId('opt-accept').addEventListener('click', applyOptModal);
byId('opt-cancel').addEventListener('click', closeOptModal);
byId('opt-modal').addEventListener('click', (e) => { if (e.target === byId('opt-modal')) closeOptModal(); });
byId('btn-apply').addEventListener('click', applyChanges);
byId('btn-accept').addEventListener('click', () => { applyChanges(); window.close(); });
byId('btn-cancel').addEventListener('click', () => window.close());

// Aviso de migracion: "Revisar" salta al primer tipo con pendientes; ambos
// botones ocultan el aviso (las pendientes siguen marcadas en la tabla).
byId('migrate-review').addEventListener('click', () => {
    noticeDismissed = true;
    updateMigrateNotice();
    const t = firstTypeWithPending();
    if (t) selectType(t);
});
byId('migrate-dismiss').addEventListener('click', () => { noticeDismissed = true; updateMigrateNotice(); });

// Edicion en vivo de propiedades (se persisten al Aplicar / Aceptar).
['type-name', 'type-identifier', 'type-color'].forEach(id => {
    byId(id).addEventListener('input', commitPropertyEdits);
});

(function init() {
    try {
        const prefs = readJson(generalPrefsPath, {});
        i18n.init(prefs.language || 'es');
        i18n.applyToDOM();
        loadAll();
        selectType(fileTypes[0]?.id || null);
        updateMigrateNotice();
    } catch (err) {
        alert('ERROR: ' + err.message + '\n' + err.stack);
    }
})();
