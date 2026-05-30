const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');
const { normalizeAudioPrefs } = require('./audio_prefs');
const { getConfigDir } = require('../backend/utils/app_paths');
const { COMMANDS, DEFAULT_SHORTCUTS, MANDATORY_ACTIONS, ALWAYS_RESERVED, COMMAND_CATEGORIES } = require('./command_registry');
const { buildComboString } = require('./shortcut_manager');

const configDir = getConfigDir(path.join(__dirname, '..', 'config'), __dirname);

const fileTypesPath = path.join(configDir, 'file_types.json');
const generalPrefsPath = path.join(configDir, 'general_settings.json');

function loadConfig(filePath, defaultData) {
    if (fs.existsSync(filePath)) {
        try { 
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (Array.isArray(defaultData)) return Array.isArray(parsed) ? parsed : defaultData;
            return { ...defaultData, ...parsed };
        } catch(e) { return defaultData; }
    }
    return defaultData;
}

function saveConfig(filePath, data) {
    try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); } catch(e) {}
}

const defaultFadeProfile = {
    fadeinActive: false,
    fadein: 0,
    mixActive: true,
    mix: 0.6,
    mixDbActive: true,
    mixDb: -14,
    fadeoutStopActive: true,
    fadeoutStop: 2,
    fadeoutNextActive: true,
    fadeoutNext: 0.6,
    mixFadeoutActive: false
};

const defaultFileTypes = [
    { id: 't_comercial', name: 'Comercial', color: '#ff0000', identifier: 'comercial', searchIn: 'all', amp: 0, report: true, voice: false, readonly: true, ...defaultFadeProfile },
    { id: 't_time', name: 'Locuciones', color: '#2ecc71', identifier: 'locucion', aliases: ['saytime', 'time_locution', 'temperature_locution', 'humidity_locution'], searchIn: 'all', amp: 0, report: true, voice: true, readonly: true, ...defaultFadeProfile },
    { id: 't_station_id', name: 'Station ID', color: '#3498db', identifier: 'id', searchIn: 'all', amp: 0, report: true, voice: false, readonly: true, ...defaultFadeProfile }
];

function normalizeFileTypes(types) {
    const loadedTypes = Array.isArray(types) ? types : [];
    const byId = new Map(loadedTypes.map(typeData => [typeData.id, typeData]));
    const builtInIds = new Set(defaultFileTypes.map(typeData => typeData.id));
    const normalized = defaultFileTypes.map(defaultType => {
        const stored = byId.get(defaultType.id) || {};
        const migrated = {
            ...defaultType,
            ...stored,
            name: defaultType.name,
            identifier: defaultType.identifier,
            aliases: defaultType.aliases || [],
            readonly: true,
            mixFadeoutActive: stored.mixFadeoutActive === true
        };
        delete migrated.mixFadeout;
        return migrated;
    });
    loadedTypes.forEach(typeData => {
        if (!typeData?.id || builtInIds.has(typeData.id)) return;
        const migrated = { ...typeData, mixFadeoutActive: typeData.mixFadeoutActive === true };
        delete migrated.mixFadeout;
        normalized.push(migrated);
    });
    return normalized;
}

let fileTypesData = normalizeFileTypes(loadConfig(fileTypesPath, defaultFileTypes));
let generalPrefs = normalizeAudioPrefs(loadConfig(generalPrefsPath, {
    modeLoopPlaylist: false, modeRemovePlayed: false, modeRepeatTrack: false, 
    timeFolder: '', weatherFolder: '', weatherTemperatureFolder: '', weatherHumidityFolder: '', duckingFade: 0.3, duckingVolume: 80,
    outMain: 'default', outMonitor: 'default', outEditor: 'default', outCue: 'default', outCartwall: 'default',
    monitorVolume: 100, monitorEnabled: false, monitorSourceMode: 'postFx', monitorVolumeUiEnabled: true, monitorVolumeUiMode: 'inline', playlistOutputMode: 'disabled', playlistSharedDevice: 'default',
    playlistOutputs: ['default', 'default', 'default', 'default'], cartwallOutputMode: 'master', audioEngineMode: 'rustAudio', rustPlaylistOwnerEnabled: true,
    repeatForgetProtectionEnabled: false, repeatForgetProtectionMax: 10, repeatDisableOnManualNext: true,
    removePlayedProtectionEnabled: false, removePlayedProtectionMinRemaining: 2,
    dblClickAction: 'mark_next', ctrlDblClickAction: 'smart_skip',
    chk_mus_fadein: false, chk_mus_fadeout_stop: true, chk_mus_fadeout_next: true, chk_mus_mix: true, chk_mus_mix_db: true, chk_mus_mix_fadeout: false,
    num_mus_fadein: 0, num_mus_fadeout_stop: 2, num_mus_fadeout_next: 0.6, num_mus_mix: 0.6, num_mus_mix_db: -14
}));
delete generalPrefs.num_mus_mix_fadeout;

let currentSelectedTypeId = 'default';
let cwState = { activeProfileId: 'default', profiles: [] };
let cwSelectedProfileId = null;

document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.target).classList.add('active');
    });
});

const selTipoArchivo = document.getElementById('sel-tipo-archivo');
const fileTypesList = document.getElementById('file-types-list');

function renderLists() {
    selTipoArchivo.innerHTML = '<option value="default">Música (Predeterminado General)</option>';
    fileTypesList.innerHTML = '';
    fileTypesData.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id; opt.text = t.name;
        selTipoArchivo.appendChild(opt);
        const li = document.createElement('li');
        li.innerText = t.name;
        li.style.color = t.color;
        if (t.id === currentSelectedTypeId) li.classList.add('selected');
        li.addEventListener('click', () => { currentSelectedTypeId = t.id; renderLists(); loadTypeDetails(t.id); loadExceptionFades(t.id); });
        fileTypesList.appendChild(li);
    });
    selTipoArchivo.value = currentSelectedTypeId;
}

function loadTypeDetails(id) {
    const t = fileTypesData.find(x => x.id === id);
    if(!t) return;
    document.getElementById('type-name').value = t.name;
    document.getElementById('type-name').disabled = t.readonly;
    document.getElementById('type-identifier').value = t.identifier;
    document.getElementById('type-identifier').disabled = t.readonly;
    document.getElementById('type-color').value = t.color;
    document.getElementById('type-color').disabled = t.readonly;
    document.getElementById('type-amp').value = t.amp;
    document.getElementById('type-report').checked = t.report;
    document.getElementById('type-voice').checked = t.voice;
    const delBtn = document.getElementById('btn-del-type');
    if (delBtn) {
        delBtn.disabled = t.readonly === true;
        delBtn.title = t.readonly ? 'Tipo predeterminado: no se puede eliminar' : 'Eliminar seleccionado';
    }
}

selTipoArchivo.addEventListener('change', (e) => {
    currentSelectedTypeId = e.target.value;
    if (currentSelectedTypeId !== 'default') loadTypeDetails(currentSelectedTypeId);
    loadExceptionFades(currentSelectedTypeId);
});

