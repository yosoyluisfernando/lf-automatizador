const { ipcRenderer } = require('electron');

const COMMON_DEVICE_WORDS = new Set(['audio', 'speaker', 'speakers', 'altavoces', 'salida', 'via', 'spdif', 's', 'pdif', 'default', 'system', 'sistema']);

const stripDefs = [
    { key: 'pgm', label: 'MASTER', dest: 'AIR / STREAM' },
    { key: 'monitor', label: 'MON', dest: 'MONITORES' },
    { key: 'cue', label: 'CUE', dest: 'PREESCUCHA' },
    { key: 'jingle', label: 'JNG', dest: 'PISADORES / HORA' },
    { key: 'cartwall', label: 'CW', dest: 'BOTONERA' },
    { key: 'pl1', label: 'PL 1', dest: 'LINEA/AUXILIAR' },
    { key: 'pl2', label: 'PL 2', dest: 'LINEA/AUXILIAR' },
    { key: 'pl3', label: 'PL 3', dest: 'LINEA/AUXILIAR' },
    { key: 'pl4', label: 'PL 4', dest: 'LINEA/AUXILIAR' },
    { key: 'aux1', label: 'AUX 1', dest: 'PLAYLIST AUX' },
    { key: 'aux2', label: 'AUX 2', dest: 'PLAYLIST AUX' }
];

function meterId(key, channel) {
    return `vu-${key}-${channel}`;
}

function valueId(key) {
    return `val-${key}`;
}

function buildStripMarkup({ key, label, dest }) {
    return `
        <div class="channel-strip">
            <div class="meter-pair">
                <div class="meter-side">
                    <span class="meter-ch">L</span>
                    <div class="vu-meter-bg"><div id="${meterId(key, 'l')}" class="vu-fill" style="height: 100%;"></div></div>
                </div>
                <div class="meter-side">
                    <span class="meter-ch">R</span>
                    <div class="vu-meter-bg"><div id="${meterId(key, 'r')}" class="vu-fill" style="height: 100%;"></div></div>
                </div>
            </div>
            <span class="label">${label}</span>
            <span class="bus-dest">${dest}</span>
            <span class="bus-value" id="${valueId(key)}">-inf dB</span>
        </div>
    `;
}

const grid = document.getElementById('console-grid');
if (grid) {
    grid.innerHTML = stripDefs.map(buildStripMarkup).join('');
}

function formatDb(dbValue) {
    if (dbValue === Number.NEGATIVE_INFINITY || !Number.isFinite(dbValue)) return '-inf dB';
    return `${dbValue >= 0 ? '+' : ''}${dbValue.toFixed(1)} dB`;
}

function applyChannelLevel(key, channel, level) {
    const meter = document.getElementById(meterId(key, channel));
    const normalized = Math.max(0, Math.min(100, Math.round(level || 0)));

    if (meter) meter.style.height = `${100 - normalized}%`;
}

function readStereoPair(key, levels) {
    const stereo = levels?.stereo || {};
    if (key.startsWith('pl')) {
        const idx = parseInt(key.slice(2), 10) - 1;
        return Array.isArray(stereo.playlists) ? (stereo.playlists[idx] || { left: 0, right: 0 }) : { left: 0, right: 0 };
    }
    const pair = stereo[key];
    if (pair && Number.isFinite(pair.left) && Number.isFinite(pair.right)) return pair;

    const fallback = Math.max(0, Math.min(100, Math.round(levels?.[key] || 0)));
    return { left: fallback, right: fallback };
}

function readStereoDbPair(key, levels) {
    const stereoDbs = levels?.stereoDbs || {};
    if (key.startsWith('pl')) {
        const idx = parseInt(key.slice(2), 10) - 1;
        return Array.isArray(stereoDbs.playlists) ? (stereoDbs.playlists[idx] || { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY }) : { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY };
    }
    const pair = stereoDbs[key];
    if (pair && (pair.left !== undefined || pair.right !== undefined)) {
        return {
            left: pair.left ?? Number.NEGATIVE_INFINITY,
            right: pair.right ?? Number.NEGATIVE_INFINITY
        };
    }

    const fallbackDbs = levels?.dbs || {};
    if (key.startsWith('pl')) {
        const idx = parseInt(key.slice(2), 10) - 1;
        const dbValue = Array.isArray(fallbackDbs.playlists) ? fallbackDbs.playlists[idx] : Number.NEGATIVE_INFINITY;
        return { left: dbValue, right: dbValue };
    }
    const dbValue = fallbackDbs[key] ?? Number.NEGATIVE_INFINITY;
    return { left: dbValue, right: dbValue };
}

