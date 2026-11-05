'use strict';
// Run with Electron. Uses the shipped preload and isolated renderer, complete
// WYSIWYG Canvas exports, native MessageChannelMain and the actual FFmpeg backend.
const { app, BrowserWindow, ipcMain, MessageChannelMain, nativeImage } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.resolve(process.env.VIDEOKIT_VALIDATION_DIR || path.join(root, 'validation-frame-pipeline'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
const raw = require('../electron/services/ffmpeg-rawvideo');
const styleEngine = require('../src/reels-style-engine');
const windows = [], owners = new Map(), faults = new Map(), counts = new Map();
const report = { exports: [], faults: [], pass: false };
// Each case deliberately destroys its last window. Keep Electron alive until
// all cases finish, instead of accepting a premature default app exit as green.
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Native frame pipeline validation timed out'); app.exit(1); }, 240000);
const scripts = ['reels-text-direction.js', 'reels-anim-engine.js', 'reels-rich-text.js',
    'reels-scroll-timing.js', 'reels-canvas-renderer.js', 'reels-overlay.js',
    'fonts-metadata.js', 'reels-font-manager.js', 'reels-frame-pipeline.js', 'reels-wysiwyg-export.js'].map(name => path.join(root, 'dist', name));

ipcMain.on('persistent-presets:hydrate', event => { event.returnValue = { ok: true, values: {} }; });
ipcMain.handle('persistent-presets:save', () => ({ ok: true }));
ipcMain.handle('scan-fonts', () => []);
ipcMain.handle('fetch-google-fonts', () => ({ items: [] }));
ipcMain.handle('check-files-exist', (_event, files) => Object.fromEntries(files.map(file => [file, fs.existsSync(file)])));
ipcMain.handle('reels-compose-wysiwyg', async (event, action, data) => {
    const result = await raw.handleWysiwygIPC(action, data);
    if (action === 'start' && typeof result === 'string') {
        owners.set(result, event.sender.id);
        event.sender.once('destroyed', () => raw.handleWysiwygIPC('abort', { sessionId: result }));
    }
    if (action === 'finish' || action === 'abort') owners.delete(data.sessionId);
    return result;
});
ipcMain.on('reels-frame-pipeline-open', (event, data) => {
    assert.equal(owners.get(data.sessionId), event.sender.id);
    const { port1, port2 } = new MessageChannelMain();
    const fault = faults.get(event.sender.id);
    const post = port1.postMessage.bind(port1);
    port1.postMessage = value => {
        if (value.type === 'ack') {
            counts.set(event.sender.id, (counts.get(event.sender.id) || 0) + 1);
            if (fault === 'ack-send') throw new Error('injected native ACK send failure');
            if (fault === 'drop-ack' || fault === 'cancel') return;
            if (fault === 'close-port') { port1.close(); return; }
        }
        post(value);
    };
    const result = raw.attachFramePipeline(data.sessionId, port1, { onFailure: error => {
        if (!event.sender.isDestroyed()) event.sender.send('reels-frame-pipeline-failed', { requestId: data.requestId, error: error.message });
    } });
    event.sender.postMessage('reels-frame-pipeline-ready', { requestId: data.requestId, ...result }, [port2]);
});

function watch(win) {
    windows.push(win);
    win.webContents.on('console-message', (_event, _level, message) => {
        if (/ReelsFrame|Error|失败/.test(message)) console.log(`[renderer ${win.webContents.id}] ${message}`);
    });
    win.webContents.on('preload-error', (_event, _file, error) => { console.error(error); });
    return win;
}
async function normalWindow() {
    const win = watch(new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron/preload.js'), sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, webSecurity: false } }));
    const fixture = path.join(out, 'renderer.html');
    fs.writeFileSync(fixture, '<html><body><canvas id="render-canvas"></canvas><input type="checkbox" id="reels-fast-alpha-mode" checked></body></html>');
    await win.loadFile(fixture);
    for (const file of scripts) await win.webContents.executeJavaScript(fs.readFileSync(file, 'utf8') + '\n;true;');
    return win;
}
function probeVideo(file, frames, duration) {
    const meta = JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,duration', '-of', 'json', file], { encoding: 'utf8' }));
    assert.equal(Number(meta.streams[0].nb_read_frames), frames);
    assert.ok(Math.abs(Number(meta.streams[0].duration) - duration) < .1);
}
async function render(kind, engine, background, highResolution = false) {
    const outputPath = path.join(out, `${kind}-${engine}${highResolution ? '-1080' : ''}.mp4`);
    const duration = highResolution ? .5 : 1.5, fps = highResolution ? 30 : 12;
    const style = styleEngine.mergeStyle({ font_family: 'Arial', fontsize: highResolution ? 76 : 32, pos_y: .5, shadow_blur: 0, visual_engine_enabled: true, mixed_layout: 'focus' });
    const params = { style, segments: [{ start: 0, end: duration, text: 'Hope shines every day', words: ['Hope', 'shines', 'every', 'day'].map((word, i) => ({ word, start: i * duration / 4, end: (i + 1) * duration / 4 })) }], overlays: [], backgroundPath: background, alphaOverlayBgPath: background, outputPath, customDuration: duration, targetWidth: highResolution ? 1080 : 360, targetHeight: highResolution ? 1920 : 640, fps, loopFade: false, exportEngine: engine, useGPU: engine === 'hardware', qualityPreset: 'ultrafast', bgVolume: 0 };
    let win, result;
    const start = Date.now();
    if (kind === 'normal') {
        win = await normalWindow();
        result = await win.webContents.executeJavaScript(`reelsWysiwygExport({...${JSON.stringify(params)},canvas:document.getElementById('render-canvas')})`);
    } else {
        win = watch(new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, webSecurity: false } }));
        const done = new Promise((resolve, reject) => {
            const ready = event => { if (event.sender === win.webContents) win.webContents.send('isolated-wysiwyg-run', { requestId: 'native-validation', params, scriptPaths: scripts }); };
            const finished = (event, data) => {
                if (event.sender !== win.webContents) return;
                ipcMain.removeListener('isolated-wysiwyg-ready', ready);
                ipcMain.removeListener('isolated-wysiwyg-result', finished);
                data.success ? resolve(data.result) : reject(new Error(data.error));
            };
            ipcMain.on('isolated-wysiwyg-ready', ready); ipcMain.on('isolated-wysiwyg-result', finished);
        });
        await win.loadFile(path.join(root, 'electron/isolated-wysiwyg-renderer.html'));
        result = await done;
    }
    assert.equal(result.output_path, outputPath);
    probeVideo(outputPath, Math.round(duration * fps), duration);
    const ackCount = counts.get(win.webContents.id) || 0;
    assert.equal(ackCount, Math.round(duration * fps));
    assert.equal(raw._test.activeSessionCount(), 0);
    report.exports.push({ kind, engine, highResolution, frames: Math.round(duration * fps), ackCount, elapsedMs: Date.now() - start });
    win.destroy();
}

