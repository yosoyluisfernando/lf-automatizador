'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

function replaceAsar(value) {
    return String(value || '').replace(/app\.asar(?!\.unpacked)/g, 'app.asar.unpacked');
}

function loadFfmpegStatic(requireFfmpegStatic = () => require('ffmpeg-static')) {
    try {
        return replaceAsar(requireFfmpegStatic() || '');
    } catch (_) {
        return '';
    }
}

function resolveBaselineFfmpegPath(options = {}) {
    const env = options.env || process.env;
    const platform = options.platform || process.platform;
    const existsSync = options.existsSync || fs.existsSync;
    const resourcesPath = options.resourcesPath || process.resourcesPath || '';
    const ext = platform === 'win32' ? '.exe' : '';

    if (env.LF_FFMPEG_PATH) return { path: replaceAsar(env.LF_FFMPEG_PATH), source: 'LF_FFMPEG_PATH' };
    if (env.FFMPEG_BIN) return { path: replaceAsar(env.FFMPEG_BIN), source: 'FFMPEG_BIN' };

    const packaged = resourcesPath ? path.join(resourcesPath, 'bin', `ffmpeg${ext}`) : '';
    if (packaged && existsSync(packaged)) return { path: packaged, source: 'packaged-bin' };

    if (platform !== 'win32') return { path: 'ffmpeg', source: 'system-path' };

    const staticPath = loadFfmpegStatic(options.requireFfmpegStatic);
    if (staticPath) return { path: staticPath, source: 'ffmpeg-static' };

    return { path: 'ffmpeg', source: 'system-path' };
}

function probeFfmpegCapabilities(executable, options = {}) {
    const spawnSync = options.spawnSync || cp.spawnSync;
    try {
        const result = spawnSync(executable, ['-hide_banner', '-encoders'], {
            windowsHide: true,
            encoding: 'utf8',
            timeout: 10000,
        });
        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        return {
            available: !result.error && (result.status === 0 || output.length > 0),
            libfdkAac: /\blibfdk_aac\b/.test(output),
            libmp3lame: /\blibmp3lame\b/.test(output),
            error: result.error ? String(result.error.message || result.error) : '',
        };
    } catch (err) {
        return { available: false, libfdkAac: false, libmp3lame: false, error: String(err.message || err) };
    }
}

function resolveFfmpegRuntime(options = {}) {
    const env = options.env || process.env;
    const probeCapabilities = options.probeCapabilities || (value => probeFfmpegCapabilities(value, options));
    let baseline = resolveBaselineFfmpegPath(options);
    baseline.capabilities = probeCapabilities(baseline.path);
    const platform = options.platform || process.platform;
    const hasExplicitBaseline = !!(env.LF_FFMPEG_PATH || env.FFMPEG_BIN);
    if (!hasExplicitBaseline
        && platform !== 'win32'
        && (!baseline.capabilities.available || !baseline.capabilities.libmp3lame)) {
        const staticPath = loadFfmpegStatic(options.requireFfmpegStatic);
        if (staticPath && staticPath !== baseline.path) {
            const staticCapabilities = probeCapabilities(staticPath);
            if (staticCapabilities.available
                && (!baseline.capabilities.available || staticCapabilities.libmp3lame)) {
                baseline = {
                    path: staticPath,
                    source: 'ffmpeg-static-fallback',
                    capabilities: staticCapabilities,
                };
            }
        }
    }

    let fdk = null;
    if (env.LF_FFMPEG_FDK_PATH) {
        const candidate = {
            path: replaceAsar(env.LF_FFMPEG_FDK_PATH),
            source: 'LF_FFMPEG_FDK_PATH',
        };
        candidate.capabilities = probeCapabilities(candidate.path);
        if (candidate.capabilities.available && candidate.capabilities.libfdkAac) fdk = candidate;
    }
    if (!fdk && baseline.capabilities.available && baseline.capabilities.libfdkAac) {
        fdk = {
            path: baseline.path,
            source: 'baseline-with-libfdk_aac',
            capabilities: baseline.capabilities,
        };
    }
    return { baseline, fdk };
}

module.exports = {
    probeFfmpegCapabilities,
    replaceAsar,
    resolveBaselineFfmpegPath,
    resolveFfmpegRuntime,
};
