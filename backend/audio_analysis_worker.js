const { parentPort } = require('worker_threads');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../database');

let ffmpegPath = 'ffmpeg';
try { 
    ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
} catch (err) {}

function resolveRustAudioEnginePath() {
    const rootDir = path.resolve(__dirname, '..');
    const ext = process.platform === 'win32' ? '.exe' : '';
    const resourcesDir = process.resourcesPath ? path.resolve(process.resourcesPath) : '';
    const candidates = [
        resourcesDir ? path.join(resourcesDir, 'bin', `lf-audio-engine${ext}`) : '',
        path.join(rootDir.replace('app.asar', 'app.asar.unpacked'), 'bin', `lf-audio-engine${ext}`),
        path.join(rootDir, 'bin', `lf-audio-engine${ext}`),
        path.join(rootDir, 'audio-engine-rust', 'target', 'release', `lf-audio-engine${ext}`),
        path.join(rootDir, 'audio-engine-rust', 'target', 'debug', `lf-audio-engine${ext}`)
    ];
    return candidates.find(candidate => candidate && fs.existsSync(candidate)) || '';
}

const rustAudioEnginePath = resolveRustAudioEnginePath();

const CPU_COUNT = Math.max(1, os.cpus()?.length || 2);
const MAX_CONCURRENT = Math.max(1, Math.min(5, CPU_COUNT));
let queue = [];
let active = 0;
const activePaths = new Set();
let cancelled = false;

function normalizeAnalyzerProvider(value) {
    const provider = String(value || '').trim().toLowerCase();
    if (provider === 'ffmpeg') return 'ffmpeg';
    if (provider === 'rust' || provider === 'rustaudio' || provider === 'rustaudioengine') return 'rustAudio';
    return 'auto';
}

const upsertTrackAnalysisForceStmt = db.prepare(`INSERT INTO tracks (file_path, db, peak_db, mix, fin, inicio, duration, file_size, file_mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET db = excluded.db, peak_db = excluded.peak_db, mix = excluded.mix, fin = excluded.fin, inicio = excluded.inicio, duration = excluded.duration, file_size = excluded.file_size, file_mtime_ms = excluded.file_mtime_ms`);
const upsertTrackAnalysisFillStmt = db.prepare(`INSERT INTO tracks (file_path, db, peak_db, mix, fin, inicio, duration, file_size, file_mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET db = COALESCE(tracks.db, excluded.db), peak_db = COALESCE(tracks.peak_db, excluded.peak_db), mix = COALESCE(tracks.mix, excluded.mix), fin = COALESCE(tracks.fin, excluded.fin), inicio = COALESCE(tracks.inicio, excluded.inicio), duration = COALESCE(tracks.duration, excluded.duration), file_size = excluded.file_size, file_mtime_ms = excluded.file_mtime_ms`);
const selectTrackByPathStmt = db.prepare("SELECT * FROM tracks WHERE file_path = ?");

function getTrackFileSignature(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return { fileSize: stat.size, fileMtimeMs: Math.round(stat.mtimeMs) };
    } catch (err) {
        return null;
    }
}

function mapResultRow(row, signature = null) {
    const effectiveSignature = signature || getTrackFileSignature(row?.file_path || '');
    const fileChanged = !!(row && effectiveSignature && (
        (row.file_size != null && Number(row.file_size) !== Number(effectiveSignature.fileSize))
        || (row.file_mtime_ms != null && Math.abs(Number(row.file_mtime_ms) - Number(effectiveSignature.fileMtimeMs)) > 2)
    ));
    return {
        db: row?.db ?? '',
        peak_db: row?.peak_db ?? '',
        mix: row?.mix ?? '',
        fin: row?.fin ?? '',
        inicio: row?.inicio ?? '',
        fileChanged
    };
}

function hasUsableAnalysis(row, signature = null) {
    if (!row) return false;
    const mapped = mapResultRow(row, signature);
    if (mapped.fileChanged) return false;
    const values = [row.inicio, row.fin, row.mix, row.duration];
    return values.every(value => Number.isFinite(Number(value)) && Number(value) > 0);
}

const runFfmpegCommand = (bin, args) => new Promise((resolve, reject) => {
    const proc = cp.spawn(bin, args, { windowsHide: true });
    let output = '';
    proc.stderr.on('data', (d) => { output += d.toString(); });
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.on('error', reject);
    proc.on('close', () => resolve(output));
});

