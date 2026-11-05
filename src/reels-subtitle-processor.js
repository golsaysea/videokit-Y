/**
 * reels-subtitle-processor.js — 字幕处理引擎
 * 
 * 完整移植自 AutoSub_v8 的以下功能：
 *   - merge_short_segments()       合并短片段
 *   - interpolate_missing_times()  填补缺失时间戳
 *   - tokenize_for_wrap()          中英文自动分词
 *   - wrap_tokens_by_pixel_width() 按像素宽度自动换行
 *   - resegment_words_by_style()   基于样式的智能分段 (核心)
 *   - smart_segmentation()         智能总流程
 * 
 * 全部在浏览器端执行，使用 Canvas 2D measureText 替代 Qt's QFontMetrics。
 */

// ═══════════════════════════════════════════════════════
// 1. Text Tokenization (中/英/日/韩分词)
// ═══════════════════════════════════════════════════════

/**
 * 按语言特性拆分文本为 token 数组。
 * - 含空白的文本 → 按空白分割 (英语/拉丁)
 * - 无空白且不含 CJK → 整段保留为一个 token，避免单个英文词被拆成字母
 * - 无空白且含 CJK → CJK 按字拆，拉丁/数字连续串保持完整
 * @returns {[string[], string]} [tokens, joiner]
 */
function tokenizeForWrap(text) {
    if (!text) return [[], ''];
    const normalized = String(text).trim();
    if (!normalized) return [[], ''];

    if (/\s/.test(normalized)) {
        const tokens = normalized.split(/\s+/).filter(t => t !== '');
        return [tokens, ' '];
    }

    const cjkLikeRe = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
    if (!cjkLikeRe.test(normalized)) {
        return [[normalized], ''];
    }

    const tokens = [];
    let nonCjkRun = '';
    for (const ch of Array.from(normalized)) {
        if (cjkLikeRe.test(ch)) {
            if (nonCjkRun) {
                tokens.push(nonCjkRun);
                nonCjkRun = '';
            }
            tokens.push(ch);
        } else {
            nonCjkRun += ch;
        }
    }
    if (nonCjkRun) tokens.push(nonCjkRun);
    return [tokens, ''];
}

// ═══════════════════════════════════════════════════════
// 2. Canvas Font Metrics (替代 QFontMetrics)
// ═══════════════════════════════════════════════════════

/**
 * 创建临时 Canvas 上下文，用于精确测量文本像素宽度。
 */
let _measureCanvas = null;
let _measureCtx = null;

function _ensureMeasureCtx() {
    if (!_measureCtx) {
        if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
            _measureCanvas = document.createElement('canvas');
            _measureCanvas.width = 1;
            _measureCanvas.height = 1;
            _measureCtx = _measureCanvas.getContext('2d');
        } else {
            _measureCtx = {
                font: '700 74px "Arial", sans-serif',
                measureText(str) {
                    const text = String(str || '');
                    const sizeMatch = String(this.font || '').match(/(\d+(?:\.\d+)?)px/i);
                    const fontSize = sizeMatch ? parseFloat(sizeMatch[1]) : 74;
                    const isBold = /\b([6-9]00|bold)\b/i.test(String(this.font || ''));
                    const boldScale = isBold ? 1.06 : 1.0;
                    let width = 0;
                    for (const ch of text) {
                        const code = ch.codePointAt(0) || 0;
                        if (code > 0x2E80) {
                            width += fontSize * 1.0;
                        } else if ('iIlj1!|.,:;\'"`'.includes(ch)) {
                            width += fontSize * 0.32 * boldScale;
                        } else if ('mMwW@%'.includes(ch)) {
                            width += fontSize * 0.85 * boldScale;
                        } else if (ch === ' ') {
                            width += fontSize * 0.28;
                        } else if (ch >= 'A' && ch <= 'Z') {
                            width += fontSize * 0.65 * boldScale;
                        } else {
                            width += fontSize * 0.56 * boldScale;
                        }
                    }
                    return { width };
                },
            };
        }
    }
    return _measureCtx;
}

/**
 * 测量文本像素宽度。
 * @param {string} text - 要测量的文本
 * @param {string} fontFamily
 * @param {number} fontSize
 * @param {boolean} bold
 * @param {boolean} italic
 * @param {number} letterSpacing - 字母间距(px)
 * @returns {number} 宽度(px)
 */
function measureTextWidth(text, fontFamily, fontSize, bold, italic, letterSpacing = 0) {
    const ctx = _ensureMeasureCtx();
    const parts = [];
    const weight = typeof bold === 'number'
        ? Math.max(100, Math.min(900, parseInt(bold, 10) || 400))
        : (bold ? 700 : 400);
    if (italic) parts.push('italic');
    parts.push(String(weight));
    parts.push(`${fontSize}px`);
    parts.push(`"${fontFamily}", ${_resolveMeasureFallback(fontFamily)}`);
    ctx.font = parts.join(' ');

    if (letterSpacing && letterSpacing !== 0) {
        // Canvas measureText 不直接支持 letter-spacing，手动计算
        let totalW = 0;
        const chars = Array.from(text);
        for (let i = 0; i < chars.length; i++) {
            totalW += ctx.measureText(chars[i]).width;
            if (i < chars.length - 1) totalW += letterSpacing;
        }
        return totalW;
    }
    return ctx.measureText(text).width;
}

function _resolveMeasureFallback(fontFamily) {
    const f = String(fontFamily || '').toLowerCase();
    const serifHints = [
        'serif', 'times', 'georgia', 'playfair', 'crimson', 'lora', 'gelasio',
        'caslon', 'vidaloka', 'yeseva', 'dm serif', 'young serif', 'rye',
        'song', 'ming', 'mincho',
    ];
    return serifHints.some(k => f.includes(k)) ? 'serif' : 'sans-serif';
}

// ═══════════════════════════════════════════════════════
// 3. Pixel-Width Text Wrapping (像素级自动换行)
// __移植自 wrap_tokens_by_pixel_width__
// ═══════════════════════════════════════════════════════

/**
 * 按像素宽度将 token 列表换行，保持单词完整。
 * @param {string[]} tokens
 * @param {number} maxWidthPx
 * @param {string} joiner - token 之间的连接符 (空格或空串)
 * @param {object} fontOpts - { fontFamily, fontSize, bold, italic, letterSpacing }
 * @returns {string[]} lines
 */
