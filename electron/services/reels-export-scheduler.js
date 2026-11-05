'use strict';
const os = require('node:os');

function estimateExportBytes(params = {}) {
    const width = Math.max(1, Number(params.targetWidth || params.width) || 1080);
    const height = Math.max(1, Number(params.targetHeight || params.height) || 1920);
    // Decoded frame cache, in-flight snapshots, compositing surfaces and decoder overhead.
    return Math.ceil(width * height * 4 * 25 + 96 * 1024 * 1024);
}

class ReelsExportScheduler {
    constructor({ maxActive, maxBytes } = {}) {
        this.maxActive = maxActive || Math.max(1, Math.min(4, Math.floor((os.availableParallelism?.() || os.cpus().length) / 2)));
        this.maxBytes = maxBytes || Math.max(256 * 1024 * 1024, Math.min(1024 * 1024 * 1024, os.totalmem() * .15));
        this.active = 0; this.bytes = 0; this.queue = [];
    }
    acquire(params, { signal, onQueue } = {}) {
        if (signal?.aborted) return Promise.reject(new Error('__CANCELLED__'));
        return new Promise((resolve, reject) => {
            const job = { bytes: estimateExportBytes(params), signal, resolve, reject };
            job.abort = () => {
                const index = this.queue.indexOf(job);
                if (index < 0) return;
                this.queue.splice(index, 1); signal.removeEventListener('abort', job.abort);
                reject(new Error('__CANCELLED__')); this.drain();
            };
            signal?.addEventListener('abort', job.abort, { once: true });
            this.queue.push(job); this.drain();
            if (this.queue.includes(job)) onQueue?.({ active: this.active, waiting: this.queue.length, maxActive: this.maxActive });
        });
    }
    drain() {
        while (this.queue.length && this.active < this.maxActive) {
            const job = this.queue[0];
            if (this.active && this.bytes + job.bytes > this.maxBytes) break;
            this.queue.shift(); job.signal?.removeEventListener('abort', job.abort);
            this.active++; this.bytes += job.bytes;
            let released = false;
            job.resolve(() => {
                if (released) return; released = true;
                this.active--; this.bytes -= job.bytes; this.drain();
            });
        }
    }
}
module.exports = { ReelsExportScheduler, estimateExportBytes };
