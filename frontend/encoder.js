const { ipcRenderer } = require('electron');
const { redactSensitiveText } = require('../backend/utils/log_security');
const { getConfigDir } = require('../backend/utils/app_paths');
const fs = require('fs');
const path = require('path');
const i18n = require('./i18n');

// Versión real (desde package.json) en la cabecera.
try {
    const appVersion = require('../package.json').version;
    const applyEncoderVersion = () => {
        const el = document.getElementById('enc-version');
        if (el) el.textContent = `LF Automatizador v${appVersion}`;
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyEncoderVersion);
    else applyEncoderVersion();
} catch (err) { /* fallback: texto estático del HTML */ }

// ── Configuración: entrada compartida + lista de servidores ──────────────────
let globalCfg = { source: 'master', mic: '', tapPoint: 'postFx' };
let servers = [];     // ver makeServer()
let nextServerId = 1;
let prefsLoadWarning = '';

function makeServer(data = {}) {
    return {
        id: data.id != null ? String(data.id) : String(nextServerId++),
        name: data.name || '',
        type: data.type || data.serverType || 'icecast',
        ip: data.ip || '',
        port: data.port || '',
        adminPort: data.adminPort || '',
        user: data.user || 'source',
        pass: data.pass || data.password || '',
        mount: data.mount || '',
        codec: data.codec || 'mp3',
        bitrate: String(data.bitrate || '128').replace(/[^\d]/g, '') || '128',
        legacy: data.legacy === true,
        genre: data.genre || '',
        // Auto-conectar cuando la reproducción inicia de forma automática al
        // abrir el programa (opcional, desactivado por defecto).
        autoConnect: data.autoConnect === true,
        // runtime (no se persiste)
        status: 'disconnected',
        autoReconnect: false,
        intentionalStop: false,
        reconnectAttempts: 0,
        reconnectTimer: null,
        startTime: 0,
        timerInterval: null,
        samples: [],
        peakKbps: 0,
        lastThroughputAt: 0
    };
}

function sanitizeServerType(t) {
    return ['icecast', 'shoutcast', 'shoutcast2'].includes(t) ? t : 'icecast';
}

// Carga + migración de prefs. El formato viejo era un único servidor plano.
function loadPrefs() {
    const result = ipcRenderer.sendSync('encoder-prefs-load-sync') || {};
    const raw = result.prefs || {};
    prefsLoadWarning = result.warning || '';
    globalCfg.source = raw.source === 'mic' ? 'mic' : 'master';
    globalCfg.mic = raw.mic || raw.micId || '';
    globalCfg.tapPoint = raw.tapPoint === 'preFx' ? 'preFx' : 'postFx';

    if (Array.isArray(raw.servers)) {
        servers = raw.servers.map(s => makeServer({ ...s, type: sanitizeServerType(s.type || s.serverType) }));
    } else if (raw.ip || raw.port || raw.type) {
        // Migración: prefs antiguas de un solo servidor.
        servers = [makeServer({
            id: '0',
            type: sanitizeServerType(raw.type || raw.serverType),
            ip: raw.ip, port: raw.port, adminPort: raw.adminPort, user: raw.user, pass: raw.pass || raw.password,
            mount: raw.mount, codec: raw.codec, bitrate: raw.bitrate
        })];
    } else {
        servers = [makeServer({ id: '0' })];
    }
    // Asegurar nextServerId mayor que cualquier id numérico existente.
    servers.forEach(s => { const n = parseInt(s.id, 10); if (Number.isFinite(n) && n >= nextServerId) nextServerId = n + 1; });
}

function savePrefs() {
    const data = {
        source: globalCfg.source,
        mic: globalCfg.mic,
        tapPoint: globalCfg.tapPoint,
        servers: servers.map(s => ({
            id: s.id, name: s.name, type: s.type, ip: s.ip, port: s.port, adminPort: s.adminPort,
            user: s.user, pass: s.pass, mount: s.mount, codec: s.codec, bitrate: s.bitrate,
            legacy: s.legacy === true, genre: s.genre || '', autoConnect: s.autoConnect === true
        }))
    };
    ipcRenderer.send('encoder-prefs-save', data);
}

loadPrefs();

// ── Referencias DOM compartidas ──────────────────────────────────────────────
const logBox = document.getElementById('enc-log');
const inputMeterEl = document.getElementById('enc-input-meter');
const inputMeterValuesEl = document.getElementById('enc-input-meter-values');
const inputMeterCoverEl = document.getElementById('enc-input-meter-cover');
const sourceSel = document.getElementById('enc-source');
const micRow = document.getElementById('row-mic');
const micSel = document.getElementById('enc-mic');
const tapPointSel = document.getElementById('enc-tap-point');
const serversContainer = document.getElementById('enc-servers');
const statusListEl = document.getElementById('enc-server-status-list');
const aggBadgeEl = document.getElementById('enc-status-badge');
const summaryEl = document.getElementById('enc-summary');