function wrapTokensByPixelWidth(tokens, maxWidthPx, joiner, fontOpts) {
    const { fontFamily, fontSize, bold, italic, letterSpacing } = fontOpts;
    const measure = (t) => measureTextWidth(t, fontFamily, fontSize, bold, italic, letterSpacing);

    const lines = [];
    let curr = '';
    for (const token of tokens) {
        const cand = curr ? (curr + joiner + token) : token;
        if (!curr || measure(cand) <= maxWidthPx) {
            curr = cand;
        } else {
            lines.push(curr);
            curr = token;
        }
    }
    if (curr) lines.push(curr);
    return lines;
}

/**
 * 按像素宽度将完整文本换行。处理已有 \n 的情况。
 */
function wrapTextByPixelWidth(text, maxWidthPx, fontOpts) {
    if (text == null) return [];
    const lines = [];
    for (const raw of String(text).split('\n')) {
        const [tokens, joiner] = tokenizeForWrap(raw);
        if (tokens.length > 0) {
            lines.push(...wrapTokensByPixelWidth(tokens, maxWidthPx, joiner, fontOpts));
        } else {
            lines.push(raw);
        }
    }
    return lines;
}

// ═══════════════════════════════════════════════════════
// 4. Merge Short Segments (合并短片段)
// __移植自 merge_short_segments__
// ═══════════════════════════════════════════════════════

/**
 * 合并时长过短的字幕片段到相邻片段。
 * @param {Array} segments - [{start, end, text, words?}, ...]
 * @param {number} shortDur - 小于此时长(秒)视为短片段
 * @param {number} maxGap - 最大可合并间隙(秒)
 * @param {number} minDur - 合并后最低时长(秒)
 * @returns {Array} 合并后的 segments
 */
