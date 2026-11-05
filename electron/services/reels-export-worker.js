'use strict';
// Pixels travel directly from the renderer to this utility process. The browser
// main thread only brokers ports and small control messages.
const { AsyncLocalStorage } = require('node:async_hooks');
const childProcess = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const context = new AsyncLocalStorage();
const owners = new Map(), children = new Set(), callbacks = new Map();
const parent = process.parentPort;
let raw, workerConfig, sequence = 0, stopping = false;
const originalSpawn = childProcess.spawn;
// This hook is confined to the utility process, including probes launched by
// imported FFmpeg helpers. It makes cancellation reap preparation/mux children too.
childProcess.spawn = function (file, args, options = {}) {
    const owner = context.getStore();
    let finalArgs = args;
    if (/^ffmpeg(?:\.exe)?$/i.test(path.basename(file))) {
        finalArgs = ['-filter_threads', '1', '-filter_complex_threads', '1'];
        for (const arg of args) { if (arg === '-i') finalArgs.push('-threads', '2'); finalArgs.push(arg); }
    }
    const child = originalSpawn(file, finalArgs, { ...options, windowsHide: true });
    children.add(child); owner?.children.add(child);
    child.once('spawn', () => {
        try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) { }
        if (owner?.controller.signal.aborted || stopping) child.kill();
    });
    child.once('close', () => { children.delete(child); owner?.children.delete(child); });
    return child;
};

function ownerFor(id) {
    let owner = owners.get(id);
    if (!owner) {
        const tempDir = fs.mkdtempSync(path.join(workerConfig.tempDir, 'reels-owner-'));
        owner = { id, tempDir, controller: new AbortController(), sessions: new Set(), artifacts: new Set(), children: new Set() };
        owners.set(id, owner);
    }
    return owner;
}
async function cancelOwner(id) {
    const owner = owners.get(id); if (!owner) return;
    owners.delete(id);
    owner.controller.abort(new Error('__CANCELLED__'));
    for (const sessionId of owner.sessions) raw?.handleWysiwygIPC('abort', { sessionId }).catch(() => {});
    const closed = [...owner.children].map(child => new Promise(resolve => {
        const timer = setTimeout(resolve, 1000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        try { child.kill(); } catch (_) { clearTimeout(timer); resolve(); }
    }));
    for (const directory of owner.artifacts) raw?.handleWysiwygIPC('cleanup-bg', { framesDir: directory }).catch(() => {});
    for (const [id, callback] of callbacks) if (callback.ownerId === owner.id) { callbacks.delete(id); callback.reject(new Error('__CANCELLED__')); }
    await Promise.all(closed);
    await fs.promises.rm(owner.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(error => console.warn('[Export cleanup]', error.message));
}
function requestAudio(data) {
    return new Promise((resolve, reject) => {
        const id = ++sequence, ownerId = context.getStore()?.id;
        callbacks.set(id, { resolve, reject, ownerId });
        parent.postMessage({ type: 'audio-request', id, ownerId, data });
    });
}

parent.on('message', async event => {
    const message = event.data || {};
    if (message.type === 'init') {
        const config = workerConfig = message.config;
        process.env.VIDEOKIT_EXPORT_USER_DATA = config.userData;
        require('./settings').configureExportPaths({ ...config, resolveTempDir: () => {
            const owner = context.getStore();
            if (owner?.controller.signal.aborted) throw new Error('__CANCELLED__');
            return owner?.tempDir;
        } });
        if (config.ffmpegPath) process.env.FFMPEG_PATH = config.ffmpegPath;
        if (config.ffprobePath) process.env.FFPROBE_PATH = config.ffprobePath;
        raw = require('./ffmpeg-rawvideo');
        raw.configureExportRuntime({ renderAudio: requestAudio });
        try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) { }
        parent.postMessage({ type: 'ready' }); return;
    }
    if (message.type === 'cancel-owner') { await cancelOwner(message.ownerId); return; }
    if (message.type === 'audio-result') {
        const callback = callbacks.get(message.id); if (!callback) return;
        callbacks.delete(message.id);
        if (message.error) callback.reject(new Error(message.error)); else callback.resolve(message.result);
        return;
    }
    if (message.type === 'shutdown') {
        stopping = true;
        await Promise.all([...owners.keys()].map(cancelOwner));
        for (const child of children) { try { child.kill(); } catch (_) { } }
        const deadline = Date.now() + 1200;
        while (children.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        parent.postMessage({ type: 'shutdown-done' }); process.exit(0); return;
    }
    if (message.type !== 'request' || !raw || stopping) return;
    let owner;
    try { owner = ownerFor(message.ownerId); }
    catch (error) { parent.postMessage({ type: 'response', id: message.id, error: error.message }); return; }
    await context.run(owner, async () => {
        try {
            let result;
            if (message.action === 'status') {
                result = { activeSessions: raw._test.activeSessionCount(), activeProcesses: children.size, ownerCount: owners.size };
            } else if (message.action === 'attach') {
                if (!owner.sessions.has(message.data.sessionId)) throw new Error('帧通道不属于当前窗口');
                result = raw.attachFramePipeline(message.data.sessionId, event.ports[0], {
                    executeFrame: write => context.run(owner, write),
                    onFailure: error => parent.postMessage({ type: 'frame-failed', token: message.id, error: error.message }),
                });
            } else {
                if (['frame', 'frames', 'finish', 'finish-video-only', 'abort'].includes(message.action) && !owner.sessions.has(message.data.sessionId)) throw new Error('编码会话不属于当前窗口');
                result = await raw.handleWysiwygIPC(message.action, { ...message.data, signal: owner.controller.signal });
                if (message.action === 'start' && typeof result === 'string') {
                    if (owner.controller.signal.aborted) { await raw.handleWysiwygIPC('abort', { sessionId: result }); throw new Error('__CANCELLED__'); }
                    owner.sessions.add(result);
                }
                if (message.action === 'prepare-bg' && result?.framesDir) {
                    if (owner.controller.signal.aborted) { await raw.handleWysiwygIPC('cleanup-bg', result); throw new Error('__CANCELLED__'); }
                    owner.artifacts.add(result.framesDir);
                }
                if (['finish', 'finish-video-only', 'abort'].includes(message.action)) owner.sessions.delete(message.data.sessionId);
                if (message.action === 'cleanup-bg') owner.artifacts.delete(message.data.framesDir);
            }
            parent.postMessage({ type: 'response', id: message.id, result });
        } catch (error) {
            if (message.action === 'attach') { try { event.ports[0]?.close(); } catch (_) { } }
            parent.postMessage({ type: 'response', id: message.id, error: error.message || String(error) });
        }
    });
});