function runRustAnalyzeCommand(task) {
    return new Promise((resolve, reject) => {
        if (!rustAudioEnginePath) {
            reject(new Error('Binario RustAudio no disponible.'));
            return;
        }
        const requestId = `analysis-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const proc = cp.spawn(rustAudioEnginePath, [], {
            cwd: path.dirname(rustAudioEnginePath),
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let settled = false;
        let stdoutBuffer = '';
        let stderrBuffer = '';
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { proc.kill(); } catch (err) {}
            reject(new Error('Timeout analizando con RustAudio.'));
        }, 12000);

        const finish = (err, result = null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            try { proc.kill(); } catch (killErr) {}
            if (err) reject(err);
            else resolve(result);
        };

        proc.stdout.on('data', chunk => {
            stdoutBuffer += String(chunk || '');
            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue;
                let message = null;
                try { message = JSON.parse(line); } catch (err) { continue; }
                if (message.type === 'ready') continue;
                if (message.requestId && message.requestId !== requestId) continue;
                if (message.type === 'analysis') {
                    finish(null, message);
                    return;
                }
                if (message.type === 'error') {
                    finish(new Error(message.message || 'RustAudio no pudo analizar.'));
                    return;
                }
            }
        });
        proc.stderr.on('data', chunk => { stderrBuffer += String(chunk || ''); });
        proc.on('error', err => finish(err));
        proc.on('close', () => {
            if (!settled) finish(new Error((stderrBuffer.trim() || 'RustAudio cerro sin resultado de analisis.')));
        });
        try {
            proc.stdin.write(`${JSON.stringify({
                cmd: 'analyzeAudio',
                requestId,
                path: task.filePath,
                dbMix: task.dbMix ?? -14,
                dbStart: task.dbStart ?? -36,
                dbFin: task.dbFin ?? -48
            })}\n`);
            proc.stdin.end();
        } catch (err) {
            finish(err);
        }
    });
}

function timeToSeconds(timeStr) {
    const parts = timeStr.split(':');
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
}

function postResult(payload) {
    parentPort.postMessage({ type: 'result', payload });
}

function postFinished() {
    parentPort.postMessage({ type: 'finished' });
}

async function analyzeTask(task) {
    const filePath = task.filePath;
    const thresholdMix = (task.dbMix ?? -14);
    const thresholdStart = (task.dbStart ?? -36);
    const thresholdFin = (task.dbFin ?? -48);
    const provider = normalizeAnalyzerProvider(task.analyzerProvider || task.provider);
    const signature = getTrackFileSignature(filePath);
    const existingRow = selectTrackByPathStmt.get(filePath);
    if (!task.forceOverwrite && hasUsableAnalysis(existingRow, signature)) {
        return {
            success: true,
            filePath,
            cached: true,
            data: mapResultRow(existingRow, signature)
        };
    }

    if (provider !== 'ffmpeg') try {
        const rustResult = await runRustAnalyzeCommand(task);
        const totalDur = Number(rustResult.duration) || 0;
        const dbValue = Number(rustResult.db);
        const peakDbValue = Number(rustResult.peakDb);
        const mixPoint = Number(rustResult.mix);
        const finPoint = Number(rustResult.fin);
        const inicioPoint = Number(rustResult.inicio);
        if (![totalDur, dbValue, peakDbValue, mixPoint, finPoint, inicioPoint].every(Number.isFinite) || totalDur <= 0) {
            throw new Error('RustAudio devolvio analisis invalido.');
        }
        if (task.forceOverwrite) {
            upsertTrackAnalysisForceStmt.run(filePath, dbValue.toFixed(1), peakDbValue.toFixed(1), mixPoint.toFixed(3), finPoint.toFixed(3), inicioPoint.toFixed(3), totalDur, signature?.fileSize ?? null, signature?.fileMtimeMs ?? null);
        } else {
            upsertTrackAnalysisFillStmt.run(filePath, dbValue.toFixed(1), peakDbValue.toFixed(1), mixPoint.toFixed(3), finPoint.toFixed(3), inicioPoint.toFixed(3), totalDur, signature?.fileSize ?? null, signature?.fileMtimeMs ?? null);
        }
        const updatedRow = selectTrackByPathStmt.get(filePath);
        return {
            success: true,
            filePath,
            analyzer: 'rustAudio',
            data: mapResultRow(updatedRow, signature)
        };
    } catch (rustErr) {
        // FFmpeg queda como respaldo para formatos o archivos que Rust no pueda decodificar.
        if (provider === 'rustAudio' && task.fallbackToFfmpeg === false) {
            throw rustErr;
        }
    }

    const volArgs = ['-hide_banner', '-nostats', '-threads', '1', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'];
    const volOutput = await runFfmpegCommand(ffmpegPath, volArgs);
    const meanVolumeMatch = volOutput.match(/mean_volume:\s*([\-\d\.]+)/);
    const maxVolumeMatch = volOutput.match(/max_volume:\s*([\-\d\.]+)/);
    const durationMatch = volOutput.match(/Duration:\s*([\d\:\.]+)/);
    if (!durationMatch) throw new Error('FFmpeg no pudo leer la duracion del archivo.');

    const totalDur = timeToSeconds(durationMatch[1]);
    const dbValue = meanVolumeMatch ? parseFloat(meanVolumeMatch[1]) : -14.0;
    const rawPeak = maxVolumeMatch ? parseFloat(maxVolumeMatch[1]) : dbValue;
    const peakDbValue = rawPeak > 3.0 ? 3.0 : rawPeak;
    const mathPeak = Math.min(rawPeak, 0.0);
    const dynamicMix = (mathPeak + thresholdMix).toFixed(1);
    const absoluteStart = thresholdStart.toFixed(1);
    const absoluteFin = thresholdFin.toFixed(1);

    const runSilDetect = async (dbThreshold, durationThreshold) => {
        const out = await runFfmpegCommand(ffmpegPath, ['-hide_banner', '-nostats', '-threads', '1', '-i', filePath, '-af', `silencedetect=n=${dbThreshold}dB:d=${durationThreshold}`, '-f', 'null', '-']);
        const blocks = [];
        let currentStart = null;
        const lines = out.split('\n');
        for (const line of lines) {
            const ms = line.match(/silence_start:\s*([\d\.]+)/);
            if (ms) currentStart = parseFloat(ms[1]);
            const me = line.match(/silence_end:\s*([\d\.]+)/);
            if (me) {
                if (currentStart !== null) {
                    blocks.push({ start: currentStart, end: parseFloat(me[1]) });
                    currentStart = null;
                } else {
                    blocks.push({ start: 0, end: parseFloat(me[1]) });
                }
            }
        }
        if (currentStart !== null) blocks.push({ start: currentStart, end: totalDur });
        return blocks;
    };

    const startSil = await runSilDetect(absoluteStart, 0.4);
    const finSil = await runSilDetect(absoluteFin, 0.4);
    const mixSil = await runSilDetect(dynamicMix, 0.2);

    let inicioPoint = 0.001;
    if (startSil.length > 0 && startSil[0].start <= 1.5) inicioPoint = startSil[0].end;

    let finPoint = totalDur;
    for (let i = finSil.length - 1; i >= 0; i--) {
        const block = finSil[i];
        if (block.end >= totalDur - 0.5) {
            finPoint = block.start;
            break;
        }
    }

    let mixPoint = totalDur;
    for (let i = mixSil.length - 1; i >= 0; i--) {
        const block = mixSil[i];
        if (block.end >= totalDur - 0.5 && block.start <= finPoint) {
            mixPoint = block.start;
            break;
        }
    }
    if (mixPoint === totalDur || mixPoint >= finPoint) mixPoint = Math.max(0.001, finPoint - 1.0);

    const round3 = (v) => Math.round(v * 1000) / 1000;
    inicioPoint = round3(inicioPoint);
    if (inicioPoint <= 0.001) inicioPoint = 0.001;

    if (task.forceOverwrite) {
        upsertTrackAnalysisForceStmt.run(filePath, dbValue.toFixed(1), peakDbValue.toFixed(1), mixPoint.toFixed(3), finPoint.toFixed(3), inicioPoint.toFixed(3), totalDur, signature?.fileSize ?? null, signature?.fileMtimeMs ?? null);
    } else {
        upsertTrackAnalysisFillStmt.run(filePath, dbValue.toFixed(1), peakDbValue.toFixed(1), mixPoint.toFixed(3), finPoint.toFixed(3), inicioPoint.toFixed(3), totalDur, signature?.fileSize ?? null, signature?.fileMtimeMs ?? null);
    }

    const updatedRow = selectTrackByPathStmt.get(filePath);
    return {
        success: true,
        filePath,
        analyzer: provider === 'ffmpeg' ? 'ffmpeg' : 'ffmpeg-fallback',
        data: mapResultRow(updatedRow, signature)
    };
}

function pump() {
    if (cancelled) {
        if (active === 0) postFinished();
        return;
    }
    while (active < MAX_CONCURRENT && queue.length > 0) {
        const task = queue.shift();
        if (task?.filePath) activePaths.add(task.filePath);
        active++;
        analyzeTask(task)
            .then(result => postResult(result))
            .catch(err => postResult({ success: false, filePath: task?.filePath, data: null, error: err.message }))
            .finally(() => {
                if (task?.filePath) activePaths.delete(task.filePath);
                active--;
                if ((queue.length === 0 || cancelled) && active === 0) postFinished();
                else pump();
            });
    }
    if (queue.length === 0 && active === 0) postFinished();
}

parentPort.on('message', (message) => {
    if (message?.action === 'cancel') {
        cancelled = true;
        queue = [];
        activePaths.clear();
        return;
    }
    if (message?.action === 'start') {
        cancelled = false;
        queue = Array.isArray(message.tasks) ? message.tasks : [];
        pump();
        return;
    }
    if (message?.action === 'append') {
        cancelled = false;
        const nextTasks = Array.isArray(message.tasks) ? message.tasks : [];
        const knownPaths = new Set([
            ...queue.map(task => task?.filePath).filter(Boolean),
            ...activePaths
        ]);
        nextTasks.forEach(task => {
            if (!task?.filePath || knownPaths.has(task.filePath)) return;
            knownPaths.add(task.filePath);
            if (task.priority === 'now') queue.unshift(task);
            else queue.push(task);
        });
        pump();
    }
});
