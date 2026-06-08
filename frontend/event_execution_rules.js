(function () {
    const ACTIONS = new Set(['add', 'temp', 'clear', 'append-end', 'ducking']);
    const EXECUTIONS = new Set(['interrupt', 'wait', 'max-delay']);
    const MAX_DELAY_ACTIONS = new Set(['force', 'omit']);
    const DUCKING_SOURCES = new Set(['file', 'locution']);

    function clampInt(value, min, max, fallback = min) {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    function normalizeAction(action, sourceType = 'file') {
        let next = ACTIONS.has(action) ? action : 'add';
        if (next === 'ducking' && !DUCKING_SOURCES.has(sourceType)) next = 'add';
        return next;
    }

    function normalizeExecution(action, execution) {
        if (action === 'append-end' || action === 'ducking') return 'wait';
        return EXECUTIONS.has(execution) ? execution : 'interrupt';
    }

    function normalizeMaxDelayAction(action) {
        return MAX_DELAY_ACTIONS.has(action) ? action : 'omit';
    }

    function normalizeEventConfig(eventObj = {}) {
        const sourceType = eventObj.sourceType || 'file';
        const action = normalizeAction(eventObj.action, sourceType);
        const rawExecution = eventObj.maxDelayActive === true && eventObj.execution === 'wait'
            ? 'max-delay'
            : eventObj.execution;
        const execution = normalizeExecution(action, rawExecution);
        const maxDelayActive = execution === 'max-delay' && eventObj.maxDelayActive !== false;
        const minutes = maxDelayActive ? clampInt(eventObj.maxDelayMinutes, 0, 9999, 0) : 0;
        const seconds = maxDelayActive ? clampInt(eventObj.maxDelaySeconds, 0, 59, 0) : 0;
        const totalSeconds = (minutes * 60) + seconds;
        const maxDelayAction = maxDelayActive ? normalizeMaxDelayAction(eventObj.maxDelayAction) : 'omit';
        const requirePlaying = maxDelayActive && maxDelayAction === 'omit'
            ? true
            : eventObj.requirePlaying === true;
        return {
            ...eventObj,
            action,
            execution,
            requirePlaying,
            maxDelayActive,
            maxDelayMinutes: minutes,
            maxDelaySeconds: seconds,
            maxDelayTime: maxDelayActive ? Math.floor(totalSeconds / 60) : 0,
            maxDelayAction,
            eventDuckingVolume: clampInt(eventObj.eventDuckingVolume, 0, 100, 20),
            eventDuckingFade: clampInt(eventObj.eventDuckingFade, 0, 5000, 500)
        };
    }

    function canExecuteWhenStopped(eventObj = {}) {
        return eventObj.requirePlaying !== true;
    }

    function getTrigger(options = {}) {
        if (options.trigger) return options.trigger;
        if (options.manual) return 'manual-button';
        if (options.playlistCommand) return 'playlist-command';
        return 'auto-schedule';
    }

    window.EventExecutionRules = {
        normalizeAction,
        normalizeExecution,
        normalizeMaxDelayAction,
        normalizeEventConfig,
        canExecuteWhenStopped,
        getTrigger
    };
})();
