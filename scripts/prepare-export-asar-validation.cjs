'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
(async () => {
    const stage = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vk-export-asar-'));
    const archive = path.join(root, 'validation-export.asar');
    try {
        for (const directory of ['electron', 'dist', 'resources']) await fs.promises.cp(path.join(root, directory), path.join(stage, directory), { recursive: true });
        if (fs.existsSync(path.join(root, 'assets'))) await fs.promises.cp(path.join(root, 'assets'), path.join(stage, 'assets'), { recursive: true });
        await fs.promises.copyFile(path.join(root, 'package.json'), path.join(stage, 'package.json'));
        await asar.createPackage(stage, archive);
        for (const file of ['electron/main.js', 'electron/services/reels-export-worker.js', 'dist/reels-frame-pipeline.js', 'dist/reels-scroll-timing.js', 'resources/export-cpu-budget.js']) {
            const archiveEntry = file.split('/').join(path.sep);
            if (!asar.extractFile(archive, archiveEntry).length) throw new Error('Missing packaged export entry: ' + file);
        }
        // Runtime dependencies resolve from the checkout's parent node_modules;
        // every app/module/worker entry and frontend file is loaded from ASAR.
        console.log('ASAR export entry prepared:', archive);
    } finally { await fs.promises.rm(stage, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
