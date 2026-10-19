const fs = require('fs');
const path = require('path');
const os = require('os');

// Color constants for pretty printing
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let errorCount = 0;
let warnCount = 0;

function printHeader(title) {
    console.log(`\n${BOLD}${CYAN}=== ${title} ===${RESET}`);
}

function printPass(message) {
    console.log(`${GREEN}✔ PASS: ${message}${RESET}`);
}

function printWarn(message) {
    warnCount++;
    console.log(`${YELLOW}⚠ WARN: ${message}${RESET}`);
}

function printError(message) {
    errorCount++;
    console.log(`${RED}✘ ERROR: ${message}${RESET}`);
}

// ═══ Helper: Walk Directory ═══
function walkDir(dir, filter, results = []) {
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
            if (!['node_modules', '.git', 'dist', 'dist-electron', '.codeql-db', 'codeql-db', 'logs', 'vendor'].includes(file)) {
                walkDir(filePath, filter, results);
            }
        } else {
            if (filter(filePath)) {
                results.push(filePath);
            }
        }
    });
    return results;
}

// ═══ Helper: Verify Case Sensitive Path on Disk ═══
function checkCaseSensitiveCasing(resolvedPath) {
    // Normalize path to get drive letter and separators standardized
    const normalized = path.normalize(resolvedPath);
    let parts = normalized.split(path.sep);

    let current = '';
    // Handle Windows drive letter
    if (parts[0] && parts[0].includes(':')) {
        current = parts[0] + path.sep;
        parts = parts.slice(1);
    } else if (normalized.startsWith(path.sep)) {
        current = path.sep;
        parts = parts.slice(parts[0] === '' ? 1 : 0);
    } else {
        current = process.cwd();
    }

    for (let part of parts) {
        if (!part) continue;
        if (!fs.existsSync(current)) return { ok: false, reason: 'Parent path does not exist' };
        
        const files = fs.readdirSync(current);
        const exactMatch = files.includes(part);
        const caseInsensitiveMatch = files.find(f => f.toLowerCase() === part.toLowerCase());

        if (exactMatch) {
            current = path.join(current, part);
        } else if (caseInsensitiveMatch) {
            return {
                ok: false,
                reason: `Casing mismatch: expected "${part}" but found "${caseInsensitiveMatch}" on disk`
            };
        } else {
            return { ok: false, reason: `File/folder "${part}" not found in "${current}"` };
        }
    }
    return { ok: true };
}

// ═══════════════════════════════════════════════════════
// 1. 版本号一致性检测 (Version Check)
// ═══════════════════════════════════════════════════════
function checkVersions() {
    printHeader('1. 检测 package.json 与 package-lock.json 版本号');
    try {
        const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));

        if (pkg.version !== lock.version) {
            printError(`版本号不一致：package.json 为 "${pkg.version}"，而 package-lock.json 为 "${lock.version}"`);
        } else {
            printPass(`版本号一致: ${pkg.version}`);
        }
    } catch (e) {
        printError(`读取版本配置文件失败: ${e.message}`);
    }
}

// ═══════════════════════════════════════════════════════
// 2. GitHub Actions 产物上传规范检测
// ═══════════════════════════════════════════════════════
function checkWorkflowConfigs() {
    printHeader('2. 检测 GitHub Actions 自动更新产物上传配置');
    const workflowPath = '.github/workflows/build.yml';
    if (!fs.existsSync(workflowPath)) {
        printWarn(`Actions 配置文件不存在: ${workflowPath}`);
        return;
    }

    try {
        const content = fs.readFileSync(workflowPath, 'utf8');
        const requiredString = 'dist-electron/*.yml';
        const occurrences = (content.split(requiredString).length - 1);

        if (occurrences < 3) {
            printError(`GitHub Actions 配置文件中未完整配置 "dist-electron/*.yml" 上传（当前仅发现 ${occurrences} 处，应至少有 3 处分别用于 Mac, Win, Linux）`);
        } else {
            printPass('Actions 自动更新配置已适配通用 *.yml 通配符');
        }
    } catch (e) {
        printError(`校验 Actions 配置文件失败: ${e.message}`);
    }
}