let micDevicesLoaded = false;
let lastInputMeterAt = 0;
const SMOOTH_WINDOW = 10;

// ── Utilidades ───────────────────────────────────────────────────────────────
function formatKbps(value) {
    if (!Number.isFinite(value) || value <= 0) return '--';
    return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}
function formatDb(value) {
    const db = Number(value);
    // Ancho fijo: el número se alinea a 6 caracteres (cubre "-120.0", "-99.9",
    // "-0.0", "-inf") para que el texto no salte al cambiar de 1 a 2 dígitos.
    // El contenedor usa white-space: pre, así que los espacios se respetan.
    const s = (!Number.isFinite(db) || db <= -119) ? '-inf' : db.toFixed(1);
    return `${s.padStart(6, ' ')} dB`;
}
function formatKbpsFixed(value) {
    // Reserva 3 caracteres para el número (64..320) para que "kbps" no se mueva.
    return `${formatKbps(value).padStart(3, ' ')} kbps`;
}
function serverLabel(s) {
    const typeName = s.type === 'icecast' ? 'Icecast' : s.type === 'shoutcast2' ? 'SHOUTcast2' : 'SHOUTcast';
    const host = s.ip ? `${s.ip}${s.port ? ':' + s.port : ''}` : i18n.t('encoder.without_host');
    return s.name ? s.name : `${typeName} · ${host}`;
}
function getServer(id) { return servers.find(s => s.id === String(id)); }
function hasBusyServers(exceptId = null) {
    return servers.some(s => s.id !== String(exceptId) && s.status !== 'disconnected');
}

function encLog(msg, type = 'info', serverId = null) {
    const d = new Date().toLocaleTimeString('es-PE', { hour12: false });
    let color = '#ccc';
    if (type === 'error') color = '#e74c3c';
    if (type === 'success') color = '#2ecc71';
    if (type === 'warn') color = '#f1c40f';
    const row = document.createElement('div');
    row.style.color = color;
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = `[${d}]`;
    row.appendChild(time);
    const prefix = serverId != null ? `[Srv ${serverId}] ` : '';
    row.appendChild(document.createTextNode(` ${prefix}${redactSensitiveText(msg)}`));
    logBox.appendChild(row);
    while (logBox.children.length > 500) logBox.removeChild(logBox.firstChild);
    logBox.scrollTop = logBox.scrollHeight;
}

// ── Medidor de entrada (compartido) ──────────────────────────────────────────
function resetInputMeter() {
    lastInputMeterAt = 0;
    if (inputMeterValuesEl) inputMeterValuesEl.textContent = i18n.t('encoder.peak_rms', {peak: '-- dB', rms: '-- dB'});
    if (inputMeterCoverEl) inputMeterCoverEl.style.width = '100%';
    if (inputMeterEl) inputMeterEl.classList.remove('warn');
}
function updateInputMeter(report = {}) {
    lastInputMeterAt = Date.now();
    const peakDb = Number(report.peakDb);
    const rmsDb = Number(report.rmsDb);
    let percent = 0;
    if (Number.isFinite(peakDb) && peakDb > -36) percent = peakDb > 3 ? 100 : ((peakDb + 36) / 39) * 100;
    const silentMs = Number(report.silentMs) || 0;
    const source = report.captureProvider || report.source || 'fuente';
    const silent = report.hasSignal === false && silentMs > 4000;
    if (inputMeterCoverEl) inputMeterCoverEl.style.width = `${(100 - percent).toFixed(1)}%`;
    if (inputMeterValuesEl) {
        const silentText = silent ? ` | ` + i18n.t('encoder.silent', {s: Math.round(silentMs / 1000)}) : '';
        inputMeterValuesEl.textContent = i18n.t('encoder.peak_rms', {peak: formatDb(peakDb), rms: formatDb(rmsDb)}) + ` | ${source}${silentText}`;
    }
    if (inputMeterEl) inputMeterEl.classList.toggle('warn', silent);
}
function rawRustMeterToDb(value) {
    const amp = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
    if (amp <= 0.000001) return -120;
    return Math.max(-120, 20 * Math.log10(amp));
}
function mergeRustInputMeters(levels = []) {
    return levels.reduce((acc, meter) => {
        if (!meter) return acc;
        const left = Math.max(0, Math.min(100, Number(meter.left) || 0));
        const right = Math.max(0, Math.min(100, Number(meter.right) || 0));
        const rawPeak = Math.max(left, right);
        acc.peak = Math.max(acc.peak, rawPeak / 100);
        acc.db = Math.max(acc.db, Number.isFinite(Number(meter.db)) ? Number(meter.db) : rawRustMeterToDb(rawPeak));
        return acc;
    }, { peak: 0, db: -120 });
}
function getEncoderRustInputMeter(status = {}) {
    const meters = Array.isArray(status.meters) ? status.meters : [];
    if (!meters.length) return null;
    const byBus = new Map();
    meters.forEach(meter => {
        const bus = String(meter?.bus || '').toLowerCase();
        if (!bus) return;
        const cur = byBus.get(bus) || [];
        cur.push(meter); byBus.set(bus, cur);
    });
    if (byBus.has('master')) return mergeRustInputMeters(byBus.get('master'));
    return mergeRustInputMeters([
        ...(byBus.get('pl1') || []), ...(byBus.get('pl2') || []),
        ...(byBus.get('pl3') || []), ...(byBus.get('pl4') || []),
        ...(byBus.get('jingle') || []), ...(byBus.get('cartwall') || [])
    ]);
}
function updateInputMeterFromRustStatus(status = {}) {
    const now = Date.now();
    if (now - lastInputMeterAt < 20) return;
    const meter = getEncoderRustInputMeter(status);
    if (!meter) return;
    updateInputMeter({
        source: 'rustAudioEngine',
        captureProvider: status.encoder?.captureProvider || status.encoder?.owner || 'rustAudioEngine',
        peakDb: meter.db, rmsDb: meter.db,
        hasSignal: meter.peak > 0.0008,
        silentMs: meter.peak > 0.0008 ? 0 : undefined,
        updatedAt: now
    });
}

