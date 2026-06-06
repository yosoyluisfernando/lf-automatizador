const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const AUDIO_FILE_RE = /\.(mp3|wav|flac|ogg|m4a|aac|aiff|aif|mp2)$/i;
const MAX_RECURSIVE_FILES = 100000;

async function readDirSafe(dirPath) {
    try {
        return await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
        return null;
    }
}

async function collectAudioFilesRecursive(rootPath) {
    const files = [];
    const stack = [rootPath];

    while (stack.length > 0 && files.length < MAX_RECURSIVE_FILES) {
        const current = stack.pop();
        const items = await readDirSafe(current);
        if (!items) continue;

        for (const item of items) {
            const itemPath = path.join(current, item.name);
            if (item.isDirectory()) {
                stack.push(itemPath);
            } else if (item.isFile() && AUDIO_FILE_RE.test(item.name)) {
                files.push({ name: item.name, path: itemPath });
                if (files.length >= MAX_RECURSIVE_FILES) break;
            }
        }
    }

    return files;
}

async function readLibraryDir(dirPath, recursive = false) {
    if (!dirPath || typeof dirPath !== 'string') return { success: false };

    if (recursive) {
        const files = await collectAudioFilesRecursive(dirPath);
        return { success: true, files, isRecursive: true, truncated: files.length >= MAX_RECURSIVE_FILES };
    }

    const items = await readDirSafe(dirPath);
    if (!items) return { success: false };

    const dirs = [];
    const files = [];
    for (const item of items) {
        if (item.isDirectory()) dirs.push(item.name);
        else if (item.isFile() && AUDIO_FILE_RE.test(item.name)) files.push(item.name);
    }

    return { success: true, dirs, files, isRecursive: false };
}

parentPort.on('message', async (message) => {
    try {
        const result = await readLibraryDir(message?.dirPath, message?.recursive === true);
        parentPort.postMessage({ id: message?.id, result });
    } catch (err) {
        parentPort.postMessage({ id: message?.id, result: { success: false, error: err.message } });
    }
});
