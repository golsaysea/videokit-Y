'use strict';
const fs = require('node:fs');

class MediaProbeQueue {
    constructor(probe, { concurrency = 2, cacheLimit = 512 } = {}) {
        this.probe = probe; this.concurrency = concurrency; this.cacheLimit = cacheLimit;
        this.active = 0; this.queue = []; this.pending = new Map(); this.cache = new Map();
    }
    async get(file, kind = 'duration') {
        let identity = String(file);
        try { const stat = await fs.promises.stat(file); identity += `:${stat.size}:${stat.mtimeMs}`; } catch (_) { }
        const key = `${kind}:${identity}`;
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.at < 60000) return cached.value;
        if (this.pending.has(key)) return this.pending.get(key);
        const promise = new Promise((resolve, reject) => { this.queue.push({ file, kind, key, resolve, reject }); this.drain(); });
        this.pending.set(key, promise);
        promise.finally(() => this.pending.delete(key)).catch(() => {});
        return promise;
    }
    drain() {
        while (this.active < this.concurrency && this.queue.length) {
            const job = this.queue.shift(); this.active++;
            Promise.resolve().then(() => this.probe(job.file, job.kind)).then(value => {
                if (value != null && (typeof value !== 'number' || value > 0)) {
                    this.cache.set(job.key, { value, at: Date.now() });
                    while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
                }
                job.resolve(value);
            }, job.reject).finally(() => { this.active--; this.drain(); });
        }
    }
}
module.exports = { MediaProbeQueue };
