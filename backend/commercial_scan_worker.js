const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { resolveFfmpegRuntime } = require('./utils/ffmpeg_resolver');

const ffmpegPath = resolveFfmpegRuntime().baseline.path;
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a|aac|aiff|aif|mp2)$/i;

function getDuration(filePath) {
    return new Promise((resolve) => {
        const proc = cp.spawn(ffmpegPath, ['-i', filePath], { windowsHide: true });
        let stderr = '';
        proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
        proc.on('close', () => {
            const match = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d+)/);
            if (match) {
                const hours = parseInt(match[1], 10);
                const minutes = parseInt(match[2], 10);
                const seconds = parseFloat(match[3]);
                resolve(hours * 3600 + minutes * 60 + seconds);
            } else {
                resolve(0);
            }
        });
        proc.on('error', () => resolve(0));
    });
}

async function scanPath(targetPath, output) {
    let stat;
    try {
        stat = fs.statSync(targetPath);
    } catch (err) {
        return;
    }

    if (stat.isDirectory()) {
        let entries = [];
        try {
            entries = fs.readdirSync(targetPath, { withFileTypes: true });
        } catch (err) {
            return;
        }
        for (const entry of entries) {
            await scanPath(path.join(targetPath, entry.name), output);
        }
        return;
    }

    if (stat.isFile() && AUDIO_EXT.test(targetPath)) {
        const duration = await getDuration(targetPath);
        output.push({
            filePath: targetPath,
            title: path.basename(targetPath).replace(/\.[^/.]+$/, ''),
            folderPath: path.dirname(targetPath),
            fileSize: stat.size,
            fileMtimeMs: stat.mtimeMs,
            duration: duration
        });
    }
}

parentPort.on('message', async (message) => {
    const paths = Array.isArray(message?.paths) ? message.paths : [];
    const output = [];
    for (const targetPath of paths) {
        await scanPath(targetPath, output);
    }
    parentPort.postMessage({ type: 'done', assets: output });
});
