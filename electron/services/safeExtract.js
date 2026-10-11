const fs = require('fs');
const path = require('path');
const extract = require('extract-zip');
module.exports = (archive, options) => extract(archive, { ...options, onEntry(entry, zip) {
    const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
    if ((mode & 0xf000) === 0xa000) throw new Error('ZIP symbolic links are not allowed');
    const root = path.resolve(options.dir);
    const target = path.resolve(root, entry.fileName);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('ZIP path escapes destination');
    for (let current = target; ; current = path.dirname(current)) {
        // lstat also sees dangling links, which existsSync silently misses.
        let stat;
        try { stat = fs.lstatSync(current); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        if (stat && stat.isSymbolicLink()) throw new Error('ZIP destination contains a symbolic link');
        if (current === path.dirname(current)) break;
    }
    if (options.onEntry) options.onEntry(entry, zip);
}});
