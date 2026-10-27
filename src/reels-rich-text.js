/**
 * reels-rich-text.js — 富文本样式范围数据模型 & 工具集
 *
 * styled_ranges 数据结构:
 *   [{ start, end, ...styleOverrides }]
 *
 * 每个 range 代表 [start, end) 半开区间的字符索引，
 * styleOverrides 只包含与全局样式不同的属性。
 *
 * 示例:
 *   text = "God loves the world"
 *   styled_ranges = [
 *     { start: 0, end: 3, fontsize: 90, color: '#FF0000', bold: true },
 *     { start: 14, end: 19, fontsize: 80, color: '#FFD700' }
 *   ]
 *   → "God" 红色90号, "loves the " 默认, "world" 金色80号
 */

const ReelsRichText = (() => {

    // ══════════════════════════════════════════════
    //  可覆盖的样式属性白名单
    // ══════════════════════════════════════════════

    const STYLE_KEYS = [
        'fontsize', 'font_family', 'font_weight', 'color', 'bold', 'italic',
        'letter_spacing', 'underline',
        'color_outline', 'border_width',
        'bg_color', 'bg_opacity',
    ];

    // ══════════════════════════════════════════════
    //  Range 操作工具函数
    // ══════════════════════════════════════════════

    /**
     * 规范化 ranges：排序 → 合并相邻且样式完全相同的 range → 移除空 range
     */
    function normalizeRanges(ranges) {
        if (!ranges || ranges.length === 0) return [];
        // 克隆、排序
        const sorted = ranges.map(r => ({ ...r })).sort((a, b) => a.start - b.start || a.end - b.end);
        const result = [];
        for (const r of sorted) {
            if (r.start >= r.end) continue; // 移除空
            const last = result[result.length - 1];
            if (last && last.end >= r.start && _sameStyle(last, r)) {
                // 合并
                last.end = Math.max(last.end, r.end);
            } else {
                result.push(r);
            }
        }
        return result;
    }

    /**
     * 检查两个 range 的样式是否完全一致（忽略 start/end）
     */
    function _sameStyle(a, b) {
        for (const key of STYLE_KEYS) {
            if (a[key] !== b[key]) return false;
        }
        return true;
    }

    /**
     * 给 [selStart, selEnd) 区间应用样式属性。
     * 会自动拆分、合并已有的 range。
     *
     * @param {Array} ranges   当前 styled_ranges（会被修改）
     * @param {number} selStart 选区起始字符索引
     * @param {number} selEnd   选区结束字符索引
     * @param {Object} style    要应用的样式 { fontsize, color, bold, ... }
     * @returns {Array} 新的 styled_ranges
     */
    function applyStyle(ranges, selStart, selEnd, style) {
        if (selStart >= selEnd || !style || Object.keys(style).length === 0) {
            return normalizeRanges(ranges || []);
        }
        ranges = (ranges || []).map(r => ({ ...r }));

        // 第一步：拆分与选区重叠的现有 range
        const newRanges = [];
        for (const r of ranges) {
            if (r.end <= selStart || r.start >= selEnd) {
                // 不重叠，保留
                newRanges.push(r);
            } else {
                // 有重叠，可能需要拆为 3 段
                // 左段：[r.start, selStart)
                if (r.start < selStart) {
                    newRanges.push({ ...r, end: selStart });
                }
                // 中段（重叠部分）：[max(r.start,selStart), min(r.end,selEnd))
                const midStart = Math.max(r.start, selStart);
                const midEnd = Math.min(r.end, selEnd);
                if (midStart < midEnd) {
                    const merged = { ...r, start: midStart, end: midEnd };
                    // 叠加新样式
                    Object.assign(merged, style);
                    newRanges.push(merged);
                }
                // 右段：[selEnd, r.end)
                if (r.end > selEnd) {
                    newRanges.push({ ...r, start: selEnd });
                }
            }
        }

        // 第二步：确保选区中没有被已有 range 覆盖的间隙也有新样式
        // 收集选区内已被 range 覆盖的区间
        const covered = newRanges
            .filter(r => r.start < selEnd && r.end > selStart)
            .sort((a, b) => a.start - b.start);

        let cursor = selStart;
        for (const c of covered) {
            if (c.start > cursor) {
                // 间隙 [cursor, c.start)
                newRanges.push({ start: cursor, end: c.start, ...style });
            }
            cursor = Math.max(cursor, c.end);
        }
        if (cursor < selEnd) {
            newRanges.push({ start: cursor, end: selEnd, ...style });
        }

        return normalizeRanges(newRanges);
    }

    /**
     * 移除 [selStart, selEnd) 区间内的指定样式属性。
     * 如果移除后 range 没有任何样式属性了，则整个 range 被删除。
     */
    function removeStyle(ranges, selStart, selEnd, keys) {
        if (selStart >= selEnd || !keys || keys.length === 0) {
            return normalizeRanges(ranges || []);
        }
        ranges = (ranges || []).map(r => ({ ...r }));
        const newRanges = [];

        for (const r of ranges) {
            if (r.end <= selStart || r.start >= selEnd) {
                newRanges.push(r);
            } else {
                // 左段
                if (r.start < selStart) {
                    newRanges.push({ ...r, end: selStart });
                }
                // 中段：移除指定 key
                const midStart = Math.max(r.start, selStart);
                const midEnd = Math.min(r.end, selEnd);
                if (midStart < midEnd) {
                    const cleaned = { start: midStart, end: midEnd };
                    for (const k of Object.keys(r)) {
                        if (k === 'start' || k === 'end') continue;
                        if (!keys.includes(k)) cleaned[k] = r[k];
                    }
                    // 检查是否还有样式属性
                    const hasStyle = Object.keys(cleaned).some(k => k !== 'start' && k !== 'end');
                    if (hasStyle) newRanges.push(cleaned);
                }
                // 右段
                if (r.end > selEnd) {
                    newRanges.push({ ...r, start: selEnd });
                }
            }
        }
        return normalizeRanges(newRanges);
    }

    /**
     * 文本编辑后偏移所有 range 的索引。
     *
     * @param {Array} ranges    styled_ranges
     * @param {number} editPos  编辑位置（字符索引）
     * @param {number} delta    正=插入，负=删除
     * @returns {Array} 调整后的 styled_ranges
     */
    function shiftRanges(ranges, editPos, delta) {
        if (!ranges || ranges.length === 0 || delta === 0) return ranges || [];
        return normalizeRanges(ranges.map(r => {
            const range = { ...r };
            if (delta > 0) {
                // 插入
                if (range.start >= editPos) range.start += delta;
                if (range.end > editPos) range.end += delta;
            } else {
                // 删除
                const delCount = -delta;
                const delEnd = editPos + delCount;
                if (range.end <= editPos) {
                    // 在删除区域之前，不受影响
                } else if (range.start >= delEnd) {
                    // 在删除区域之后
                    range.start -= delCount;
                    range.end -= delCount;
                } else {
                    // 与删除区域重叠
                    range.start = Math.min(range.start, editPos);
                    range.end = Math.max(editPos, range.end - delCount);
                }
            }
            return range;
        }).filter(r => r.start < r.end));
    }

    // ══════════════════════════════════════════════
    //  文本拆分：将文本按 ranges 分为带样式的片段
    // ══════════════════════════════════════════════

    /**
     * 将纯文本按 styled_ranges 拆成样式片段数组。
     *
     * @param {string} text     原始文本
     * @param {Array}  ranges   styled_ranges
     * @param {Object} baseStyle 基础全局样式
     * @returns {Array<{text, start, end, style}>}  每个片段包含文字和合并后的完整样式
     */
    function splitByRanges(text, ranges, baseStyle = {}) {
        if (!text) return [];
        ranges = normalizeRanges(ranges || []);
        if (ranges.length === 0) {
            return [{ text, start: 0, end: text.length, style: { ...baseStyle } }];
        }

        // 收集所有分割点
        const cuts = new Set([0, text.length]);
        for (const r of ranges) {
            if (r.start > 0 && r.start < text.length) cuts.add(r.start);
            if (r.end > 0 && r.end < text.length) cuts.add(r.end);
        }
        const sorted = [...cuts].sort((a, b) => a - b);

        const result = [];
        for (let i = 0; i < sorted.length - 1; i++) {
            const s = sorted[i];
            const e = sorted[i + 1];
            const segText = text.substring(s, e);
            if (!segText) continue;

            // 查找覆盖此区间的所有 ranges，依序合并样式
            const style = { ...baseStyle };
            for (const r of ranges) {
                if (r.start <= s && r.end >= e) {
                    // 完全覆盖或等于 → 应用样式
                    for (const k of STYLE_KEYS) {
                        if (r[k] !== undefined) style[k] = r[k];
                    }
                    if (r.bold !== undefined && r.font_weight === undefined) {
                        if (r.bold && (parseInt(style.font_weight, 10) || 400) < 600) {
                            style.font_weight = 700;
                        } else if (!r.bold && (parseInt(style.font_weight, 10) || 700) >= 600) {
                            style.font_weight = 400;
                        }
                    } else if (r.font_weight !== undefined && r.bold === undefined) {
                        style.bold = (parseInt(r.font_weight, 10) || 400) >= 600;
                    }
                }
            }
            result.push({ text: segText, start: s, end: e, style });
        }
        return result;
    }

    // ══════════════════════════════════════════════
    //  序列化 / 反序列化
    // ══════════════════════════════════════════════

    /**
     * 清理 ranges 中的默认值（与 baseStyle 相同的属性不需要存储）
     */
    function compactRanges(ranges, baseStyle = {}) {
        return normalizeRanges((ranges || []).map(r => {
            const clean = { start: r.start, end: r.end };
            for (const k of STYLE_KEYS) {
                if (r[k] !== undefined && r[k] !== baseStyle[k]) {
                    clean[k] = r[k];
                }
            }
            const hasStyle = Object.keys(clean).some(k => k !== 'start' && k !== 'end');
            return hasStyle ? clean : null;
        }).filter(Boolean));
    }

    /**
     * 验证 ranges 是否合法（所有索引在文本长度内）
     */
    function validateRanges(ranges, textLength) {
        if (!ranges) return [];
        return normalizeRanges(ranges.map(r => ({
            ...r,
            start: Math.max(0, Math.min(r.start, textLength)),
            end: Math.max(0, Math.min(r.end, textLength)),
        })).filter(r => r.start < r.end));
    }

    // ══════════════════════════════════════════════
    //  自动着色 (Auto Colorize)
    // ══════════════════════════════════════════════

    function autoColorize(text, rules) {
        if (!text || !rules || rules.length === 0) return [];
        const ranges = [];
        const REGEX_TYPES = new Set(['number', 'english', 'punctuation', 'regex']);
        for (const rule of rules) {
            if (!rule.keywords || rule.keywords.length === 0) continue;
            const sorted = [...rule.keywords].filter(k => k).sort((a, b) => b.length - a.length);
            if (sorted.length === 0) continue;

            let pattern;
            if (rule.type === 'english') {
                // Historical name kept for saved projects.  This is a
                // multilingual word rule: \p{L} handles Polish/French letters
                // and \p{M} keeps decomposed accents with their base letter.
                pattern = new RegExp("[\\p{L}\\p{M}]+(?:[’'\\-][\\p{L}\\p{M}]+)*", 'gu');
            } else if (REGEX_TYPES.has(rule.type)) {
                try {
                    pattern = new RegExp(sorted.join('|'), 'gu');
                } catch (e) {
                    console.warn('[AutoColor] Invalid regex:', sorted, e);
                    continue;
                }
            } else {
                const escaped = sorted.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                pattern = new RegExp(escaped.join('|'), rule.case_sensitive === true ? 'gu' : 'giu');
            }

            let match;
            while ((match = pattern.exec(text)) !== null) {
                if (match[0].length === 0) { pattern.lastIndex++; continue; }
                const r = { start: match.index, end: match.index + match[0].length };
                if (rule.color) r.color = rule.color;
                if (rule.bold === true) {
                    r.bold = true;
                    r.font_weight = 700;
                }
                if (rule.fontsize && rule.fontsize > 0) r.fontsize = rule.fontsize;
                if (rule.italic === true) r.italic = true;
                ranges.push(r);
            }
        }
        return ranges;
    }

    function mergeAutoAndManual(autoRanges, manualRanges) {
        if (!autoRanges || autoRanges.length === 0) return manualRanges || [];
        if (!manualRanges || manualRanges.length === 0) return autoRanges;

        // 手动样式覆盖自动样式，通过组合即可在 splitByRanges 阶段发挥后者覆盖前者的效果
        return normalizeRanges([...autoRanges, ...manualRanges]);
    }

    const _autoColorCache = new Map();
    const _AUTO_COLOR_CACHE_MAX = 50;
    
    function getCachedAutoColor(text, rules) {
        if (!text || !rules || rules.length === 0) return [];
        // 用 text + rules JSON 生成缓存 key
        const key = text + '||' + JSON.stringify(rules);
        if (_autoColorCache.has(key)) return _autoColorCache.get(key);
        const result = autoColorize(text, rules);
        if (_autoColorCache.size > _AUTO_COLOR_CACHE_MAX) _autoColorCache.clear();
        _autoColorCache.set(key, result);
        return result;
    }

    // ══════════════════════════════════════════════
    //  导出
    // ══════════════════════════════════════════════

    return {
        STYLE_KEYS,
        normalizeRanges,
        applyStyle,
        removeStyle,
        shiftRanges,
        splitByRanges,
        compactRanges,
        validateRanges,
        autoColorize,
        mergeAutoAndManual,
        getCachedAutoColor,
    };

})();

if (typeof window !== 'undefined') window.ReelsRichText = ReelsRichText;
if (typeof module !== 'undefined' && module.exports) module.exports = ReelsRichText;
