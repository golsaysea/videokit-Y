'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createReelsFrameBridge } = require('../electron/services/reels-frame-bridge');
const { createReelsFrameReceiver } = require('../electron/services/reels-frame-receiver');
const { writeEncoderFrame } = require('../electron/services/encoder-frame-write');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const producer = fs.readFileSync(path.join(__dirname, '../src/reels-frame-pipeline.js'), 'utf8');

function loadPipeline(api) {
    const context = { window: { electronAPI: api }, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, ArrayBuffer, Uint8Array, Image: class {} };
    vm.createContext(context);
    vm.runInContext(producer, context);
    return context.window.ReelsFramePipeline.create;
}

function fixture(options = {}) {
    const ipc = new EventEmitter(), main = new EventEmitter();
    const writes = [], failures = [], traces = [], aborts = [];
    let renderer, receiver, requestId;
    let frameTransfers = 0;
    main.start = () => {};
    main.close = () => queueMicrotask(() => renderer?.onclose?.());
    main.postMessage = value => {
        if (options.ackSendError && value.type === 'ack') throw new Error('injected ACK failure');
        if (options.dropAck && value.type === 'ack') return;
        const data = structuredClone(value);
        queueMicrotask(() => renderer?.onmessage?.({ data }));
    };
    ipc.invoke = async (channel, action, data) => {
        assert.equal(channel, 'reels-compose-wysiwyg');
        assert.equal(action, 'abort');
        aborts.push(data.sessionId);
        return true;
    };
    ipc.send = (channel, data) => {
        assert.equal(channel, 'reels-frame-pipeline-open');
        requestId = data.requestId;
        if (options.noReady) return;
        renderer = {
            start() {},
            close() { queueMicrotask(() => main.emit('close')); },
            postMessage(value, transfer) {
                if (transfer?.length) frameTransfers++;
                // Match Electron's unsupported transferred-ArrayBuffer case:
                // any such message loses its decodable payload.
                const data = transfer?.length ? null : structuredClone(value);
                queueMicrotask(() => main.emit('message', { data }));
            },
        };
        receiver = createReelsFrameReceiver({
            port: main, sessionId: data.sessionId, frameBytes: 16,
            writeFrame: async raw => {
                if (options.writeError) return { ok: false, error: 'injected encoder failure' };
                await delay(options.writeDelay ?? 1);
                writes.push([...new Uint8Array(raw)]);
                return { ok: true };
            },
            trace: message => traces.push(message),
            onFailure(error) {
                failures.push(error.message);
                ipc.emit('reels-frame-pipeline-failed', {}, { requestId, error: error.message });
            },
        });
        queueMicrotask(() => ipc.emit('reels-frame-pipeline-ready', { ports: [renderer] }, { requestId, ok: true }));
    };
    const bridge = createReelsFrameBridge(ipc, { openTimeoutMs: 50, ackTimeoutMs: 50, trace: message => traces.push(message), ...options.timeouts });
    const pipeline = loadPipeline({ ...bridge.api, reelsComposeWysiwyg: (action, data) => ipc.invoke('reels-compose-wysiwyg', action, data) })('session-test', 3, options.pipelineOptions);
    return { bridge, pipeline, writes, failures, traces, aborts, main, ipc, get renderer() { return renderer; }, get receiver() { return receiver; }, get frameTransfers() { return frameTransfers; } };
}

test('production bridge and receiver preserve pixels, ACK order and a bounded pipeline', async t => {
    const f = fixture({ writeDelay: 2 }); t.after(() => f.bridge.dispose());
    for (let i = 0; i < 9; i++) {
        const pixels = new Uint8Array(16).fill(i);
        await f.pipeline.send(pixels.buffer);
        assert.equal(pixels.byteLength, 16, 'pixels must not be detached');
        assert.ok(f.receiver.queued <= 3);
    }
    await f.pipeline.drain();
    assert.deepEqual(f.writes, Array.from({ length: 9 }, (_, i) => new Array(16).fill(i)));
    assert.equal(f.frameTransfers, 0);
    assert.equal(f.failures.length, 0);
    assert.ok(f.traces.some(s => s.includes('ack-recv')));
    await delay(2);
    assert.equal(f.receiver.closed, true);
});

for (const [label, options, pattern] of [
    ['missing ACK', { dropAck: true }, /ACK.*超时/],
    ['ACK send failure', { ackSendError: true }, /injected ACK failure/],
    ['encoder failure', { writeError: true }, /injected encoder failure/],
]) test(`${label} rejects export and aborts the encoder instead of hanging`, async t => {
    const f = fixture(options); t.after(() => f.bridge.dispose());
    await assert.rejects(async () => { for (let i = 0; i < 3; i++) await f.pipeline.send(new ArrayBuffer(16)); }, pattern);
    await delay(2);
    assert.ok(f.aborts.includes('session-test'));
    f.pipeline.abort(new Error('test cleanup'));
});

