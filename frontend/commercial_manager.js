const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const i18n = require('./i18n');

let categories = [];
let assets = [];
let blocks = [];
let selectedAsset = null;
let selectedAssetPaths = new Set();
let currentBlockId = null;
let currentSlot = { day: 1, time: '08:00' };
let currentView = 'library';

const $ = (id) => document.getElementById(id);
const statusText = $('cm-status');
const countText = $('cm-count');

const typeMap = [
    ['commercial', 'COMERCIAL', 'pag'],
    ['promo', 'PROMO', 'pro'],
    ['courtesy', 'CORTESIA', 'pag'],
    ['public_service', 'SERV. PUBLICO', 'gob'],
    ['government', 'GOBIERNO', 'gob'],
    ['social', 'SOCIAL', 'gob'],
    ['station_id', 'ID EMISORA', 'id'],
    ['jingle', 'JINGLE', 'id'],
    ['sweeper', 'PISADOR', 'id'],
    ['temporary', 'TEMPORAL', 'pro'],
    ['other', 'OTRO', '']
];

const trafficHierarchy = {
    commercial: {
        categoryLabel: 'Categoria competencia',
        categoryOptions: [
            ['beverages', 'Bebidas Gaseosas'],
            ['automotive', 'Automotriz'],
            ['finance', 'Finanzas'],
            ['retail', 'Retail'],
            ['education', 'Educacion'],
            ['health', 'Salud'],
            ['concerts', 'Conciertos'],
            ['food', 'Comida / Restaurantes'],
            ['real_estate', 'Inmobiliaria'],
            ['other_commercial', 'Otra categoria comercial']
        ],
        conditionOptions: [
            ['paid_contract', 'Pagado (Contrato)'],
            ['exchange', 'Canje (Intercambio)'],
            ['client_courtesy', 'Cortesia a Cliente'],
            ['one_time_temp', 'Temporal Unico']
        ],
        defaultCategory: 'beverages',
        defaultCondition: 'paid_contract'
    },
    internal: {
        categoryLabel: 'Categoria / motivo',
        categoryOptions: [
            ['program_promo', 'Promocion Programa'],
            ['station_event', 'Evento Emisora'],
            ['general_branding', 'Branding General'],
            ['legal_identification', 'Identificacion Legal']
        ],
        conditionOptions: [
            ['station_internal', 'Interno Emisora'],
            ['internal_exchange', 'Canje Interno'],
            ['seasonal_promo', 'Promocion Temporal']
        ],
        defaultCategory: 'program_promo',
        defaultCondition: 'station_internal'
    },
    courtesy: {
        categoryLabel: 'Categoria / motivo',
        categoryOptions: [
            ['social_request', 'Pedido Social'],
            ['friend_courtesy', 'Cortesia Amigo'],
            ['special_mention', 'Mencion Especial']
        ],
        conditionOptions: [
            ['social_exchange', 'Canje Social'],
            ['public_service_note', 'Nota Servicio Publico'],
            ['event_courtesy', 'Cortesia Evento']
        ],
        defaultCategory: 'social_request',
        defaultCondition: 'social_exchange'
    },
    public: {
        categoryLabel: 'Categoria / motivo',
        categoryOptions: [
            ['government_legal', 'Gubernamental Legal'],
            ['civic_campaign', 'Campana Civica'],
            ['public_health', 'Salud Publica'],
            ['bereavement_notice', 'Nota Luctuosa']
        ],
        conditionOptions: [
            ['legal_required', 'Legal (Obligatorio)'],
            ['public_service', 'Servicio Publico'],
            ['community_service', 'Servicio Comunitario']
        ],
        defaultCategory: 'government_legal',
        defaultCondition: 'public_service'
    },
    temporary: {
        categoryLabel: 'Categoria / motivo',
        categoryOptions: [
            ['temporary_campaign', 'Campana Temporal'],
            ['technical_test', 'Prueba Tecnica'],
            ['one_time_piece', 'Pieza Unica'],
            ['other_reason', 'Otro Motivo']
        ],
        conditionOptions: [
            ['temporary_rotation', 'Rotacion Temporal'],
            ['manual_review', 'Revision Manual'],
            ['other_condition', 'Otra Condicion']
        ],
        defaultCategory: 'temporary_campaign',
        defaultCondition: 'temporary_rotation'
    }
};

