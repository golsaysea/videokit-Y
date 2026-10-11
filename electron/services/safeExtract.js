const fs = require('fs');
const path = require('path');
const extract = require('extract-zip');
module.exports = (archive, options) => {
    const requestedRoot = path.resolve(options.dir);
    fs.mkdirSync(requestedRoot, { recursive: true });
    if (fs.lstatSync(requestedRoot).isSymbolicLink()) throw new Error('ZIP destination is a symbolic link');
    // macOS /var and /tmp are OS aliases. Canonicalize the chosen directory,
    // then reject links within the extraction tree instead of its OS ancestors.
    const root = fs.realpathSync(requestedRoot);
    return extract(archive, { ...options, dir: root, onEntry(entry, zip) {
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & 0xf000) === 0xa000) throw new Error('ZIP symbolic links are not allowed');
        const target = path.resolve(root, entry.fileName);
        if (target !== root && !target.startsWith(root + path.sep)) throw new Error('ZIP path escapes destination');
        for (let current = target; ; current = path.dirname(current)) {
            let stat;
            try { stat = fs.lstatSync(current); } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            if (stat && stat.isSymbolicLink()) throw new Error('ZIP destination contains a symbolic link');
            if (current === root) break;
        }
        if (options.onEntry) options.onEntry(entry, zip);
    }});
};