// ── Render de tarjetas de servidor ───────────────────────────────────────────
function statusText(status) {
    if (status === 'live') return i18n.t('encoder.status_live');
    if (status === 'connecting') return i18n.t('encoder.status_connecting');
    return i18n.t('encoder.status_off');
}
function statusClass(status) {
    if (status === 'live') return 'status-badge status-on';
    if (status === 'connecting') return 'status-badge status-connecting';
    return 'status-badge status-off';
}

function buildServerCard(s) {
    const card = document.createElement('div');
    card.className = 'enc-server-card';
    card.dataset.serverId = s.id;

    const isIce = s.type === 'icecast';
    const isSc2 = s.type === 'shoutcast2';
    const mountLabel = isSc2 ? i18n.t('encoder.srv_sid') : i18n.t('encoder.srv_mount');
    const mountPh = isSc2 ? i18n.t('encoder.srv_sid_ph') : i18n.t('encoder.srv_mount_ph');

    card.innerHTML = `
        <div class="enc-server-head">
            <span class="enc-server-title"></span>
            <span class="enc-srv-badge ${statusClass(s.status)}">${statusText(s.status)}</span>
            <div class="enc-srv-actions">
                <button class="enc-mini-btn srv-toggle">${i18n.t('encoder.btn_connect')}</button>
                <button class="enc-mini-btn danger srv-remove" title="${i18n.t('encoder.btn_remove')}">&#10005;</button>
            </div>
        </div>
        <div class="enc-server-body">
            <div class="row"><label>${i18n.t('encoder.srv_type')}</label>
                <select class="enc-input dark-select fld-type">
                    <option value="icecast">${i18n.t('encoder.srv_type_ice')}</option>
                    <option value="shoutcast">${i18n.t('encoder.srv_type_sc1')}</option>
                    <option value="shoutcast2">${i18n.t('encoder.srv_type_sc2')}</option>
                </select>
            </div>
            <div class="row"><label>${i18n.t('encoder.srv_ip')}</label><input type="text" class="enc-input fld-ip" placeholder="${i18n.t('encoder.srv_ip_ph')}"></div>
            <div class="row"><label>${i18n.t('encoder.srv_port')}</label><input type="text" class="enc-input fld-port" placeholder="${i18n.t('encoder.srv_port_ph')}" title="${i18n.t('encoder.srv_port_tt')}"></div>
            <div class="row row-admin-port" style="${isIce ? 'display:none;' : ''}"><label>${i18n.t('encoder.srv_admin_port')}</label><input type="text" class="enc-input fld-admin-port" placeholder="${i18n.t('encoder.srv_admin_port_ph')}" title="${i18n.t('encoder.srv_admin_port_tt')}"></div>
            <div class="row row-user" style="${isIce || isSc2 ? '' : 'display:none;'}"><label>${i18n.t('encoder.srv_user')}</label><input type="text" class="enc-input fld-user" placeholder="${i18n.t('encoder.srv_user_ph')}"></div>
            <div class="row"><label>${i18n.t('encoder.srv_pass')}</label><input type="password" class="enc-input fld-pass" placeholder="${i18n.t('encoder.srv_pass_ph')}"></div>
            <div class="row row-mount" style="${isIce || isSc2 ? '' : 'display:none;'}"><label class="lbl-mount">${mountLabel}</label><input type="text" class="enc-input fld-mount" placeholder="${mountPh}"></div>
            <div class="row row-legacy" style="${isSc2 ? '' : 'display:none;'}"><label>${i18n.t('encoder.srv_legacy')}</label><input type="checkbox" class="fld-legacy" title="${i18n.t('encoder.srv_legacy_tt')}"></div>
            <div class="row row-icy" style="${isIce ? 'display:none;' : ''}"><label>${i18n.t('encoder.srv_name')}</label><input type="text" class="enc-input fld-icyname" placeholder="${i18n.t('encoder.srv_name_ph')}" title="${i18n.t('encoder.srv_name_tt')}"></div>
            <div class="row row-icy" style="${isIce ? 'display:none;' : ''}"><label>${i18n.t('encoder.srv_genre')}</label><input type="text" class="enc-input fld-genre" placeholder="${i18n.t('encoder.srv_genre_ph')}" title="${i18n.t('encoder.srv_genre_tt')}"></div>
            <div class="row"><label>${i18n.t('encoder.srv_codec')}</label>
                <select class="enc-input dark-select fld-codec">
                    <option value="mp3">${i18n.t('encoder.srv_codec_mp3')}</option>
                    <option value="aac">${i18n.t('encoder.srv_codec_aac')}</option>
                    <option value="aac_he">${i18n.t('encoder.srv_codec_aac_he')}</option>
                </select>
            </div>
            <div class="row"><label>${i18n.t('encoder.srv_bitrate')}</label>
                <select class="enc-input dark-select fld-bitrate">
                    <option value="64">${i18n.t('encoder.srv_bitrate_64')}</option>
                    <option value="128">${i18n.t('encoder.srv_bitrate_128')}</option>
                    <option value="192">${i18n.t('encoder.srv_bitrate_192')}</option>
                    <option value="320">${i18n.t('encoder.srv_bitrate_320')}</option>
                </select>
            </div>
            <div class="row"><label>${i18n.t('encoder.srv_autoconnect')}</label><input type="checkbox" class="fld-autoconnect" title="${i18n.t('encoder.srv_autoconnect_tt')}"></div>
        </div>`;

    // Rellenar valores
    card.querySelector('.enc-server-title').textContent = serverLabel(s);
    card.querySelector('.fld-type').value = s.type;
    card.querySelector('.fld-ip').value = s.ip;
    card.querySelector('.fld-port').value = s.port;
    card.querySelector('.fld-admin-port').value = s.adminPort;
    card.querySelector('.fld-user').value = s.user || 'source';
    card.querySelector('.fld-pass').value = s.pass;
    card.querySelector('.fld-mount').value = s.mount;
    card.querySelector('.fld-codec').value = s.codec;
    card.querySelector('.fld-bitrate').value = s.bitrate;
    card.querySelector('.fld-legacy').checked = s.legacy === true;
    card.querySelector('.fld-icyname').value = s.name || '';
    card.querySelector('.fld-genre').value = s.genre || '';
    card.querySelector('.fld-autoconnect').checked = s.autoConnect === true;

    wireServerCard(card, s);
    return card;
}