const legacyTypeMap = {
    paid: 'commercial',
    station_promo: 'promo',
    unpaid: 'courtesy',
    psa: 'public_service',
    legal_id: 'station_id',
    sweep: 'sweeper'
};

function normalizeCommercialType(type) {
    const raw = type || 'commercial';
    if (legacyTypeMap[raw]) return legacyTypeMap[raw];
    if (typeMap.some(item => item[0] === raw)) return raw;
    return 'other';
}

function hierarchyKeyForType(type) {
    const normalized = normalizeCommercialType(type);
    if (normalized === 'commercial') return 'commercial';
    if (['promo', 'station_id', 'jingle', 'sweeper'].includes(normalized)) return 'internal';
    if (normalized === 'courtesy') return 'courtesy';
    if (['public_service', 'government', 'social'].includes(normalized)) return 'public';
    return 'temporary';
}

function setStatus(text) { statusText.textContent = text || i18n.t('commercial_manager.lbl_ready') || 'Listo'; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function basename(filePath) { return path.basename(filePath || ''); }
function categoryName(id) { return categories.find(c => c.id === id)?.name || id || i18n.t('commercial_manager.js_other') || 'Otro'; }
function typeClass(asset) {
    const type = normalizeCommercialType(asset?.commercialType);
    return typeMap.find(item => item[0] === type)?.[2] || '';
}
function typeShort(asset) {
    const type = normalizeCommercialType(asset?.commercialType);
    return typeMap.find(item => item[0] === type)?.[1] || String(type).toUpperCase();
}
function secondsToClock(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const min = Math.floor(total / 60);
    const sec = total % 60;
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
function dateOnly(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso).slice(0, 10);
    return date.toISOString().slice(0, 10);
}
function isoFromDate(value) {
    if (!value) return '';
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}
function assetReady(asset) {
    return !!(asset?.clientName || asset?.campaignName) && asset.status !== 'draft' && asset.enabled !== false;
}
function assetValidityLabel(asset) {
    if (!asset?.validityStart && !asset?.validityEnd) return '--';
    return `${dateOnly(asset.validityStart) || '...'} - ${dateOnly(asset.validityEnd) || '...'}`;
}

function optionLabel(options, value) {
    return options.find(option => option[0] === value)?.[1] || value || i18n.t('commercial_manager.js_other') || 'Otro';
}

function metadataCategoryName(asset) {
    const config = trafficHierarchy[hierarchyKeyForType(asset?.commercialType)];
    return optionLabel(config.categoryOptions, asset?.category) || categoryName(asset?.category);
}

function conditionName(asset) {
    const config = trafficHierarchy[hierarchyKeyForType(asset?.commercialType)];
    return optionLabel(config.conditionOptions, asset?.billingMode);
}

function populateSelect(select, includeAll = false) {
    const old = select.value;
    select.replaceChildren();
    if (includeAll) {
        const option = document.createElement('option');
        option.value = 'all';
        option.textContent = 'Todas';
        select.appendChild(option);
    }
    categories.forEach(category => {
        const option = document.createElement('option');
        option.value = category.id;
        option.textContent = category.name;
        select.appendChild(option);
    });
    if ([...select.options].some(option => option.value === old)) select.value = old;
}

async function loadCategories() {
    categories = await ipcRenderer.invoke('commercial-get-categories');
    if (!Array.isArray(categories)) categories = [];
    populateSelect($('filter-category'), true);
    populateSelect($('import-category'));
    renderTypeButtons();
}

async function loadSettings() {
    const settings = await ipcRenderer.invoke('commercial-get-settings');
    $('commercials-root-path').textContent = settings.commercialsRoot || 'Sin carpeta configurada';
    $('jingles-root-path').textContent = settings.jinglesRoot || 'Sin carpeta configurada';
}

async function loadAssets(keepSelection = true) {
    const filters = {
        rootType: $('filter-root').value,
        category: $('filter-category').value,
        status: $('filter-status').value,
        search: $('global-search').value.trim()
    };
    assets = await ipcRenderer.invoke('commercial-get-assets', filters);
    if (!keepSelection || !assets.some(asset => asset.filePath === selectedAsset?.filePath)) {
        selectedAsset = null;
        selectedAssetPaths.clear();
    }
    renderAssetsTable();
    renderInventory();
    renderContinuityInventory();
    renderSmartCards();
}

async function loadBlocks() {
    blocks = await ipcRenderer.invoke('commercial-get-blocks');
    if (!Array.isArray(blocks)) blocks = [];
    if (blocks.length && !currentBlockId) currentBlockId = blocks[0].id;
    renderBasicRows();
    renderAdvancedGrid();
    renderContinuityGrid();
    renderTanda();
}

function renderTypeButtons() {
    const host = $('type-buttons');
    host.replaceChildren();
    typeMap.forEach(([id, label]) => {
        const button = document.createElement('div');
        button.className = 'type-btn';
        button.dataset.type = id;
        button.textContent = label;
        button.addEventListener('click', () => {
            if (!selectedAsset) return;
            selectedAsset.commercialType = id;
            const config = trafficHierarchy[hierarchyKeyForType(id)];
            if (!config.categoryOptions.some(option => option[0] === selectedAsset.category)) selectedAsset.category = config.defaultCategory;
            if (!config.conditionOptions.some(option => option[0] === selectedAsset.billingMode)) selectedAsset.billingMode = config.defaultCondition;
            loadAssetIntoInspector(selectedAsset);
        });
        host.appendChild(button);
    });
}

function renderAssetsTable() {
    const body = $('asset-body');
    body.replaceChildren();
    $('empty-assets').style.display = assets.length ? 'none' : 'block';
    countText.textContent = `${assets.length} ${i18n.t('commercial_manager.js_items') || 'elemento(s)'}`;
    assets.forEach(asset => {
        const tr = document.createElement('tr');
        tr.draggable = true;
        tr.className = selectedAssetPaths.has(asset.filePath) ? 'selected' : '';
        const dotClass = assetReady(asset) ? 'ok' : (asset.computedStatus === 'expired' ? 'bad' : 'warn');
        const cueLabel = asset.duration ? `${secondsToClock(asset.duration)} / ${i18n.t('commercial_manager.js_ready') || 'listo'}` : (i18n.t('commercial_manager.js_pending') || 'Pendiente');
        tr.innerHTML = `
            <td><span class="status-dot ${dotClass}"></span></td>
            <td title="${esc(asset.filePath)}">${esc(asset.title || basename(asset.filePath))}</td>
            <td>${esc(asset.clientName || asset.campaignName || i18n.t('commercial_manager.js_unassigned') || '(Sin asignar)')}</td>
            <td><span class="badge ${typeClass(asset)}">${esc(typeShort(asset))}</span></td>
            <td>${esc(assetValidityLabel(asset))}</td>
            <td>${esc(cueLabel)}</td>`;
        tr.addEventListener('click', (event) => {
            if (!event.ctrlKey) selectedAssetPaths.clear();
            if (selectedAssetPaths.has(asset.filePath)) selectedAssetPaths.delete(asset.filePath);
            else selectedAssetPaths.add(asset.filePath);
            selectedAsset = asset;
            renderAssetsTable();
            loadAssetIntoInspector(asset);
        });
        tr.addEventListener('dragstart', (event) => {
            const selected = assets.filter(item => selectedAssetPaths.has(item.filePath));
            event.dataTransfer.setData('application/json', JSON.stringify(selected.length ? selected : [asset]));
            event.dataTransfer.effectAllowed = 'copy';
        });
        body.appendChild(tr);
    });
}

function renderInventory() {
    const host = $('inventory-list');
    host.replaceChildren();
    assets.filter(assetReady).slice(0, 120).forEach(asset => host.appendChild(createSpotCard(asset)));
}

function renderContinuityInventory() {
    const host = $('continuity-inventory');
    host.replaceChildren();
    assets.filter(assetReady).slice(0, 80).forEach(asset => host.appendChild(createSpotCard(asset)));
}

function createSpotCard(asset) {
    const card = document.createElement('div');
    card.className = `spot-card ${typeClass(asset)}`;
    card.draggable = true;
    card.innerHTML = `<div class="spot-head"><span>${esc(asset.clientName || asset.campaignName || asset.title || basename(asset.filePath))}</span><span class="badge ${typeClass(asset)}">${esc(typeShort(asset))}</span></div><div class="spot-meta"><span>${esc(metadataCategoryName(asset))}</span><span>${secondsToClock(asset.duration)}</span></div>`;
    card.addEventListener('click', () => { selectedAsset = asset; loadAssetIntoInspector(asset); showView('library'); });
    card.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('application/json', JSON.stringify([asset]));
        event.dataTransfer.effectAllowed = 'copy';
    });
    return card;
}