function mergeShortSegments(segments, shortDur = 0.35, maxGap = 0.25, minDur = 0.25) {
    const segs = segments.slice().sort((a, b) => (a.start || 0) - (b.start || 0));
    const endsWithSentencePunct = (txt) => /[.!?。！？]+['"\u201D\u2019）)】\]》」]*$/.test(String(txt || '').trim());
    let i = 0;
    while (i < segs.length) {
        const s = segs[i].start;
        const e = segs[i].end;
        if (typeof s !== 'number' || typeof e !== 'number') { i++; continue; }
        const dur = e - s;
        if (dur >= shortDur) { i++; continue; }

        let bestIdx = null;
        let bestGap = null;

        // 尝试右邻 (若当前片段已经是句尾标点结束，则绝不跨越句号合并到下一句)
        if (i + 1 < segs.length && !endsWithSentencePunct(segs[i].text)) {
            const rs = segs[i + 1].start;
            if (typeof rs === 'number') {
                const gapR = rs - e;
                if (gapR <= maxGap) { bestIdx = i + 1; bestGap = gapR; }
            }
        }
        // 尝试左邻 (选更近的；若左邻已经是句尾标点结束，则绝不跨越句号合并到上一句)
        if (i - 1 >= 0 && !endsWithSentencePunct(segs[i - 1].text)) {
            const le = segs[i - 1].end;
            if (typeof le === 'number') {
                const gapL = s - le;
                if (gapL <= maxGap && (bestIdx === null || gapL < bestGap)) {
                    bestIdx = i - 1; bestGap = gapL;
                }
            }
        }

        if (bestIdx === null) { i++; continue; }

        const target = segs[bestIdx];
        if (bestIdx < i) {
            target.start = Math.min(target.start || s, s);
            target.end = Math.max(target.end || e, e);
            if (target.text && segs[i].text) target.text = `${target.text} ${segs[i].text}`;
            else target.text = target.text || segs[i].text || '';
            if (target.words && segs[i].words) target.words = target.words.concat(segs[i].words);
        } else {
            target.start = Math.min(target.start || s, s);
            target.end = Math.max(target.end || e, e);
            if (segs[i].text && target.text) target.text = `${segs[i].text} ${target.text}`;
            else target.text = segs[i].text || target.text || '';
            if (target.words && segs[i].words) target.words = segs[i].words.concat(target.words);
        }
        segs.splice(i, 1);
        i = bestIdx < i ? Math.max(0, bestIdx - 1) : Math.max(0, i - 1);
    }

    // 保证最低时长
    segs.sort((a, b) => (a.start || 0) - (b.start || 0));
    for (const seg of segs) {
        if (typeof seg.start === 'number' && typeof seg.end === 'number') {
            if (seg.end < seg.start + minDur) seg.end = seg.start + minDur;
        }
    }
    return segs;
}

// ═══════════════════════════════════════════════════════
// 5. Interpolate Missing Word Times (填补缺失时间戳)
// __移植自 _interpolate_missing_word_times__
// ═══════════════════════════════════════════════════════

/**
 * 线性插值填补缺失时间戳的单词。
 * @param {Array} words - [{word, start, end, wid}, ...]
 * @param {number|null} audioDur - 音频总时长(秒)
 * @returns {Array} words (原地修改)
 */
function interpolateMissingWordTimes(words, audioDur = null) {
    if (!words || words.length === 0) return words;
    const valid = (t) => typeof t === 'number' && isFinite(t);
    const n = words.length;
    let i = 0;

    while (i < n) {
        if (valid(words[i].start) && valid(words[i].end)) { i++; continue; }
        const runStart = i;
        while (i < n && (!valid(words[i].start) || !valid(words[i].end))) i++;
        const runEnd = i - 1;

        let prevEnd = null;
        if (runStart - 1 >= 0 && valid(words[runStart - 1].end))
            prevEnd = words[runStart - 1].end;
        let nextStart = null;
        if (runEnd + 1 < n && valid(words[runEnd + 1].start))
            nextStart = words[runEnd + 1].start;

        const count = runEnd - runStart + 1;

        if (valid(prevEnd) && valid(nextStart) && nextStart >= prevEnd) {
            const span = nextStart - prevEnd;
            const step = span / (count + 1);
            for (let k = 0; k < count; k++) {
                words[runStart + k].start = prevEnd + step * k;
                words[runStart + k].end = prevEnd + step * (k + 1);
            }
        } else if (!valid(prevEnd) && valid(nextStart) && nextStart > 0 && count > 0) {
            // 开头缺失：回填最多1.2s
            const ns = nextStart;
            const span = Math.min(ns, 1.2);
            const base = Math.max(0, ns - span);
            const step = span / (count + 1);
            for (let k = 0; k < count; k++) {
                words[runStart + k].start = base + step * k;
                words[runStart + k].end = base + step * (k + 1);
            }
        } else {
            const fallback = valid(prevEnd) ? prevEnd : (valid(nextStart) ? nextStart : 0);
            for (let idx = runStart; idx <= runEnd; idx++) {
                words[idx].start = fallback;
                words[idx].end = fallback;
            }
        }
    }

    // 裁剪到音频时长范围
    if (valid(audioDur) && audioDur > 0) {
        for (const w of words) {
            if (valid(w.start)) w.start = Math.max(0, Math.min(w.start, audioDur));
            if (valid(w.end)) w.end = Math.max(0, Math.min(w.end, audioDur));
        }
    }
    return words;
}

// ═══════════════════════════════════════════════════════
// 6. Resegment by Style (基于样式的智能分段 — 核心)
// __移植自 resegment_words_by_style__
// ═══════════════════════════════════════════════════════

/**
 * 基于字幕样式 (字体大小、换行宽度、最大行数) 将单词列表重新分段。
 * 使用 Canvas 像素测量代替 QFontMetrics。
 * 
 * @param {Array} allWords - [{word, start, end, wid}, ...]
 * @param {object} style - 当前字幕样式对象
 * @param {number} videoW - 视频宽度(px)
 * @returns {Array} segments - [{start, end, text, words}, ...]
 */
function resegmentWordsByStyle(allWords, style, videoW) {
    if (!allWords || allWords.length === 0) return [];

    const s = style || {};
    const fontSize = parseInt(s.fontsize) || 74;
    const fontWeight = Math.max(100, Math.min(900, parseInt(s.font_weight || (s.bold !== false ? 700 : 400), 10) || 700));
    const maxLines = Math.max(1, parseInt(s.wrap_lines) || 2);
    if (typeof videoW !== 'number' || videoW <= 0) videoW = 1920;

    // 计算最大排版宽度
    let maxWidthPx = null;
    const wrapLeft = s.wrap_left;
    const wrapRight = s.wrap_right;
    if (typeof wrapLeft === 'number' && typeof wrapRight === 'number' && wrapRight > wrapLeft + 50) {
        maxWidthPx = Math.round(wrapRight - wrapLeft);
    }
    if (maxWidthPx === null) {
        const wrapPercent = Math.max(20, Math.min(120, parseInt(s.wrap_width_percent) || 100));
        const margin = 100;
        const baseW = Math.max(200, videoW - margin * 2);
        maxWidthPx = Math.max(200, Math.round(baseW * (wrapPercent / 100)));
    }
    if (s.advanced_textbox_enabled) {
        maxWidthPx = Math.max(80, parseInt(s.advanced_textbox_w) || maxWidthPx);
    }

    const fontOpts = {
        fontFamily: s.font_family || 'Arial',
        fontSize: fontSize,
        bold: fontWeight >= 600,
        italic: !!s.italic,
        letterSpacing: s.letter_spacing || 0,
    };

    // 标点断句正则与词数限制
    const maxWordsPerSeg = Math.max(0, parseInt(s.max_words_per_segment, 10) || 0);
    const maxWordsPerLine = Math.max(0, parseInt(s.max_words_per_line, 10) || 0);
    const hardBreakRe = maxWordsPerSeg > 0
        ? /[.!?。！？；;]+['"\u201D\u2019）)】\]》」]*$/
        : /[.。！？!?；;：:]+['"\u201D\u2019）)】\]》」]*$|[\"'\u201D\u2019）)】\]》」]$/;
    const isAbbrevToken = (tok) => /^(mr|mrs|ms|dr|st|prof|sr|jr|vs|etc|no)\.$/i.test(String(tok || '').trim());
    const commaBreakRe = /[，,;；]['"\u201D\u2019）)】\]》」]*$/;
    const gapThreshold = parseFloat(s.segment_gap_sec) || 0.45;

    function packEventWords(words) {
        if (!words || words.length === 0) return null;
        const text = words.map(w => w.word || '').filter(Boolean).join(' ').trim();
        return {
            start: words[0].start,
            end: words[words.length - 1].end,
            words: words,
            text: text,
        };
    }

    function wouldFit(currentWords, nextToken) {
        const tokens = currentWords.map(w => w.word || '').filter(Boolean);
        if (nextToken) tokens.push(nextToken);
        if (tokens.length === 0) return true;
        if (maxWordsPerSeg > 0 && tokens.length > maxWordsPerSeg) return false;
        if (maxWordsPerLine > 0 && tokens.length > maxLines * maxWordsPerLine) return false;
        if (maxWordsPerSeg > 0 && s.balanced_two_line_wrap && tokens.length <= maxWordsPerSeg) {
            return true;
        }
        const [toks, joiner] = tokenizeForWrap(tokens.join(' '));
        const lines = wrapTokensByPixelWidth(toks, maxWidthPx, joiner, fontOpts);
        return lines.length <= maxLines;
    }

    const events = [];
    let currentWords = [];
    let clauseWordCount = 0;
    let prevEnd = null;
    let prevToken = null;

    for (const w of allWords) {
        const token = (w.word || '').trim();
        if (!token) continue;

        // 标点断句
        if (currentWords.length > 0 && prevToken && hardBreakRe.test(prevToken) && !isAbbrevToken(prevToken)) {
            const packed = packEventWords(currentWords);
            if (packed) events.push(packed);
            currentWords = [];
            clauseWordCount = 0;
        } else if (maxWordsPerSeg > 0 && currentWords.length > 0 && prevToken && commaBreakRe.test(prevToken) && clauseWordCount > maxWordsPerSeg) {
            const packed = packEventWords(currentWords);
            if (packed) events.push(packed);
            currentWords = [];
            clauseWordCount = 0;
        }

        // 间隔断句
        if (currentWords.length > 0 && typeof prevEnd === 'number' && typeof w.start === 'number') {
            if (w.start - prevEnd >= gapThreshold) {
                const packed = packEventWords(currentWords);
                if (packed) events.push(packed);
                currentWords = [];
                clauseWordCount = 0;
            }
        }

        // 每屏词数上限或宽度断句
        if (currentWords.length > 0 && ((maxWordsPerSeg > 0 && currentWords.length >= maxWordsPerSeg) || !wouldFit(currentWords, token))) {
            const packed = packEventWords(currentWords);
            if (packed) events.push(packed);
            currentWords = [];
        }

        currentWords.push({ word: token, start: w.start, end: w.end, wid: w.wid });
        clauseWordCount++;
        prevEnd = w.end;
        prevToken = token;
    }

    const packed = packEventWords(currentWords);
    if (packed) events.push(packed);

    return events;
}

// ═══════════════════════════════════════════════════════
// 7. Smart Segmentation Pipeline (智能分段总流程)
// __移植自 smart_segmentation__
// ═══════════════════════════════════════════════════════

/**
 * 智能字幕分段流水线。
 * 1. 扁平化所有 word （从 segments/words 中提取）
 * 2. 插值填补缺失时间戳
 * 3. 按样式和视频宽度重新分段
 * 4. 合并过短片段
 * 
 * @param {Array} segments - 原始 segments [{text, words:[{word,start,end},...], start, end}, ...]
 * @param {object} style - 字幕样式
 * @param {number} videoW - 视频宽度(px)
 * @param {number|null} audioDur - 音频时长(秒)
 * @returns {Array} 重新分段后的 segments
 */
function smartSegmentation(segments, style, videoW = 1920, audioDur = null) {
    // 步骤1：扁平化 words
    const allWords = flattenWordsFromSegments(segments);
    if (allWords.length === 0) return segments || [];

    // 步骤2：插值
    interpolateMissingWordTimes(allWords, audioDur);

    // 步骤3：按样式分段
    let result = resegmentWordsByStyle(allWords, style, videoW);

    // 步骤4：合并短片段
    result = mergeShortSegments(result, 0.35, 0.25, 0.25);

    return result;
}

/**
 * 从 segments 中提取所有 word 对象。
 */
function flattenWordsFromSegments(segments) {
    const allWords = [];
    let wid = 0;
    for (const seg of (segments || [])) {
        for (const w of (seg.words || [])) {
            const token = w.word || '';
            if (!token) continue;
            allWords.push({
                word: token,
                start: w.start,
                end: w.end,
                wid: wid++,
            });
        }
    }
    return allWords;
}

// ═══════════════════════════════════════════════════════
// 8. Enhanced SRT ↔ Segments Conversion
// ═══════════════════════════════════════════════════════

/**
 * 针对词级别时间戳进行更健壮的分词（用于卡拉OK高亮、单字显示等动画用途）
 * - CJK 汉字按单字拆分。
 * - 英文/拉丁文/数字以空格分词，保持完整。
 * - 所有的标点符号、符号和空白字符，会自动附着并合并到前一个有效字/词的末尾（如果在最开头，则附着到下一个有效字/词的开头），防止标点单独出现。
 */
function tokenizeForWordTiming(text) {
    if (!text) return [];
    const normalized = String(text).trim();
    if (!normalized) return [];

    const cjkLikeRe = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
    const punctRe = /^[，。！？；：、（）《》【】“”‘’「」『』—…\s,.\-!?:;()\[\]{}'"`~@#$%^&*_+=\/\\|]+$/;

    const chars = Array.from(normalized);
    const rawTokens = [];

    let currentWord = '';
    let currentPunct = '';

    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (cjkLikeRe.test(ch)) {
            if (currentWord) {
                rawTokens.push({ type: 'word', text: currentWord });
                currentWord = '';
            }
            if (currentPunct) {
                rawTokens.push({ type: 'punct', text: currentPunct });
                currentPunct = '';
            }
            rawTokens.push({ type: 'cjk', text: ch });
        } else if (/\s/.test(ch)) {
            if (currentWord) {
                rawTokens.push({ type: 'word', text: currentWord });
                currentWord = '';
            }
            if (currentPunct) {
                rawTokens.push({ type: 'punct', text: currentPunct });
                currentPunct = '';
            }
        } else if (punctRe.test(ch)) {
            if (currentWord) {
                rawTokens.push({ type: 'word', text: currentWord });
                currentWord = '';
            }
            currentPunct += ch;
        } else {
            if (currentPunct) {
                rawTokens.push({ type: 'punct', text: currentPunct });
                currentPunct = '';
            }
            currentWord += ch;
        }
    }
    if (currentWord) rawTokens.push({ type: 'word', text: currentWord });
    if (currentPunct) rawTokens.push({ type: 'punct', text: currentPunct });

    const tokens = [];
    let pendingPrepend = '';

    for (const token of rawTokens) {
        if (token.type === 'punct') {
            if (tokens.length > 0) {
                tokens[tokens.length - 1] += token.text;
            } else {
                pendingPrepend += token.text;
            }
        } else {
            let tokenText = token.text;
            if (pendingPrepend) {
                tokenText = pendingPrepend + tokenText;
                pendingPrepend = '';
            }
            tokens.push(tokenText);
        }
    }
    if (pendingPrepend && tokens.length > 0) {
        tokens[tokens.length - 1] += pendingPrepend;
    } else if (pendingPrepend) {
        tokens.push(pendingPrepend);
    }

    return tokens;
}

/**
 * 将 SRT 解析结果转为带 words 的 segments。
 * 对于每个 SRT 条目，如果没有 words 信息，自动按字符生成假 word 时间。
 */
function srtToSegmentsWithWords(srtSegments) {
    return srtSegments.map(seg => {
        // 兼容两种输入:
        // 1) 毫秒 (subtitle service parseSRT)
        // 2) 秒 (reels-canvas-renderer parseSRT)
        const rawStart = Number(seg.start || 0);
        const rawEnd = Number(seg.end || 0);
        const unit = String(seg._timeUnit || seg.timeUnit || '').toLowerCase();
        const looksLikeMs = unit === 'ms' || (unit !== 'sec' && Number.isInteger(rawStart) && Number.isInteger(rawEnd) && rawEnd > 1000);
        const startSec = looksLikeMs ? (rawStart / 1000) : rawStart;
        const endSec = looksLikeMs ? (rawEnd / 1000) : rawEnd;
        const text = seg.text || '';
        const dur = endSec - startSec;

        let needsRegen = !seg.words || seg.words.length === 0;
        if (seg.words && seg.words.length === 1 && text.trim().length > 1) {
            needsRegen = true;
        }

        if (!needsRegen) {
            return { start: startSec, end: endSec, text, words: seg.words };
        }

        // 自动按 token 生成均匀分布的 word timing
        const tokens = tokenizeForWordTiming(text.replace(/\n/g, ' '));
        const words = tokens.map((token, i) => ({
            word: token,
            start: startSec + (dur * i / tokens.length),
            end: startSec + (dur * (i + 1) / tokens.length),
        }));

        return { start: startSec, end: endSec, text, words };
    });
}


/**
 * 将 segments 转回 SRT 格式字符串。
 */
function segmentsToSRT(segments) {
    return segments.map((seg, i) => {
        const idx = i + 1;
        const fmtTime = (sec) => {
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            const s = sec % 60;
            const ms = Math.round((s - Math.floor(s)) * 1000);
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
        };
        return `${idx}\n${fmtTime(seg.start)} --> ${fmtTime(seg.end)}\n${seg.text}`;
    }).join('\n\n') + '\n';
}

// ═══════════════════════════════════════════════════════
// 9. Enhanced ASS Generation (增强 ASS 导出)
// __移植自 AutoSub 的 ASS 样式系统，含高亮色、box、渐变__
// ═══════════════════════════════════════════════════════

/**
 * 生成增强版 .ass 文件 — 最大化还原 Canvas 预览效果
 * 
 * 支持:
 * - 字体样式、描边、阴影（无上限）、对齐
 * - 卡拉OK 逐词变色 (\kf tag)
 * - box 背景 (BorderStyle 3)
 * - letter-spacing
 * - 淡入/淡出 动画 (\fad)
 * - 上滑/下滑/左滑/右滑 动画 (\move)
 * - 弹出 动画 (\t + \fscx + \fscy)
 * - 模糊渐清 动画 (\blur + \t)
 * - 下划线 (\u1)
 * - 多层描边扩展 (多 Dialogue 层模拟)
 * - 打字机 效果 (\kf 逐字)
 * 
 * @param {Array} segments - [{start, end, text, words?}, ...]
 * @param {object} style - 样式对象
 * @param {object} opts - { videoW, videoH, karaokeHighlight }
 * @returns {string} ASS 文件内容
 */
function generateEnhancedASS(segments, style, opts = {}) {
    const s = style || {};
    const videoW = opts.videoW || 1080;
    const videoH = opts.videoH || 1920;
    const explicitKaraoke = opts.karaokeHighlight !== undefined
        ? opts.karaokeHighlight !== false
        : (s.karaoke_highlight !== undefined
            ? Boolean(s.karaoke_highlight)
            : (s.highlight ? s.highlight === 'word-by-word' : true));
    const karaokeHL = explicitKaraoke;

    const fontFamily = s.font_family || 'Arial';
    const fontSize = s.fontsize || 74;
    const fontWeight = Math.max(100, Math.min(900, parseInt(s.font_weight || (s.bold !== false ? 700 : 400), 10) || 700));
    const bold = fontWeight >= 600 ? -1 : 0;
    const italic = s.italic ? -1 : 0;
    const spacing = s.letter_spacing || 0;

    function toASSColor(hex, alpha = 0) {
        if (!hex) hex = '#FFFFFF';
        hex = hex.replace('#', '');
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        const r = hex.substr(0, 2);
        const g = hex.substr(2, 2);
        const b = hex.substr(4, 2);
        const a = alpha.toString(16).padStart(2, '0').toUpperCase();
        return `&H${a}${b}${g}${r}`;
    }

    const colorTextHex = s.color_text || s.primary_color || '#FFFFFF';
    const colorHighHex = s.color_high || s.keyword_color || (s.highlight === 'word-by-word' ? '#FFD700' : '');
    const colorOutlineHex = s.color_outline || s.outline_color || '#3E2723';

    const primaryColor = toASSColor(colorTextHex);
    const secondaryColor = toASSColor(colorHighHex || '#FFD700');
    const outlineColor = toASSColor(colorOutlineHex);
    const shadowAlpha = Math.round(255 - (s.opacity_shadow || 150));
    const shadowColor = toASSColor(s.color_shadow || '#000000', shadowAlpha);

    const borderW = s.use_stroke !== false ? (s.border_width || 3) : 0;
    // 阴影距离：综合偏移量和模糊值
    const shadowDist = Math.max(
        Math.abs(s.shadow_offset_x || 0),
        Math.abs(s.shadow_offset_y || 0),
        s.shadow_blur ? Math.max(1, Math.round(s.shadow_blur * 0.5)) : 0
    );

    // BorderStyle: 1=outline+shadow, 3=opaque box
    const borderStyle = s.use_box ? 3 : 1;
    const backColor = s.use_box
        ? toASSColor(s.color_bg || '#000000', Math.round(255 - (s.opacity_bg ?? 150)))
        : shadowColor;

    // 下划线
    const useUnderline = s.use_underline ? -1 : 0;

    // 位置计算 — 使用精确 \pos 与 \an
    const useAdvTextbox = !!s.advanced_textbox_enabled;
    const advAlign = String(s.advanced_textbox_align || s.adv_text_align || 'center').toLowerCase();
    const advValign = String(s.advanced_textbox_valign || 'center').toLowerCase();
    
    // ASS Alignment Numbering:
    // 7 8 9 (Top Left, Top Center, Top Right)
    // 4 5 6 (Middle Left, Middle Center, Middle Right)
    // 1 2 3 (Bottom Left, Bottom Center, Bottom Right)
    const bx = advAlign === 'left' ? 1 : (advAlign === 'right' ? 3 : 2);
    const by = advValign === 'bottom' ? 0 : (advValign === 'top' ? 6 : 3);
    const baseAlign = useAdvTextbox ? (bx + by) : 5;

    const advX = parseFloat(s.advanced_textbox_x) || 0;
    const advY = parseFloat(s.advanced_textbox_y) || 0;
    const advW = Math.max(80, parseFloat(s.advanced_textbox_w) || videoW * 0.8);
    const advH = Math.max(40, parseFloat(s.advanced_textbox_h) || 200);

    const rawPosX = typeof s.pos_x === 'number' ? s.pos_x : 0.5;
    const rawPosY = typeof s.pos_y === 'number' ? s.pos_y : 0.5;

    let posX = rawPosX <= 1 ? rawPosX * videoW : rawPosX;
    let posY = rawPosY <= 1 ? rawPosY * videoH : rawPosY;

    if (useAdvTextbox) {
        posX = advAlign === 'left' ? advX : (advAlign === 'right' ? advX + advW : advX + advW / 2);
        posY = advValign === 'top' ? advY : (advValign === 'bottom' ? advY + advH : advY + advH / 2);
    }

    // 与预览一致的自动换行宽度
    const wrapPercent = Math.max(20, Math.min(120, parseFloat(s.wrap_width_percent) || 90));
    const wrapWidth = useAdvTextbox
        ? Math.max(80, parseFloat(s.advanced_textbox_w) || videoW * 0.8)
        : Math.max(200, Math.floor(videoW * (wrapPercent / 100)));
    const wrapFontOpts = {
        fontFamily, fontSize,
        bold: fontWeight >= 600,
        italic: !!s.italic,
        letterSpacing: spacing,
    };

    // ── 动画参数 ──
    const animInType = s.anim_in_type || 'none';
    const animOutType = s.anim_out_type || 'none';
    const animInDur = (s.anim_in_duration || 0.3) * 1000;  // ms
    const animOutDur = (s.anim_out_duration || 0.25) * 1000;
    const slideDistance = 60; // px, 与预览一致

    function toASSTime(sec) {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const sRem = sec % 60;
        return `${h}:${String(m).padStart(2, '0')}:${sRem.toFixed(2).padStart(5, '0')}`;
    }

    // ── 构建动画覆盖标签 ──
    function buildAnimTags(segStart, segEnd) {
        const tags = [];
        const durMs = Math.round((segEnd - segStart) * 1000);

        // Fade in / out
        const hasFadeIn = animInType === 'fade';
        const hasFadeOut = animOutType === 'fade';
        if (hasFadeIn || hasFadeOut) {
            const fadeIn = hasFadeIn ? Math.round(animInDur) : 0;
            const fadeOut = hasFadeOut ? Math.round(animOutDur) : 0;
            tags.push(`\\fad(${fadeIn},${fadeOut})`);
        }

        // Pop (scale) animation
        const hasPopIn = animInType === 'pop';
        const hasPopOut = animOutType === 'pop';
        if (hasPopIn) {
            // Start at 0% scale, expand to 115% then settle to 100%
            tags.push(`\\fscx10\\fscy10`);
            const overshootEnd = Math.round(animInDur * 0.6);
            tags.push(`\\t(0,${overshootEnd},\\fscx115\\fscy115)`);
            tags.push(`\\t(${overshootEnd},${Math.round(animInDur)},\\fscx100\\fscy100)`);
        }
        if (hasPopOut) {
            const outStart = Math.max(0, durMs - Math.round(animOutDur));
            tags.push(`\\t(${outStart},${durMs},\\fscx10\\fscy10)`);
        }

        // Blur → Sharp animation
        if (animInType === 'blur_sharp') {
            const blurMax = parseInt(s.blur_sharp_max) || 20;
            const clearMs = Math.round(animInDur * (parseFloat(s.blur_sharp_clear_frac) || 0.4));
            tags.push(`\\blur${blurMax}`);
            tags.push(`\\t(0,${Math.round(animInDur)},\\blur0)`);
            if (!hasFadeIn) {
                tags.push(`\\fad(${clearMs},0)`);
            }
        }

        // Holy glow - simulate with blur pulsing
        if (animInType === 'holy_glow') {
            const glowRadius = parseInt(s.holy_glow_radius) || 6;
            tags.push(`\\blur${glowRadius}`);
            // Pulse between blur levels
            const period = Math.round((parseFloat(s.holy_glow_period) || 3.0) * 1000);
            const half = Math.round(period / 2);
            // Single pulse cycle
            tags.push(`\\t(0,${half},\\blur${Math.round(glowRadius * 0.3)})`);
            tags.push(`\\t(${half},${period},\\blur${glowRadius})`);
        }

        return tags.join('');
    }

    function resolveSegmentPos(segStyle = null) {
        if (!segStyle || typeof segStyle !== 'object') {
            return { x: posX, y: posY };
        }
        const sx = typeof segStyle.pos_x === 'number' ? segStyle.pos_x : parseFloat(segStyle.pos_x);
        const sy = typeof segStyle.pos_y === 'number' ? segStyle.pos_y : parseFloat(segStyle.pos_y);
        const x = Number.isFinite(sx) ? (sx <= 1 ? sx * videoW : sx) : posX;
        const y = Number.isFinite(sy) ? (sy <= 1 ? sy * videoH : sy) : posY;
        return { x, y };
    }

    // ── 构建位置标签（含 slide 动画支持）──
    function buildPosTags(segStart, segEnd, segStyle = null) {
        const segPos = resolveSegmentPos(segStyle);
        const cx = Math.round(segPos.x);
        const cy = Math.round(segPos.y);
        const durMs = Math.round((segEnd - segStart) * 1000);

        // Slide animations use \move
        const slideTypes = ['slide_up', 'slide_down', 'slide_left', 'slide_right'];
        const hasSlideIn = slideTypes.includes(animInType);
        const hasSlideOut = slideTypes.includes(animOutType);

        if (hasSlideIn && !hasSlideOut) {
            // Slide IN only: move from offset to final position
            const [dx, dy] = _slideOffset(animInType, slideDistance);
            return `\\an${baseAlign}\\move(${cx + dx},${cy + dy},${cx},${cy},0,${Math.round(animInDur)})`;
        }
        if (!hasSlideIn && hasSlideOut) {
            // Slide OUT only: move from final position to offset
            const [dx, dy] = _slideOffset(animOutType, slideDistance);
            const outStart = Math.max(0, durMs - Math.round(animOutDur));
            return `\\an${baseAlign}\\move(${cx},${cy},${cx + dx},${cy + dy},${outStart},${durMs})`;
        }
        if (hasSlideIn && hasSlideOut) {
            // Both: use \move for in, can't do both with one \move in ASS
            // Prioritize slide-in
            const [dx, dy] = _slideOffset(animInType, slideDistance);
            return `\\an${baseAlign}\\move(${cx + dx},${cy + dy},${cx},${cy},0,${Math.round(animInDur)})`;
        }
        // No slide → static \pos
        return `\\an${baseAlign}\\pos(${cx},${cy})`;
    }

    function _slideOffset(type, dist) {
        switch (type) {
            case 'slide_up': return [0, dist];      // starts below
            case 'slide_down': return [0, -dist];    // starts above
            case 'slide_left': return [dist, 0];     // starts right
            case 'slide_right': return [-dist, 0];   // starts left
            default: return [0, 0];
        }
    }

    // ── 多层描边扩展样式 ──
    const seEnabled = !!s.stroke_expand_enabled;
    let seStyles = '';
    if (seEnabled) {
        const seLayers = parseInt(s.stroke_expand_layers) || 3;
        const seStep = parseFloat(s.stroke_expand_step) || 4;
        const seColorsStr = typeof s.stroke_expand_colors === 'string'
            ? s.stroke_expand_colors : (Array.isArray(s.stroke_expand_colors) ? s.stroke_expand_colors.join(',') : '#FF0000,#00FF00,#0000FF');
        const seColors = seColorsStr.split(',').map(c => c.trim()).filter(Boolean);

        // 为每一层创建一个额外的 Style
        for (let li = 0; li < seLayers; li++) {
            const lw = seStep * (li + 1);
            const color = li < seColors.length ? seColors[li] : seColors[seColors.length - 1] || '#000000';
            const assColor = toASSColor(color);
            // 透明度随层数递增
            const layerAlpha = Math.round(Math.min(200, 60 + li * 30));
            const layerAlphaHex = layerAlpha.toString(16).padStart(2, '0').toUpperCase();
            seStyles += `\nStyle: SE_Layer${li},${fontFamily},${fontSize},${toASSColor('#FFFFFF', 255)},${toASSColor('#FFFFFF', 255)},${toASSColor(color, 0)},${toASSColor('#000000', 255)},${bold},${italic},0,0,100,100,${spacing},0,1,${Math.round(lw)},0,5,0,0,0,1`;
        }
    }

    const creditText = typeof s.credit === 'string' ? s.credit.trim() : '';
    let creditStyleLine = '';
    if (creditText) {
        const creditPos = String(s.credit_position || 'top-right').toLowerCase();
        const creditAlign = creditPos === 'top-left' ? 7
            : (creditPos === 'bottom-right' ? 3
                : (creditPos === 'bottom-left' ? 1 : 9));
        const creditFontSize = Math.max(16, Math.round(28 * (videoW / 1080)));
        const creditMargin = Math.max(14, Math.round(28 * (videoW / 1080)));
        creditStyleLine = `\nStyle: Credit,${fontFamily},${creditFontSize},${toASSColor('#FFFFFF', 35)},${toASSColor('#FFFFFF', 35)},${toASSColor('#000000', 80)},${toASSColor('#000000', 160)},0,0,0,0,100,100,0,0,1,2,1,${creditAlign},${creditMargin},${creditMargin},${creditMargin},1`;
    }

    const header = `[Script Info]
Title: Batch Reels Enhanced Subtitle
ScriptType: v4.00+
PlayResX: ${videoW}
PlayResY: ${videoH}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontFamily},${fontSize},${primaryColor},${secondaryColor},${outlineColor},${backColor},${bold},${italic},${useUnderline},0,100,100,${spacing},0,${borderStyle},${borderW},${shadowDist},5,0,0,0,1${seStyles}${creditStyleLine}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

    const events = [];

    function buildSegmentStyleTags(segStyle = {}) {
        if (!segStyle || typeof segStyle !== 'object') return '';
        let tags = '';
        const color = segStyle.color_text || segStyle.color;
        if (color) tags += `\\1c${toASSColor(color)}`;
        if (segStyle.color_outline) tags += `\\3c${toASSColor(segStyle.color_outline)}`;
        if (segStyle.fontsize) tags += `\\fs${Math.round(parseFloat(segStyle.fontsize) || fontSize)}`;
        if (segStyle.font_family) tags += `\\fn${String(segStyle.font_family).replace(/[{}\\]/g, '')}`;
        if (segStyle.font_weight !== undefined) tags += `\\b${Math.max(100, Math.min(900, parseInt(segStyle.font_weight, 10) || 400))}`;
        else if (segStyle.bold !== undefined) tags += `\\b${segStyle.bold ? 1 : 0}`;
        if (segStyle.italic !== undefined) tags += `\\i${segStyle.italic ? 1 : 0}`;
        if (segStyle.border_width !== undefined) tags += `\\bord${Math.max(0, parseFloat(segStyle.border_width) || 0)}`;
        if (segStyle.shadow_blur || segStyle.shadow_offset_x || segStyle.shadow_offset_y) {
            const shad = Math.max(Math.abs(segStyle.shadow_offset_x || 0), Math.abs(segStyle.shadow_offset_y || 0), segStyle.shadow_blur ? Math.min(segStyle.shadow_blur, 4) : 0);
            tags += `\\shad${Math.max(0, Math.round(shad))}`;
        }
        return tags;
    }

    for (const seg of segments) {
        const segStyle = seg.style_override || seg.subtitle_style || null;
        const segStyleTags = buildSegmentStyleTags(segStyle);
        const rawText = String(seg.text || '');
        const effectiveDirectionSetting = (segStyle && segStyle.text_direction) || s.text_direction || 'auto';
        const resolvedDirection = (typeof ReelsTextDirection !== 'undefined')
            ? ReelsTextDirection.resolve(effectiveDirectionSetting, rawText)
            : 'ltr';
        const directionMark = resolvedDirection === 'rtl' ? '\u200F' : '\u200E';
        const directionTags = resolvedDirection === 'rtl' ? '\\fsp0' : '';
        const wrappedLines = wrapTextByPixelWidth(rawText, wrapWidth, wrapFontOpts);
        let text = directionMark + (wrappedLines.length > 0 ? wrappedLines.join('\n') : rawText).replace(/\n/g, '\\N');

        // 动画标签
        const posTag = buildPosTags(seg.start, seg.end, segStyle);
        const animTag = buildAnimTags(seg.start, seg.end);
        const overrideOpen = `{${posTag}${animTag}${segStyleTags}${directionTags}}`;

        // ── 仅显示当前激活单词 (only_show_active_word) ──
        if (s.only_show_active_word && seg.words && seg.words.length > 0) {
            for (const w of seg.words) {
                const wText = w.word || '';
                if (!wText.trim()) continue;
                const wPosTag = buildPosTags(w.start, w.end, segStyle);
                const wAnimTag = buildAnimTags(w.start, w.end);
                const wOverrideOpen = `{${wPosTag}${wAnimTag}${segStyleTags}${directionTags}}`;
                events.push(`Dialogue: 0,${toASSTime(w.start)},${toASSTime(w.end)},Default,,0,0,0,,${wOverrideOpen}${directionMark}${wText}`);

                // ── 多层描边扩展 Dialogue (底层先画) ──
                if (seEnabled) {
                    const seLayers = parseInt(s.stroke_expand_layers) || 3;
                    for (let li = seLayers - 1; li >= 0; li--) {
                        const layerNum = -(10 + li);
                        events.push(`Dialogue: ${layerNum},${toASSTime(w.start)},${toASSTime(w.end)},SE_Layer${li},,0,0,0,,{${wPosTag}${wAnimTag}${directionTags}}${directionMark}${wText}`);
                    }
                }
            }
        }
        // ── 打字机效果 (typewriter) ──
        else if (animInType === 'typewriter' && seg.words && seg.words.length > 0) {
            // 用 \kf 逐字显示，灰色→白色过渡
            const unrevealedColor = toASSColor(s.tw_unrevealed_color || '#808080');
            const revealedColor = toASSColor(colorTextHex || '#FFFFFF');
            const parts = [];
            for (const w of seg.words) {
                const wDur = ((w.end || 0) - (w.start || 0));
                const kDur = Math.max(1, Math.round(wDur * 100));
                parts.push(`{\\kf${kDur}\\1c${revealedColor}}${w.word}`);
            }
            // 初始颜色设为未显示色
            const twOverride = `{${posTag}${animTag}\\1c${unrevealedColor}${directionTags}}`;
            text = directionMark + parts.join(' ');
            events.push(`Dialogue: 0,${toASSTime(seg.start)},${toASSTime(seg.end)},Default,,0,0,0,,${twOverride}${text}`);
        }
        // ── 卡拉OK 逐词高亮 ──
        else if (karaokeHL && colorHighHex) {
            const segWords = (seg.words && seg.words.length > 0)
                ? seg.words
                : (srtToSegmentsWithWords([{ start: seg.start, end: seg.end, text: rawText, _timeUnit: 'sec' }])[0]?.words || []);
            if (segWords.length > 0) {
                const highColor = toASSColor(colorHighHex);
                const parts = [];
                for (const w of segWords) {
                    const wDur = ((w.end || 0) - (w.start || 0));
                    const kDur = Math.max(1, Math.round(wDur * 100));
                    parts.push(`{\\kf${kDur}\\1c${highColor}}${w.word}`);
                }
                text = directionMark + parts.join(' ');
                events.push(`Dialogue: 0,${toASSTime(seg.start)},${toASSTime(seg.end)},Default,,0,0,0,,${overrideOpen}${text}`);
            } else {
                events.push(`Dialogue: 0,${toASSTime(seg.start)},${toASSTime(seg.end)},Default,,0,0,0,,${overrideOpen}${text}`);
            }
        }
        // ── 普通文本 ──
        else {
            events.push(`Dialogue: 0,${toASSTime(seg.start)},${toASSTime(seg.end)},Default,,0,0,0,,${overrideOpen}${text}`);
        }

        // ── 多层描边扩展 Dialogue (底层先画) ──
        if (seEnabled && !s.only_show_active_word) {
            const seLayers = parseInt(s.stroke_expand_layers) || 3;
            for (let li = seLayers - 1; li >= 0; li--) {
                // 描边层在主文字下方 (layer -10 - li)
                const layerNum = -(10 + li);
                const seText = directionMark + (wrappedLines.length > 0 ? wrappedLines.join('\n') : rawText).replace(/\n/g, '\\N');
                const sePosTag = buildPosTags(seg.start, seg.end, segStyle);
                const seAnimTag = buildAnimTags(seg.start, seg.end);
                events.push(`Dialogue: ${layerNum},${toASSTime(seg.start)},${toASSTime(seg.end)},SE_Layer${li},,0,0,0,,{${sePosTag}${seAnimTag}${directionTags}}${seText}`);
            }
        }
    }

    // ── 水印 Credit ──
    if (creditText) {
        const maxSegEnd = segments.reduce((m, seg) => Math.max(m, Number(seg.end) || 0), 0);
        const totalEndSec = Number(opts.duration) > 0 ? Number(opts.duration) : (maxSegEnd > 0 ? maxSegEnd : 3600);
        const safeCredit = creditText.replace(/\r?\n/g, '\\N');
        events.push(`Dialogue: 10,0:00:00.00,${toASSTime(totalEndSec)},Credit,,0,0,0,,${safeCredit}`);
    }

    // ── 全局蒙版 ──
    if (s.global_mask_enabled) {
        const gmOpacity = s.global_mask_opacity ?? 0.5;
        const gmAlpha = Math.round(255 - (gmOpacity * 255)).toString(16).padStart(2, '0').toUpperCase();
        const cAsAss = toASSColor(s.global_mask_color || '#000000');
        const bgr = cAsAss.substring(4);
        const maskEvent = `Dialogue: -100,0:00:00.00,99:59:59.99,Default,,0,0,0,,{\\pos(0,0)\\p1\\1c&H${bgr}&\\1a&H${gmAlpha}&\\bord0\\shad0}m 0 0 l ${videoW} 0 l ${videoW} ${videoH} l 0 ${videoH}{\\p0}`;
        events.unshift(maskEvent);
    }

    return header + '\n' + events.join('\n') + '\n';
}

// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

const ReelsSubtitleProcessor = {
    // Tokenization
    tokenizeForWrap,
    measureTextWidth,
    wrapTokensByPixelWidth,
    wrapTextByPixelWidth,

    // Segment processing
    mergeShortSegments,
    interpolateMissingWordTimes,
    flattenWordsFromSegments,
    resegmentWordsByStyle,
    smartSegmentation,

    // Conversion
    srtToSegmentsWithWords,
    segmentsToSRT,

    // ASS
    generateEnhancedASS,
};

if (typeof window !== 'undefined') window.ReelsSubtitleProcessor = ReelsSubtitleProcessor;
if (typeof module !== 'undefined' && module.exports) module.exports = ReelsSubtitleProcessor;