function loadExceptionFades(id) {
    let source = {};
    if (id === 'default') {
        source = {
            fadeinActive: generalPrefs.chk_mus_fadein, fadein: generalPrefs.num_mus_fadein,
            fadeoutStopActive: generalPrefs.chk_mus_fadeout_stop, fadeoutStop: generalPrefs.num_mus_fadeout_stop,
            fadeoutNextActive: generalPrefs.chk_mus_fadeout_next, fadeoutNext: generalPrefs.num_mus_fadeout_next,
            mixActive: generalPrefs.chk_mus_mix, mix: generalPrefs.num_mus_mix,
            mixDbActive: generalPrefs.chk_mus_mix_db, mixDb: generalPrefs.num_mus_mix_db,
            mixFadeoutActive: generalPrefs.chk_mus_mix_fadeout
        };
    } else {
        source = fileTypesData.find(x => x.id === id) || {};
    }
    document.getElementById('chk-fadein').checked = source.fadeinActive || false;
    document.getElementById('num-fadein').value = source.fadein || 0;
    document.getElementById('chk-fadeout-stop').checked = source.fadeoutStopActive || false;
    document.getElementById('num-fadeout-stop').value = source.fadeoutStop || 0;
    document.getElementById('chk-fadeout-next').checked = source.fadeoutNextActive || false;
    document.getElementById('num-fadeout-next').value = source.fadeoutNext || 0;
    document.getElementById('chk-mix').checked = source.mixActive || false;
    document.getElementById('num-mix').value = source.mix || 0;
    document.getElementById('chk-mix-db').checked = source.mixDbActive || false;
    document.getElementById('num-mix-db').value = source.mixDb || -14;
    document.getElementById('chk-mix-fadeout').checked = source.mixFadeoutActive || false;
}

function saveCurrentTypeState() {
    if (currentSelectedTypeId !== 'default') {
        const t = fileTypesData.find(x => x.id === currentSelectedTypeId);
        if (t) {
            if(!t.readonly) {
                t.name = document.getElementById('type-name').value;
                t.identifier = document.getElementById('type-identifier').value;
                t.color = document.getElementById('type-color').value;
            }
            t.amp = parseFloat(document.getElementById('type-amp').value) || 0;
            t.report = document.getElementById('type-report').checked;
            t.voice = document.getElementById('type-voice').checked;
            t.fadeinActive = document.getElementById('chk-fadein').checked;
            t.fadein = parseFloat(document.getElementById('num-fadein').value) || 0;
            t.fadeoutStopActive = document.getElementById('chk-fadeout-stop').checked;
            t.fadeoutStop = parseFloat(document.getElementById('num-fadeout-stop').value) || 0;
            t.fadeoutNextActive = document.getElementById('chk-fadeout-next').checked;
            t.fadeoutNext = parseFloat(document.getElementById('num-fadeout-next').value) || 0;
            t.mixActive = document.getElementById('chk-mix').checked;
            t.mix = parseFloat(document.getElementById('num-mix').value) || 0;
            t.mixDbActive = document.getElementById('chk-mix-db').checked;
            t.mixDb = parseFloat(document.getElementById('num-mix-db').value) || -14;
            t.mixFadeoutActive = document.getElementById('chk-mix-fadeout').checked;
            delete t.mixFadeout;
        }
    } else {
        generalPrefs.chk_mus_fadein = document.getElementById('chk-fadein').checked;
        generalPrefs.num_mus_fadein = parseFloat(document.getElementById('num-fadein').value) || 0;
        generalPrefs.chk_mus_fadeout_stop = document.getElementById('chk-fadeout-stop').checked;
        generalPrefs.num_mus_fadeout_stop = parseFloat(document.getElementById('num-fadeout-stop').value) || 0;
        generalPrefs.chk_mus_fadeout_next = document.getElementById('chk-fadeout-next').checked;
        generalPrefs.num_mus_fadeout_next = parseFloat(document.getElementById('num-fadeout-next').value) || 0;
        generalPrefs.chk_mus_mix = document.getElementById('chk-mix').checked;
        generalPrefs.num_mus_mix = parseFloat(document.getElementById('num-mix').value) || 0;
        generalPrefs.chk_mus_mix_db = document.getElementById('chk-mix-db').checked;
        generalPrefs.num_mus_mix_db = parseFloat(document.getElementById('num-mix-db').value) || -14;
        generalPrefs.chk_mus_mix_fadeout = document.getElementById('chk-mix-fadeout').checked;
        delete generalPrefs.num_mus_mix_fadeout;
    }
}

document.querySelectorAll('#tab-types input, #tab-fades input, #sel-tipo-archivo').forEach(el => {
    el.addEventListener('change', () => {
        saveCurrentTypeState();
        if(currentSelectedTypeId !== 'default') renderLists();
    });
});

document.getElementById('btn-add-type').addEventListener('click', () => {
    const newId = 't_' + Date.now();
    fileTypesData.push({
        id: newId, name: 'Nuevo Tipo', color: '#ffffff', identifier: 'nuevo', searchIn: 'all', amp: 0, report: false, voice: false, readonly: false,
        ...defaultFadeProfile
    });
    currentSelectedTypeId = newId; renderLists(); loadTypeDetails(newId); loadExceptionFades(newId);
});

document.getElementById('btn-del-type').addEventListener('click', () => {
    const t = fileTypesData.find(x => x.id === currentSelectedTypeId);
    if (!t || t.readonly) return;
    fileTypesData = fileTypesData.filter(x => x.id !== currentSelectedTypeId);
    currentSelectedTypeId = 'default'; renderLists(); loadExceptionFades('default');
});

const txtTimeFolder = document.getElementById('txt-time-folder');
if (txtTimeFolder) {
    txtTimeFolder.value = generalPrefs.timeFolder || '';
    document.getElementById('btn-browse-time').addEventListener('click', async () => {
        const folder = await ipcRenderer.invoke('dialog:selectFolder');
        if (folder) txtTimeFolder.value = folder;
    });
}

const txtWeatherCity = document.getElementById('txt-weather-city');
const selWeatherUnit = document.getElementById('sel-weather-unit');
const txtWeatherFolder = document.getElementById('txt-weather-folder');
const txtWeatherTempFolder = document.getElementById('txt-weather-temp-folder');
const txtWeatherHumFolder = document.getElementById('txt-weather-hum-folder');
const lblWeatherTemp = document.getElementById('lbl-weather-temp');
const lblWeatherHum = document.getElementById('lbl-weather-humidity');
let selectedWeatherCoords = {
    lat: generalPrefs.weatherLatitude || null,
    lon: generalPrefs.weatherLongitude || null
};

