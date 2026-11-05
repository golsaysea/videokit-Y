'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { ReelsExportScheduler } = require('../electron/services/reels-export-scheduler');
const { verifyPortableRuntime, REQUIRED } = require('../scripts/verify-packaged-runtime.cjs');
const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('portable validation rejects the released missing-Python layout before distribution', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vkk-runtime-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const file of REQUIRED.filter(file => !file.includes('python'))) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), 'fixture');
    }
    await assert.rejects(verifyPortableRuntime(dir, { platform: 'linux' }), /vendor\/python\/python.exe/);
    for (const file of REQUIRED.filter(file => file.includes('python'))) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), 'fixture');
    }
    let executed = false;
    const report = await verifyPortableRuntime(dir, { platform: 'win32', execFile(exe, args, opts, cb) {
        executed = true; assert.equal(exe, path.join(dir, 'vendor/python/python.exe'));
        assert.match(args[2], /import ctypes/); cb(null);
    } });
    assert.equal(executed, true); assert.equal(report.embeddedPython, true);
    await assert.rejects(verifyPortableRuntime(dir, { platform: 'win32', execFile(_exe, _args, _opts, cb) {
        cb(new Error('DLL load failed'));
    } }), /DLL load failed/);
});

test('missing embedded Python produces an actionable error without spawning a doomed helper', async () => {
    const module = { exports: {} }; let spawned = false;
    const builtin = name => name === 'fs' ? { existsSync: () => false }
        : name === 'child_process' ? { spawn() { spawned = true; throw Error('unexpected spawn'); } } : require(name);
    vm.runInNewContext(fs.readFileSync(path.join(root, 'resources/export-cpu-budget.js'), 'utf8'), {
        module, exports: module.exports, require: builtin, __dirname: path.join(root, 'missing-resources'),
        process: { platform: 'win32' }, setTimeout, clearTimeout,
    });
    await assert.rejects(module.exports.assign(1234), error => error.code === 'EXPORT_RUNTIME_MISSING' && /缺少内置 Python/.test(error.message));
    assert.equal(spawned, false);
});

function isolatedFixture(t, budget = { assign: async () => {} }) {
    const text = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
    const begin = text.indexOf("    handleTrusted('isolated-wysiwyg-export', async");
    const end = text.indexOf('    // IPC: 视频首尾拼接', begin);
    assert.ok(begin >= 0 && end > begin);
    const ipc = new EventEmitter(), handlers = new Map(), windows = [], cancelled = [];
    let nextId = 100;
    class Window {
        constructor() {
            this.closed = false; this.webContents = new EventEmitter();
            this.webContents.id = ++nextId; this.webContents.getOSProcessId = () => this.webContents.id;
            this.sent = []; this.webContents.send = (...args) => this.sent.push(args); windows.push(this);
        }
        isDestroyed() { return this.closed; }
        destroy() { this.closed = true; }
        loadFile() { return Promise.resolve(); }
    }
    const owner = new EventEmitter(); owner.isDestroyed = () => false; owner.send = () => {};
    const scheduler = new ReelsExportScheduler({ maxActive: 1, maxBytes: 1024 * 1024 * 1024 });
    const jobs = new Map(), renderers = new Map();
    vm.runInNewContext(text.slice(begin, end), {
        handleTrusted: (name, fn) => handlers.set(name, fn), assertTrustedRenderer() {},
        isolatedReelsRenderers: renderers, isolatedReelsJobs: jobs, reelsExportScheduler: scheduler,
        reelsExportService: { cancelOwner: id => cancelled.push(id) },
        AbortController, Map, Promise, Date, String, Error, Number, Math, setTimeout, clearTimeout,
        ipcMain: ipc, BrowserWindow: Window, app: { isPackaged: false }, path, fs,
        process: {}, __dirname: path.join(root, 'electron'), require: () => budget,
        log() {}, writeRendererCrashReport: () => null,
    });
    t.after(() => owner.emit('destroyed'));
    const run = requestId => handlers.get('isolated-wysiwyg-export')({ sender: owner }, { requestId, params: {} });
    return { run, owner, windows, ipc, scheduler, jobs, renderers, cancelled };
}