function renderSmartCards() {
    const now = Date.now();
    const soon = now + (7 * 24 * 60 * 60 * 1000);
    const expiring = assets.filter(asset => {
        const end = asset.validityEnd ? new Date(asset.validityEnd).getTime() : 0;
        return end && end >= now && end <= soon;
    }).length;
    const orphans = assets.filter(asset => !assetReady(asset)).length;
    $('expiring-card').textContent = `${expiring} ${i18n.t('commercial_manager.js_expiring') || 'spots por expirar pronto'}`;
    $('orphans-card').textContent = `${orphans} ${i18n.t('commercial_manager.js_orphans') || 'spots sin metadata'}`;
}

function loadAssetIntoInspector(asset) {
    if (!asset) return;
    asset.commercialType = normalizeCommercialType(asset.commercialType || asset.category);
    syncDynamicDropdowns(asset.commercialType, asset.category, asset.billingMode);
    $('asset-state-label').textContent = assetReady(asset) ? (i18n.t('commercial_manager.lbl_ready') || 'Listo') : (i18n.t('commercial_manager.js_missing_info') || 'Falta info');
    $('asset-file-label').textContent = asset.filePath || 'Selecciona un archivo';
    $('asset-audio-info').textContent = `${i18n.t('commercial_manager.js_dur') || 'Dur:'} ${secondsToClock(asset.duration)} | dB: --`;
    $('asset-client').value = asset.clientName || '';
    $('asset-campaign').value = asset.campaignName || asset.title || basename(asset.filePath);
    $('asset-validity-start').value = dateOnly(asset.validityStart);
    $('asset-validity-end').value = dateOnly(asset.validityEnd);
    $('asset-priority').value = asset.commercialPriority || 'normal';
    $('asset-daily-limit').value = asset.dailyLimit || 0;
    $('asset-traffic-notes').value = asset.trafficNotes || '';
    $('asset-notes').value = asset.notes || '';
    $('asset-frequency').value = asset.frequencyRule || 'manual';
    $('asset-separation').value = asset.separationRule || 'category';
    document.querySelectorAll('#type-buttons .type-btn').forEach(button => button.classList.toggle('active', button.dataset.type === asset.commercialType));
}

