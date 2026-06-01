'use strict';

function buildRenamedAudioPath(filePath, requestedBaseName, pathApi = require('path')) {
    const currentPath = String(filePath || '').trim();
    const baseName = String(requestedBaseName || '').trim();
    if (!currentPath) throw new Error('Archivo invalido.');
    if (!baseName || baseName === '.' || baseName === '..' || /[<>:"/\\|?*\0]/.test(baseName)) {
        throw new Error('Nombre de archivo invalido.');
    }
    const extension = pathApi.extname(currentPath);
    return pathApi.join(pathApi.dirname(currentPath), `${baseName}${extension}`);
}

function renameFilePreservingExtension(fsApi, pathApi, filePath, requestedBaseName) {
    const currentPath = String(filePath || '').trim();
    if (!fsApi.existsSync(currentPath)) throw new Error('El archivo original no existe.');
    const renamedPath = buildRenamedAudioPath(currentPath, requestedBaseName, pathApi);
    if (pathApi.resolve(renamedPath) === pathApi.resolve(currentPath)) return currentPath;
    if (fsApi.existsSync(renamedPath)) throw new Error('Ya existe un archivo con ese nombre.');
    fsApi.renameSync(currentPath, renamedPath);
    return renamedPath;
}

module.exports = { buildRenamedAudioPath, renameFilePreservingExtension };
