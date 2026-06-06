/**
 * Utilidades comunes (limpieza de texto, CSV, rate limiting, etc)
 */

function cleanCsvList(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .filter((item, index, arr) => arr.findIndex(other => other.toLocaleLowerCase() === item.toLocaleLowerCase()) === index)
        .join(', ');
}

function mergeCsvList(currentValue, nextValue) {
    return cleanCsvList([currentValue, nextValue].filter(Boolean).join(','));
}

function cleanMetaString(s) {
    if (!s) return '';
    return String(s).toLowerCase()
        .replace(/\.(mp3|wav|flac|ogg|m4a|aac|aiff|aif|mp2)$/i, '')
        .replace(/\[[^\]]*\]|\([^\)]*\)|\{[^\}]*\}/g, ' ')
        .replace(/feat\.?|ft\.?|official|video|lyrics|letra|audio|remix|mix|version|radio|live|hd|hq|explicit/gi, ' ')
        .replace(/[_\-]+/g, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenSet(s) {
    const cleaned = cleanMetaString(s);
    if (!cleaned) return new Set();
    return new Set(cleaned.split(' ').filter(Boolean));
}

function jaccard(aSet, bSet) {
    if (!aSet || !bSet) return 0;
    if (aSet.size === 0 && bSet.size === 0) return 1;
    if (aSet.size === 0 || bSet.size === 0) return 0;
    let inter = 0;
    for (const v of aSet) if (bSet.has(v)) inter++; 
    const uni = aSet.size + bSet.size - inter;
    return uni === 0 ? 0 : inter / uni;
}

const rateLimiterState = new Map(); 
async function waitRateLimit(key, minIntervalMs) {
    const now = Date.now();
    const last = rateLimiterState.get(key) || 0;
    const wait = Math.max(0, (last + minIntervalMs) - now);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    rateLimiterState.set(key, Date.now());
}

module.exports = {
    cleanCsvList,
    mergeCsvList,
    cleanMetaString,
    tokenSet,
    jaccard,
    waitRateLimit
};