function wireServerCard(card, s) {
    const typeSel = card.querySelector('.fld-type');
    const rowUser = card.querySelector('.row-user');
    const rowMount = card.querySelector('.row-mount');
    const rowLegacy = card.querySelector('.row-legacy');
    const rowAdminPort = card.querySelector('.row-admin-port');
    const rowsIcy = card.querySelectorAll('.row-icy');
    const lblMount = card.querySelector('.lbl-mount');
    const mountInput = card.querySelector('.fld-mount');

    function applyTypeVisibility() {
        const t = typeSel.value;
        const isIce = t === 'icecast';
        rowsIcy.forEach(r => { r.style.display = isIce ? 'none' : 'flex'; });
        rowAdminPort.style.display = isIce ? 'none' : 'flex';
        if (isIce) {
            rowMount.style.display = 'flex'; lblMount.textContent = i18n.t('encoder.srv_mount'); mountInput.placeholder = i18n.t('encoder.srv_mount_ph');
            rowUser.style.display = 'flex';
            rowLegacy.style.display = 'none';
        } else if (t === 'shoutcast2') {
            rowMount.style.display = 'flex'; lblMount.textContent = i18n.t('encoder.srv_sid'); mountInput.placeholder = i18n.t('encoder.srv_sid_ph');
            rowUser.style.display = 'flex';
            rowLegacy.style.display = 'flex';
        } else {
            rowMount.style.display = 'none'; rowUser.style.display = 'none';
            rowLegacy.style.display = 'none';
        }
    }

    typeSel.addEventListener('change', () => { s.type = sanitizeServerType(typeSel.value); applyTypeVisibility(); refreshTitles(); savePrefs(); });
    card.querySelector('.fld-ip').addEventListener('input', (e) => { s.ip = e.target.value.trim(); refreshTitles(); savePrefs(); });
    card.querySelector('.fld-port').addEventListener('input', (e) => { s.port = e.target.value.trim(); refreshTitles(); savePrefs(); });
    card.querySelector('.fld-admin-port').addEventListener('input', (e) => { s.adminPort = e.target.value.trim(); savePrefs(); });
    card.querySelector('.fld-user').addEventListener('input', (e) => { s.user = e.target.value.trim() || 'source'; savePrefs(); });
    card.querySelector('.fld-pass').addEventListener('input', (e) => { s.pass = e.target.value; savePrefs(); });
    mountInput.addEventListener('input', (e) => { s.mount = e.target.value; savePrefs(); });
    mountInput.addEventListener('blur', () => {
        const raw = (s.mount || '').trim();
        if (!raw) return;
        if (s.type === 'shoutcast2') s.mount = raw.replace(/[^\d]/g, '') || '1';
        else s.mount = raw.startsWith('/') ? raw : `/${raw}`;
        mountInput.value = s.mount;
        savePrefs();
    });
    card.querySelector('.fld-legacy').addEventListener('change', (e) => { s.legacy = e.target.checked; savePrefs(); });
    card.querySelector('.fld-icyname').addEventListener('input', (e) => { s.name = e.target.value; refreshTitles(); savePrefs(); });
    card.querySelector('.fld-genre').addEventListener('input', (e) => { s.genre = e.target.value; savePrefs(); });
    card.querySelector('.fld-codec').addEventListener('change', (e) => { s.codec = e.target.value; savePrefs(); });
    card.querySelector('.fld-bitrate').addEventListener('change', (e) => { s.bitrate = String(e.target.value).replace(/[^\d]/g, '') || '128'; savePrefs(); });
    card.querySelector('.fld-autoconnect').addEventListener('change', (e) => { s.autoConnect = e.target.checked; savePrefs(); });

    card.querySelector('.srv-toggle').addEventListener('click', () => {
        if (s.status === 'disconnected') connectServer(s.id);
        else disconnectServer(s.id);
    });
    card.querySelector('.srv-remove').addEventListener('click', () => removeServer(s.id));
}