test('unexpected port closure rejects a frame already waiting for ACK', async t => {
    const f = fixture({ dropAck: true }); t.after(() => f.bridge.dispose());
    await f.pipeline.send(new ArrayBuffer(16));
    await f.pipeline.send(new ArrayBuffer(16));
    const third = f.pipeline.send(new ArrayBuffer(16));
    const rejection = assert.rejects(third, /断开/);
    f.renderer.onclose();
    await rejection;
    f.pipeline.abort();
});

test('undecodable frame messages use independent failure reporting', async t => {
    const f = fixture({ dropAck: true }); t.after(() => f.bridge.dispose());
    await f.pipeline.send(new ArrayBuffer(16));
    const drained = assert.rejects(f.pipeline.drain(), /无法解码/);
    f.main.emit('message', { data: null });
    await drained;
    assert.ok(f.failures.some(s => /无法解码/.test(s)));
});

test('bad sequence and partial frames stop the receiver', async t => {
    for (const payload of [{ type: 'frame', seq: 7, raw: new ArrayBuffer(16) }, { type: 'frame', seq: 1, raw: new ArrayBuffer(8) }]) {
        const f = fixture({ dropAck: true }); t.after(() => f.bridge.dispose());
        await f.pipeline.send(new ArrayBuffer(16));
        const drained = assert.rejects(f.pipeline.drain(), /序号|不完整/);
        f.main.emit('message', { data: payload });
        await drained;
    }
});

test('cancellation interrupts ACK wait and open-channel wait without legacy resend', async t => {
    for (const noReady of [false, true]) {
        let cancelled = false;
        const f = fixture({ noReady, dropAck: true, timeouts: { openTimeoutMs: 1000, ackTimeoutMs: 1000 }, pipelineOptions: { isCancelled: () => cancelled } });
        t.after(() => f.bridge.dispose());
        const work = (async () => { for (let i = 0; i < 3; i++) await f.pipeline.send(new ArrayBuffer(16)); })();
        const rejection = assert.rejects(work, /__CANCELLED__/);
        await delay(5); cancelled = true;
        await rejection;
        f.pipeline.abort();
    }
});

test('open-channel timeout is explicit and reclaims the session', async t => {
    const f = fixture({ noReady: true }); t.after(() => f.bridge.dispose());
    await assert.rejects(f.pipeline.send(new ArrayBuffer(16)), /通道超时/);
    assert.ok(f.aborts.includes('session-test'));
});

test('ACK idle timeout is renewed by actual progress', async t => {
    const f = fixture({ writeDelay: 18, timeouts: { ackTimeoutMs: 40 } }); t.after(() => f.bridge.dispose());
    for (let i = 0; i < 6; i++) await f.pipeline.send(new ArrayBuffer(16));
    await f.pipeline.drain();
    assert.equal(f.writes.length, 6);
});

function encoderFixture() {
    const stream = new EventEmitter(), proc = new EventEmitter();
    stream.writable = true; stream.on('error', () => {});
    proc.stdin = stream;
    const session = { proc, writeAbortController: new AbortController(), stderr: '' };
    const listeners = () => [stream.eventNames().map(n => [n, stream.listenerCount(n)]), proc.eventNames().map(n => [n, proc.listenerCount(n)])];
    return { session, stream, proc, listeners };
}

test('backpressure requires callback and drain, then releases all temporary listeners', async () => {
    const f = encoderFixture(); const baseline = f.listeners();
    f.stream.write = (_buffer, callback) => { queueMicrotask(() => callback()); return false; };
    let settled = false;
    const work = writeEncoderFrame(f.session, Buffer.alloc(16), 100).then(() => { settled = true; });
    await delay(5); assert.equal(settled, false);
    f.stream.emit('drain'); await work;
    assert.deepEqual(f.listeners(), baseline);
});

for (const fault of ['timeout', 'exit', 'close', 'error', 'cancel']) test(`encoder ${fault} never produces a successful ACK`, async () => {
    const f = encoderFixture(); const baseline = f.listeners();
    f.stream.write = () => false;
    const work = writeEncoderFrame(f.session, Buffer.alloc(16), fault === 'timeout' ? 15 : 500);
    const rejected = assert.rejects(work, /超时|退出|关闭|injected|CANCELLED/);
    if (fault === 'exit') f.proc.emit('exit', 1, null);
    if (fault === 'close') f.stream.emit('close');
    if (fault === 'error') f.stream.emit('error', new Error('injected stream error'));
    if (fault === 'cancel') f.session.writeAbortController.abort(new Error('__CANCELLED__'));
    await rejected;
    assert.deepEqual(f.listeners(), baseline);
});
