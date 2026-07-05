const CommercialSchedule = (() => {
    const Data = CommercialData;
    const days = [['Dom', 0], ['Lun', 1], ['Mar', 2], ['Mie', 3], ['Jue', 4], ['Vie', 5], ['Sab', 6]];

    function timesFromConfig(state) {
        const cfg = Data.normalizeScheduleConfig(state.scheduleConfig);
        const times = [];
        cfg.hours.forEach(hour => {
            cfg.minutes.forEach(minute => times.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`));
        });
        return [...new Set(times)].sort();
    }

    function selectedPaths(state) {
        return [...state.selectedAssetPaths];
    }

    function ruleFor(state, assetPath) {
        return state.airRules.find(rule => rule.assetPath === assetPath) || null;
    }

    function slotState(state, day, time) {
        const selected = selectedPaths(state);
        if (!selected.length) return summaryState(state, day, time);
        const count = selected.filter(path => {
            const rule = ruleFor(state, path);
            return (rule?.daySlots?.[String(day)] || []).includes(time);
        }).length;
        if (count === 0) return { mark: 'none', label: '' };
        if (count === selected.length) return { mark: 'all', label: String(count) };
        return { mark: 'partial', label: `${count}/${selected.length}` };
    }

    function summaryState(state, day, time) {
        const count = state.airRules.filter(rule => rule.enabled && (rule.daySlots?.[String(day)] || []).includes(time)).length;
        return { mark: count ? 'summary' : 'none', label: count ? String(count) : '' };
    }

    function renderGrid(state, handlers) {
        const host = document.getElementById('schedule-grid');
        const head = document.querySelector('.schedule-head');
        const summary = document.getElementById('schedule-summary');
        const times = timesFromConfig(state);
        renderHead(head, times, handlers);
        host.replaceChildren();
        summary.textContent = state.mode === 'editor'
            ? `${selectedPaths(state).length} seleccionado(s) - click marca/desmarca`
            : 'Modo visor - click muestra la tanda';

        times.forEach(time => {
            const row = document.createElement('div');
            row.className = 'schedule-row';
            const hour = document.createElement('div');
            hour.className = 'hour-cell';
            hour.textContent = time;
            hour.title = 'Doble click: marcar/desmarcar esta hora en todos los dias';
            hour.addEventListener('dblclick', event => {
                event.preventDefault();
                handlers.onTimeDoubleClick(time);
            });
            row.appendChild(hour);
            days.forEach(([label, day]) => row.appendChild(cell(state, label, day, time, handlers)));
            host.appendChild(row);
        });
    }

    function renderHead(head, times, handlers) {
        head.replaceChildren();
        const hour = document.createElement('div');
        hour.textContent = 'Hora';
        head.appendChild(hour);
        days.forEach(([label, day]) => {
            const node = document.createElement('div');
            node.textContent = label;
            node.title = 'Doble click: marcar/desmarcar todo el dia';
            node.addEventListener('dblclick', event => {
                event.preventDefault();
                handlers.onDayDoubleClick(day, times);
            });
            head.appendChild(node);
        });
    }

    function cell(state, label, day, time, handlers) {
        const info = slotState(state, day, time);
        const node = document.createElement('div');
        node.className = `schedule-slot ${info.mark}`;
        if (state.selectedSlot?.day === day && state.selectedSlot?.time === time) node.classList.add('selected');
        node.innerHTML = info.label
            ? `<span class="slot-count">${Data.esc(info.label)}</span><span>${Data.esc(label)}</span>`
            : '<span>+</span>';
        node.addEventListener('click', () => handlers.onCellClick(day, time));
        return node;
    }

    return { renderGrid, timesFromConfig };
})();
