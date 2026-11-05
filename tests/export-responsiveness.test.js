'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ReelsExportScheduler, estimateExportBytes } = require('../electron/services/reels-export-scheduler');
const { MediaProbeQueue } = require('../electron/services/media-probe-queue');
const { ReelsExportService } = require('../electron/services/reels-export-service');
const { probeGPUEncoder, _test: probeTest } = require('../electron/services/gpu-encoder-probe');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('global scheduler applies memory/slot budgets, cancels queued jobs and releases once', async () => {
    const weight = estimateExportBytes({ width: 1080, height: 1920 });
    const scheduler = new ReelsExportScheduler({ maxActive: 4, maxBytes: weight * 2 });
    const a = await scheduler.acquire({ width: 1080, height: 1920 });
    const b = await scheduler.acquire({ width: 1080, height: 1920 });
    const controller = new AbortController(); let queued = false;
    const cancelled = scheduler.acquire({ width: 1080, height: 1920 }, { signal: controller.signal, onQueue: () => { queued = true; } });
    controller.abort(); await assert.rejects(cancelled, /__CANCELLED__/); assert.equal(queued, true);
    let started = false;
    const third = scheduler.acquire({ width: 1080, height: 1920 }).then(release => { started = true; return release; });
    await tick(); assert.equal(started, false); a(); a(); const c = await third;
    assert.equal(scheduler.active, 2); b(); c(); assert.equal(scheduler.active, 0); assert.equal(scheduler.bytes, 0);
});

test('media probes from multiple callers are bounded, deduplicated and failures do not poison retries', async () => {
    let active = 0, maximum = 0, calls = 0, fail = true;
    const queue = new MediaProbeQueue(async file => {
        calls++; maximum = Math.max(maximum, ++active); await tick(); active--;
        if (file === 'bad' && fail) throw new Error('probe failed'); return 10;
    });
    const result = await Promise.all(Array.from({ length: 50 }, (_, i) => queue.get('file-' + (i % 7))));
    assert.equal(result.length, 50); assert.equal(calls, 7); assert.ok(maximum <= 2);
    await assert.rejects(queue.get('bad'), /probe failed/); fail = false;
    assert.equal(await queue.get('bad'), 10);
});

test('GPU probing is asynchronous, shares pending results and distinguishes geometry/rate', async t => {
    probeTest.clear(); let calls = 0, heartbeat = false;
    const spawn = () => {
        calls++; const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin.end = () => setTimeout(() => child.emit('close', 0, null), 20);
        child.kill = () => child.emit('close', null, 'SIGTERM'); return child;
    };
    t.after(() => probeTest.clear());
    const a = probeGPUEncoder('fixture-ffmpeg', 'fixture-codec', ['-c:v', 'fixture'], 16, 16, 30, { spawn });
    const b = probeGPUEncoder('fixture-ffmpeg', 'fixture-codec', ['-c:v', 'fixture'], 16, 16, 30, { spawn });
    setImmediate(() => { heartbeat = true; });
    assert.deepEqual(await Promise.all([a, b]), [true, true]); assert.equal(calls, 1); assert.equal(heartbeat, true);
    await probeGPUEncoder('fixture-ffmpeg', 'fixture-codec', ['-c:v', 'fixture'], 32, 16, 30, { spawn });
    await probeGPUEncoder('fixture-ffmpeg', 'fixture-codec', ['-c:v', 'fixture'], 32, 16, 60, { spawn });
    assert.equal(calls, 3);
});

function owner(id) { const value = new EventEmitter(); value.id = id; value.isDestroyed = () => false; return value; }
test('utility service forwards ports once, reports crashes and isolates cancellation by owner', async () => {
    const child = new EventEmitter(), sent = [];
    child.postMessage = (message, ports) => {
        sent.push({ message, ports });
        if (message.type === 'init') queueMicrotask(() => child.emit('message', { type: 'ready' }));
        if (message.type === 'request' && message.action !== 'finish') queueMicrotask(() => child.emit('message', { type: 'response', id: message.id, result: message.action === 'attach' ? { ok: true } : 'session-' + message.ownerId }));
        if (message.type === 'shutdown') queueMicrotask(() => child.emit('exit', 0));
    };
    child.kill = () => child.emit('exit', 1);
    const service = new ReelsExportService({ config: {}, fork: () => child, renderAudio: async () => 'audio.wav' });
    const a = owner(1), b = owner(2);
    await service.handle(a, 'start', {}); await service.handle(b, 'start', {});
    const port = {}; let failure;
    await service.attach(b, 'session-2', port, error => { failure = error; });
    assert.deepEqual(sent.find(entry => entry.message.action === 'attach').ports, [port]);
    const waitingA = service.handle(a, 'finish', { sessionId: 'session-1' });
    const waitingB = service.handle(b, 'finish', { sessionId: 'session-2' });
    await tick(); a.emit('destroyed'); await assert.rejects(waitingA, /__CANCELLED__/);
    assert.equal(service.owners.has(2), true); assert.equal(failure, undefined);
    child.emit('exit', 9); await assert.rejects(waitingB, /后台编码服务意外退出/); assert.match(failure.message, /后台编码服务意外退出/);
    assert.equal(service.pending.size, 0); assert.equal(service.bindings.size, 0);
    await service.close();
});
