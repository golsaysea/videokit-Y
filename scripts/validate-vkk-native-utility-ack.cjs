'use strict';
// Native Electron utilityProcess + MessageChannelMain + FFmpeg end-to-end smoke.
const { app, BrowserWindow, ipcMain, MessageChannelMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { ReelsExportService } = require('../electron/services/reels-export-service');

const root = path.resolve(__dirname, '..');
const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vkk-native-ack-'));
const profile = path.join(rootTmp, 'profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('Native ACK smoke timed out'); app.exit(1); }, 120000);
let worker;
let browser;
(async () => {
    await app.whenReady();
    const outputPath = path.join(rootTmp, 'native-ack.mp4');
    const service = worker = new ReelsExportService({
        config: { userData: profile, tempDir: rootTmp, systemDirs: [rootTmp],
            ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', ffprobePath: process.env.FFPROBE_PATH || 'ffprobe' },
        renderAudio: async () => null,
        trace: msg => console.log('[ExportWorker]', msg),
    });
    const fixture = path.join(rootTmp, 'renderer.html');
    fs.writeFileSync(fixture, '<html><body>ACK smoke</body></html>');
    browser = new BrowserWindow({ show: false, webPreferences: {
        nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
    await browser.loadFile(fixture);
    const owner = browser.webContents;
    ipcMain.on('reels-frame-pipeline-open', async (event, data) => {
        if (event.sender !== owner) return;
        const { port1, port2 } = new MessageChannelMain();
        try {
            const result = await service.attach(owner, data.sessionId, port1, error => {
                if (!owner.isDestroyed()) owner.send('reels-frame-pipeline-failed',
                    { requestId: data.requestId, error: error.message });
            });
            if (!result.ok) throw new Error(result.error);
            owner.postMessage('reels-frame-pipeline-ready', { requestId: data.requestId, ...result }, [port2]);
        } catch (error) {
            try { port1.close(); port2.close(); } catch (_) {}
            if (!owner.isDestroyed()) owner.send('reels-frame-pipeline-failed',
                { requestId: data.requestId, error: error.message });
        }
    });
    ipcMain.handle('reels-compose-wysiwyg', (event, action, data) => service.handle(event.sender, action, data));
    const sessionId = await service.handle(owner, 'start', { width: 192, height: 320,
        fps: 15, totalFrames: 30, targetDuration: 2, outputPath,
        useGPU: false, qualityPreset: 'ultrafast' });
    assert.equal(typeof sessionId, 'string', JSON.stringify(sessionId));
    const script = `(async () => {
        const { ipcRenderer } = require('electron');
        const bridge = require(${JSON.stringify(path.join(root, 'electron/services/reels-frame-bridge.js'))})
            .createReelsFrameBridge(ipcRenderer, { ackTimeoutMs: 30000 });
        window.electronAPI = { ...bridge.api,
            reelsComposeWysiwyg: (action, data) => ipcRenderer.invoke('reels-compose-wysiwyg', action, data) };
        require(${JSON.stringify(path.join(root, 'src/reels-frame-pipeline.js'))});
        const producer = window.ReelsFramePipeline.create(${JSON.stringify(sessionId)}, 3);
        for (let i = 0; i < 30; i++) {
            const raw = new ArrayBuffer(192 * 320 * 4);
            const bytes = new Uint8Array(raw);
            for (let p = 0; p < bytes.length; p += 4) {
                bytes[p] = (i * 7) % 255; bytes[p+1] = 120;
                bytes[p+2] = 180; bytes[p+3] = 255;
            }
            await producer.send(raw);
        }
        await producer.drain();
        const result = await ipcRenderer.invoke('reels-compose-wysiwyg', 'finish',
            { sessionId: ${JSON.stringify(sessionId)} });
        bridge.dispose();
        return result;
    })()`;
    const result = await owner.executeJavaScript(script);
    assert.equal(result.output_path, outputPath, result.error);
    const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
    const metadata = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
        '-show_entries', 'stream=nb_read_frames,duration', '-of', 'json', outputPath], { encoding: 'utf8' }));
    assert.equal(Number(metadata.streams[0].nb_read_frames), 30);
    assert.ok(Math.abs(Number(metadata.streams[0].duration) - 2) < 0.1);
    const status = await service.handle(owner, 'status', {});
    assert.equal(status.activeSessions, 0);
    assert.equal(status.transportStats.frameControlCalls, 0);
    assert.equal(status.transportStats.attachedPipelines, 1);
    console.log(JSON.stringify({ nativeElectron: true, utilityProcess: true, frames: 30,
        duration: metadata.streams[0].duration, transport: status.transportStats, pass: true }));
    await service.close();
    browser.destroy(); browser = null;
    clearTimeout(timeout);
    try { fs.rmSync(rootTmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
    catch (error) { console.warn('[Smoke cleanup after Electron exit]', error.message); }
    app.exit(0);
})().catch(async error => {
    console.error(error.stack || error);
    try { await worker?.close(); } catch (_) {}
    try { browser?.destroy(); } catch (_) {}
    clearTimeout(timeout);
    app.exit(1);
});
