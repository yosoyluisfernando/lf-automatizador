const { parentPort } = require('worker_threads');
const cp = require('child_process');

let ffmpegPath = 'ffmpeg';
try { 
    ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
} catch (err) {}

function buildPeaksFromPcm(buffer, sampleRate = 8000) {
    const sampleCount = Math.floor(buffer.length / 4);
    const targetBins = Math.max(2048, Math.min(60000, Math.ceil((sampleCount / sampleRate) * 120)));
    const samplesPerBin = Math.max(1, Math.ceil(sampleCount / targetBins));
    const bins = Math.ceil(sampleCount / samplesPerBin);
    const min = new Array(bins);
    const max = new Array(bins);

    for (let bin = 0; bin < bins; bin++) {
        const start = bin * samplesPerBin;
        const end = Math.min(sampleCount, start + samplesPerBin);
        let binMin = 1;
        let binMax = -1;
        for (let i = start; i < end; i++) {
            const datum = buffer.readFloatLE(i * 4);
            if (datum < binMin) binMin = datum;
            if (datum > binMax) binMax = datum;
        }
        min[bin] = binMin;
        max[bin] = binMax;
    }

    return { min, max, bins, duration: sampleCount / sampleRate };
}

function buildWaveform(filePath) {
    return new Promise((resolve, reject) => {
        const sampleRate = 8000;
        const proc = cp.spawn(ffmpegPath, [
            '-hide_banner',
            '-nostats',
            '-threads', '1',
            '-i', filePath,
            '-vn',
            '-ac', '1',
            '-ar', String(sampleRate),
            '-f', 'f32le',
            'pipe:1'
        ], { windowsHide: true });
        const chunks = [];
        let stderr = '';
        proc.stdout.on('data', chunk => chunks.push(chunk));
        proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
        proc.on('error', reject);
        proc.on('close', code => {
            if (code !== 0 && chunks.length === 0) {
                reject(new Error(stderr || `FFmpeg termino con codigo ${code}`));
                return;
            }
            resolve(buildPeaksFromPcm(Buffer.concat(chunks), sampleRate));
        });
    });
}

parentPort.on('message', async (message) => {
    try {
        const peaks = await buildWaveform(message.filePath);
        parentPort.postMessage({ id: message.id, result: { success: true, peaks } });
    } catch (err) {
        parentPort.postMessage({ id: message.id, result: { success: false, error: err.message } });
    }
});