function readUnifiedDb(key, levels) {
    const dbs = levels?.dbs || {};
    if (key.startsWith('pl')) {
        const idx = parseInt(key.slice(2), 10) - 1;
        return Array.isArray(dbs.playlists) ? (dbs.playlists[idx] ?? Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY;
    }
    return dbs[key] ?? Number.NEGATIVE_INFINITY;
}

let currentLevels = {
    pgm: 0,
    monitor: 0,
    cue: 0,
    jingle: 0,
    cartwall: 0,
    playlists: [0, 0, 0, 0],
    stereo: {
        pgm: { left: 0, right: 0 },
        monitor: { left: 0, right: 0 },
        cue: { left: 0, right: 0 },
        jingle: { left: 0, right: 0 },
        cartwall: { left: 0, right: 0 },
        playlists: Array.from({ length: 4 }, () => ({ left: 0, right: 0 }))
    },
    dbs: {
        pgm: Number.NEGATIVE_INFINITY,
        monitor: Number.NEGATIVE_INFINITY,
        cue: Number.NEGATIVE_INFINITY,
        jingle: Number.NEGATIVE_INFINITY,
        cartwall: Number.NEGATIVE_INFINITY,
        playlists: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
    },
    stereoDbs: {
        pgm: { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY },
        monitor: { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY },
        cue: { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY },
        jingle: { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY },
        cartwall: { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY },
        playlists: Array.from({ length: 4 }, () => ({ left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY }))
    }
};
let rustDevicesRefreshInFlight = false;
let lastRustDevicesSignature = '';
let lastVuUpdateAt = 0;
let lastDiagnosticsRefreshAt = 0;
let vuDecayAnimationStarted = false;
const DIAGNOSTICS_REFRESH_INTERVAL_MS = 1000;
const VU_STALE_DECAY_AFTER_MS = 450;
const VU_DECAY_STEP = 6;
const RUST_METER_HOLD_MS = 700;
let lastRustMeterUpdateAt = 0;
let lastRustMeters = [];
let diagnosticsExpanded = localStorage.getItem('lf-console-diagnostics-expanded') === '1';

function rustMeterRawToVisualPercent(value) {
    const amp = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
    if (amp <= 0.0001) return 0;
    const db = 20 * Math.log10(amp);
    if (db < -36) return 0;
    if (db > 3) return 100;
    return ((db + 36) / 39) * 100;
}

function refreshMeters(levels = currentLevels) {
    stripDefs.forEach(({ key }) => {
        const stereoPair = readStereoPair(key, levels);
        applyChannelLevel(key, 'l', stereoPair.left);
        applyChannelLevel(key, 'r', stereoPair.right);
        const value = document.getElementById(valueId(key));
        if (value) value.innerText = formatDb(readUnifiedDb(key, levels));
    });
}

function rustMeterBusToStripKey(bus = '') {
    const normalized = String(bus || '').toLowerCase();
    if (normalized === 'master') return 'pgm';
    if (normalized === 'monitor') return 'monitor';
    if (normalized === 'cue') return 'cue';
    if (normalized === 'jingle' || normalized === 'jingles' || normalized === 'overlay') return 'jingle';
    if (normalized === 'cartwall') return 'cartwall';
    if (['pl1', 'pl2', 'pl3', 'pl4'].includes(normalized)) return normalized;
    if (['aux1', 'aux2'].includes(normalized)) return normalized;
    if (normalized === 'playlists') return 'pl1';
    return '';
}

function paintRustMetersToStrips(meters = []) {
    const byStrip = new Map();
    const playlistMode = currentLevels?.diagnostics?.devices?.playlistMode || 'disabled';
    meters.forEach(meter => {
        const stripKey = rustMeterBusToStripKey(meter?.bus);
        if (!stripKey) return;
        const rawLeft = Math.max(0, Math.min(100, Number(meter.left) || 0));
        const rawRight = Math.max(0, Math.min(100, Number(meter.right) || 0));
        const left = rustMeterRawToVisualPercent(rawLeft);
        const right = rustMeterRawToVisualPercent(rawRight);
        if (left <= 0 && right <= 0) return;
        const current = byStrip.get(stripKey) || { left: 0, right: 0, db: Number.NEGATIVE_INFINITY };
        const rawPeak = Math.max(rawLeft, rawRight);
        byStrip.set(stripKey, {
            left: Math.max(current.left, left),
            right: Math.max(current.right, right),
            db: Math.max(current.db, rawPeak > 0 ? 20 * Math.log10(rawPeak / 100) : Number.NEGATIVE_INFINITY)
        });
    });

    const hasExplicitMasterMeter = byStrip.has('pgm');
    if (!hasExplicitMasterMeter) {
        // El MASTER refleja TODOS los buses de programa que viajan al aire,
        // no solo las playlists. Esto coincide con `is_program_bus` del motor
        // Rust: master|jingle|cartwall|pl1..pl4. Sin esto, un pisador o una
        // locución de hora lanzada desde la botonera (bus 'jingle') o un
        // cartwall (bus 'cartwall') sonaba al aire pero no movía el medidor
        // del MASTER → falso "Detenido". Cuando playlistMode = 'independent',
        // las playlists tienen su propia salida y NO suman al master, pero
        // jingle/cartwall siempre sí (son pisadores sobre el programa).
        const buses = playlistMode === 'independent'
            ? ['jingle', 'cartwall', 'aux1', 'aux2']
            : ['jingle', 'cartwall', 'pl1', 'pl2', 'pl3', 'pl4', 'aux1', 'aux2'];
        const masterSum = buses.reduce((acc, key) => {
            const level = byStrip.get(key);
            if (!level) return acc;
            return {
                left: Math.max(acc.left, level.left),
                right: Math.max(acc.right, level.right),
                db: Math.max(acc.db, level.db)
            };
        }, { left: 0, right: 0, db: Number.NEGATIVE_INFINITY });
        if (masterSum.left > 0 || masterSum.right > 0) {
            byStrip.set('pgm', masterSum);
        }
    }

    byStrip.forEach((level, stripKey) => {
        applyChannelLevel(stripKey, 'l', level.left);
        applyChannelLevel(stripKey, 'r', level.right);
        const value = document.getElementById(valueId(stripKey));
        if (value) value.innerText = formatDb(level.db);
    });
    return byStrip.size;
}

function applyRustMetersToStrips(meters = [], { paint = true } = {}) {
    const painted = paint ? paintRustMetersToStrips(meters) : 0;
    if (Array.isArray(meters) && meters.length > 0) {
        lastRustMeters = meters;
        lastRustMeterUpdateAt = performance.now();
    }
    return painted;
}

function decayPercent(value) {
    return Math.max(0, Math.round((Number(value) || 0) - VU_DECAY_STEP));
}

function decayDb(value) {
    if (!Number.isFinite(value)) return Number.NEGATIVE_INFINITY;
    return value <= -90 ? Number.NEGATIVE_INFINITY : value - 3;
}

function decayStereoPair(pair = {}) {
    return {
        left: decayPercent(pair.left),
        right: decayPercent(pair.right)
    };
}

function decayStereoDbPair(pair = {}) {
    return {
        left: decayDb(pair.left),
        right: decayDb(pair.right)
    };
}

function decayVuLevels(levels = currentLevels) {
    const playlists = Array.isArray(levels.playlists) ? levels.playlists.map(decayPercent) : [0, 0, 0, 0];
    return {
        ...levels,
        pgm: decayPercent(levels.pgm),
        monitor: decayPercent(levels.monitor),
        cue: decayPercent(levels.cue),
        jingle: decayPercent(levels.jingle),
        cartwall: decayPercent(levels.cartwall),
        playlists,
        stereo: {
            ...(levels.stereo || {}),
            pgm: decayStereoPair(levels.stereo?.pgm),
            monitor: decayStereoPair(levels.stereo?.monitor),
            cue: decayStereoPair(levels.stereo?.cue),
            jingle: decayStereoPair(levels.stereo?.jingle),
            cartwall: decayStereoPair(levels.stereo?.cartwall),
            playlists: Array.isArray(levels.stereo?.playlists)
                ? levels.stereo.playlists.map(decayStereoPair)
                : Array.from({ length: 4 }, () => ({ left: 0, right: 0 }))
        },
        dbs: {
            ...(levels.dbs || {}),
            pgm: decayDb(levels.dbs?.pgm),
            monitor: decayDb(levels.dbs?.monitor),
            cue: decayDb(levels.dbs?.cue),
            jingle: decayDb(levels.dbs?.jingle),
            cartwall: decayDb(levels.dbs?.cartwall),
            playlists: Array.isArray(levels.dbs?.playlists)
                ? levels.dbs.playlists.map(decayDb)
                : [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
        },
        stereoDbs: {
            ...(levels.stereoDbs || {}),
            pgm: decayStereoDbPair(levels.stereoDbs?.pgm),
            monitor: decayStereoDbPair(levels.stereoDbs?.monitor),
            cue: decayStereoDbPair(levels.stereoDbs?.cue),
            jingle: decayStereoDbPair(levels.stereoDbs?.jingle),
            cartwall: decayStereoDbPair(levels.stereoDbs?.cartwall),
            playlists: Array.isArray(levels.stereoDbs?.playlists)
                ? levels.stereoDbs.playlists.map(decayStereoDbPair)
                : Array.from({ length: 4 }, () => ({ left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY }))
        }
    };
}

function refreshDiagnosticsThrottled(force = false) {
    const now = performance.now();
    if (!force && now - lastDiagnosticsRefreshAt < DIAGNOSTICS_REFRESH_INTERVAL_MS) return;
    lastDiagnosticsRefreshAt = now;
    refreshDiagnostics(currentLevels.diagnostics || {});
}

function animateStaleVuDecay() {
    const now = performance.now();
    if (now - lastRustMeterUpdateAt <= RUST_METER_HOLD_MS) {
        requestAnimationFrame(animateStaleVuDecay);
        return;
    }
    if (now - lastVuUpdateAt > VU_STALE_DECAY_AFTER_MS) {
        currentLevels = decayVuLevels(currentLevels);
        refreshMeters(currentLevels);
    }
    requestAnimationFrame(animateStaleVuDecay);
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
}

function renderLines(id, lines, className = '') {
    const el = document.getElementById(id);
    if (!el) return;
    const safeLines = Array.isArray(lines) && lines.length ? lines : ['Sin datos'];
    el.innerHTML = safeLines.map(line => `<div class="diag-line ${className}">${String(line)}</div>`).join('');
}

function renderSummaryLines(lines = []) {
    const el = document.getElementById('diag-summary');
    if (!el) return;
    const safeLines = Array.isArray(lines) && lines.length ? lines : ['Estado: sin datos'];
    el.innerHTML = safeLines.map(line => {
        const [label, ...rest] = String(line).split(':');
        const body = rest.join(':').trim();
        return `<div class="diag-summary-line"><strong>${label.trim()}:</strong> ${body}</div>`;
    }).join('');
}

function renderOperatorEngineState(state = {}) {
    const el = document.getElementById('operator-engine-state');
    if (!el) return;
    el.dataset.tone = state.tone || 'web';
    el.innerText = state.label || 'Motor al aire: Web Audio API';
}

function setDiagnosticsExpanded(expanded) {
    diagnosticsExpanded = !!expanded;
    localStorage.setItem('lf-console-diagnostics-expanded', diagnosticsExpanded ? '1' : '0');
    const detailGrid = document.getElementById('diag-detail-grid');
    const controls = document.getElementById('technical-controls');
    const button = document.getElementById('btn-toggle-diagnostics');
    if (detailGrid) detailGrid.classList.toggle('is-hidden', !diagnosticsExpanded);
    if (controls) controls.classList.toggle('is-hidden', !diagnosticsExpanded);
    if (button) button.innerText = diagnosticsExpanded ? 'Ocultar detalle' : 'Detalle tecnico';
}

function formatMixSeconds(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '-';
    return `${Math.round(numeric)}s`;
}

function formatMixGain(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '0.000';
    return numeric.toFixed(3);
}

function renderMixDiagnostics(mix = {}) {
    const players = Array.isArray(mix.players) ? mix.players : [];
    const activeLabel = mix.active
        ? `Mix ${mix.direction || 'A/B'} activo`
        : mix.phase === 'cola-fade'
            ? 'Cola de fade / salida pendiente'
            : mix.phase === 'single'
                ? 'Un solo player al aire'
                : 'Sin mezcla A/B';
    const lines = [
        activeLabel,
        `Referencia drift: ${mix.driftReferencePlayer || '-'}`,
        `Ignorar drift por mix: ${mix.shouldIgnoreDrift ? 'si' : 'no'}`
    ].concat(players.map(player => {
        const flags = [
            player.isOnAirReference ? 'ref' : '',
            player.isFading ? 'fade' : '',
            player.hasPendingStop ? 'stop-pend' : ''
        ].filter(Boolean).join(',');
        const title = player.title ? ` | ${player.title}` : '';
        const flagText = flags ? ` [${flags}]` : '';
        return `${player.id}: ${player.active ? 'play' : 'idle'} g=${formatMixGain(player.gain)} ${formatMixSeconds(player.currentTime)}/${formatMixSeconds(player.duration)}${flagText}${title}`;
    }));
    renderLines('diag-mix', lines, mix.active ? 'diag-warning' : '');
}

function buildRustPcmLiveMixPlan() {
    const mixPlayers = currentLevels?.diagnostics?.mix?.players;
    const plan = Array.isArray(mixPlayers) ? mixPlayers
        .filter(player => player?.path && (player.active || player.loaded))
        .map(player => ({
            player: player.id,
            path: player.path,
            gain: Number.isFinite(Number(player.gain)) ? Number(player.gain) : 1,
            positionMs: Math.max(0, Math.round((Number(player.currentTime) || 0) * 1000)),
            active: player.active !== false,
            title: player.title || ''
        })) : [];

    const livePlayers = currentLevels?.diagnostics?.players;
    const jinglePlayer = Array.isArray(livePlayers)
        ? livePlayers.find(player => player?.id === 'jingle-player' && player.active && player.path)
        : null;
    if (jinglePlayer) {
        plan.push({
            player: 'jingle-player',
            path: jinglePlayer.path,
            gain: 1,
            positionMs: Math.max(0, Math.round((Number(jinglePlayer.currentTime) || 0) * 1000)),
            active: true,
            title: 'jingle/pisador'
        });
    }

    const overlays = currentLevels?.diagnostics?.overlays || {};
    const cartwallSources = overlays.cartwallMode === 'master' && Array.isArray(overlays.cartwallSources)
        ? overlays.cartwallSources
        : [];
    cartwallSources.forEach((source, index) => {
        if (!source?.path) return;
        plan.push({
            player: source.id || `cartwall-${index + 1}`,
            path: source.path,
            gain: Number.isFinite(Number(source.gain)) ? Number(source.gain) : 1,
            positionMs: Math.max(0, Math.round((Number(source.currentTime) || 0) * 1000)),
            active: true,
            title: source.title || 'cartwall'
        });
    });

    const overlayDropSources = Array.isArray(overlays.overlayDropSources) ? overlays.overlayDropSources : [];
    overlayDropSources.forEach((source, index) => {
        if (!source?.path) return;
        plan.push({
            player: source.id || `overlay-${index + 1}`,
            path: source.path,
            gain: Number.isFinite(Number(source.gain)) ? Number(source.gain) : 1,
            positionMs: Math.max(0, Math.round((Number(source.currentTime) || 0) * 1000)),
            active: true,
            title: source.title || 'pisador'
        });
    });

    const seen = new Set();
    return plan.filter(item => {
        const key = `${item.player}|${item.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 8);
}

function renderFxDiagnostics(fx = {}) {
    const chain = Array.isArray(fx.chain) && fx.chain.length ? fx.chain.join(' -> ') : 'sin cadena';
    const active = Array.isArray(fx.activeModules) && fx.activeModules.length ? fx.activeModules.join(', ') : 'bypass';
    return [
        `FX master: ${fx.active ? 'activo' : 'bypass'}`,
        `Cadena: ${chain}`,
        `Activos: ${active}`,
        `EQ: ${fx.eq ? 'on' : 'off'} | AGC: ${fx.comp ? 'on' : 'off'} | Limitador: ${fx.limiter ? 'on' : 'off'}`,
        `Preamp: ${Number.isFinite(Number(fx.preampDb)) ? Number(fx.preampDb).toFixed(1) : '0.0'} dB | Pan: ${Number.isFinite(Number(fx.pan)) ? Number(fx.pan).toFixed(2) : '0.00'} | ${fx.mono ? 'MONO' : 'ESTEREO'}`,
        `Monitor actual: ${fx.monitorPath || 'post-FX'}`
    ];
}

function renderOverlayDiagnostics(overlays = {}, fx = {}) {
    renderLines('diag-overlays', renderFxDiagnostics(fx), fx.active ? 'diag-warning' : '');
}

function getRustProbeFromStatus(status = {}, fallback = {}) {
    return {
        available: !!(status.available || fallback.available),
        running: !!status.running,
        exePath: status.exePath || fallback.exePath || '',
        reportPath: status.reportPath || fallback.reportPath || '',
        lastStatus: status.lastStatus || fallback.lastStatus || null,
        lastDevices: status.lastDevices || fallback.lastDevices || null,
        lastError: status.lastError || fallback.lastError || ''
    };
}

function summarizeMonitor(latency = {}, fx = {}) {
    const monitorMs = latency.monitorMs ?? '-';
    const path = fx.monitorPath || 'post-FX';
    return `Monitor: ${path}, latencia estimada ${monitorMs} ms`;
}

function summarizePlayback(rustProbe = {}, mix = {}) {
    const title = rustProbe.lastStatus?.nowPlaying?.title || 'sin titulo';
    const transport = rustProbe.lastStatus?.transport || null;
    if (!transport) return `Reproduccion: ${title}`;
    const pos = Math.round((transport.positionMs || 0) / 1000);
    const dur = Math.round((transport.durationMs || 0) / 1000);
    const mixText = mix.active ? ' con mezcla A/B' : '';
    return `Reproduccion: ${transport.status || 'estado'} ${pos}s/${dur}s${mixText}`;
}

function summarizeEncoderSource(encoder = {}, rustEncoder = {}) {
    const state = encoder.active ? encoder : rustEncoder;
    const owner = state.owner || encoder.owner || 'none';
    const transport = state.transport || encoder.transport || 'ffmpeg';
    const format = state.captureFormat || encoder.captureFormat || state.source || 'sin fuente';
    const requested = state.requestedOwner || encoder.requestedOwner || owner;
    const fallback = state.fallbackReason || encoder.fallbackReason || '';
    const bridge = state.pcmBridgeReady === false && state.requestedOwner === 'rustAudioEngine'
        ? ` | tap ${state.pcmBridgeMode || 'planned'}`
        : '';
    const provider = requested && requested !== owner
        ? ` | solicitado ${requested}${fallback ? ` -> fallback ${owner}` : ''}`
        : '';
    return encoder.active
        ? `Encoder: activo | ${owner} -> ${transport} | ${format}${provider}${bridge}`
        : `Encoder: detenido | ${encoder.source && encoder.source !== 'sin fuente' ? encoder.source : 'sin fuente'}${rustEncoder.owner ? ` | Rust: ${rustEncoder.active ? 'activo' : 'detenido'}` : ''}`;
}

function resolveOperatorEngineState(diagnostics = {}, rustProbe = {}) {
    const encoder = diagnostics.encoder || {};
    const rustEncoder = rustProbe.lastStatus?.encoder || {};
    const state = encoder.active ? encoder : rustEncoder;
    const requestedOwner = state.requestedOwner || encoder.requestedOwner || '';
    const owner = state.owner || encoder.owner || '';
    const captureProvider = state.captureProvider || encoder.captureProvider || owner;
    const provider = String(state.encoderProvider || encoder.encoderProvider || '').toLowerCase();
    const fallbackReason = state.fallbackReason || encoder.fallbackReason || '';
    const rustRequested = requestedOwner === 'rustAudioEngine'
        || provider === 'rust'
        || diagnostics.requestedMode === 'rustAudio';
    const rustCarryingAudio = state.active === true
        && (owner === 'rustAudioEngine' || captureProvider === 'rustAudioEngine')
        && state.pcmBridgeReady === true;
    const fellBackToWebAudio = rustRequested
        && state.active === true
        && (owner === 'webAudioRenderer' || captureProvider === 'webAudioRenderer');

    if (rustCarryingAudio) {
        return { tone: 'rust', label: 'Motor al aire: Rust PCM tap' };
    }
    if (diagnostics.runtime?.playlistOwner === 'rustAudioEngine') {
        return { tone: 'rust', label: 'Motor al aire: Rust dueño de Playlist A/B' };
    }
    if (diagnostics.runtime?.rustPlaylistOwnerRequested) {
        const reason = diagnostics.runtime.rustPlaylistOwnerFallbackReason
            ? ` (${diagnostics.runtime.rustPlaylistOwnerFallbackReason})`
            : '';
        return { tone: 'fallback', label: `Motor al aire: Web Audio API por fallback de Rust A/B${reason}` };
    }
    if (fellBackToWebAudio) {
        const suffix = fallbackReason ? ` (${fallbackReason})` : '';
        return { tone: 'fallback', label: `Motor al aire: Web Audio API por fallback de Rust${suffix}` };
    }
    if (rustRequested) {
        const hasPlayers = Array.isArray(rustProbe.lastStatus?.players) && rustProbe.lastStatus.players.length > 0;
        return {
            tone: hasPlayers ? 'rust' : 'fallback',
            label: hasPlayers
                ? 'Motor al aire: Rust con players activos'
                : 'Motor al aire: Rust solicitado, sin players activos'
        };
    }
    if (rustProbe.lastError) {
        return { tone: 'warn', label: `Motor al aire: Web Audio API, Rust con error` };
    }
    return { tone: 'web', label: 'Motor al aire: Web Audio API' };
}

function renderOperatorSummary({ diagnostics = {}, rustProbe = {}, activeMode = 'webAudio', requestedMode = 'webAudio', adapter = '' } = {}) {
    const latency = diagnostics.latency || {};
    const fx = diagnostics.fx || {};
    const mix = diagnostics.mix || {};
    const encoder = diagnostics.encoder || {};
    const rustEncoder = rustProbe.lastStatus?.encoder || {};
    const warnings = Array.isArray(diagnostics.warnings) ? diagnostics.warnings : [];
    const rustState = rustProbe.running
        ? 'activo'
        : rustProbe.available || rustProbe.lastStatus
            ? 'disponible'
            : 'no disponible';
    const encoderLine = summarizeEncoderSource(encoder, rustEncoder);
    // El panel de resumen solo muestra datos del motor Rust.
    // Las latencias del AudioContext de Web Audio (masterMs/monitorMs/cueMs) no aplican al motor Rust.
    const lineaMotor = rustProbe.running
        ? activeMode === 'webAudio'
            ? `Motor Rust: en línea | AVISO: WebAudio aún activo como motor de audio`
            : `Motor Rust: en línea`
        : activeMode === 'webAudio'
            ? `Motor Rust: ${rustState} | AVISO: WebAudio activo (Rust no disponible)`
            : `Motor Rust: ${rustState}`;

    const summary = [
        lineaMotor,
        encoderLine,
        summarizePlayback(rustProbe, mix),
        `Avisos: ${warnings.length ? warnings.join(' | ') : 'sin errores nuevos'}`
    ].filter(Boolean);
    renderSummaryLines(summary);
}

function formatDeviceLine(device) {
    if (!device) return '';
    const suffix = device.isDefault ? ' (default)' : '';
    return `${device.indexId || device.id || 'output'}: ${device.name || 'sin nombre'}${suffix}`;
}

function escapeAttr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function getSelectedRustOutputId() {
    const select = document.getElementById('rust-output-select');
    return select?.value || 'default';
}

function getRustBusOutputId(status = {}, busId = '') {
    const bus = Array.isArray(status.buses) ? status.buses.find(item => item.id === busId) : null;
    return bus?.outputDeviceId || 'default';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function refreshRustDiagnosticsFromStatus(fallback = {}) {
    const liveResult = await ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'status' });
    const status = await ipcRenderer.invoke('audio-engine-rust-status');
    const liveStatus = liveResult?.message?.type === 'status'
        ? liveResult.message
        : status?.lastStatus || fallback.lastStatus || null;
    const nextDiagnostics = {
        ...(currentLevels.diagnostics || {}),
        rustAvailable: true,
        rustProbe: getRustProbeFromStatus({
            ...status,
            lastStatus: liveStatus
        }, {
            available: true,
            ...fallback
        })
    };
    currentLevels = { ...currentLevels, diagnostics: nextDiagnostics };
    refreshDiagnostics(nextDiagnostics);
    return status;
}

async function invokeAudioEngineContract(type, payload = {}) {
    const response = await ipcRenderer.invoke('audio-engine-command', { type, payload });
    if (response?.success !== true) throw new Error(response?.error || `AudioEngineClient no respondio a ${type}.`);
    if (response?.result?.ok !== true) {
        throw new Error(response?.result?.error || response?.error || `AudioEngineClient rechazo ${type}.`);
    }

    // Puerta de acceso: la consola es exclusiva del motor Rust.
    // Si WebAudio respondió a un comando de la consola, se registra el acceso en el reporte.
    const modoRespuesta = response?.diagnostics?.activeMode || '';
    const adapterRespuesta = response?.diagnostics?.adapter || '';
    if (modoRespuesta === 'webAudio' || adapterRespuesta.includes('WebAudio')) {
        ipcRenderer.send('log-web-audio-acceso-consola', {
            origen: 'consola.invokeAudioEngineContract',
            comando: type,
            adapter_detectado: adapterRespuesta || 'WebAudioEngineAdapter',
            motivo_rechazo: 'La consola de audio virtual es exclusiva del motor Rust'
        });
    }

    if (response?.diagnostics) {
        currentLevels = { ...currentLevels, diagnostics: response.diagnostics };
        refreshDiagnostics(response.diagnostics);
    }
    return response;
}

function refreshRustOutputSelect(outputs = [], defaultOutput = '') {
    const select = document.getElementById('rust-output-select');
    if (!select) return;
    const previous = select.value || 'default';
    const options = [{ value: 'default', label: `Rust: default${defaultOutput ? ` (${defaultOutput})` : ''}` }]
        .concat(outputs.map((device, index) => ({
            value: device.id || device.indexId || `output:${index}`,
            label: `${device.name || `Salida ${index + 1}`}${device.isDefault ? ' *' : ''}`
        })));
    select.innerHTML = options
        .map(option => `<option value="${escapeAttr(option.value)}">${escapeAttr(option.label)}</option>`)
        .join('');
    select.value = options.some(option => option.value === previous) ? previous : 'default';
}

function buildRustDevicesSignature(devices = {}) {
    const outputs = Array.isArray(devices.outputs) ? devices.outputs : [];
    return JSON.stringify({
        host: devices.host || '',
        defaultOutputId: devices.defaultOutputId || '',
        outputs: outputs.map(output => [output.id || '', output.name || '', !!output.isDefault])
    });
}

function isRustAudioBusy() {
    const status = currentLevels?.diagnostics?.rustProbe?.lastStatus || null;
    if (!status) return false;
    if (Array.isArray(status.activeOutputs) && status.activeOutputs.length > 0) return true;
    if (Array.isArray(status.players)) {
        return status.players.some(player => {
            if (!player) return false;
            if (player.audioReady) return true;
            return ['playing', 'paused', 'loaded'].includes(player.status);
        });
    }
    return status.labPlayback === true;
}

async function refreshRustDevices({ force = false, source = 'auto' } = {}) {
    if (!force && isRustAudioBusy()) return { skipped: true, reason: 'rust-audio-busy' };
    if (rustDevicesRefreshInFlight) return null;
    rustDevicesRefreshInFlight = true;
    try {
        const result = await ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'devices' });
        if (result?.success !== true) throw new Error(result?.error || 'Rust no pudo listar salidas.');
        const status = await ipcRenderer.invoke('audio-engine-rust-status');
        const devices = status?.lastDevices || result.message || {};
        const signature = buildRustDevicesSignature(devices);
        const changed = signature !== lastRustDevicesSignature;
        if (changed || force) {
            lastRustDevicesSignature = signature;
            const nextDiagnostics = {
                ...(currentLevels.diagnostics || {}),
                rustAvailable: true,
                rustProbe: getRustProbeFromStatus(status, {
                    available: true,
                    lastDevices: devices
                })
            };
            currentLevels = { ...currentLevels, diagnostics: nextDiagnostics };
            refreshDiagnostics(nextDiagnostics);
            if (changed && source !== 'startup') {
                setText('diag-updated', `Rust salidas actualizadas: ${(devices.outputs || []).length}`);
            }
        }
        return { result, status, devices, changed };
    } catch (err) {
        if (force) setText('diag-updated', err.message || String(err));
        return { error: err };
    } finally {
        rustDevicesRefreshInFlight = false;
    }
}

function normalizeAudioConfig(config = {}) {
    const main = config.outMain || 'default';
    const monitor = config.outMonitor || main;
    const cue = config.outCue || main;
    const sharedPlaylist = config.playlistSharedDevice || monitor || main;
    const playlistOutputs = Array.isArray(config.playlistOutputs)
        ? Array.from({ length: 4 }, (_, idx) => config.playlistOutputs[idx] || sharedPlaylist)
        : [sharedPlaylist, sharedPlaylist, sharedPlaylist, sharedPlaylist];
    return {
        ...config,
        outMain: main,
        outMonitor: monitor,
        outCue: cue,
        outCartwall: config.outCartwall || main,
        monitorEnabled: config.monitorEnabled === true,
        playlistOutputMode: ['shared', 'independent', 'disabled'].includes(config.playlistOutputMode) ? config.playlistOutputMode : 'disabled',
        playlistSharedDevice: sharedPlaylist,
        playlistOutputs,
        cartwallOutputMode: ['master', 'monitor', 'cue', 'device'].includes(config.cartwallOutputMode) ? config.cartwallOutputMode : 'master'
    };
}

function labelTokens(value = '') {
    return String(value)
        .toLowerCase()
        .replace(/[\[\]\(\)\{\}_-]+/g, ' ')
        .replace(/[^a-z0-9áéíóúüñ]+/gi, ' ')
        .split(/\s+/)
        .filter(token => token.length > 2 && !COMMON_DEVICE_WORDS.has(token));
}

function scoreLabelMatch(a = '', b = '') {
    const aTokens = new Set(labelTokens(a));
    const bTokens = new Set(labelTokens(b));
    if (!aTokens.size || !bTokens.size) return 0;
    let hits = 0;
    aTokens.forEach(token => { if (bTokens.has(token)) hits++; });
    return hits / Math.max(aTokens.size, bTokens.size);
}

function resolveRustOutputForDevice(deviceId, rustDevices = {}, browserOutputs = []) {
    const requested = deviceId || 'default';
    const rustOutputs = Array.isArray(rustDevices.outputs) ? rustDevices.outputs : [];
    if (requested === 'default') return {
        id: 'default',
        name: rustDevices.defaultOutput || 'default',
        confidence: 'default'
    };
    const exact = rustOutputs.find(output => output.id === requested || output.indexId === requested || output.name === requested);
    if (exact) return { id: exact.id || exact.indexId || 'default', name: exact.name || exact.id, confidence: 'exact' };

    const browserDevice = browserOutputs.find(device => device.deviceId === requested);
    const browserLabel = browserDevice?.label || '';
    let best = null;
    rustOutputs.forEach(output => {
        const score = scoreLabelMatch(browserLabel, output.name || '');
        if (!best || score > best.score) best = { output, score };
    });
    if (best && best.score >= 0.34) {
        return {
            id: best.output.id || best.output.indexId || 'default',
            name: best.output.name || best.output.id,
            confidence: `label ${Math.round(best.score * 100)}%`,
            browserLabel
        };
    }
    return {
        id: 'default',
        name: rustDevices.defaultOutput || 'default',
        confidence: browserLabel ? `fallback: ${browserLabel}` : 'fallback'
    };
}

function buildConfiguredRustRoutePlan(config = {}, rustDevices = {}, browserOutputs = []) {
    const prefs = normalizeAudioConfig(config);
    const planned = [
        { role: 'master', label: 'Master', deviceId: prefs.outMain },
        { role: 'jingle', label: 'Jingles/Pisadores', deviceId: prefs.outMain }
    ];
    if (prefs.monitorEnabled) planned.push({ role: 'monitor', label: 'Monitor', deviceId: prefs.outMonitor });
    planned.push({ role: 'cue', label: 'Cue', deviceId: prefs.outCue });

    const cartwallDevice = prefs.cartwallOutputMode === 'monitor'
        ? prefs.outMonitor
        : prefs.cartwallOutputMode === 'cue'
            ? prefs.outCue
            : prefs.cartwallOutputMode === 'device'
                ? prefs.outCartwall
                : prefs.outMain;
    planned.push({ role: 'cartwall', label: `Cartwall ${prefs.cartwallOutputMode}`, deviceId: cartwallDevice });

    if (prefs.playlistOutputMode === 'shared') {
        [1, 2, 3, 4].forEach(idx => planned.push({ role: `pl${idx}`, label: `Playlist ${idx} compartida`, deviceId: prefs.playlistSharedDevice }));
    } else if (prefs.playlistOutputMode === 'independent') {
        prefs.playlistOutputs.forEach((deviceId, idx) => planned.push({ role: `pl${idx + 1}`, label: `Playlist ${idx + 1}`, deviceId }));
    }

    return planned.map(item => ({
        ...item,
        rust: resolveRustOutputForDevice(item.deviceId, rustDevices, browserOutputs)
    }));
}

function groupRoutePlanByRustOutput(plan = []) {
    const groups = new Map();
    plan.forEach(item => {
        const key = item.rust?.id || 'default';
        if (!groups.has(key)) groups.set(key, { outputId: key, outputName: item.rust?.name || key, roles: [], confidence: item.rust?.confidence || '' });
        groups.get(key).roles.push(item.label);
    });
    return Array.from(groups.values());
}

function formatReportEntry(entry) {
    if (!entry) return '';
    if (entry.raw) return entry.raw;
    const time = entry.at ? new Date(entry.at).toLocaleTimeString() : '';
    if (entry.type === 'command') return `${time} cmd ${entry.command?.cmd || ''}`.trim();
    if (entry.type === 'message') {
        const msg = entry.message || {};
        if (msg.type === 'status') return `${time} status ${msg.players?.length || 0} players`.trim();
        if (msg.type === 'devices') return `${time} devices ${msg.outputs?.length || 0} salidas`.trim();
        if (msg.type === 'error') return `${time} error ${msg.message || ''}`.trim();
        return `${time} message ${msg.type || ''}`.trim();
    }
    if (entry.error) return `${time} ${entry.type || 'error'} ${entry.error}`.trim();
    return `${time} ${entry.type || 'evento'}`.trim();
}

async function getBrowserAudioOutputs() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(device => device.kind === 'audiooutput');
    } catch (err) {
        return [];
    }
}

async function refreshReportTail() {
    try {
        const result = await ipcRenderer.invoke('audio-engine-report-tail', 10);
        if (result?.success !== true) {
            renderLines('diag-report', [result?.error || 'Reporte no disponible'], 'diag-warning');
            return;
        }
        const lines = (result.entries || []).map(formatReportEntry).filter(Boolean);
        renderLines('diag-report', lines);
    } catch (err) {
        renderLines('diag-report', [err.message || String(err)], 'diag-warning');
    }
}

function refreshDiagnostics(diagnostics = {}) {
    const activeMode = diagnostics.activeMode || diagnostics.mode || 'webAudio';
    const requestedMode = diagnostics.requestedMode || activeMode;
    const adapter = diagnostics.adapter || 'WebAudioEngineAdapter';
    const rustProbe = diagnostics.rustProbe || {};
    const rustAvailable = !!(diagnostics.rustAvailable || rustProbe.available || rustProbe.running || rustProbe.lastStatus);
    const rustLabel = rustAvailable ? (rustProbe.running ? 'Rust probe: activo' : 'Rust probe: disponible') : 'Rust probe: no disponible';
    // Etiqueta del motor: enfocada en Rust. WebAudio aparece solo como advertencia de migración.
    const etiquetaMotor = rustProbe.running
        ? `Motor Rust: en línea | ${rustLabel}`
        : activeMode === 'webAudio'
            ? `${rustLabel} | Fallback WebAudio activo`
            : `${rustLabel}`;
    setText('diag-engine', etiquetaMotor);
    renderOperatorEngineState(resolveOperatorEngineState(diagnostics, rustProbe));
    setText('diag-updated', diagnostics.updatedAt ? new Date(diagnostics.updatedAt).toLocaleTimeString() : 'Diagnostico activo');
    renderOperatorSummary({ diagnostics, rustProbe, activeMode, requestedMode, adapter });
    renderMixDiagnostics(diagnostics.mix || {});
    renderOverlayDiagnostics(diagnostics.overlays || {}, diagnostics.fx || {});

    const players = Array.isArray(diagnostics.players) ? diagnostics.players : [];
    const rustBuses = Array.isArray(rustProbe.lastStatus?.buses) ? rustProbe.lastStatus.buses : [];
    const rustMeters = Array.isArray(rustProbe.lastStatus?.meters) ? rustProbe.lastStatus.meters : [];
    applyRustMetersToStrips(rustMeters, { paint: false });
    const playerLines = players
        .filter(player => player.active || player.loaded || player.count)
        .map(player => {
            const state = player.count !== undefined ? `${player.count}` : (player.active ? 'activo' : 'cargado');
            const sink = player.sink ? ` -> ${player.sink}` : '';
            return `${player.id}: ${state}${sink}`;
        })
        .concat(rustMeters
            .filter(meter => (meter.left || meter.right) > 0)
            .map(meter => {
                const rawPeak = Math.max(Number(meter.left) || 0, Number(meter.right) || 0);
                const visualPeak = rustMeterRawToVisualPercent(rawPeak);
                return `rust meter ${meter.id}: ${Math.round(visualPeak)}% visual (${Math.round(rawPeak)}% real)`;
            }));
    renderLines('diag-players', playerLines);
    renderLines('diag-rust-buses', rustBuses.map(bus => `${bus.id} -> ${bus.outputDeviceName || bus.outputDeviceId || 'default'}`));

    const devices = diagnostics.devices || {};
    const rustDevices = rustProbe.lastDevices || {};
    const rustOutputs = Array.isArray(rustDevices.outputs) ? rustDevices.outputs : [];
    refreshRustOutputSelect(rustOutputs, rustDevices.defaultOutput || '');
    const routeLines = [
        `Master: ${devices.main || 'default'}`,
        `Monitor: ${devices.monitor || 'default'}`,
        `Cue: ${devices.cue || 'default'}`,
        `Cartwall: ${devices.cartwall || 'default'}`,
        `Playlists: ${devices.playlistMode || 'disabled'}`,
        `Rust host: ${rustDevices.host || 'sin consultar'}`,
        `Rust hosts disponibles: ${rustDevices.availableHosts || '-'}`,
        `Rust default: ${rustDevices.defaultOutput || 'sin consultar'}`,
        `Rust salidas: ${rustOutputs.length}`,
        `Reporte: ${rustProbe.reportPath || 'config/audio_engine_report.jsonl'}`
    ].concat(rustOutputs.slice(0, 4).map(formatDeviceLine));
    renderLines('diag-routes', routeLines);

    const latency = diagnostics.latency || {};
    const latencyLines = [
        `Master: ${latency.masterMs ?? 0} ms`,
        `Monitor: ${latency.monitorMs ?? '-'} ms`,
        `Cue: ${latency.cueMs ?? '-'} ms`
    ];
    if (latency.note) latencyLines.push(latency.note);
    if (rustProbe.lastStatus?.engine) latencyLines.push(`Rust: ${rustProbe.lastStatus.engine} ${rustProbe.lastStatus.version || ''}`.trim());
    if (rustProbe.lastStatus?.nowPlaying?.title) latencyLines.push(`Rust now: ${rustProbe.lastStatus.nowPlaying.title}`);
    if (rustProbe.lastStatus?.transport) {
        const t = rustProbe.lastStatus.transport;
        const pos = Math.round((t.positionMs || 0) / 1000);
        const dur = Math.round((t.durationMs || 0) / 1000);
        latencyLines.push(`Rust transport: ${t.status || 'unknown'} ${pos}s/${dur}s`);
        if (t.mixActive || t.mixPhase) {
            const mixDirection = t.mixDirection ? ` ${t.mixDirection}` : '';
            latencyLines.push(`Rust mix: ${t.mixPhase || 'mix'}${mixDirection}`);
        }
    }
    if (rustProbe.lastStatus?.encoder) {
        const encoderState = rustProbe.lastStatus.encoder;
        const rate = Number(encoderState.bitrateKbps) > 0 ? ` | ${Number(encoderState.bitrateKbps).toFixed(0)} kbps` : '';
        const speed = Number(encoderState.speed) > 0 ? ` | ${Number(encoderState.speed).toFixed(2)}x` : '';
        const gaps = Number(encoderState.gapWarnings) > 0 ? ` | gaps ${encoderState.gapWarnings}` : '';
        const requested = encoderState.requestedOwner && encoderState.requestedOwner !== encoderState.owner
            ? ` | solicitado ${encoderState.requestedOwner}`
            : '';
        const fallback = encoderState.fallbackReason ? ` | fallback ${encoderState.fallbackReason}` : '';
        latencyLines.push(`Rust encoder: ${encoderState.active ? 'activo' : 'detenido'} | ${encoderState.owner || '-'} | ${encoderState.captureFormat || '-'} ${encoderState.sampleRate || ''}${rate}${speed}${gaps}${requested}${fallback}`.trim());
        if (encoderState.requestedOwner === 'rustAudioEngine' && encoderState.pcmBridgeReady !== true) {
            const bridgeMode = encoderState.pcmBridgeMode || 'planned';
            const bridgeReason = encoderState.pcmBridgeReason || encoderState.fallbackReason || 'rust-master-pcm-pending';
            latencyLines.push(`Rust PCM tap: ${bridgeMode} | ${bridgeReason}`);
        }
    }
    if (rustProbe.lastError) latencyLines.push(`Rust error: ${rustProbe.lastError}`);
    const warnings = Array.isArray(diagnostics.warnings) ? diagnostics.warnings : [];
    renderLines('diag-latency', latencyLines.concat(warnings), warnings.length ? 'diag-warning' : '');
    if (diagnosticsExpanded) refreshReportTail();
}

ipcRenderer.on('update-vu', (e, levels) => {
    currentLevels = levels || currentLevels;
    lastVuUpdateAt = performance.now();
    refreshMeters();
    const rustMeters = Array.isArray(currentLevels?.rustMeters) && currentLevels.rustMeters.length > 0
        ? currentLevels.rustMeters
        : currentLevels?.diagnostics?.rustProbe?.lastStatus?.meters;
    if (Array.isArray(rustMeters) && rustMeters.length > 0) {
        applyRustMetersToStrips(rustMeters, { paint: true });
    }
    refreshDiagnosticsThrottled();
});

// FASE EXTRA — Vúmetros en tiempo real desde el push directo del motor Rust.
// Cada ~100 ms el motor emite un mensaje `status` con el array `meters`. Lo
// recibimos sin pasar por el renderer principal — eso elimina el retraso
// perceptual que reportó el operador. Pintamos los strips de inmediato y
// guardamos los meters en `currentLevels.rustMeters` para que otros consumers
// los vean también.
ipcRenderer.on('audio-engine-rust-event', (e, message) => {
    if (!message || message.type !== 'status') return;
    const rustMeters = Array.isArray(message.meters) ? message.meters : null;
    if (rustMeters && rustMeters.length > 0) {
        lastVuUpdateAt = performance.now();
        applyRustMetersToStrips(rustMeters, { paint: true });
        // Mantenemos el cache para que `refreshMeters`/`refreshDiagnostics`
        // siguientes vean datos frescos del motor Rust.
        if (!currentLevels) currentLevels = {};
        currentLevels.rustMeters = rustMeters;
        currentLevels.rustMetersUpdatedAt = message.updatedAt || Date.now();
    }
});

if (!vuDecayAnimationStarted) {
    vuDecayAnimationStarted = true;
    lastVuUpdateAt = performance.now();
    requestAnimationFrame(animateStaleVuDecay);
}

const rustProbeButton = document.getElementById('btn-rust-probe');
if (rustProbeButton) {
    rustProbeButton.addEventListener('click', async () => {
        rustProbeButton.disabled = true;
        rustProbeButton.innerText = 'Probando...';
        try {
            const sequence = [
                { cmd: 'status' },
                { cmd: 'devices' },
                { cmd: 'load', player: 'probe', path: 'diagnostico://rust-probe' },
                { cmd: 'play', player: 'probe' },
                { cmd: 'pause', player: 'probe' },
                { cmd: 'stop', player: 'probe' }
            ];
            let result = null;
            for (const command of sequence) {
                result = await ipcRenderer.invoke('audio-engine-rust-command', command);
                if (result?.success !== true) break;
            }
            const status = await ipcRenderer.invoke('audio-engine-rust-status');
            const ok = result?.success === true && !!(status?.available || status?.running || status?.lastStatus);
            const nextDiagnostics = {
                ...(currentLevels.diagnostics || {}),
                rustAvailable: ok,
                rustProbe: {
                    ...getRustProbeFromStatus(status, {
                        available: ok,
                        lastStatus: result?.status || result?.message || null,
                        lastError: result?.error || ''
                    })
                }
            };
            currentLevels = { ...currentLevels, diagnostics: nextDiagnostics };
            refreshDiagnostics(nextDiagnostics);
            rustProbeButton.innerText = ok ? 'Rust OK' : 'Rust error';
            setText('diag-updated', ok ? 'Rust probe completo: load/play/pause/stop' : (result?.error || status?.lastError || 'Rust no respondio'));
        } catch (err) {
            rustProbeButton.innerText = 'Rust error';
            setText('diag-updated', err.message || String(err));
        } finally {
            setTimeout(() => {
                rustProbeButton.disabled = false;
                rustProbeButton.innerText = 'Probar Rust';
            }, 1800);
        }
    });
}

const rustDevicesButton = document.getElementById('btn-rust-devices');
if (rustDevicesButton) {
    rustDevicesButton.addEventListener('click', async () => {
        rustDevicesButton.disabled = true;
        rustDevicesButton.innerText = 'Listando...';
        try {
            const refreshed = await refreshRustDevices({ force: true, source: 'manual' });
            if (refreshed?.error) throw refreshed.error;
            rustDevicesButton.innerText = 'Salidas OK';
            setText('diag-updated', `Rust salidas: ${(refreshed?.devices?.outputs || []).length} | Host: ${refreshed?.devices?.host || '-'}`);
        } catch (err) {
            rustDevicesButton.innerText = 'Error salidas';
            setText('diag-updated', err.message || String(err));
        } finally {
            setTimeout(() => {
                rustDevicesButton.disabled = false;
                rustDevicesButton.innerText = 'Salidas Rust';
            }, 1800);
        }
    });
}

setTimeout(() => refreshRustDevices({ force: true, source: 'startup' }), 500);
setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    refreshRustDevices({ source: 'interval' });
}, 60000);
ipcRenderer.on('settings-updated', () => refreshRustDevices({ force: true, source: 'settings' }));

const rustLabButton = document.getElementById('btn-rust-lab-play');
if (rustLabButton) {
    rustLabButton.addEventListener('click', async () => {
        rustLabButton.disabled = true;
        rustLabButton.innerText = 'Elige audio...';
        try {
            const filePath = await ipcRenderer.invoke('dialog:openFile');
            if (!filePath) {
                rustLabButton.innerText = 'Lab audio Rust';
                return;
            }
            const outputId = getSelectedRustOutputId();
            rustLabButton.innerText = 'Rust sonando...';
            setText('diag-updated', `Rust lab: reproduciendo 5 segundos por ${outputId === 'default' ? 'salida default' : 'salida seleccionada'}`);
            let result = await ipcRenderer.invoke('audio-engine-rust-command', {
                cmd: 'labPlay',
                player: 'lab',
                path: filePath,
                gain: 0.65,
                outputId
            });
            if (result?.success !== true) throw new Error(result?.error || 'Rust lab no pudo reproducir.');
            await new Promise(resolve => setTimeout(resolve, 5000));
            result = await ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'stop', player: 'lab' });
            const status = await ipcRenderer.invoke('audio-engine-rust-status');
            const nextDiagnostics = {
                ...(currentLevels.diagnostics || {}),
                rustAvailable: true,
                rustProbe: {
                    ...getRustProbeFromStatus(status, {
                        available: true,
                        lastStatus: result?.status || result?.message || null,
                        lastError: result?.error || ''
                    })
                }
            };
            currentLevels = { ...currentLevels, diagnostics: nextDiagnostics };
            refreshDiagnostics(nextDiagnostics);
            rustLabButton.innerText = 'Rust OK';
            setText('diag-updated', 'Rust lab completo: audio reproducido y detenido');
        } catch (err) {
            rustLabButton.innerText = 'Rust error';
            setText('diag-updated', err.message || String(err));
        } finally {
            setTimeout(() => {
                rustLabButton.disabled = false;
                rustLabButton.innerText = 'Lab audio Rust';
            }, 1800);
        }
    });
}

const rustPreviewSafeButton = document.getElementById('btn-rust-preview-safe');
if (rustPreviewSafeButton) {
    rustPreviewSafeButton.addEventListener('click', async () => {
        rustPreviewSafeButton.disabled = true;
        rustPreviewSafeButton.innerText = 'Elige audio...';
        const player = 'preview-player';
        let previousCueOutputId = 'default';
        try {
            const filePath = await ipcRenderer.invoke('dialog:openFile');
            if (!filePath) {
                rustPreviewSafeButton.innerText = 'Preview Rust';
                return;
            }

            const beforeStatus = await ipcRenderer.invoke('audio-engine-rust-status');
            previousCueOutputId = getRustBusOutputId(beforeStatus?.lastStatus, 'cue');
            const outputId = getSelectedRustOutputId();
            const outputLabel = outputId === 'default' ? 'salida default' : 'salida seleccionada';

            rustPreviewSafeButton.innerText = 'Preview...';
            setText('diag-updated', `Preview Rust: cue por ${outputLabel}, volumen bajo`);

            let result = await ipcRenderer.invoke('audio-engine-rust-command', {
                cmd: 'route',
                bus: 'cue',
                outputId
            });
            if (result?.success !== true) throw new Error(result?.error || 'Rust no pudo enrutar cue.');

            result = await ipcRenderer.invoke('audio-engine-rust-command', {
                cmd: 'labPlay',
                player,
                bus: 'cue',
                path: filePath,
                gain: 0.32
            });
            if (result?.success !== true) throw new Error(result?.error || 'Rust preview no pudo reproducir.');

            for (let tick = 1; tick <= 8; tick++) {
                await sleep(500);
                await refreshRustDiagnosticsFromStatus();
                setText('diag-updated', `Preview Rust: ${(tick / 2).toFixed(1)}/4 s por ${outputLabel}`);
            }

            await ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'stop', player });
            await ipcRenderer.invoke('audio-engine-rust-command', {
                cmd: 'route',
                bus: 'cue',
                outputId: previousCueOutputId || 'default'
            });
            await refreshRustDiagnosticsFromStatus();
            rustPreviewSafeButton.innerText = 'Preview OK';
            setText('diag-updated', 'Preview Rust completo: player detenido y ruta cue restaurada');
        } catch (err) {
            try { await ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'stop', player }); } catch (stopErr) {}
            try {
                await ipcRenderer.invoke('audio-engine-rust-command', {
                    cmd: 'route',
                    bus: 'cue',
                    outputId: previousCueOutputId || 'default'
                });
            } catch (routeErr) {}
            rustPreviewSafeButton.innerText = 'Preview error';
            setText('diag-updated', err.message || String(err));
        } finally {
            setTimeout(() => {
                rustPreviewSafeButton.disabled = false;
                rustPreviewSafeButton.innerText = 'Preview Rust';
            }, 1800);
        }
    });
}

const rustRoutingMapButton = document.getElementById('btn-rust-routing-map');
if (rustRoutingMapButton) {
    rustRoutingMapButton.addEventListener('click', async () => {
        rustRoutingMapButton.disabled = true;
        rustRoutingMapButton.innerText = 'Mapeando...';
        const startedPlayers = [];
        try {
            const configResult = await ipcRenderer.invoke('audio-routing-config');
            if (configResult?.success !== true) throw new Error(configResult?.error || 'No se pudo leer configuracion de salidas.');

            const devicesResult = await ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'devices' });
            if (devicesResult?.success !== true) throw new Error(devicesResult?.error || 'Rust no pudo listar salidas.');
            const rustDevices = devicesResult.message || {};
            const browserOutputs = await getBrowserAudioOutputs();
            const plan = buildConfiguredRustRoutePlan(configResult.config || {}, rustDevices, browserOutputs);
            const groups = groupRoutePlanByRustOutput(plan);
            const mapLines = groups.map(group => `${group.roles.join('+')} -> ${group.outputName} (${group.confidence})`);
            renderLines('diag-latency', mapLines.length ? mapLines : ['Sin rutas configuradas']);

            for (const item of plan) {
                const routeResult = await ipcRenderer.invoke('audio-engine-rust-command', {
                    cmd: 'route',
                    bus: item.role,
                    outputId: item.rust?.id || 'default'
                });
                if (routeResult?.success !== true) throw new Error(routeResult?.error || `Fallo ruta ${item.label}`);
            }

            const filePath = await ipcRenderer.invoke('dialog:openFile');
            if (!filePath) {
                const status = await ipcRenderer.invoke('audio-engine-rust-status');
                const nextDiagnostics = {
                    ...(currentLevels.diagnostics || {}),
                    rustAvailable: true,
                    rustProbe: getRustProbeFromStatus(status, {
                        available: true,
                        lastDevices: rustDevices
                    })
                };
                currentLevels = { ...currentLevels, diagnostics: nextDiagnostics };
                refreshDiagnostics(nextDiagnostics);
                renderLines('diag-latency', mapLines);
                rustRoutingMapButton.innerText = 'Mapa listo';
                setText('diag-updated', `Rutas Rust registradas: ${plan.length} buses, ${groups.length} salidas`);
                return;
            }

            rustRoutingMapButton.innerText = 'Rust buses...';
            for (let idx = 0; idx < plan.length; idx++) {
                const item = plan[idx];
                const player = `route-map-${item.role}`;
                rustRoutingMapButton.innerText = `${idx + 1}/${plan.length}`;
                setText('diag-updated', `Mapa Rust: ${item.label}`);
                const result = await ipcRenderer.invoke('audio-engine-rust-command', {
                    cmd: 'labPlay',
                    player,
                    bus: item.role,
                    path: filePath,
                    gain: 0.35
                });
                if (result?.success !== true) throw new Error(result?.error || `Fallo ruta ${item.label}`);
                startedPlayers.push(player);

                const busEndsAt = Date.now() + 1200;
                while (Date.now() < busEndsAt) {
                    await refreshRustDiagnosticsFromStatus({ lastDevices: rustDevices });
                    await sleep(160);
                }

                await ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'stop', player });
            }
            startedPlayers.length = 0;
            const status = await ipcRenderer.invoke('audio-engine-rust-status');
            const nextDiagnostics = {
                ...(currentLevels.diagnostics || {}),
                rustAvailable: true,
                rustProbe: getRustProbeFromStatus(status, {
                    available: true,
                    lastDevices: rustDevices
                })
            };
            currentLevels = { ...currentLevels, diagnostics: nextDiagnostics };
            refreshDiagnostics(nextDiagnostics);
            renderLines('diag-latency', mapLines);
            rustRoutingMapButton.innerText = 'Mapa OK';
            setText('diag-updated', `Mapa Rust probado: ${plan.length} buses, ${groups.length} salidas unicas`);
        } catch (err) {
            for (const player of startedPlayers) {
                try { await ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'stop', player }); } catch (stopErr) {}
            }
            rustRoutingMapButton.innerText = 'Mapa error';
            setText('diag-updated', err.message || String(err));
        } finally {
            setTimeout(() => {
                rustRoutingMapButton.disabled = false;
                rustRoutingMapButton.innerText = 'Test mapa Rust';
            }, 1800);
        }
    });
}

const rustRealPlayersButton = document.getElementById('btn-rust-real-players');
if (rustRealPlayersButton) {
    rustRealPlayersButton.addEventListener('click', async () => {
        rustRealPlayersButton.disabled = true;
        rustRealPlayersButton.innerText = 'Players...';
        const startedPlayers = [];
        try {
            const filePath = await ipcRenderer.invoke('dialog:openFile');
            if (!filePath) {
                rustRealPlayersButton.innerText = 'Test players';
                return;
            }
            const players = [
                { player: 'player-a', bus: 'master', label: 'A / master' },
                { player: 'player-b', bus: 'master', label: 'B / master' },
                { player: 'cartwall-player', bus: 'cartwall', label: 'Cartwall' },
                { player: 'cue-player', bus: 'cue', label: 'Cue' },
                { player: 'pl1', bus: 'pl1', label: 'PL 1' },
                { player: 'pl2', bus: 'pl2', label: 'PL 2' },
                { player: 'pl3', bus: 'pl3', label: 'PL 3' },
                { player: 'pl4', bus: 'pl4', label: 'PL 4' }
            ];
            for (let idx = 0; idx < players.length; idx++) {
                const item = players[idx];
                rustRealPlayersButton.innerText = `${idx + 1}/${players.length}`;
                setText('diag-updated', `Rust player test: ${item.label}`);
                const result = await ipcRenderer.invoke('audio-engine-rust-command', {
                    cmd: 'labPlay',
                    player: item.player,
                    bus: item.bus,
                    path: filePath,
                    gain: 0.24
                });
                if (result?.success !== true) throw new Error(result?.error || `Fallo player ${item.label}`);
                startedPlayers.push(item.player);

                for (let tick = 1; tick <= 3; tick++) {
                    await sleep(500);
                    await refreshRustDiagnosticsFromStatus();
                    setText('diag-updated', `Rust player test: ${item.label} ${tick}/3`);
                }

                await ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'stop', player: item.player });
            }
            await refreshRustDiagnosticsFromStatus();
            rustRealPlayersButton.innerText = 'Players OK';
            setText('diag-updated', 'Players Rust probados por bus: A/B, cartwall, cue y PL1-PL4');
        } catch (err) {
            for (const player of startedPlayers) {
                try { await ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'stop', player }); } catch (stopErr) {}
            }
            try { await refreshRustDiagnosticsFromStatus(); } catch (statusErr) {}
            rustRealPlayersButton.innerText = 'Players error';
            setText('diag-updated', err.message || String(err));
        } finally {
            setTimeout(() => {
                rustRealPlayersButton.disabled = false;
                rustRealPlayersButton.innerText = 'Test players';
            }, 1800);
        }
    });
}

const rustPcmFfmpegButton = document.getElementById('btn-rust-pcm-ffmpeg');
if (rustPcmFfmpegButton) {
    rustPcmFfmpegButton.addEventListener('click', async () => {
        rustPcmFfmpegButton.disabled = true;
        rustPcmFfmpegButton.innerText = 'Elige audio...';
        try {
            const filePath = await ipcRenderer.invoke('dialog:openFile');
            const hasFile = !!filePath;
            const liveMixPlan = hasFile ? [] : buildRustPcmLiveMixPlan();
            rustPcmFfmpegButton.innerText = hasFile ? 'PCM audio...' : (liveMixPlan.length ? 'PCM vivo...' : 'PCM raiz...');
            setText('diag-updated', hasFile
                ? 'Probando Rust PCM -> FFmpeg con mezcla A/B, play/seek/pause/stop, sin transmitir...'
                : liveMixPlan.length
                    ? 'Probando Rust PCM -> FFmpeg con el mapa vivo de la consola, sin transmitir...'
                    : 'Probando Rust PCM -> FFmpeg con PARA_PRUEBAS1/2 si existen; si no, silencio...');
            const result = await ipcRenderer.invoke('rust-pcm-ffmpeg-test', {
                durationMs: 6200,
                filePath: filePath || '',
                allowRootTestFiles: true,
                players: liveMixPlan,
                scripted: hasFile
            });
            const mb = ((Number(result?.stdoutBytes) || 0) / 1048576).toFixed(2);
            const code = result?.ffmpegCode ?? 'n/a';
            const gap = Math.round(Number(result?.maxStdoutGapMs) || 0);
            if (result?.success !== true) {
                throw new Error(result?.error || result?.bridgeError || `FFmpeg salio con codigo ${code}`);
            }
            rustPcmFfmpegButton.innerText = 'PCM OK';
            const bridgeMode = result?.bridgeStatus?.mode || 'pcm';
            const sourceMode = result?.usedLiveMixPlan
                ? `mapa vivo (${Array.isArray(result.playerPlans) ? result.playerPlans.length : liveMixPlan.length} fuentes)`
                : result?.usedDefaultFiles
                    ? 'archivos raiz A/B'
                    : (result?.secondFilePath ? 'mezcla A/B real' : bridgeMode);
            setText('diag-updated', `Rust PCM -> FFmpeg OK: ${sourceMode}, ${mb} MB, max gap ${gap} ms, ffmpeg=${code}`);
            refreshReportTail();
        } catch (err) {
            rustPcmFfmpegButton.innerText = 'PCM error';
            setText('diag-updated', err.message || String(err));
        } finally {
            setTimeout(() => {
                rustPcmFfmpegButton.disabled = false;
                rustPcmFfmpegButton.innerText = 'Test PCM';
            }, 1800);
        }
    });
}

const clientProbeButton = document.getElementById('btn-client-probe');
if (clientProbeButton) {
    clientProbeButton.addEventListener('click', async () => {
        clientProbeButton.disabled = true;
        clientProbeButton.innerText = 'Cliente...';
        try {
            const result = await ipcRenderer.invoke('audio-engine-command', {
                type: 'route',
                payload: { bus: 'diagnostic-client', outputId: 'default' }
            });
            const ok = result?.success === true && result?.result?.ok === true;
            clientProbeButton.innerText = ok ? 'Cliente OK' : 'Cliente error';
            const adapter = result?.diagnostics?.adapter || 'desconocido';
            setText('diag-updated', ok
                ? `AudioEngineClient OK via ${adapter}`
                : (result?.result?.error || result?.error || 'AudioEngineClient no respondio'));
            if (result?.diagnostics) {
                currentLevels = { ...currentLevels, diagnostics: result.diagnostics };
                refreshDiagnostics(result.diagnostics);
            }
        } catch (err) {
            clientProbeButton.innerText = 'Cliente error';
            setText('diag-updated', err.message || String(err));
        } finally {
            setTimeout(() => {
                clientProbeButton.disabled = false;
                clientProbeButton.innerText = 'Test cliente';
            }, 1800);
        }
    });
}

const contractPlayerButton = document.getElementById('btn-contract-player');
if (contractPlayerButton) {
    contractPlayerButton.addEventListener('click', async () => {
        contractPlayerButton.disabled = true;
        contractPlayerButton.innerText = 'Elige audio...';
        const player = 'player-a';
        let previousMasterOutputId = 'default';
        try {
            const filePath = await ipcRenderer.invoke('dialog:openFile');
            if (!filePath) {
                contractPlayerButton.innerText = 'Test contrato';
                return;
            }

            const beforeStatus = await ipcRenderer.invoke('audio-engine-rust-status');
            previousMasterOutputId = getRustBusOutputId(beforeStatus?.lastStatus, 'master');
            const outputId = getSelectedRustOutputId();
            const outputLabel = outputId === 'default' ? 'salida default' : 'salida seleccionada';

            contractPlayerButton.innerText = 'Contrato...';
            setText('diag-updated', `Contrato Rust: route master por ${outputLabel}`);
            await invokeAudioEngineContract('route', { bus: 'master', outputId });

            setText('diag-updated', 'Contrato Rust: load player-a');
            await invokeAudioEngineContract('load', {
                player,
                bus: 'master',
                path: filePath,
                outputId,
                gain: 0.22
            });

            setText('diag-updated', 'Contrato Rust: play player-a');
            await invokeAudioEngineContract('play', { player });

            for (let tick = 1; tick <= 4; tick++) {
                await sleep(500);
                await refreshRustDiagnosticsFromStatus();
                setText('diag-updated', `Contrato Rust: player-a ${tick}/4`);
            }

            setText('diag-updated', 'Contrato Rust: seek player-a');
            await invokeAudioEngineContract('seek', { player, positionMs: 1500 });
            await sleep(500);
            await refreshRustDiagnosticsFromStatus();

            await invokeAudioEngineContract('stop', { player });
            await invokeAudioEngineContract('route', {
                bus: 'master',
                outputId: previousMasterOutputId || 'default'
            });
            await refreshRustDiagnosticsFromStatus();
            contractPlayerButton.innerText = 'Contrato OK';
            setText('diag-updated', 'Contrato Rust OK: load/play/seek/stop y ruta master restaurada');
        } catch (err) {
            try { await invokeAudioEngineContract('stop', { player }); } catch (stopErr) {}
            try {
                await invokeAudioEngineContract('route', {
                    bus: 'master',
                    outputId: previousMasterOutputId || 'default'
                });
            } catch (routeErr) {}
            try { await refreshRustDiagnosticsFromStatus(); } catch (statusErr) {}
            contractPlayerButton.innerText = 'Contrato error';
            setText('diag-updated', err.message || String(err));
        } finally {
            setTimeout(() => {
                contractPlayerButton.disabled = false;
                contractPlayerButton.innerText = 'Test contrato';
            }, 1800);
        }
    });
}

const rustSnapshotButton = document.getElementById('btn-rust-snapshot');
if (rustSnapshotButton) {
    rustSnapshotButton.addEventListener('click', async () => {
        rustSnapshotButton.disabled = true;
        rustSnapshotButton.innerText = 'Guardando...';
        try {
            const result = await ipcRenderer.invoke('audio-engine-snapshot', {
                uiDiagnostics: currentLevels.diagnostics || {}
            });
            if (result?.success !== true) throw new Error(result?.error || 'No se pudo guardar snapshot.');
            rustSnapshotButton.innerText = 'Snapshot OK';
            setText('diag-updated', `Snapshot: ${result.snapshotPath}`);
            refreshReportTail();
        } catch (err) {
            rustSnapshotButton.innerText = 'Snapshot error';
            setText('diag-updated', err.message || String(err));
        } finally {
            setTimeout(() => {
                rustSnapshotButton.disabled = false;
                rustSnapshotButton.innerText = 'Snapshot';
            }, 1800);
        }
    });
}

const diagnosticsToggleButton = document.getElementById('btn-toggle-diagnostics');
if (diagnosticsToggleButton) {
    diagnosticsToggleButton.addEventListener('click', () => {
        setDiagnosticsExpanded(!diagnosticsExpanded);
        if (diagnosticsExpanded) refreshReportTail();
    });
}
setDiagnosticsExpanded(diagnosticsExpanded);
