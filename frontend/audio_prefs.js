const AUDIO_PREFS_DEFAULTS = {
    outMain: 'default',
    outMonitor: 'default',
    outCue: 'default',
    outCartwall: 'default',
    outEditor: 'default',
    monitorVolume: 100,
    monitorEnabled: false,
    monitorSourceMode: 'postFx',
    monitorVolumeUiEnabled: true,
    monitorVolumeUiMode: 'inline',
    playlistOutputMode: 'disabled',
    playlistSharedDevice: 'default',
    playlistOutputs: ['default', 'default', 'default', 'default'],
    cartwallOutputMode: 'master',
    keyboardShortcutScope: 'contextual',
    repeatForgetProtectionEnabled: false,
    repeatForgetProtectionMax: 10,
    repeatDisableOnManualNext: true,
    removePlayedProtectionEnabled: false,
    removePlayedProtectionMinRemaining: 2,
    historyRetentionDays: 30,
    historyMusicEnabled: true,
    reportMusicEnabled: true,
    // Separacion de canciones (antes "evitar repetir musica aleatoria").
    // Solo-horas: minimo 1, maximo 48, predeterminado 12.
    musicRandomProtectionValue: 12,
    musicRandomProtectionUnit: 'hours',
    // Separacion por artista: opcional, viene desactivada.
    musicArtistSeparationEnabled: false,
    musicArtistSeparationHours: 1,
    // Incluir subcarpetas en carpetas aleatorias: 'ask' | 'always' | 'never'.
    randomIncludeSubfolders: 'ask',
    reportPersistOnRestart: true,
    reportRetentionUnit: 'days',
    reportRetentionValue: 7,
    // El motor Rust es la unica fuente de audio en produccion. El modo
    // 'webAudio' fue retirado del UI y de la logica: cualquier valor legado
    // ('webAudio', undefined, etc.) se promueve a 'rustAudio' en normalizeAudioPrefs.
    audioEngineMode: 'rustAudio',
    rustPlaylistOwnerEnabled: true,
    eventPreHoldActive: true,
    eventPreHoldSeconds: 20
};

function normalizePlaylistOutputs(rawOutputs, fallbackDevice) {
    const outputs = Array.isArray(rawOutputs) ? rawOutputs : [];
    return Array.from({ length: 4 }, (_, idx) => outputs[idx] || fallbackDevice || 'default');
}

