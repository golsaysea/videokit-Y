const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath, pathToFileURL } = require('url');
const archiver = require('archiver');
const extract = require('./safeExtract');

function sourcePath(value) {
    if (typeof value !== 'string' || /^(data:|blob:|https?:)/i.test(value)) return '';
    try {
        if (/^local-media:\/\//i.test(value)) {
            const raw = value.replace(/^local-media:\/\//i, '');
            const decode = text => {
                let local = decodeURIComponent(text);
                if (/^\/[a-z]:[\\/]/i.test(local)) local = local.slice(1);
                return path.isAbsolute(local) ? path.normalize(local) : '';
            };
            // Older toFileUrl versions left a real filename's # unescaped.
            const complete = decode(raw);
            if (complete && fs.existsSync(complete)) return complete;
            return decode(raw.split(/[?#]/)[0]);
        }
        return /^file:/i.test(value) ? fileURLToPath(value) : (path.isAbsolute(value) ? value : '');
    } catch (_) { return ''; }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

async function exportPackage({ presets, outputPath }) {
    const copied = new Map(), missing = [], packaged = clone(presets || {});
    for (const preset of Object.values(packaged)) for (const layer of (preset?.layers || [])) {
        const source = sourcePath(layer?.content);
        if (!source) continue;
        if (!fs.existsSync(source) || !fs.statSync(source).isFile()) { missing.push(source); continue; }
        let asset = copied.get(source);
        if (!asset) {
            const ext = path.extname(source);
            const name = path.basename(source, ext).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'media';
            asset = `assets/${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}_${name}${ext}`;
            copied.set(source, asset);
        }
        layer.content = asset;
    }
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(outputPath);
        const zip = archiver('zip', { zlib: { level: 6 } });
        out.on('close', resolve); out.on('error', reject); zip.on('error', reject);
        zip.pipe(out);
        zip.append(JSON.stringify({ format: 'videokit-overlay-preset-package', version: 1, presets: packaged, missingMedia: missing }, null, 2), { name: 'manifest.json' });
        for (const [source, asset] of copied) zip.file(source, { name: asset });
        zip.finalize();
    });
    return { copied: copied.size, missing };
}

async function importPackage({ packagePath, destinationDir }) {
    const target = path.join(destinationDir, `overlay-package-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
    await extract(packagePath, { dir: target });
    const manifest = JSON.parse(await fs.promises.readFile(path.join(target, 'manifest.json'), 'utf8'));
    if (manifest?.format !== 'videokit-overlay-preset-package' || !manifest.presets || typeof manifest.presets !== 'object') throw new Error('不是有效的 VideoKit 覆层预设包');
    const assetsRoot = path.resolve(target, 'assets') + path.sep;
    for (const preset of Object.values(manifest.presets)) for (const layer of (preset?.layers || [])) {
        if (typeof layer?.content !== 'string' || !layer.content.startsWith('assets/')) continue;
        const assetPath = path.resolve(target, layer.content);
        if (!assetPath.startsWith(assetsRoot) || !fs.existsSync(assetPath)) throw new Error(`预设包中的媒体文件缺失：${layer.content}`);
        layer.content = pathToFileURL(assetPath).href;
    }
    return { presets: manifest.presets, assetDir: target, missing: manifest.missingMedia || [] };
}

function presetMediaReferences(layers) {
    const refs = [];
    for (const [index, layer] of (layers || []).entries()) {
        if (!layer || typeof layer !== 'object') continue;
        if (['image', 'video', 'audio'].includes(layer.type) && !layer.is_img_sequence) refs.push({ owner: layer, key: 'content', index, name: layer.name });
        if (layer.scroll_tw_cursor_image) refs.push({ owner: layer, key: 'scroll_tw_cursor_image', index, name: layer.name });
        if (layer.is_img_sequence && Array.isArray(layer.sequence_frames)) layer.sequence_frames.forEach((_, key) => refs.push({ owner: layer.sequence_frames, key, index, name: layer.name }));
    }
    return refs;
}

async function savePresetAssets({ preset, destinationDir }) {
    const saved = clone(preset);
    const refs = presetMediaReferences(saved.layers);
    const missing = [], files = [];
    for (const ref of refs) {
        const value = ref.owner[ref.key];
        if (typeof value === 'string' && value.startsWith('data:')) continue;
        const source = sourcePath(value);
        let stat = null;
        try { if (source) stat = fs.statSync(source); } catch (_) {}
        if (!source || !stat?.isFile()) {
            missing.push(`第 ${ref.index + 1} 层${ref.name ? `（${ref.name}）` : ''}：${String(value || '未指定文件')}`);
        } else files.push({ ref, source, stat });
    }
    if (missing.length) throw new Error(`以下媒体无法复制到预设库，请确认原文件仍存在：\n${missing.join('\n')}`);
    const root = path.resolve(destinationDir), assets = path.join(root, 'shared-assets');
    let copied = 0, reused = 0;
    const processed = new Map();
    for (const { ref, source, stat } of files) {
        const canonical = path.resolve(source);
        const relative = path.relative(root, canonical);
        let target = processed.get(canonical);
        if (!target) {
            if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
                target = canonical; reused++;
            } else {
                const ext = path.extname(source), stem = path.basename(source, ext).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'media';
                const key = crypto.createHash('sha256').update(`${canonical}\0${stat.size}\0${stat.mtimeMs}`).digest('hex').slice(0, 20);
                target = path.join(assets, `${key}_${stem}${ext}`);
                await fs.promises.mkdir(assets, { recursive: true });
                if (fs.existsSync(target) && fs.statSync(target).size === stat.size) reused++;
                else {
                    const temporary = target + '.partial-' + crypto.randomUUID();
                    try {
                        await fs.promises.copyFile(source, temporary);
                        await fs.promises.rename(temporary, target);
                    } finally { if (fs.existsSync(temporary)) await fs.promises.unlink(temporary); }
                    copied++;
                }
            }
            processed.set(canonical, target);
        }
        ref.owner[ref.key] = pathToFileURL(target).href;
    }
    saved.meta = { ...(saved.meta || {}), mediaStorage: refs.length ? 'packaged' : 'none', packagedMediaCount: processed.size };
    return { preset: saved, copied, reused };
}

module.exports = { exportPackage, importPackage, savePresetAssets, sourcePath, presetMediaReferences };
