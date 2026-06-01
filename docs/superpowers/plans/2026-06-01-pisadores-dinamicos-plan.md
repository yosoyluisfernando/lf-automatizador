# Pisadores dinamicos y reglas automaticas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Incorporar cuatro pisadores uniformes por pista, fuentes aleatorias o integradas, anclajes dinamicos y reglas rapidas de playlist con precarga determinista en Rust.

**Architecture:** Extraer la logica portable a `frontend/pisador_rules.js` y la preparacion asincrona de overlays a `frontend/pisador_runtime.js`. El Editor Avanzado persistira `P1-P4` en SQLite; la playlist guardara reglas rapidas como metadata de fila y opcionalmente por ruta. `frontend/render.js` coordinara las sesiones de reproduccion y Rust recibira archivos o secuencias precargadas con autoplay desactivado.

**Tech Stack:** Electron, Node.js CommonJS, SQLite con `better-sqlite3`, HTML/CSS, motor Rust con `rodio`, pruebas `node:test`, `cargo test`.

---

## File map

### New files

- `frontend/pisador_rules.js`: contrato portable para fuentes, condiciones, opciones de overflow, reglas rapidas y normalizacion de rutas.
- `frontend/pisador_runtime.js`: planner asincrono que resuelve fuentes concretas, filtra carpetas por duracion y crea sesiones deterministas.
- `tests/pisador_rules.test.js`: pruebas unitarias del contrato de datos.
- `tests/pisador_runtime.test.js`: pruebas unitarias del planner.
- `tests/pisador_db_regressions.test.js`: pruebas de esquema, migracion y transporte IPC.
- `tests/pisador_ui_regressions.test.js`: pruebas estructurales de ambas superficies de UI.
- `tests/pisador_engine_contract.test.js`: pruebas del adaptador Electron y contrato Rust.

### Existing files to modify

- `database.js`: columnas `P4`, opciones por pisador y migracion heredada de hora.
- `main.js`: transporte legado de filas SQLite con `P4` y opciones.
- `backend/ipc/library.js`: guardar y devolver `P1-P4`.
- `frontend/audio_editor.html`: contenedor compacto y modal de seguridad.
- `frontend/audio_editor.js`: render de filas uniformes, dialogos por fuente y validacion Intro/Outro.
- `frontend/index.html`: opcion contextual y modal de regla rapida.
- `frontend/render.js`: metadata de fila, preferencias por ruta, preparacion y disparo de sesiones.
- `frontend/audio_engine_client.js`: exponer `loadSequence`, `cacheDuration` y `cartwallSequence`.
- `audio-engine-rust/src/main.rs`: cargar secuencias gapless pausadas y reproducirlas despues.
- `Documentación/05_editor_audio.md`: documentar `P1-P4`, fuentes y anclajes.
- `Documentación/01_consola_principal.md`: documentar la herramienta contextual.

## Task 1: Crear el contrato portable de pisadores

**Files:**
- Create: `frontend/pisador_rules.js`
- Create: `tests/pisador_rules.test.js`

- [ ] **Step 1: Write the failing contract tests**

```js
'use strict';

const assert = require('assert');
const path = require('path');
const test = require('node:test');

const rules = require('../frontend/pisador_rules');

test('legacy file paths remain file sources', () => {
    assert.deepStrictEqual(rules.parsePisadorSource('C:\\Radio\\id.mp3'), {
        v: 1, kind: 'file', path: 'C:\\Radio\\id.mp3'
    });
});

test('folder and builtin sources round-trip as portable JSON', () => {
    const folder = { v: 1, kind: 'folder', path: '/home/radio/pisadores' };
    assert.deepStrictEqual(rules.parsePisadorSource(rules.serializePisadorSource(folder)), folder);
    assert.deepStrictEqual(
        rules.parsePisadorSource(rules.serializePisadorSource({ v: 1, kind: 'builtin', name: 'temperature' })),
        { v: 1, kind: 'builtin', name: 'temperature' }
    );
});

test('dynamic anchors map to the approved mode and symbolic time', () => {
    assert.deepStrictEqual(rules.conditionToStorage('intro'), { mode: 'end', time: 'intro' });
    assert.deepStrictEqual(rules.conditionToStorage('outro'), { mode: 'start', time: 'outro' });
    assert.strictEqual(rules.storageToCondition('end', 'intro'), 'intro');
    assert.strictEqual(rules.storageToCondition('start', 'outro'), 'outro');
});

test('missing dynamic markers are rejected', () => {
    assert.deepStrictEqual(rules.validateDynamicAnchor('intro', { intro: 0, outro: 9 }), {
        ok: false, marker: 'intro'
    });
    assert.deepStrictEqual(rules.validateDynamicAnchor('outro', { intro: 4, outro: 12 }), {
        ok: true, marker: 'outro', seconds: 12
    });
});

test('quick rules normalize scope, priority and start time', () => {
    assert.deepStrictEqual(rules.normalizeQuickRule({
        source: { kind: 'folder', path: '/radio/ids' },
        startSeconds: '8.25',
        advancedPolicy: 'ignore',
        scope: 'path'
    }), {
        v: 1,
        source: { v: 1, kind: 'folder', path: '/radio/ids' },
        startSeconds: 8.25,
        advancedPolicy: 'ignore',
        scope: 'path'
    });
});

test('path keys are case-insensitive only on Windows', () => {
    const win = rules.normalizeRulePathKey('C:\\Radio\\IDS', 'win32');
    const winLower = rules.normalizeRulePathKey('c:\\radio\\ids', 'win32');
    assert.strictEqual(win, winLower);
    assert.strictEqual(
        rules.normalizeRulePathKey('/Radio/IDS', 'linux') === rules.normalizeRulePathKey('/radio/ids', 'linux'),
        false
    );
});
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run:

```powershell
node --test tests/pisador_rules.test.js
```

Expected: FAIL with `Cannot find module '../frontend/pisador_rules'`.

- [ ] **Step 3: Implement the portable contract**

Create `frontend/pisador_rules.js`:

```js
'use strict';

const path = require('path');

const PISADOR_IDS = Object.freeze(['p1', 'p2', 'p3', 'p4']);
const SOURCE_KINDS = new Set(['file', 'folder', 'builtin']);
const BUILTIN_NAMES = new Set(['time', 'temperature', 'humidity']);
const OVERFLOW_POLICIES = new Set(['skip', 'truncate-at-intro', 'allow-overlap']);
const QUICK_ADVANCED_POLICIES = new Set(['respect', 'ignore']);
const QUICK_SCOPES = new Set(['row', 'path']);

function normalizePisadorSource(source) {
    if (!source) return null;
    if (typeof source === 'string') return { v: 1, kind: 'file', path: source };
    const kind = SOURCE_KINDS.has(source.kind) ? source.kind : '';
    if (kind === 'builtin') {
        return BUILTIN_NAMES.has(source.name) ? { v: 1, kind, name: source.name } : null;
    }
    const sourcePath = String(source.path || '').trim();
    return sourcePath ? { v: 1, kind, path: sourcePath } : null;
}

function parsePisadorSource(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (!raw.startsWith('{')) return normalizePisadorSource(raw);
    try { return normalizePisadorSource(JSON.parse(raw)); } catch (err) { return null; }
}

function serializePisadorSource(source) {
    const normalized = normalizePisadorSource(source);
    if (!normalized) return null;
    return normalized.kind === 'file' ? normalized.path : JSON.stringify(normalized);
}

function normalizePisadorOptions(value) {
    let parsed = value;
    if (typeof value === 'string') {
        try { parsed = JSON.parse(value); } catch (err) { parsed = {}; }
    }
    const overflowPolicy = OVERFLOW_POLICIES.has(parsed?.overflowPolicy)
        ? parsed.overflowPolicy
        : 'skip';
    return { v: 1, overflowPolicy };
}