function fillOptions(select, options, selectedValue) {
    select.replaceChildren();
    options.forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
    });
    if (options.some(option => option[0] === selectedValue)) select.value = selectedValue;
    else if (options[0]) select.value = options[0][0];
}

function syncDynamicDropdowns(type, categoryValue, conditionValue) {
    const normalizedType = normalizeCommercialType(type);
    const config = trafficHierarchy[hierarchyKeyForType(normalizedType)];
    $('asset-category-label').textContent = config.categoryLabel;
    $('asset-billing-label').textContent = 'Condicion de emision';
    fillOptions($('asset-category'), config.categoryOptions, categoryValue);
    fillOptions($('asset-billing'), config.conditionOptions, conditionValue);
    if (selectedAsset) {
        selectedAsset.commercialType = normalizedType;
        selectedAsset.category = $('asset-category').value || config.defaultCategory;
        selectedAsset.billingMode = $('asset-billing').value || config.defaultCondition;
    }
}

function readAssetFromInspector() {
    if (!selectedAsset) return null;
    return {
        ...selectedAsset,
        title: $('asset-campaign').value.trim() || selectedAsset.title || basename(selectedAsset.filePath),
        clientName: $('asset-client').value.trim(),
        campaignName: $('asset-campaign').value.trim(),
        category: $('asset-category').value || trafficHierarchy[hierarchyKeyForType(selectedAsset.commercialType)].defaultCategory,
        commercialType: normalizeCommercialType(selectedAsset.commercialType),
        billingMode: $('asset-billing').value,
        validityStart: isoFromDate($('asset-validity-start').value),
        validityEnd: isoFromDate($('asset-validity-end').value),
        commercialPriority: $('asset-priority').value,
        dailyLimit: parseInt($('asset-daily-limit').value, 10) || 0,
        trafficNotes: $('asset-traffic-notes').value.trim(),
        notes: $('asset-notes').value.trim(),
        frequencyRule: $('asset-frequency').value,
        separationRule: $('asset-separation').value,
        enabled: true,
        status: 'active'
    };
}

function getCurrentBlock() {
    return blocks.find(block => block.id === currentBlockId) || null;
}