// ═══════════════════════════════════════════════════════
// 3. 代码合规性检测 (Static Analysis for Windows Bugs)
// ═══════════════════════════════════════════════════════
function checkStaticCode() {
    printHeader('3. 静态代码跨平台兼容性扫描 (electron/ & src/)');

    const files = walkDir('.', (f) => {
        const ext = path.extname(f).toLowerCase();
        return ['.js', '.html', '.ts'].includes(ext);
    });

    files.forEach(file => {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');

        lines.forEach((line, idx) => {
            const lineNum = idx + 1;

            // 3.1 file:// 拼接 bug
            if (line.includes('file://${') && !line.includes('toFileUrl') && !line.includes('toFileUrl(') && !line.includes('toFileUrl') && !file.includes('pre-build-check')) {
                printWarn(`[本地文件 URL] ${file}:${lineNum}: 使用了 \`file://\${...\}\` 直接拼接，在 Windows 上可能会因缺少斜杠或含反斜杠导致黑屏。请用 toFileUrl 处理！\n    内容: ${line.trim()}`);
            }

            // 3.2 硬编码 /tmp/ 路径
            if (/['"\/]tmp\//.test(line) && !line.includes('secureTmpFile') && !line.includes('os.tmpdir()') && !file.includes('pre-build-check')) {
                printError(`[临时路径] ${file}:${lineNum}: 包含硬编码的 "/tmp/" 目录，在 Windows 下会找不到路径报错。请使用 os.tmpdir() 或 app.getPath('temp')！\n    内容: ${line.trim()}`);
            }

            // 3.3 fs.chmodSync 是否被 platform !== 'win32' 包裹
            if (line.includes('chmodSync(') || line.includes('chmodSync ')) {
                // Check if nearby lines (up or down 3 lines) contain win32 platform check
                const start = Math.max(0, idx - 3);
                const end = Math.min(lines.length - 1, idx + 3);
                const context = lines.slice(start, end + 1).join('\n');
                if (!context.includes('win32') && !context.includes('platform !==')) {
                    printError(`[权限控制] ${file}:${lineNum}: 使用了 chmodSync()，但未经过 process.platform === 'win32' 的过滤保护，会在 Windows 下直接崩溃！\n    内容: ${line.trim()}`);
                }
            }

            // 3.4 Unix 专属命令拦截
            const unixCommandRegex = /\b(rm -rf|mkdir -p|cp -r|rmdir -s)\b/;
            if (unixCommandRegex.test(line) && !file.includes('pre-build-check')) {
                printWarn(`[Unix命令] ${file}:${lineNum}: 包含 Unix 特有终端命令，在 Windows CMD 中可能执行失败。建议用 fs 原生函数替换！\n    内容: ${line.trim()}`);
            }

            // 3.5 前端绝对资源路径拦截 (只针对 html 里的 src/href="/*")
            if (path.extname(file) === '.html') {
                const absoluteAssetRegex = /(src|href)=['"]\/[a-zA-Z0-9_\-]/;
                if (absoluteAssetRegex.test(line) && !line.includes('http') && !line.includes('local-media')) {
                    printError(`[网页绝对路径] ${file}:${lineNum}: 包含绝对资源路径引用 (例如 "/assets/... ")，在打包后 (file:// 协议运行下) 会解析到根盘符 (C:/)，导致无法加载！请用相对路径 "./assets/..."。\n    内容: ${line.trim()}`);
                }
            }
        });
    });
}

// ═══════════════════════════════════════════════════════
// 4. 大小写敏感路径引用检测
// ═══════════════════════════════════════════════════════
function checkCaseSensitiveImports() {
    printHeader('4. 大小写敏感模块导入引用检测');

    const files = walkDir('.', (f) => {
        const ext = path.extname(f).toLowerCase();
        return ['.js', '.ts'].includes(ext);
    });

    files.forEach(file => {
        const content = fs.readFileSync(file, 'utf8');
        const fileDir = path.dirname(file);

        // Regex for local require/import paths (starts with ./ or ../)
        const regexes = [
            /require\(['"](\.\.?[/\\].*?)['"]\)/g,
            /import\s+.*\s+from\s+['"](\.\.?[/\\].*?)['"]/g,
            /import\(['"](\.\.?[/\\].*?)['"]\)/g
        ];

        regexes.forEach(regex => {
            let match;
            while ((match = regex.exec(content)) !== null) {
                const importPath = match[1];
                let resolved = path.resolve(fileDir, importPath);
                
                // Determine possible files this import could refer to
                let candidates = [];
                if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
                    candidates.push(resolved);
                } else {
                    // Try standard JS extensions
                    const exts = ['.js', '.ts', '.json', '/index.js', '/index.ts', '/index.json'];
                    exts.forEach(ext => {
                        const testPath = resolved + ext;
                        if (fs.existsSync(testPath)) {
                            candidates.push(testPath);
                        }
                    });
                }

                if (candidates.length === 0) {
                    printError(`[导入失败] ${file}: 引入的本地模块 "${importPath}" 在磁盘上未找到！`);
                    continue;
                }

                // Check casing of the first existing candidate
                const result = checkCaseSensitiveCasing(candidates[0]);
                if (!result.ok) {
                    printError(`[模块大小写冲突] ${file}: 引入模块 "${importPath}" 的路径大小写与真实磁盘不匹配！\n    原因: ${result.reason}`);
                }
            }
        });
    });
}

// ═══════════════════════════════════════════════════════
// 5. 原生 C++ 模块检测 (.node 依赖项)
// ═══════════════════════════════════════════════════════
function checkNativeModules() {
    printHeader('5. 检测原生 C++ 模块依赖性');
    const nodeModulesDir = 'node_modules';
    if (!fs.existsSync(nodeModulesDir)) {
        printWarn('当前未安装依赖项(node_modules 不存在)，跳过原生模块检测。');
        return;
    }

    const nativeFiles = walkDir(nodeModulesDir, (f) => {
        return path.extname(f).toLowerCase() === '.node';
    });

    if (nativeFiles.length > 0) {
        let pkg = {};
        try { pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')); } catch (_) { }
        if (pkg.build?.npmRebuild === true) {
            printPass(`检测到 ${nativeFiles.length} 个原生模块，已强制开启 electron-builder 分平台重建`);
        } else {
            printError(`项目包含 ${nativeFiles.length} 个原生模块，但 package.json build.npmRebuild 未明确开启`);
        }
    } else {
        printPass('项目中未发现外部二进制原生模块依赖 (.node)，打包环境较轻量安全');
    }
}

// ═══════════════════════════════════════════════════════
// 6. 核心功能回归检查 (Reels / T字幕 / 字体 / 连体背景 / 实时预览)
// ═══════════════════════════════════════════════════════
function checkCoreFeatureRegressions() {
    printHeader('6. 核心功能回归检测 (Reels / T字幕 / 字体 / 连体背景 / 实时预览)');
    const checks = [
        {
            file: 'src/reels-style-engine.js',
            patterns: ['text_gradient_scope', 'uppercase', 'highlight_enabled', 'box_connected', 'box_concave_radius', 'box_snap_threshold', 'char_anim_intensity', 'char_anim_duration', 'char_anim_stagger'],
            desc: 'T字幕样式字段（渐变范围、非破坏式大写、朗读高亮开关、连体背景、动画参数）',
        },
        {
            file: 'src/reels-anim-engine.js',
            patterns: ['char_float_up', 'char_pop_elastic', 'char_wave', 'char_drop_bounce', 'char_squash_bounce', 'char_center_spread'],
            desc: 'T字幕 6 种逐字动画系统扩展',
        },
        {
            file: 'src/reels-canvas-renderer.js',
            patterns: ['_buildConnectedAdaptiveBoxPath', 'text_gradient_scope', 'highlight_enabled', 'uppercase'],
            desc: 'T字幕连体贴合背景几何构建与渲染兼容',
        },
        {
            file: 'src/reels-font-manager.js',
            patterns: ['UNIFIED_FONT_SELECT_IDS', 'getUnifiedFontCatalog', 'refreshCatalogIfChanged', '_loadingGoogleFontPromises'],
            desc: '统一字体库系统与 Google Fonts 按需缓存',
        },
        {
            file: 'src/reels-overlay-panel.js',
            patterns: ['_esc(', 'ropEditorEventGuard', 'rop-tpl-name-input', 'scroll_uppercase', 'scroll_letter_spacing'],
            desc: '覆层面板 HTML 转义 (_esc)、模板名称输入焦点保护与滚动文字实时预览刷新',
        },
        {
            file: 'src/reels-batch-table.js',
            patterns: ['_rbtResolveStaticVideoThumbnail', 'stopHoverPreviewVideo', 'reelsSyncTaskRemovalToBatchTabs', 'isRowDirectBgDrop', '_naturalSortByName'],
            desc: '批量 Reels 静态缩略图缓存、单悬停预览、行拖拽分配、自然数字排序与删除持久化',
        },
        {
            file: 'electron/services/reels-hdr-preview.js',
            patterns: ['classifyVideoColorProfile', 'buildBt709ConversionFilter'],
            desc: '宽色域 (HLG/PQ/BT.2020/P3) 自动识别与 BT.709 转换',
        },
        {
            file: 'electron/services/codeCacheGuard.js',
            patterns: ['rotateCodeCacheDir', 'ensureFreshCodeCacheOnStartup', 'Code Cache.before-videokit-repair-'],
            desc: '更新后自动备份重建 Code Cache 防白屏机制（保留全部工程与预设）',
        },
    ];

    for (const item of checks) {
        if (!fs.existsSync(item.file)) {
            printError(`[回归检查] 关键文件缺失: ${item.file}`);
            continue;
        }
        const content = fs.readFileSync(item.file, 'utf8');
        const missing = item.patterns.filter(p => !content.includes(p));
        if (missing.length > 0) {
            printError(`[回归检查] ${item.file} 缺少关键实现 (${missing.join(', ')}) — ${item.desc}`);
        } else {
            printPass(`${item.desc} (${item.file})`);
        }
    }
}

// ═══ Main Execution ═══
console.log(`${BOLD}${CYAN}🚀 开始执行打包前自动化跨平台兼容性体检...${RESET}`);

checkVersions();
checkWorkflowConfigs();
checkStaticCode();
checkCaseSensitiveImports();
checkNativeModules();
checkCoreFeatureRegressions();

console.log(`\n${BOLD}${CYAN}=== 体检报告汇总 ===${RESET}`);
console.log(`${GREEN}✔ PASS 项：代表当前无阻断性跨平台 Bug。${RESET}`);
console.log(`${YELLOW}⚠ WARN 项：${warnCount} 个（非阻断性警告，但需注意在 Windows 下的行为）。${RESET}`);
console.log(`${RED}✘ ERROR 项：${errorCount} 个（阻断性错误，请修复后再打包！）。${RESET}`);

if (errorCount > 0) {
    console.log(`\n${RED}${BOLD}体检未通过！共有 ${errorCount} 个 ERROR。已中断打包！请修复后重试。${RESET}\n`);
    process.exit(1);
} else {
    console.log(`\n${GREEN}${BOLD}🎉 体检通过！恭喜，代码健康状况良好，可以进行安全打包。${RESET}\n`);
    process.exit(0);
}