function renderServers() {
    serversContainer.innerHTML = '';
    servers.forEach(s => serversContainer.appendChild(buildServerCard(s)));
    renderStatusList();
    updateAggregate();
}

function refreshTitles() {
    servers.forEach(s => {
        const card = serversContainer.querySelector(`.enc-server-card[data-server-id="${s.id}"]`);
        if (card) card.querySelector('.enc-server-title').textContent = serverLabel(s);
        const row = statusListEl.querySelector(`.enc-status-row[data-server-id="${s.id}"] .srv-name`);
        if (row) row.textContent = serverLabel(s);
    });
}

// ── Lista de estado (pestaña Estado) ─────────────────────────────────────────
function renderStatusList() {
    statusListEl.innerHTML = '';
    if (!servers.length) {
        statusListEl.innerHTML = `<div style="color:#555;font-size:12px;padding:6px 2px;">${i18n.t('encoder.no_servers_configured')}</div>`;
        return;
    }
    servers.forEach(s => {
        const row = document.createElement('div');
        row.className = 'enc-status-row';
        row.dataset.serverId = s.id;
        row.innerHTML = `
            <span class="${statusClass(s.status)} srv-badge">${statusText(s.status)}</span>
            <span class="srv-name"></span>
            <span class="srv-kbps"> -- kbps</span>
            <span class="srv-uptime">00:00:00</span>
            <button class="enc-mini-btn srv-toggle2">${i18n.t('encoder.btn_connect')}</button>`;
        row.querySelector('.srv-name').textContent = serverLabel(s);
        row.querySelector('.srv-toggle2').addEventListener('click', () => {
            if (s.status === 'disconnected') connectServer(s.id); else disconnectServer(s.id);
        });
        statusListEl.appendChild(row);
        updateServerRowButtons(s);
    });
}

function updateServerRowButtons(s) {
    const label = s.status === 'disconnected' ? i18n.t('encoder.btn_connect') : (s.status === 'connecting' ? i18n.t('encoder.btn_cancel') : i18n.t('encoder.btn_disconnect'));
    const cls = s.status === 'disconnected' ? 'enc-mini-btn' : 'enc-mini-btn off';
    // tarjeta config
    const card = serversContainer.querySelector(`.enc-server-card[data-server-id="${s.id}"]`);
    if (card) {
        const badge = card.querySelector('.enc-srv-badge');
        if (badge) { badge.className = `enc-srv-badge ${statusClass(s.status)}`; badge.textContent = statusText(s.status); }
        const btn = card.querySelector('.srv-toggle');
        if (btn) { btn.textContent = label; btn.className = cls + ' srv-toggle'; }
    }
    // fila estado
    const row = statusListEl.querySelector(`.enc-status-row[data-server-id="${s.id}"]`);
    if (row) {
        const badge = row.querySelector('.srv-badge');
        if (badge) { badge.className = `${statusClass(s.status)} srv-badge`; badge.textContent = statusText(s.status); }
        const btn = row.querySelector('.srv-toggle2');
        if (btn) { btn.textContent = label; btn.className = cls + ' srv-toggle2'; }
    }
}

