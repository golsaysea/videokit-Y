'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const results = new Map(), pending = new Map();

function waitForProbe(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new Error('__CANCELLED__'));
    return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('__CANCELLED__'));
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

async function probeGPUEncoder(ffmpegPath, codec, encoderArgs, width, height, fps, options = {}) {
    let signature = ffmpegPath;
    try { const stat = await fs.promises.stat(ffmpegPath); signature += `:${stat.size}:${stat.mtimeMs}`; } catch (_) { }
    const key = JSON.stringify([signature, process.platform, codec, encoderArgs, width, height, fps]);
    const cached = results.get(key);
    if (cached && cached.expires > Date.now()) return waitForProbe(Promise.resolve(cached.available), options.signal);
    if (!pending.has(key)) {
        const probe = (async () => {
            const output = require('./settings').secureTmpFile('gpu_probe', '.mp4');
            try {
                const available = await new Promise((resolve, reject) => {
                    const args = ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`,
                        '-framerate', String(fps), '-i', 'pipe:0', '-an', ...encoderArgs, '-pix_fmt', 'yuv420p', '-frames:v', '3', output];
                    const child = (options.spawn || spawn)(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
                    let stderr = '', settled = false;
                    const finish = (error, value) => {
                        if (settled) return; settled = true; clearTimeout(timer);
                        if (error) reject(error); else resolve(value);
                    };
                    const timer = setTimeout(() => { child.kill(); finish(new Error('硬件编码器探测超时')); }, options.timeoutMs || 15000);
                    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
                    child.stdin.on('error', () => {}); // Unsupported encoders may exit before consuming input.
                    child.once('error', error => finish(error));
                    child.once('close', (code, signal) => {
                        if (signal || code == null) finish(new Error('硬件编码器探测被终止'));
                        else { if (code !== 0) console.log(`[GPU probe] ${codec}: ${stderr.slice(-400)}`); finish(null, code === 0); }
                    });
                    child.stdin.end(Buffer.alloc(width * height * 4 * 3));
                });
                results.set(key, { available, expires: Date.now() + (available ? 3600000 : 300000) });
                return available;
            } finally { await fs.promises.unlink(output).catch(() => {}); }
        })();
        pending.set(key, probe);
        probe.finally(() => pending.delete(key)).catch(() => {});
    }
    return waitForProbe(pending.get(key), options.signal);
}

module.exports = { probeGPUEncoder, waitForProbe, _test: { clear() { results.clear(); pending.clear(); } } };
