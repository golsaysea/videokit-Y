'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const REQUIRED = [
    'export-cpu-budget.js',
    'vendor/ffmpeg/bin/ffmpeg.exe', 'vendor/ffmpeg/bin/ffprobe.exe',
    'vendor/python/python.exe', 'vendor/python/python311.dll',
    'vendor/python/python311.zip', 'vendor/python/_ctypes.pyd',
];
async function verifyPortableRuntime(resources, options = {}) {
    const missing = REQUIRED.filter(file => {
        try { const stat = fs.statSync(path.join(resources, file)); return !stat.isFile() || stat.size === 0; }
        catch (_) { return true; }
    });
    if (missing.length) throw new Error('Windows 免安装包缺少导出运行组件：\n' + missing.join('\n'));
    if ((options.platform || process.platform) === 'win32') {
        const run = options.execFile || execFile;
        await new Promise((resolve, reject) => run(path.join(resources, 'vendor/python/python.exe'),
            ['-I', '-c', 'import ctypes, encodings, json, sys; print(json.dumps({"version":sys.version_info[:3],"ctypes":True}))'],
            { timeout: 15000, windowsHide: true }, error => error ? reject(error) : resolve()));
    }
    return { checked: REQUIRED.length, embeddedPython: true };
}
module.exports = async function afterPack(context) {
    if (context.electronPlatformName !== 'win32') return;
    const report = await verifyPortableRuntime(path.join(context.appOutDir, 'resources'));
    console.log('[Portable runtime]', JSON.stringify(report));
};
module.exports.verifyPortableRuntime = verifyPortableRuntime;
module.exports.REQUIRED = REQUIRED;
if (require.main === module) {
    verifyPortableRuntime(path.resolve(process.argv[2] || 'dist-electron/win-unpacked/resources'))
        .then(result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
}