function createBlock(overrides = {}) {
    return {
        id: `com_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        name: i18n.t('commercial_manager.js_new_block') || 'Nueva pauta',
        mode: $('mode-toggle')?.checked ? 'advanced' : 'basic',
        enabled: true,
        priority: 'normal',
        action: 'temp',
        execution: 'wait',
        primaryTime: '10:00',
        repeatActive: false,
        repeatInterval: 0,
        repeatUnit: 'minutes',
        notes: '',
        items: [],
        ...overrides
    };
}

function loadBlockEditor(block) {
    if (!block) return;
    currentBlockId = block.id;
    $('block-name').value = block.name || '';
    $('block-time').value = block.primaryTime || '';
    $('block-priority').value = block.priority || 'normal';
    $('block-execution').value = block.execution || 'wait';
    $('repeat-active').value = block.repeatActive ? '1' : '0';
    $('repeat-interval').value = block.repeatInterval || 0;
    $('block-notes').value = block.notes || '';
    renderBasicRows();
    renderTanda();
}

function readBlockEditor() {
    const block = getCurrentBlock();
    if (!block) return null;
    block.name = $('block-name').value.trim() || i18n.t('commercial_manager.js_pauta') || 'Pauta comercial';
    block.primaryTime = $('block-time').value || block.primaryTime || '10:00';
    block.priority = $('block-priority').value || 'normal';
    block.execution = $('block-execution').value || 'wait';
    block.repeatActive = $('repeat-active').value === '1';
    block.repeatInterval = parseInt($('repeat-interval').value, 10) || 0;
    block.repeatUnit = 'minutes';
    block.notes = $('block-notes').value.trim();
    block.mode = $('mode-toggle').checked ? 'advanced' : 'basic';
    return block;
}

function assetToBlockItem(asset) {
    return {
        id: `${currentBlockId || 'new'}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        sourceType: 'file',
        filePath: asset.filePath,
        title: asset.clientName || asset.campaignName || asset.title || basename(asset.filePath),
        duration: asset.duration || 0,
        temp: true
    };
}

function ensureEditableBlock() {
    let block = getCurrentBlock();
    if (!block) {
        block = createBlock();
        blocks.push(block);
        currentBlockId = block.id;
    }
    return block;
}

function addAssetsToBlock(assetItems, block = ensureEditableBlock()) {
    if (!Array.isArray(assetItems) || !assetItems.length) return;
    assetItems.forEach(asset => block.items.push(assetToBlockItem(asset)));
    currentBlockId = block.id;
    loadBlockEditor(block);
    renderContinuityGrid();
}

function renderBasicRows() {
    const body = $('basic-body');
    body.replaceChildren();
    blocks.filter(block => block.mode !== 'advanced').forEach((block, index) => {
        const tr = document.createElement('tr');
        tr.className = block.id === currentBlockId ? 'selected' : '';
        const names = (block.items || []).map(item => item.title || basename(item.filePath)).join(', ') || i18n.t('commercial_manager.js_no_spots') || '(Sin spots)';
        tr.innerHTML = `<td>${index + 1}</td><td>${esc(block.primaryTime || '--')}</td><td><strong>${esc(names)}</strong></td><td>${block.repeatActive ? `${i18n.t('commercial_manager.js_every') || 'Cada'} ${block.repeatInterval || 0} ${i18n.t('commercial_manager.js_min') || 'min'}` : (i18n.t('commercial_manager.js_exact_time') || 'Hora exacta')}</td><td><button class="danger" data-delete="${esc(block.id)}">X</button></td>`;
        tr.addEventListener('click', (event) => {
            if (event.target.dataset.delete) return;
            loadBlockEditor(block);
        });
        tr.querySelector('button').addEventListener('click', async () => {
            await ipcRenderer.invoke('commercial-delete-block', block.id);
            blocks = blocks.filter(item => item.id !== block.id);
            currentBlockId = blocks[0]?.id || null;
            renderBasicRows();
            renderContinuityGrid();
        });
        body.appendChild(tr);
    });
}

function renderAdvancedGrid() {
    renderGrid($('advanced-grid'), true);
}

function renderContinuityGrid() {
    renderDayTabs();
    renderGrid($('continuity-grid'), false);
}