function setServerKbps(s, smoothed) {
    const row = statusListEl.querySelector(`.enc-status-row[data-server-id="${s.id}"] .srv-kbps`);
    if (row) row.textContent = formatKbpsFixed(smoothed);
}
function setServerUptime(s, text) {
    const row = statusListEl.querySelector(`.enc-status-row[data-server-id="${s.id}"] .srv-uptime`);
    if (row) row.textContent = text;
}

// ── Estado agregado (cabecera) ───────────────────────────────────────────────
function updateAggregate() {
    let live = 0, connecting = 0;
    servers.forEach(s => { if (s.status === 'live') live++; else if (s.status === 'connecting') connecting++; });
    if (aggBadgeEl) {
        if (live > 0) { aggBadgeEl.className = 'status-badge status-on'; aggBadgeEl.textContent = i18n.t('encoder.status_live'); }
        else if (connecting > 0) { aggBadgeEl.className = 'status-badge status-connecting'; aggBadgeEl.textContent = i18n.t('encoder.status_connecting'); }
        else { aggBadgeEl.className = 'status-badge status-off'; aggBadgeEl.textContent = i18n.t('encoder.status_disconnected'); }
    }
    if (summaryEl) {
        summaryEl.textContent = live > 0
            ? i18n.t('encoder.summary_live', { live, connecting }).replace(', 0 conectando', '')
            : (connecting > 0 ? i18n.t('encoder.summary_connecting_only', { connecting }) : i18n.t('encoder.no_active_transmissions'));
    }
}

// ── Conexión por servidor ────────────────────────────────────────────────────
function buildServerConfig(s) {
    return {
        serverId: s.id,
        serverType: s.type, type: s.type,
        ip: s.ip, port: s.port, adminPort: s.adminPort,
        user: s.user || 'source',
        password: s.pass, pass: s.pass,
        mount: s.mount,
        source: globalCfg.source,
        micId: globalCfg.mic, mic: globalCfg.mic,
        codec: s.codec, bitrate: s.bitrate,
        legacy: s.legacy === true,
        icyName: s.name || 'Radio',
        icyGenre: s.genre || 'Variado',
        encoderProvider: 'rust',
        tapPoint: globalCfg.tapPoint
    };
}

function validateServer(s) {
    const portNum = Number(s.port);
    const adminPortNum = Number(s.adminPort);
    if (s.adminPort && (!Number.isInteger(adminPortNum) || adminPortNum < 1 || adminPortNum > 65535)) return i18n.t('encoder.err_admin_port');
    if (!s.ip || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return i18n.t('encoder.err_ip_port');
    if (!s.pass) return i18n.t('encoder.err_pass');
    if (s.type === 'icecast' && !s.mount) return i18n.t('encoder.err_mount');
    if (s.type === 'shoutcast2' && !/^[1-9]\d*$/.test(String(s.mount || '').trim())) return i18n.t('encoder.err_sid');
    if (!['mp3', 'aac', 'aac_he'].includes(s.codec)) return i18n.t('encoder.err_codec');
    if (globalCfg.source === 'mic' && !globalCfg.mic) return i18n.t('encoder.err_no_mic');
    return null;
}

function connectServer(id, opts = {}) {
    const s = getServer(id);
    if (!s) return;
    if (globalCfg.source === 'mic' && hasBusyServers(s.id)) {
        encLog(i18n.t('encoder.err_mic_busy'), 'error', s.id);
        return;
    }
    const err = validateServer(s);
    if (err) { encLog(err, 'error', s.id); document.getElementById('tab-btn-config').click(); return; }
    clearServerReconnect(s);
    s.autoReconnect = true;
    s.intentionalStop = false;
    if (!opts.isRetry) { s.reconnectAttempts = 0; s.samples = []; s.peakKbps = 0; }
    savePrefs();
    ipcRenderer.send('start-encoder-server', buildServerConfig(s));
    setServerStatus(s.id, 'connecting');
    encLog(opts.isRetry ? i18n.t('encoder.log_retry') : i18n.t('encoder.log_start'), 'warn', s.id);
}

function disconnectServer(id) {
    const s = getServer(id);
    if (!s) return;
    s.intentionalStop = true;
    s.autoReconnect = false;
    clearServerReconnect(s);
    ipcRenderer.send('stop-encoder-server', { serverId: s.id });
    encLog(i18n.t('encoder.log_stop'), 'warn', s.id);
}

function connectAll() {
    if (!servers.length) { encLog(i18n.t('encoder.no_servers_configured'), 'warn'); return; }
    servers.forEach(s => { if (s.status === 'disconnected') connectServer(s.id); });
}
function disconnectAll() {
    servers.forEach(s => { s.intentionalStop = true; s.autoReconnect = false; clearServerReconnect(s); });
    ipcRenderer.send('stop-encoder');
    encLog(i18n.t('encoder.log_stop_all'), 'warn');
}

// ── Reconexión por servidor ──────────────────────────────────────────────────
function clearServerReconnect(s) { if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; } }
function scheduleServerReconnect(s) {
    if (!s.autoReconnect || s.intentionalStop || s.reconnectTimer) return;
    s.reconnectAttempts++;
    const delaySec = Math.min(60, s.reconnectAttempts <= 1 ? 5 : 5 * Math.pow(2, Math.min(4, s.reconnectAttempts - 1)));
    encLog(i18n.t('encoder.log_reconnect', { s: delaySec, n: s.reconnectAttempts }), 'error', s.id);
    s.reconnectTimer = setTimeout(() => {
        s.reconnectTimer = null;
        if (s.autoReconnect && !s.intentionalStop) connectServer(s.id, { isRetry: true });
    }, delaySec * 1000);
}

