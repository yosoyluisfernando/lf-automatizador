'use strict';

const path = require('path');

function normalizePathKey(value) {
    return String(value || '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
}

function getTypeById(fileTypes = [], typeId = '') {
    if (!typeId) return null;
    return (Array.isArray(fileTypes) ? fileTypes : []).find(type => type?.id === typeId) || null;
}

function optionIncludesSubfolders(assignedPath, optionsMap = {}) {
    const opts = optionsMap?.[assignedPath];
    if (!opts) return false;
    return opts.kind === 'folder' && opts.includeSubfolders === true;
}

function resolveExplicitAssignment(targetPath, fileTypes = [], explicitTypes = {}, optionsMap = {}) {
    if (!targetPath) return null;
    const exactType = getTypeById(fileTypes, explicitTypes[targetPath]);
    if (exactType) return { matchedPath: targetPath, typeData: exactType, matchKind: 'exact' };

    const dirPath = path.dirname(targetPath);
    if (!dirPath || dirPath === targetPath) return null;

    const directType = getTypeById(fileTypes, explicitTypes[dirPath]);
    if (directType) return { matchedPath: dirPath, typeData: directType, matchKind: 'direct-folder' };

    const targetKey = normalizePathKey(targetPath);
    let prev = dirPath;
    let ancestor = path.dirname(dirPath);
    while (ancestor && ancestor !== prev) {
        if (explicitTypes[ancestor] && optionIncludesSubfolders(ancestor, optionsMap)) {
            const ancestorKey = normalizePathKey(ancestor);
            if (targetKey === ancestorKey || targetKey.startsWith(`${ancestorKey}/`)) {
                const found = getTypeById(fileTypes, explicitTypes[ancestor]);
                if (found) return { matchedPath: ancestor, typeData: found, matchKind: 'ancestor-folder' };
            }
        }
        prev = ancestor;
        ancestor = path.dirname(ancestor);
    }
    return null;
}

function identifierMatchesFile(type = {}, filePath = '') {
    const nameStr = path.basename(filePath || '').toLowerCase();
    if (!nameStr) return false;

    if (type._regex) return type._regex.test(nameStr);
    if (type._identifier !== undefined) {
        const identifier = String(type._identifier || '').toLowerCase().trim();
        return !!identifier && nameStr.includes(identifier);
    }

    const identifiers = [type.identifier, ...(Array.isArray(type.aliases) ? type.aliases : [])].filter(Boolean);
    for (const rawIdentifier of identifiers) {
        const identifier = String(rawIdentifier || '').toLowerCase().trim();
        if (!identifier) continue;
        if (/^[a-z0-9]+$/.test(identifier)) {
            if (new RegExp(`\\b${identifier}\\b`, 'i').test(nameStr)) return true;
        } else if (nameStr.includes(identifier)) {
            return true;
        }
    }
    return false;
}

function resolveFileType(filePath, row = null, fileTypes = [], explicitTypes = {}, optionsMap = {}) {
    const rowType = getTypeById(fileTypes, row?.type_id);
    if (rowType) return rowType;

    const explicit = resolveExplicitAssignment(filePath, fileTypes, explicitTypes, optionsMap);
    if (explicit?.typeData) return explicit.typeData;

    for (const type of Array.isArray(fileTypes) ? fileTypes : []) {
        if (identifierMatchesFile(type, filePath)) return type;
    }
    return null;
}

module.exports = {
    normalizePathKey,
    getTypeById,
    resolveExplicitAssignment,
    identifierMatchesFile,
    resolveFileType
};
