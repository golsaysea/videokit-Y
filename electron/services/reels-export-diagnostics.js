'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { monitorEventLoopDelay } = require('node:perf_hooks');

class ReelsExportDiagnostics {
    constructor(directory) { this.directory = directory; this.active = new Map(); this.moves = 0; this.latest = null; }
    begin(id, params = {}) {
        if (!this.active.size) {
            this.histogram = monitorEventLoopDelay({ resolution: 20 }); this.histogram.enable();
            this.moves = 0;
        }
        this.active.set(id, { started: Date.now(), width: Number(params.targetWidth || params.width) || 1080,
            height: Number(params.targetHeight || params.height) || 1920, engine: params.exportEngine || 'precise' });
        let finished = false;
        return () => {
            if (finished) return; finished = true;
            const job = this.active.get(id); this.active.delete(id);
            const histogram = this.histogram;
            if (!job || !histogram) return;
            this.latest = { timestamp: new Date().toISOString(), ...job, elapsedMs: Date.now() - job.started,
                mainLoopP95Ms: histogram.percentile(95) / 1e6, mainLoopMaxMs: histogram.max / 1e6,
                windowMoves: this.moves, activeExports: this.active.size, mainRssMB: Math.round(process.memoryUsage().rss / 1048576),
                freeMemoryMB: Math.round(os.freemem() / 1048576), electron: process.versions.electron };
            const line = JSON.stringify(this.latest) + '\n';
            const directory = typeof this.directory === 'function' ? this.directory() : this.directory;
            fs.promises.mkdir(directory, { recursive: true }).then(() => fs.promises.appendFile(path.join(directory, 'export-responsiveness.jsonl'), line)).catch(() => {});
            if (!this.active.size) { histogram.disable(); this.histogram = null; }
        };
    }
    moved() { if (this.active.size) this.moves++; }
}
module.exports = { ReelsExportDiagnostics };
