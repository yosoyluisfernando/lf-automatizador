'use strict';

const SERVER_TYPES = new Set(['icecast', 'shoutcast', 'shoutcast2', 'shoutcast2_legacy']);
const CODECS = new Set(['mp3', 'aac', 'aac_he']);

function fail(message, category = 'config', retryable = false) {
    return { ok: false, message, category, retryable };
}

function normalizeMount(value) {
    const mount = String(value || '').trim();
    if (!mount) return '';
    return mount.startsWith('/') ? mount : `/${mount}`;
}

function validateEncoderConfig(rawConfig = {}, options = {}) {
    const requestedType = String(rawConfig.serverType || rawConfig.type || '').trim();
    if (!SERVER_TYPES.has(requestedType)) return fail('Tipo de servidor no reconocido.');

    const legacySc2 = requestedType === 'shoutcast2_legacy'
        || (requestedType === 'shoutcast2' && rawConfig.legacy === true);
    const serverType = legacySc2 ? 'shoutcast2' : requestedType;
    const ip = String(rawConfig.ip || '').trim();
    if (!ip || /\s|:\/\//.test(ip)) return fail('IP o host invalido.');

    const port = Number(rawConfig.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('Puerto invalido.');
    const adminPortRaw = String(rawConfig.adminPort || '').trim();
    const adminPort = adminPortRaw ? Number(adminPortRaw) : 0;
    if (adminPortRaw && (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65535)) {
        return fail('Puerto administrativo invalido.');
    }

    const password = String(rawConfig.password || rawConfig.pass || '');
    if (!password) return fail('Falta la contrasena del servidor.', 'auth');

    const codec = String(rawConfig.codec || '').trim();
    if (!CODECS.has(codec)) return fail('Codec no reconocido.', 'codec');
    if (codec === 'aac_he' && options.fdkAvailable !== true) {
        return fail('AAC+ / HE-AAC requiere un FFmpeg externo autorizado con libfdk_aac.', 'codec');
    }

    const bitrate = Number(rawConfig.bitrate || 128);
    if (!Number.isInteger(bitrate) || bitrate < 8 || bitrate > 512) {
        return fail('Bitrate invalido.');
    }

    let mount = String(rawConfig.mount || '').trim();
    if (serverType === 'icecast') {
        mount = normalizeMount(mount);
        if (!mount || mount === '/') return fail('Falta el punto de montaje para Icecast.');
    }
    if (serverType === 'shoutcast2') {
        if (!/^[1-9]\d*$/.test(mount)) return fail('El Stream ID (SID) debe ser un entero positivo.');
    }

    return {
        ok: true,
        config: {
            ...rawConfig,
            serverType,
            type: serverType,
            legacy: legacySc2,
            ip,
            port: String(port),
            adminPort: adminPortRaw ? String(adminPort) : '',
            password,
            pass: password,
            user: String(rawConfig.user || rawConfig.username || 'source').trim() || 'source',
            mount,
            codec,
            bitrate: String(bitrate),
        },
    };
}

function classifyEncoderError(value) {
    const text = String(value || '').toLowerCase();
    if (/401|403|unauthori[sz]ed|forbidden|bad password|invalid password|authentication|auth failed|cipher/.test(text)) {
        return { category: 'auth', retryable: false };
    }
    if (/stream in use|mountpoint.*in use|already connected|invalid sid|bad sid|nak/.test(text)) {
        return { category: 'server', retryable: false };
    }
    if (/unknown encoder|libfdk_aac|invalid data|unsupported codec|codec/.test(text)) {
        return { category: 'codec', retryable: false };
    }
    if (/econnrefused|econnreset|enotfound|etimedout|timeout|socket|network|temporar|closed by|cerro la conexion|cerrado por el servidor/.test(text)) {
        return { category: 'network', retryable: true };
    }
    return { category: 'server', retryable: false };
}

module.exports = {
    classifyEncoderError,
    normalizeMount,
    validateEncoderConfig,
};
