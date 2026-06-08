const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadBrowserGlobal(file, globalName) {
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    return context.window[globalName];
}

test('event rules normalize incompatible execution combinations', () => {
    const rules = loadBrowserGlobal('frontend/event_execution_rules.js', 'EventExecutionRules');

    const appendEnd = rules.normalizeEventConfig({
        action: 'append-end',
        execution: 'max-delay',
        requirePlaying: false,
        maxDelayActive: true,
        maxDelayMinutes: 2,
        maxDelaySeconds: 30
    });
    assert.equal(appendEnd.action, 'append-end');
    assert.equal(appendEnd.execution, 'wait');
    assert.equal(appendEnd.requirePlaying, false);
    assert.equal(appendEnd.maxDelayActive, false);
    assert.equal(appendEnd.maxDelayMinutes, 0);
    assert.equal(appendEnd.maxDelaySeconds, 0);

    const omitDelay = rules.normalizeEventConfig({
        action: 'add',
        execution: 'max-delay',
        requirePlaying: false,
        maxDelayActive: true,
        maxDelayMinutes: 0,
        maxDelaySeconds: 10,
        maxDelayAction: 'omit'
    });
    assert.equal(omitDelay.requirePlaying, true);
    assert.equal(rules.canExecuteWhenStopped(omitDelay), false);

    const legacyDelay = rules.normalizeEventConfig({
        action: 'add',
        execution: 'wait',
        maxDelayActive: true,
        maxDelayMinutes: 1,
        maxDelaySeconds: 15,
        maxDelayAction: 'force'
    });
    assert.equal(legacyDelay.execution, 'max-delay');
    assert.equal(legacyDelay.maxDelayActive, true);
    assert.equal(legacyDelay.maxDelayAction, 'force');

    const streamClear = rules.normalizeEventConfig({
        sourceType: 'stream_url',
        action: 'clear',
        execution: 'max-delay',
        maxDelayActive: true,
        maxDelayAction: 'omit'
    });
    assert.equal(streamClear.action, 'clear');
});

test('event air state includes auxiliary Rust players', () => {
    const airState = loadBrowserGlobal('frontend/event_air_state.js', 'EventAirState');
    assert.equal(airState.isAuxiliaryOnAir({
        players: [
            { id: 'aux1-main', status: 'playing', audioReady: true },
            { id: 'pl1-main', status: 'stopped', audioReady: true }
        ]
    }), true);
    assert.equal(airState.isAuxiliaryOnAir({
        players: [{ id: 'aux2-main', status: 'stopped', audioReady: true }]
    }), false);
});

test('event runtime queue clears tolerance state for a full batch', () => {
    const runtime = loadBrowserGlobal('frontend/event_runtime_queue.js', 'EventRuntimeQueue');
    const rows = [
        { dataset: { batchId: 'b1', queuedAt: '1', maxDelay: '10', delayAction: 'force', clearOnExecution: 'true' } },
        { dataset: { batchId: 'b1', queuedAt: '1', maxDelay: '10', delayAction: 'force', clearOnExecution: 'true' } }
    ];
    const tbody = { querySelectorAll: () => rows };
    rows.forEach(row => { row.closest = () => tbody; });

    runtime.clearDelayBatch(rows[0], { clearExecution: false });

    assert.equal(rows[0].dataset.queuedAt, undefined);
    assert.equal(rows[1].dataset.maxDelay, undefined);
    assert.equal(rows[0].dataset.clearOnExecution, 'true');
});