function renderGrid(host, editable) {
    host.replaceChildren();
    const minutes = ['00', '15', '30', '45'];
    for (let hour = 0; hour < 24; hour++) {
        const hourText = `${String(hour).padStart(2, '0')}:00`;
        const time = document.createElement('div');
        time.className = 'time-cell';
        time.textContent = hourText;
        host.appendChild(time);
        minutes.forEach(minute => {
            const slotTime = `${String(hour).padStart(2, '0')}:${minute}`;
            const cell = document.createElement('div');
            cell.className = `slot-cell ${currentSlot.time === slotTime ? 'selected' : ''}`;
            cell.dataset.time = slotTime;
            const slotBlocks = blocks.filter(block => (block.primaryTime || '').slice(0, 5) === slotTime);
            if (!slotBlocks.length) {
                cell.innerHTML = `<span style="font-size:10px;color:#555;text-align:center;margin-top:8px;">${i18n.t('commercial_manager.js_unprogrammed') || '(Sin programar)'}</span>`;
            } else {
                slotBlocks.forEach(block => {
                    const count = (block.items || []).length;
                    const total = (block.items || []).reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
                    const micro = document.createElement('div');
                    micro.className = 'micro';
                    micro.innerHTML = `<span>${esc(block.name || i18n.t('commercial_manager.js_pauta') || 'Pauta')}</span><span>${count} / ${secondsToClock(total)}</span>`;
                    cell.appendChild(micro);
                });
            }
            cell.addEventListener('click', () => {
                currentSlot = { day: Number($('advanced-day').value || 1), time: slotTime };
                const block = slotBlocks[0] || createBlock({ name: `${i18n.t('commercial_manager.js_pauta') || 'Pauta'} ${slotTime}`, primaryTime: slotTime, mode: editable ? 'advanced' : 'basic' });
                if (!slotBlocks[0]) blocks.push(block);
                currentBlockId = block.id;
                loadBlockEditor(block);
                $('selected-slot-label').textContent = `${i18n.t('commercial_manager.js_sel_block') || 'Bloque seleccionado:'} ${slotTime}`;
                renderAdvancedGrid();
                renderContinuityGrid();
            });
            cell.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
            cell.addEventListener('drop', event => {
                event.preventDefault();
                const payload = JSON.parse(event.dataTransfer.getData('application/json') || '[]');
                let block = slotBlocks[0];
                if (!block) {
                    block = createBlock({ name: `${i18n.t('commercial_manager.js_pauta') || 'Pauta'} ${slotTime}`, primaryTime: slotTime, mode: editable ? 'advanced' : 'basic' });
                    blocks.push(block);
                }
                addAssetsToBlock(payload, block);
            });
            host.appendChild(cell);
        });
    }
}

function renderDayTabs() {
    const host = $('continuity-day-tabs');
    if (host.children.length) return;
    [
        i18n.t('commercial_manager.day_sun_short') || 'Dom',
        i18n.t('commercial_manager.day_mon_short') || 'Lun',
        i18n.t('commercial_manager.day_tue_short') || 'Mar',
        i18n.t('commercial_manager.day_wed_short') || 'Mie',
        i18n.t('commercial_manager.day_thu_short') || 'Jue',
        i18n.t('commercial_manager.day_fri_short') || 'Vie',
        i18n.t('commercial_manager.day_sat_short') || 'Sab'
    ].forEach((label, index) => {
        const button = document.createElement('button');
        button.textContent = label;
        button.className = index === 1 ? 'active' : '';
        button.addEventListener('click', () => {
            host.querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button));
            currentSlot.day = index;
            renderContinuityGrid();
        });
        host.appendChild(button);
    });
}