function normalizeAudioPrefs(prefs = {}) {
    const mainDevice = prefs.outMain || AUDIO_PREFS_DEFAULTS.outMain;
    const monitorDevice = prefs.outMonitor || mainDevice;
    const cueDevice = prefs.outCue || mainDevice;
    const sharedPlaylistDevice = prefs.playlistSharedDevice || monitorDevice || mainDevice;
    const playlistMode = ['disabled', 'shared', 'independent'].includes(prefs.playlistOutputMode)
        ? prefs.playlistOutputMode
        : AUDIO_PREFS_DEFAULTS.playlistOutputMode;
    const cartwallMode = ['master', 'monitor', 'cue', 'device'].includes(prefs.cartwallOutputMode)
        ? prefs.cartwallOutputMode
        : AUDIO_PREFS_DEFAULTS.cartwallOutputMode;
    const keyboardShortcutScope = ['contextual', 'main-window', 'application'].includes(prefs.keyboardShortcutScope)
        ? prefs.keyboardShortcutScope
        : AUDIO_PREFS_DEFAULTS.keyboardShortcutScope;
    // Promocion forzada: cualquier valor legado se convierte en 'rustAudio'.
    // El motor Web Audio ya no existe como modo de operacion.
    const audioEngineMode = 'rustAudio';
    const monitorVolumeUiMode = ['inline', 'icon'].includes(prefs.monitorVolumeUiMode)
        ? prefs.monitorVolumeUiMode
        : AUDIO_PREFS_DEFAULTS.monitorVolumeUiMode;
    const monitorSourceMode = ['postFx', 'preFx'].includes(prefs.monitorSourceMode)
        ? prefs.monitorSourceMode
        : AUDIO_PREFS_DEFAULTS.monitorSourceMode;

    return {
        ...prefs,
        outMain: mainDevice,
        outMonitor: monitorDevice,
        outCue: cueDevice,
        outCartwall: prefs.outCartwall || mainDevice,
        outEditor: cueDevice,
        monitorVolume: Math.max(0, Math.min(100, parseInt(prefs.monitorVolume, 10) || AUDIO_PREFS_DEFAULTS.monitorVolume)),
        monitorEnabled: prefs.monitorEnabled === true,
        monitorSourceMode,
        monitorVolumeUiEnabled: prefs.monitorVolumeUiEnabled !== false,
        monitorVolumeUiMode,
        playlistOutputMode: playlistMode,
        playlistSharedDevice: sharedPlaylistDevice,
        playlistOutputs: normalizePlaylistOutputs(prefs.playlistOutputs, sharedPlaylistDevice || mainDevice),
        cartwallOutputMode: cartwallMode,
        keyboardShortcutScope,
        repeatForgetProtectionEnabled: prefs.repeatForgetProtectionEnabled === true,
        repeatForgetProtectionMax: Math.max(1, Math.min(999, parseInt(prefs.repeatForgetProtectionMax, 10) || AUDIO_PREFS_DEFAULTS.repeatForgetProtectionMax)),
        repeatDisableOnManualNext: prefs.repeatDisableOnManualNext !== false,
        removePlayedProtectionEnabled: prefs.removePlayedProtectionEnabled === true,
        removePlayedProtectionMinRemaining: Math.max(1, Math.min(999, parseInt(prefs.removePlayedProtectionMinRemaining, 10) || AUDIO_PREFS_DEFAULTS.removePlayedProtectionMinRemaining)),
        // Memoria fisica: piso de 30 dias (respalda las reglas de separacion).
        historyRetentionDays: Math.max(30, Math.min(366, parseInt(prefs.historyRetentionDays, 10) || AUDIO_PREFS_DEFAULTS.historyRetentionDays)),
        historyMusicEnabled: prefs.historyMusicEnabled !== false,
        reportMusicEnabled: prefs.reportMusicEnabled !== false,
        // Separacion de canciones: solo-horas (1..48). Migracion unica desde el
        // esquema legado en dias -> horas (dias x 24, tope 48h). Idempotente: un
        // valor ya en horas solo se reajusta al nuevo rango.
        musicRandomProtectionUnit: 'hours',
        musicRandomProtectionValue: (() => {
            const max = 48;
            const hasValue = prefs.musicRandomProtectionValue != null || prefs.musicRandomProtectionDays != null;
            if (!hasValue) return AUDIO_PREFS_DEFAULTS.musicRandomProtectionValue;
            let hours;
            if (prefs.musicRandomProtectionUnit === 'hours') {
                hours = parseInt(prefs.musicRandomProtectionValue, 10);
            } else {
                const days = parseInt(prefs.musicRandomProtectionValue ?? prefs.musicRandomProtectionDays, 10);
                hours = Number.isFinite(days) ? days * 24 : NaN;
            }
            if (!Number.isFinite(hours)) hours = AUDIO_PREFS_DEFAULTS.musicRandomProtectionValue;
            return Math.max(1, Math.min(max, hours));
        })(),
        // Separacion por artista: opcional (desactivada por defecto), 1..48h.
        musicArtistSeparationEnabled: prefs.musicArtistSeparationEnabled === true,
        musicArtistSeparationHours: Math.max(1, Math.min(48, parseInt(prefs.musicArtistSeparationHours, 10) || AUDIO_PREFS_DEFAULTS.musicArtistSeparationHours)),
        // Incluir subcarpetas en carpetas aleatorias.
        randomIncludeSubfolders: ['ask', 'always', 'never'].includes(prefs.randomIncludeSubfolders)
            ? prefs.randomIncludeSubfolders
            : AUDIO_PREFS_DEFAULTS.randomIncludeSubfolders,
        reportPersistOnRestart: prefs.reportPersistOnRestart !== false,
        reportRetentionUnit: prefs.reportRetentionUnit === 'hours' ? 'hours' : 'days',
        reportRetentionValue: Math.max(1, Math.min(366, parseInt(prefs.reportRetentionValue, 10) || AUDIO_PREFS_DEFAULTS.reportRetentionValue)),
        audioEngineMode,
        rustPlaylistOwnerEnabled: true,
        eventPreHoldActive: prefs.eventPreHoldActive !== false,
        eventPreHoldSeconds: Math.max(1, Math.min(120, parseInt(prefs.eventPreHoldSeconds, 10) || AUDIO_PREFS_DEFAULTS.eventPreHoldSeconds))
    };
}

module.exports = {
    AUDIO_PREFS_DEFAULTS,
    normalizeAudioPrefs
};
