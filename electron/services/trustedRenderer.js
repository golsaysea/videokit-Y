const path = require('path');
const { fileURLToPath } = require('url');
function isTrustedRendererUrl(value, { packaged = true, port = 5173 } = {}) {
    try {
        const url = new URL(value);
        if (url.username || url.password) return false;
        if (!packaged && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
            && url.port === String(port) && ['/', '/index.html'].includes(url.pathname)) return true;
        if (url.protocol !== 'file:') return false;
        const target = path.resolve(fileURLToPath(url));
        const root = path.resolve(__dirname, '../..');
        return ['dist/index.html', 'src/index.html', 'electron/isolated-wysiwyg-renderer.html',
            'electron/shadow-renderer.html', 'electron/audio-renderer.html'].some(p => path.resolve(root, p) === target);
    } catch { return false; }
}
function assertTrustedRenderer(event) {
    const { app } = require('electron');
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame || !isTrustedRendererUrl(frame.url,
        { packaged: app.isPackaged, port: Number(process.env.VITE_PORT) || 5173 })) {
        throw new Error('Untrusted IPC sender');
    }
}
module.exports = { isTrustedRendererUrl, assertTrustedRenderer };