function serializePisadorOptions(value) {
    return JSON.stringify(normalizePisadorOptions(value));
}

function conditionToStorage(condition, manualTime = null) {
    if (condition === 'intro') return { mode: 'end', time: 'intro' };
    if (condition === 'outro') return { mode: 'start', time: 'outro' };
    return { mode: condition === 'end' ? 'end' : 'start', time: manualTime };
}

function storageToCondition(mode, time) {
    if (time === 'intro') return 'intro';
    if (time === 'outro') return 'outro';
    return mode === 'end' ? 'end' : 'start';
}

function validateDynamicAnchor(condition, markers = {}) {
    if (condition !== 'intro' && condition !== 'outro') return { ok: true };
    const seconds = Number(markers[condition]);
    return Number.isFinite(seconds) && seconds > 0
        ? { ok: true, marker: condition, seconds }
        : { ok: false, marker: condition };
}

function normalizeQuickRule(rule) {
    const source = normalizePisadorSource(rule?.source);
    const startSeconds = Number(rule?.startSeconds);
    if (!source || !Number.isFinite(startSeconds) || startSeconds < 0) return null;
    return {
        v: 1,
        source,
        startSeconds,
        advancedPolicy: QUICK_ADVANCED_POLICIES.has(rule?.advancedPolicy) ? rule.advancedPolicy : 'respect',
        scope: QUICK_SCOPES.has(rule?.scope) ? rule.scope : 'row'
    };
}

