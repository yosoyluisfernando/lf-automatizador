const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a|aac|aiff|aif|mp2)$/i;

function scanPath(targetPath, output) {
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
        entries.forEach(entry => scanPath(path.join(targetPath, entry.name), output));
        return;
    }

    if (stat.isFile() && AUDIO_EXT.test(targetPath)) {
        output.push({
            filePath: targetPath,
            title: path.basename(targetPath).replace(/\.[^/.]+$/, ''),
            folderPath: path.dirname(targetPath),
            fileSize: stat.size,
            fileMtimeMs: stat.mtimeMs
        });
    }
}

parentPort.on('message', (message) => {
    const paths = Array.isArray(message?.paths) ? message.paths : [];
    const output = [];
    paths.forEach(targetPath => scanPath(targetPath, output));
    parentPort.postMessage({ type: 'done', assets: output });
});
