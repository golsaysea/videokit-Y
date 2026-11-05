'use strict';
const path = require('node:path');

class ReelsExportService {
    constructor({ config, renderAudio, fork, trace = () => {} }) {
        this.config = config; this.renderAudio = renderAudio; this.fork = fork;
        this.trace = trace; this.sequence = 0; this.pending = new Map(); this.owners = new Map(); this.bindings = new Map();
        this.child = null; this.ready = null; this.closed = false;
        this.stats = { frameControlCalls: 0, attachedPipelines: 0 };
    }
    ensureWorker() {
        if (this.closed) return Promise.reject(new Error('导出服务已关闭'));
        if (this.ready) return this.ready;
        this.ready = new Promise((resolve, reject) => {
            const fork = this.fork || require('electron').utilityProcess.fork;
            const child = this.child = fork(path.join(__dirname, 'reels-export-worker.js'), [], { serviceName: 'VideoKit Export', stdio: 'pipe' });
            const timer = setTimeout(() => { reject(new Error('后台编码服务启动超时')); child.kill(); }, 15000);
            child.on('message', message => {
                if (message.type === 'ready') { clearTimeout(timer); resolve(); return; }
                if (message.type === 'response') {
                    const request = this.pending.get(message.id); if (!request) return;
                    this.pending.delete(message.id); clearTimeout(request.timer);
                    if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
                } else if (message.type === 'frame-failed') this.bindings.get(message.token)?.fail(new Error(message.error));
                else if (message.type === 'audio-request') {
                    const owner = this.owners.get(message.ownerId);
                    Promise.resolve().then(() => {
                        if (!owner) throw new Error('__CANCELLED__');
                        return this.renderAudio({ ...message.data, signal: owner.controller.signal });
                    }).then(result => child.postMessage({ type: 'audio-result', id: message.id, result }),
                        error => child.postMessage({ type: 'audio-result', id: message.id, error: error.message })).catch(() => {});
                }
            });
            let logTail = '';
            const log = bytes => {
                logTail = (logTail + bytes.toString()).slice(-16000);
                // Output remains asynchronous; never print a line per video frame.
                const newline = logTail.lastIndexOf('\n');
                if (newline >= 0) { this.trace(logTail.slice(0, newline)); logTail = logTail.slice(newline + 1); }
            };
            child.stdout?.on('data', log); child.stderr?.on('data', log);
            child.once('exit', code => {
                clearTimeout(timer); reject(new Error(`后台编码服务退出：${code}`));
                if (this.child !== child) return;
                this.child = null; this.ready = null;
                this.failAll(new Error(`后台编码服务意外退出：${code}`));
            });
            child.postMessage({ type: 'init', config: this.config });
        });
        this.ready.catch(() => {});
        return this.ready;
    }
    rememberOwner(owner) {
        if (owner.isDestroyed()) throw new Error('__CANCELLED__');
        if (this.owners.has(owner.id)) return;
        const state = { owner, controller: new AbortController() };
        state.destroy = () => this.cancelOwner(owner.id);
        this.owners.set(owner.id, state); owner.once('destroyed', state.destroy);
    }
    async request(owner, action, data = {}, ports = [], onFailure) {
        this.rememberOwner(owner);
        const state = this.owners.get(owner.id);
        await this.ensureWorker();
        if (owner.isDestroyed() || state.controller.signal.aborted) throw new Error('__CANCELLED__');
        const id = ++this.sequence;
        if (action === 'frame' || action === 'frames') this.stats.frameControlCalls++;
        if (action === 'attach') this.stats.attachedPipelines++;
        if (onFailure) this.bindings.set(id, { ownerId: owner.id, sessionId: data.sessionId, fail: onFailure });
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id); reject(new Error(`后台编码操作超时：${action}`)); this.cancelOwner(owner.id);
            }, action === 'attach' ? 10000 : 60 * 60 * 1000);
            this.pending.set(id, { ownerId: owner.id, resolve, reject, timer });
            try { this.child.postMessage({ type: 'request', id, ownerId: owner.id, action, data }, ports); }
            catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
        });
        try {
            const result = await promise;
            if (action === 'attach' && !result?.ok) this.bindings.delete(id);
            if (['finish', 'finish-video-only', 'abort'].includes(action)) {
                for (const [token, binding] of this.bindings) if (binding.sessionId === data.sessionId && binding.ownerId === owner.id) this.bindings.delete(token);
            }
            return result;
        } catch (error) { if (onFailure) this.bindings.delete(id); throw error; }
    }
    async handle(owner, action, data) {
        const result = await this.request(owner, action, data);
        return action === 'status' ? { ...result, transportStats: { ...this.stats } } : result;
    }
    attach(owner, sessionId, port, onFailure) { return this.request(owner, 'attach', { sessionId }, [port], onFailure); }
    cancelOwner(id) {
        const state = this.owners.get(id); if (!state) return;
        this.owners.delete(id); state.owner.removeListener('destroyed', state.destroy);
        state.controller.abort(new Error('__CANCELLED__'));
        try { this.child?.postMessage({ type: 'cancel-owner', ownerId: id }); } catch (_) { }
        for (const [token, request] of this.pending) if (request.ownerId === id) {
            this.pending.delete(token); clearTimeout(request.timer); request.reject(new Error('__CANCELLED__'));
        }
        for (const [token, binding] of this.bindings) if (binding.ownerId === id) {
            this.bindings.delete(token); try { binding.fail(new Error('__CANCELLED__')); } catch (_) { }
        }
    }
    failAll(error) {
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
        this.pending.clear();
        for (const binding of this.bindings.values()) { try { binding.fail(error); } catch (_) { } }
        this.bindings.clear();
        for (const [id] of this.owners) this.cancelOwner(id);
    }
    async close() {
        if (this.closed) return; this.closed = true;
        const child = this.child; this.failAll(new Error('__CANCELLED__'));
        if (!child) return;
        await new Promise(resolve => {
            const finish = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => { child.kill(); finish(); }, 1800);
            child.once('exit', finish);
            try { child.postMessage({ type: 'shutdown' }); } catch (_) { child.kill(); finish(); }
        });
    }
}
module.exports = { ReelsExportService };