// ── Transición de estado por servidor ────────────────────────────────────────
function setServerStatus(id, status) {
    const s = getServer(id);
    if (!s) return;
    const prev = s.status;
    s.status = status;
    updateServerRowButtons(s);
    updateAggregate();

    if (status === 'live') {
        if (prev !== 'live') encLog(i18n.t('encoder.log_connected'), 'success', s.id);
        s.autoReconnect = true; s.intentionalStop = false; s.reconnectAttempts = 0;
        clearServerReconnect(s);
        if (!s.timerInterval) {
            s.startTime = Date.now();
            s.timerInterval = setInterval(() => {
                const total = Math.floor((Date.now() - s.startTime) / 1000);
                const h = String(Math.floor(total / 3600)).padStart(2, '0');
                const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
                const sec = String(total % 60).padStart(2, '0');
                setServerUptime(s, `${h}:${m}:${sec}`);
            }, 1000);
        }
    } else if (status === 'disconnected') {
        if (s.timerInterval) { clearInterval(s.timerInterval); s.timerInterval = null; }
        setServerUptime(s, '00:00:00');
        setServerKbps(s, 0);
        if (s.autoReconnect && !s.intentionalStop) scheduleServerReconnect(s);
    }
}

function updateServerThroughput(report = {}) {
    const s = getServer(report.serverId);
    if (!s) return;
    const kbps = Number(report.bitrateKbps);
    if (!Number.isFinite(kbps) || kbps <= 0) return;
    s.lastThroughputAt = Date.now();
    s.peakKbps = Math.max(s.peakKbps, kbps);
    s.samples.push(kbps);
    if (s.samples.length > 120) s.samples.shift();
    // Promedio móvil para una lectura estable (ver nota de overhead ADTS/ABR).
    const win = s.samples.slice(-SMOOTH_WINDOW);
    const smoothed = win.reduce((a, b) => a + b, 0) / win.length;
    setServerKbps(s, smoothed);
}

// ── Agregar / quitar servidores ──────────────────────────────────────────────
function addServer() {
    const s = makeServer({ type: 'icecast', codec: 'mp3', bitrate: '128' });
    servers.push(s);
    savePrefs();
    renderServers();
}
function removeServer(id) {
    const s = getServer(id);
    if (!s) return;
    if (s.status !== 'disconnected') disconnectServer(id);
    clearServerReconnect(s);
    if (s.timerInterval) clearInterval(s.timerInterval);
    servers = servers.filter(x => x.id !== String(id));
    savePrefs();
    renderServers();
}

// ── Micrófonos (entrada externa) ─────────────────────────────────────────────
async function loadMicrophones() {
    if (micDevicesLoaded) return;
    try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter(d => d.kind === 'audioinput');
        micSel.innerHTML = '';
        mics.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.deviceId;
            opt.text = m.label || `Micrófono ${m.deviceId.substring(0, 5)}`;
            micSel.appendChild(opt);
        });
        if (globalCfg.mic && Array.from(micSel.options).some(o => o.value === globalCfg.mic)) micSel.value = globalCfg.mic;
        micDevicesLoaded = true;
        encLog(i18n.t('encoder.log_mic_ok'), 'success');
    } catch (e) {
        encLog(i18n.t('encoder.log_mic_err'), 'error');
    }
}

// ── Wiring global ────────────────────────────────────────────────────────────
document.getElementById('tab-btn-status').addEventListener('click', (e) => {
    document.querySelectorAll('.enc-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.enc-pane').forEach(p => p.classList.remove('active'));
    e.target.classList.add('active');
    document.getElementById('tab-status').classList.add('active');
});
document.getElementById('tab-btn-config').addEventListener('click', (e) => {
    document.querySelectorAll('.enc-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.enc-pane').forEach(p => p.classList.remove('active'));
    e.target.classList.add('active');
    document.getElementById('tab-config').classList.add('active');
});

sourceSel.value = globalCfg.source;
tapPointSel.value = globalCfg.tapPoint;