async function faultCase(fault) {
    const win = watch(new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } }));
    await win.loadURL('data:text/html,<html></html>');
    faults.set(win.webContents.id, fault);
    const result = await win.webContents.executeJavaScript(`(async()=>{
        const {ipcRenderer}=require('electron');
        const bridge=require(${JSON.stringify(path.join(root, 'electron/services/reels-frame-bridge.js'))}).createReelsFrameBridge(ipcRenderer,{ackTimeoutMs:300});
        const sessionId=await ipcRenderer.invoke('reels-compose-wysiwyg','start',{width:64,height:64,fps:10,totalFrames:20,targetDuration:2,outputPath:${JSON.stringify(path.join(out, 'fault.mp4'))},useGPU:false,qualityPreset:'ultrafast'});
        try {const id=await bridge.api.createReelsFramePipeline(sessionId);const pending=[0,1,2].map(seq=>bridge.api.sendReelsFramePipeline(id,seq,new ArrayBuffer(64*64*4)));if(${JSON.stringify(fault)}==='cancel')setTimeout(()=>bridge.cancelAll(new Error('__CANCELLED__')),30);await Promise.all(pending);return {failed:false};}
        catch(error){return {failed:true,error:error.message};}
        finally{bridge.dispose();await ipcRenderer.invoke('reels-compose-wysiwyg','abort',{sessionId});}
    })()`);
    assert.equal(result.failed, true, fault + ' did not terminate');
    assert.match(result.error, fault === 'drop-ack' ? /ACK.*超时/ : fault === 'ack-send' ? /injected native ACK/ : fault === 'cancel' ? /__CANCELLED__/ : /断开/);
    assert.equal(raw._test.activeSessionCount(), 0);
    report.faults.push({ fault, error: result.error });
    win.destroy();
}

(async () => {
    await app.whenReady();
    const bitmap = Buffer.alloc(360 * 640 * 4, 255);
    for (let i = 0; i < bitmap.length; i += 4) { bitmap[i] = 140; bitmap[i + 1] = 100; bitmap[i + 2] = 60; }
    const background = path.join(out, 'background.png');
    fs.writeFileSync(background, nativeImage.createFromBitmap(bitmap, { width: 360, height: 640 }).toPNG());
    for (const kind of ['normal', 'isolated']) for (const engine of ['precise', 'pipeline', 'hardware']) await render(kind, engine, background);
    await render('isolated', 'pipeline', background, true);
    for (const fault of ['drop-ack', 'ack-send', 'close-port', 'cancel']) await faultCase(fault);
    assert.equal(report.exports.length, 7);
    assert.equal(report.faults.length, 4);
    report.pass = true;
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Native MessagePort + full Canvas/FFmpeg export\n```json\n' + JSON.stringify(report, null, 2) + '\n```\n');
    clearTimeout(deadline);
    process.stdout.write(JSON.stringify(report) + '\n', () => app.exit(0));
})().catch(error => {
    console.error(error.stack);
    fs.writeFileSync(path.join(out, 'failure.txt'), error.stack || String(error));
    clearTimeout(deadline); for (const win of windows) if (!win.isDestroyed()) win.destroy(); app.exit(1);
});
