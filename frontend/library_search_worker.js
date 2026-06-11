'use strict';

// Hilo de búsqueda de la biblioteca. La interfaz gráfica nunca debe ejecutar
// la búsqueda difusa (Fuse + Levenshtein) sobre miles de pistas en su propio
// hilo: bloquea el repintado y la ventana "se congela". Este worker mantiene
// el índice en memoria y responde consultas; el renderer solo envía la lista
// (al cambiar) y recibe rutas ordenadas por relevancia.

const { parentPort } = require('worker_threads');
const { createSearchSession } = require('./library_search_shared');

let session = null;

parentPort.on('message', (message = {}) => {
    if (message.type === 'index') {
        session = createSearchSession(Array.isArray(message.tracks) ? message.tracks : []);
        parentPort.postMessage({ type: 'indexed', count: session.size });
        return;
    }
    if (message.type === 'search') {
        const items = session ? session.search(message.query || '') : [];
        parentPort.postMessage({
            type: 'results',
            seq: message.seq,
            paths: items.map(item => item.fullPath).filter(Boolean)
        });
    }
});