sourceSel.addEventListener('change', async () => {
    if (servers.some(s => s.status !== 'disconnected')) {
        sourceSel.value = globalCfg.source;
        encLog(i18n.t('encoder.warn_source_change'), 'warn');
        return;
    }
    globalCfg.source = sourceSel.value === 'mic' ? 'mic' : 'master';
    micRow.style.display = globalCfg.source === 'mic' ? 'flex' : 'none';
    if (globalCfg.source === 'mic') await loadMicrophones();
    savePrefs();
});
micRow.style.display = globalCfg.source === 'mic' ? 'flex' : 'none';
if (globalCfg.source === 'mic') loadMicrophones();

micSel.addEventListener('change', () => {
    if (servers.some(s => s.status !== 'disconnected')) {
        micSel.value = globalCfg.mic;
        encLog(i18n.t('encoder.warn_mic_change'), 'warn');
        return;
    }
    globalCfg.mic = micSel.value;
    savePrefs();
});

// Tap point: persistir + hot-swap al motor Rust (sin reiniciar el encoder).
ipcRenderer.send('encoder-tap-point-changed', { tapPoint: globalCfg.tapPoint });
tapPointSel.addEventListener('change', () => {
    globalCfg.tapPoint = tapPointSel.value === 'preFx' ? 'preFx' : 'postFx';
    savePrefs();
    ipcRenderer.send('encoder-tap-point-changed', { tapPoint: globalCfg.tapPoint });
});

document.getElementById('btn-add-server').addEventListener('click', addServer);
document.getElementById('btn-connect-all').addEventListener('click', connectAll);
document.getElementById('btn-disconnect-all').addEventListener('click', disconnectAll);

// ── Listeners IPC ────────────────────────────────────────────────────────────
ipcRenderer.on('encoder-status', (e, payload) => {
    if (payload && typeof payload === 'object') setServerStatus(payload.serverId, payload.status);
});
ipcRenderer.on('encoder-servers-snapshot', (e, list) => {
    if (!Array.isArray(list)) return;
    list.forEach(item => { if (getServer(item.serverId)) setServerStatus(item.serverId, item.status); });
});
// Arranque automático del encoder (auto-play desatendido): conecta únicamente
// los servidores marcados como "auto-conectar al iniciar" y que aún no estén en
// uso. Reutiliza connectServer, así que hereda validación y reconexión.
ipcRenderer.on('encoder-autoconnect-marked', () => {
    servers.forEach(s => {
        if (s.autoConnect === true && s.status === 'disconnected') connectServer(s.id);
    });
});
ipcRenderer.on('encoder-throughput', (e, report) => updateServerThroughput(report || {}));
ipcRenderer.on('encoder-error', (e, payload) => {
    if (payload && typeof payload === 'object') {
        const s = getServer(payload.serverId);
        if (s && payload.retryable === false) {
            s.autoReconnect = false;
            clearServerReconnect(s);
        }
        encLog(`Error${payload.category ? ` (${payload.category})` : ''}: ${payload.message}`, 'error', payload.serverId);
    } else encLog(`Error: ${payload}`, 'error');
});
ipcRenderer.on('encoder-warn', (e, payload) => {
    if (payload && typeof payload === 'object') encLog(`Aviso: ${payload.message}`, 'warn', payload.serverId);
    else encLog(`Aviso: ${payload}`, 'warn');
});
ipcRenderer.on('encoder-prefs-warning', (e, message) => {
    if (message) encLog(`Aviso de credenciales: ${message}`, 'warn');
});
ipcRenderer.on('encoder-input-meter', (e, report) => updateInputMeter(report));
ipcRenderer.on('encoder-capture-health', (e, report) => {
    if (report && report.reason === 'chunk-gap') encLog(`Aviso captura: pausa ${Math.round(report.gapMs || 0)} ms entre bloques PCM.`, 'warn');
});
ipcRenderer.on('audio-engine-rust-event', (e, message) => {
    if (!message || message.type !== 'status') return;
    updateInputMeterFromRustStatus(message);
});

// ── Init ─────────────────────────────────────────────────────────────────────
const configDir = getConfigDir(path.join(__dirname, '..', 'config'), __dirname);
const generalPrefsPath = path.join(configDir, 'general_settings.json');
let sysLang = 'es';
try {
    if (fs.existsSync(generalPrefsPath)) {
        const parsed = JSON.parse(fs.readFileSync(generalPrefsPath, 'utf-8'));
        if (parsed.language) sysLang = parsed.language;
    }
} catch(e) { console.warn('Error reading lang:', e); }

try {
    i18n.init(sysLang);
    i18n.applyToDOM();
    renderServers();
    resetInputMeter();
    encLog(i18n.t('encoder.log_ready'), 'info');
    if (prefsLoadWarning) encLog(i18n.t('encoder.warn_credentials') + `: ${prefsLoadWarning}`, 'warn');
} catch (err) {
    console.error(err);
    alert("CRITICAL ERROR: " + err.message);
}
