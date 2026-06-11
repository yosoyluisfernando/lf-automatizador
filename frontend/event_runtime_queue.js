(function () {
    const FINAL_STATES = new Set(['fired', 'omitted', 'cancelled']);

    function getRowsByBatch(tbody, batchId) {
        if (!tbody || !batchId) return [];
        return Array.from(tbody.querySelectorAll('tr')).filter(row => row.dataset.batchId === batchId);
    }

    function clearDelayDataset(row, { clearExecution = false } = {}) {
        if (!row) return;
        delete row.dataset.queuedAt;
        delete row.dataset.maxDelay;
        delete row.dataset.delayAction;
        if (clearExecution) delete row.dataset.clearOnExecution;
    }

    function clearDelayBatch(row, options = {}) {
        const batchId = row?.dataset?.batchId;
        const tbody = options.tbody || row?.closest?.('tbody');
        const rows = batchId ? getRowsByBatch(tbody, batchId) : (row ? [row] : []);
        rows.forEach(item => clearDelayDataset(item, options));
        return rows;
    }

    function markFinal(entry, status, label, message, setter) {
        if (!entry || FINAL_STATES.has(entry.status)) return;
        if (typeof setter === 'function') setter(entry, status, label, message);
        else {
            entry.status = status;
            entry.label = label || status.toUpperCase();
            entry.message = message || '';
            entry.updatedAt = Date.now();
        }
    }

    window.EventRuntimeQueue = {
        clearDelayDataset,
        clearDelayBatch,
        getRowsByBatch,
        markFinal,
        FINAL_STATES
    };
})();
