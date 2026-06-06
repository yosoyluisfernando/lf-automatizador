const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');
const { getConfigDir } = require('../backend/utils/app_paths');
const i18n = require('./i18n');

const configDir = getConfigDir(path.join(__dirname, '..', 'config'), __dirname);

function loadLanguage() {
    let lang = 'es';
    try {
        const prefsPath = path.join(configDir, 'general_settings.json');
        if (fs.existsSync(prefsPath)) {
            const p = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
            lang = p.language || 'es';
        }
    } catch (e) {}
    i18n.init(lang);
    i18n.applyToDOM();
}

ipcRenderer.on('settings-updated', () => {
    loadLanguage();
    updatePreview();
});

let groupsDB = [];
let currentSelectedId = null;

const ulList = document.getElementById('groups-list');
const inputName = document.getElementById('grp-name');
const inputColorBg = document.getElementById('grp-color-bg');
const inputColorTxt = document.getElementById('grp-color-txt');
const btnDelete = document.getElementById('btn-del-group');
const previewBox = document.getElementById('preview-box');
const previewText = document.getElementById('preview-text');
const previewArrow = document.getElementById('preview-arrow'); 

async function loadDB() {
    try {
        const rows = await ipcRenderer.invoke('db-get-groups');
        if (rows && rows.length > 0) {
            groupsDB = rows;
        } else {
            // Predeterminado en caso de que la DB esté vacía
            groupsDB = [{ id: 'g_general', name: i18n.t('event_groups.dyn_general') || 'General', colorBg: '#222225', colorText: '#00a8ff', readonly: true }];
            saveDB();
        }
    } catch(e){
        console.error("Error al cargar grupos desde SQLite vía IPC:", e);
        groupsDB = [{ id: 'g_general', name: i18n.t('event_groups.dyn_general') || 'General', colorBg: '#222225', colorText: '#00a8ff', readonly: true }];
    }
    renderList();
    if(groupsDB.length > 0) selectGroup(groupsDB[0].id);
}

async function saveDB() {
    await ipcRenderer.invoke('db-save-groups', groupsDB);
}

function renderList() {
    ulList.innerHTML = '';
    groupsDB.forEach(g => {
        const li = document.createElement('li');
        li.innerText = g.name;
        if (g.id === currentSelectedId) li.classList.add('selected');
        li.addEventListener('click', () => selectGroup(g.id));
        ulList.appendChild(li);
    });
}

function selectGroup(id) {
    currentSelectedId = id;
    renderList();
    const g = groupsDB.find(x => x.id === id);
    if(!g) return;

    inputName.value = g.name;
    inputColorBg.value = g.colorBg || '#222225';
    inputColorTxt.value = g.colorText || '#00a8ff';
    
    updatePreview();

    if (g.readonly) {
        inputName.disabled = true;
        btnDelete.style.opacity = '0.3';
        btnDelete.style.cursor = 'not-allowed';
    } else {
        inputName.disabled = false;
        btnDelete.style.opacity = '1';
        btnDelete.style.cursor = 'pointer';
    }
}

function updatePreview() {
    previewBox.style.backgroundColor = inputColorBg.value;
    previewText.style.color = inputColorTxt.value;
    previewArrow.style.color = inputColorTxt.value;
    previewText.innerText = inputName.value || i18n.t('event_groups.preview_txt') || "Vista Previa del Grupo";
}

function updateCurrentGroup() {
    if (!currentSelectedId) return;
    const g = groupsDB.find(x => x.id === currentSelectedId);
    if (!g) return;

    if (!g.readonly) g.name = inputName.value;
    g.colorBg = inputColorBg.value;
    g.colorText = inputColorTxt.value;

    updatePreview();
    renderList();
}

inputName.addEventListener('input', updateCurrentGroup);
inputColorBg.addEventListener('input', updateCurrentGroup);
inputColorTxt.addEventListener('input', updateCurrentGroup);

document.getElementById('btn-reset-colors').addEventListener('click', (e) => {
    e.preventDefault(); 
    if (!currentSelectedId) return;
    const g = groupsDB.find(x => x.id === currentSelectedId);
    if (!g) return;

    inputColorBg.value = '#222225';
    inputColorTxt.value = '#00a8ff';
    
    updateCurrentGroup(); 
});

document.getElementById('btn-add-group').addEventListener('click', () => {
    const newId = 'g_' + Date.now();
    groupsDB.push({
        id: newId, name: i18n.t('event_groups.dyn_new_group') || 'Nuevo Grupo', colorBg: '#222225', colorText: '#00a8ff', readonly: false
    });
    selectGroup(newId);
});

btnDelete.addEventListener('click', () => {
    const g = groupsDB.find(x => x.id === currentSelectedId);
    if (!g || g.readonly) return; 
    groupsDB = groupsDB.filter(x => x.id !== currentSelectedId);
    if (groupsDB.length > 0) selectGroup(groupsDB[0].id);
    else currentSelectedId = null;
    renderList();
});

document.getElementById('btn-save').addEventListener('click', async (e) => {
    e.preventDefault();
    groupsDB = groupsDB.filter(g => g.name && g.name.trim() !== '');
    
    await saveDB();
    window.close();
});

document.getElementById('btn-cancel').addEventListener('click', (e) => {
    e.preventDefault();
    window.close();
});

document.addEventListener('DOMContentLoaded', () => {
    loadLanguage();
    loadDB();
});