function renderTanda() {
    const block = getCurrentBlock();
    const host = $('tanda-items');
    host.replaceChildren();
    if (!block) {
        $('tanda-title').textContent = i18n.t('commercial_manager.lbl_no_block') || 'Sin bloque seleccionado';
        return;
    }
    $('tanda-title').textContent = `${block.name || i18n.t('commercial_manager.js_pauta') || 'Pauta'} - ${block.primaryTime || '--'}`;
    const items = block.items || [];
    const total = items.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
    const limit = 180;
    $('tanda-progress').style.width = `${Math.min(100, (total / limit) * 100)}%`;
    $('tanda-progress').style.background = total > limit ? 'var(--bad)' : (total > limit * .85 ? 'var(--warn)' : 'var(--ok)');
    $('tanda-progress-text').innerHTML = `<span>${i18n.t('commercial_manager.js_occupied') || 'Ocupado:'} ${secondsToClock(total)}</span><span>${i18n.t('commercial_manager.js_limit') || 'Limite:'} ${secondsToClock(limit)}</span>`;
    const opening = document.createElement('div');
    opening.className = 'tanda-item fixed';
    opening.innerHTML = `<div class="tanda-title">${i18n.t('commercial_manager.js_open_tanda') || 'Apertura de tanda / ID'}</div><div>00:05</div><div class="tanda-meta">${i18n.t('commercial_manager.js_global_rule') || 'Regla global del sistema'}</div>`;
    host.appendChild(opening);
    items.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'tanda-item';
        row.innerHTML = `<div class="tanda-title">${esc(item.title || basename(item.filePath))}</div><div>${secondsToClock(item.duration)}</div><div class="tanda-meta">${i18n.t('commercial_manager.js_order') || 'Orden'} ${index + 1} | ${i18n.t('commercial_manager.js_temp') || 'Temporal'}</div>`;
        host.appendChild(row);
    });
    const drop = document.createElement('div');
    drop.className = 'drop-hint';
    drop.style.margin = '4px 0';
    drop.textContent = i18n.t('commercial_manager.js_drag_spot') || '+ Arrastra un spot aqui';
    drop.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
    drop.addEventListener('drop', event => {
        event.preventDefault();
        const payload = JSON.parse(event.dataTransfer.getData('application/json') || '[]');
        addAssetsToBlock(payload, block);
    });
    host.appendChild(drop);
}

function showView(view) {
    currentView = view;
    document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
    document.querySelectorAll('.view').forEach(section => section.classList.toggle('active', section.id === `view-${view}`));
}

async function saveAsset() {
    const payload = readAssetFromInspector();
    if (!payload) return;
    const result = await ipcRenderer.invoke('commercial-save-asset-metadata', payload);
    if (!result?.success) {
        alert(result?.error || i18n.t('commercial_manager.js_save_err') || 'No se pudo guardar');
        return;
    }
    setStatus(i18n.t('commercial_manager.js_spot_saved') || 'Spot guardado en SQLite');
    selectedAsset = payload;
    await loadAssets(true);
}

async function saveBlock() {
    const block = readBlockEditor();
    if (!block) return;
    const result = await ipcRenderer.invoke('commercial-save-block', block);
    if (!result?.success) {
        alert(result?.error || i18n.t('commercial_manager.js_save_err') || 'No se pudo guardar');
        return;
    }
    setStatus(i18n.t('commercial_manager.js_pauta_saved') || 'Pauta guardada');
    currentBlockId = result.id;
    await loadBlocks();
}

async function setRoot(rootType) {
    const result = await ipcRenderer.invoke('commercial-set-root', rootType);
    if (result?.success) {
        await loadSettings();
        setStatus(i18n.t('commercial_manager.js_root_set') || 'Raiz configurada');
    }
}

async function scanRoot(rootType) {
    setStatus(i18n.t('commercial_manager.js_scan_worker') || 'Escaneando en worker...');
    const category = rootType === 'jingles' ? 'jingle' : $('import-category').value;
    const result = await ipcRenderer.invoke('commercial-scan-root', { rootType, category });
    setStatus(result?.success ? `${i18n.t('commercial_manager.js_scan_ready') || 'Escaneo listo:'} ${result.count} ${i18n.t('commercial_manager.js_audio') || 'audio(s)'}` : (result?.error || 'No se pudo escanear'));
    await loadAssets(false);
}

async function importPaths(paths) {
    if (!paths.length) return;
    setStatus(i18n.t('commercial_manager.js_import_worker') || 'Importando en worker...');
    const rootType = $('filter-root').value === 'jingles' ? 'jingles' : 'commercials';
    const category = $('import-category').value || 'paid';
    const result = await ipcRenderer.invoke('commercial-import-paths', { paths, rootType, category });
    setStatus(result?.success ? `${i18n.t('commercial_manager.js_imported') || 'Importados'} ${result.count} ${i18n.t('commercial_manager.js_audio') || 'audio(s)'}` : (result?.error || 'No se pudo importar'));
    await loadAssets(false);
}

