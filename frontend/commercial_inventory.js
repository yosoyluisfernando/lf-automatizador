const CommercialInventory = (() => {
    const Data = CommercialData;

    function visibleAssets(state) {
        const search = (state.filters.search || '').toLowerCase();
        return state.assets.filter(asset => {
            if (state.filters.kind === 'commercials' && Data.isJingle(asset)) return false;
            if (state.filters.kind === 'jingles' && !Data.isJingle(asset)) return false;
            if (state.filters.status !== 'all' && Data.assetStatus(asset) !== state.filters.status) return false;
            if (!search) return true;
            return [
                asset.title,
                asset.clientName,
                asset.campaignName,
                asset.filePath,
                asset.category,
                asset.commercialType
            ].some(value => String(value || '').toLowerCase().includes(search));
        });
    }

    function statusText(status) {
        return {
            active: 'Vigente',
            draft: 'Sin datos',
            upcoming: 'Futuro',
            expiring: 'Por vencer',
            expired: 'Vencido',
            paused: 'Pausado'
        }[status] || status || 'Sin datos';
    }

    function renderRoot(settings) {
        const node = document.getElementById('root-summary');
        const root = settings?.commercialsRoot || '';
        node.textContent = root ? `Raíz: ${root}` : 'Sin carpeta de comerciales configurada';
        node.title = root;
    }

    function render(state, handlers) {
        renderRoot(state.settings);
        const host = document.getElementById('inventory-list');
        const empty = document.getElementById('inventory-empty');
        const count = document.getElementById('count-text');
        const assets = visibleAssets(state);

        host.replaceChildren();
        count.textContent = `${assets.length} elemento(s)`;
        empty.style.display = assets.length ? 'none' : 'block';

        assets.forEach(asset => {
            const card = document.createElement('div');
            const status = Data.assetStatus(asset);
            const kindClass = Data.isJingle(asset) ? 'jingle' : 'commercial';
            const selected = state.selectedAssetPaths.has(asset.filePath);
            card.className = `asset-card ${kindClass} ${status} ${selected ? 'selected' : ''}`;
            card.draggable = true;
            card.innerHTML = `
                <div class="asset-main">
                    <div class="asset-title" title="${Data.esc(asset.filePath)}">${Data.esc(Data.assetTitle(asset))}</div>
                    <span class="badge">${Data.esc(Data.typeLabel(asset))}</span>
                </div>
                <div class="asset-meta">
                    <span>${Data.esc(statusText(status))}</span>
                    <span>${Data.secondsToClock(asset.duration)}</span>
                </div>`;
            card.addEventListener('dblclick', () => Data.preview(asset.filePath));
            card.addEventListener('dragstart', event => {
                const selectedAssets = state.assets.filter(item => state.selectedAssetPaths.has(item.filePath));
                const payload = selectedAssets.length && selected ? selectedAssets : [asset];
                event.dataTransfer.setData('application/json', JSON.stringify(payload));
                event.dataTransfer.effectAllowed = 'copy';
            });
            card.addEventListener('click', event => handlers.onAssetClick(asset, event));
            host.appendChild(card);
        });
    }

    function bindDropzone(handlers) {
        const panel = document.querySelector('.inventory-panel');
        panel.addEventListener('dragover', event => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        });
        panel.addEventListener('drop', event => {
            event.preventDefault();
            handlers.onFilesDropped(Data.audioPathsFromFileList(event.dataTransfer.files));
        });
    }

    return { render, bindDropzone };
})();
