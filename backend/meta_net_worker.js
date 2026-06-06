const { parentPort } = require('worker_threads');
const path = require('path');
const db = require('../database');

let queue = [];
let active = 0;
let cancelled = false;
const MAX_CONCURRENT = 5;
const rateLimiterState = new Map();

async function waitRateLimit(key, minIntervalMs) {
    const now = Date.now();
    const last = rateLimiterState.get(key) || 0;
    const wait = Math.max(0, (last + minIntervalMs) - now);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    rateLimiterState.set(key, Date.now());
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
    return cleaned ? new Set(cleaned.split(' ').filter(Boolean)) : new Set();
}

function jaccard(aSet, bSet) {
    if (!aSet || !bSet) return 0;
    if (aSet.size === 0 && bSet.size === 0) return 1;
    if (aSet.size === 0 || bSet.size === 0) return 0;
    let inter = 0;
    for (const value of aSet) if (bSet.has(value)) inter++;
    const uni = aSet.size + bSet.size - inter;
    return uni === 0 ? 0 : inter / uni;
}

function toDisplayArtist(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseFeatList(featValue) {
    if (!featValue) return [];
    if (Array.isArray(featValue)) return featValue.map(toDisplayArtist).filter(Boolean);
    return String(featValue).split(/\s*(?:,|;|\||\/|\\|\s+x\s+|\s+y\s+|\s+vs\.?\s+|&)\s*/i).map(toDisplayArtist).filter(Boolean);
}

function parseTitleAndArtist(rawArtist, rawTitle) {
    let artist = (rawArtist || '').trim();
    let title = (rawTitle || '').trim();
    let feats = [];
    let isRemix = false;
    const remixMatch = title.match(/[\(\[]?\s*(?:official\s+)?(?:remix|mix|rmx)\s*[\)\]]?/i);
    if (remixMatch) { isRemix = true; title = title.replace(remixMatch[0], '').trim(); }
    const remixArtistMatch = artist.match(/[\(\[]?\s*(?:official\s+)?(?:remix|mix|rmx)\s*[\)\]]?/i);
    if (remixArtistMatch) { isRemix = true; artist = artist.replace(remixArtistMatch[0], '').trim(); }
    const featInTitleMatch = title.match(/[\(\[]?(?:feat\.?|ft\.?|featuring)\s+([^()\[\]]+)[\)\]]?/i);
    if (featInTitleMatch) { feats.push(...parseFeatList(featInTitleMatch[1])); title = title.replace(featInTitleMatch[0], '').trim(); }
    const featInArtistMatch = artist.match(/(?:feat\.?|ft\.?|featuring)\s+(.+)/i);
    if (featInArtistMatch) { feats.push(...parseFeatList(featInArtistMatch[1])); artist = artist.replace(featInArtistMatch[0], '').trim(); }
    feats = [...new Set(feats.filter(Boolean))];
    title = title.replace(/\(\s*\)|\[\s*\]/g, '').replace(/-\s*$/, '').trim();
    return { artist, title, feats, isRemix };
}

function postResult(payload) {
    parentPort.postMessage({ type: 'result', payload });
}

function postFinished() {
    parentPort.postMessage({ type: 'finished' });
}

async function processTask(task) {
    const trackData = db.prepare("SELECT custom_title, custom_artist FROM tracks WHERE file_path = ?").get(task.filePath);
    const baseName = path.basename(task.filePath, path.extname(task.filePath)).replace(/[-_]/g, ' ');
    const rawTitle = (trackData?.custom_title || '').trim() || '';
    const rawArtist = (trackData?.custom_artist || '').trim() || '';
    const parsed = parseTitleAndArtist(rawArtist, rawTitle);
    let query = `${parsed.artist} ${parsed.title}`.trim();
    if (!query) query = baseName;

    let resultData = null;
    const expectedTokens = tokenSet(`${parsed.artist} ${parsed.title}`.trim() || baseName);
    const minScore = 0.55;

    try {
        await waitRateLimit('musicbrainz', 1100);
        let mbQuery = query;
        if (parsed.artist && parsed.title) mbQuery = `artist:"${parsed.artist}" AND recording:"${parsed.title}"`;
        const mbUrl = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(mbQuery)}&fmt=json&limit=5`;
        const mbResponse = await fetch(mbUrl, { headers: { 'User-Agent': 'LF_Automatizador/1.0 ( luisfernando@local )' } });
        if (mbResponse.ok) {
            const mbData = await mbResponse.json();
            if (mbData.recordings && mbData.recordings.length > 0) {
                let best = null;
                let bestScore = -1;
                for (const rec of mbData.recordings) {
                    const candTitle = rec.title || '';
                    const candArtist = rec['artist-credit']?.[0]?.name || '';
                    const score = jaccard(expectedTokens, tokenSet(`${candArtist} ${candTitle}`));
                    if (score > bestScore) {
                        bestScore = score;
                        best = rec;
                    }
                }
                if (best && bestScore >= minScore) {
                    resultData = {
                        title: best.title || '',
                        artist: best['artist-credit']?.[0]?.name || '',
                        album: best.releases?.[0]?.title || '',
                        year: best.releases?.[0]?.date ? best.releases[0].date.substring(0, 4) : ''
                    };
                }
            }
        }
    } catch (err) {}

    if (!resultData || !resultData.year || !resultData.album) {
        try {
            await waitRateLimit('itunes', 200);
            const itUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=5`;
            const itResponse = await fetch(itUrl);
            if (itResponse.ok) {
                const itData = await itResponse.json();
                if (itData.results && itData.results.length > 0) {
                    let best = null;
                    let bestScore = -1;
                    for (const rec of itData.results) {
                        const candTitle = rec.trackName || '';
                        const candArtist = rec.artistName || '';
                        const score = jaccard(expectedTokens, tokenSet(`${candArtist} ${candTitle}`));
                        if (score > bestScore) {
                            bestScore = score;
                            best = rec;
                        }
                    }
                    if (best && bestScore >= minScore) {
                        resultData = {
                            title: resultData?.title || best.trackName || '',
                            artist: resultData?.artist || best.artistName || '',
                            album: resultData?.album || best.collectionName || '',
                            year: resultData?.year || (best.releaseDate ? best.releaseDate.substring(0, 4) : ''),
                            genre: best.primaryGenreName || ''
                        };
                    }
                }
            }
        } catch (err) {}
    }

    if (resultData) {
        const parsedRes = parseTitleAndArtist(resultData.artist, resultData.title);
        const featsJson = parsedRes.feats.length > 0 ? JSON.stringify(parsedRes.feats) : null;
        const force = task.forceOverwrite ? 1 : 0;
        const finalRemix = (parsedRes.isRemix || parsed.isRemix) ? 1 : 0;
        db.prepare(`INSERT INTO tracks (file_path, custom_title, custom_artist, feat, is_remix, album, year, genre) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET custom_title = CASE WHEN ?=1 THEN excluded.custom_title ELSE COALESCE(NULLIF(tracks.custom_title, ''), excluded.custom_title) END, custom_artist = CASE WHEN ?=1 THEN excluded.custom_artist ELSE COALESCE(NULLIF(tracks.custom_artist, ''), excluded.custom_artist) END, feat = CASE WHEN ?=1 THEN excluded.feat ELSE COALESCE(NULLIF(tracks.feat, ''), excluded.feat) END, is_remix = CASE WHEN ?=1 THEN excluded.is_remix ELSE COALESCE(NULLIF(tracks.is_remix, ''), excluded.is_remix) END, album = CASE WHEN ?=1 THEN excluded.album ELSE COALESCE(NULLIF(tracks.album, ''), excluded.album) END, year = CASE WHEN ?=1 THEN excluded.year ELSE COALESCE(NULLIF(tracks.year, ''), excluded.year) END, genre = CASE WHEN ?=1 THEN excluded.genre ELSE COALESCE(NULLIF(tracks.genre, ''), excluded.genre) END`).run(task.filePath, parsedRes.title, parsedRes.artist, featsJson, finalRemix, resultData.album, resultData.year, resultData.genre || '', force, force, force, force, force, force, force);
    }

    const updated = db.prepare("SELECT custom_title, custom_artist, feat, is_remix, album, year, genre FROM tracks WHERE file_path=?").get(task.filePath);
    return { success: !!resultData, filePath: task.filePath, data: updated };
}

function pump() {
    if (cancelled) {
        if (active === 0) postFinished();
        return;
    }
    while (active < MAX_CONCURRENT && queue.length > 0) {
        const task = queue.shift();
        active++;
        processTask(task)
            .then(result => postResult(result))
            .catch(err => postResult({ success: false, filePath: task?.filePath, error: err.message }))
            .finally(() => {
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
        return;
    }
    if (message?.action === 'start') {
        cancelled = false;
        queue = Array.isArray(message.tasks) ? message.tasks : [];
        pump();
    }
});