test('production isolated handler retains its budget and cancellation registration until settlement', async t => {
    const f = isolatedFixture(t), pending = f.run('first'); await tick();
    assert.equal(f.scheduler.active, 1); assert.equal(f.jobs.size, 1);
    const win = f.windows[0];
    f.ipc.emit('isolated-wysiwyg-ready', { sender: win.webContents }); await tick();
    assert.equal(win.sent[0][0], 'isolated-wysiwyg-run'); assert.equal(f.scheduler.active, 1);
    f.ipc.emit('isolated-wysiwyg-result', { sender: win.webContents }, { success: true, result: { output_path: 'done.mp4' } });
    const result = await pending;
    assert.equal(result.output_path, 'done.mp4'); assert.equal(f.scheduler.active, 0);
    assert.equal(f.jobs.size, 0); assert.equal(f.renderers.size, 0);
    assert.deepEqual(f.cancelled, [win.webContents.id]); assert.equal(f.owner.listenerCount('destroyed'), 0);
});

test('production handler cancels active and queued exports promptly and permits restart', async t => {
    const f = isolatedFixture(t), a = f.run('active'); await tick();
    const b = f.run('queued'); await tick();
    assert.equal(f.windows.length, 1); assert.equal(f.scheduler.queue.length, 1);
    f.ipc.emit('cancel-isolated-wysiwyg-export', { sender: f.owner }, 'queued');
    assert.equal((await b).cancelled, true); assert.equal(f.scheduler.active, 1);
    f.ipc.emit('cancel-isolated-wysiwyg-export', { sender: f.owner }, 'active');
    assert.equal((await a).cancelled, true); assert.equal(f.scheduler.active, 0);
    const c = f.run('restart'); await tick();
    assert.equal(f.windows.length, 2);
    f.owner.emit('destroyed'); assert.equal((await c).cancelled, true);
    assert.equal(f.scheduler.active, 0); assert.equal(f.jobs.size, 0);
});

test('CPU helper startup failure terminates the real isolated handler before rendering and cleans listeners', async t => {
    const f = isolatedFixture(t, { assign: async () => { throw Error('导出组件不完整：缺少内置 Python'); } });
    const pending = f.run('broken');
    const rejected = assert.rejects(pending, /缺少内置 Python/); await tick();
    const win = f.windows[0]; f.ipc.emit('isolated-wysiwyg-ready', { sender: win.webContents });
    await rejected; assert.equal(win.sent.length, 0); assert.equal(win.isDestroyed(), true);
    assert.equal(f.scheduler.active, 0); assert.equal(f.owner.listenerCount('destroyed'), 0);
    assert.equal(f.ipc.listenerCount('isolated-wysiwyg-ready'), 0);
});

function errorUIFixture(impl, nativeDialog) {
    const source = fs.readFileSync(path.join(root, 'src/batch-reels.js'), 'utf8');
    const begin = source.indexOf('async function _reelsShowExportError(');
    const end = source.indexOf('async function _reelsStartExportImpl(', begin);
    const calls = [], button = { disabled: true, innerHTML: '导出中' }, state = { isExporting: false };
    const context = {
        window: { electronAPI: nativeDialog ? { showReelsExportError: nativeDialog } : {} },
        _reelsState: state, _reelsStartExportImpl: impl, console: { error() {}, warn() {} },
        _reelsUpdateLastErrorUI: detail => calls.push(['detail', detail]),
        _reelsAppendExportLogUI: detail => calls.push(['log', detail]), _reelsFinishExportTiming() {},
        localStorage: { removeItem() {} }, REELS_EXPORT_RESUME_KEY: 'resume',
        document: { getElementById: () => button }, alert: detail => calls.push(['alert', detail]),
    };
    vm.createContext(context); vm.runInContext(source.slice(begin, end), context);
    return { context, calls, button, state };
}

test('frontend catches preparation failures, shows native error and always re-enables export', async () => {
    const shown = [];
    const f = errorUIFixture(async () => { throw Error('导出组件不完整：缺少内置 Python'); },
        async payload => shown.push(payload.detail));
    const result = await f.context.reelsStartExport();
    assert.match(result.error, /缺少内置 Python/); assert.equal(shown.length, 1);
    assert.equal(f.button.disabled, false); assert.equal(f.state.isExporting, false);
    assert.equal(f.calls.filter(call => call[0] === 'alert').length, 0);
});

test('frontend falls back if native error IPC is unavailable and rejects duplicate start while busy', async () => {
    let resolve; const f = errorUIFixture(() => new Promise(done => { resolve = done; }), async () => { throw Error('bridge unavailable'); });
    const first = f.context.reelsStartExport(); assert.equal(await f.context.reelsStartExport(), undefined);
    resolve('ok'); assert.equal(await first, 'ok');
    await f.context._reelsShowExportError('failure detail');
    assert.equal(f.calls.filter(call => call[0] === 'alert').length, 1);
});