function bindEvents() {
    document.querySelectorAll('.nav-tab').forEach(tab => tab.addEventListener('click', () => showView(tab.dataset.view)));
    $('btn-refresh').addEventListener('click', async () => { await loadAssets(true); await loadBlocks(); });
    $('global-search').addEventListener('input', () => { clearTimeout(window.cmSearchTimer); window.cmSearchTimer = setTimeout(() => loadAssets(false), 180); });
    $('filter-root').addEventListener('change', () => loadAssets(false));
    $('filter-category').addEventListener('change', () => loadAssets(false));
    $('filter-status').addEventListener('change', () => loadAssets(false));
    $('btn-set-commercials-root').addEventListener('click', () => setRoot('commercials'));
    $('btn-set-jingles-root').addEventListener('click', () => setRoot('jingles'));
    $('btn-scan-commercials').addEventListener('click', () => scanRoot('commercials'));
    $('btn-scan-jingles').addEventListener('click', () => scanRoot('jingles'));
    $('btn-new-category').addEventListener('click', async () => {
        const name = prompt(i18n.t('commercial_manager.js_new_cat_prompt') || 'Nombre de la nueva categoria:');
        if (!name?.trim()) return;
        const result = await ipcRenderer.invoke('commercial-save-category', { name: name.trim() });
        if (!result?.success) return alert(result?.error || i18n.t('commercial_manager.js_save_err') || 'No se pudo guardar');
        await loadCategories();
        $('import-category').value = result.id;
    });
    $('btn-apply-category').addEventListener('click', async () => {
        const paths = [...selectedAssetPaths];
        if (!paths.length) return;
        await ipcRenderer.invoke('commercial-update-assets-category', { paths, category: $('import-category').value });
        await loadAssets(false);
    });
    $('btn-save-asset').addEventListener('click', saveAsset);
    $('btn-disable-asset').addEventListener('click', async () => {
        if (!selectedAsset) return;
        selectedAsset.enabled = false;
        await ipcRenderer.invoke('commercial-save-asset-metadata', { ...readAssetFromInspector(), enabled: false, status: 'draft' });
        await loadAssets(false);
    });
    $('mode-toggle').addEventListener('change', () => {
        const advanced = $('mode-toggle').checked;
        $('lbl-basic').classList.toggle('active', !advanced);
        $('lbl-advanced').classList.toggle('active', advanced);
        $('sub-basic').classList.toggle('active', !advanced);
        $('sub-advanced').classList.toggle('active', advanced);
        $('editor-basic').style.display = advanced ? 'none' : 'grid';
        $('editor-advanced').style.display = advanced ? 'grid' : 'none';
        const block = getCurrentBlock();
        if (block) block.mode = advanced ? 'advanced' : 'basic';
    });
    $('btn-new-basic-block').addEventListener('click', () => {
        const block = createBlock({ mode: 'basic' });
        blocks.push(block);
        loadBlockEditor(block);
    });
    $('btn-clear-basic').addEventListener('click', () => {
        const block = getCurrentBlock();
        if (!block) return;
        block.items = [];
        renderBasicRows();
        renderTanda();
    });
    $('btn-save-block').addEventListener('click', saveBlock);
    $('btn-save-tanda').addEventListener('click', saveBlock);
    $('btn-empty-tanda').addEventListener('click', () => {
        const block = getCurrentBlock();
        if (!block) return;
        block.items = [];
        renderTanda();
        renderContinuityGrid();
    });
    $('btn-generate-grid').addEventListener('click', () => {
        setStatus(i18n.t('commercial_manager.js_gen_ready') || 'Generador automatico preparado...');
    });
    $('basic-drop').addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
    $('basic-drop').addEventListener('drop', event => {
        event.preventDefault();
        const payload = JSON.parse(event.dataTransfer.getData('application/json') || '[]');
        addAssetsToBlock(payload);
    });
    const dropzone = $('asset-dropzone');
    dropzone.addEventListener('dragover', event => { event.preventDefault(); });
    dropzone.addEventListener('drop', event => {
        event.preventDefault();
        importPaths([...event.dataTransfer.files].map(file => file.path).filter(Boolean));
    });
    window.addEventListener('keydown', event => {
        if (event.ctrlKey && event.key.toLowerCase() === 's') {
            event.preventDefault();
            if (currentView === 'library') saveAsset();
            else saveBlock();
        }
    });
}

(async function init() {
    bindEvents();
    let lang = 'es';
    try {
        const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'general_settings.json'), 'utf8'));
        lang = p.language || 'es';
    } catch (e) {}
    await i18n.init(lang);
    i18n.applyToDOM();
    await loadCategories();
    await loadSettings();
    await loadAssets(false);
    await loadBlocks();
    if (blocks[0]) loadBlockEditor(blocks[0]);
})();