function normalizeRulePathKey(value, platform = process.platform) {
    const resolved = path.resolve(String(value || '').trim());
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

module.exports = {
    PISADOR_IDS,
    parsePisadorSource,
    serializePisadorSource,
    normalizePisadorSource,
    normalizePisadorOptions,
    serializePisadorOptions,
    conditionToStorage,
    storageToCondition,
    validateDynamicAnchor,
    normalizeQuickRule,
    normalizeRulePathKey
};
```

- [ ] **Step 4: Run the unit test**

Run:

```powershell
node --test tests/pisador_rules.test.js
```

Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add frontend/pisador_rules.js tests/pisador_rules.test.js
git commit -m "feat: add portable pisador rule contract"
```

## Task 2: Extender SQLite con P4 y migrar la locucion horaria heredada

**Files:**
- Modify: `database.js:311-337`
- Modify: `database.js:690-716`
- Modify: `main.js:950-1045`
- Modify: `main.js:1104-1112`
- Modify: `backend/ipc/library.js:144-180`
- Create: `tests/pisador_db_regressions.test.js`

- [ ] **Step 1: Write failing regression tests for schema and IPC transport**

```js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const dbSource = fs.readFileSync(path.join(root, 'database.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const librarySource = fs.readFileSync(path.join(root, 'backend', 'ipc', 'library.js'), 'utf8');

test('tracks schema adds P4 and per-pisador options idempotently', () => {
    ['p1_options TEXT', 'p2_options TEXT', 'p3_options TEXT', 'p4_active INTEGER',
     'p4_mode TEXT', 'p4_time TEXT', 'p4_file TEXT', 'p4_options TEXT']
        .forEach(column => assert.match(dbSource, new RegExp(column.replace(' ', '\\\\s+'))));
});

test('legacy phora migrates once into builtin time P4 without deleting legacy columns', () => {
    assert.match(dbSource, /pisador_p4_time_migrated/);
    assert.match(dbSource, /builtin.*time/);
    assert.doesNotMatch(dbSource, /DROP COLUMN\s+phora/i);
});

test('main and library IPC carry P4 options and source', () => {
    for (const source of [mainSource, librarySource]) {
        assert.match(source, /p4_active/);
        assert.match(source, /p4_mode/);
        assert.match(source, /p4_time/);
        assert.match(source, /p4_file/);
        assert.match(source, /p4_options/);
    }
});
```

- [ ] **Step 2: Run the regression test to verify it fails**

Run:

```powershell
node --test tests/pisador_db_regressions.test.js
```

Expected: FAIL because `p4_active` and `p1_options` are absent.

- [ ] **Step 3: Add idempotent columns and migration**

In `database.js`, append to `ensureMetadataSchema()`:

```js
        'p1_options TEXT',
        'p2_options TEXT',
        'p3_options TEXT',
        'p4_active INTEGER DEFAULT 0',
        "p4_mode TEXT DEFAULT 'start'",
        'p4_time TEXT',
        'p4_file TEXT',
        'p4_options TEXT'
```

Add after `migratePisadorUndefinedBugs()`:

```js
function migrateLegacyTimePisadorToP4() {
    const key = 'pisador_p4_time_migrated';
    if (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)) return;
    const builtinTime = JSON.stringify({ v: 1, kind: 'builtin', name: 'time' });
    db.prepare(`
        UPDATE tracks
        SET p4_active = 1,
            p4_mode = COALESCE(NULLIF(phora_mode, ''), 'start'),
            p4_time = phora_time,
            p4_file = ?,
            p4_options = ?
        WHERE phora_active = 1
          AND phora_time IS NOT NULL
          AND COALESCE(p4_active, 0) = 0
    `).run(builtinTime, JSON.stringify({ v: 1, overflowPolicy: 'skip' }));
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, '1', ?)")
      .run(key, new Date().toISOString());
}
migrateLegacyTimePisadorToP4();
```

- [ ] **Step 4: Carry P1-P4 through backend maps and UPSERTs**

In `main.js` and `backend/ipc/library.js`:

- Extend sanitization to clear `p4_active` and `p4_time`.
- Extend row mapping with `p1_options`, `p2_options`, `p3_options`, `p4_active`, `p4_mode`, `p4_time`, `p4_file`, `p4_options`.
- Extend `saveDbTrackStmt` columns, values and conflict updates.
- Extend `lib-save-db-track` payload:

```js
p1_options: trackData.p1_options || null,
p2_options: trackData.p2_options || null,
p3_options: trackData.p3_options || null,
p4_active: trackData.p4_active ? 1 : 0,
p4_mode: trackData.p4_mode || 'start',
p4_time: trackData.p4_time || null,
p4_file: trackData.p4_file || null,
p4_options: trackData.p4_options || null,
```

Keep `phora_*` in the SQL transport unchanged for downgrade compatibility.

- [ ] **Step 5: Run database regressions and the full Node suite**

Run:

```powershell
node --test tests/pisador_db_regressions.test.js
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add database.js main.js backend/ipc/library.js tests/pisador_db_regressions.test.js
git commit -m "feat: persist fourth pisador and migrate legacy time cue"
```

## Task 3: Uniformar P1-P4 en el Editor Avanzado

**Files:**
- Modify: `frontend/audio_editor.html:118-189`
- Modify: `frontend/audio_editor.js:1-90`
- Modify: `frontend/audio_editor.js:497-713`
- Modify: `frontend/audio_editor.js:935-954`
- Modify: `frontend/audio_editor.js:1065-1070`
- Create: `tests/pisador_ui_regressions.test.js`

- [ ] **Step 1: Write failing editor UI regressions**

```js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const editorHtml = fs.readFileSync(path.join(root, 'frontend', 'audio_editor.html'), 'utf8');
const editorJs = fs.readFileSync(path.join(root, 'frontend', 'audio_editor.js'), 'utf8');

test('advanced editor renders four uniform pisador rows', () => {
    assert.match(editorHtml, /id="pisadores-list"/);
    assert.match(editorJs, /PISADOR_IDS/);
    assert.doesNotMatch(editorHtml, /mode-phora/);
});

test('advanced editor exposes the approved condition order and source types', () => {
    assert.match(editorJs, /Inicia en[\s\S]*Termina en[\s\S]*Termina en Intro[\s\S]*Inicia en Outro/);
    assert.match(editorJs, /Archivo especifico[\s\S]*Carpeta aleatoria[\s\S]*Locucion de hora[\s\S]*Temperatura[\s\S]*Humedad/);
});

test('advanced editor validates dynamic anchors and exposes overflow settings', () => {
    assert.match(editorJs, /validateDynamicAnchor/);
    assert.match(editorHtml, /id="pisador-overflow-modal"/);
    assert.match(editorJs, /overflowPolicy/);
});
```

- [ ] **Step 2: Run the UI regression test to verify it fails**

Run:

```powershell
node --test tests/pisador_ui_regressions.test.js
```

Expected: FAIL because the editor still contains `mode-phora`.

- [ ] **Step 3: Replace the static rows with a compact generated container**

In `frontend/audio_editor.html`, replace the current pisador rows with:

```html
<fieldset class="ae-fieldset" style="margin-bottom: 10px;">
    <legend>Pisadores (Eventos sobre pista)</legend>
    <div style="font-size:10px;color:#888;">Configura fuente y sincronizacion precisa para esta pista.</div>
    <div id="pisadores-list"></div>
</fieldset>

<div id="pisador-overflow-modal" class="modal-overlay" style="display:none;">
    <div class="modal-box" style="width:420px;height:auto;">
        <div class="modal-header">Seguridad del pisador <span id="pisador-overflow-label"></span></div>
        <div class="modal-body">
            <label for="pisador-overflow-policy">Si ningun audio cabe antes del Intro:</label>
            <select id="pisador-overflow-policy" class="ae-input">
                <option value="skip">Cancelar el pisador y registrar aviso</option>
                <option value="truncate-at-intro">Iniciar desde el principio y truncar al llegar al Intro</option>
                <option value="allow-overlap">Iniciar desde el principio y dejar terminar completo</option>
            </select>
        </div>
        <div class="modal-footer">
            <button class="cue-btn" onclick="closePisadorOverflowModal()">Cancelar</button>
            <button class="cue-btn" onclick="savePisadorOverflowModal()">Guardar</button>
        </div>
    </div>
</div>
```

- [ ] **Step 4: Render four uniform rows and validate anchors**

At the top of `frontend/audio_editor.js` import:

```js
const {
    PISADOR_IDS,
    parsePisadorSource,
    serializePisadorSource,
    normalizePisadorOptions,
    serializePisadorOptions,
    conditionToStorage,
    storageToCondition,
    validateDynamicAnchor
} = require('./pisador_rules');
```

Add:

```js
const pisadorOptionsById = new Map();
let editingOverflowPisadorId = '';

function renderPisadorRows() {
    document.getElementById('pisadores-list').innerHTML = PISADOR_IDS.map(id => `
        <div class="pisador-row" data-pisador="${id}">
            <div class="pisador-controls">
                <strong>${id.toUpperCase()}:</strong>
                <select id="condition-${id}" class="ae-input pisador-condition">
                    <option value="start">Inicia en</option>
                    <option value="end">Termina en</option>
                    <option value="intro">Termina en Intro</option>
                    <option value="outro">Inicia en Outro</option>
                </select>
                <input type="text" id="cue-${id}" class="cue-time" value="0.00" readonly>
                <button class="cue-btn" id="fix-${id}" onclick="setCue('${id}')">Fijar</button>
                <button class="cue-btn" onclick="openPisadorOverflowModal('${id}')">&#9881;</button>
                <button class="cue-btn" onclick="clearCue('${id}')">X</button>
            </div>
            <div class="pisador-source-controls">
                <select id="source-kind-${id}" class="ae-input pisador-source-kind">
                    <option value="file">Archivo especifico</option>
                    <option value="folder">Carpeta aleatoria</option>
                    <option value="time">Locucion de hora</option>
                    <option value="temperature">Temperatura</option>
                    <option value="humidity">Humedad</option>
                </select>
                <input type="text" id="file-${id}" class="ae-input" readonly>
                <button class="cue-btn" id="browse-${id}" onclick="browsePisador('${id}')">...</button>
            </div>
            <div id="warning-${id}" class="pisador-warning" style="display:none;"></div>
        </div>
    `).join('');
    PISADOR_IDS.forEach(id => {
        document.getElementById(`condition-${id}`).addEventListener('change', () => syncPisadorUiState(id));
        document.getElementById(`source-kind-${id}`).addEventListener('change', () => syncPisadorUiState(id));
        pisadorOptionsById.set(id, normalizePisadorOptions(null));
        syncPisadorUiState(id);
    });
}

function syncPisadorUiState(id) {
    const condition = document.getElementById(`condition-${id}`).value;
    const kind = document.getElementById(`source-kind-${id}`).value;
    const dynamic = condition === 'intro' || condition === 'outro';
    document.getElementById(`cue-${id}`).style.display = dynamic ? 'none' : '';
    document.getElementById(`fix-${id}`).disabled = dynamic;
    document.getElementById(`file-${id}`).style.display = kind === 'file' || kind === 'folder' ? '' : 'none';
    document.getElementById(`browse-${id}`).style.display = kind === 'file' || kind === 'folder' ? '' : 'none';
    validatePisadorAnchor(id);
}

function validatePisadorAnchor(id) {
    const condition = document.getElementById(`condition-${id}`).value;
    const result = validateDynamicAnchor(condition, {
        intro: document.getElementById('cue-intro').value,
        outro: document.getElementById('cue-outro').value
    });
    const warning = document.getElementById(`warning-${id}`);
    warning.style.display = result.ok ? 'none' : '';
    warning.textContent = result.ok ? '' : `Debes fijar el marcador ${result.marker.toUpperCase()} antes de guardar.`;
    return result.ok;
}
```

Call `renderPisadorRows()` once after DOM initialization.

- [ ] **Step 5: Load and save symbolic anchors, sources and options**

Replace loops over `['p1', 'p2', 'p3', 'phora']` with `PISADOR_IDS`. For load:

```js
const condition = storageToCondition(row[`${id}_mode`], row[`${id}_time`]);
document.getElementById(`condition-${id}`).value = condition;
const source = parsePisadorSource(row[`${id}_file`]);
document.getElementById(`source-kind-${id}`).value = source?.kind === 'builtin' ? source.name : (source?.kind || 'file');
document.getElementById(`file-${id}`).value = source?.path || '';
pisadorOptionsById.set(id, normalizePisadorOptions(row[`${id}_options`]));
syncPisadorUiState(id);
```

For save:

```js
for (const id of PISADOR_IDS) {
    const condition = document.getElementById(`condition-${id}`).value;
    const manualTime = document.getElementById(`cue-${id}`).value;
    const stored = conditionToStorage(condition, manualTime);
    const sourceKind = document.getElementById(`source-kind-${id}`).value;
    const source = ['time', 'temperature', 'humidity'].includes(sourceKind)
        ? { v: 1, kind: 'builtin', name: sourceKind }
        : { v: 1, kind: sourceKind, path: document.getElementById(`file-${id}`).value };
    const validSource = serializePisadorSource(source);
    const active = Boolean(validSource) && (stored.time === 'intro' || stored.time === 'outro' || Number(stored.time) > 0);
    if (active && !validatePisadorAnchor(id)) throw new Error(`Pisador ${id.toUpperCase()} sin marcador dinamico.`);
    mc[`${id}_active`] = active;
    mc[`${id}_mode`] = stored.mode;
    mc[`${id}_time`] = active ? stored.time : null;
    mc[`${id}_file`] = validSource;
    mc[`${id}_options`] = serializePisadorOptions(pisadorOptionsById.get(id));
}
```

Catch the validation error in `saveAndClose()` and navigation buttons, showing `alert(err.message)` without closing or navigating.

- [ ] **Step 6: Use file or folder dialog according to source**

Replace `browsePisador`:

```js
window.browsePisador = async function(id) {
    const kind = document.getElementById(`source-kind-${id}`).value;
    const channel = kind === 'folder' ? 'dialog:selectFolder' : 'dialog:openFile';
    const selectedPath = await ipcRenderer.invoke(channel);
    if (selectedPath) document.getElementById(`file-${id}`).value = selectedPath;
};
```

Add modal open/save functions that read and write `pisadorOptionsById`.

- [ ] **Step 7: Implement the overflow modal functions**

Add:

```js
window.openPisadorOverflowModal = function(id) {
    editingOverflowPisadorId = id;
    document.getElementById('pisador-overflow-label').textContent = id.toUpperCase();
    document.getElementById('pisador-overflow-policy').value =
        normalizePisadorOptions(pisadorOptionsById.get(id)).overflowPolicy;
    document.getElementById('pisador-overflow-modal').style.display = 'flex';
};

window.closePisadorOverflowModal = function() {
    editingOverflowPisadorId = '';
    document.getElementById('pisador-overflow-modal').style.display = 'none';
};

window.savePisadorOverflowModal = function() {
    if (!editingOverflowPisadorId) return;
    pisadorOptionsById.set(editingOverflowPisadorId, normalizePisadorOptions({
        overflowPolicy: document.getElementById('pisador-overflow-policy').value
    }));
    closePisadorOverflowModal();
};
```

- [ ] **Step 8: Keep waveform markers numeric-only**

Replace overlay marker loops with `PISADOR_IDS`, but skip marker drawing and dragging when `parseFloat(cue.value)` is not finite. Dynamic Intro/Outro anchoring is already visible through the main Intro and Outro markers.

- [ ] **Step 9: Run UI regressions and Node suite**

Run:

```powershell
node --test tests/pisador_ui_regressions.test.js
npm test
```

Expected: PASS.

- [ ] **Step 10: Commit**

```powershell
git add frontend/audio_editor.html frontend/audio_editor.js tests/pisador_ui_regressions.test.js
git commit -m "feat: add four uniform pisadores to advanced editor"
```

## Task 4: Persistir reglas rapidas en filas y por ruta

**Files:**
- Modify: `frontend/index.html:478-495`
- Modify: `frontend/render.js:64-111`
- Modify: `frontend/render.js:615-650`
- Modify: `frontend/render.js:2947-3034`
- Modify: `frontend/render.js:3885-4030`
- Modify: `frontend/render.js:5455-5789`
- Modify: `tests/pisador_ui_regressions.test.js`
- Modify: `tests/pisador_rules.test.js`

- [ ] **Step 1: Add failing tests for quick rule metadata**

Append to `tests/pisador_rules.test.js`:

```js
test('quick rules serialize safely for dataset storage', () => {
    const encoded = rules.serializeQuickRule({
        source: { kind: 'builtin', name: 'humidity' },
        startSeconds: 5,
        advancedPolicy: 'respect',
        scope: 'row'
    });
    assert.deepStrictEqual(rules.parseQuickRule(encoded), {
        v: 1,
        source: { v: 1, kind: 'builtin', name: 'humidity' },
        startSeconds: 5,
        advancedPolicy: 'respect',
        scope: 'row'
    });
});
```

Append to `tests/pisador_ui_regressions.test.js`:

```js
const indexHtml = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const renderJs = fs.readFileSync(path.join(root, 'frontend', 'render.js'), 'utf8');

test('playlist exposes quick automatic pisador modal and serializes row metadata', () => {
    assert.match(indexHtml, /id="pm-auto-pisador"/);
    assert.match(indexHtml, /id="auto-pisador-modal"/);
    assert.match(renderJs, /automaticPisadorRule/);
    assert.match(renderJs, /automatic_sweeper_rules\.json/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test tests/pisador_rules.test.js tests/pisador_ui_regressions.test.js
```

Expected: FAIL because quick rule serialization and modal do not exist.

- [ ] **Step 3: Add quick rule serialization helpers**

In `frontend/pisador_rules.js` add:

```js
function parseQuickRule(value) {
    if (!value) return null;
    try { return normalizeQuickRule(typeof value === 'string' ? JSON.parse(value) : value); }
    catch (err) { return null; }
}

function serializeQuickRule(value) {
    const normalized = normalizeQuickRule(value);
    return normalized ? JSON.stringify(normalized) : '';
}
```

Export both functions.

- [ ] **Step 4: Add the contextual item and modal**

Inside `#pm-tools .submenu-tools` in `frontend/index.html`, add:

```html
<div class="context-item" id="pm-auto-pisador" style="color:#b56ad9;">Pisadores automaticos...</div>
```

Add a compact modal near the existing playlist modals:

```html
<div id="auto-pisador-modal" class="modal-overlay" style="display:none;">
  <div class="modal-content" style="width:430px;">
    <h3>Pisador automatico</h3>
    <select id="auto-pisador-source-kind" class="dark-select">
      <option value="file">Archivo especifico</option>
      <option value="folder">Carpeta aleatoria</option>
      <option value="time">Locucion de hora</option>
      <option value="temperature">Temperatura</option>
      <option value="humidity">Humedad</option>
    </select>
    <input id="auto-pisador-source-path" class="settings-input" readonly>
    <button id="auto-pisador-browse" class="settings-btn">...</button>
    <label>Inicia en <input id="auto-pisador-start" type="number" min="0" step="0.01" value="0"> segundos</label>
    <select id="auto-pisador-advanced-policy" class="dark-select">
      <option value="respect">Respetar pisadores del Editor Avanzado</option>
      <option value="ignore">Ignorar pisadores del Editor Avanzado</option>
    </select>
    <select id="auto-pisador-scope" class="dark-select">
      <option value="row">Solo esta fila de playlist</option>
      <option value="path">Cada vez que se vuelva a anadir esta ruta</option>
    </select>
    <button id="auto-pisador-clear" class="settings-btn">Quitar regla</button>
    <button id="auto-pisador-cancel" class="settings-btn">Cancelar</button>
    <button id="auto-pisador-save" class="settings-btn">Guardar</button>
  </div>
</div>
```

- [ ] **Step 5: Store row metadata in session, `.lfplay`, clipboard and restore paths**

At the top of `frontend/render.js` import:

```js
const {
    PISADOR_IDS,
    parseQuickRule,
    serializeQuickRule,
    normalizeQuickRule,
    normalizeRulePathKey
} = require('./pisador_rules');
```

Add `automaticPisadorRule` to `serializePlaylistRow()`, `handleSavePlaylist()`, `normalizePlaylistItem()`, `restoreSessionState()`, `loadPlaylistRowsInChunks()`, `pm-copy`, `pm-cut` and `pm-paste`:

```js
automaticPisadorRule: row.dataset.automaticPisadorRule || null
```

When restoring:

```js
if (lastInsertedRow && item.automaticPisadorRule) {
    lastInsertedRow.dataset.automaticPisadorRule = item.automaticPisadorRule;
}
```

- [ ] **Step 6: Load and save persistent per-path preferences**

In `frontend/render.js`:

```js
const AUTOMATIC_PISADOR_RULES_PATH = path.join(configDir, 'automatic_sweeper_rules.json');
let automaticPisadorRulesByPath = loadConfig(AUTOMATIC_PISADOR_RULES_PATH, {});

function getPersistentAutomaticPisadorRule(route) {
    return parseQuickRule(automaticPisadorRulesByPath[normalizeRulePathKey(route)]);
}

function setPersistentAutomaticPisadorRule(route, rule) {
    const key = normalizeRulePathKey(route);
    if (rule) automaticPisadorRulesByPath[key] = rule;
    else delete automaticPisadorRulesByPath[key];
    saveConfig(AUTOMATIC_PISADOR_RULES_PATH, automaticPisadorRulesByPath);
}

function applyDefaultAutomaticPisadorRule(row) {
    if (!row?.dataset?.ruta || row.dataset.automaticPisadorRule) return;
    const rule = getPersistentAutomaticPisadorRule(row.dataset.ruta);
    if (rule) row.dataset.automaticPisadorRule = serializeQuickRule(rule);
}
```

Call `applyDefaultAutomaticPisadorRule(tr)` inside `createPlaylistRow()` before returning.

- [ ] **Step 7: Wire modal behavior and menu availability**

Enable `#pm-auto-pisador` only for `normal` and `random` row types. On save:

```js
function syncAutomaticPisadorMenuAvailability() {
    const allowed = rightClickedRow && ['normal', 'random'].includes(rightClickedRow.dataset.type || 'normal');
    document.getElementById('pm-auto-pisador').classList.toggle('context-disabled', !allowed);
}

function automaticPisadorSourceFromModal() {
    const kind = document.getElementById('auto-pisador-source-kind').value;
    return ['time', 'temperature', 'humidity'].includes(kind)
        ? { v: 1, kind: 'builtin', name: kind }
        : { v: 1, kind, path: document.getElementById('auto-pisador-source-path').value };
}

function syncAutomaticPisadorModalSource() {
    const kind = document.getElementById('auto-pisador-source-kind').value;
    const needsPath = kind === 'file' || kind === 'folder';
    document.getElementById('auto-pisador-source-path').style.display = needsPath ? '' : 'none';
    document.getElementById('auto-pisador-browse').style.display = needsPath ? '' : 'none';
}

function openAutomaticPisadorModal(row) {
    if (!row || !['normal', 'random'].includes(row.dataset.type || 'normal')) return;
    const rule = parseQuickRule(row.dataset.automaticPisadorRule);
    const source = rule?.source || { kind: 'file', path: '' };
    document.getElementById('auto-pisador-source-kind').value = source.kind === 'builtin' ? source.name : source.kind;
    document.getElementById('auto-pisador-source-path').value = source.path || '';
    document.getElementById('auto-pisador-start').value = rule?.startSeconds ?? 0;
    document.getElementById('auto-pisador-advanced-policy').value = rule?.advancedPolicy || 'respect';
    document.getElementById('auto-pisador-scope').value = rule?.scope || 'row';
    syncAutomaticPisadorModalSource();
    document.getElementById('auto-pisador-modal').style.display = 'flex';
}

document.getElementById('auto-pisador-browse').addEventListener('click', async () => {
    const kind = document.getElementById('auto-pisador-source-kind').value;
    const channel = kind === 'folder' ? 'dialog:selectFolder' : 'dialog:openFile';
    const selectedPath = await ipcRenderer.invoke(channel);
    if (selectedPath) document.getElementById('auto-pisador-source-path').value = selectedPath;
});

document.getElementById('auto-pisador-save').addEventListener('click', () => {
    if (!rightClickedRow) return;
    const source = automaticPisadorSourceFromModal();
const rule = normalizeQuickRule({
    source,
    startSeconds: document.getElementById('auto-pisador-start').value,
    advancedPolicy: document.getElementById('auto-pisador-advanced-policy').value,
    scope: document.getElementById('auto-pisador-scope').value
});
if (!rule) return alert('Completa una fuente valida y el tiempo de inicio.');
rightClickedRow.dataset.automaticPisadorRule = serializeQuickRule(rule);
if (rule.scope === 'path') setPersistentAutomaticPisadorRule(rightClickedRow.dataset.ruta, rule);
saveSessionSnapshot();
hideAllMenus();
    document.getElementById('auto-pisador-modal').style.display = 'none';
});

document.getElementById('auto-pisador-clear').addEventListener('click', () => {
    if (!rightClickedRow) return;
    const previous = parseQuickRule(rightClickedRow.dataset.automaticPisadorRule);
    delete rightClickedRow.dataset.automaticPisadorRule;
    if (previous?.scope === 'path') setPersistentAutomaticPisadorRule(rightClickedRow.dataset.ruta, null);
    saveSessionSnapshot();
    document.getElementById('auto-pisador-modal').style.display = 'none';
});
```

Also wire Cancel, source `change`, and `#pm-auto-pisador` click:

```js
document.getElementById('auto-pisador-cancel').addEventListener('click', () => {
    document.getElementById('auto-pisador-modal').style.display = 'none';
});
document.getElementById('auto-pisador-source-kind').addEventListener('change', syncAutomaticPisadorModalSource);
document.getElementById('pm-auto-pisador').addEventListener('click', () => openAutomaticPisadorModal(rightClickedRow));
```

Call `syncAutomaticPisadorMenuAvailability()` immediately before showing the
playlist context menu.

- [ ] **Step 8: Run rule and UI tests**

Run:

```powershell
node --test tests/pisador_rules.test.js tests/pisador_ui_regressions.test.js
npm test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add frontend/pisador_rules.js frontend/index.html frontend/render.js tests/pisador_rules.test.js tests/pisador_ui_regressions.test.js
git commit -m "feat: persist quick automatic pisador rules"
```

## Task 5: Permitir precarga pausada de secuencias gapless en Rust

**Files:**
- Modify: `frontend/audio_engine_client.js:1-24`
- Modify: `frontend/audio_engine_client.js:330-352`
- Modify: `audio-engine-rust/src/main.rs:2906-2966`
- Modify: `audio-engine-rust/src/main.rs:4661-4677`
- Create: `tests/pisador_engine_contract.test.js`

- [ ] **Step 1: Write failing engine contract tests**

```js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { RustAudioEngineAdapter, AUDIO_ENGINE_COMMANDS } = require('../frontend/audio_engine_client');
const rustSource = fs.readFileSync(path.join(__dirname, '..', 'audio-engine-rust', 'src', 'main.rs'), 'utf8');

test('adapter exposes duration warmup and paused sequence preload', () => {
    assert.ok(AUDIO_ENGINE_COMMANDS.includes('cacheDuration'));
    assert.ok(AUDIO_ENGINE_COMMANDS.includes('cartwallSequence'));
    assert.ok(AUDIO_ENGINE_COMMANDS.includes('loadSequence'));
    const adapter = new RustAudioEngineAdapter();
    assert.deepStrictEqual(adapter.toRustCommand('loadSequence', {
        player: 'overlay-p1',
        paths: ['a.mp3', 'b.mp3'],
        autoplay: false,
        bus: 'jingle'
    }), {
        cmd: 'loadSequence',
        player: 'overlay-p1',
        bus: 'jingle',
        paths: ['a.mp3', 'b.mp3'],
        outputId: 'default',
        gain: 1,
        autoplay: false,
        cacheDir: ''
    });
});

test('Rust loadSequence passes autoplay into the sequence loader', () => {
    assert.match(rustSource, /"loadSequence"/);
    assert.match(rustSource, /load_audio_player_sequence[\s\S]*paused/);
});
```

- [ ] **Step 2: Run the engine contract test to verify it fails**

Run:

```powershell
node --test tests/pisador_engine_contract.test.js
```

Expected: FAIL because `loadSequence` is absent.

- [ ] **Step 3: Extend the Electron adapter**

Add `cacheDuration`, `cartwallSequence` and `loadSequence` to `AUDIO_ENGINE_COMMANDS`.

Add to `toRustCommand()`:

```js
case 'loadSequence':
    return {
        cmd: 'loadSequence',
        player,
        bus: payload.bus || 'jingle',
        paths: Array.isArray(payload.paths) ? payload.paths : [],
        outputId: payload.outputId || payload.deviceId || 'default',
        gain: payload.gain ?? 1,
        autoplay: payload.autoplay === true,
        cacheDir: payload.cacheDir || ''
    };
```

- [ ] **Step 4: Teach Rust to load a sequence paused**

Change `load_audio_player_sequence` signature:

```rust
fn load_audio_player_sequence(
    state: &mut EngineState,
    player_id: &str,
    file_paths: &[String],
    gain: f32,
    paused: bool,
    output_id: &str,
    bus_id: &str,
    cache_dir: &str
) -> Result<(), String>
```

Before appending segments:

```rust
if paused {
    player.pause();
}
```

Set:

```rust
runtime.state.status = if paused { "loaded".to_string() } else { "playing".to_string() };
```

Update existing `cartwallSequence` call with `paused = false`. Add:

```rust
"loadSequence" => {
    let paths = json_get_string_array(&line, "paths");
    let gain = json_get_f32(&line, "gain").unwrap_or(1.0);
    let bus_id = json_get_string(&line, "bus").unwrap_or_else(|| "jingle".to_string());
    let output_id = json_get_string(&line, "outputId").unwrap_or_else(|| "default".to_string());
    let cache_dir = json_get_string(&line, "cacheDir").unwrap_or_default();
    let autoplay = json_get_bool(&line, "autoplay").unwrap_or(false);
    if paths.is_empty() {
        emit_error("loadSequence: 'paths' vacio.", &request_id);
    } else if let Err(err) = load_audio_player_sequence(
        &mut state, &player_id, &paths, gain, !autoplay, &output_id, &bus_id, &cache_dir
    ) {
        emit_error(&format!("loadSequence '{}': {}", player_id, err), &request_id);
    }
}
```

- [ ] **Step 5: Run Node contract and Rust compile tests**

Run:

```powershell
node --test tests/pisador_engine_contract.test.js
cargo test --manifest-path audio-engine-rust/Cargo.toml
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add frontend/audio_engine_client.js audio-engine-rust/src/main.rs tests/pisador_engine_contract.test.js
git commit -m "feat: preload gapless overlay sequences in rust"
```

## Task 6: Crear el planner determinista de runtime

**Files:**
- Create: `frontend/pisador_runtime.js`
- Create: `tests/pisador_runtime.test.js`

- [ ] **Step 1: Write failing planner tests**

```js
'use strict';

const assert = require('assert');
const test = require('node:test');

const { prepareOverlaySession } = require('../frontend/pisador_runtime');

function deps(overrides = {}) {
    return {
        listFolderFiles: async () => ['short.mp3', 'long.mp3'],
        getDuration: async file => file.includes('short') ? 3 : 10,
        chooseRandom: values => values[0],
        resolveBuiltin: async source => source.name === 'time' ? ['hrs.mp3', 'min.mp3'] : ['weather.mp3'],
        preloadFile: async plan => ({ ok: true, playerId: plan.playerId }),
        preloadSequence: async plan => ({ ok: true, playerId: plan.playerId }),
        ...overrides
    };
}

test('folder end-at-intro chooses and measures the same fitting file', async () => {
    const session = await prepareOverlaySession({
        sessionId: 7,
        trackPath: '/music/song.mp3',
        startOffset: 0,
        markers: { intro: 5, outro: 30 },
        advanced: [{
            id: 'p1', active: true, mode: 'end', time: 'intro',
            source: { kind: 'folder', path: '/ids' },
            options: { overflowPolicy: 'skip' }
        }]
    }, deps());
    assert.strictEqual(session.plans[0].resolvedPaths[0], 'short.mp3');
    assert.strictEqual(session.plans[0].duration, 3);
    assert.strictEqual(session.plans[0].triggerTime, 2);
});

test('respect omits quick rule when an advanced pisador is active', async () => {
    const session = await prepareOverlaySession({
        sessionId: 8, startOffset: 0, markers: {},
        advanced: [{ id: 'p1', active: true, mode: 'start', time: '4', source: { kind: 'file', path: 'id.mp3' } }],
        quickRule: { source: { kind: 'file', path: 'quick.mp3' }, startSeconds: 2, advancedPolicy: 'respect' }
    }, deps({ getDuration: async () => 1 }));
    assert.deepStrictEqual(session.plans.map(plan => plan.id), ['p1']);
});

test('ignore uses quick rule instead of advanced pisadores', async () => {
    const session = await prepareOverlaySession({
        sessionId: 9, startOffset: 0, markers: {},
        advanced: [{ id: 'p1', active: true, mode: 'start', time: '4', source: { kind: 'file', path: 'id.mp3' } }],
        quickRule: { source: { kind: 'file', path: 'quick.mp3' }, startSeconds: 2, advancedPolicy: 'ignore' }
    }, deps({ getDuration: async () => 1 }));
    assert.deepStrictEqual(session.plans.map(plan => plan.id), ['quick']);
});

test('overflow skip cancels a folder when no file fits', async () => {
    const session = await prepareOverlaySession({
        sessionId: 10, startOffset: 0, markers: { intro: 2 },
        advanced: [{
            id: 'p1', active: true, mode: 'end', time: 'intro',
            source: { kind: 'folder', path: '/ids' },
            options: { overflowPolicy: 'skip' }
        }]
    }, deps());
    assert.strictEqual(session.plans.length, 0);
    assert.match(session.warnings[0], /no cabe/i);
});

test('overflow truncate starts at the effective beginning and stops at Intro', async () => {
    const session = await prepareOverlaySession({
        sessionId: 12, startOffset: 0, markers: { intro: 2 },
        advanced: [{
            id: 'p1', active: true, mode: 'end', time: 'intro',
            source: { kind: 'folder', path: '/ids' },
            options: { overflowPolicy: 'truncate-at-intro' }
        }]
    }, deps());
    assert.strictEqual(session.plans[0].triggerTime, 0);
    assert.strictEqual(session.plans[0].stopAt, 2);
});

test('overflow allow-overlap starts at the effective beginning without truncation', async () => {
    const session = await prepareOverlaySession({
        sessionId: 13, startOffset: 0, markers: { intro: 2 },
        advanced: [{
            id: 'p1', active: true, mode: 'end', time: 'intro',
            source: { kind: 'folder', path: '/ids' },
            options: { overflowPolicy: 'allow-overlap' }
        }]
    }, deps());
    assert.strictEqual(session.plans[0].triggerTime, 0);
    assert.strictEqual(session.plans[0].stopAt, null);
});

test('builtin time preloads its exact measured sequence', async () => {
    const session = await prepareOverlaySession({
        sessionId: 11, startOffset: 0, markers: {},
        advanced: [{ id: 'p4', active: true, mode: 'end', time: '10', source: { kind: 'builtin', name: 'time' } }]
    }, deps({ getDuration: async () => 2 }));
    assert.deepStrictEqual(session.plans[0].resolvedPaths, ['hrs.mp3', 'min.mp3']);
    assert.strictEqual(session.plans[0].duration, 4);
    assert.strictEqual(session.plans[0].triggerTime, 6);
});
```

- [ ] **Step 2: Run planner tests to verify they fail**

Run:

```powershell
node --test tests/pisador_runtime.test.js
```

Expected: FAIL because `frontend/pisador_runtime.js` does not exist.

- [ ] **Step 3: Implement deterministic session preparation**

Create `frontend/pisador_runtime.js` with:

```js
'use strict';

function sum(values) { return values.reduce((total, value) => total + value, 0); }

function applicablePisadores({ advanced = [], quickRule = null }) {
    const activeAdvanced = advanced.filter(item => item?.active);
    if (!quickRule) return activeAdvanced;
    if (quickRule.advancedPolicy === 'ignore') {
        return [{ id: 'quick', active: true, mode: 'start', time: String(quickRule.startSeconds), source: quickRule.source, options: { overflowPolicy: 'skip' } }];
    }
    return activeAdvanced.length ? activeAdvanced : [{
        id: 'quick', active: true, mode: 'start', time: String(quickRule.startSeconds), source: quickRule.source, options: { overflowPolicy: 'skip' }
    }];
}

async function measurePaths(paths, getDuration) {
    const measured = [];
    for (const filePath of paths) measured.push({ filePath, duration: Math.max(0, Number(await getDuration(filePath)) || 0) });
    return measured;
}

function markerFor(item, markers) {
    if (item.time === 'intro') return Number(markers.intro);
    if (item.time === 'outro') return Number(markers.outro);
    return Number(item.time);
}

async function resolvePaths(item, context, deps) {
    if (item.source.kind === 'file') return [item.source.path];
    if (item.source.kind === 'builtin') return deps.resolveBuiltin(item.source);
    const files = await deps.listFolderFiles(item.source.path);
    if (item.time !== 'intro') return files.length ? [deps.chooseRandom(files)] : [];
    const space = Math.max(0, Number(context.markers.intro) - Number(context.startOffset || 0));
    const measured = await measurePaths(files, deps.getDuration);
    const fitting = measured.filter(entry => entry.duration <= space).map(entry => entry.filePath);
    if (fitting.length) return [deps.chooseRandom(fitting)];
    return [];
}

async function prepareOne(item, context, deps, warnings) {
    const paths = await resolvePaths(item, context, deps);
    const overflowPolicy = item.options?.overflowPolicy || 'skip';
    const marker = markerFor(item, context.markers || {});
    if (!paths.length && item.time === 'intro') {
        warnings.push(`${item.id}: ningun audio cabe antes del Intro.`);
        if (overflowPolicy === 'skip') return null;
        const files = item.source.kind === 'folder' ? await deps.listFolderFiles(item.source.path) : [];
        if (!files.length) return null;
        paths.push(deps.chooseRandom(files));
    }
    if (!paths.length || !Number.isFinite(marker)) {
        warnings.push(`${item.id}: fuente o marcador no disponible.`);
        return null;
    }
    const duration = sum((await measurePaths(paths, deps.getDuration)).map(entry => entry.duration));
    let absoluteTrigger = item.mode === 'end' ? marker - duration : marker;
    let stopAt = null;
    if (absoluteTrigger < Number(context.startOffset || 0)) {
        if (overflowPolicy === 'skip') return null;
        absoluteTrigger = Number(context.startOffset || 0);
        if (overflowPolicy === 'truncate-at-intro') stopAt = Number(context.markers.intro);
    }
    const plan = {
        id: item.id,
        playerId: `overlay-${context.sessionId}-${item.id}`,
        resolvedPaths: paths,
        duration,
        triggerTime: Math.max(0, absoluteTrigger - Number(context.startOffset || 0)),
        stopAt,
        fired: false
    };
    const result = paths.length > 1 ? await deps.preloadSequence(plan) : await deps.preloadFile(plan);
    if (!result?.ok) {
        warnings.push(`${item.id}: fallo de precarga.`);
        return null;
    }
    return plan;
}

async function prepareOverlaySession(context, deps) {
    const warnings = [];
    const plans = [];
    for (const item of applicablePisadores(context)) {
        const plan = await prepareOne(item, context, deps, warnings);
        if (plan) plans.push(plan);
    }
    return { sessionId: context.sessionId, plans, warnings };
}

module.exports = { applicablePisadores, prepareOverlaySession };
```

- [ ] **Step 4: Run planner tests**

Run:

```powershell
node --test tests/pisador_runtime.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add frontend/pisador_runtime.js tests/pisador_runtime.test.js
git commit -m "feat: plan deterministic pisador overlay sessions"
```

## Task 7: Integrar sesiones precargadas al reloj de emision

**Files:**
- Modify: `frontend/render.js:8450-8695`
- Modify: `frontend/render.js:8967-9020`
- Modify: `frontend/render.js:9193-9426`
- Modify: `frontend/render.js:10220-10235`
- Modify: `tests/pisador_ui_regressions.test.js`

- [ ] **Step 1: Add failing runtime integration regressions**

Append:

```js
test('renderer prepares, plays and clears overlay sessions instead of rerolling folders at trigger time', () => {
    assert.match(renderJs, /prepareOverlaySession/);
    assert.match(renderJs, /clearPreparedOverlaySession/);
    assert.match(renderJs, /registerRustOverlayRuntime/);
    assert.match(renderJs, /finishRustOverlayRuntime/);
    assert.match(renderJs, /commandRustControlPlane\('play'/);
    assert.doesNotMatch(renderJs, /playOverlayDrop\(mc\[`p\$\{i\}_file`\]\)/);
});
```

- [ ] **Step 2: Run regression to verify it fails**

Run:

```powershell
node --test tests/pisador_ui_regressions.test.js
```

Expected: FAIL because renderer still resolves random folders inside `playOverlayDrop`.

- [ ] **Step 3: Import planner and add session lifecycle**

Extend the existing `require('./pisador_rules')` destructuring with
`parsePisadorSource` and `normalizePisadorOptions`. Then add:

```js
const { prepareOverlaySession } = require('./pisador_runtime');
let preparedOverlaySession = null;
let preparedOverlaySessionPromise = null;
let overlayPreparationGeneration = 0;

function clearPreparedOverlaySession() {
    overlayPreparationGeneration++;
    preparedOverlaySession?.plans.forEach(plan => {
        if (rustOverlayRuntimes.has(plan.playerId)) {
            finishRustOverlayRuntime(plan.playerId);
        } else {
            commandRustControlPlane('stop', { player: plan.playerId }).catch(() => {});
        }
    });
    preparedOverlaySession = null;
    preparedOverlaySessionPromise = null;
}
```

Call `clearPreparedOverlaySession()` before changing track context, on Stop, emergency Stop and manual restart.

- [ ] **Step 4: Build planner dependencies from existing helpers**

Add:

```js
function buildPisadorPlannerDeps() {
    return {
        listFolderFiles: async folder => getRandomFolderFilesFast(folder).map(name => path.join(folder, name)),
        getDuration: async filePath => {
            if (overlayDurationCache.has(filePath)) return overlayDurationCache.get(filePath);
            const duration = await getAudioDuration(filePath);
            if (duration > 0) overlayDurationCache.set(filePath, duration);
            return duration;
        },
        chooseRandom: files => files[Math.floor(Math.random() * files.length)],
        resolveBuiltin: async source => {
            if (source.name === 'time') return resolveTimeLocutionFiles(generalPrefs.timeFolder);
            const value = await ensureClimateWeatherValue(source.name);
            const filePath = Number.isFinite(value) ? resolveClimateLocutionFile(source.name, value) : '';
            return filePath ? [filePath] : [];
        },
        preloadFile: plan => commandRustControlPlane('load', {
            player: plan.playerId, bus: 'jingle', path: plan.resolvedPaths[0],
            gain: 1, autoplay: false, cacheDir: mainWaveformCacheDir
        }),
        preloadSequence: plan => commandRustControlPlane('loadSequence', {
            player: plan.playerId, bus: 'jingle', paths: plan.resolvedPaths,
            gain: 1, autoplay: false, cacheDir: mainWaveformCacheDir
        })
    };
}
```

- [ ] **Step 5: Normalize current physical track config and quick row rule**

Add:

```js
function buildAdvancedPisadores(mc = {}) {
    return PISADOR_IDS.map(id => ({
        id,
        active: mc[`${id}_active`] === true || mc[`${id}_active`] === 1,
        mode: mc[`${id}_mode`] || 'start',
        time: mc[`${id}_time`],
        source: parsePisadorSource(mc[`${id}_file`]),
        options: normalizePisadorOptions(mc[`${id}_options`])
    })).filter(item => item.source);
}

async function prepareCurrentOverlaySession(row, physicalTrackPath, startOffset) {
    clearPreparedOverlaySession();
    const mc = manualCuesDB[physicalTrackPath] || {};
    const targetSessionId = playRowSessionId;
    const targetGeneration = overlayPreparationGeneration;
    const preparation = prepareOverlaySession({
        sessionId: targetSessionId,
        trackPath: physicalTrackPath,
        startOffset,
        markers: { intro: Number(mc.intro) || 0, outro: Number(mc.outro) || 0 },
        advanced: buildAdvancedPisadores(mc),
        quickRule: parseQuickRule(row.dataset.automaticPisadorRule)
    }, buildPisadorPlannerDeps());
    preparedOverlaySessionPromise = preparation;
    const nextSession = await preparation;
    if (targetSessionId !== playRowSessionId || targetGeneration !== overlayPreparationGeneration) {
        nextSession.plans.forEach(plan => commandRustControlPlane('stop', { player: plan.playerId }).catch(() => {}));
        return null;
    }
    preparedOverlaySession = nextSession;
    nextSession.warnings.forEach(message => {
        logSystem(`[PISADOR] ${physicalTrackPath}: ${message}`);
        recordIncident(`[PISADOR] ${message}`, { category: 'air', level: 'warn' });
    });
    return nextSession;
}
```

For random playlist rows, invoke this after `resolvedRandomPath` is known. For
normal rows, use `tr.dataset.ruta`. Start the promise immediately after
`currentStartTimeOffset` has been resolved and before the Rust primary deck
load:

```js
prepareCurrentOverlaySession(tr, rutaFisica, currentStartTimeOffset).catch(err => {
    logSystem(`[PISADOR] No se pudo preparar la sesion: ${err.message || err}`);
});
```

Do not await this promise before playing the song. Overlay preparation runs in
parallel with the existing primary deck load. If a disk is too slow and the
plan misses its trigger window, omit that overlay and log a warning; never
delay the main song.

Add warmup for upcoming rows inside the existing `warmTrackFromLibraryAndFile`
lookahead:

```js
async function warmPisadorSourcesForTrack(filePath) {
    const mc = manualCuesDB[filePath] || {};
    for (const item of buildAdvancedPisadores(mc)) {
        if (item.source.kind !== 'folder') continue;
        const names = await warmRandomFolder(item.source.path);
        const paths = names.map(name => path.join(item.source.path, name));
        if (paths.length) commandRustControlPlane('cacheDuration', { paths, cacheDir: mainWaveformCacheDir }).catch(() => {});
    }
}
```

Call `warmPisadorSourcesForTrack(filePath).catch(() => {})` from
`warmTrackFromLibraryAndFile()`.

- [ ] **Step 6: Trigger preloaded players from the clock**

Replace the P1-P3 and `phora` branches in `handleTimeUpdate()`:

```js
if (preparedOverlaySession?.sessionId === playRowSessionId) {
    preparedOverlaySession.plans.forEach(plan => {
        if (!plan.fired && realElapsed > plan.triggerTime + 1.5) {
            plan.fired = true;
            logSystem(`[PISADOR] ${plan.id} omitido: la precarga no llego antes de su ventana.`);
            recordIncident(`[PISADOR] ${plan.id} omitido por precarga tardia.`, { category: 'air', level: 'warn' });
            return;
        }
        if (plan.fired || !didCrossOverlayTrigger(plan.triggerTime, realElapsed)) return;
        plan.fired = true;
        lastOverlayTriggerInfo = {
            type: plan.id, triggerTime: plan.triggerTime, realElapsed, at: Date.now()
        };
        registerRustOverlayRuntime({
            playerId: plan.playerId,
            path: plan.resolvedPaths.join(' | '),
            type: 'overlay',
            affectsProgram: true
        });
        commandRustControlPlane('play', { player: plan.playerId }).then(result => {
            if (!result?.ok) {
                finishRustOverlayRuntime(plan.playerId);
                logSystem(`[PISADOR] No se pudo disparar ${plan.id}: ${result?.error || 'sin detalle'}`);
            }
        }).catch(err => {
            finishRustOverlayRuntime(plan.playerId);
            logSystem(`[PISADOR] No se pudo disparar ${plan.id}: ${err.message || err}`);
        });
    });
}
```

After remembering the overlay evaluation, stop truncated plans:

```js
preparedOverlaySession?.plans.forEach(plan => {
    if (plan.fired && plan.stopAt && absTime >= plan.stopAt) {
        finishRustOverlayRuntime(plan.playerId);
        plan.stopAt = null;
    }
});
```

Remove the legacy `realElapsed >= 0.5` guard and update crossing logic so a
valid plan scheduled at second zero can fire once:

```js
return previousElapsed <= triggerTime
    && realElapsed >= triggerTime
    && realElapsed <= triggerTime + 1.5;
```

- [ ] **Step 7: Keep legacy WebAudio fallback deterministic**

Change `playOverlayDrop()` to accept only an already-resolved file path. Remove its directory reroll branch. If WebAudio fallback is active, the trigger path uses `plan.resolvedPaths` and sequences play in order. Production Rust remains preload-first.

- [ ] **Step 8: Run focused and full tests**

Run:

```powershell
node --test tests/pisador_runtime.test.js tests/pisador_ui_regressions.test.js tests/pisador_engine_contract.test.js
npm test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add frontend/render.js tests/pisador_ui_regressions.test.js
git commit -m "feat: preload and trigger deterministic pisador sessions"
```

## Task 8: Actualizar documentacion y verificar de extremo a extremo

**Files:**
- Modify: `Documentación/05_editor_audio.md`
- Modify: `Documentación/01_consola_principal.md`

- [ ] **Step 1: Update user-facing documentation**

In `Documentación/05_editor_audio.md`, replace the `P1, P2, P3 + hora` description with:

```md
Hay cuatro pisadores uniformes (`P1` a `P4`). Cada uno puede usar archivo,
carpeta aleatoria, locucion de hora, temperatura o humedad. Las condiciones
disponibles son `Inicia en`, `Termina en`, `Termina en Intro` e
`Inicia en Outro`. Los anclajes dinamicos requieren que el marcador
correspondiente exista antes de guardar.
```

In `Documentación/01_consola_principal.md`, document:

```md
| `Pisadores automaticos...` | Configura un pisador sencillo que inicia a los segundos indicados. Puede conservar prioridad del Editor Avanzado y aplicarse solo a la fila o cada vez que se agregue la misma ruta. |
```

- [ ] **Step 2: Run formatting and automated verification**

Run:

```powershell
git diff --check
npm test
cargo test --manifest-path audio-engine-rust/Cargo.toml
```

Expected: no whitespace errors; Node and Rust tests PASS.

- [ ] **Step 3: Launch the app for a visual smoke test**

Run:

```powershell
npm start
```

Verify manually:

1. Open a normal song in Editor de Pistas Avanzado.
2. Confirm `P1-P4`, approved condition order and five sources.
3. Select `Termina en Intro` with Intro at `0.00`; confirm warning and blocked save.
4. Fix Intro; confirm save becomes valid.
5. Open the gear modal and save each overflow policy.
6. Right-click a normal playlist row and a random folder row; confirm `Herramientas > Pisadores automaticos`.
7. Confirm the contextual item is unavailable for streams and special rows.
8. Save and reopen `.lfplay`; confirm local rule remains.
9. Add the same route again after choosing persistent scope; confirm rule reapplies.

- [ ] **Step 4: Perform an on-air behavior smoke test with short fixture audio**

Prepare one song with a five-second Intro marker and a pisador folder containing a three-second and a ten-second file. Verify:

1. `Termina en Intro` chooses only the three-second file.
2. The player is visible as `loaded` before its trigger.
3. It changes to `playing` at Intro minus three seconds.
4. A folder containing only the ten-second file follows each configured overflow policy.
5. Restarting the song creates a new session and may choose a different eligible file.
6. Skipping the song before the trigger removes the loaded overlay player.

- [ ] **Step 5: Commit documentation**

```powershell
git add Documentación/05_editor_audio.md Documentación/01_consola_principal.md
git commit -m "docs: explain dynamic and automatic pisadores"
```

- [ ] **Step 6: Final repository check**

Run:

```powershell
git status --short
git log --oneline -n 10
```

Expected: only pre-existing unrelated working tree changes remain. The pisador implementation is represented by focused commits.
