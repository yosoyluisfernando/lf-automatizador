const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');
const { normalizeAudioPrefs } = require('./audio_prefs');

const configDir = path.join(__dirname, '..', 'config');
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

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

const defaultFileTypes = [
    { id: 't_comercial', name: 'Comercial', color: '#ff0000', identifier: 'comercial', searchIn: 'all', amp: 0, report: true, voice: false, readonly: true, fadeinActive: false, fadein: 0, mixActive: false, mix: 0, mixDbActive: false, mixDb: -14, fadeoutStopActive: false, fadeoutStop: 0, fadeoutNextActive: false, fadeoutNext: 0, mixFadeoutActive: false },
    { id: 't_time', name: 'Locución horaria', color: '#2ecc71', identifier: 'saytime', searchIn: 'all', amp: 0, report: true, voice: true, readonly: true, fadeinActive: false, fadein: 0, mixActive: false, mix: 0, mixDbActive: false, mixDb: -14, fadeoutStopActive: false, fadeoutStop: 0, fadeoutNextActive: false, fadeoutNext: 0, mixFadeoutActive: false },
    { id: 't_station_id', name: 'Station ID', color: '#3498db', identifier: 'id', searchIn: 'all', amp: 0, report: true, voice: false, readonly: false, fadeinActive: false, fadein: 0, mixActive: false, mix: 0, mixDbActive: false, mixDb: -14, fadeoutStopActive: false, fadeoutStop: 0, fadeoutNextActive: false, fadeoutNext: 0, mixFadeoutActive: false }
];

let fileTypesData = loadConfig(fileTypesPath, defaultFileTypes).map(typeData => {
    const migrated = { ...typeData, mixFadeoutActive: typeData.mixFadeoutActive === true };
    delete migrated.mixFadeout;
    return migrated;
});
let generalPrefs = normalizeAudioPrefs(loadConfig(generalPrefsPath, {
    modeLoopPlaylist: false, modeRemovePlayed: false, modeRepeatTrack: false, 
    timeFolder: '', duckingFade: 1.0, duckingVolume: 20,
    outMain: 'default', outMonitor: 'default', outEditor: 'default', outCue: 'default', outCartwall: 'default',
    monitorVolume: 100, monitorEnabled: false, monitorSourceMode: 'postFx', monitorVolumeUiEnabled: true, monitorVolumeUiMode: 'inline', playlistOutputMode: 'disabled', playlistSharedDevice: 'default',
    playlistOutputs: ['default', 'default', 'default', 'default'], cartwallOutputMode: 'master', audioEngineMode: 'webAudio',
    chk_mus_fadein: false, chk_mus_fadeout_stop: false, chk_mus_fadeout_next: false, chk_mus_mix: false, chk_mus_mix_db: false, chk_mus_mix_fadeout: false,
    num_mus_fadein: 0, num_mus_fadeout_stop: 0, num_mus_fadeout_next: 0, num_mus_mix: 0, num_mus_mix_db: -14
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
        fadeinActive: false, fadein: 0, mixActive: false, mix: 0, mixDbActive: false, mixDb: -14, fadeoutStopActive: false, fadeoutStop: 0, fadeoutNextActive: false, fadeoutNext: 0, mixFadeoutActive: false
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
const lblWeatherTemp = document.getElementById('lbl-weather-temp');
const lblWeatherHum = document.getElementById('lbl-weather-humidity');

if (txtWeatherCity) {
    txtWeatherCity.value = generalPrefs.weatherCity || '';
    if (selWeatherUnit) selWeatherUnit.value = generalPrefs.weatherUnit || 'metric';
    if (txtWeatherFolder) txtWeatherFolder.value = generalPrefs.weatherFolder || '';

    document.getElementById('btn-browse-weather').addEventListener('click', async () => {
        const folder = await ipcRenderer.invoke('dialog:selectFolder');
        if (folder) txtWeatherFolder.value = folder;
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
    txtWeatherCity.addEventListener('input', () => {
        clearTimeout(suggestTimeout);
        const query = txtWeatherCity.value.trim();
        if (query.length < 3) return;
        suggestTimeout = setTimeout(async () => {
            try {
                const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=es&format=json`);
                const data = await res.json();
                const datalist = document.getElementById('weather-city-suggestions');
                if (datalist && data.results) {
                    datalist.innerHTML = '';
                    data.results.forEach(r => {
                        const opt = document.createElement('option');
                        const admin = r.admin1 ? `, ${r.admin1}` : '';
                        opt.value = `${r.name}${admin}, ${r.country_code}`;
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
            const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=es&format=json`);
            const geoData = await geoRes.json();
            
            if (!geoData.results || geoData.results.length === 0) {
                lblWeatherTemp.innerText = '--';
                lblWeatherHum.innerText = '--';
                alert('No se encontro la ciudad.');
                return;
            }
            
            const { latitude, longitude } = geoData.results[0];
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

    if (monitorRow) monitorRow.style.display = monitorEnabled ? 'flex' : 'none';
    if (monitorSourceRow) monitorSourceRow.style.display = monitorEnabled ? 'flex' : 'none';
    if (monitorVolumeUiToggleRow) monitorVolumeUiToggleRow.style.display = monitorEnabled ? 'flex' : 'none';
    if (monitorVolumeUiModeRow) monitorVolumeUiModeRow.style.display = monitorEnabled && monitorVolumeUiEnabled ? 'flex' : 'none';
    if (playlistSharedWrap) playlistSharedWrap.style.display = playlistMode === 'shared' ? 'grid' : 'none';
    if (playlistIndependentWrap) playlistIndependentWrap.style.display = playlistMode === 'independent' ? 'grid' : 'none';
    if (cartwallDeviceRow) cartwallDeviceRow.style.display = cartwallMode === 'device' ? 'flex' : 'none';
}

function applyAudioPrefsToForm() {
    const audioEngineMode = document.getElementById('sel-audio-engine-mode');
    if (audioEngineMode) audioEngineMode.value = generalPrefs.audioEngineMode || 'webAudio';

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

document.getElementById('num-duck-vol').value = generalPrefs.duckingVolume || 20;
document.getElementById('num-duck-fade').value = generalPrefs.duckingFade || 1.0;

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

function saveAll() {
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
    const audioEngineMode = document.getElementById('sel-audio-engine-mode');
    if (audioEngineMode) generalPrefs.audioEngineMode = audioEngineMode.value;
    
    generalPrefs.duckingVolume = parseInt(document.getElementById('num-duck-vol').value) || 20;
    generalPrefs.duckingFade = parseFloat(document.getElementById('num-duck-fade').value) || 1.0;
    
    localStorage.setItem('sel-out-cue', generalPrefs.outCue);

    generalPrefs.timeFolder = txtTimeFolder ? txtTimeFolder.value : '';
    if (document.getElementById('txt-weather-city')) {
        generalPrefs.weatherCity = document.getElementById('txt-weather-city').value;
        generalPrefs.weatherUnit = document.getElementById('sel-weather-unit').value;
        generalPrefs.weatherFolder = document.getElementById('txt-weather-folder').value;
    }
    generalPrefs = normalizeAudioPrefs(generalPrefs);
    delete generalPrefs.num_mus_mix_fadeout;
    saveConfig(generalPrefsPath, generalPrefs);
    ipcRenderer.send('settings-updated');
}

document.getElementById('btn-apply').addEventListener('click', saveAll);
document.getElementById('btn-accept').addEventListener('click', () => { saveAll(); window.close(); });
document.getElementById('btn-cancel').addEventListener('click', () => window.close());

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
