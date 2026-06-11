'use strict';

const path = require('path');
const Fuse = require('fuse.js');

function normalizeSearchText(value = '') {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function defaultTitleForItem(item = {}) {
    const title = item.title || item.customTitle || '';
    const artist = item.artist || item.customArtist || '';
    if (title && artist) return `${artist} - ${title}`;
    const filePath = item.fullPath || item.filePath || '';
    return title || path.basename(filePath, path.extname(filePath)) || path.basename(filePath) || '';
}

function buildSearchItem(item = {}, titleBuilder = defaultTitleForItem) {
    const filePath = item.fullPath || item.filePath || '';
    const title = titleBuilder(item);
    return {
        ...item,
        displayTitle: title,
        searchTitle: normalizeSearchText(item.title || item.customTitle || title),
        searchArtist: normalizeSearchText(item.artist || item.customArtist),
        searchGenre: normalizeSearchText(item.genre || item.primaryGenre || item.subgenre),
        searchAlbum: normalizeSearchText(item.album),
        searchCountry: normalizeSearchText(item.artistCountry || item.artistCountryCode),
        searchYear: normalizeSearchText(item.year),
        searchPath: normalizeSearchText(filePath)
    };
}

function tokenizeSearchText(value = '') {
    return normalizeSearchText(value)
        .split(/[^a-z0-9]+/i)
        .map(token => token.trim())
        .filter(token => token.length >= 2);
}

function levenshteinDistance(a = '', b = '') {
    if (a === b) return 0;
    if (!a) return b.length;
    if (!b) return a.length;
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    const current = Array.from({ length: b.length + 1 }, () => 0);
    for (let i = 1; i <= a.length; i += 1) {
        current[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + cost
            );
        }
        for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
    }
    return previous[b.length];
}

function allowedTypoDistance(token = '') {
    if (token.length <= 3) return 0;
    if (token.length <= 5) return 1;
    return 2;
}

function searchableTextForItem(item = {}) {
    return [
        item.searchTitle,
        item.searchArtist,
        item.searchAlbum,
        item.searchGenre,
        item.searchCountry,
        item.searchYear,
        item.searchPath
    ].filter(Boolean).join(' ');
}

function tokenMatchesWord(token, words = []) {
    if (!token) return false;
    return words.some(word => {
        if (!word) return false;
        if (word.includes(token)) return true;
        if (Math.abs(word.length - token.length) > allowedTypoDistance(token)) return false;
        return levenshteinDistance(token, word) <= allowedTypoDistance(token);
    });
}

function classifySearchMatch(item = {}, cleanQuery = '', queryTokens = []) {
    const title = item.searchTitle || '';
    const artist = item.searchArtist || '';
    const strongText = [title, artist, item.searchAlbum, item.searchGenre].filter(Boolean).join(' ');
    const allText = searchableTextForItem(item);
    const words = tokenizeSearchText(strongText);

    if (title.includes(cleanQuery)) return { matched: true, rank: 0 };
    if (artist.includes(cleanQuery)) return { matched: true, rank: 1 };
    if (strongText.includes(cleanQuery)) return { matched: true, rank: 2 };
    if (allText.includes(cleanQuery)) return { matched: true, rank: 3 };

    if (queryTokens.length > 0 && queryTokens.every(token => tokenMatchesWord(token, words))) {
        return { matched: true, rank: 4 };
    }

    return { matched: false, rank: 99 };
}

function buildFuseOptions(options = {}) {
    return {
        keys: options.keys || [
            { name: 'searchTitle', weight: 0.38 },
            { name: 'searchArtist', weight: 0.24 },
            { name: 'searchGenre', weight: 0.16 },
            { name: 'searchCountry', weight: 0.10 },
            { name: 'searchPath', weight: 0.12 }
        ],
        threshold: Number.isFinite(options.threshold) ? options.threshold : 0.34,
        ignoreLocation: true,
        includeScore: options.includeScore === true,
        useExtendedSearch: false,
        ignoreDiacritics: true
    };
}

function createFuseEngine(items = [], options = {}) {
    const titleBuilder = typeof options.titleBuilder === 'function' ? options.titleBuilder : defaultTitleForItem;
    const fuseItems = (Array.isArray(items) ? items : []).map(item => buildSearchItem(item, titleBuilder));
    return new Fuse(fuseItems, buildFuseOptions(options));
}

// Sesión con índice precalculado: construir el índice de Fuse es O(n) y no debe
// repetirse en cada tecleo. Quien busca repetidamente sobre la misma lista
// (p. ej. el worker de la biblioteca) crea una sesión y reutiliza el índice.
function createSearchSession(items = [], options = {}) {
    const titleBuilder = typeof options.titleBuilder === 'function' ? options.titleBuilder : defaultTitleForItem;
    const sourceItems = Array.isArray(items) ? items : [];
    const searchItems = sourceItems.map(item => buildSearchItem(item, titleBuilder));
    const fuse = new Fuse(searchItems, { ...buildFuseOptions(options), includeScore: true });

    return {
        size: sourceItems.length,
        search(query = '') {
            const cleanQuery = normalizeSearchText(query);
            if (!cleanQuery) return [...searchItems];
            const queryTokens = tokenizeSearchText(cleanQuery);
            const scoreLimit = Number.isFinite(options.scoreLimit)
                ? options.scoreLimit
                : (cleanQuery.length >= 5 ? 0.18 : 0.34);

            return fuse.search(cleanQuery)
                .map((result, index) => {
                    const match = classifySearchMatch(result.item, cleanQuery, queryTokens);
                    const score = Number.isFinite(result.score) ? result.score : 1;
                    const matched = match.matched || score <= scoreLimit;
                    return { item: result.item, matched, rank: match.matched ? match.rank : 8, score, index };
                })
                .filter(result => result.matched)
                .sort((a, b) => (a.rank - b.rank) || (a.score - b.score) || (a.index - b.index))
                .map(result => result.item);
        }
    };
}

function fuzzySearch(items = [], query = '', options = {}) {
    return createSearchSession(items, options).search(query);
}

module.exports = {
    normalizeSearchText,
    buildSearchItem,
    createFuseEngine,
    createSearchSession,
    fuzzySearch
};