if (txtWeatherCity) {
    txtWeatherCity.value = generalPrefs.weatherCity || '';
    if (selWeatherUnit) selWeatherUnit.value = generalPrefs.weatherUnit || 'metric';
    if (txtWeatherFolder) txtWeatherFolder.value = generalPrefs.weatherFolder || '';
    if (txtWeatherTempFolder) txtWeatherTempFolder.value = generalPrefs.weatherTemperatureFolder || generalPrefs.weatherFolder || '';
    if (txtWeatherHumFolder) txtWeatherHumFolder.value = generalPrefs.weatherHumidityFolder || generalPrefs.weatherFolder || '';

    document.getElementById('btn-browse-weather')?.addEventListener('click', async () => {
        const folder = await ipcRenderer.invoke('dialog:selectFolder');
        if (folder) txtWeatherFolder.value = folder;
    });
    document.getElementById('btn-browse-weather-temp')?.addEventListener('click', async () => {
        const folder = await ipcRenderer.invoke('dialog:selectFolder');
        if (folder && txtWeatherTempFolder) txtWeatherTempFolder.value = folder;
    });
    document.getElementById('btn-browse-weather-hum')?.addEventListener('click', async () => {
        const folder = await ipcRenderer.invoke('dialog:selectFolder');
        if (folder && txtWeatherHumFolder) txtWeatherHumFolder.value = folder;
    });


    const weatherJsonPath = path.join(__dirname, '..', 'config', 'weather.json');
    try {
        if (fs.existsSync(weatherJsonPath)) {
            const wInfo = JSON.parse(fs.readFileSync(weatherJsonPath, 'utf8'));
            if (wInfo.temp !== null) {
                lblWeatherTemp.innerText = `🌡️ ${wInfo.temp} ${wInfo.unitSym}`;
                lblWeatherHum.innerText = `💧 ${wInfo.hum} %`;
                const date = new Date(wInfo.lastUpdate);
                document.getElementById('lbl-weather-updated').innerText = `Última actualización: ${date.toLocaleTimeString('es-PE')}`;
            }
        }
    } catch(e) {}

    let suggestTimeout;
    let weatherSuggestionsMap = new Map();
    txtWeatherCity.addEventListener('input', () => {
        clearTimeout(suggestTimeout);
        selectedWeatherCoords = { lat: null, lon: null };
        const query = txtWeatherCity.value.trim();
        if (query.length < 3) return;
        suggestTimeout = setTimeout(async () => {
            try {
                const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=es&format=json`);
                const data = await res.json();
                const datalist = document.getElementById('weather-city-suggestions');
                if (datalist && data.results) {
                    datalist.innerHTML = '';
                    weatherSuggestionsMap.clear();
                    data.results.forEach(r => {
                        const opt = document.createElement('option');
                        const admin = r.admin1 ? `, ${r.admin1}` : '';
                        const label = `${r.name}${admin}, ${r.country_code}`;
                        opt.value = label;
                        weatherSuggestionsMap.set(label, { lat: r.latitude, lon: r.longitude });
                        datalist.appendChild(opt);
                    });
                }
            } catch(e) {}
        }, 500);
    });

    document.getElementById('btn-weather-fetch').addEventListener('click', async () => {
        const city = txtWeatherCity.value.trim();
        if (!city) { alert('Por favor, ingresa una ciudad.'); return; }
        
        lblWeatherTemp.innerText = '...';
        lblWeatherHum.innerText = '...';
        
        try {
            let latitude, longitude;
            if (weatherSuggestionsMap.has(city)) {
                const coords = weatherSuggestionsMap.get(city);
                latitude = coords.lat;
                longitude = coords.lon;
            } else {
                const queryCity = city.split(',')[0].trim();
                const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(queryCity)}&count=1&language=es&format=json`);
                const geoData = await geoRes.json();
                
                if (!geoData.results || geoData.results.length === 0) {
                    lblWeatherTemp.innerText = '--';
                    lblWeatherHum.innerText = '--';
                    alert('No se encontro la ciudad.');
                    return;
                }
                latitude = geoData.results[0].latitude;
                longitude = geoData.results[0].longitude;
            }
            selectedWeatherCoords = { lat: latitude, lon: longitude };
            
            const unitStr = selWeatherUnit.value === 'imperial' ? 'fahrenheit' : 'celsius';
            const unitSym = selWeatherUnit.value === 'imperial' ? '°F' : '°C';
            
            const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m&temperature_unit=${unitStr}`);
            const wData = await wRes.json();
            
            if (wData.current) {
                lblWeatherTemp.innerText = `${wData.current.temperature_2m} ${unitSym}`;
                lblWeatherHum.innerText = `${wData.current.relative_humidity_2m} %`;
            }
        } catch (e) {
            console.error('Error fetching weather:', e);
            lblWeatherTemp.innerText = 'Error';
            lblWeatherHum.innerText = 'Error';
        }
    });
}

const audioDeviceSelectIds = [
    'sel-out-main',
    'sel-out-monitor',
    'sel-out-cue',
    'sel-playlist-shared',
    'sel-pl-out-1',
    'sel-pl-out-2',
    'sel-pl-out-3',
    'sel-pl-out-4',
    'sel-out-cartwall'
];

function isRustAudioModeSelected() {
    // Rust es ahora el unico motor disponible — el modo WebAudio fue retirado.
    return true;
}

function setSelectDeviceOptions(select, audioOutputs) {
    if (!select) return;
    select.innerHTML = '<option value="default">Tarjeta Predeterminada del Sistema</option>';
    audioOutputs.forEach(device => {
        if (device.deviceId === 'default' || device.deviceId === 'communications') return;
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.text = device.label || `Audio Device ${device.deviceId.substring(0, 5)}...`;
        select.appendChild(opt);
    });
}

function setSelectRustDeviceOptions(select, rustDevices = {}) {
    if (!select) return;
    const defaultName = rustDevices.defaultOutput || rustDevices.defaultOutputName || rustDevices.defaultOutputId || 'Rust';
    select.innerHTML = `<option value="default">Predeterminada Rust (${defaultName})</option>`;
    const outputs = Array.isArray(rustDevices.outputs) ? rustDevices.outputs : [];
    outputs.forEach((device, index) => {
        const value = device.id || device.indexId || `output:${index}`;
        const opt = document.createElement('option');
        opt.value = value;
        const label = device.name || value;
        const prefix = device.indexId || value;
        opt.text = device.isDefault || value === rustDevices.defaultOutputId
            ? `${prefix}: ${label} (default)`
            : `${prefix}: ${label}`;
        select.appendChild(opt);
    });
}

const ROUTE_COMMON_DEVICE_WORDS = new Set([
    'audio', 'device', 'speakers', 'speaker', 'auriculares', 'headphones', 'altavoces',
    'salida', 'output', 'digital', 'high', 'definition', 'usb', 'wasapi', 'default'
]);

function tokenizeRouteLabel(value = '') {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .split(/[^a-z0-9]+/)
        .filter(token => token.length >= 3 && !ROUTE_COMMON_DEVICE_WORDS.has(token));
}

function scoreRouteLabelMatch(a = '', b = '') {
    const aTokens = new Set(tokenizeRouteLabel(a));
    const bTokens = new Set(tokenizeRouteLabel(b));
    if (!aTokens.size || !bTokens.size) return 0;
    let hits = 0;
    aTokens.forEach(token => { if (bTokens.has(token)) hits++; });
    return hits / Math.max(aTokens.size, bTokens.size);
}

function resolveRustOutputIdFromBrowserValue(value, rustDevices = {}, browserOutputs = []) {
    const requested = String(value || '').trim();
    const rustOutputs = Array.isArray(rustDevices.outputs) ? rustDevices.outputs : [];
    if (!requested || requested === 'default') return requested || 'default';
    const exact = rustOutputs.find(output => output.id === requested || output.indexId === requested || output.name === requested);
    if (exact) return exact.id || exact.indexId || 'default';

    const browserDevice = browserOutputs.find(device => device.deviceId === requested);
    const browserLabel = browserDevice?.label || '';
    let best = null;
    rustOutputs.forEach(output => {
        const score = scoreRouteLabelMatch(browserLabel, output.name || '');
        if (!best || score > best.score) best = { output, score };
    });
    if (best && best.score >= 0.34) return best.output.id || best.output.indexId || 'default';
    return requested;
}

function migrateVisiblePrefsToRustOutputIds(rustDevices = {}, browserOutputs = []) {
    generalPrefs.outMain = resolveRustOutputIdFromBrowserValue(generalPrefs.outMain, rustDevices, browserOutputs);
    generalPrefs.outMonitor = resolveRustOutputIdFromBrowserValue(generalPrefs.outMonitor, rustDevices, browserOutputs);
    generalPrefs.outCue = resolveRustOutputIdFromBrowserValue(generalPrefs.outCue, rustDevices, browserOutputs);
    generalPrefs.outCartwall = resolveRustOutputIdFromBrowserValue(generalPrefs.outCartwall, rustDevices, browserOutputs);
    generalPrefs.playlistSharedDevice = resolveRustOutputIdFromBrowserValue(generalPrefs.playlistSharedDevice, rustDevices, browserOutputs);
    generalPrefs.playlistOutputs = (generalPrefs.playlistOutputs || []).map(value => (
        resolveRustOutputIdFromBrowserValue(value, rustDevices, browserOutputs)
    ));
}

function ensureSelectValue(select, value) {
    if (!select) return;
    const hasValue = Array.from(select.options).some(opt => opt.value === value);
    select.value = hasValue ? value : 'default';
}

function updateAudioRoutingVisibility() {
    const monitorRow = document.getElementById('monitor-output-row');
    const monitorSourceRow = document.getElementById('monitor-source-row');
    const monitorVolumeUiToggleRow = document.getElementById('monitor-volume-ui-toggle-row');
    const monitorVolumeUiModeRow = document.getElementById('monitor-volume-ui-mode-row');
    const playlistSharedWrap = document.getElementById('playlist-shared-output-wrap');
    const playlistIndependentWrap = document.getElementById('playlist-independent-output-wrap');
    const cartwallDeviceRow = document.getElementById('cartwall-device-row');

    const monitorEnabled = document.getElementById('chk-monitor-enabled')?.checked === true;
    const monitorVolumeUiEnabled = document.getElementById('chk-monitor-volume-ui')?.checked === true;
    const playlistMode = document.getElementById('sel-playlist-output-mode')?.value || 'disabled';
    const cartwallMode = document.getElementById('sel-cartwall-mode')?.value || 'master';
    const audioEngineHint = document.getElementById('audio-engine-hint');
    if (audioEngineHint) {
        audioEngineHint.textContent = 'Rust es el motor principal: enumera tarjetas nativas y es dueño del audio al aire.';
    }

    if (monitorRow) monitorRow.style.display = monitorEnabled ? 'flex' : 'none';
    if (monitorSourceRow) monitorSourceRow.style.display = monitorEnabled ? 'flex' : 'none';
    if (monitorVolumeUiToggleRow) monitorVolumeUiToggleRow.style.display = monitorEnabled ? 'flex' : 'none';
    if (monitorVolumeUiModeRow) monitorVolumeUiModeRow.style.display = monitorEnabled && monitorVolumeUiEnabled ? 'flex' : 'none';
    if (playlistSharedWrap) playlistSharedWrap.style.display = playlistMode === 'shared' ? 'grid' : 'none';
    if (playlistIndependentWrap) playlistIndependentWrap.style.display = playlistMode === 'independent' ? 'grid' : 'none';
    if (cartwallDeviceRow) cartwallDeviceRow.style.display = cartwallMode === 'device' ? 'flex' : 'none';
}

function normalizeAudioRouteSignature(prefs = {}) {
    const normalized = normalizeAudioPrefs(prefs || {});
    return JSON.stringify({
        audioEngineMode: normalized.audioEngineMode || 'rustAudio',
        rustPlaylistOwnerEnabled: normalized.rustPlaylistOwnerEnabled === true,
        outMain: normalized.outMain || 'default',
        outMonitor: normalized.outMonitor || normalized.outMain || 'default',
        outCue: normalized.outCue || normalized.outMain || 'default',
        outCartwall: normalized.outCartwall || normalized.outMain || 'default',
        monitorEnabled: normalized.monitorEnabled === true,
        monitorSourceMode: normalized.monitorSourceMode === 'preFx' ? 'preFx' : 'postFx',
        playlistOutputMode: normalized.playlistOutputMode || 'disabled',
        playlistSharedDevice: normalized.playlistSharedDevice || normalized.outMain || 'default',
        playlistOutputs: Array.isArray(normalized.playlistOutputs) ? normalized.playlistOutputs.slice(0, 4) : [],
        cartwallOutputMode: normalized.cartwallOutputMode || 'master'
    });
}

function hasAudioRoutingPrefsChanged(previousPrefs = {}, nextPrefs = {}) {
    return normalizeAudioRouteSignature(previousPrefs) !== normalizeAudioRouteSignature(nextPrefs);
}

function applyAudioPrefsToForm() {
    const audioEngineMode = document.getElementById('sel-audio-engine-mode');
    if (audioEngineMode) audioEngineMode.value = 'rustAudio';

    ensureSelectValue(document.getElementById('sel-out-main'), generalPrefs.outMain);
    ensureSelectValue(document.getElementById('sel-out-monitor'), generalPrefs.outMonitor);
    ensureSelectValue(document.getElementById('sel-out-cue'), generalPrefs.outCue);
    ensureSelectValue(document.getElementById('sel-playlist-shared'), generalPrefs.playlistSharedDevice);
    ensureSelectValue(document.getElementById('sel-pl-out-1'), generalPrefs.playlistOutputs[0]);
    ensureSelectValue(document.getElementById('sel-pl-out-2'), generalPrefs.playlistOutputs[1]);
    ensureSelectValue(document.getElementById('sel-pl-out-3'), generalPrefs.playlistOutputs[2]);
    ensureSelectValue(document.getElementById('sel-pl-out-4'), generalPrefs.playlistOutputs[3]);
    ensureSelectValue(document.getElementById('sel-out-cartwall'), generalPrefs.outCartwall);

    const chkMonitorEnabled = document.getElementById('chk-monitor-enabled');
    if (chkMonitorEnabled) chkMonitorEnabled.checked = generalPrefs.monitorEnabled === true;
    const chkMonitorVolumeUi = document.getElementById('chk-monitor-volume-ui');
    if (chkMonitorVolumeUi) chkMonitorVolumeUi.checked = generalPrefs.monitorVolumeUiEnabled !== false;
    const monitorVolumeUiMode = document.getElementById('sel-monitor-volume-ui-mode');
    if (monitorVolumeUiMode) monitorVolumeUiMode.value = generalPrefs.monitorVolumeUiMode || 'inline';
    const monitorSourceMode = document.getElementById('sel-monitor-source-mode');
    if (monitorSourceMode) monitorSourceMode.value = generalPrefs.monitorSourceMode || 'postFx';

    const playlistMode = document.getElementById('sel-playlist-output-mode');
    if (playlistMode) playlistMode.value = generalPrefs.playlistOutputMode || 'disabled';

    const cartwallMode = document.getElementById('sel-cartwall-mode');
    if (cartwallMode) cartwallMode.value = generalPrefs.cartwallOutputMode || 'master';

    updateAudioRoutingVisibility();
}

async function enumerateAudioDevices() {
    if (isRustAudioModeSelected()) {
        try {
            const result = await ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'devices', silent: true });
            const rustDevices = result?.message || result?.status || {};
            if (result?.success === true && Array.isArray(rustDevices.outputs) && rustDevices.outputs.length) {
                let browserOutputs = [];
                try {
                    const browserDevices = await navigator.mediaDevices.enumerateDevices();
                    browserOutputs = browserDevices.filter(d => d.kind === 'audiooutput');
                } catch (err) {}
                migrateVisiblePrefsToRustOutputIds(rustDevices, browserOutputs);
                audioDeviceSelectIds.forEach(id => setSelectRustDeviceOptions(document.getElementById(id), rustDevices));
                applyAudioPrefsToForm();
                return;
            }
        } catch (err) {}
    }
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
        audioDeviceSelectIds.forEach(id => setSelectDeviceOptions(document.getElementById(id), audioOutputs));
        applyAudioPrefsToForm();
    } catch (err) {}
}

async function loadCartwallProfiles() {
    const loaded = await ipcRenderer.invoke('get-cartwall-profiles');
    if (loaded && loaded.profiles) {
        cwState = loaded;
    } else {
        cwState = {
            activeProfileId: 'default',
            profiles: [{ id: 'default', name: 'Principal', bg: '#008c3a', text: '#ffffff', paletas: [{ nombre: 'BOTONERA 1', rows: 5, cols: 5, tabBg: '#3a3f44', tabText: '#cccccc', botones: [] }] }]
        };
        for(let i=1; i<=25; i++) cwState.profiles[0].paletas[0].botones.push({id: i, label: i.toString(), file: '', name: '', bg: '', text: '#FFFFFF', vol: 1, loop: false, stopOther: false, overlap: false});
    }
    cwSelectedProfileId = cwState.activeProfileId;
    renderCwProfilesList();
    loadCwProfileDetails(cwSelectedProfileId);
}

function renderCwProfilesList() {
    const list = document.getElementById('cw-profile-list');
    list.innerHTML = '';
    cwState.profiles.forEach(prof => {
        let li = document.createElement('li');
        let text = prof.name;
        if (prof.id === cwState.activeProfileId) text += ' [ACTIVO]';
        li.innerText = text;
        if (prof.id === cwSelectedProfileId) li.classList.add('selected');
        li.onclick = () => { cwSelectedProfileId = prof.id; renderCwProfilesList(); loadCwProfileDetails(prof.id); };
        list.appendChild(li);
    });
}

function loadCwProfileDetails(id) {
    const prof = cwState.profiles.find(p => p.id === id);
    if (!prof) return;
    document.getElementById('cw-prof-name').value = prof.name;
    document.getElementById('cw-prof-bg').value = prof.bg || '#008c3a';
    document.getElementById('cw-prof-text').value = prof.text || '#ffffff';
}

function saveCwProfileDetails() {
    const prof = cwState.profiles.find(p => p.id === cwSelectedProfileId);
    if (!prof) return;
    prof.name = document.getElementById('cw-prof-name').value || 'Perfil';
    prof.bg = document.getElementById('cw-prof-bg').value;
    prof.text = document.getElementById('cw-prof-text').value;
    ipcRenderer.invoke('save-cartwall-profiles', cwState);
    renderCwProfilesList();
}

document.getElementById('cw-prof-name').addEventListener('change', saveCwProfileDetails);
document.getElementById('cw-prof-bg').addEventListener('change', saveCwProfileDetails);
document.getElementById('cw-prof-text').addEventListener('change', saveCwProfileDetails);

document.getElementById('btn-cw-activate').addEventListener('click', () => {
    cwState.activeProfileId = cwSelectedProfileId;
    ipcRenderer.invoke('save-cartwall-profiles', cwState);
    renderCwProfilesList();
});

document.getElementById('btn-cw-add').addEventListener('click', () => {
    const newId = Date.now().toString();
    const newProfile = { id: newId, name: 'Nuevo Perfil', bg: '#008c3a', text: '#ffffff', paletas: [{ nombre: 'BOTONERA 1', rows: 5, cols: 5, tabBg: '#3a3f44', tabText: '#cccccc', botones: [] }] };
    for(let i=1; i<=25; i++) newProfile.paletas[0].botones.push({id: i, label: i.toString(), file: '', name: '', bg: '', text: '#FFFFFF', vol: 1, loop: false, stopOther: false, overlap: false});
    cwState.profiles.push(newProfile);
    cwSelectedProfileId = newId;
    ipcRenderer.invoke('save-cartwall-profiles', cwState);
    renderCwProfilesList();
    loadCwProfileDetails(newId);
});

document.getElementById('btn-cw-del').addEventListener('click', async () => {
    if (cwState.profiles.length <= 1) { alert("No puedes eliminar el único perfil."); return; }
    const prof = cwState.profiles.find(p => p.id === cwSelectedProfileId);
    if (!prof) return;
    const accion = await ipcRenderer.invoke('preguntar-eliminar-perfil', prof.name);
    if (accion === 0) {
        cwState.profiles = cwState.profiles.filter(p => p.id !== cwSelectedProfileId);
        cwSelectedProfileId = cwState.profiles[0].id;
        if (cwState.activeProfileId === prof.id) cwState.activeProfileId = cwSelectedProfileId;
        ipcRenderer.invoke('save-cartwall-profiles', cwState);
        renderCwProfilesList();
        loadCwProfileDetails(cwSelectedProfileId);
    } else if (accion === 1) {
        const exportado = await ipcRenderer.invoke('exportar-bdeplf', prof);
        if (exportado) {
            cwState.profiles = cwState.profiles.filter(p => p.id !== cwSelectedProfileId);
            cwSelectedProfileId = cwState.profiles[0].id;
            if (cwState.activeProfileId === prof.id) cwState.activeProfileId = cwSelectedProfileId;
            ipcRenderer.invoke('save-cartwall-profiles', cwState);
            renderCwProfilesList();
            loadCwProfileDetails(cwSelectedProfileId);
        }
    }
});

document.getElementById('btn-cw-import').addEventListener('click', async () => {
    const imported = await ipcRenderer.invoke('importar-bdeplf');
    if (imported && imported.name && imported.paletas) {
        imported.id = Date.now().toString(); 
        if(!imported.bg) imported.bg = '#008c3a'; if(!imported.text) imported.text = '#ffffff';
        cwState.profiles.push(imported); 
        cwSelectedProfileId = imported.id;
        ipcRenderer.invoke('save-cartwall-profiles', cwState);
        renderCwProfilesList();
        loadCwProfileDetails(imported.id);
    }
});

document.getElementById('btn-cw-export').addEventListener('click', async () => {
    const prof = cwState.profiles.find(p => p.id === cwSelectedProfileId);
    if (prof) await ipcRenderer.invoke('exportar-bdeplf', prof);
});

document.getElementById('num-duck-vol').value = generalPrefs.duckingVolume ?? 80;
document.getElementById('num-duck-fade').value = generalPrefs.duckingFade || 0.3;

// Comportamiento de clic en playlist
const selDblClick = document.getElementById('sel-dbl-click-action');
const selCtrlDblClick = document.getElementById('sel-ctrl-dbl-click-action');

function syncClickActionSelects() {
    if (!selDblClick || !selCtrlDblClick) return;
    const dblVal = selDblClick.value;
    const ctrlVal = selCtrlDblClick.value;
    Array.from(selDblClick.options).forEach(opt => { opt.hidden = opt.value === ctrlVal; });
    Array.from(selCtrlDblClick.options).forEach(opt => { opt.hidden = opt.value === dblVal; });
}

if (selDblClick && selCtrlDblClick) {
    selDblClick.value = generalPrefs.dblClickAction || 'mark_next';
    selCtrlDblClick.value = generalPrefs.ctrlDblClickAction || 'smart_skip';
    syncClickActionSelects();
    selDblClick.addEventListener('change', syncClickActionSelects);
    selCtrlDblClick.addEventListener('change', syncClickActionSelects);
}

[
    'chk-monitor-enabled',
    'chk-monitor-volume-ui',
    'sel-monitor-source-mode',
    'sel-playlist-output-mode',
    'sel-cartwall-mode',
    'sel-monitor-volume-ui-mode'
].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', updateAudioRoutingVisibility);
});

const audioEngineModeSelect = document.getElementById('sel-audio-engine-mode');
if (audioEngineModeSelect) {
    audioEngineModeSelect.addEventListener('change', () => {
        updateAudioRoutingVisibility();
        enumerateAudioDevices();
    });
}

function saveAll() {
    const previousPrefs = normalizeAudioPrefs(loadConfig(generalPrefsPath, generalPrefs));
    saveCurrentTypeState();
    saveConfig(fileTypesPath, fileTypesData);
    generalPrefs.outMain = document.getElementById('sel-out-main').value;
    generalPrefs.outMonitor = document.getElementById('sel-out-monitor').value;
    generalPrefs.outCue = document.getElementById('sel-out-cue').value;
    generalPrefs.outCartwall = document.getElementById('sel-out-cartwall').value;
    generalPrefs.outEditor = generalPrefs.outCue;
    generalPrefs.monitorEnabled = document.getElementById('chk-monitor-enabled').checked;
    generalPrefs.monitorSourceMode = document.getElementById('sel-monitor-source-mode').value || 'postFx';
    generalPrefs.monitorVolumeUiEnabled = document.getElementById('chk-monitor-volume-ui').checked;
    generalPrefs.monitorVolumeUiMode = document.getElementById('sel-monitor-volume-ui-mode').value || 'inline';
    generalPrefs.playlistOutputMode = document.getElementById('sel-playlist-output-mode').value;
    generalPrefs.playlistSharedDevice = document.getElementById('sel-playlist-shared').value;
    generalPrefs.playlistOutputs = [
        document.getElementById('sel-pl-out-1').value,
        document.getElementById('sel-pl-out-2').value,
        document.getElementById('sel-pl-out-3').value,
        document.getElementById('sel-pl-out-4').value
    ];
    generalPrefs.cartwallOutputMode = document.getElementById('sel-cartwall-mode').value;
    // Rust es el unico motor: forzamos siempre la preferencia, ignorando el select.
    generalPrefs.audioEngineMode = 'rustAudio';
    generalPrefs.rustPlaylistOwnerEnabled = true;
    
    generalPrefs.duckingVolume = parseInt(document.getElementById('num-duck-vol').value) || 80;
    generalPrefs.duckingFade = parseFloat(document.getElementById('num-duck-fade').value) || 0.3;
    if (selDblClick) generalPrefs.dblClickAction = selDblClick.value;
    if (selCtrlDblClick) generalPrefs.ctrlDblClickAction = selCtrlDblClick.value;
    
    localStorage.setItem('sel-out-cue', generalPrefs.outCue);

    generalPrefs.timeFolder = txtTimeFolder ? txtTimeFolder.value : '';
    if (document.getElementById('txt-weather-city')) {
        generalPrefs.weatherCity = document.getElementById('txt-weather-city').value;
        generalPrefs.weatherUnit = document.getElementById('sel-weather-unit').value;
        generalPrefs.weatherTemperatureFolder = document.getElementById('txt-weather-temp-folder')?.value || '';
        generalPrefs.weatherHumidityFolder = document.getElementById('txt-weather-hum-folder')?.value || '';
        generalPrefs.weatherFolder = generalPrefs.weatherTemperatureFolder || generalPrefs.weatherHumidityFolder || generalPrefs.weatherFolder || '';
        generalPrefs.weatherLatitude = selectedWeatherCoords.lat;
        generalPrefs.weatherLongitude = selectedWeatherCoords.lon;
    }
    generalPrefs = normalizeAudioPrefs(generalPrefs);
    delete generalPrefs.num_mus_mix_fadeout;
    saveConfig(generalPrefsPath, generalPrefs);

    if (currentShortcuts !== null) {
        ipcRenderer.invoke('save-keyboard-shortcuts', currentShortcuts);
    }
    if (cwShortcutsModified && cwState?.profiles?.length) {
        ipcRenderer.invoke('save-cartwall-profiles', cwState);
        cwShortcutsModified = false;
    }

    ipcRenderer.send('settings-updated', {
        audioChanged: hasAudioRoutingPrefsChanged(previousPrefs, generalPrefs),
        audioEngineModeChanged: previousPrefs.audioEngineMode !== generalPrefs.audioEngineMode
    });
}

// FASE 3 — Snapshot inicial de la UI para que Cancelar pueda revertir.
// Lo capturamos justo antes de que el operador interactúe. Los selectores
// de tarjetas de audio y los toggles relevantes se serializan a JSON.
const __SETTINGS_SNAPSHOT_IDS = [
    'sel-out-main', 'sel-out-monitor', 'sel-out-cue', 'sel-out-cartwall',
    'sel-pl-out-1', 'sel-pl-out-2', 'sel-pl-out-3', 'sel-pl-out-4',
    'sel-playlist-shared', 'sel-playlist-output-mode', 'sel-cartwall-mode',
    'sel-monitor-source-mode', 'sel-monitor-volume-ui-mode',
    'sel-audio-engine-mode',
    'chk-monitor-enabled', 'chk-monitor-volume-ui',
    'num-duck-vol', 'num-duck-fade',
    'txt-weather-city', 'sel-weather-unit', 'txt-weather-folder', 'txt-weather-temp-folder', 'txt-weather-hum-folder'
];
let __settingsSnapshot = null;

function captureSettingsSnapshot() {
    const snap = {};
    __SETTINGS_SNAPSHOT_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        snap[id] = el.type === 'checkbox' ? el.checked : el.value;
    });
    __settingsSnapshot = snap;
}

function restoreSettingsSnapshot() {
    if (!__settingsSnapshot) return;
    Object.entries(__settingsSnapshot).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = value;
        else el.value = value;
        // Disparar change para que listeners actualicen estados dependientes.
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (err) {}
    });
}

// Capturamos el snapshot tras una pequeña espera para que el DOM termine de
// poblarse con las opciones de tarjetas (que vienen async desde el SO).
setTimeout(captureSettingsSnapshot, 1500);

document.getElementById('btn-apply').addEventListener('click', () => {
    // FASE 3 — Aplicar: persiste y empuja al motor Rust en caliente PERO
    // NO cierra la ventana. Después de aplicar, refrescamos el snapshot
    // para que un posterior Cancelar revierta a este nuevo estado base.
    saveAll();
    captureSettingsSnapshot();
});
document.getElementById('btn-accept').addEventListener('click', () => {
    // FASE 3 — Guardar (Aceptar y Cerrar): aplica + persiste + cierra.
    saveAll();
    window.close();
});
document.getElementById('btn-cancel').addEventListener('click', () => {
    // FASE 3 — Cancelar: revierte la UI al snapshot y cierra SIN persistir
    // ni mandar comandos al motor Rust. Los cambios que estaban "flotando"
    // en los selectores se descartan.
    restoreSettingsSnapshot();
    window.close();
});

// ── Atajos de teclado ─────────────────────────────────────────────────────────
// currentShortcuts es el mapa de overrides guardado en DB.
// getEffectiveShortcuts() fusiona con DEFAULT_SHORTCUTS para obtener el mapa completo.
let currentShortcuts = null;   // null = no cargado aún
let captureKeydownHandler = null;
let cwShortcutsModified = false;

function getEffectiveShortcuts() {
    const result = { ...DEFAULT_SHORTCUTS };
    Object.entries(currentShortcuts || {}).forEach(([aid, key]) => {
        if (key === '' || key === null) delete result[aid];
        else if (key) result[aid] = key;
    });
    return result;
}

function getCwButtonShortcut(tabIdx, btnId) {
    const profile = cwState?.profiles?.find(p => p.id === cwState?.activeProfileId);
    return profile?.paletas?.[tabIdx]?.botones?.find(b => b.id === btnId)?.shortcut || '';
}

function setCwButtonShortcut(tabIdx, btnId, combo) {
    const profile = cwState?.profiles?.find(p => p.id === cwState?.activeProfileId);
    const btn = profile?.paletas?.[tabIdx]?.botones?.find(b => b.id === btnId);
    if (btn) { btn.shortcut = combo; cwShortcutsModified = true; }
}

function findConflictInGeneral(combo, excludeActionId) {
    const eff = getEffectiveShortcuts();
    for (const [aid, key] of Object.entries(eff)) {
        if (key === combo && aid !== excludeActionId) return aid;
    }
    return null;
}

function findConflictInCwActiveTab(combo, excludeTabIdx, excludeBtnId) {
    const profile = cwState?.profiles?.find(p => p.id === cwState?.activeProfileId);
    for (let ti = 0; ti < (profile?.paletas?.length || 0); ti++) {
        for (const btn of (profile.paletas[ti]?.botones || [])) {
            if (btn.shortcut === combo && !(ti === excludeTabIdx && btn.id === excludeBtnId))
                return { tabIdx: ti, btnId: btn.id };
        }
    }
    return null;
}

function showShortcutStatus(msg, type = 'ok') {
    const el = document.getElementById('shortcuts-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'shortcuts-status-msg sc-status-' + type;
    clearTimeout(el._scTimer);
    el._scTimer = setTimeout(() => { el.textContent = ''; el.className = 'shortcuts-status-msg'; }, 4000);
}

function cancelCapture() {
    if (!captureKeydownHandler) return;
    document.removeEventListener('keydown', captureKeydownHandler, true);
    captureKeydownHandler = null;
    document.querySelectorAll('.shortcut-input.sc-capturing').forEach(el => {
        el.classList.remove('sc-capturing');
        const row = el.closest('[data-action-id]') || el.closest('[data-cw-key]');
        if (!row) return;
        if (row.dataset.actionId) {
            el.value = getEffectiveShortcuts()[row.dataset.actionId] || '';
        } else if (row.dataset.cwKey) {
            const [ti, bid] = row.dataset.cwKey.split(':').map(Number);
            el.value = getCwButtonShortcut(ti, bid);
        }
        el.placeholder = 'Sin asignar';
    });
}

function startCapture(inputEl, isCw, actionIdOrTabIdx, cwBtnId) {
    cancelCapture();
    inputEl.value = '';
    inputEl.placeholder = 'Presiona una tecla…';
    inputEl.classList.add('sc-capturing');
    inputEl.focus();

    captureKeydownHandler = (e) => {
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();

        if (e.key === 'Escape') { cancelCapture(); return; }

        const combo = buildComboString(e);
        if (!combo) return;

        // Tecla reservada de sistema
        const baseKey = combo.split('+').pop();
        if (ALWAYS_RESERVED.has(baseKey) || ALWAYS_RESERVED.has(combo)) {
            showShortcutStatus(`"${combo}" es una tecla del sistema y no puede asignarse.`, 'error');
            cancelCapture(); return;
        }

        if (isCw) {
            // Verificar conflicto con acciones generales
            const genConflict = findConflictInGeneral(combo, null);
            if (genConflict) {
                const cmd = COMMANDS.find(c => c.id === genConflict);
                if (MANDATORY_ACTIONS.has(genConflict)) {
                    showShortcutStatus(`"${combo}" está asignada a "${cmd?.label}" (obligatoria). Cambia esa acción primero.`, 'error');
                    cancelCapture(); return;
                }
                if (!currentShortcuts) currentShortcuts = {};
                currentShortcuts[genConflict] = '';
                updateShortcutRowValue(genConflict, '');
            }
            // Conflicto con otro botón del cartwall
            const cwConflict = findConflictInCwActiveTab(combo, actionIdOrTabIdx, cwBtnId);
            if (cwConflict) { setCwButtonShortcut(cwConflict.tabIdx, cwConflict.btnId, ''); updateCwRowValue(cwConflict.tabIdx, cwConflict.btnId, ''); }
            setCwButtonShortcut(actionIdOrTabIdx, cwBtnId, combo);
            inputEl.value = combo; inputEl.placeholder = 'Sin asignar'; inputEl.classList.remove('sc-capturing');
            if (!genConflict) showShortcutStatus(`"${combo}" asignada.`, 'ok');
        } else {
            const conflict = findConflictInGeneral(combo, actionIdOrTabIdx);
            if (conflict) {
                const cmd = COMMANDS.find(c => c.id === conflict);
                if (MANDATORY_ACTIONS.has(conflict)) {
                    showShortcutStatus(`"${combo}" está asignada a "${cmd?.label}" (obligatoria). Cambia esa acción primero.`, 'error');
                    cancelCapture(); return;
                }
                if (!currentShortcuts) currentShortcuts = {};
                currentShortcuts[conflict] = '';
                updateShortcutRowValue(conflict, '');
                showShortcutStatus(`"${combo}" se desasignó de: ${cmd?.label || conflict}`, 'warning');
            }
            if (!currentShortcuts) currentShortcuts = {};
            currentShortcuts[actionIdOrTabIdx] = combo;
            inputEl.value = combo; inputEl.placeholder = 'Sin asignar'; inputEl.classList.remove('sc-capturing');
            if (!conflict) showShortcutStatus(`"${combo}" asignada.`, 'ok');
        }

        document.removeEventListener('keydown', captureKeydownHandler, true);
        captureKeydownHandler = null;
        updateConflictBadges();
    };

    document.addEventListener('keydown', captureKeydownHandler, true);
}

function updateShortcutRowValue(actionId, value) {
    const row = document.querySelector(`[data-action-id="${actionId}"]`);
    if (row) { const inp = row.querySelector('.shortcut-input'); if (inp) inp.value = value; }
}

function updateCwRowValue(tabIdx, btnId, value) {
    const row = document.querySelector(`[data-cw-key="${tabIdx}:${btnId}"]`);
    if (row) { const inp = row.querySelector('.shortcut-input'); if (inp) inp.value = value; }
}

function updateConflictBadges() {
    const usage = {};
    document.querySelectorAll('[data-action-id] .shortcut-input').forEach(inp => {
        if (inp.value) usage[inp.value] = (usage[inp.value] || 0) + 1;
    });
    document.querySelectorAll('[data-action-id]').forEach(row => {
        const inp = row.querySelector('.shortcut-input');
        const badge = row.querySelector('.sc-conflict-badge');
        if (!inp || !badge) return;
        const conflict = inp.value && (usage[inp.value] || 0) > 1;
        badge.style.display = conflict ? 'inline' : 'none';
        inp.classList.toggle('sc-conflict', !!conflict);
    });
}

function buildShortcutRow(cmd, currentValue) {
    const isMandatory = MANDATORY_ACTIONS.has(cmd.id);
    const div = document.createElement('div');
    div.className = 'shortcut-row';
    div.dataset.actionId = cmd.id;

    const label = document.createElement('span');
    label.className = 'shortcut-label';
    label.textContent = cmd.label;
    if (isMandatory) {
        const dot = document.createElement('span');
        dot.style.cssText = 'font-size:10px;color:#e67e22;margin-left:6px;vertical-align:middle;';
        dot.title = 'Obligatoria — siempre debe tener una tecla';
        dot.textContent = '●';
        label.appendChild(dot);
    }

    const zone = document.createElement('div');
    zone.style.cssText = 'display:flex;align-items:center;gap:4px;';

    const input = document.createElement('input');
    input.type = 'text'; input.className = 'shortcut-input'; input.readOnly = true;
    input.value = currentValue || ''; input.placeholder = 'Sin asignar';
    input.title = 'Clic para asignar una tecla';
    input.addEventListener('click', () => startCapture(input, false, cmd.id, -1));

    const badge = document.createElement('span');
    badge.className = 'sc-conflict-badge'; badge.title = 'Conflicto: tecla ya asignada'; badge.textContent = '⚠'; badge.style.display = 'none';

    zone.appendChild(input); zone.appendChild(badge);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'icon-btn shortcut-clear-btn'; clearBtn.textContent = '×';
    clearBtn.disabled = isMandatory;
    clearBtn.title = isMandatory ? 'Obligatoria: no puede quedar sin tecla' : 'Quitar atajo';
    clearBtn.addEventListener('click', () => {
        if (!currentShortcuts) currentShortcuts = {};
        currentShortcuts[cmd.id] = '';
        input.value = '';
        updateConflictBadges();
        showShortcutStatus('Atajo eliminado.', 'ok');
    });

    div.appendChild(label); div.appendChild(zone); div.appendChild(clearBtn);
    return div;
}

function renderShortcutsSection(container) {
    container.innerHTML = '';
    const eff = getEffectiveShortcuts();
    const grouped = {};
    COMMANDS.forEach(cmd => {
        if (!grouped[cmd.category]) grouped[cmd.category] = [];
        grouped[cmd.category].push(cmd);
    });
    Object.entries(grouped).forEach(([cat, cmds]) => {
        const hdr = document.createElement('div');
        hdr.className = 'shortcuts-category-header'; hdr.textContent = cat;
        container.appendChild(hdr);
        cmds.forEach(cmd => container.appendChild(buildShortcutRow(cmd, eff[cmd.id] || '')));
    });
    updateConflictBadges();
}

function buildCwShortcutRow(tabIdx, btnId, labelText, currentValue) {
    const div = document.createElement('div');
    div.className = 'shortcut-row'; div.dataset.cwKey = `${tabIdx}:${btnId}`;

    const label = document.createElement('span');
    label.className = 'shortcut-label'; label.style.color = '#aaa'; label.textContent = labelText;

    const input = document.createElement('input');
    input.type = 'text'; input.className = 'shortcut-input'; input.readOnly = true;
    input.value = currentValue || ''; input.placeholder = 'Sin asignar';
    input.addEventListener('click', () => startCapture(input, true, tabIdx, btnId));

    const clearBtn = document.createElement('button');
    clearBtn.className = 'icon-btn shortcut-clear-btn'; clearBtn.textContent = '×'; clearBtn.title = 'Quitar atajo';
    clearBtn.addEventListener('click', () => {
        setCwButtonShortcut(tabIdx, btnId, '');
        input.value = '';
        showShortcutStatus('Atajo eliminado.', 'ok');
    });

    div.appendChild(label); div.appendChild(input); div.appendChild(clearBtn);
    return div;
}

function renderCartwallShortcutsSection(container) {
    container.innerHTML = '';
    const profile = cwState?.profiles?.find(p => p.id === cwState?.activeProfileId);
    if (!profile?.paletas?.length) {
        container.innerHTML = '<div style="color:#555;font-size:12px;padding:8px 0;">No hay perfil de cartwall activo.</div>';
        return;
    }
    let hasAny = false;
    profile.paletas.forEach((paleta, tabIdx) => {
        const withContent = (paleta.botones || []).filter(b => b.file || b.name);
        if (!withContent.length) return;
        hasAny = true;
        const hdr = document.createElement('div');
        hdr.className = 'shortcuts-category-header';
        hdr.textContent = paleta.nombre || `Botonera ${tabIdx + 1}`;
        container.appendChild(hdr);
        withContent.forEach(btn => {
            const lbl = `Btn ${btn.id}${btn.name ? ` — ${btn.name}` : ''}`;
            container.appendChild(buildCwShortcutRow(tabIdx, btn.id, lbl, btn.shortcut || ''));
        });
    });
    if (!hasAny) container.innerHTML = '<div style="color:#555;font-size:12px;padding:8px 0;">No hay botones configurados en el perfil activo.</div>';
}

async function initShortcutsTab() {
    if (currentShortcuts === null) {
        const saved = await ipcRenderer.invoke('get-keyboard-shortcuts');
        currentShortcuts = { ...(saved || {}) };
    }
    const genEl = document.getElementById('shortcuts-general-container');
    const cwEl  = document.getElementById('shortcuts-cartwall-container');
    if (genEl) renderShortcutsSection(genEl);
    if (cwEl)  renderCartwallShortcutsSection(cwEl);
}

document.querySelector('[data-target="tab-shortcuts"]')
    ?.addEventListener('click', initShortcutsTab);

document.getElementById('btn-shortcuts-reset')?.addEventListener('click', () => {
    currentShortcuts = {};
    const genEl = document.getElementById('shortcuts-general-container');
    if (genEl) renderShortcutsSection(genEl);
    showShortcutStatus('Atajos restaurados a los valores de fábrica.', 'ok');
});

renderLists();
loadExceptionFades('default');
applyAudioPrefsToForm();
enumerateAudioDevices();
loadCartwallProfiles();


// Control de Scroll para inputs numéricos (Global)
document.addEventListener('wheel', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type === 'number') {
        e.preventDefault();
        const input = e.target;
        if (input.disabled || input.readOnly) return;
        
        const step = parseFloat(input.getAttribute('step')) || 1;
        let val = parseFloat(input.value) || 0;
        
        if (e.deltaY < 0) val += step;
        else val -= step;
        
        const min = input.getAttribute('min');
        if (min !== null && val < parseFloat(min)) val = parseFloat(min);
        const max = input.getAttribute('max');
        if (max !== null && val > parseFloat(max)) val = parseFloat(max);
        
        const stepStr = step.toString();
        const decimalPlaces = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
        input.value = val.toFixed(decimalPlaces);
        
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }
}, { passive: false });
