'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function helper() {
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/reels-scroll-timing.js'), 'utf8'), context);
    return context.window.ReelsScrollTiming;
}

test('automatic endings follow each task and never copy another task duration', () => {
    const timing = helper();
    const tasks = [30, 45, 60].map((n, i) => ({ audioPath: 'p' + i }));
    const cache = { p0: 30, p1: 45, p2: 60 };
    const overlays = tasks.map(() => ({ type: 'scroll', end: 9999, scroll_end_auto: true }));
    assert.deepEqual(overlays.map((ov, i) => timing.end(ov, tasks[i], { mediaDurations: cache })), [30, 45, 60]);
    overlays[0].end = 20; overlays[0].scroll_end_auto = false;
    assert.deepEqual(overlays.map((ov, i) => timing.end(ov, tasks[i], { mediaDurations: cache })), [20, 45, 60]);
    timing.reset(overlays[0]);
    assert.deepEqual(overlays.map((ov, i) => timing.end(ov, tasks[i], { mediaDurations: cache })), [30, 45, 60]);
});

test('audio speed and explicit export duration resolve correctly', () => {
    const timing = helper();
    const task = { audioPath: 'a', audioDurScale: 150 };
    assert.equal(timing.duration(task, { mediaDurations: { a: 20 } }), 30);
    assert.equal(timing.duration(null, { bodyDuration: 37.2 }), 37.2);
    const copy = timing.renderingOverlay({ type: 'scroll', end: 9999, scroll_end_auto: true }, null, { bodyDuration: 37.2 });
    assert.equal(copy.end, 37.2);
});

test('manual duration and display ranges never get replaced', () => {
    const timing = helper();
    const task = { audioPath: 'a' };
    const manual = { type: 'scroll', scroll_end_auto: false, end: 12 };
    assert.equal(timing.end(manual, task, { mediaDurations: { a: 60 } }), 12);
    const multi = { type: 'scroll', scroll_end_auto: true, end: 25, display_ranges: [{ start: 3, end: 25 }] };
    assert.equal(timing.end(multi, task, { mediaDurations: { a: 60 } }), 25);
    assert.equal(timing.renderingOverlay(multi, task, { mediaDurations: { a: 60 } }), multi);
});

test('unknown metadata keeps unresolved auto sentinel instead of arbitrary fallback', () => {
    const timing = helper();
    const ov = { type: 'scroll', scroll_end_auto: true, end: 9999 };
    assert.equal(timing.end(ov, { audioPath: 'not-cached' }, { mediaDurations: {} }), 9999);
});
