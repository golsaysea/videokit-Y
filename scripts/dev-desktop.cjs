'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function probeHostPort(port, host) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', (err) => {
            if (err && (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
        srv.once('listening', () => {
            srv.close(() => resolve(true));
        });
        srv.listen({ port, host, exclusive: true });
    });
}

async function isPortAvailable(port) {
    const [ipv4Ok, ipv6Ok] = await Promise.all([
        probeHostPort(port, '127.0.0.1'),
        probeHostPort(port, '::1'),
    ]);
    return ipv4Ok && ipv6Ok;
}

async function findAvailablePort(preferredPort = 5173, maxTries = 30) {
    const start = Number(preferredPort) > 0 ? Math.floor(Number(preferredPort)) : 5173;
    for (let offset = 0; offset < maxTries; offset++) {
        const candidate = start + offset;
        if (await isPortAvailable(candidate)) {
            return candidate;
        }
    }
    throw new Error(`No available dev port found in range ${start}-${start + maxTries - 1}`);
}

function checkHttpReady(url) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout: 1500 }, (res) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function waitForDevServer(url, { timeoutMs = 60000, isAborted = () => false } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (isAborted()) {
            throw new Error('Vite dev server exited before becoming ready');
        }
        if (await checkHttpReady(url)) {
            return true;
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Timed out waiting for Vite dev server at ${url}`);
}

function terminateChildTree(child) {
    if (!child || child.killed || typeof child.pid !== 'number') return;
    try {
        if (process.platform === 'win32') {
            execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true,
            });
            return;
        }
    } catch (_) {}
    try {
        child.kill('SIGTERM');
    } catch (_) {}
}

async function main() {
    const preferredPort = Number(process.env.VITE_PORT) || 5173;
    const port = await findAvailablePort(preferredPort);
    const devUrl = `http://localhost:${port}`;

    if (port !== preferredPort) {
        console.log(`[Dev] 端口 ${preferredPort} 已被占用，自动切换开发端口 -> ${port}`);
    } else {
        console.log(`Starting VideoKit on port ${port}...`);
    }
    console.log('Close the application to stop the development server.');

    const env = { ...process.env, VITE_PORT: String(port) };
    delete env.ELECTRON_RUN_AS_NODE;

    if (process.platform === 'win32') {
        const ffmpegWin = path.join(ROOT, 'vendor', 'win32', 'ffmpeg.exe');
        const ffprobeWin = path.join(ROOT, 'vendor', 'win32', 'ffprobe.exe');
        if (!env.FFMPEG_PATH && fs.existsSync(ffmpegWin)) env.FFMPEG_PATH = ffmpegWin;
        if (!env.FFPROBE_PATH && fs.existsSync(ffprobeWin)) env.FFPROBE_PATH = ffprobeWin;
    }

    const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    const viteChild = spawn(process.execPath, [viteBin, '--host', 'localhost', '--port', String(port)], {
        cwd: ROOT,
        env,
        stdio: 'inherit',
    });

    let viteExited = false;
    let electronChild = null;
    let cleaningUp = false;

    const cleanup = () => {
        if (cleaningUp) return;
        cleaningUp = true;
        terminateChildTree(electronChild);
        terminateChildTree(viteChild);
    };

    process.once('SIGINT', () => { cleanup(); process.exit(130); });
    process.once('SIGTERM', () => { cleanup(); process.exit(143); });
    process.once('exit', cleanup);

    viteChild.once('exit', (code) => {
        viteExited = true;
        if (!cleaningUp && electronChild === null && code !== 0) {
            process.exit(typeof code === 'number' ? code : 1);
        }
    });

    try {
        await waitForDevServer(devUrl, { isAborted: () => viteExited });
    } catch (err) {
        console.error(`[Dev] ${err.message}`);
        cleanup();
        process.exit(1);
    }

    const electronBinary = require('electron');
    electronChild = spawn(electronBinary, ['.'], {
        cwd: ROOT,
        env,
        stdio: 'inherit',
    });

    electronChild.once('exit', (code, signal) => {
        cleanup();
        if (typeof code === 'number') {
            process.exit(code);
        }
        if (signal) {
            process.exit(1);
        }
        process.exit(0);
    });
}

module.exports = {
    isPortAvailable,
    findAvailablePort,
    waitForDevServer,
};

if (require.main === module) {
    main().catch((err) => {
        console.error('[Dev] Failed to start:', err && err.stack ? err.stack : err);
        process.exit(1);
    });
}
