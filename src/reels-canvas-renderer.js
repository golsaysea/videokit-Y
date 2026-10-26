/**
 * reels-canvas-renderer.js — Canvas2D subtitle renderer
 * 
 * ✅ 完整移植自 AutoSub_v8 FrameRenderer.draw_subtitle()
 * QPainter → CanvasRenderingContext2D
 * 
 * 核心功能：
 * - 文字绘制 (带描边、阴影、背景框)
 * - 多行自动换行 (按像素宽度)
 * - 当前词高亮 (弹力色块)
 * - 多层扩展描边 (stroke_expand)
 * - 高级文本框 (advanced_textbox)
 * - 文本对齐 (left/center/right)
 * - 字母间距 (letter_spacing)
 * - 背景框模糊羽化 (box_blur)
 * - 渐变背景 (bg_gradient)
 * - 下划线效果
 * - Holy Glow 光晕
 * - Blur→Sharp 模糊到清晰
 * - 音频频谱可视化
 * - 16+种动画效果 (通过 reels-anim-engine.js)
 * - 打字机、逐字弹跳、节奏逐词等特效
 */

// Only the animation that is actually selected may reserve extra layout
// space. The style always carries defaults for every animation (including
// letter_jump_scale=1.5); taking their unconditional maximum made ordinary
// fade/static subtitles taller and left the surplus below the final line.
function getSubtitleLayoutMaxScale(style) {
    const s = style || {};
    const type = s.anim_in_type || 'none';
    let value = 1;
    if (type === 'word_pop_random') value = Number(s.word_pop_random_max_scale ?? 1.34);
    else if (type === 'word_pop_random_pulse') value = Number(s.word_pop_random_pulse_max_scale ?? 1.38);
    else if (type === 'letter_jump') value = Number(s.letter_jump_scale ?? 1.5);
    return Number.isFinite(value) ? Math.max(1, value) : 1;
}

function getTopBaselineGlyphBounds(metrics, fontSize, lineHeight) {
    const safeFontSize = Math.max(1, Number(fontSize) || 1);
    const safeLineHeight = Math.max(1, Number(lineHeight) || safeFontSize * 1.2);
    const actualAscent = Number(metrics?.actualBoundingBoxAscent);
    const actualDescent = Number(metrics?.actualBoundingBoxDescent);

    if (!Number.isFinite(actualAscent) || !Number.isFinite(actualDescent)) {
        return { top: 0, bottom: safeLineHeight, height: safeLineHeight };
    }

    // TextMetrics are relative to the currently selected textBaseline. These
    // subtitles use "top", so glyph top is -ascent and glyph bottom is
    // descent from the draw Y. Re-basing through fontBoundingBoxAscent shifts
    // accented capitals below the box and clips their diacritics.
    const top = Math.max(0, Math.min(safeLineHeight, -actualAscent));
    const bottom = Math.max(top, Math.min(safeLineHeight, actualDescent));
    return { top, bottom, height: Math.max(0, bottom - top) };
}

// Canvas calls the Photoshop-style "Linear Dodge" blend operation "lighter".
// Keep this normalization at the render boundary so preview canvases and the
// off-screen canvas used for MP4 export cannot interpret the UI value
// differently.
function getAmbientGlowCompositeOperation(style) {
    const requested = String(style?.ambient_glow_blend_mode || 'lighter').toLowerCase();
    const aliases = {
        'linear-dodge': 'lighter',
        'linear_dodge': 'lighter',
        'lineardodge': 'lighter',
    };
    const operation = aliases[requested] || requested;
    return ['lighter', 'screen', 'soft-light', 'overlay', 'source-over'].includes(operation)
        ? operation
        : 'lighter';
}

// Split by visible characters so emoji and combining accents stay intact.
function getWritingGraphemes(text) {
    return typeof Intl.Segmenter === 'function'
        ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), item => item.segment)
        : Array.from(text);
}
function repairCollapsedWritingSegments(segments,totalDuration=0) {
    const first=segments.findIndex(seg=>String(seg.edited_text??seg.text??'').trim()&&!(Number(seg.end)>Number(seg.start)+.0001));
    if(first<0)return segments;
    // Only repair a collapsed trailing run; retain every valid earlier timestamp.
    if(segments.slice(first).some(seg=>Number(seg.end)>Number(seg.start)+.0001))return segments;
    const weight=text=>Math.max(1,getWritingGraphemes(String(text)).filter(ch=>!/^\s+$/.test(ch)).length);
    let index=first;
    const prior=segments.slice(0,first).filter(s=>Number(s.end)>Number(s.start));
    const typical=prior.reduce((n,s)=>n+Number(s.end)-Number(s.start),0)/Math.max(1,prior.length);
    if(first>0&&Number(segments[first-1].end)-Number(segments[first-1].start)<typical*.5)index--;
    const tail=segments.slice(index),start=Number(tail[0].start)||0;
    const units=tail.reduce((n,s)=>n+weight(s.edited_text??s.text??''),0);
    const good=segments.slice(0,index),seconds=good.reduce((n,s)=>n+Math.max(0,Number(s.end)-Number(s.start)),0),letters=good.reduce((n,s)=>n+weight(s.edited_text??s.text??''),0);
    const rate=letters?seconds/letters:.075;
    const end=Number(totalDuration)>start+.1?Number(totalDuration):start+Math.max(.1,units*rate);
    let cursor=start;
    return [...good,...tail.map((seg,i)=>{
        const begin=cursor;cursor=i===tail.length-1?end:cursor+(end-start)*weight(seg.edited_text??seg.text??'')/units;
        const words=seg.words?.map(word=>({...word}));
        if(words?.length){const count=words.reduce((n,w)=>n+weight(w.word??w.text??''),0);let t=begin;for(const word of words){word.start=t;t+=(cursor-begin)*weight(word.word??word.text??'')/count;word.end=t;}words[words.length-1].end=cursor;}
        return {...seg,start:begin,end:cursor,...(words?{words}:{}),_writingTimingEstimated:true};
    })];
}
function getSpeechWritingTokens(seg, text, syncSpeech) {
    const glyphs = getWritingGraphemes(text);
    const start = Number(seg.start) || 0;
    const duration = Math.max(.001, (Number(seg.end) || 0) - start);
    const tokens = glyphs.map((text, i) => ({ text, start: start + duration * i / glyphs.length, end: start + duration * (i + 1) / glyphs.length }));
    if (!syncSpeech || !Array.isArray(seg.words) || !seg.words.length) return tokens;
    const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '');
    const words = seg.words.map(w => ({ text: normalize(w.word ?? w.text), start: Number(w.start), end: Number(w.end) })).filter(w => w.text);
    // Only reuse speech timestamps if they still describe the edited script.
    // An SRT or changed script falls back to sentence timing rather than stale words.
    if (!words.length || words.map(w => w.text).join('') !== glyphs.map(normalize).join('') ||
        words.some((w, i) => !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end < w.start || (i && w.start < words[i-1].end - .001))) return tokens;
    let gi = 0;
    for (const word of words) {
        const indices = [];let collected = '';
        while (gi < glyphs.length && collected.length < word.text.length) {
            const normalized = normalize(glyphs[gi]);
            if (normalized) { indices.push(gi); collected += normalized; }
            gi++;
        }
        if (collected !== word.text) return tokens;
        indices.forEach((index, i) => {
            tokens[index].start = word.start + (word.end - word.start) * i / indices.length;
            tokens[index].end = word.start + (word.end - word.start) * (i + 1) / indices.length;
        });
    }
    let previousEnd = words[0].start;
    for (const tok of tokens) {
        if (!normalize(tok.text)) { tok.start = previousEnd; tok.end = previousEnd; }
        else previousEnd = tok.end;
    }
    return tokens;
}

const BUILTIN_WRITING_TIP_KINDS = new Set([
    'quill', 'rose', 'fountain_pen', 'brush', 'pencil', 'sparkle_wand',
    'butterfly', 'candle_flame', 'dove', 'heart', 'leaf', 'sakura',
    'crown', 'music_note', 'cross_light', 'feather_gold'
]);
function isImageOrVectorWritingTip(kind) {
    return kind === 'image' || BUILTIN_WRITING_TIP_KINDS.has(kind);
}
if (typeof window !== 'undefined') {
    window.isImageOrVectorWritingTip = isImageOrVectorWritingTip;
}

// The origin is the writing tip. Size/rotation always pivot around that point.
function drawSpeechWritingTip(ctx, kind, x, y, size, angle) {
    ctx.save();
    ctx.translate(x, y);ctx.rotate(angle * Math.PI / 180);ctx.scale(size, size);
    ctx.lineCap = 'round';ctx.lineJoin = 'round';
    const shape = (data, fill, stroke, width = .025) => {
        const p = new Path2D(data);if (fill) { ctx.fillStyle = fill;ctx.fill(p); }
        if (stroke) { ctx.strokeStyle = stroke;ctx.lineWidth = width;ctx.stroke(p); }
    };
    if (kind === 'rose') {
        shape('M0 0 Q.21-.22 .48-.73', null, '#26743c', .045);
        shape('M.19-.27 Q-.09-.47 .04-.61 Q.29-.56 .27-.38 Z', '#39854b', '#17532b', .015);
        shape('M.31-.46 Q.64-.43 .64-.61 Q.37-.67 .31-.46 Z', '#459853', '#17532b', .015);
        shape('M.35-.7 L.37-.88 L.62-.88 L.65-.7 L.5-.62 Z', '#2b7139', null);
        shape('M.32-.72 C.08-.8 .16-1.09 .37-1.03 C.37-1.24 .7-1.24 .71-1.03 C.97-1.08 1-.78 .78-.7 C.67-.5 .41-.55 .32-.72 Z', '#ba173a', '#780e2b', .018);
        shape('M.26-.95 Q.43-.85 .51-.7 Q.43-1.17 .68-1.13 Q.86-.98 .66-.76 Q.82-.88 .88-.91', null, '#f2667f', .035);
        shape('M.43-.92 Q.53-1.03 .65-.94 Q.68-.81 .52-.78 Q.45-.81 .49-.9', '#dc3653', '#8c1734', .02);
    } else if (kind === 'fountain_pen') {
        // 🖋️ 复古黑金钢笔尖
        shape('M.30-.50 L.88-1.08 C.96-1.14 1.06-1.04 1.00-.96 L.42-.38 Z', '#1e2430', '#d4af37', .022);
        shape('M.23-.43 L.43-.23 L.51-.31 L.31-.51 Z', '#ffd700', '#92400e', .016);
        shape('M0 0 L.09-.33 L.25-.41 L.41-.25 L.33-.09 Z', '#f5c542', '#7a5813', .018);
        shape('M0 0 L.20-.20', null, '#3d2b07', .016);
        shape('M.18-.22 A.035 .035 0 1 1 .22-.18 A.035 .035 0 1 1 .18-.22 Z', '#3d2b07', null);
    } else if (kind === 'brush') {
        // 🖌️ 东方水墨毛笔
        shape('M.34-.54 L.92-1.12 C.99-1.17 1.07-1.09 1.02-1.02 L.44-.44 Z', '#c89d54', '#6b4c1b', .02);
        shape('M.58-.78 L.68-.68 M.74-.94 L.84-.84', null, '#6b4c1b', .022);
        shape('M.23-.43 L.37-.29 L.47-.39 L.33-.53 Z', '#b91c1c', '#fbbf24', .016);
        shape('M0 0 C.04-.19 .11-.36 .25-.44 C.38-.33 .43-.22 .35-.10 C.24-.02 .10 0 0 0 Z', '#f5f0e6', '#6e6558', .016);
        shape('M0 0 C.03-.12 .08-.23 .17-.30 C.24-.24 .26-.15 .20-.07 C.12-.02 .05 0 0 0 Z', '#1f242d', '#111827', .012);
    } else if (kind === 'pencil') {
        // ✏️ 经典木质铅笔
        shape('M.86-1.00 C.94-1.08 1.06-.96 .98-.88 L.90-.80 L.78-.92 Z', '#f472b6', '#be185d', .018);
        shape('M.72-.86 L.80-.94 L.92-.82 L.84-.74 Z', '#cbd5e1', '#475569', .016);
        shape('M.22-.36 L.72-.86 L.84-.74 L.34-.24 Z', '#fbbf24', '#b45309', .018);
        shape('M.28-.30 L.78-.80', null, '#d97706', .016);
        shape('M.09-.23 L.22-.36 L.34-.24 L.23-.09 Z', '#f3d2a2', '#9c7644', .015);
        shape('M0 0 L.09-.23 L.23-.09 Z', '#2d3138', '#111827', .014);
    } else if (kind === 'sparkle_wand') {
        // ✨ 星光魔法棒
        shape('M.24-.24 L.94-.94', null, '#b45309', .06);
        shape('M.24-.24 L.94-.94', null, '#fde047', .028);
        shape('M0 0 L.15-.21 L.03-.35 L.21-.29 L.35-.47 L.29-.27 L.47-.21 L.27-.15 Z', '#fde047', '#ca8a04', .018);
        shape('M.13-.15 L.21-.23 L.29-.15 L.21-.07 Z', '#ffffff', null);
        shape('M.56-.28 L.61-.37 L.70-.32 L.61-.23 Z', '#fef08a', '#eab308', .012);
        shape('M.26-.60 L.31-.71 L.42-.66 L.31-.55 Z', '#fef08a', '#eab308', .012);
    } else if (kind === 'butterfly') {
        // 🦋 灵动金粉蝴蝶
        shape('M.20-.22 C.02-.54 .18-.96 .52-.88 C.78-.82 .82-.44 .46-.28 Z', '#60a5fa', '#1e3a8a', .02);
        shape('M.24-.28 C.14-.48 .26-.76 .48-.72 C.64-.68 .64-.46 .42-.32 Z', '#fbbf24', null);
        shape('M.22-.20 C.48-.34 .88-.28 .84-.04 C.80 .16 .44 .12 .22-.20 Z', '#93c5fd', '#1e3a8a', .018);
        shape('M.30-.18 C.48-.26 .70-.22 .68-.06 C.65 .06 .44 .04 .30-.18 Z', '#f472b6', null);
        shape('M.04-.04 L.36-.36', null, '#451a03', .035);
        shape('M.06-.06 Q-.05-.22 .03-.32 M.06-.06 Q.22 .04 .32-.04', null, '#451a03', .015);
    } else if (kind === 'candle_flame') {
        // 🕯️ 温暖摇曳烛火
        shape('M.18-.03 C-.08-.22 -.06-.64 .22-.95 C.48-.64 .50-.22 .18-.03 Z', 'rgba(251,146,60,0.34)', null);
        shape('M0 0 L.18-.12', null, '#78350f', .028);
        shape('M.18-.08 C.01-.24 .03-.56 .22-.82 C.39-.56 .41-.24 .18-.08 Z', '#f97316', '#c2410c', .018);
        shape('M.18-.12 C.07-.26 .09-.48 .21-.66 C.32-.48 .33-.26 .18-.12 Z', '#fde047', null);
        shape('M.18-.14 C.13-.22 .14-.34 .20-.44 C.26-.34 .26-.22 .18-.14 Z', '#ffffff', null);
    } else if (kind === 'dove') {
        // 🕊️ 圣洁和平白鸽
        shape('M0 0 Q.14-.06 .26-.18', null, '#15803d', .024);
        shape('M.06-.03 Q.04-.13 .13-.11 Q.11-.02 .06-.03 Z M.14-.09 Q.23-.07 .21-.16 Q.13-.15 .14-.09 Z', '#22c55e', null);
        shape('M.38-.26 C.32-.58 .54-.90 .88-.96 C.84-.66 .68-.42 .52-.24 Z', '#e2e8f0', '#64748b', .018);
        shape('M.30-.22 C.18-.50 .34-.80 .66-.86 C.64-.58 .52-.38 .40-.22 Z', '#ffffff', '#64748b', .018);
        shape('M.18-.16 C.12-.24 .18-.36 .28-.34 C.36-.32 .40-.24 .48-.26 C.66-.30 .88-.22 .98-.08 C.82-.05 .68-.07 .56-.01 C.38 .05 .24-.06 .18-.16 Z', '#ffffff', '#64748b', .018);
        shape('M.11-.13 L.19-.19 L.18-.11 Z', '#f59e0b', null);
        shape('M.22-.26 A.02 .02 0 1 1 .24-.24 Z', '#1e293b', null);
    } else if (kind === 'heart') {
        // ❤️ 立体发光红心
        shape('M0 0 C-.08-.34 -.38-.66 -.18-.90 C-.02-1.08 .22-.94 .26-.74 C.42-.92 .72-.94 .80-.70 C.90-.42 .44-.14 0 0 Z', '#e11d48', '#881337', .022);
        shape('M.05-.08 C-.02-.34 -.26-.60 -.11-.79 C.01-.93 .20-.82 .24-.64 C.38-.79 .61-.81 .68-.62 C.76-.39 .39-.17 .05-.08 Z', '#fb7185', null);
        shape('M-.08-.62 C-.12-.72 -.04-.82 .06-.78', null, '#ffe4e6', .038);
    } else if (kind === 'leaf') {
        // 🍃 清新翠绿嫩叶
        shape('M0 0 C.06-.38 .32-.78 .84-.92 C.82-.42 .48-.10 0 0 Z', '#22c55e', '#14532d', .02);
        shape('M0 0 C.06-.38 .32-.78 .84-.92 C.52-.56 .26-.28 0 0 Z', '#4ade80', null);
        shape('M0 0 Q.38-.46 .78-.86 M.24-.26 L.20-.46 M.42-.44 L.38-.66 M.30-.32 L.50-.30', null, '#15803d', .02);
        shape('M.48-.24 A.045 .045 0 1 1 .52-.20 A.045 .045 0 1 1 .48-.24 Z', '#e0f2fe', '#0284c7', .01);
    } else if (kind === 'sakura') {
        // 🌸 浪漫粉白樱花
        shape('M0 0 C.02-.16 .15-.26 .27-.21 L.22-.14 L.28-.10 C.21-.02 .09 .02 0 0 Z', '#fbcfe8', '#db2777', .015);
        shape('M.48-.52 C.30-.62 .26-.84 .40-.92 L.46-.84 L.52-.92 C.64-.84 .62-.62 .48-.52 Z', '#f9a8d4', '#be185d', .016);
        shape('M.48-.52 C.60-.68 .82-.70 .88-.56 L.80-.50 L.88-.44 C.80-.32 .58-.36 .48-.52 Z', '#fbcfe8', '#be185d', .016);
        shape('M.48-.52 C.62-.38 .64-.16 .50-.10 L.46-.18 L.40-.10 C.28-.18 .32-.38 .48-.52 Z', '#f9a8d4', '#be185d', .016);
        shape('M.48-.52 C.34-.38 .14-.36 .08-.50 L.16-.54 L.08-.60 C.16-.72 .36-.66 .48-.52 Z', '#fbcfe8', '#be185d', .016);
        shape('M.44-.52 A.05 .05 0 1 1 .52-.52 A.05 .05 0 1 1 .44-.52 Z', '#fde047', '#ca8a04', .014);
    } else if (kind === 'crown') {
        // 👑 璀璨金色皇冠
        shape('M0 0 L.14-.14', null, '#fbbf24', .03);
        shape('M.12-.18 L.74-.18 L.82-.66 L.58-.44 L.43-.78 L.28-.44 L.04-.66 Z', '#fbbf24', '#92400e', .022);
        shape('M.12-.18 L.74-.18 L.71-.08 L.15-.08 Z', '#d97706', '#78350f', .018);
        shape('M.40-.82 A.04 .04 0 1 1 .46-.82 A.04 .04 0 1 1 .40-.82 Z', '#ef4444', '#7f1d1d', .012);
        shape('M.01-.70 A.035 .035 0 1 1 .07-.70 A.035 .035 0 1 1 .01-.70 Z M.79-.70 A.035 .035 0 1 1 .85-.70 A.035 .035 0 1 1 .79-.70 Z', '#3b82f6', '#1e3a8a', .012);
    } else if (kind === 'music_note') {
        // 🎵 律动金色音符
        shape('M.02-.04 C-.02-.14 .08-.26 .22-.24 C.34-.22 .38-.10 .28-.02 C.18 .06 .06 .04 .02-.04 Z', '#fbbf24', '#92400e', .02);
        shape('M.31-.12 L.48-.88', null, '#fbbf24', .055);
        shape('M.31-.12 L.48-.88', null, '#92400e', .016);
        shape('M.48-.88 C.68-.82 .84-.66 .78-.44 C.74-.58 .62-.68 .46-.70 Z', '#f59e0b', '#92400e', .018);
        shape('M.64-.24 A.06 .045 -20 1 1 .76-.24 A.06 .045 -20 1 1 .64-.24 Z', '#fde047', '#ca8a04', .012);
        shape('M.75-.26 L.82-.54 L.92-.50', null, '#fde047', .024);
    } else if (kind === 'cross_light') {
        // ✝️ 光芒十字架
        shape('M.10-.54 L.64-.54 M.37-.84 L.37-.24 M.19-.72 L.55-.36 M.19-.36 L.55-.72', null, 'rgba(253,224,71,0.45)', .035);
        shape('M0 0 L.52-.92 L.62-.86 L.10 .06 Z', '#fbbf24', '#92400e', .02);
        shape('M.14-.68 L.68-.38 L.62-.28 L.08-.58 Z', '#fde047', '#92400e', .02);
    } else if (kind === 'feather_gold') {
        // 🪽 鎏金神圣金羽
        shape('M.04-.06 C.18-.46 .24-.86 .56-1.16 C.70-1.32 .86-1.40 1.00-1.42 C1.06-.98 .82-.52 .42-.26 Z', '#fde047', '#b45309', .018);
        shape('M.08-.12 C.22-.46 .30-.78 .56-1.04 C.72-.78 .64-.46 .36-.28 Z', '#f59e0b', null);
        shape('M0 0 Q.42-.52 .94-1.36', null, '#fef9c3', .03);
        for (let i = 0; i < 6; i++) {
            const a = .22 + i * .09, b = -.34 - i * .145;
            shape(`M${a} ${b} l-.035 -.18 M${a} ${b} l.19 -.025`, null, '#b45309', .012);
        }
    } else {
        // 🪶 默认复古羽毛笔 (quill)
        shape('M.05-.07 C.2-.48 .23-.87 .54-1.15 C.66-1.32 .82-1.4 .97-1.44 C1.04-1.02 .81-.55 .43-.3 Z', '#eee8d9', '#7e7264', .018);
        shape('M.08-.1 Q.43-.54 .91-1.36', null, '#a78d61', .027);
        for (let i=0;i<6;i++) {
            const a=.22+i*.09,b=-.34-i*.145;
            shape(`M${a} ${b} l-.035 -.18 M${a} ${b} l.19 -.025`, null, '#baa98b', .01);
        }
        shape('M0 0 L.04-.19 L.17-.13 Z', '#c99c47', '#71572f', .012);
        shape('M0 0 L.11-.16', null, '#30291f', .012);
    }
    ctx.restore();
}
if (typeof window !== 'undefined') {
    window.drawSpeechWritingTip = drawSpeechWritingTip;
}

function getWritingSentenceSpans(text) {
    const spans=[];
    for (const line of text.matchAll(/[^\n]+(?:\n|$)|\n/g)) {
        const parts = typeof Intl.Segmenter === 'function'
            ? Array.from(new Intl.Segmenter(undefined,{granularity:'sentence'}).segment(line[0]),p=>({text:p.segment,index:p.index}))
            : Array.from(line[0].matchAll(/[^.!?。！？]+(?:[.!?。！？]+|$)/g),p=>({text:p[0],index:p.index}));
        for(const part of parts)if(part.text.trim())spans.push({text:part.text,startIndex:line.index+part.index,endIndex:line.index+part.index+part.text.length});
    }
    const joined=[];
    for(const span of spans){const previous=joined.at(-1);if(previous && /^\s*\d+[.)、]\s*$/u.test(previous.text)){joined[joined.length-1]={...span,text:previous.text+span.text,startIndex:previous.startIndex};}else joined.push(span);}
    return joined;
}
function getSentenceWritingTokens(seg,text,syncSpeech) {
    const tokens=getSpeechWritingTokens(seg,text,syncSpeech);
    let offset=0;const indexed=tokens.map(t=>{const item={...t,index:offset};offset+=t.text.length;return item;});
    for(const sentence of getWritingSentenceSpans(text)) {
        const group=indexed.filter(t=>t.index>=sentence.startIndex&&t.index<sentence.endIndex);
        const spoken=group.filter(t=>!/^[\s\p{P}]+$/u.test(t.text));
        const first=spoken[0]||group[0],last=spoken[spoken.length-1]||group[group.length-1];
        if(!first||!last)continue;
        const start=first.start,end=last.end;
        for(const tok of group){tok.start=start;tok.end=end;tok._sentenceToken=true;}
    }
    return indexed;
}
function mergeWritingSentenceCues(segments) {
    let text='',tokens=[];
    for(const seg of segments){if(text){text+=' ';tokens.push({text:' ',start:tokens.at(-1)?.end||0,end:tokens.at(-1)?.end||0});}const value=String(seg.edited_text??seg.text??'');text+=value;tokens.push(...getSpeechWritingTokens(seg,value,true));}
    let index=0;const indexed=tokens.map(t=>{const v={...t,index};index+=t.text.length;return v;});
    const spans=getWritingSentenceSpans(text),merged=[];
    for(const span of spans){if(merged.length&&/^\s*\d+[.)、]\s*$/u.test(merged.at(-1).text)){const previous=merged.pop();merged.push({...span,text:previous.text+span.text,startIndex:previous.startIndex});}else merged.push(span);}
    return merged.map(span=>{const chars=indexed.filter(t=>t.index>=span.startIndex&&t.index<span.endIndex);const spoken=chars.filter(t=>/[\p{L}\p{N}]/u.test(t.text));return {text:span.text,start:spoken[0]?.start??chars[0]?.start??0,end:spoken.at(-1)?.end??chars.at(-1)?.end??0,words:chars.map(t=>({word:t.text,start:t.start,end:t.end}))};});
}
function getSplitWritingParts(segments,s,originalScript='') {
    const normalize=t=>String(t||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu,'');
    const texts=segments.map(seg=>String(seg.edited_text??seg.text??''));
    const joined=texts.join(' ');
    const spoken=texts.map(normalize).join('');
    const scriptSentence=getWritingSentenceSpans(String(originalScript||''))[0]?.text.trim();
    const custom=s.fullpage_typewriter_title_auto===false?String(s.fullpage_typewriter_title_text??'').trim():null;
    // A sentence can span arbitrary SRT cues. Prefer the complete recording script,
    // and accept a custom heading as the boundary only if it matches spoken words.
    const matchingCustom=custom&&spoken.startsWith(normalize(custom))&&normalize(custom);
    const matchingScript=scriptSentence&&spoken.startsWith(normalize(scriptSentence))&&normalize(scriptSentence);
    const autoTitle=matchingScript?scriptSentence:(getWritingSentenceSpans(joined)[0]?.text.trim()||'');
    const boundary=matchingCustom||matchingScript||normalize(autoTitle);
    if(!boundary)return {title:[],body:segments.map(x=>({...x})),titleEnd:0};
    let consumed=0,titleEnd=0,titleStart=null;const titleWords=[],body=[];
    segments.forEach((seg,index)=>{
        const text=texts[index],timed=getSpeechWritingTokens(seg,text,s.fullpage_typewriter_speech_sync!==false);
        let cut=0,offset=0;
        for(const token of timed){
            if(consumed<boundary.length){
                consumed+=normalize(token.text).length;cut=offset+token.text.length;
                if(normalize(token.text)){titleStart??=token.start;titleEnd=token.end;}
            }else if(cut&&/^[\s\p{P}]+$/u.test(token.text)){cut=offset+token.text.length;}
            else break;
            offset+=token.text.length;
        }
        const titleChars=normalize(text.slice(0,cut)).length;let wordChars=0,wordCut=0;
        for(const word of seg.words||[]){wordChars+=normalize(word.word??word.text).length;if(wordChars<=titleChars)wordCut++;else break;}
        titleWords.push(...(seg.words||[]).slice(0,wordCut).map(w=>({...w})));
        const rest=text.slice(cut).trimStart();
        if(rest){const remainingTokens=getSpeechWritingTokens(seg,text,true);let off=0;const first=remainingTokens.find(t=>{const hit=off>=cut&&normalize(t.text);off+=t.text.length;return hit;});
            body.push({...seg,text:rest,edited_text:rest,start:Math.max(Number(seg.start)||0,cut?(first?.start??titleEnd):Number(seg.start)||0),words:seg.words?.slice(wordCut).map(w=>({...w})),_writingSourceIndex:index,_writingPrefix:text.slice(0,text.length-rest.length)});
        }
    });
    const titleText=custom===null?autoTitle:custom;
    const title=[{text:titleText,edited_text:titleText,start:titleStart??0,end:titleEnd,words:titleWords}];
    const shift=(list,amount)=>list.map(seg=>({...seg,start:Number(seg.start)+amount,end:Number(seg.end)+amount,words:seg.words?.map(w=>({...w,start:Number(w.start)+amount,end:Number(w.end)+amount}))}));
    const titleDelay=Number(s.fullpage_typewriter_title_delay)||0;
    // Automatic mode uses SRT times directly. Old manual offsets must not
    // make the narration drift after enabling the repaired sequential mode.
    const automatic=s.fullpage_typewriter_auto_sequence!==false;
    const shiftedBody=shift(body,automatic?0:Number(s.fullpage_typewriter_body_delay)||0);
    const gate=titleEnd+titleDelay;
    if(automatic)for(const seg of shiftedBody){seg.start=Math.max(seg.start,gate);seg.end=Math.max(seg.end,seg.start);if(seg.words)seg.words=seg.words.map(w=>({...w,start:Math.max(w.start,gate),end:Math.max(w.end,gate)}));}
    return {title:shift(title,titleDelay),body:shiftedBody,titleEnd:gate};
}

function getWritingVisualStyle(style) {
    if(!style?.fullpage_typewriter || style.fullpage_typewriter_keep_background===false)return style;
    return {...style,global_mask_enabled:false,ambient_lighting_enabled:false,ambient_glow_enabled:false};
}
class ReelsCanvasRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this._seCache = { key: null, img: null }; // stroke expand cache
        this._ambientLightingLayer = null;
    }

    async _loadWritingCursorGif(source,entry) {
        if(typeof ImageDecoder==='undefined')throw new Error('当前软件无法解码 GIF 动画。');
        const data=window.electronAPI.readWritingCursorImage(source);
        const decoder=new ImageDecoder({data:new Uint8Array(data),type:'image/gif',preferAnimation:true});
        const frames=[];let duration=0;
        try {
            await decoder.tracks.ready;
            await decoder.completed;
            const count=decoder.tracks.selectedTrack?.frameCount||0;
            for(let i=0;i<count;i++) {
                const {image}=await decoder.decode({frameIndex:i});
                try {
                    const canvas=document.createElement('canvas');
                    const scale=Math.min(1,512/Math.max(image.displayWidth,image.displayHeight));
                    canvas.width=Math.max(1,Math.round(image.displayWidth*scale));
                    canvas.height=Math.max(1,Math.round(image.displayHeight*scale));
                    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
                    duration+=image.duration>0?image.duration/1000000:.1;
                    frames.push({image:canvas,end:duration});
                } finally {image.close();}
            }
            if(!frames.length)throw new Error('GIF 没有可读取的画面，请重新上传。');
            entry.frames=frames;entry.duration=duration;entry.image=frames[0].image;
            window.reelsRefreshSpeechWritingPreview?.();
            return entry.image;
        } finally {decoder.close();}
    }

    _getWritingCursorImage(source) {
        if(!source)return null;
        this._writingCursorImages ||= new Map();
        if(this._writingCursorImages.has(source))return this._writingCursorImages.get(source);
        const entry={image:null,error:null,promise:null};
        this._writingCursorImages.set(source,entry);
        if(/\.gif(?:[?#]|$)/i.test(source)) {
            entry.promise=this._loadWritingCursorGif(source,entry).catch(error=>{entry.error=error;throw error;});
            entry.promise.catch(()=>{});
            return entry;
        }
        entry.promise=new Promise((resolve,reject)=>{
            const img=new Image();
            img.onload=()=>{entry.image=img;resolve(img);window.reelsRefreshSpeechWritingPreview?.();};
            img.onerror=()=>{entry.error=new Error('无法加载出字图片，请重新上传。');reject(entry.error);};
            img.src=window.electronAPI?.toFileUrl?.(source)||source;
        });
        entry.promise.catch(()=>{});
        return entry;
    }
    async prepareWritingCursorImage(style) {
        if(style?.fullpage_typewriter_cursor_kind!=='image')return;
        const source=style.fullpage_typewriter_cursor_image;
        if(!source)throw new Error('请先上传出字图片。');
        await this._getWritingCursorImage(source).promise;
    }
    _drawWritingCursorImage(ctx,style,x,y,size,angle,currentTime=0) {
        const entry=this._getWritingCursorImage(style.fullpage_typewriter_cursor_image);
        let img=entry?.image;
        if(entry?.frames?.length) {
            const t=Math.max(0,Number(currentTime)||0)%entry.duration;
            img=(entry.frames.find(frame=>t<frame.end)||entry.frames[entry.frames.length-1]).image;
        }
        if(!img)return;
        const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height;
        if(!iw||!ih)return;
        const factor=size/Math.max(iw,ih),w=iw*factor,h=ih*factor;
        const ax=Math.max(0,Math.min(100,Number(style.fullpage_typewriter_cursor_image_anchor_x??50)))/100;
        const ay=Math.max(0,Math.min(100,Number(style.fullpage_typewriter_cursor_image_anchor_y??50)))/100;
        ctx.save();ctx.translate(x,y);ctx.rotate(angle*Math.PI/180);
        ctx.drawImage(img,-w*ax,-h*ay,w,h);ctx.restore();
    }

    setContextSegments(segments, originalScript = '') {
        this._writingOriginalScript = originalScript;
        this._contextSegments = repairCollapsedWritingSegments(segments || []);
    }

    // 环境光的暗部调色（电影级暗角过渡）：支持暗部颜色、暗部强度、中心暗度与暗角范围实时调节
    renderAmbientLightingBase(style, videoW, videoH) {
        const isEnabled = style?.ambient_lighting_enabled || style?.ambient_glow_enabled;
        if (!isEnabled) return;
        const ctx = this.ctx;
        const outerOpacity = Math.max(0, Math.min(1, Number(style.ambient_dark_opacity ?? .70)));
        const centerOpacity = Math.max(0, Math.min(1, Number(style.ambient_dark_center_opacity ?? .20)));
        if (outerOpacity <= 0.005 && centerOpacity <= 0.005) return;
        
        const darkColor = style.ambient_dark_color || '#000000';
        const hex = String(darkColor).replace('#', '');
        const rVal = parseInt(hex.slice(0, 2), 16) || 0;
        const gVal = parseInt(hex.slice(2, 4), 16) || 0;
        const bVal = parseInt(hex.slice(4, 6), 16) || 0;

        const darkRadiusRatio = Math.max(0.1, Math.min(2.0, Number(style.ambient_dark_radius ?? 0.8)));
        const posY = style.pos_y != null ? style.pos_y : 0.5;
        const centerX = videoW / 2;
        const centerY = videoH * posY;
        const innerR = videoW * (darkRadiusRatio * 0.15);
        const outerR = videoW * (darkRadiusRatio * 0.95);

        // Render the dark environment on its own layer.  This lets the active
        // light aperture lower the *dark layer's* alpha rather than merely
        // painting a brighter colour over a blackened background.
        const layer = this._getAmbientLightingLayer(videoW, videoH);
        if (!layer) return this._renderAmbientLightingDirect(ctx, centerX, centerY, innerR, outerR,
            rVal, gVal, bVal, centerOpacity, outerOpacity, videoW, videoH);
        const layerCtx = layer.getContext('2d');
        layerCtx.clearRect(0, 0, videoW, videoH);
        layerCtx.globalCompositeOperation = 'source-over';
        const vigGrad = layerCtx.createRadialGradient(centerX, centerY, innerR, centerX, centerY, outerR);
        vigGrad.addColorStop(0, `rgba(${rVal}, ${gVal}, ${bVal}, ${centerOpacity.toFixed(3)})`);
        vigGrad.addColorStop(0.35, `rgba(${rVal}, ${gVal}, ${bVal}, ${(centerOpacity + (outerOpacity - centerOpacity) * 0.45).toFixed(3)})`);
        vigGrad.addColorStop(0.70, `rgba(${rVal}, ${gVal}, ${bVal}, ${(centerOpacity + (outerOpacity - centerOpacity) * 0.82).toFixed(3)})`);
        vigGrad.addColorStop(1, `rgba(${rVal}, ${gVal}, ${bVal}, ${outerOpacity.toFixed(3)})`);
        layerCtx.fillStyle = vigGrad;
        layerCtx.fillRect(0, 0, videoW, videoH);

        // The aperture uses the same radius and intensity controls as the
        // optical glow.  At the centre, glow opacity directly determines how
        // much of the dark environment is removed; it smoothly returns to the
        // configured vignette at the edge of the glow range.
        if (style?.ambient_glow_enabled) {
            const glowRadius = Math.max(60, Number(style.ambient_glow_radius) || 360) * 1.35;
            const glowOpacity = Math.max(0, Math.min(1, Number(style.ambient_glow_opacity ?? .55)));
            if (glowOpacity > 0.005) {
                layerCtx.save();
                layerCtx.globalCompositeOperation = 'destination-out';
                const aperture = layerCtx.createRadialGradient(centerX, centerY, 0, centerX, centerY, glowRadius);
                aperture.addColorStop(0, `rgba(0, 0, 0, ${glowOpacity.toFixed(3)})`);
                aperture.addColorStop(0.30, `rgba(0, 0, 0, ${(glowOpacity * .82).toFixed(3)})`);
                aperture.addColorStop(0.65, `rgba(0, 0, 0, ${(glowOpacity * .35).toFixed(3)})`);
                aperture.addColorStop(1, 'rgba(0, 0, 0, 0)');
                layerCtx.fillStyle = aperture;
                layerCtx.fillRect(centerX - glowRadius, centerY - glowRadius, glowRadius * 2, glowRadius * 2);
                layerCtx.restore();
            }
        }

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(layer, 0, 0, videoW, videoH);
        ctx.restore();
    }

    _getAmbientLightingLayer(width, height) {
        if (typeof document === 'undefined') return null;
        if (!this._ambientLightingLayer) this._ambientLightingLayer = document.createElement('canvas');
        if (this._ambientLightingLayer.width !== width || this._ambientLightingLayer.height !== height) {
            this._ambientLightingLayer.width = width;
            this._ambientLightingLayer.height = height;
        }
        return this._ambientLightingLayer;
    }

    _renderAmbientLightingDirect(ctx, centerX, centerY, innerR, outerR,
        rVal, gVal, bVal, centerOpacity, outerOpacity, videoW, videoH) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        const vigGrad = ctx.createRadialGradient(centerX, centerY, innerR, centerX, centerY, outerR);
        vigGrad.addColorStop(0, `rgba(${rVal}, ${gVal}, ${bVal}, ${centerOpacity.toFixed(3)})`);
        vigGrad.addColorStop(0.35, `rgba(${rVal}, ${gVal}, ${bVal}, ${(centerOpacity + (outerOpacity - centerOpacity) * 0.45).toFixed(3)})`);
        vigGrad.addColorStop(0.70, `rgba(${rVal}, ${gVal}, ${bVal}, ${(centerOpacity + (outerOpacity - centerOpacity) * 0.82).toFixed(3)})`);
        vigGrad.addColorStop(1, `rgba(${rVal}, ${gVal}, ${bVal}, ${outerOpacity.toFixed(3)})`);
        ctx.fillStyle = vigGrad;
        ctx.fillRect(0, 0, videoW, videoH);
        ctx.restore();
    }

    /**
     * 主渲染入口
     */
    renderSubtitle(style, segment, currentTime, videoW, videoH, _isSubCall = false, _skipKineticBackdrop = false) {
        if (!segment) return;
        const ctx = this.ctx;
        const s = {
            ...(style || {}),
            ...(segment.style_override || segment.subtitle_style || {})
        };
        // 最后一遍文字清晰层：环境光已经全部叠完，不能再参与光的混合。
        if (style?._ambient_text_final_pass) s.ambient_glow_enabled = false;
        const rawSegmentText = segment.edited_text || segment.text || '';
        const segmentText = this._applyTextTransform(rawSegmentText, s);
        const textDirection = (typeof ReelsTextDirection !== 'undefined')
            ? ReelsTextDirection.resolve(s.text_direction, segmentText)
            : 'ltr';
        ctx.direction = textDirection;
        ctx.textAlign = 'left';

        if (!_isSubCall && s.mixed_layout && s.mixed_layout !== 'none') {
            this._renderMixedLayout(s, segment, currentTime, videoW, videoH);
            return;
        }

        if (!_isSubCall && s.fullpage_typewriter) {
            this._renderFullpageTypewriter(s, currentTime, videoW, videoH);
            return;
        }

        if (!_isSubCall && s.anim_in_type === 'scatter_pop') {
            this._renderScatterPop(s, segment, currentTime, videoW, videoH);
            return;
        }

        if (!_isSubCall && s.anim_in_type === 'word_random_position') {
            this._renderWordRandomPosition(s, segment, currentTime, videoW, videoH);
            return;
        }

        if (!_isSubCall && s.anim_in_type === 'kinetic_glow_stack') {
            if (!_skipKineticBackdrop) {
                this.renderKineticGlowBackdrop(s, videoW, videoH);
            }
            this._renderKineticGlowStack(s, segment, currentTime, videoW, videoH);
            return;
        }

        const text = segmentText;
        if (!text.trim()) return;

        const segStart = segment.start || 0;
        const segEnd = segment.end || 0;
        
        // Context interception for Scrolling Mode (teleprompter-style)
        if (!_isSubCall && s.scrolling_mode && this._contextSegments && this._contextSegments.length > 1) {
            // Find which segment is active
            let activeIdx = -1;
            for (let si = 0; si < this._contextSegments.length; si++) {
                const seg = this._contextSegments[si];
                if (currentTime >= seg.start && currentTime <= seg.end) {
                    activeIdx = si;
                    break;
                }
            }
            if (activeIdx === -1) {
                for (let si = 0; si < this._contextSegments.length; si++) {
                    if (this._contextSegments[si].start > currentTime) {
                        activeIdx = Math.max(0, si - 1);
                        break;
                    }
                }
                if (activeIdx === -1) activeIdx = this._contextSegments.length - 1;
            }

            const activeSeg = this._contextSegments[activeIdx];
            const fontSize = s.fontsize || 60;
            // Gap between lines: generous spacing for readability
            const gap = fontSize * 1.8;

            // Smooth transition when switching lines
            const transDur = 0.30;
            let scrollAnim = 0;
            if (currentTime >= activeSeg.start && currentTime < activeSeg.start + transDur && activeIdx > 0) {
                const t = (currentTime - activeSeg.start) / transDur;
                const ease = 1 - Math.pow(1 - t, 3);
                scrollAnim = (1 - ease);
            }
            const centerIdx = activeIdx - scrollAnim;

            const visibleLines = s.scrolling_visible_lines || 5;
            const halfVisible = visibleLines / 2;
            const contextOpacity = s.scrolling_opacity_context ?? 0.25;

            for (let si = 0; si < this._contextSegments.length; si++) {
                const distFromCenter = si - centerIdx;
                if (Math.abs(distFromCenter) > halfVisible + 1) continue;

                const yOffset = distFromCenter * gap;
                const absDist = Math.abs(distFromCenter);

                // Opacity
                let lineAlpha = 1.0;
                if (absDist > 0.5) {
                    lineAlpha = contextOpacity;
                    if (absDist > halfVisible - 0.5) {
                        lineAlpha *= Math.max(0, 1.0 - (absDist - (halfVisible - 0.5)));
                    }
                }
                if (lineAlpha <= 0.01) continue;

                const targetSeg = this._contextSegments[si];
                const targetStyle = { ...s };
                targetStyle.scrolling_mode = false;

                // Determine render time and highlight state
                const isPast = currentTime > targetSeg.end;
                const isFuture = currentTime < targetSeg.start;
                const isPlaying = !isPast && !isFuture;
                let renderTime;
                if (isPlaying) {
                    renderTime = currentTime;
                } else if (isPast) {
                    // Already read: plain text, no highlight
                    renderTime = targetSeg.start;
                    targetStyle.karaoke_highlight = false;
                    targetStyle.color_high = targetStyle.color_text || '#FFFFFF';
                } else {
                    // Future: show static, no highlight
                    renderTime = targetSeg.start;
                    targetStyle.karaoke_highlight = false;
                    targetStyle.color_high = targetStyle.color_text || '#FFFFFF';
                }

                // Scrolling mode: disable ALL animations — scroll handles transitions
                targetStyle.anim_in_type = 'none';
                targetStyle.anim_out_type = 'none';
                targetStyle.dynamic_box = false;

                // Apply opacity through style so renderSubtitle respects it
                targetStyle.opacity_text_global = lineAlpha;

                ctx.save();
                ctx.translate(0, yOffset);

                this.renderSubtitle(targetStyle, targetSeg, renderTime, videoW, videoH, true);
                ctx.restore();
            }
            return;
        }

        const isLineFocus = Boolean(s.active_line_focus_enabled || (s.anim_in_type || 'none') === 'line_focus');
        if (!_isSubCall && isLineFocus && this._contextSegments && this._contextSegments.length > 1) {
            const curTextRaw = String(segment.edited_text || segment.text || '').trim();
            const curWordsRaw = curTextRaw ? curTextRaw.split(/\s+/).filter(Boolean) : [];
            if (curTextRaw && !curTextRaw.includes('\n') && curWordsRaw.length >= 1 && curWordsRaw.length <= 3) {
                const segIdx = this._contextSegments.findIndex(seg =>
                    seg === segment ||
                    (seg.start === segment.start && seg.end === segment.end && (seg.edited_text || seg.text) === (segment.edited_text || segment.text))
                );
                if (segIdx >= 0) {
                    const pairBaseIdx = segIdx - (segIdx % 2);
                    const segA = this._contextSegments[pairBaseIdx];
                    const segB = this._contextSegments[pairBaseIdx + 1];
                    if (segA && segB) {
                        const textA = String(segA.edited_text || segA.text || '').trim();
                        const textB = String(segB.edited_text || segB.text || '').trim();
                        const tokensA = textA ? textA.split(/\s+/).filter(Boolean) : [];
                        const tokensB = textB ? textB.split(/\s+/).filter(Boolean) : [];
                        const gapAB = (Number(segB.start) || 0) - (Number(segA.end) || 0);
                        if (textA && textB && !textA.includes('\n') && !textB.includes('\n') &&
                            tokensA.length <= 3 && tokensB.length <= 3 && gapAB <= 1.5) {
                            const buildSegWords = (segObj, tokens) => {
                                const s0 = Number(segObj.start) || 0;
                                const s1 = Math.max(s0 + 0.001, Number(segObj.end) || (s0 + 1));
                                const dur = s1 - s0;
                                const rawW = Array.isArray(segObj.words) ? segObj.words : [];
                                if (rawW.length === tokens.length && rawW.length > 0) {
                                    return rawW.map((w, i) => ({
                                        word: w?.word ?? w?.text ?? tokens[i],
                                        start: Number.isFinite(Number(w?.start)) ? Number(w.start) : (s0 + dur * (i / tokens.length)),
                                        end: Number.isFinite(Number(w?.end)) ? Number(w.end) : (s0 + dur * ((i + 1) / tokens.length)),
                                    }));
                                }
                                return tokens.map((tok, i) => ({
                                    word: tok,
                                    start: s0 + dur * (i / Math.max(1, tokens.length)),
                                    end: s0 + dur * ((i + 1) / Math.max(1, tokens.length)),
                                }));
                            };
                            const combinedText = `${textA}\n${textB}`;
                            const pairedStart = Number(segA.start) || 0;
                            const pairedEnd = Number(segB.end) || 0;
                            if (currentTime < pairedStart || currentTime > pairedEnd) return;
                            const pairedSeg = {
                                ...segment,
                                start: pairedStart,
                                end: pairedEnd,
                                text: combinedText,
                                edited_text: combinedText,
                                words: [...buildSegWords(segA, tokensA), ...buildSegWords(segB, tokensB)],
                            };
                            this.renderSubtitle(style, pairedSeg, currentTime, videoW, videoH, true);
                            return;
                        }
                    }
                }
            }
        }

        // For non-scrolling lines, we only render if active
        if (!_isSubCall && (currentTime < segStart || currentTime > segEnd)) return;

        // 【拦截】如果包含富文本样式范围，或启用了自动着色规则，则进入独立的富文本渲染循环，以此保证旧版 0 损耗
        // 自动着色的字符坐标必须与实际绘制的文本一致。字幕经过编辑后
        // edited_text 与 text 可能不同；此前仍以 text 建立范围，会让命中词
        // 后面的富文本切片错位，进而造成该句排版重叠/混乱。
        const renderedText = segmentText;
        let finalStyledRanges = Array.isArray(segment.styled_ranges) ? segment.styled_ranges : [];
        if (s.auto_color_rules && s.auto_color_rules.length > 0 && typeof ReelsRichText !== 'undefined') {
            const autoRanges = ReelsRichText.getCachedAutoColor(renderedText, s.auto_color_rules);
            finalStyledRanges = ReelsRichText.mergeAutoAndManual(autoRanges, finalStyledRanges);
        }

        // 兼容旧任务中保存的范围：文本被编辑后，丢弃越界部分，避免影响
        // splitByRanges 的分段与换行计算。
        if (finalStyledRanges.length > 0 && typeof ReelsRichText !== 'undefined') {
            finalStyledRanges = ReelsRichText.validateRanges(finalStyledRanges, renderedText.length);
        }

        if (finalStyledRanges && finalStyledRanges.length > 0) {
            const origRanges = segment.styled_ranges;
            segment.styled_ranges = finalStyledRanges;
            this._renderRichTextSubtitle(style, segment, currentTime, videoW, videoH);
            segment.styled_ranges = origRanges; // 恢复原始引用
            return;
        }

        const anim = (typeof ReelsAnimEngine !== 'undefined' ? ReelsAnimEngine : (typeof window !== 'undefined' ? window.ReelsAnimEngine : null));

        // ── 字体设置 ──
        const fontFamily = s.font_family || 'Arial';
        const fallbackFamily = _resolveGenericFallback(fontFamily);
        const fontWeight = _resolveFontWeight(s.font_weight, s.bold !== false ? 700 : 400);
        const fontSize = s.fontsize || 74;
        const italic = s.italic || false;
        // Drawing Arabic-family scripts character-by-character breaks joining.
        // Preserve shaped glyph runs in RTL mode and ignore manual letter spacing.
        const letterSpacing = textDirection === 'rtl' ? 0 : (s.letter_spacing || 0);
        const wordSpacing = s.word_spacing || 0;
        const randomWordSpacingMax = Math.max(0, Number(s.random_word_spacing || 0));
        const randomLineSpacingMax = Math.max(0, Number(s.random_line_spacing || 0));
        const fontStr = `${italic ? 'italic ' : ''}${fontWeight} ${fontSize}px "${fontFamily}", ${fallbackFamily}`;
        ctx.font = fontStr;
        ctx.textBaseline = 'top';

        // ── 高级文本框 ──
        const advEnabled = !!s.advanced_textbox_enabled;
        const advAlign = (s.advanced_textbox_align || s.adv_text_align || 'center').toLowerCase();
        const advX = parseFloat(s.advanced_textbox_x) || 0;
        const advY = parseFloat(s.advanced_textbox_y) || 0;
        const advW = Math.max(80, parseFloat(s.advanced_textbox_w) || videoW * 0.8);
        const advH = Math.max(40, parseFloat(s.advanced_textbox_h) || 200);
        const autoWrap = s.auto_wrap !== false;

        // ── 文字换行计算 ──
        let maxWidth;
        if (advEnabled) {
            maxWidth = Math.max(1, advW);
        } else {
            const wrapPercent = Math.max(20, Math.min(120, s.wrap_width_percent || 90));
            maxWidth = Math.max(200, Math.floor(videoW * (wrapPercent / 100)));
        }

        const wordsInfo = segment.words || [];
        const mappedWords = wordsInfo.length > 0
            ? wordsInfo.map(w => this._applyTextTransform(w?.word ?? w?.text ?? '', s)).filter(Boolean)
            : [];
        const flatWords = mappedWords.length > 0
            ? mappedWords
            : text.split(/\s+/).filter(Boolean);
        const words = flatWords;
        const joiner = ' ';

        const paragraphs = text.split('\n');
        const lines = [];
        
        // 建立单词到段落的映射
        const wordParaIndices = [];
        let currentParaIdx = 0;
        let paraCharIdx = 0;

        for (let w = 0; w < flatWords.length; w++) {
            const wordStr = flatWords[w];
            const wordNonSpaces = wordStr.replace(/\s/g, '').length;
            
            while (currentParaIdx < paragraphs.length) {
                const para = paragraphs[currentParaIdx];
                // 跳过段落前面的空白字符
                while (paraCharIdx < para.length && /\s/.test(para[paraCharIdx])) {
                    paraCharIdx++;
                }
                if (paraCharIdx < para.length) {
                    const remaining = para.slice(paraCharIdx);
                    const paraRemainingNonSpaces = remaining.replace(/\s/g, '').length;
                    // 如果当前段落剩下的字符全是空白，且不是最后一个段落，则移到下一个段落
                    if (paraRemainingNonSpaces === 0 && currentParaIdx < paragraphs.length - 1) {
                        currentParaIdx++;
                        paraCharIdx = 0;
                        continue;
                    }
                    
                    wordParaIndices.push(currentParaIdx);
                    
                    // 在当前段落中消耗掉当前单词的所有非空白字符
                    let matchedNonSpaces = 0;
                    while (paraCharIdx < para.length && matchedNonSpaces < wordNonSpaces) {
                        if (!/\s/.test(para[paraCharIdx])) {
                            matchedNonSpaces++;
                        }
                        paraCharIdx++;
                    }
                    break;
                } else {
                    if (currentParaIdx < paragraphs.length - 1) {
                        currentParaIdx++;
                        paraCharIdx = 0;
                    } else {
                        wordParaIndices.push(currentParaIdx);
                        break;
                    }
                }
            }
        }

        // 按段落对单词分组
        const paraWordsGroups = Array.from({ length: paragraphs.length }, () => []);
        for (let w = 0; w < flatWords.length; w++) {
            const pIdx = wordParaIndices[w] !== undefined ? wordParaIndices[w] : (paragraphs.length - 1);
            paraWordsGroups[pIdx].push(flatWords[w]);
        }

        const popMaxScaleGlobal = getSubtitleLayoutMaxScale(s);
        const antiCollisionPaddingGlobal = (popMaxScaleGlobal > 1.05) ? ((ctx.measureText(' ').width + wordSpacing) * (popMaxScaleGlobal - 1.0) * 1.2) : 0;

        for (let i = 0; i < paragraphs.length; i++) {
            const paraWords = paraWordsGroups[i];
            if (paraWords.length > 0) {
                const wrapWordSpacing = wordSpacing + randomWordSpacingMax + antiCollisionPaddingGlobal;
                const paraLines = this._wrapTokensByPixelWidth(paraWords, autoWrap ? maxWidth : Infinity, joiner, letterSpacing, wrapWordSpacing);
                lines.push(...paraLines);
            } else {
                const isLast = (i === paragraphs.length - 1);
                if (!isLast || paragraphs[i].trim() !== '') {
                    lines.push('');
                }
            }
        }
        if (isLineFocus && paragraphs.length === 1 && flatWords.length >= 2) {
            const mid = Math.ceil(flatWords.length / 2);
            const half1 = flatWords.slice(0, mid);
            const half2 = flatWords.slice(mid);
            const wrapWordSpacing = wordSpacing + randomWordSpacingMax + antiCollisionPaddingGlobal;
            const lines1 = this._wrapTokensByPixelWidth(half1, autoWrap ? maxWidth : Infinity, joiner, letterSpacing, wrapWordSpacing);
            const lines2 = this._wrapTokensByPixelWidth(half2, autoWrap ? maxWidth : Infinity, joiner, letterSpacing, wrapWordSpacing);
            if (lines1.length === 1 && lines2.length === 1) {
                lines.length = 0;
                lines.push(lines1[0], lines2[0]);
            } else if (lines.length === 1) {
                lines.length = 0;
                lines.push(...lines1, ...lines2);
            }
        }
        if (lines.length === 0) return;

        // ── 行高与布局 ──
        const lineSpacing = s.line_spacing || 0;
        const lineH = fontSize * 1.2;
        const lineStep = lineH + lineSpacing;
        const blockTypography = s.block_typography_enabled === true;
        const blockScaleMin = Number.isFinite(Number(s.block_scale_min)) ? Number(s.block_scale_min) : 0.78;
        const blockScaleMax = Number.isFinite(Number(s.block_scale_max)) ? Number(s.block_scale_max) : 1.6;
        const blockTargetWidth = maxWidth;

        // If advanced textbox, limit visible lines
        let visibleLines = lines;
        if (advEnabled) {
            const maxVisLines = Math.max(1, Math.floor(advH / Math.max(1, lineStep)));
            visibleLines = lines.slice(0, maxVisLines);
        }

        let maxLineW = 0;
        let widthWordStartIdx = 0;
        const lineWidths = visibleLines.map(line => {
            const measured = this._measureLineWithRandomSpacing(ctx, line, letterSpacing, wordSpacing, s, segStart, widthWordStartIdx);
            const w = measured.width;
            widthWordStartIdx = measured.nextWordIdx;
            maxLineW = Math.max(maxLineW, w);
            return w;
        });
        const lineGlyphBounds = visibleLines.map((line) => {
            if (!line || !line.trim()) return { top: 0, bottom: lineH, height: lineH };
            return getTopBaselineGlyphBounds(ctx.measureText(line), fontSize, lineH);
        });

        // Precompute word timings & active spoken word index so line-level focus scaling and word rendering share it
        const animInType_ = s.anim_in_type || 'none';
        const _isWPR_ = animInType_ === 'word_pop_random';
        const _isWPRP_ = animInType_ === 'word_pop_random_pulse';
        const _isLJ_ = animInType_ === 'letter_jump';
        const totalWordCount = Math.max(1, words.length);
        const segDur = Math.max(0.001, segEnd - segStart);
        const wordPopGroups = (_isWPR_ && words.length > 0)
            ? this._buildWordPopGroups(words.length, segStart, segEnd, wordsInfo)
            : null;
        const resolvedWordTimings = Array.from({ length: totalWordCount }, (_, idx) => {
            const wInfo = idx < wordsInfo.length ? wordsInfo[idx] : null;
            const fbStart = segStart + segDur * (idx / totalWordCount);
            const fbEnd = segStart + segDur * ((idx + 1) / totalWordCount);
            const rawStart = wInfo ? Number(wInfo.start) : NaN;
            const rawEnd = wInfo ? Number(wInfo.end) : NaN;
            let ws = Number.isFinite(rawStart) ? rawStart : fbStart;
            let we = Number.isFinite(rawEnd) ? rawEnd : fbEnd;
            if (wordPopGroups && idx < wordPopGroups.starts.length) {
                ws = wordPopGroups.starts[idx];
                we = wordPopGroups.ends[idx];
            }
            return { start: ws, end: we };
        });
        const highlightEnabled = s.highlight_enabled !== false && s.karaoke_highlight !== false;
        const highlightScaleEnabled = Boolean(s.highlight_scale_enabled);
        const highlightScaleFactor = highlightScaleEnabled
            ? Math.max(0.5, Math.min(3.0, (Number(s.highlight_scale) || 125) / 100))
            : 1.0;
        const hideUntilSpoken = Boolean(s.hide_until_spoken);
        const unreadOpacityFactor = Math.max(0, Math.min(1, Number(s.unread_opacity ?? 0) / 100));
        let activeSpokenIdx = -1;
        if ((highlightEnabled || highlightScaleEnabled || hideUntilSpoken || s.dynamic_box || isLineFocus) &&
            currentTime != null && currentTime >= segStart - 1e-6 && currentTime <= segEnd + 1e-6) {
            activeSpokenIdx = resolvedWordTimings.findIndex((wt, idx) =>
                currentTime >= wt.start && (idx === totalWordCount - 1 ? currentTime <= wt.end : currentTime < wt.end)
            );
            if (activeSpokenIdx < 0) {
                for (let k = totalWordCount - 1; k >= 0; k--) {
                    if (currentTime >= resolvedWordTimings[k].start - 1e-6) {
                        activeSpokenIdx = k;
                        break;
                    }
                }
                if (activeSpokenIdx < 0 && totalWordCount > 0) {
                    activeSpokenIdx = 0;
                }
            }
        }
        const lineWordRanges = [];
        let rangeWordCursor = 0;
        for (let li = 0; li < visibleLines.length; li++) {
            const cnt = visibleLines[li].split(/\s+/).filter(Boolean).length;
            lineWordRanges.push({ startWordIdx: rangeWordCursor, endWordIdx: rangeWordCursor + cnt });
            rangeWordCursor += cnt;
        }
        const lineFocusState = (isLineFocus && visibleLines.length > 1 && anim && typeof anim.computeActiveLineFocusScales === 'function')
            ? anim.computeActiveLineFocusScales(lineWordRanges, activeSpokenIdx, 1.0, Number(s.inactive_line_scale ?? 0.62))
            : null;

        const lineScales = lineWidths.map((w, lineIndex) => {
            const lineTokens = visibleLines[lineIndex].split(/\s+/).filter(Boolean);
            let maxAnimatedTokenW = 0;
            for (const token of lineTokens) {
                maxAnimatedTokenW = Math.max(
                    maxAnimatedTokenW,
                    this._measureTextWithSpacing(ctx, token, letterSpacing) * popMaxScaleGlobal,
                );
            }
            const overflowFit = maxAnimatedTokenW > maxWidth ? maxWidth / maxAnimatedTokenW : 1.0;
            const focusScale = lineFocusState ? (lineFocusState.scales[lineIndex] ?? 1.0) : 1.0;
            if (!blockTypography) return Math.min(1.0, overflowFit) * focusScale;
            const safeW = Math.max(1, w);
            const fit = blockTargetWidth / safeW;
            return Math.min(overflowFit, Math.max(blockScaleMin, Math.min(blockScaleMax, fit))) * focusScale;
        });
        const lineHeights = lineScales.map(sc => lineH * sc * popMaxScaleGlobal);
        const lineSpacings = visibleLines.map((_, i) => {
            if (i >= visibleLines.length - 1) return 0;
            const verticalCushion = (popMaxScaleGlobal > 1.05) ? (lineH * (popMaxScaleGlobal - 1.0) * 0.35) : 0;
            return lineSpacing + verticalCushion + this._computeRandomLineSpacing(s, i, segStart);
        });
        const lineTopOffsets = [];
        let accumY = 0;
        for (let i = 0; i < visibleLines.length; i++) {
            lineTopOffsets.push(accumY);
            accumY += lineHeights[i];
            if (i < visibleLines.length - 1) accumY += lineSpacings[i];
        }
        const lineTextTopOffsets = lineTopOffsets.map((slotTop, i) => {
            const renderedLineH = lineH * (lineScales[i] || 1);
            return slotTop + Math.max(0, ((lineHeights[i] || renderedLineH) - renderedLineH) / 2);
        });
        const totalH = accumY;

        // ── 精确计算每行实际渲染宽度（模拟渲染循环的 currX 推进） ──
        const segDur_ = segDur;
        const baseSpaceW_ = ctx.measureText(' ').width + wordSpacing;
        const popMaxScale_ = popMaxScaleGlobal;
        const antiCollisionPadding_ = (popMaxScale_ > 1.05) ? (baseSpaceW_ * (popMaxScale_ - 1.0) * 1.2) : 0;
        const safeBaseSpaceW_ = baseSpaceW_ + antiCollisionPadding_;

        let actualMaxLineW = 0;
        let finalMaxLineW = 0; // 所有词完全展开后的最终宽度（用于稳定居中锚点）
        const actualLineWidths = []; // 每行动画后实际渲染宽度
        const finalLineWidths = [];  // 每行最终宽度（不随时间变化）
        let simWordIdx = 0;
        for (let li = 0; li < visibleLines.length; li++) {
            const lineTokens = visibleLines[li].split(/\s+/).filter(Boolean);
            const lScale = lineScales[li] || 1.0;
            let lineRenderedW = 0;
            let lineFinalW = 0;

            for (let ti = 0; ti < lineTokens.length; ti++) {
                const ww = this._measureTextWithSpacing(ctx, lineTokens[ti], letterSpacing);
                let allocScale = 1.0;
                let spacingWordStart = segStart + segDur_ * (simWordIdx / Math.max(1, words.length));

                if (_isWPR_) {
                    let ws = segStart;
                    if (wordsInfo.length > 0 && simWordIdx < wordsInfo.length) {
                        ws = wordsInfo[simWordIdx].start || segStart;
                    } else {
                        ws = segStart + segDur_ * (simWordIdx / Math.max(1, words.length));
                    }
                    spacingWordStart = ws;
                    allocScale = this._computeWordRandomFinalScale(
                        simWordIdx, segStart, ws,
                        Number(s.word_pop_random_min_scale ?? 0.7),
                        Number(s.word_pop_random_max_scale ?? 1.34)
                    );
                } else if (_isWPRP_) {
                    const pMax = Number(s.word_pop_random_pulse_max_scale ?? 1.40);
                    allocScale = Math.max(1.0, pMax * 0.85);
                } else if (_isLJ_) {
                    const ljScale = Number(s.letter_jump_scale ?? 1.5);
                    if (ljScale > 1.0) {
                        allocScale = ljScale;
                    }
                }

                const slotW = ww * lScale * allocScale;
                const gapW = (safeBaseSpaceW_ + this._computeRandomWordSpacing(s, simWordIdx, segStart, spacingWordStart)) * lScale;
                if (ti < lineTokens.length - 1) {
                    lineRenderedW += slotW + gapW;
                    lineFinalW += slotW + gapW;
                } else {
                    lineRenderedW += slotW;
                    lineFinalW += slotW;
                }
                simWordIdx++;
            }
            actualLineWidths.push(lineRenderedW);
            actualMaxLineW = Math.max(actualMaxLineW, lineRenderedW);
            finalLineWidths.push(lineFinalW);
            finalMaxLineW = Math.max(finalMaxLineW, lineFinalW);
        }

        // 使用最终宽度（所有词完成动画后）来锚定居中位置，避免逐词弹出时文字整体偏移
        let renderMaxLineW = blockTypography ? blockTargetWidth : maxLineW;
        renderMaxLineW = Math.max(renderMaxLineW, finalMaxLineW);

        // ── 位置计算 ──
        let cx, cy;
        if (advEnabled) {
            cx = advX + advW / 2;
            cy = advY + advH / 2;
        } else {
            cx = typeof s.pos_x === 'number' && s.pos_x <= 1
                ? s.pos_x * videoW : (s.pos_x || videoW / 2);
            cy = typeof s.pos_y === 'number' && s.pos_y <= 1
                ? s.pos_y * videoH : (s.pos_y || videoH * 0.85);
        }

        const rawTextAlign = String(
            s.text_align || (advEnabled ? (s.advanced_textbox_align || s.adv_text_align) : '') || 'center'
        ).toLowerCase();

        const resolveLineAlignMode = (lineIdx) => {
            if (rawTextAlign === 'left' || rawTextAlign === 'right' || rawTextAlign === 'center') {
                return rawTextAlign;
            }
            if (rawTextAlign === 'smart_left_center') {
                const lnStr = String(visibleLines[lineIdx] || '').trim();
                const lnWords = lnStr.split(/\s+/).filter(Boolean);
                const lnW = (finalLineWidths[lineIdx] != null && finalLineWidths[lineIdx] > (lineWidths[lineIdx] || 0))
                    ? finalLineWidths[lineIdx]
                    : (lineWidths[lineIdx] || 0);
                const hasExclaim = /[!?\uFF01\uFF1F]["'”’)]*$/.test(lnStr);
                if (visibleLines.length === 1) {
                    const isShortImpact = (lnWords.length <= 3 && lnStr.length <= 16) || (hasExclaim && lnWords.length <= 4);
                    return isShortImpact ? 'center' : 'left';
                }
                const ratio = renderMaxLineW > 1 ? (lnW / renderMaxLineW) : 1;
                const isFocalShortLine = (ratio < 0.68 && lnWords.length <= 3) || (hasExclaim && ratio < 0.76);
                return isFocalShortLine ? 'center' : 'left';
            }
            return advEnabled ? advAlign : 'center';
        };

        const computeAlignedLineX = (lineIdx, lineWForAlign) => {
            const mode = resolveLineAlignMode(lineIdx);
            if (blockTypography) {
                if (advEnabled && mode === 'left') return advX;
                if (advEnabled && mode === 'right') return advX + advW - renderMaxLineW;
                return cx - renderMaxLineW / 2;
            }
            if (mode === 'left') {
                return advEnabled ? advX : (cx - renderMaxLineW / 2);
            }
            if (mode === 'right') {
                return advEnabled ? (advX + advW - lineWForAlign) : (cx + renderMaxLineW / 2 - lineWForAlign);
            }
            return cx - lineWForAlign / 2;
        };

        const parsePadding = (val, fallback) => {
            if (val === undefined || val === null || val === '') return fallback;
            const parsed = parseFloat(val);
            return Number.isFinite(parsed) ? parsed : fallback;
        };

        const padLeft = parsePadding(s.box_padding_left, parsePadding(s.box_padding_x, 12));
        const padRight = parsePadding(s.box_padding_right, parsePadding(s.box_padding_x, 12));
        const padTop = parsePadding(s.box_padding_top, parsePadding(s.box_padding_y, 8));
        const padBottom = parsePadding(s.box_padding_bottom, parsePadding(s.box_padding_y, 8));

        // 描边/扩展描边超出文字边界的额外量
        let strokeExtra = 0;
        // `0` is a deliberate “no outline” setting from the per-subtitle
        // editor.  Using `|| 3` converted it back to a 3px outline reserve,
        // leaving unwanted space beneath a bottom padding of 0.
        const configuredBorderWidth = Number(s.border_width);
        const borderWidth = Number.isFinite(configuredBorderWidth)
            ? Math.max(0, configuredBorderWidth)
            : (s.use_stroke === false ? 0 : 3);
        if (s.use_stroke !== false && borderWidth > 0) {
            strokeExtra = Math.max(strokeExtra, borderWidth);
        }
        if (s.stroke_expand_enabled) {
            const seLayers = parseInt(s.stroke_expand_layers) || 3;
            const seStep = parseFloat(s.stroke_expand_step) || 4;
            const seFeather = parseFloat(s.stroke_expand_feather) || 8;
            strokeExtra = Math.max(strokeExtra, seLayers * seStep + seFeather);
        }
        const effectivePadLeft = padLeft + strokeExtra;
        const effectivePadRight = padRight + strokeExtra;
        const effectivePadTop = padTop + strokeExtra;
        const effectivePadBottom = padBottom + strokeExtra;
        const canTightFitGlyphs = popMaxScaleGlobal <= 1.05
            && !blockTypography
            && randomLineSpacingMax <= 0
            && lineScales.every(scale => Math.abs(scale - 1) < 0.001);
        const textBlockStartY = cy - totalH / 2;
        const tightContentTop = canTightFitGlyphs
            ? textBlockStartY + (lineGlyphBounds[0]?.top || 0)
            : textBlockStartY;
        const lastLineIndex = Math.max(0, visibleLines.length - 1);
        const lastLineTop = textBlockStartY + (lineTextTopOffsets[lastLineIndex] || 0);
        const tightContentBottom = canTightFitGlyphs
            ? lastLineTop + (lineGlyphBounds[lastLineIndex]?.bottom ?? lineH)
            : textBlockStartY + totalH;
        let rectX, rectY, rectW, rectH;
        if (advEnabled) {
            rectX = advX; rectY = advY; rectW = advW; rectH = advH;
        } else {
            rectX = cx - renderMaxLineW / 2 - effectivePadLeft;
            rectY = tightContentTop - effectivePadTop;
            rectW = renderMaxLineW + effectivePadLeft + effectivePadRight;
            rectH = Math.max(1, tightContentBottom - tightContentTop) + effectivePadTop + effectivePadBottom;
        }

        ctx.save();

        // ── 旋转 ──
        const rotation = s.rotation || 0;
        if (rotation !== 0) {
            ctx.translate(cx, cy);
            ctx.rotate(rotation * Math.PI / 180);
            ctx.translate(-cx, -cy);
        }

        // ── 动画进度 ──
        const animInType = s.anim_in_type || 'none';
        const animOutType = s.anim_out_type || 'none';
        let inProg = 1.0, outProg = 1.0;
        let animOpacity = 1.0;

        if (anim && (animInType !== 'none' || animOutType !== 'none')) {
            const inDur = animInType !== 'none' ? (s.anim_in_duration || 0.3) : 0;
            const outDur = animOutType !== 'none' ? (s.anim_out_duration || 0.25) : 0;
            [inProg, outProg] = anim.computeAnimProgress(
                currentTime, segStart, segEnd, inDur, outDur,
                s.anim_in_easing || 'ease_out', s.anim_out_easing || 'ease_in_out'
            );
        }

        // Fade
        if (animInType === 'fade') animOpacity = Math.min(animOpacity, inProg);
        if (animOutType === 'fade') animOpacity = Math.min(animOpacity, outProg);

        // Slide
        if (anim) {
            if (['slide_up', 'slide_down', 'slide_left', 'slide_right'].includes(animInType)) {
                const [dx, dy] = anim.computeSlideOffset(inProg, animInType, 60, false);
                ctx.translate(dx, dy);
            }
            if (['slide_up', 'slide_down', 'slide_left', 'slide_right'].includes(animOutType)) {
                const [dx, dy] = anim.computeSlideOffset(outProg, animOutType, 60, true);
                ctx.translate(dx, dy);
            }
        }

        // Pop
        if (anim && (animInType === 'pop' || animOutType === 'pop')) {
            let popP = 1.0;
            if (animInType === 'pop') popP = Math.min(popP, anim.computePopScale(inProg));
            if (animOutType === 'pop') popP = Math.min(popP, anim.computePopScale(outProg));
            if (Math.abs(popP - 1.0) > 0.001) {
                ctx.translate(cx, cy);
                ctx.scale(popP, popP);
                ctx.translate(-cx, -cy);
            }
        }

        // Floating
        if (anim && animInType === 'floating') {
            const dyFloat = anim.computeFloatingOffset(
                currentTime, segStart,
                s.floating_amplitude || 8, s.floating_period || 2.0
            );
            ctx.translate(0, dyFloat);
        }

        // Holy glow
        let holyGlowAlpha = 1.0, holyGlowRadius = 0;
        if (anim && animInType === 'holy_glow' && typeof anim.computeHolyGlow === 'function') {
            [holyGlowAlpha, holyGlowRadius] = anim.computeHolyGlow(
                currentTime, segStart, segEnd,
                parseInt(s.holy_glow_radius) || 6,
                parseFloat(s.holy_glow_period) || 3.0
            );
        }

        // Blur→Sharp
        let blurRadius = 0;
        if (anim && animInType === 'blur_sharp' && typeof anim.computeBlurSharpRadius === 'function') {
            blurRadius = anim.computeBlurSharpRadius(
                currentTime, segStart, segEnd,
                parseInt(s.blur_sharp_max) || 20,
                parseFloat(s.blur_sharp_clear_frac) || 0.4
            );
        }

        // Global opacity
        const rawOp = s.opacity_text_global !== undefined ? s.opacity_text_global : 255;
        const normOp = rawOp <= 1.0 && rawOp > 0 ? rawOp : rawOp / 255;
        const globalAlpha = normOp * animOpacity;
        ctx.globalAlpha = globalAlpha;

        // ── Typewriter / Zoom Typewriter ──
        const isZoomTypewriter = animInType === 'zoom_typewriter';
        const isTypewriter = animInType === 'typewriter' || isZoomTypewriter;
        const typewriterRevealType = isZoomTypewriter ? 'char' : (s.typewriter_reveal_type || 'word');
        // Older saved styles may not contain this field at all.  Missing means
        // hidden, not the old implicit 100/255 grey placeholder; otherwise an
        // existing project leaks future words as soon as it uses typewriter.
        // Explicit legacy values in 0–255 remain supported.
        const twUnreadOpacity = isZoomTypewriter ? 0 : (s.tw_unrevealed_opacity === undefined ? 0
            : Math.max(0, Math.min(1, s.tw_unrevealed_opacity > 1
                ? s.tw_unrevealed_opacity / 255 : s.tw_unrevealed_opacity)));
        let twRevealedCount = -1;
        let zoomTwState = null;
        if (isZoomTypewriter && anim && typeof anim.computeZoomTypewriterState === 'function') {
            const totalCharsForZoom = words.reduce((count, word) => count + Array.from(word).length, 0);
            zoomTwState = anim.computeZoomTypewriterState(currentTime, segStart, segEnd, totalCharsForZoom, {
                startScale: s.zoom_tw_start_scale,
                endScale: s.zoom_tw_end_scale,
            });
            twRevealedCount = zoomTwState.revealedChars;
            if (Math.abs(zoomTwState.blockScale - 1.0) > 0.001) {
                ctx.translate(cx, cy);
                ctx.scale(zoomTwState.blockScale, zoomTwState.blockScale);
                ctx.translate(-cx, -cy);
            }
        } else if (isTypewriter && anim) {
            const totalUnits = typewriterRevealType === 'char'
                ? words.reduce((count, word) => count + Array.from(word).length, 0)
                : words.length;
            twRevealedCount = anim.computeTypewriterProgress(
                currentTime, segStart, segEnd, totalUnits
            );
        }

        // ── Character bounce & Extended Per-Char Animations ──
        const isCharBounce = animInType === 'char_bounce';
        const isExtendedCharAnim = !!(anim && anim.isCharAnimType && anim.isCharAnimType(animInType));
        const cbHeight = s.char_bounce_height || 20;
        const cbStagger = s.char_bounce_stagger || 0.05;

        // ── Metronome / Bullet / Letter Jump flags ──
        const isMetronome = animInType === 'metronome';
        const isWordPopRandom = animInType === 'word_pop_random';
        const isWordPopRandomPulse = animInType === 'word_pop_random_pulse';
        const isBullet = animInType === 'bullet_reveal';
        const isLetterJump = animInType === 'letter_jump';
        const isFlash = animInType === 'flash_highlight';
        const isHolyGlow = animInType === 'holy_glow';

        // ── Advanced textbox background ──
        if (advEnabled && s.adv_bg_enabled) {
            this._drawAdvTextboxBg(ctx, s, advX, advY, advW, advH);
        }

        // ── 背景框绘制 ──
        const isBoxWipe = Boolean(s.box_wipe_enabled || animInType === 'box_wipe');
        if (s.use_box || isBoxWipe) {
            ctx.save();
            const bgColor = s.color_bg || '#000000';
            const bgAlpha = (s.opacity_bg ?? 150) / 255;
            ctx.globalAlpha = globalAlpha * bgAlpha;

            // Box blur (feathered edge)
            const boxBlur = s.box_blur || 0;
            const rad = s.box_radius ?? 8;
            const concaveRad = Number.isFinite(Number(s.box_concave_radius))
                ? Math.max(0, Number(s.box_concave_radius))
                : rad;
            const snapThreshold = Number.isFinite(Number(s.box_snap_threshold))
                ? Math.max(0, Number(s.box_snap_threshold))
                : 18;
            
            const isAdaptive = (s.box_adaptive_width || isBoxWipe) && !advEnabled;
            const isConnectedAdaptive = isAdaptive && !isBoxWipe && (s.box_connected !== false) && visibleLines.length > 1;
            let tempStartY;
            if (isAdaptive) {
                tempStartY = cy - totalH / 2;
            }

            const buildBoxPath = (expand) => {
                ctx.beginPath();
                if (isAdaptive) {
                    const slabs = [];
                    const baseSlabWidths = [];
                    for (let i = 0; i < visibleLines.length; i++) {
                        const lineW = lineWidths[i];
                        const effectiveLineW = (actualLineWidths[i] != null && actualLineWidths[i] > lineW) ? actualLineWidths[i] : lineW;
                        const xStart = computeAlignedLineX(i, effectiveLineW);
                        const y = tempStartY + (lineTopOffsets[i] || 0);
                        const lRectX = xStart - effectivePadLeft - expand;
                        const glyphBounds = lineGlyphBounds[i] || { top: 0, bottom: lineH, height: lineH };
                        const tightLine = canTightFitGlyphs;
                        const lRectY = y + (tightLine ? glyphBounds.top : 0) - effectivePadTop - expand;
                        const baseW = effectiveLineW + effectivePadLeft + effectivePadRight;
                        const lRectW = baseW + expand * 2;
                        const contentH = tightLine ? glyphBounds.height : (lineHeights[i] || lineH);
                        const lRectH = contentH + effectivePadTop + effectivePadBottom + expand * 2;
                        baseSlabWidths.push(baseW);
                        slabs.push({
                            left: lRectX,
                            right: lRectX + lRectW,
                            top: lRectY,
                            bottom: lRectY + lRectH,
                        });
                    }
                    if (isBoxWipe && slabs.length > 1) {
                        const minGap = Math.max(4, Math.round(fontSize * 0.10));
                        for (let i = 0; i < slabs.length - 1; i++) {
                            const cur = slabs[i];
                            const nxt = slabs[i + 1];
                            const actualGap = nxt.top - cur.bottom;
                            if (actualGap < minGap) {
                                const mid = (cur.bottom + nxt.top) / 2;
                                const halfGap = minGap / 2;
                                const minHalfH = Math.max(8, fontSize * 0.35);
                                cur.bottom = Math.max(cur.top + minHalfH, mid - halfGap);
                                nxt.top = Math.min(nxt.bottom - minHalfH, mid + halfGap);
                            }
                        }
                    }
                    if (isConnectedAdaptive && slabs.length > 1) {
                        this._buildConnectedAdaptiveBoxPath(
                            ctx,
                            slabs,
                            rad + expand * 0.3,
                            concaveRad + expand * 0.2,
                            snapThreshold
                        );
                    } else {
                        const wipedWidths = (isBoxWipe && anim && typeof anim.computeBoxWipeLineWidths === 'function')
                            ? anim.computeBoxWipeLineWidths(currentTime, segStart, segEnd, baseSlabWidths)
                            : null;
                        for (let i = 0; i < slabs.length; i++) {
                            const sl = slabs[i];
                            let lRectX = sl.left;
                            const lRectY = sl.top;
                            let lRectW = Math.max(1, sl.right - sl.left);
                            if (wipedWidths) {
                                const w = wipedWidths[i] || 0;
                                if (w <= 0.5) continue;
                                lRectW = Math.max(1, w + expand * 2);
                                if (textDirection === 'rtl') {
                                    lRectX = sl.right - lRectW;
                                }
                            }
                            const lRectH = Math.max(1, sl.bottom - sl.top);
                            let r = rad + expand * 0.3;
                            r = Math.min(r, lRectW / 2, lRectH / 2);
                            ctx.moveTo(lRectX + r, lRectY);
                            ctx.lineTo(lRectX + lRectW - r, lRectY);
                            ctx.quadraticCurveTo(lRectX + lRectW, lRectY, lRectX + lRectW, lRectY + r);
                            ctx.lineTo(lRectX + lRectW, lRectY + lRectH - r);
                            ctx.quadraticCurveTo(lRectX + lRectW, lRectY + lRectH, lRectX + lRectW - r, lRectY + lRectH);
                            ctx.lineTo(lRectX + r, lRectY + lRectH);
                            ctx.quadraticCurveTo(lRectX, lRectY + lRectH, lRectX, lRectY + lRectH - r);
                            ctx.lineTo(lRectX, lRectY + r);
                            ctx.quadraticCurveTo(lRectX, lRectY, lRectX + r, lRectY);
                            ctx.closePath();
                        }
                    }
                } else {
                    let r = rad + expand * 0.3;
                    let lRectX = rectX - expand;
                    const lRectY = rectY - expand;
                    let lRectW = rectW + expand * 2;
                    if (isBoxWipe && anim && typeof anim.computeBoxWipeLineWidths === 'function') {
                        const [w] = anim.computeBoxWipeLineWidths(currentTime, segStart, segEnd, [rectW]);
                        if (!w || w <= 0.5) return;
                        lRectW = Math.max(1, w + expand * 2);
                        if (textDirection === 'rtl') {
                            lRectX = (rectX + rectW + expand) - lRectW;
                        }
                    }
                    const lRectH = rectH + expand * 2;
                    r = Math.min(r, lRectW / 2, lRectH / 2);
                    ctx.moveTo(lRectX + r, lRectY);
                    ctx.lineTo(lRectX + lRectW - r, lRectY);
                    ctx.quadraticCurveTo(lRectX + lRectW, lRectY, lRectX + lRectW, lRectY + r);
                    ctx.lineTo(lRectX + lRectW, lRectY + lRectH - r);
                    ctx.quadraticCurveTo(lRectX + lRectW, lRectY + lRectH, lRectX + lRectW - r, lRectY + lRectH);
                    ctx.lineTo(lRectX + r, lRectY + lRectH);
                    ctx.quadraticCurveTo(lRectX, lRectY + lRectH, lRectX, lRectY + lRectH - r);
                    ctx.lineTo(lRectX, lRectY + r);
                    ctx.quadraticCurveTo(lRectX, lRectY, lRectX + r, lRectY);
                    ctx.closePath();
                }
            };

            const brushEngine = (typeof window !== 'undefined' && (window.ReelsBrushEngine || window.ReelsOverlay?.ReelsBrushEngine));
            const bStyle = s.box_brush_style;
            const isBrush = brushEngine && bStyle && bStyle !== 'rect' && bStyle !== 'none';

            if (isBrush) {
                let brushColor = bgColor;
                let brushDir = 'horizontal';
                if (s.bg_gradient_enabled) {
                    const colors = typeof s.bg_gradient_colors === 'string'
                        ? s.bg_gradient_colors.split(',').map(c => c.trim())
                        : (Array.isArray(s.bg_gradient_colors) ? s.bg_gradient_colors : [bgColor, '#333333']);
                    if (colors.length >= 2) {
                        brushColor = colors.join(',');
                        brushDir = s.bg_gradient_type === 'linear_v' ? 'vertical' : 'horizontal';
                    }
                } else if (s.box_transition_enabled && anim) {
                    const fromColor = this._parseColor(bgColor);
                    const toColor = this._parseColor(s.box_transition_color_to || '#FF6600');
                    const transColor = anim.computeBoxColorTransition(
                        currentTime, segStart, segEnd, wordsInfo,
                        [...fromColor, Math.round(bgAlpha * 255)],
                        [...toColor, Math.round(bgAlpha * 255)]
                    );
                    brushColor = `rgba(${transColor[0]},${transColor[1]},${transColor[2]},${transColor[3] / 255})`;
                }
                const bColorMode = s.box_brush_color_mode || 'tint';
                const bCustomData = s.box_custom_brush_data || null;
                const bSolid = (s.box_brush_solid != null && !isNaN(s.box_brush_solid)) ? Number(s.box_brush_solid) : 100;
                const brushW = Number(s.box_brush_w) || 0;
                const brushH = Number(s.box_brush_h) || 0;
                const brushX = Number(s.box_brush_x) || 0;
                const brushY = Number(s.box_brush_y) || 0;

                if (isAdaptive) {
                    const brushBoxes = [];
                    const brushBaseWidths = [];
                    for (let i = 0; i < visibleLines.length; i++) {
                        const lineW = lineWidths[i];
                        const effectiveLineW = (actualLineWidths[i] != null && actualLineWidths[i] > lineW) ? actualLineWidths[i] : lineW;
                        let xStart = computeAlignedLineX(i, effectiveLineW);
                        const y = tempStartY + (lineTopOffsets[i] || 0);
                        let lRectX = xStart - effectivePadLeft;
                        const glyphBounds = lineGlyphBounds[i] || { top: 0, bottom: lineH, height: lineH };
                        const tightLine = canTightFitGlyphs;
                        let lRectY = y + (tightLine ? glyphBounds.top : 0) - effectivePadTop;
                        let lRectW = effectiveLineW + effectivePadLeft + effectivePadRight;
                        const contentH = tightLine ? glyphBounds.height : (lineHeights[i] || lineH);
                        let lRectH = contentH + effectivePadTop + effectivePadBottom;

                        if (brushW > 0) {
                            const bcx = lRectX + lRectW / 2;
                            lRectW = brushW;
                            lRectX = bcx - lRectW / 2;
                        }
                        if (brushH > 0) {
                            const bcy = lRectY + lRectH / 2;
                            lRectH = brushH;
                            lRectY = bcy - lRectH / 2;
                        }
                        lRectX += brushX;
                        lRectY += brushY;
                        brushBaseWidths.push(lRectW);
                        brushBoxes.push({ x: lRectX, y: lRectY, w: lRectW, h: lRectH });
                    }
                    const wipedBrushWidths = (isBoxWipe && anim && typeof anim.computeBoxWipeLineWidths === 'function')
                        ? anim.computeBoxWipeLineWidths(currentTime, segStart, segEnd, brushBaseWidths)
                        : null;
                    for (let i = 0; i < brushBoxes.length; i++) {
                        const bb = brushBoxes[i];
                        let drawX = bb.x;
                        let drawW = bb.w;
                        if (wipedBrushWidths) {
                            drawW = wipedBrushWidths[i] || 0;
                            if (drawW <= 0.5) continue;
                            if (textDirection === 'rtl') {
                                drawX = (bb.x + bb.w) - drawW;
                            }
                        }
                        brushEngine.drawBrush(ctx, drawX, bb.y, drawW, bb.h, bStyle, brushColor, 1, bColorMode, brushDir, bCustomData, bSolid);
                    }
                } else {
                    let bx = rectX, by = rectY, bw = rectW, bh = rectH;
                    if (brushW > 0) {
                        const bcx = bx + bw / 2;
                        bw = brushW;
                        bx = bcx - bw / 2;
                    }
                    if (brushH > 0) {
                        const bcy = by + bh / 2;
                        bh = brushH;
                        by = bcy - bh / 2;
                    }
                    bx += brushX;
                    by += brushY;
                    if (isBoxWipe && anim && typeof anim.computeBoxWipeLineWidths === 'function') {
                        const [w] = anim.computeBoxWipeLineWidths(currentTime, segStart, segEnd, [bw]);
                        if (w && w > 0.5) {
                            if (textDirection === 'rtl') bx = (bx + bw) - w;
                            brushEngine.drawBrush(ctx, bx, by, w, bh, bStyle, brushColor, 1, bColorMode, brushDir, bCustomData, bSolid);
                        }
                    } else {
                        brushEngine.drawBrush(ctx, bx, by, bw, bh, bStyle, brushColor, 1, bColorMode, brushDir, bCustomData, bSolid);
                    }
                }
            } else {
                if (boxBlur > 0) {
                    const steps = Math.min(20, Math.max(6, Math.floor(boxBlur * 0.5)));
                    for (let si = steps; si >= 0; si--) {
                        const t = si / Math.max(1, steps);
                        const expand = t * boxBlur;
                        const alphaFactor = Math.exp(-((t * 2.8) ** 2));
                        const layerAlpha = bgAlpha * alphaFactor / steps * 3.5;
                        if (layerAlpha < 0.004) continue;
                        ctx.save();
                        ctx.globalAlpha = globalAlpha * Math.min(1, layerAlpha);
                        ctx.fillStyle = bgColor;
                        buildBoxPath(expand);
                        ctx.fill();
                        ctx.restore();
                    }
                }

                ctx.fillStyle = bgColor;

                // Box color transition
                if (s.box_transition_enabled && anim) {
                    const fromColor = this._parseColor(bgColor);
                    const toColor = this._parseColor(s.box_transition_color_to || '#FF6600');
                    const transColor = anim.computeBoxColorTransition(
                        currentTime, segStart, segEnd, wordsInfo,
                        [...fromColor, Math.round(bgAlpha * 255)],
                        [...toColor, Math.round(bgAlpha * 255)]
                    );
                    ctx.fillStyle = `rgba(${transColor[0]},${transColor[1]},${transColor[2]},${transColor[3] / 255})`;
                }

                // Gradient background
                if (s.bg_gradient_enabled) {
                    const colors = typeof s.bg_gradient_colors === 'string'
                        ? s.bg_gradient_colors.split(',').map(c => c.trim())
                        : (Array.isArray(s.bg_gradient_colors) ? s.bg_gradient_colors : [bgColor, '#333333']);
                    if (colors.length >= 2) {
                        let grad;
                        const gradType = s.bg_gradient_type || 'linear_h';
                        if (gradType === 'linear_v') {
                            grad = ctx.createLinearGradient(rectX, rectY, rectX, rectY + rectH);
                        } else if (gradType === 'center') {
                            grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rectW, rectH) / 2);
                        } else if (gradType === 'fresnel') {
                            grad = ctx.createLinearGradient(rectX, rectY, rectX + rectW, rectY);
                            const edgeC = colors[0]; const midC = colors[colors.length - 1];
                            grad.addColorStop(0, edgeC);
                            grad.addColorStop(0.15, midC + '1E'); // alpha ~30
                            grad.addColorStop(0.85, midC + '1E');
                            grad.addColorStop(1.0, edgeC);
                            ctx.fillStyle = grad;
                        } else {
                            grad = ctx.createLinearGradient(rectX, rectY, rectX + rectW, rectY);
                        }
                        if (gradType !== 'fresnel') {
                            colors.forEach((c, i) => {
                                grad.addColorStop(i / Math.max(1, colors.length - 1), c);
                            });
                            ctx.fillStyle = grad;
                        }
                    }
                }

                buildBoxPath(0);
                ctx.fill();

                // Highlight overlay
                if (s.bg_gradient_highlight) {
                    const hlGrad = ctx.createLinearGradient(rectX, rectY, rectX, rectY + rectH * 0.3);
                    hlGrad.addColorStop(0, 'rgba(255,255,255,0.24)');
                    hlGrad.addColorStop(1, 'rgba(255,255,255,0)');
                    ctx.fillStyle = hlGrad;
                    buildBoxPath(0);
                    ctx.fill();
                }
            }
            ctx.restore();
        }

        // ── Flash highlight ──
        if (isFlash && anim) {
            const flashI = anim.computeFlashHighlight(currentTime, segStart, s.flash_duration || 0.1);
            if (flashI > 0.01) {
                ctx.save();
                ctx.globalAlpha = globalAlpha * flashI * 0.8;
                ctx.fillStyle = s.flash_color || '#FFFF00';
                const rad = s.box_radius || 8;
                this._roundRect(ctx, rectX - 4, rectY - 4, rectW + 8, rectH + 8, rad);
                ctx.fill();
                ctx.restore();
            }
        }

        // ── Clip for advanced textbox ──
        if (advEnabled) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(rectX, rectY, rectW, rectH);
            ctx.clip();
        }

        // ── Multi-layer stroke expand (pre-pass) ──
        // These modes control visibility per word/line.  A whole-line pre-pass
        // would leak the expanded outline for text that is still hidden.
        const needsPerWordStrokeExpand = s.only_show_active_word || Boolean(s.hide_until_spoken) ||
            Boolean(s.highlight_scale_enabled) || isTypewriter || isMetronome ||
            isWordPopRandom || isWordPopRandomPulse || isBullet || isExtendedCharAnim ||
            isLineFocus || lineScales.some(sc => Math.abs(sc - 1.0) > 0.001);
        if (s.stroke_expand_enabled && !needsPerWordStrokeExpand) {
            this._renderStrokeExpand(ctx, s, visibleLines, lineWidths, cx, advEnabled, advAlign, advX, advW,
                cy, totalH, lineStep, fontStr, fontSize, letterSpacing, advY, advH, computeAlignedLineX);
        }

        // ── 文字绘制 ──
        if (blurRadius > 0) {
            ctx.filter = `blur(${blurRadius}px)`;
        }
        const textColor = s.color_text || '#FFFFFF';
        const highColor = s.color_high || '#FFD700';
        const outlineColor = s.color_outline || '#3E2723';
        const outlineAlpha = (s.opacity_outline || 255) / 255;
        const configuredDrawBorderWidth = Number(s.border_width);
        const borderW = Number.isFinite(configuredDrawBorderWidth)
            ? Math.max(0, configuredDrawBorderWidth)
            : (s.use_stroke === false ? 0 : 3);
        const useStroke = s.use_stroke !== false;
        const shadowBlur = s.shadow_blur || 0;
        const shadowOffX = s.shadow_offset_x || 0;
        const shadowOffY = s.shadow_offset_y || 0;
        const shadowColor = s.color_shadow || '#000000';
        const shadowAlpha = (s.opacity_shadow || 150) / 255;
        const useUnderline = s.use_underline || false;
        const underlineColor = s.color_underline || '#FFD700';

        let startY;
        if (advEnabled) {
            const advValign = (s.advanced_textbox_valign || 'center').toLowerCase();
            if (advValign === 'top') {
                startY = advY;
            } else if (advValign === 'bottom') {
                startY = advY + advH - totalH;
            } else { // center
                startY = cy - totalH / 2;
            }
        } else {
            startY = cy - totalH / 2;
        }

        let wordCounter = 0;
        let twCharCounter = 0;
        let animCharCounter = 0;
        const totalAnimChars = isExtendedCharAnim
            ? visibleLines.reduce((sum, ln) => sum + ln.split(/\s+/).filter(Boolean).reduce((c, w) => c + Array.from(w).length, 0), 0)
            : 0;
        const activeHighlightIdx = highlightEnabled ? activeSpokenIdx : -1;

        for (let i = 0; i < visibleLines.length; i++) {
            const line = visibleLines[i];
            const lineW = lineWidths[i];
            const lineScale = lineScales[i] || 1.0;
            const lineHScaled = lineH * lineScale;
            const scaledLineW = lineW * lineScale;
            const hasCustomLineScale = Math.abs(lineScale - 1.0) > 0.001;

            // Text alignment — 使用最终行宽（所有词展开后）来锚定位置，避免逐词弹出时偏移
            const anchorLineW = (finalLineWidths[i] != null && (hasCustomLineScale || finalLineWidths[i] > lineW))
                ? finalLineWidths[i] : scaledLineW;
            const effectiveLineW = (actualLineWidths[i] != null && (hasCustomLineScale || actualLineWidths[i] > lineW))
                ? actualLineWidths[i] : scaledLineW;
            const lineAlignMode = resolveLineAlignMode(i);
            const xStart = computeAlignedLineX(i, lineAlignMode === 'right' ? effectiveLineW : anchorLineW);

            const y = startY + (lineTextTopOffsets[i] || 0);
            const lineGradBounds = {
                x: xStart,
                y,
                w: Math.max(1, effectiveLineW || anchorLineW || lineW),
                h: Math.max(1, lineHScaled),
            };

            // Bullet reveal: per-line alpha
            let lineAlpha = 1.0;
            if (anim && isBullet) {
                lineAlpha = anim.computeBulletRevealLineAlpha(
                    currentTime, segStart, segEnd, i, visibleLines.length,
                    s.bullet_stagger || 0.15
                );
                if (lineAlpha < 0.01) {
                    const lineWords = line.split(/\s+/);
                    wordCounter += lineWords.length;
                    continue;
                }
            }

            const lineWords = line.split(/\s+/).filter(Boolean);
            let currX = textDirection === 'rtl' ? xStart + effectiveLineW : xStart;

            for (const wordStr of lineWords) {
                const wordW = this._measureTextWithSpacing(ctx, wordStr, letterSpacing);
                const baseSpaceW = ctx.measureText(' ').width + wordSpacing;

                // Current word timing & highlight
                wordCounter++;
                const wordIdx = wordCounter - 1;
                const wt = resolvedWordTimings[wordIdx] || {
                    start: segStart + segDur * (wordIdx / totalWordCount),
                    end: segStart + segDur * ((wordIdx + 1) / totalWordCount),
                };
                const wordStart = wt.start;
                const wordEnd = wt.end;

                let isActiveSpoken = false;
                if (activeSpokenIdx >= 0) {
                    if (wordPopGroups) {
                        const activeTiming = resolvedWordTimings[activeSpokenIdx];
                        isActiveSpoken = activeTiming != null
                            && Math.abs(wordStart - activeTiming.start) < 1e-6
                            && Math.abs(wordEnd - activeTiming.end) < 1e-6;
                    } else {
                        isActiveSpoken = wordIdx === activeSpokenIdx;
                    }
                }
                const isHighlight = highlightEnabled && isActiveSpoken;
                const isHighlightZoom = highlightScaleEnabled && isActiveSpoken;

                let allocScale = 1.0;
                if (isWordPopRandom) {
                    allocScale = this._computeWordRandomFinalScale(
                        wordIdx, segStart, wordStart,
                        Number(s.word_pop_random_min_scale ?? 0.7),
                        Number(s.word_pop_random_max_scale ?? 1.34)
                    );
                } else if (isWordPopRandomPulse) {
                    const pMax = Number(s.word_pop_random_pulse_max_scale ?? 1.40);
                    allocScale = Math.max(1.0, pMax * 0.85);
                } else if (isLetterJump) {
                    const ljScale = Number(s.letter_jump_scale ?? 1.5);
                    if (ljScale > 1.0) allocScale = ljScale;
                }

                const slotW = wordW * lineScale * allocScale;
                const slotX = textDirection === 'rtl' ? currX - slotW : currX;

                const isWordActive = !s.only_show_active_word || (currentTime == null || (currentTime >= wordStart && (wordIdx === totalWordCount - 1 ? currentTime <= wordEnd : currentTime < wordEnd)));
                const wordCenterX = s.only_show_active_word ? cx : (slotX + slotW / 2);
                const drawX = wordCenterX - (wordW * lineScale) / 2;
                const textDrawX = wordCenterX - wordW / 2;

                const wordCenterY = y + lineHScaled / 2;
                let wordY = y;

                // Word Pop 会在绘制阶段放大当前词。色块也必须采用相同
                // 缩放，否则文字回弹时会跑出色块，或看起来整体错位。
                let dynamicWordScale = 1.0;
                if (anim && (isWordPopRandom || isWordPopRandomPulse) && currentTime >= wordStart) {
                    if (isWordPopRandomPulse && typeof anim.computeWordRandomPulseScale === 'function') {
                        dynamicWordScale = anim.computeWordRandomPulseScale(
                            currentTime, wordStart, wordEnd, wordIdx, segStart,
                            Number(s.word_pop_random_pulse_min_scale ?? 1.08),
                            Number(s.word_pop_random_pulse_max_scale ?? 1.38),
                            Number(s.word_pop_random_pulse_duration ?? 0.22)
                        );
                    } else {
                        dynamicWordScale = anim.computeWordRandomPopScale(
                            currentTime, wordStart, wordEnd, wordIdx, segStart,
                            Number(s.word_pop_random_min_scale ?? 0.7),
                            Number(s.word_pop_random_max_scale ?? 1.34),
                            Number(s.word_pop_random_duration ?? 0.22)
                        );
                    }
                }

                // Metronome visibility
                let metroVisible = true;
                if (anim && isMetronome) {
                    metroVisible = anim.computeMetronomeWordVisible(
                        currentTime, segStart, segEnd,
                        wordIdx, totalWordCount,
                        s.metronome_bpm || 120
                    );
                }

                // ── Dynamic highlight box ──
                if (isActiveSpoken && s.dynamic_box && isWordActive) {
                    const dynPad = s.high_padding || 4;
                    const dynOffY = s.high_offset_y || 0;
                    const effectiveBoxScale = dynamicWordScale * (isHighlightZoom ? highlightScaleFactor : 1.0);
                    let boxX = drawX - dynPad * effectiveBoxScale;
                    let boxY = y - dynPad * effectiveBoxScale + dynOffY;
                    let boxW = (wordW * lineScale + dynPad * 2) * effectiveBoxScale;
                    let boxH = (lineHScaled + dynPad * 2) * effectiveBoxScale;
                    if (effectiveBoxScale !== 1.0) {
                        boxX = wordCenterX - boxW / 2;
                        boxY = wordCenterY - boxH / 2 + dynOffY;
                    }

                    if (s.dyn_box_anim && anim) {
                        const dscale = anim.computeDynBoxScale(
                            currentTime, wordStart, wordEnd,
                            s.dyn_box_anim_overshoot || 1.3, s.dyn_box_anim_duration || 0.15
                        );
                        if (Math.abs(dscale - 1.0) > 0.01) {
                            const dbCx = boxX + boxW / 2;
                            const dbCy = boxY + boxH / 2;
                            boxX = dbCx - (boxW * dscale) / 2;
                            boxY = dbCy - (boxH * dscale) / 2;
                            boxW *= dscale;
                            boxH *= dscale;
                        }
                    }

                    ctx.save();
                    const dynColor = s.color_high_bg || '#FFD700';
                    const dynAlpha = (s.opacity_high_bg || 200) / 255;
                    ctx.globalAlpha = globalAlpha * dynAlpha * lineAlpha;
                    const dynRad = s.dynamic_radius || 6;
                    this._roundRect(ctx, boxX, boxY, boxW, boxH, dynRad);
                    if (s.dynamic_box_stroke) {
                        ctx.strokeStyle = dynColor;
                        ctx.lineWidth = s.dynamic_box_stroke_width || 2;
                        ctx.stroke();
                    } else {
                        ctx.fillStyle = dynColor;
                        ctx.fill();
                    }
                    ctx.restore();
                }

                // ── Letter jump scale ──
                let letterJumpScale = 1.0;
                if (anim && isLetterJump && isHighlight) {
                    letterJumpScale = anim.computeLetterJumpScale(
                        currentTime, wordStart, wordEnd,
                        s.letter_jump_scale || 1.5, s.letter_jump_duration || 0.2
                    );
                }

                let wordOpacity = lineAlpha;
                if (s.only_show_active_word && currentTime != null && (currentTime < wordStart || currentTime > wordEnd)) {
                    wordOpacity = 0.0;
                } else if ((s.ambient_glow_enabled || style?._ambient_text_final_pass)
                    && currentTime != null && currentTime < wordStart) {
                    wordOpacity = 0.0;
                } else if (hideUntilSpoken && currentTime != null && currentTime < wordStart && !isActiveSpoken) {
                    wordOpacity *= unreadOpacityFactor;
                }
                let wordColor = isHighlight ? highColor : textColor;
                let wordStrokeColor = outlineColor;
                let typewriterPartial = null;
                let zoomTwActivePop = null;

                if (isTypewriter) {
                    const chars = Array.from(wordStr);
                    const wordUnits = typewriterRevealType === 'char' ? chars.length : 1;
                    const wordStartCharIdx = twCharCounter;
                    const revealedUnits = twRevealedCount < 0 ? wordUnits
                        : Math.max(0, Math.min(wordUnits, twRevealedCount - twCharCounter));
                    if (twRevealedCount >= 0) {
                        if (revealedUnits === 0) {
                            wordColor = s.tw_unrevealed_color || '#808080';
                            wordStrokeColor = s.tw_unrevealed_stroke_color || '#404040';
                            wordOpacity *= twUnreadOpacity;
                        } else {
                            // Do not override the user's normal text/stroke
                            // settings with the legacy typewriter defaults.
                            wordColor = isHighlight ? highColor : (s.tw_revealed_color || textColor);
                            wordStrokeColor = s.tw_revealed_stroke_color || outlineColor;
                        }
                        if (isZoomTypewriter && zoomTwState && revealedUnits > 0 &&
                            zoomTwState.activeCharIdx === (wordStartCharIdx + revealedUnits - 1) &&
                            zoomTwState.activeCharProgress < 0.999) {
                            zoomTwActivePop = {
                                prefix: chars.slice(0, revealedUnits - 1).join(''),
                                activeChar: chars[revealedUnits - 1] || '',
                                progress: zoomTwState.activeCharProgress,
                            };
                        } else if (typewriterRevealType === 'char' && revealedUnits > 0 && revealedUnits < wordUnits) {
                            typewriterPartial = {
                                revealed: chars.slice(0, revealedUnits).join(''),
                                unrevealed: chars.slice(revealedUnits).join(''),
                            };
                        }
                    }
                    twCharCounter += wordUnits;
                }

                if (isMetronome) {
                    if (metroVisible) {
                        wordColor = isHighlight ? highColor : (s.metro_read_color || textColor);
                        wordStrokeColor = s.metro_read_stroke_color || outlineColor;
                    } else {
                        wordColor = s.metro_unread_color || '#808080';
                        wordStrokeColor = s.metro_unread_stroke_color || '#404040';
                        // 0 是用户有效设置（完全隐藏未读字），不能用 || 回退到 100。
                        const metroUnreadOpacity = s.metro_unread_opacity ?? 100;
                        wordOpacity *= Math.max(0, Math.min(1, Number(metroUnreadOpacity) / 255));
                    }
                }

                // ── Word pop random (逐词弹出+随机大小) ──
                let randomPopScale = 1.0;
                if (anim && (isWordPopRandom || isWordPopRandomPulse)) {
                    const unreadOpacity = Math.max(0, Math.min(1, Number(s.word_pop_random_unread_opacity ?? 0.0)));
                    const readOpacity = Math.max(0, Math.min(1, Number(s.word_pop_random_read_opacity ?? 1.0)));
                    if (currentTime < wordStart) {
                        wordOpacity *= unreadOpacity;
                    } else {
                        wordOpacity *= readOpacity;
                    }

                    if (currentTime >= wordStart) {
                        randomPopScale = dynamicWordScale;
                    }
                }

                // ── Vertical offset for char bounce ──
                if (anim && isCharBounce) {
                    const bounceOff = anim.computeCharBounceOffset(
                        currentTime, wordIdx,
                        segStart, segDur, totalWordCount,
                        cbHeight, cbStagger
                    );
                    wordY = y + bounceOff;
                }

                // ── Bullet reveal alpha ──
                if (isBullet && lineAlpha < 0.999 && isWordActive) {
                    ctx.save();
                    ctx.globalAlpha = ctx.globalAlpha * lineAlpha;
                }

                // ── Holy glow around text ──
                if (isHolyGlow && !style?._ambient_text_final_pass && holyGlowRadius > 0 && isWordActive && wordOpacity > 0.001) {
                    ctx.save();
                    const glowColor = s.holy_glow_color || '#FFFFCC';
                    for (let gr = holyGlowRadius; gr > 0; gr--) {
                        const ga = (80 * holyGlowAlpha * (gr / holyGlowRadius) * 0.5) / 255;
                        ctx.globalAlpha = globalAlpha * wordOpacity * ga;
                        ctx.strokeStyle = glowColor;
                        ctx.lineWidth = gr * 2;
                        ctx.lineJoin = 'round';
                        if (letterSpacing > 0) {
                            this._strokeTextSpaced(ctx, wordStr, drawX, wordY, letterSpacing);
                        } else {
                            ctx.strokeText(wordStr, drawX, wordY);
                        }
                    }
                    ctx.restore();
                }

                // ── Render word ──
                if (isWordActive && wordOpacity > 0.001) {
                    const wordScale = letterJumpScale * randomPopScale * (isHighlightZoom ? highlightScaleFactor : 1.0);
                    const textDrawY = (wordCenterY - lineH / 2) + (wordY - y);

                    // ── Local multi-layer stroke expand ──
                    if (s.stroke_expand_enabled && needsPerWordStrokeExpand) {
                        ctx.save();
                        ctx.globalAlpha = globalAlpha * wordOpacity;
                        if (wordScale !== 1.0) {
                            ctx.translate(wordCenterX, wordCenterY);
                            ctx.scale(wordScale, wordScale);
                            ctx.translate(-wordCenterX, -wordCenterY);
                        }
                        if (lineScale !== 1.0) {
                            ctx.translate(wordCenterX, wordCenterY);
                            ctx.scale(lineScale, lineScale);
                            ctx.translate(-wordCenterX, -wordCenterY);
                        }
                        if (typewriterPartial) {
                            this._renderWordStrokeExpand(ctx, s, typewriterPartial.revealed, textDrawX, textDrawY, fontStr, letterSpacing);
                            const revealedW = this._measureTextWithSpacing(ctx, typewriterPartial.revealed, letterSpacing);
                            // The unread half needs its own opacity.  In
                            // particular, opacity 0 must hide both text and
                            // expanded outline.
                            if (twUnreadOpacity > 0.01) {
                                ctx.globalAlpha = globalAlpha * wordOpacity * twUnreadOpacity;
                                this._renderWordStrokeExpand(ctx, s, typewriterPartial.unrevealed, textDrawX + revealedW, textDrawY, fontStr, letterSpacing);
                            }
                        } else {
                            this._renderWordStrokeExpand(ctx, s, wordStr, textDrawX, textDrawY, fontStr, letterSpacing);
                        }
                        ctx.restore();
                    }

                    ctx.save();
                    ctx.globalAlpha = globalAlpha * wordOpacity;

                    // ── 调色级物理曝光提亮 (Exposure Dodge & Optical Luminescence) ──
                    if (s.ambient_glow_enabled && (currentTime == null || currentTime >= wordStart)) {
                        ctx.save();
                        const ambColor = s.ambient_glow_color || s.color_high || '#FFE600';
                        const rawRadius = Number(s.ambient_glow_radius) || 360;
                        const baseRadius = Math.max(60, rawRadius);
                        const wordAlpha = Math.max(0.1, Math.min(1.0, Number(s.ambient_glow_opacity ?? 0.55))) * animOpacity;
                        const blendOperation = getAmbientGlowCompositeOperation(s);

                        const hex = String(ambColor).replace('#', '');
                        const rVal = parseInt(hex.slice(0, 2), 16) || 255;
                        const gVal = parseInt(hex.slice(2, 4), 16) || 230;
                        const bVal = parseInt(hex.slice(4, 6), 16) || 120;

                        // ── Pass 1: 广域温和曝光减淡 ──
                        ctx.globalCompositeOperation = blendOperation;
                        const dodgeGrad = ctx.createRadialGradient(wordCenterX, wordCenterY, 0, wordCenterX, wordCenterY, baseRadius);
                        dodgeGrad.addColorStop(0, `rgba(${Math.round(rVal * 0.55)}, ${Math.round(gVal * 0.55)}, ${Math.round(bVal * 0.55)}, ${(wordAlpha * 0.48).toFixed(3)})`);
                        dodgeGrad.addColorStop(0.3, `rgba(${Math.round(rVal * 0.38)}, ${Math.round(gVal * 0.38)}, ${Math.round(bVal * 0.38)}, ${(wordAlpha * 0.32).toFixed(3)})`);
                        dodgeGrad.addColorStop(0.65, `rgba(${Math.round(rVal * 0.18)}, ${Math.round(gVal * 0.18)}, ${Math.round(bVal * 0.18)}, ${(wordAlpha * 0.12).toFixed(3)})`);
                        dodgeGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
                        ctx.fillStyle = dodgeGrad;
                        ctx.fillRect(wordCenterX - baseRadius, wordCenterY - baseRadius, baseRadius * 2, baseRadius * 2);

                        // ── Pass 2: 大范围暖调色温弥散 ──
                        ctx.globalCompositeOperation = blendOperation;
                        const toneRadius = baseRadius * 1.35;
                        const toneGrad = ctx.createRadialGradient(wordCenterX, wordCenterY, 0, wordCenterX, wordCenterY, toneRadius);
                        toneGrad.addColorStop(0, `rgba(${rVal}, ${gVal}, ${bVal}, ${(wordAlpha * 0.75).toFixed(3)})`);
                        toneGrad.addColorStop(0.45, `rgba(${rVal}, ${gVal}, ${bVal}, ${(wordAlpha * 0.38).toFixed(3)})`);
                        toneGrad.addColorStop(0.8, `rgba(${rVal}, ${gVal}, ${bVal}, ${(wordAlpha * 0.10).toFixed(3)})`);
                        toneGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
                        ctx.fillStyle = toneGrad;
                        ctx.fillRect(wordCenterX - toneRadius, wordCenterY - toneRadius, toneRadius * 2, toneRadius * 2);

                        // ── Pass 3: 柔美边缘光学微光 ──
                        ctx.globalCompositeOperation = blendOperation;
                        const screenRadius = baseRadius * 0.75;
                        const screenGrad = ctx.createRadialGradient(wordCenterX, wordCenterY, 0, wordCenterX, wordCenterY, screenRadius);
                        screenGrad.addColorStop(0, `rgba(${rVal}, ${gVal}, ${bVal}, ${(wordAlpha * 0.18).toFixed(3)})`);
                        screenGrad.addColorStop(0.5, `rgba(${rVal}, ${gVal}, ${bVal}, ${(wordAlpha * 0.06).toFixed(3)})`);
                        screenGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
                        ctx.fillStyle = screenGrad;
                        ctx.fillRect(wordCenterX - screenRadius, wordCenterY - screenRadius, screenRadius * 2, screenRadius * 2);

                        ctx.restore();
                    }

                    if (wordScale !== 1.0) {
                        ctx.translate(wordCenterX, wordCenterY);
                        ctx.scale(wordScale, wordScale);
                        ctx.translate(-wordCenterX, -wordCenterY);
                    }
                    if (lineScale !== 1.0) {
                        ctx.translate(wordCenterX, wordCenterY);
                        ctx.scale(lineScale, lineScale);
                        ctx.translate(-wordCenterX, -wordCenterY);
                    }

                    let currentShadowBlur = shadowBlur;
                    let currentShadowColor = shadowColor;
                    if (shadowColor && shadowColor.includes(',')) {
                        const shadowColors = shadowColor.split(',').map(c => c.trim());
                        currentShadowColor = isHighlight ? (shadowColors[1] || shadowColors[0]) : shadowColors[0];
                    }

                    const wordGradBounds = {
                        x: textDrawX,
                        y: textDrawY,
                        w: Math.max(1, wordW),
                        h: Math.max(1, fontSize * 0.95),
                    };
                    const activeGradBounds = (s.text_gradient_scope === 'word') ? wordGradBounds : lineGradBounds;

                    if (zoomTwActivePop) {
                        const revealedColor = s.tw_revealed_color || textColor;
                        const revealedStroke = s.tw_revealed_stroke_color || outlineColor;
                        let activeX = textDrawX;
                        if (zoomTwActivePop.prefix) {
                            this._drawWord(ctx, zoomTwActivePop.prefix, textDrawX, textDrawY, revealedColor,
                                useStroke && !s.stroke_expand_enabled, revealedStroke, borderW, outlineAlpha,
                                currentShadowBlur, shadowOffX, shadowOffY, currentShadowColor, shadowAlpha, letterSpacing, s, activeGradBounds);
                            activeX += this._measureTextWithSpacing(ctx, zoomTwActivePop.prefix, letterSpacing);
                        }
                        if (zoomTwActivePop.activeChar) {
                            const chW = this._measureTextWithSpacing(ctx, zoomTwActivePop.activeChar, letterSpacing);
                            const chCx = activeX + chW / 2;
                            const chCy = textDrawY + fontSize * 0.55;
                            const p = zoomTwActivePop.progress;
                            const chScale = 0.72 + 0.28 * p;
                            const chDy = (1 - p) * fontSize * 0.08;
                            ctx.save();
                            ctx.translate(chCx, chCy + chDy);
                            ctx.scale(chScale, chScale);
                            ctx.translate(-chCx, -chCy);
                            this._drawWord(ctx, zoomTwActivePop.activeChar, activeX, textDrawY, revealedColor,
                                useStroke && !s.stroke_expand_enabled, revealedStroke, borderW, outlineAlpha,
                                currentShadowBlur, shadowOffX, shadowOffY, currentShadowColor, shadowAlpha, letterSpacing, s, activeGradBounds);
                            ctx.restore();
                        }
                    } else if (typewriterPartial) {
                        const revealedColor = s.tw_revealed_color || textColor;
                        const revealedStroke = s.tw_revealed_stroke_color || outlineColor;
                        const unrevealedColor = s.tw_unrevealed_color || '#808080';
                        const unrevealedStroke = s.tw_unrevealed_stroke_color || '#404040';
                        const revealedW = this._measureTextWithSpacing(ctx, typewriterPartial.revealed, letterSpacing);
                        this._drawWord(ctx, typewriterPartial.revealed, textDrawX, textDrawY, revealedColor,
                            useStroke && !s.stroke_expand_enabled, revealedStroke, borderW, outlineAlpha,
                            currentShadowBlur, shadowOffX, shadowOffY, currentShadowColor, shadowAlpha, letterSpacing, s, activeGradBounds);
                        if (twUnreadOpacity > 0.001) {
                            ctx.globalAlpha = globalAlpha * wordOpacity * twUnreadOpacity;
                            this._drawWord(ctx, typewriterPartial.unrevealed, textDrawX + revealedW, textDrawY, unrevealedColor,
                                useStroke && !s.stroke_expand_enabled, unrevealedStroke, borderW, outlineAlpha,
                                currentShadowBlur, shadowOffX, shadowOffY, currentShadowColor, shadowAlpha, letterSpacing, s, activeGradBounds);
                        }
                    } else if (isExtendedCharAnim && anim) {
                        const chars = Array.from(wordStr);
                        let charX = textDrawX;
                        const charAnimOpts = {
                            intensity: s.char_anim_intensity ?? 1.0,
                            duration: s.char_anim_duration ?? 0.28,
                            stagger: s.char_anim_stagger ?? 0.04,
                            fontSize,
                        };
                        for (let ci = 0; ci < chars.length; ci++) {
                            const ch = chars[ci];
                            const chW = ctx.measureText(ch).width;
                            const tf = anim.computeCharAnimTransform(
                                animInType,
                                currentTime,
                                animCharCounter,
                                totalAnimChars,
                                segStart,
                                segEnd,
                                charAnimOpts
                            );
                            animCharCounter++;
                            if (tf.alpha > 0.005) {
                                ctx.save();
                                ctx.globalAlpha *= tf.alpha;
                                const chCx = charX + chW / 2;
                                const chCy = textDrawY + fontSize * 0.55;
                                if (tf.dx !== 0 || tf.dy !== 0) {
                                    ctx.translate(tf.dx, tf.dy);
                                }
                                if (Math.abs(tf.scaleX - 1) > 0.001 || Math.abs(tf.scaleY - 1) > 0.001) {
                                    ctx.translate(chCx, chCy);
                                    ctx.scale(tf.scaleX, tf.scaleY);
                                    ctx.translate(-chCx, -chCy);
                                }
                                this._drawWord(ctx, ch, charX, textDrawY, wordColor,
                                    useStroke && !s.stroke_expand_enabled, wordStrokeColor, borderW, outlineAlpha,
                                    currentShadowBlur, shadowOffX, shadowOffY, currentShadowColor, shadowAlpha, 0, s, activeGradBounds);
                                ctx.restore();
                            }
                            charX += chW + letterSpacing;
                        }
                    } else {
                        const punctMatch = (isHighlight && wordColor !== textColor && textDirection !== 'rtl')
                            ? wordStr.match(/^(.+?)([,.:;!?，。：；！？]+)$/)
                            : null;
                        if (punctMatch) {
                            const [, corePart, punctPart] = punctMatch;
                            const coreW = this._measureTextWithSpacing(ctx, corePart, letterSpacing);
                            this._drawWord(ctx, corePart, textDrawX, textDrawY, wordColor,
                                useStroke && !s.stroke_expand_enabled, wordStrokeColor, borderW, outlineAlpha,
                                currentShadowBlur, shadowOffX, shadowOffY, currentShadowColor, shadowAlpha, letterSpacing, s, activeGradBounds);
                            this._drawWord(ctx, punctPart, textDrawX + coreW, textDrawY, textColor,
                                useStroke && !s.stroke_expand_enabled, wordStrokeColor, borderW, outlineAlpha,
                                currentShadowBlur, shadowOffX, shadowOffY, currentShadowColor, shadowAlpha, letterSpacing, s, activeGradBounds);
                        } else {
                            this._drawWord(ctx, wordStr, textDrawX, textDrawY, wordColor,
                                useStroke && !s.stroke_expand_enabled, wordStrokeColor, borderW, outlineAlpha,
                                currentShadowBlur, shadowOffX, shadowOffY, currentShadowColor, shadowAlpha, letterSpacing, s, activeGradBounds);
                        }
                    }
                    ctx.restore();
                } else if (isExtendedCharAnim) {
                    animCharCounter += Array.from(wordStr).length;
                }

                // Bullet restore
                if (isBullet && lineAlpha < 0.999 && isWordActive) ctx.restore();

                // Underline
                if (((isHighlight && useUnderline) || (useUnderline && s.underline_all)) && isWordActive) {
                    ctx.save();
                    ctx.globalAlpha = globalAlpha * lineAlpha;
                    ctx.strokeStyle = underlineColor;
                    ctx.lineWidth = Math.max(2, fontSize * 0.04) * lineScale;
                    ctx.beginPath();
                    const underlineY = wordY + lineHScaled + 2;
                    ctx.moveTo(drawX, underlineY);
                    ctx.lineTo(drawX + wordW * lineScale, underlineY);
                    ctx.stroke();
                    ctx.restore();
                }

                const randomGapW = this._computeRandomWordSpacing(s, wordIdx, segStart, wordStart);
                const advanceW = slotW + (safeBaseSpaceW_ + randomGapW) * lineScale;
                currX += textDirection === 'rtl' ? -advanceW : advanceW;
            }
        }

        // ── Blur → Sharp post-process ──
        if (blurRadius > 0) {
            ctx.filter = 'none';
        }

        // Restore advanced textbox clip
        if (advEnabled) ctx.restore();

        ctx.restore();

        // 同一段内后出现单词的环境光可能覆盖先画出的字。再绘制一遍没有
        // 环境光的文字层，使所有光只作用于背景、文字始终位于合成最顶层。
        if (s.ambient_glow_enabled && !style?._ambient_text_final_pass) {
            this.renderSubtitle({ ...s, ambient_glow_enabled: false, _ambient_text_final_pass: true },
                segment, currentTime, videoW, videoH, true);
        }
    }

    // ─── Non-destructive uppercase transform ───
    _applyTextTransform(str, s) {
        const raw = String(str ?? '');
        if (!raw || !s) return raw;
        if (s.uppercase === true || String(s.text_transform || '').toLowerCase() === 'uppercase') {
            return raw.toUpperCase();
        }
        return raw;
    }

    // ─── Connected adaptive multi-line background contour with concave fillets & width snapping ───
    _buildConnectedAdaptiveBoxPath(ctx, rawSlabs, outerRadius = 8, concaveRadius = 10, snapThreshold = 18) {
        const slabs = rawSlabs.map(s => ({
            left: Number(s.left) || 0,
            right: Number(s.right) || 0,
            top: Number(s.top) || 0,
            bottom: Number(s.bottom) || 0,
        }));
        const N = slabs.length;
        if (N === 0) return;

        // 1. 相邻行宽度接近时自动对齐，避免产生微小台阶和小凸角
        const thr = Math.max(0, Number(snapThreshold) || 0);
        if (thr > 0) {
            for (let pass = 0; pass < 2; pass++) {
                for (let i = 0; i < N - 1; i++) {
                    const dl = Math.abs(slabs[i].left - slabs[i + 1].left);
                    if (dl > 0 && dl <= thr) {
                        const minL = Math.min(slabs[i].left, slabs[i + 1].left);
                        slabs[i].left = minL;
                        slabs[i + 1].left = minL;
                    }
                    const dr = Math.abs(slabs[i].right - slabs[i + 1].right);
                    if (dr > 0 && dr <= thr) {
                        const maxR = Math.max(slabs[i].right, slabs[i + 1].right);
                        slabs[i].right = maxR;
                        slabs[i + 1].right = maxR;
                    }
                }
            }
        }

        // 2. 相邻行垂直缝隙桥接，形成连续无断缝的上下边界
        for (let i = 0; i < N - 1; i++) {
            const seamY = (slabs[i].bottom + slabs[i + 1].top) / 2;
            slabs[i].bottom = seamY;
            slabs[i + 1].top = seamY;
        }

        // 3. 按顺时针顺序提取正交多边形顶点
        const rawPts = [];
        const pushPt = (x, y) => {
            if (rawPts.length > 0) {
                const prev = rawPts[rawPts.length - 1];
                if (Math.hypot(x - prev.x, y - prev.y) < 0.5) return;
            }
            rawPts.push({ x, y });
        };

        pushPt(slabs[0].left, slabs[0].top);
        pushPt(slabs[0].right, slabs[0].top);
        for (let i = 0; i < N; i++) {
            pushPt(slabs[i].right, slabs[i].bottom);
            if (i < N - 1 && Math.abs(slabs[i + 1].right - slabs[i].right) >= 0.5) {
                pushPt(slabs[i + 1].right, slabs[i].bottom);
            }
        }
        pushPt(slabs[N - 1].left, slabs[N - 1].bottom);
        for (let i = N - 1; i >= 0; i--) {
            pushPt(slabs[i].left, slabs[i].top);
            if (i > 0 && Math.abs(slabs[i - 1].left - slabs[i].left) >= 0.5) {
                pushPt(slabs[i - 1].left, slabs[i].top);
            }
        }
        if (rawPts.length > 1) {
            const first = rawPts[0];
            const last = rawPts[rawPts.length - 1];
            if (Math.hypot(first.x - last.x, first.y - last.y) < 0.5) {
                rawPts.pop();
            }
        }

        // 移除共线冗余点
        const pts = [];
        const M = rawPts.length;
        for (let i = 0; i < M; i++) {
            const prev = rawPts[(i - 1 + M) % M];
            const curr = rawPts[i];
            const next = rawPts[(i + 1) % M];
            const v1x = curr.x - prev.x, v1y = curr.y - prev.y;
            const v2x = next.x - curr.x, v2y = next.y - curr.y;
            const cross = v1x * v2y - v1y * v2x;
            if (Math.abs(cross) > 0.01) {
                pts.push(curr);
            }
        }

        const K = pts.length;
        if (K < 3) return;

        const outR = Math.max(0, Number(outerRadius) || 0);
        const inR = Math.max(0, Number(concaveRadius) || 0);

        // 从第一条边的中点开始，使用 arcTo 绘制外圆角与内凹圆角
        const mid0 = {
            x: (pts[K - 1].x + pts[0].x) / 2,
            y: (pts[K - 1].y + pts[0].y) / 2,
        };
        ctx.moveTo(mid0.x, mid0.y);
        for (let i = 0; i < K; i++) {
            const prev = pts[(i - 1 + K) % K];
            const curr = pts[i];
            const next = pts[(i + 1) % K];
            const v1x = curr.x - prev.x, v1y = curr.y - prev.y;
            const v2x = next.x - curr.x, v2y = next.y - curr.y;
            const len1 = Math.hypot(v1x, v1y);
            const len2 = Math.hypot(v2x, v2y);
            const cross = v1x * v2y - v1y * v2x;
            // 屏幕坐标系顺时针多边形：cross > 0 为外凸角，cross < 0 为内凹角
            const targetR = cross >= 0 ? outR : inR;
            const r = Math.max(0, Math.min(targetR, len1 / 2, len2 / 2));
            if (r > 0.25) {
                ctx.arcTo(curr.x, curr.y, next.x, next.y, r);
            } else {
                ctx.lineTo(curr.x, curr.y);
            }
        }
        ctx.closePath();
    }

    // ─── Advanced textbox background ───
    _drawAdvTextboxBg(ctx, s, x, y, w, h) {
        ctx.save();
        const bgColor = s.adv_bg_color || '#000000';
        const bgAlpha = (s.adv_bg_opacity || 150) / 255;
        ctx.globalAlpha = ctx.globalAlpha * bgAlpha;
        const rad = s.adv_bg_radius || 8;
        const ox = s.adv_bg_offset_x || 0;
        const oy = s.adv_bg_offset_y || 0;
        const bw = s.adv_bg_w || w;
        const bh = s.adv_bg_h || h;

        if (s.adv_bg_gradient_enabled) {
            const colors = typeof s.adv_bg_gradient_colors === 'string'
                ? s.adv_bg_gradient_colors.split(',').map(c => c.trim())
                : (Array.isArray(s.adv_bg_gradient_colors) ? s.adv_bg_gradient_colors : [bgColor, '#333']);
            if (colors.length >= 2) {
                const gradType = s.adv_bg_gradient_type || 'linear_h';
                let grad;
                if (gradType === 'linear_v') {
                    grad = ctx.createLinearGradient(x + ox, y + oy, x + ox, y + oy + bh);
                } else if (gradType === 'center') {
                    grad = ctx.createRadialGradient(x + ox + bw / 2, y + oy + bh / 2, 0,
                        x + ox + bw / 2, y + oy + bh / 2, Math.max(bw, bh) / 2);
                } else {
                    grad = ctx.createLinearGradient(x + ox, y + oy, x + ox + bw, y + oy);
                }
                colors.forEach((c, i) => grad.addColorStop(i / Math.max(1, colors.length - 1), c));
                ctx.fillStyle = grad;
            } else {
                ctx.fillStyle = bgColor;
            }
        } else {
            ctx.fillStyle = bgColor;
        }

        this._roundRect(ctx, x + ox, y + oy, bw, bh, rad);
        ctx.fill();

        if (s.adv_bg_gradient_highlight) {
            const hlGrad = ctx.createLinearGradient(x + ox, y + oy, x + ox, y + oy + bh * 0.3);
            hlGrad.addColorStop(0, 'rgba(255,255,255,0.24)');
            hlGrad.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = hlGrad;
            this._roundRect(ctx, x + ox, y + oy, bw, bh, rad);
            ctx.fill();
        }
        ctx.restore();
    }

    // ─── Independent outline/glow controls ───
    _resolveStrokeExpandLayerMetrics(s, li, seLayers = 3, seStep = 4, seFeather = 8, seLayerWidths = s?.stroke_expand_layer_widths || [], seLayerFeathers = s?.stroke_expand_layer_feathers || []) {
        const fallbackWidth = Number.isFinite(parseFloat(seLayerWidths[li]))
            ? parseFloat(seLayerWidths[li])
            : seStep * (li + 1);
        const fallbackFeather = Number.isFinite(parseFloat(seLayerFeathers[li]))
            ? parseFloat(seLayerFeathers[li])
            : seFeather;
        const controlsEnabled = s.effect_controls_enabled === true || s.effect_controls_enabled === 1 || s.effect_controls_enabled === 'true';
        if (!controlsEnabled) return { width: fallbackWidth, feather: fallbackFeather };

        const parseOr = (value, fallback) => {
            const parsed = parseFloat(value);
            return Number.isFinite(parsed) ? parsed : fallback;
        };
        const innerWidth = Math.max(0, parseOr(s.effect_inner_outline_width, 5));
        const glowRange = Math.max(innerWidth, parseOr(s.effect_glow_range, 22));
        const glowBlur = Math.max(0, parseOr(s.effect_glow_blur, 18));

        if (seLayers <= 1 || li === 0) {
            return { width: innerWidth, feather: Math.min(2, glowBlur * 0.11) };
        }
        if (li === seLayers - 1) {
            return { width: glowRange + innerWidth * 1.6, feather: glowBlur * 0.9 };
        }

        const lastGlowLayer = Math.max(1, seLayers - 2);
        const progress = Math.min(1, li / lastGlowLayer);
        return {
            width: innerWidth + (glowRange - innerWidth) * progress,
            feather: glowBlur * progress,
        };
    }

    _resolveStrokeExpandLayerOpacity(s, li) {
        const controlsEnabled = s.effect_controls_enabled === true || s.effect_controls_enabled === 1 || s.effect_controls_enabled === 'true';
        if (!controlsEnabled || li === 0) return 1;
        const parsed = parseFloat(s.effect_glow_opacity);
        const percent = Number.isFinite(parsed) ? parsed : 70;
        return Math.max(0, Math.min(1, percent / 100));
    }

    // ─── Multi-layer stroke expand ───
    _renderStrokeExpand(ctx, s, lines, lineWidths, cx, advEnabled, advAlign, advX, advW,
        cy, totalH, lineStep, fontStr, fontSize, letterSpacing, advY, advH, computeAlignedLineX = null) {
        const seLayers = parseInt(s.stroke_expand_layers) || 3;
        const seStep = parseFloat(s.stroke_expand_step) || 4;
        const seFeather = parseFloat(s.stroke_expand_feather) || 8;
        const seColorsStr = typeof s.stroke_expand_colors === 'string'
            ? s.stroke_expand_colors : (Array.isArray(s.stroke_expand_colors) ? s.stroke_expand_colors.join(',') : '#FF0000,#00FF00,#0000FF');
        const seColors = seColorsStr.split(',').map(c => c.trim()).filter(Boolean);
        const seLayerWidths = s.stroke_expand_layer_widths || [];
        const seLayerFeathers = s.stroke_expand_layer_feathers || [];

        let startY;
        if (advEnabled) {
            const advValign = (s.advanced_textbox_valign || 'center').toLowerCase();
            if (advValign === 'top') {
                startY = advY;
            } else if (advValign === 'bottom') {
                startY = advY + advH - totalH;
            } else {
                startY = cy - totalH / 2;
            }
        } else {
            startY = cy - totalH / 2;
        }

        ctx.save();
        ctx.font = fontStr;
        ctx.textBaseline = 'top';

        // Draw layers from outermost to innermost
        for (let li = seLayers - 1; li >= 0; li--) {
            const metrics = this._resolveStrokeExpandLayerMetrics(
                s, li, seLayers, seStep, seFeather, seLayerWidths, seLayerFeathers
            );
            const lw = metrics.width;
            const lf = metrics.feather;
            const color = li < seColors.length ? seColors[li] : seColors[seColors.length - 1] || '#000000';
            const layerOpacity = this._resolveStrokeExpandLayerOpacity(s, li);

            if (lf > 0) {
                // Feathered stroke: multiple passes with decreasing alpha
                const featherSteps = Math.min(8, Math.max(3, Math.floor(lf)));
                for (let fi = featherSteps; fi >= 0; fi--) {
                    const t = fi / featherSteps;
                    const expandW = lw + lf * t;
                    const alpha = Math.exp(-((t * 2.5) ** 2));
                    ctx.save();
                    ctx.globalAlpha = ctx.globalAlpha * alpha * 0.4 * layerOpacity;
                    ctx.strokeStyle = color;
                    ctx.lineWidth = expandW * 2;
                    ctx.lineJoin = 'round';
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        const lineW = lineWidths[i];
                        let xS;
                        if (typeof computeAlignedLineX === 'function') xS = computeAlignedLineX(i, lineW);
                        else if (advEnabled && advAlign === 'left') xS = advX;
                        else if (advEnabled && advAlign === 'right') xS = advX + advW - lineW;
                        else xS = cx - lineW / 2;
                        const yS = startY + i * lineStep;
                        ctx.strokeText(line, xS, yS);
                    }
                    ctx.restore();
                }
            } else {
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * layerOpacity;
                ctx.strokeStyle = color;
                ctx.lineWidth = lw * 2;
                ctx.lineJoin = 'round';
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const lineW = lineWidths[i];
                    let xS;
                    if (typeof computeAlignedLineX === 'function') xS = computeAlignedLineX(i, lineW);
                    else if (advEnabled && advAlign === 'left') xS = advX;
                    else if (advEnabled && advAlign === 'right') xS = advX + advW - lineW;
                    else xS = cx - lineW / 2;
                    const yS = startY + i * lineStep;
                    ctx.strokeText(line, xS, yS);
                }
                ctx.restore();
            }
        }
        ctx.restore();
    }

    // ─── Single word stroke expand (for only_show_active_word) ───
    _renderWordStrokeExpand(ctx, s, wordStr, x, y, fontStr, letterSpacing) {
        const seLayers = parseInt(s.stroke_expand_layers) || 3;
        const seStep = parseFloat(s.stroke_expand_step) || 4;
        const seFeather = parseFloat(s.stroke_expand_feather) || 8;
        const seColorsStr = typeof s.stroke_expand_colors === 'string'
            ? s.stroke_expand_colors : (Array.isArray(s.stroke_expand_colors) ? s.stroke_expand_colors.join(',') : '#FF0000,#00FF00,#0000FF');
        const seColors = seColorsStr.split(',').map(c => c.trim()).filter(Boolean);
        const seLayerWidths = s.stroke_expand_layer_widths || [];
        const seLayerFeathers = s.stroke_expand_layer_feathers || [];

        ctx.save();
        ctx.font = fontStr;
        ctx.textBaseline = 'top';

        for (let li = seLayers - 1; li >= 0; li--) {
            const metrics = this._resolveStrokeExpandLayerMetrics(
                s, li, seLayers, seStep, seFeather, seLayerWidths, seLayerFeathers
            );
            const lw = metrics.width;
            const lf = metrics.feather;
            const color = li < seColors.length ? seColors[li] : seColors[seColors.length - 1] || '#000000';
            const layerOpacity = this._resolveStrokeExpandLayerOpacity(s, li);

            if (lf > 0) {
                const featherSteps = Math.min(8, Math.max(3, Math.floor(lf)));
                for (let fi = featherSteps; fi >= 0; fi--) {
                    const t = fi / featherSteps;
                    const expandW = lw + lf * t;
                    const alpha = Math.exp(-((t * 2.5) ** 2));
                    ctx.save();
                    ctx.globalAlpha = ctx.globalAlpha * alpha * 0.4 * layerOpacity;
                    ctx.strokeStyle = color;
                    ctx.lineWidth = expandW * 2;
                    ctx.lineJoin = 'round';
                    if (letterSpacing > 0) {
                        this._strokeTextSpaced(ctx, wordStr, x, y, letterSpacing);
                    } else {
                        ctx.strokeText(wordStr, x, y);
                    }
                    ctx.restore();
                }
            } else {
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * layerOpacity;
                ctx.strokeStyle = color;
                ctx.lineWidth = lw * 2;
                ctx.lineJoin = 'round';
                if (letterSpacing > 0) {
                    this._strokeTextSpaced(ctx, wordStr, x, y, letterSpacing);
                } else {
                    ctx.strokeText(wordStr, x, y);
                }
                ctx.restore();
            }
        }
        ctx.restore();
    }

    // ─── Helper: draw word with optional letter spacing ───
    _drawWord(ctx, text, x, y, fillColor,
        useStroke, strokeColor, strokeWidth, strokeAlpha,
        shadowBlur, shadowOffX, shadowOffY, shadowColor, shadowAlpha, letterSpacing = 0, s = null, gradBounds = null) {

        // Speed Trail (motion blur / speed lines)
        if (s && s.speed_trail_enabled) {
            ctx.save();
            const layers = s.speed_trail_layers ?? 5;
            const step = s.speed_trail_step ?? -8;
            const trailColor = s.speed_trail_color || '#FFFFFF';
            const baseAlpha = (s.speed_trail_opacity ?? 80) / 255;
            
            for (let i = 1; i <= layers; i++) {
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * baseAlpha * (1 - i / (layers + 1));
                ctx.fillStyle = trailColor;
                if (letterSpacing > 0) {
                    this._fillTextSpaced(ctx, text, x + i * step, y, letterSpacing);
                } else {
                    ctx.fillText(text, x + i * step, y);
                }
                ctx.restore();
            }
            ctx.restore();
        }

        // Shadow
        if (shadowBlur > 0 || shadowOffX !== 0 || shadowOffY !== 0) {
            ctx.save();
            ctx.globalAlpha *= shadowAlpha;
            ctx.fillStyle = shadowColor;
            // 使用 Canvas 原生阴影 API, 产生真正的高斯模糊
            if (shadowBlur > 0) {
                ctx.shadowColor = shadowColor;
                ctx.shadowBlur = shadowBlur;
                ctx.shadowOffsetX = shadowOffX;
                ctx.shadowOffsetY = shadowOffY;
            }
            if (letterSpacing > 0) {
                this._fillTextSpaced(ctx, text, x + (shadowBlur > 0 ? 0 : shadowOffX), y + (shadowBlur > 0 ? 0 : shadowOffY), letterSpacing);
            } else {
                ctx.fillText(text, x + (shadowBlur > 0 ? 0 : shadowOffX), y + (shadowBlur > 0 ? 0 : shadowOffY));
            }
            ctx.restore();
        }

        // Stroke
        if (useStroke && strokeWidth > 0) {
            ctx.save();
            ctx.globalAlpha *= strokeAlpha;
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = strokeWidth * 2;
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            if (letterSpacing > 0) {
                this._strokeTextSpaced(ctx, text, x, y, letterSpacing);
            } else {
                ctx.strokeText(text, x, y);
            }
            ctx.restore();
        }

        // Fill
        if (typeof fillColor === 'string' && fillColor.includes(',')) {
            const colors = fillColor.split(',').map(c => c.trim()).filter(Boolean);
            if (colors.length >= 2) {
                const match = ctx.font.match(/(\d+)px/);
                const fontSize = match ? parseFloat(match[1]) : 80;
                let dir = 'horizontal';
                if (s) {
                    if (fillColor === s.color_high) {
                        dir = s.high_gradient_direction || s.text_gradient_direction || 'horizontal';
                    } else {
                        dir = s.text_gradient_direction || 'horizontal';
                    }
                }
                const useSpan = gradBounds && Number.isFinite(gradBounds.x) && Number.isFinite(gradBounds.w);
                const gx = useSpan ? gradBounds.x : x;
                const gy = useSpan ? gradBounds.y : y;
                const gw = useSpan
                    ? Math.max(1, gradBounds.w)
                    : ((letterSpacing > 0)
                        ? (ctx.measureText(text).width + letterSpacing * Math.max(0, text.length - 1))
                        : ctx.measureText(text).width) || (fontSize * 2);
                const gh = useSpan ? Math.max(1, gradBounds.h || fontSize * 0.95) : (fontSize * 0.95);
                let grad;
                if (dir === 'horizontal') {
                    grad = ctx.createLinearGradient(gx, gy, gx + gw, gy);
                } else if (dir === 'diagonal') {
                    grad = ctx.createLinearGradient(gx, gy, gx + gw, gy + gh);
                } else {
                    grad = ctx.createLinearGradient(gx, gy, gx, gy + gh);
                }
                colors.forEach((c, i) => {
                    grad.addColorStop(i / Math.max(1, colors.length - 1), c);
                });
                ctx.fillStyle = grad;
            } else {
                ctx.fillStyle = fillColor;
            }
        } else {
            ctx.fillStyle = fillColor;
        }
        if (letterSpacing > 0) {
            this._fillTextSpaced(ctx, text, x, y, letterSpacing);
        } else {
            ctx.fillText(text, x, y);
        }
    }

    // ─── Letter-spaced text rendering ───
    _fillTextSpaced(ctx, text, x, y, spacing) {
        let cx = x;
        for (const ch of text) {
            ctx.fillText(ch, cx, y);
            cx += ctx.measureText(ch).width + spacing;
        }
    }

    _strokeTextSpaced(ctx, text, x, y, spacing) {
        let cx = x;
        for (const ch of text) {
            ctx.strokeText(ch, cx, y);
            cx += ctx.measureText(ch).width + spacing;
        }
    }

    _measureTextWithSpacing(ctx, text, spacing = 0) {
        if (!spacing || spacing === 0) return ctx.measureText(text).width;
        let w = 0;
        for (const ch of text) {
            w += ctx.measureText(ch).width + spacing;
        }
        return Math.max(0, w - spacing); // remove last spacing
    }

    /**
     * 测量整行宽度：每个单词内部使用 letterSpacing，单词之间使用 wordSpacing
     * 区别于 _measureTextWithSpacing 对所有字符统一加 spacing
     */
    _measureLineWithSpacing(ctx, line, letterSpacing = 0, wordSpacing = 0) {
        if (!letterSpacing && !wordSpacing) return ctx.measureText(line).width;
        const words = line.split(/\s+/).filter(Boolean);
        if (words.length === 0) return 0;
        let total = 0;
        for (let i = 0; i < words.length; i++) {
            total += this._measureTextWithSpacing(ctx, words[i], letterSpacing);
            if (i < words.length - 1) {
                total += ctx.measureText(' ').width + wordSpacing;
            }
        }
        return total;
    }

    _measureLineWithRandomSpacing(ctx, line, letterSpacing = 0, wordSpacing = 0, style = {}, segStart = 0, startWordIdx = 0) {
        const words = line.split(/\s+/).filter(Boolean);
        if (words.length === 0) return { width: 0, nextWordIdx: startWordIdx };
        let total = 0;
        let wordIdx = startWordIdx;
        const popMax = Math.max(1.0,
            Number(style.word_pop_random_max_scale ?? 1.0),
            Number(style.word_pop_random_pulse_max_scale ?? 1.0),
            Number(style.letter_jump_scale ?? 1.0)
        );
        const baseSpaceW = ctx.measureText(' ').width + wordSpacing;
        const antiCollisionPadding = (popMax > 1.05) ? (baseSpaceW * (popMax - 1.0) * 1.2) : 0;
        const safeSpaceW = baseSpaceW + antiCollisionPadding;

        for (let i = 0; i < words.length; i++) {
            const rawW = this._measureTextWithSpacing(ctx, words[i], letterSpacing);
            let allocScale = 1.0;
            if ((style.anim_in_type || 'none') === 'word_pop_random') {
                allocScale = this._computeWordRandomFinalScale(
                    wordIdx, segStart, segStart,
                    Number(style.word_pop_random_min_scale ?? 0.7),
                    Number(style.word_pop_random_max_scale ?? 1.34)
                );
            } else if ((style.anim_in_type || 'none') === 'word_pop_random_pulse') {
                const pMax = Number(style.word_pop_random_pulse_max_scale ?? 1.40);
                allocScale = Math.max(1.0, pMax * 0.85);
            } else if ((style.anim_in_type || 'none') === 'letter_jump') {
                const ljScale = Number(style.letter_jump_scale ?? 1.5);
                if (ljScale > 1.0) allocScale = ljScale;
            }
            total += rawW * allocScale;
            if (i < words.length - 1) {
                total += safeSpaceW + this._computeRandomWordSpacing(style, wordIdx, segStart, segStart);
            }
            wordIdx++;
        }
        return { width: total, nextWordIdx: wordIdx };
    }

    _seededRand(seed) {
        const raw = (Math.sin(seed) * 43758.5453) % 1;
        return raw < 0 ? raw + 1 : raw;
    }

    _randomSpacingSeed(style) {
        const seed = Number(style && style.random_spacing_seed);
        return Number.isFinite(seed) ? seed : 1;
    }

    _computeRandomWordSpacing(style, wordIdx, segStart = 0, wordStart = 0) {
        const max = Math.max(0, Number(style && style.random_word_spacing) || 0);
        if (max <= 0) return 0;
        const seed = this._randomSpacingSeed(style);
        const key = (Number(wordIdx) + 1) * 19.91 + Number(segStart) * 43.17 + Number(wordStart) * 7.31 + seed * 101.3;
        return this._seededRand(key) * max;
    }

    _computeRandomLineSpacing(style, lineIdx, segStart = 0) {
        const max = Math.max(0, Number(style && style.random_line_spacing) || 0);
        if (max <= 0) return 0;
        const seed = this._randomSpacingSeed(style);
        const key = (Number(lineIdx) + 1) * 29.37 + Number(segStart) * 11.79 + seed * 53.11;
        return this._seededRand(key) * max;
    }

    _computeWordRandomFinalScale(wordIdx, segStart, wordStart, minScale = 0.7, maxScale = 1.34) {
        const key = (Number(wordIdx) + 1.0) * 12.9898 + Number(segStart) * 78.233 + Number(wordStart) * 37.719;
        const rand = this._seededRand(key);
        const minS = Number(minScale) || 0.7;
        const maxS = Math.max(minS, Number(maxScale) || 1.34);
        return minS + (maxS - minS) * rand;
    }

    _buildWordPopGroups(totalWords, segStart, segEnd, wordsInfo = []) {
        const count = Math.max(0, parseInt(totalWords, 10) || 0);
        const starts = new Array(count);
        const ends = new Array(count);
        if (count <= 0) return { starts, ends };

        const segDur = Math.max(0.001, segEnd - segStart);
        const hasWordTimes = Array.isArray(wordsInfo) && wordsInfo.length >= count;

        let i = 0;
        while (i < count) {
            const seed = (i + 1) * 17.17 + segStart * 31.13 + segEnd * 7.19;
            const r = this._seededRand(seed);
            let groupSize = 1;
            if (r > 0.82) groupSize = 3;
            else if (r > 0.48) groupSize = 2;
            const startIdx = i;
            const endIdx = Math.min(count - 1, i + groupSize - 1);

            let gStart = segStart + segDur * (startIdx / count);
            let gEnd = segStart + segDur * ((endIdx + 1) / count);
            if (hasWordTimes) {
                const ws = wordsInfo[startIdx];
                const we = wordsInfo[endIdx];
                const tStart = ws && Number.isFinite(ws.start) ? ws.start : gStart;
                const tEnd = we && Number.isFinite(we.end) ? we.end : gEnd;
                gStart = tStart;
                gEnd = Math.max(gStart + 0.04, tEnd);
            }

            for (let j = startIdx; j <= endIdx; j++) {
                starts[j] = gStart;
                ends[j] = gEnd;
            }
            i = endIdx + 1;
        }
        return { starts, ends };
    }

    // ─── Wrap tokens by pixel width ───
    _wrapTokensByPixelWidth(words, maxWidth, joiner = ' ', letterSpacing = 0, wordSpacing = 0) {
        const ctx = this.ctx;
        const lines = [];
        let currentLine = '';
        let currentLineW = 0;
        const joinerW = ctx.measureText(joiner).width + wordSpacing;

        // A subtitle from Chinese ASR often arrives as one uninterrupted token.
        // It must still obey the selected layout width; otherwise it extends
        // beyond the video instead of becoming multiple subtitle lines.
        const appendOversizeToken = (token) => {
            for (const char of Array.from(token)) {
                const charW = this._measureTextWithSpacing(ctx, char, letterSpacing);
                if (currentLine && currentLineW + charW > maxWidth) {
                    lines.push(currentLine);
                    currentLine = char;
                    currentLineW = charW;
                } else {
                    currentLine += char;
                    currentLineW += charW;
                }
            }
        };

        for (const word of words) {
            const wordW = this._measureTextWithSpacing(ctx, word, letterSpacing);
            // Keep normal words intact where possible. Only split a token that
            // cannot fit on an otherwise empty line (notably CJK text without
            // spaces), so very long subtitles wrap automatically without
            // reducing their font size.
            if (wordW > maxWidth) {
                if (currentLine) {
                    lines.push(currentLine);
                    currentLine = '';
                    currentLineW = 0;
                }
                appendOversizeToken(word);
                continue;
            }
            const testW = currentLine ? currentLineW + joinerW + wordW : wordW;
            if (testW > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
                currentLineW = wordW;
            } else {
                currentLine = currentLine ? currentLine + joiner + word : word;
                currentLineW = testW;
            }
        }
        if (currentLine) lines.push(currentLine);
        return lines;
    }

    // ─── Round rect ───
    _roundRect(ctx, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    // ─── Parse color ───
    _parseColor(colorStr) {
        if (!colorStr) return [0, 0, 0];
        if (colorStr.startsWith('#')) {
            const hex = colorStr.slice(1);
            if (hex.length === 3) {
                return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)];
            }
            return [parseInt(hex.substr(0, 2), 16), parseInt(hex.substr(2, 2), 16), parseInt(hex.substr(4, 2), 16)];
        }
        return [0, 0, 0];
    }

    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    renderFrameWithSubtitle(videoEl, style, segment) {
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        ctx.drawImage(videoEl, 0, 0, w, h);
        const hasKineticBackdrop = style && style.anim_in_type === 'kinetic_glow_stack';
        if (hasKineticBackdrop) {
            this.renderKineticGlowBackdrop(style, w, h);
        }
        this.renderSubtitle(style, segment, videoEl.currentTime, w, h, false, hasKineticBackdrop);
    }

    // ═══════════════════════════════════════════════
    // 富文本渲染循环 (Phase 4)
    // ═══════════════════════════════════════════════

    _renderRichTextSubtitle(style, segment, currentTime, videoW, videoH) {
        if (!segment) return;
        const ctx = this.ctx;
        const s = {
            ...(style || {}),
            ...(segment.style_override || segment.subtitle_style || {})
        };
        const text = segment.edited_text || segment.text || '';
        const textDirection = (typeof ReelsTextDirection !== 'undefined')
            ? ReelsTextDirection.resolve(s.text_direction, text)
            : 'ltr';
        ctx.direction = textDirection;
        ctx.textAlign = 'left';
        
        // 1. 基础配置提取
        const fontFamily = s.font_family || 'Arial';
        const fallbackFamily = (typeof _resolveGenericFallback === 'function') ? _resolveGenericFallback(fontFamily) : 'sans-serif';
        const fw = (typeof _resolveFontWeight === 'function') ? _resolveFontWeight(s.font_weight, s.bold !== false ? 700 : 400) : 700;
        
        const baseStyleConfig = {
            fontsize: s.fontsize || 74,
            color: s.color || s.color_text || '#FFFFFF',
            bold: (fw >= 600),
            font_weight: fw,
            italic: !!s.italic
        };
        const letterSpacing = textDirection === 'rtl' ? 0 : (s.letter_spacing || 0);
        const wordSpacing = s.word_spacing || 0;
        const randomLineSpacingMax = Math.max(0, Number(s.random_line_spacing || 0));

        // 高级文本框/布局
        const advEnabled = !!s.advanced_textbox_enabled;
        const advAlign = (s.advanced_textbox_align || s.adv_text_align || 'center').toLowerCase();
        const advX = parseFloat(s.advanced_textbox_x) || 0;
        const advY = parseFloat(s.advanced_textbox_y) || 0;
        const advW = Math.max(80, parseFloat(s.advanced_textbox_w) || videoW * 0.8);
        const advH = Math.max(40, parseFloat(s.advanced_textbox_h) || 200);
        const autoWrap = s.auto_wrap !== false;

        let maxWidth;
        if (advEnabled) {
            maxWidth = Math.max(1, advW);
        } else {
            const wrapPercent = Math.max(20, Math.min(120, s.wrap_width_percent || 90));
            maxWidth = Math.max(200, Math.floor(videoW * (wrapPercent / 100)));
        }

        // 2. 将纯文本切割为样式片段
        const rawChunks = ReelsRichText.splitByRanges(text, segment.styled_ranges, baseStyleConfig);
        
        // 词级细化：为了支持换行，我们将每个 rawChunk 中的文字按空格拆成细粒度的 token (兼顾样式)
        const tokens = [];
        for (const chunk of rawChunks) {
            const regex = /([^ \n]+|[ \n])/g;
            let match;
            while ((match = regex.exec(chunk.text)) !== null) {
                // 如果是换行，我们专门标记
                tokens.push({ text: match[0], style: chunk.style, isNewline: match[0] === '\n' });
            }
        }

        // 辅助：获取段落的完整 ctx.font
        const _getFontStr = (st) => {
            const b = Math.max(100, Math.min(900, parseInt(st.font_weight || (st.bold ? 700 : 400), 10) || 400));
            const sz = st.fontsize || baseStyleConfig.fontsize;
            return `${st.italic ? 'italic ' : ''}${b} ${sz}px "${fontFamily}", ${fallbackFamily}`;
        };

        // 3. 换行计算 & 尺寸测量
        const lines = []; // 当前由 { tokens, metrics } 组成
        let currentLine = { tokens: [], w: 0, maxAscent: 0, maxDescent: 0, maxFs: 0 };
        let measureWordIdx = 0;
        
        for (const tok of tokens) {
            if (tok.isNewline) {
                lines.push(currentLine);
                currentLine = { tokens: [], w: 0, maxAscent: 0, maxDescent: 0, maxFs: 0 };
                continue;
            }

            ctx.font = _getFontStr(tok.style);
            const isSpace = tok.text === ' ';
            const mw = isSpace
                ? ctx.measureText(' ').width + wordSpacing + this._computeRandomWordSpacing(s, Math.max(0, measureWordIdx - 1), segment.start || 0, segment.start || 0)
                : this._measureTextWithSpacing(ctx, tok.text, letterSpacing);
            // 近似高度获取，canvas 原生 TextMetrics 可给准确高度， fallback用fontSize
            let asc = tok.style.fontsize * 0.8; 
            let desc = tok.style.fontsize * 0.2;
            const metrics = ctx.measureText(tok.text);
            if (metrics.actualBoundingBoxAscent !== undefined) {
                asc = metrics.actualBoundingBoxAscent;
                desc = metrics.actualBoundingBoxDescent;
            }

            // 检查宽度是否超过 maxWidth
            if (autoWrap && currentLine.w + mw > maxWidth && currentLine.tokens.length > 0 && tok.text !== ' ') {
                // 折行前，剔除行尾空格
                if (currentLine.tokens.length > 0 && currentLine.tokens[currentLine.tokens.length-1].text === ' ') {
                   const popSpace = currentLine.tokens.pop();
                   ctx.font = _getFontStr(popSpace.style);
                   currentLine.w -= ctx.measureText(' ').width + wordSpacing;
                }

                lines.push(currentLine);
                currentLine = { tokens: [tok], w: mw, maxAscent: asc, maxDescent: desc, maxFs: tok.style.fontsize };
                if (!isSpace) measureWordIdx++;
            } else {
                currentLine.tokens.push(tok);
                currentLine.w += mw;
                currentLine.maxAscent = Math.max(currentLine.maxAscent, asc);
                currentLine.maxDescent = Math.max(currentLine.maxDescent, desc);
                currentLine.maxFs = Math.max(currentLine.maxFs, tok.style.fontsize);
                if (!isSpace) measureWordIdx++;
            }
        }
        if (currentLine.tokens.length > 0 || tokens.length === 0) {
            lines.push(currentLine);
        }
        if (lines.length === 0) return;

        // 4. 定位与边距计算
        const maxLineW = Math.max(0, ...lines.map(l => l.w || 0));
        const lineSpacing = s.line_spacing || 0;
        const richLineSpacings = lines.map((_, i) => i < lines.length - 1 ? lineSpacing + this._computeRandomLineSpacing(s, i, segment.start || 0) : 0);
        let totalH = 0;
        lines.forEach((l, i) => {
            // fallback 高度
            if (l.maxAscent === 0) { l.maxFs = baseStyleConfig.fontsize; l.maxAscent = l.maxFs * 0.8; l.maxDescent = l.maxFs * 0.2; }
            l.lineH = l.maxAscent + l.maxDescent;
            totalH += l.lineH;
            if (i < lines.length - 1) totalH += richLineSpacings[i];
        });
        if (totalH < 0) totalH = 0;

        let cx, cy;
        if (advEnabled) {
            cx = advX + advW / 2;
            cy = advY + advH / 2;
        } else {
            cx = typeof s.pos_x === 'number' && s.pos_x <= 1 ? s.pos_x * videoW : (s.pos_x || videoW / 2);
            cy = typeof s.pos_y === 'number' && s.pos_y <= 1 ? s.pos_y * videoH : (s.pos_y || videoH * 0.85);
        }

        const parsePadding = (val, fallback) => {
            if (val === undefined || val === null || val === '') return fallback;
            const parsed = parseFloat(val);
            return Number.isFinite(parsed) ? parsed : fallback;
        };

        const padLeft = parsePadding(s.box_padding_left, parsePadding(s.box_padding_x, 12));
        const padRight = parsePadding(s.box_padding_right, parsePadding(s.box_padding_x, 12));
        const padTop = parsePadding(s.box_padding_top, parsePadding(s.box_padding_y, 8));
        const padBottom = parsePadding(s.box_padding_bottom, parsePadding(s.box_padding_y, 8));

        const configuredRichBorderWidth = Number(s.border_width);
        const borderW = Number.isFinite(configuredRichBorderWidth)
            ? Math.max(0, configuredRichBorderWidth)
            : (s.use_stroke === false ? 0 : 3);
        const effectivePadLeft = padLeft + borderW;
        const effectivePadRight = padRight + borderW;
        const effectivePadTop = padTop + borderW;
        const effectivePadBottom = padBottom + borderW;

        ctx.save();
        const rotation = s.rotation || 0;
        if (rotation !== 0) {
            ctx.translate(cx, cy);
            ctx.rotate(rotation * Math.PI / 180);
            ctx.translate(-cx, -cy);
        }

        // 5. 绘制基础背景框
        const isRichBoxWipe = Boolean(s.box_wipe_enabled || s.anim_in_type === 'box_wipe');
        const richBoxOpacity = (s.use_box || isRichBoxWipe)
            ? (s.box_opacity ?? s.opacity_bg ?? 150)
            : 0;
        if (richBoxOpacity > 0) {
            ctx.save();
            ctx.globalAlpha = Math.min(1, richBoxOpacity / 255);
            ctx.fillStyle = s.bg_color || s.color_bg || '#000000';
            const r = s.box_radius || 0;
            const richAdaptive = Boolean((s.box_adaptive_width || isRichBoxWipe) && !advEnabled);

            if (richAdaptive) {
                const richAnim = (typeof ReelsAnimEngine !== 'undefined' ? ReelsAnimEngine : (typeof window !== 'undefined' ? window.ReelsAnimEngine : null));
                const richSlabs = [];
                const richBaseWidths = [];
                let lineYCursor = cy - totalH / 2;
                const alignSetting = String(
                    s.text_align || (advEnabled ? (s.advanced_textbox_align || s.adv_text_align) : '') || 'center'
                ).toLowerCase();
                for (let li = 0; li < lines.length; li++) {
                    const ln = lines[li];
                    const lw = Math.max(0, ln.w || 0);
                    let lx = cx - lw / 2;
                    if (alignSetting === 'left') lx = cx - maxLineW / 2;
                    else if (alignSetting === 'right') lx = cx + maxLineW / 2 - lw;
                    const bw = lw + effectivePadLeft + effectivePadRight;
                    const bh = (ln.lineH || baseStyleConfig.fontsize) + effectivePadTop + effectivePadBottom;
                    richBaseWidths.push(bw);
                    richSlabs.push({
                        left: lx - effectivePadLeft,
                        right: lx - effectivePadLeft + bw,
                        top: lineYCursor - effectivePadTop,
                        bottom: lineYCursor - effectivePadTop + bh,
                    });
                    lineYCursor += (ln.lineH || 0) + (richLineSpacings[li] || 0);
                }
                if (isRichBoxWipe && richSlabs.length > 1) {
                    const minGap = Math.max(4, Math.round((baseStyleConfig.fontsize || 48) * 0.10));
                    for (let li = 0; li < richSlabs.length - 1; li++) {
                        const cur = richSlabs[li];
                        const nxt = richSlabs[li + 1];
                        if (nxt.top - cur.bottom < minGap) {
                            const mid = (cur.bottom + nxt.top) / 2;
                            cur.bottom = mid - minGap / 2;
                            nxt.top = mid + minGap / 2;
                        }
                    }
                }
                const wipedRichWidths = (isRichBoxWipe && richAnim && typeof richAnim.computeBoxWipeLineWidths === 'function')
                    ? richAnim.computeBoxWipeLineWidths(currentTime, segment.start || 0, segment.end || 0, richBaseWidths)
                    : null;
                for (let li = 0; li < richSlabs.length; li++) {
                    const sl = richSlabs[li];
                    let slW = Math.max(1, sl.right - sl.left);
                    let slX = sl.left;
                    if (wipedRichWidths) {
                        slW = wipedRichWidths[li] || 0;
                        if (slW <= 0.5) continue;
                        if (textDirection === 'rtl') slX = sl.right - slW;
                    }
                    const slH = Math.max(1, sl.bottom - sl.top);
                    if (r > 0) {
                        this._roundRect(ctx, slX, sl.top, slW, slH, Math.min(r, slW / 2, slH / 2));
                        ctx.fill();
                    } else {
                        ctx.fillRect(slX, sl.top, slW, slH);
                    }
                }
            } else {
                let bX, bY, bW, bH;
                if (advEnabled) {
                    bX = advX; bY = advY; bW = advW; bH = advH;
                } else {
                    bX = cx - maxLineW / 2 - effectivePadLeft;
                    bY = cy - totalH / 2 - effectivePadTop;
                    bW = maxLineW + effectivePadLeft + effectivePadRight;
                    bH = totalH + effectivePadTop + effectivePadBottom;
                }
                if (isRichBoxWipe && typeof ReelsAnimEngine !== 'undefined' && typeof ReelsAnimEngine.computeBoxWipeLineWidths === 'function') {
                    const [w] = ReelsAnimEngine.computeBoxWipeLineWidths(currentTime, segment.start || 0, segment.end || 0, [bW]);
                    bW = w || 0;
                }
                if (bW > 0.5) {
                    if (r > 0) {
                        this._roundRect(ctx, bX, bY, bW, bH, Math.min(r, bW / 2, bH / 2));
                        ctx.fill();
                    } else {
                        ctx.fillRect(bX, bY, bW, bH);
                    }
                }
            }
            ctx.restore();
        }

        // 6. 全局属性（透明度、描边、阴影）
        const textAlpha = Math.min(1, Math.max(0, s.opacity !== undefined ? s.opacity / 255 : 1));
        const useStroke = s.use_stroke !== false;
        const outlineColor = s.color_outline || '#3E2723';
        const outlineAlpha = s.opacity_outline !== undefined ? s.opacity_outline / 255 : 1;
        // borderW already declared above (line ~1521)
        
        const shadowBlur = s.shadow_blur || 0;
        const shadowOffX = s.shadow_off_x || 0;
        const shadowOffY = s.shadow_off_y || 0;
        const shadowColor = s.shadow_color || '#000000';
        const shadowAlpha = s.shadow_opacity !== undefined ? s.shadow_opacity / 255 : 0;

        ctx.globalAlpha = ctx.globalAlpha * textAlpha;

        // 7. 处理多行逐行绘制
        let startY;
        if (advEnabled) {
            const valign = (s.advanced_textbox_valign || 'center').toLowerCase();
            if (valign === 'top') startY = advY;
            else if (valign === 'bottom') startY = advY + advH - totalH;
            else startY = cy - totalH / 2;
        } else {
            startY = cy - totalH / 2;
        }

        let currY = startY;
        let renderWordIdx = 0;
        let renderLineIdx = 0;
        const richRawAlign = String(
            s.text_align || (advEnabled ? (s.advanced_textbox_align || s.adv_text_align) : '') || 'center'
        ).toLowerCase();
        for (const line of lines) {
            // align
            let lineAlign = richRawAlign;
            if (lineAlign === 'smart_left_center') {
                const lnText = line.tokens.map(t => t.text).join('').trim();
                const lnWords = lnText.split(/\s+/).filter(Boolean);
                const hasExclaim = /[!?\uFF01\uFF1F]["'”’)]*$/.test(lnText);
                if (lines.length === 1) {
                    lineAlign = ((lnWords.length <= 3 && lnText.length <= 16) || (hasExclaim && lnWords.length <= 4)) ? 'center' : 'left';
                } else {
                    const ratio = maxLineW > 1 ? (line.w / maxLineW) : 1;
                    lineAlign = ((ratio < 0.68 && lnWords.length <= 3) || (hasExclaim && ratio < 0.76)) ? 'center' : 'left';
                }
            }
            let renderX = 0;
            if (lineAlign === 'left') renderX = advEnabled ? advX : (cx - maxLineW / 2);
            else if (lineAlign === 'right') renderX = advEnabled ? (advX + advW - line.w) : (cx + maxLineW / 2 - line.w);
            else renderX = cx - line.w / 2;
            if (textDirection === 'rtl') renderX += line.w;

            // 保持 baseline 统一，以这一行最大 ascent 为基线起点
            const baselineY = currY + line.maxAscent;

            for (const tok of line.tokens) {
                if (tok.text === ' ') {
                    ctx.font = _getFontStr(tok.style);
                    const spaceAdvance = ctx.measureText(' ').width + wordSpacing + this._computeRandomWordSpacing(s, Math.max(0, renderWordIdx - 1), segment.start || 0, segment.start || 0);
                    renderX += textDirection === 'rtl' ? -spaceAdvance : spaceAdvance;
                    continue;
                }

                ctx.font = _getFontStr(tok.style);
                const tokenWidth = this._measureTextWithSpacing(ctx, tok.text, letterSpacing);
                const tokenX = textDirection === 'rtl' ? renderX - tokenWidth : renderX;
                
                // --- 背景高亮（独立的单个文本块高亮处理，如果有设定的独立背景色） ---
                if (tok.style.bg_color) {
                    ctx.save();
                    ctx.fillStyle = tok.style.bg_color;
                    ctx.globalAlpha = textAlpha * (tok.style.bg_opacity !== undefined ? tok.style.bg_opacity : 0.8);
                    const bw = tokenWidth;
                    const fs = tok.style.fontsize || baseStyleConfig.fontsize;
                    ctx.fillRect(tokenX - 2, baselineY - fs * 0.8 - 2, bw + 4, fs + 4);
                    ctx.restore();
                }

                // --- 绘制阴影 ---
                if (shadowAlpha > 0 && (shadowBlur > 0 || shadowOffX !== 0 || shadowOffY !== 0)) {
                    ctx.save();
                    ctx.globalAlpha = textAlpha * shadowAlpha;
                    ctx.fillStyle = shadowColor;
                    if (shadowBlur > 0) {
                        ctx.shadowColor = shadowColor;
                        ctx.shadowBlur = shadowBlur;
                        ctx.shadowOffsetX = shadowOffX;
                        ctx.shadowOffsetY = shadowOffY;
                    }
                    ctx.textBaseline = 'alphabetic';
                    if (letterSpacing > 0) {
                        this._fillTextSpaced(ctx, tok.text, tokenX + (shadowBlur > 0 ? 0 : shadowOffX), baselineY + (shadowBlur > 0 ? 0 : shadowOffY), letterSpacing);
                    } else {
                        ctx.fillText(tok.text, tokenX + (shadowBlur > 0 ? 0 : shadowOffX), baselineY + (shadowBlur > 0 ? 0 : shadowOffY));
                    }
                    ctx.restore();
                }

                // --- 绘制描边 ---
                const tokStrokeC = tok.style.color_outline || outlineColor;
                const tokStrokeW = tok.style.border_width !== undefined ? tok.style.border_width : borderW;
                if (useStroke && tokStrokeW > 0) {
                    ctx.save();
                    ctx.globalAlpha = textAlpha * outlineAlpha;
                    ctx.strokeStyle = tokStrokeC;
                    ctx.lineWidth = tokStrokeW * 2;
                    ctx.lineJoin = 'round';
                    ctx.miterLimit = 2;
                    ctx.textBaseline = 'alphabetic';
                    
                    if (letterSpacing > 0) {
                        this._strokeTextSpaced(ctx, tok.text, tokenX, baselineY, letterSpacing);
                    } else {
                        ctx.strokeText(tok.text, tokenX, baselineY);
                    }
                    ctx.restore();
                }

                // --- 绘制实体文字 ---
                ctx.save();
                ctx.fillStyle = tok.style.color || baseStyleConfig.color;
                ctx.textBaseline = 'alphabetic';
                if (letterSpacing > 0) {
                    this._fillTextSpaced(ctx, tok.text, tokenX, baselineY, letterSpacing);
                } else {
                    ctx.fillText(tok.text, tokenX, baselineY);
                }
                
                renderX += textDirection === 'rtl' ? -tokenWidth : tokenWidth;
                renderWordIdx++;
                ctx.restore();
            }

            currY += line.lineH + (randomLineSpacingMax > 0 ? (richLineSpacings[renderLineIdx] || 0) : lineSpacing);
            renderLineIdx++;
        }

        ctx.restore();
    }

    _drawSplitWritingCursor(style,parts,time,width,height,bodyStyle) {
        const title=this._writingPartPositions.title,body=this._writingPartPositions.body;
        const titleEnabled=style.fullpage_typewriter_title_cursor!==false;
        const bodyEnabled=style.fullpage_typewriter_body_cursor!==false;
        const hasBody=parts.body.some(seg=>String(seg.edited_text??seg.text??'').trim());
        const bodyStart=hasBody?Math.min(...parts.body.map(seg=>Number(seg.start)||0)):Infinity;
        let position=titleEnabled?title:null;
        if(hasBody&&time>=parts.titleEnd&&bodyEnabled) {
            let target=body;
            if(!target&&titleEnabled&&title) {
                // Measure the body start on a separate canvas without revealing future text.
                const canvas=this._writingCursorMeasureCanvas ||= document.createElement('canvas');
                if(canvas.width!==width)canvas.width=width;
                if(canvas.height!==height)canvas.height=height;
                const previousCtx=this.ctx,previousPosition=this._writingTipPosition;
                try {
                    this.ctx=canvas.getContext('2d');this.ctx.clearRect(0,0,width,height);
                    const firstWordStart=parts.body[0]?.words?.find(word=>String(word.word??word.text??'').trim())?.start;
                    this._renderFullpageTypewriter(bodyStyle,Math.max(bodyStart,Number(firstWordStart)||bodyStart)+.000001,width,height);
                    target=this._writingTipPosition;
                } finally {this.ctx=previousCtx;this._writingTipPosition=previousPosition;}
            }
            if(target) {
                const gap=bodyStart-parts.titleEnd;
                const duration=gap>.02?Math.min(.35,gap):.22;
                let progress=Math.max(0,Math.min(1,(time-parts.titleEnd)/duration));
                progress=progress*progress*(3-2*progress);
                position=titleEnabled&&title?{...target,
                    x:title.x+(target.x-title.x)*progress,
                    y:title.y+(target.y-title.y)*progress,
                    size:title.size+(target.size-title.size)*progress,
                    time,
                }:(time>=bodyStart?body:null);
            } else if(time>=bodyStart)position=null;
        } else if(hasBody&&time>=bodyStart&&!bodyEnabled) {
            position=null;
        }
        this._writingTipPosition=position;
        if(!position)return;
        const ctx=this.ctx,kind=style.fullpage_typewriter_cursor_kind||'char';
        if(isImageOrVectorWritingTip(kind)) {
            const scale=Math.max(.2,Math.min(4,Number(style.fullpage_typewriter_cursor_scale)||1));
            const x=position.x+(Number(style.fullpage_typewriter_cursor_offset_x)||0);
            const y=position.y+position.size*.9+(Number(style.fullpage_typewriter_cursor_offset_y)||0);
            const size=position.size*scale,angle=Number(style.fullpage_typewriter_cursor_angle)||0;
            if(kind==='image')this._drawWritingCursorImage(ctx,style,x,y,size,angle,time);
            else drawSpeechWritingTip(ctx,kind,x,y,size,angle);
        } else if(Math.floor(time*2)%2===0) {
            ctx.save();ctx.fillStyle=style.fullpage_typewriter_cursor_color||'#FFD700';
            ctx.font=position.font;ctx.fillText(style.fullpage_typewriter_cursor_char||'|',position.x,position.y);ctx.restore();
        }
    }

    _renderFullpageTypewriter(s, currentTime, videoW, videoH) {
        if (s.fullpage_typewriter_split && !s._writingPart) {
            const original = this._contextSegments;
            const parts = getSplitWritingParts(original || [], s, this._writingOriginalScript);
            const common = { ...s, _writingPart: true, fullpage_typewriter_first_line_scale: 1,
                fullpage_typewriter_first_line_color: '', fullpage_typewriter_first_line_bold: false, tw_unrevealed_opacity: 0, _writingDeferCursor: true };
            this._writingPartPositions = {};
            try {
                this._contextSegments = parts.title.map(seg => ({...seg, style_override: {}, subtitle_style: {}}));
                const titleStyle = { ...common,
                    font_family: s.fullpage_typewriter_title_font_follow !== false ? (s.font_family || 'Arial') : (s.fullpage_typewriter_title_font || s.font_family || 'Arial'),
                    use_stroke: s.fullpage_typewriter_title_stroke_independent ? (s.fullpage_typewriter_title_stroke_enabled !== false && Number(s.fullpage_typewriter_title_stroke_width ?? s.border_width ?? 3)>0) : s.use_stroke,
                    color_outline: s.fullpage_typewriter_title_stroke_independent ? (s.fullpage_typewriter_title_stroke_color || s.color_outline || '#3e2723') : s.color_outline,
                    border_width: s.fullpage_typewriter_title_stroke_independent ? (s.fullpage_typewriter_title_stroke_width ?? s.border_width ?? 3) : s.border_width,
                    opacity_outline: s.fullpage_typewriter_title_stroke_independent ? (s.fullpage_typewriter_title_stroke_opacity ?? s.opacity_outline ?? 255) : s.opacity_outline,
                    stroke_expand_enabled: s.fullpage_typewriter_title_stroke_independent ? false : s.stroke_expand_enabled,
                    use_box: s.fullpage_typewriter_title_box_enabled ?? s.use_box,
                    color_bg: s.fullpage_typewriter_title_box_color || s.color_bg || '#000000',
                    opacity_bg: s.fullpage_typewriter_title_box_opacity ?? s.opacity_bg ?? 180,
                    fontsize: Number(s.fullpage_typewriter_title_size) || 56,
                    font_weight: s.fullpage_typewriter_title_weight || '700',
                    color_text: s.fullpage_typewriter_title_color || '#FFD700',
                    advanced_textbox_enabled: false,
                    pos_x: (Number(s.fullpage_typewriter_title_x) || 50) / 100,
                    pos_y: (Number(s.fullpage_typewriter_title_y) || 20) / 100,
                    auto_wrap: true, wrap_width_percent: Math.min(90, Number(s.wrap_width_percent) || 85),
                    fullpage_typewriter_reveal_type: s.fullpage_typewriter_title_reveal || 'char',
                    fullpage_typewriter_cursor: s.fullpage_typewriter_title_cursor !== false,
                };
                this._renderFullpageTypewriter(titleStyle, currentTime, videoW, videoH);
                this._writingPartPositions.title = this._writingTipPosition;
                this._contextSegments = (s.fullpage_typewriter_body_reveal === 'sentence' || !s.fullpage_typewriter_body_reveal ? mergeWritingSentenceCues(parts.body) : parts.body).map(seg => ({...seg, style_override: {}, subtitle_style: {}}));
                const bodyStyle = { ...common,
                    use_stroke: s.fullpage_typewriter_body_stroke_independent ? (s.fullpage_typewriter_body_stroke_enabled !== false && Number(s.fullpage_typewriter_body_stroke_width ?? s.border_width ?? 3)>0) : s.use_stroke,
                    color_outline: s.fullpage_typewriter_body_stroke_independent ? (s.fullpage_typewriter_body_stroke_color || s.color_outline || '#3e2723') : s.color_outline,
                    border_width: s.fullpage_typewriter_body_stroke_independent ? (s.fullpage_typewriter_body_stroke_width ?? s.border_width ?? 3) : s.border_width,
                    opacity_outline: s.fullpage_typewriter_body_stroke_independent ? (s.fullpage_typewriter_body_stroke_opacity ?? s.opacity_outline ?? 255) : s.opacity_outline,
                    stroke_expand_enabled: s.fullpage_typewriter_body_stroke_independent ? false : s.stroke_expand_enabled,
                    use_box: s.fullpage_typewriter_body_box_enabled ?? s.use_box,
                    color_bg: s.fullpage_typewriter_body_box_color || s.color_bg || '#000000',
                    opacity_bg: s.fullpage_typewriter_body_box_opacity ?? s.opacity_bg ?? 180,
                    advanced_textbox_enabled: false,
                    pos_x: (Number(s.fullpage_typewriter_body_x) || 50) / 100,
                    pos_y: (Number(s.fullpage_typewriter_body_y) || 60) / 100,
                    fullpage_typewriter_reveal_type: s.fullpage_typewriter_body_reveal || 'sentence',
                    fullpage_typewriter_cursor: s.fullpage_typewriter_body_cursor !== false,
                };
                this._renderFullpageTypewriter(bodyStyle, currentTime, videoW, videoH);
                this._writingPartPositions.body = this._writingTipPosition;
                this._drawSplitWritingCursor(s, parts, currentTime, videoW, videoH, bodyStyle);
            } finally { this._contextSegments = original; }
            return;
        }
        this._writingTipPosition = null;
        if(s._writingPart && !(this._contextSegments||[]).some(seg=>Number(seg.start)<=currentTime))return;
        const ctx = this.ctx;
        const segments = this._contextSegments || [];
        if (segments.length === 0) return;
        const directionSample = segments.map(seg => seg.edited_text || seg.text || '').join('\n');
        const textDirection = (typeof ReelsTextDirection !== 'undefined')
            ? ReelsTextDirection.resolve(s.text_direction, directionSample)
            : 'ltr';
        ctx.direction = textDirection;
        ctx.textAlign = 'left';
        const firstSegStyle = segments[0] ? { ...(segments[0].style_override || segments[0].subtitle_style || {}) } : {};

        // 1. Gather all tokens with their target times
        const allTokens = [];
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const text = seg.edited_text || seg.text || '';
            if (!text.trim()) continue;

            const segStart = seg.start || 0;
            const segEnd = seg.end || 0;
            const segDur = Math.max(0.001, segEnd - segStart);

            const segTokens = [];
            if (s.fullpage_typewriter_reveal_type === 'sentence') {
                segTokens.push(...getSentenceWritingTokens(seg, text, s.fullpage_typewriter_speech_sync !== false));
            } else if (s.fullpage_typewriter_reveal_type === 'char' && textDirection !== 'rtl') {
                segTokens.push(...getSpeechWritingTokens(seg, text, s.fullpage_typewriter_speech_sync !== false));
            } else {
                // Word-by-word
                if (seg.words && seg.words.length > 0) {
                    for (let wi = 0; wi < seg.words.length; wi++) {
                        const w = seg.words[wi];
                        segTokens.push({
                            text: w.word,
                            start: w.start,
                            end: w.end
                        });
                        if (wi < seg.words.length - 1) {
                            const nextWord = seg.words[wi + 1];
                            segTokens.push({
                                text: ' ',
                                start: w.end,
                                end: nextWord.start
                            });
                        }
                    }
                } else {
                    const rawWords = text.split(/(\s+)/).filter(Boolean);
                    let charCount = 0;
                    const totalChars = text.length || 1;
                    for (const w of rawWords) {
                        const wLen = w.length;
                        segTokens.push({
                            text: w,
                            start: segStart + segDur * (charCount / totalChars),
                            end: segStart + segDur * ((charCount + wLen) / totalChars)
                        });
                        charCount += wLen;
                    }
                }
            }

            // Insert spacing between segments if needed
            if (i > 0 && allTokens.length > 0 && segTokens.length > 0) {
                const lastTok = allTokens[allTokens.length - 1];
                const firstTok = segTokens[0];
                if (!/\s/.test(lastTok.text[lastTok.text.length - 1]) && !/\s/.test(firstTok.text[0])) {
                    allTokens.push({
                        text: ' ',
                        start: lastTok.end,
                        end: firstTok.start
                    });
                }
            }
            allTokens.push(...segTokens);
        }

        if (allTokens.length === 0) return;

        // 2. Set font properties
        const fontFamily = s.font_family || 'Arial';
        const fallbackFamily = _resolveGenericFallback(fontFamily);
        const fontWeight = _resolveFontWeight(s.font_weight, s.bold !== false ? 700 : 400);
        const fontSize = s.fontsize || 58;
        const italic = s.italic || false;
        const letterSpacing = textDirection === 'rtl' ? 0 : (s.letter_spacing || 0);
        const wordSpacing = s.word_spacing || 0;
        const fontStr = `${italic ? 'italic ' : ''}${fontWeight} ${fontSize}px "${fontFamily}", ${fallbackFamily}`;
        ctx.font = fontStr;
        ctx.textBaseline = 'top';

        const getLineFontStr = (li) => {
            let fSize = fontSize;
            let fWeight = fontWeight;
            let fFamily = fontFamily;
            let fItalic = italic;
            
            if (li === 0) {
                if (s.fullpage_typewriter_first_line_scale) {
                    fSize = fontSize * parseFloat(s.fullpage_typewriter_first_line_scale);
                } else if (firstSegStyle.fontsize) {
                    fSize = firstSegStyle.fontsize;
                }
                
                if (s.fullpage_typewriter_first_line_bold !== undefined) {
                    fWeight = s.fullpage_typewriter_first_line_bold ? 900 : fontWeight;
                } else if (firstSegStyle.bold !== undefined) {
                    fWeight = _resolveFontWeight(firstSegStyle.font_weight, firstSegStyle.bold !== false ? 700 : 400);
                }
                
                if (firstSegStyle.font_family) {
                    fFamily = firstSegStyle.font_family;
                }
                if (firstSegStyle.italic !== undefined) {
                    fItalic = firstSegStyle.italic;
                }
            }
            
            const fallbackFam = _resolveGenericFallback(fFamily);
            return `${fItalic ? 'italic ' : ''}${fWeight} ${fSize}px "${fFamily}", ${fallbackFam}`;
        };

        const getLineHeight = (li) => {
            let fSize = fontSize;
            if (li === 0) {
                if (s.fullpage_typewriter_first_line_scale) {
                    fSize = fontSize * parseFloat(s.fullpage_typewriter_first_line_scale);
                } else if (firstSegStyle.fontsize) {
                    fSize = firstSegStyle.fontsize;
                }
            }
            return fSize * 1.2;
        };

        // 3. Line wrapping
        const advEnabled = !!s.advanced_textbox_enabled;
        const advAlign = (s.advanced_textbox_align || s.adv_text_align || 'center').toLowerCase();
        const advX = parseFloat(s.advanced_textbox_x) || 0;
        const advY = parseFloat(s.advanced_textbox_y) || 0;
        const advW = Math.max(80, parseFloat(s.advanced_textbox_w) || videoW * 0.8);
        const advH = Math.max(40, parseFloat(s.advanced_textbox_h) || 200);
        const autoWrap = s.auto_wrap !== false;

        let maxWidth;
        if (advEnabled) {
            maxWidth = Math.max(1, advW);
        } else {
            const wrapPercent = Math.max(20, Math.min(120, s.wrap_width_percent || 85));
            maxWidth = Math.max(200, Math.floor(videoW * (wrapPercent / 100)));
        }

        // Group tokens into wrapping units: English words, spaces, or individual CJK characters
        const wrappingTokens = [];
        let currentWrapTok = null;
        const isCjk = (char) => /[\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(char);

        for (const tok of allTokens) {
            const hasNewline = tok.text.includes('\n');
            const isSpace = /^\s+$/.test(tok.text);
            const isCjkChar = isCjk(tok.text);
            const isEnglishWordChar = !isSpace && !isCjkChar && !hasNewline;

            if (isEnglishWordChar) {
                if (currentWrapTok && currentWrapTok.isWord) {
                    currentWrapTok.text += tok.text;
                    currentWrapTok.tokens.push(tok);
                } else {
                    if (currentWrapTok) {
                        wrappingTokens.push(currentWrapTok);
                    }
                    currentWrapTok = {
                        text: tok.text,
                        isWord: true,
                        tokens: [tok]
                    };
                }
            } else {
                if (currentWrapTok) {
                    wrappingTokens.push(currentWrapTok);
                }
                currentWrapTok = {
                    text: tok.text,
                    isWord: false,
                    tokens: [tok]
                };
            }
        }
        if (currentWrapTok) {
            wrappingTokens.push(currentWrapTok);
        }

        const wrapLines = [];
        let currentWrapLine = [];
        let currentWrapLineW = 0;

        for (const wrapTok of wrappingTokens) {
            if (wrapTok.text.includes('\n')) {
                const parts = wrapTok.text.split('\n');
                for (let p = 0; p < parts.length; p++) {
                    if (p > 0) {
                        wrapLines.push(currentWrapLine);
                        currentWrapLine = [];
                        currentWrapLineW = 0;
                    }
                    const partText = parts[p];
                    if (partText) {
                        const partTokens = wrapTok.tokens.map(tok => ({ ...tok, text: partText }));
                        const partW = this._measureTextWithSpacing(ctx, partText, letterSpacing);
                        currentWrapLine.push({
                            text: partText,
                            isWord: wrapTok.isWord,
                            tokens: partTokens
                        });
                        currentWrapLineW += partW;
                    }
                }
                continue;
            }

            const wrapTokW = this._measureTextWithSpacing(ctx, wrapTok.text, letterSpacing);
            const isWhitespace = /^\s+$/.test(wrapTok.text);

            if (autoWrap && currentWrapLineW + wrapTokW > maxWidth && currentWrapLine.length > 0 && !isWhitespace) {
                wrapLines.push(currentWrapLine);
                currentWrapLine = [wrapTok];
                currentWrapLineW = wrapTokW;
            } else {
                currentWrapLine.push(wrapTok);
                currentWrapLineW += wrapTokW;
            }
        }
        if (currentWrapLine.length > 0) {
            wrapLines.push(currentWrapLine);
        }

        const lines = [];
        for (const wrapLine of wrapLines) {
            const lineTokens = [];
            for (const wrapTok of wrapLine) {
                lineTokens.push(...wrapTok.tokens);
            }
            lines.push(lineTokens);
        }

        if (lines.length === 0) return;

        const parsePadding = (val, fallback) => {
            if (val === undefined || val === null || val === '') return fallback;
            const parsed = parseFloat(val);
            return Number.isFinite(parsed) ? parsed : fallback;
        };

        const padLeft = parsePadding(s.box_padding_left, parsePadding(s.box_padding_x, 24));
        const padRight = parsePadding(s.box_padding_right, parsePadding(s.box_padding_x, 24));
        const padTop = parsePadding(s.box_padding_top, parsePadding(s.box_padding_y, 20));
        const padBottom = parsePadding(s.box_padding_bottom, parsePadding(s.box_padding_y, 20));

        // Limit lines if advanced textbox. When auto-page is enabled, split all
        // wrapped lines into height-safe pages and select the page whose first
        // visible token has started. This lets a writing tip keep writing through
        // a long script without silently dropping the overflow lines.
        let visibleLines = lines;
        let visibleLineIndices = lines.map((_, index) => index);
        if (advEnabled) {
            const lineSpacing = s.line_spacing || 8;
            const availablePageH = Math.max(1, advH - padTop - padBottom);
            const pages = [];
            let pageStart = 0;
            let pageHeight = 0;

            for (let li = 0; li < lines.length; li++) {
                const lineH = getLineHeight(li);
                const nextHeight = pageHeight + (li > pageStart ? lineSpacing : 0) + lineH;
                if (li > pageStart && nextHeight > availablePageH) {
                    pages.push({ start: pageStart, end: li });
                    pageStart = li;
                    pageHeight = lineH;
                } else {
                    pageHeight = nextHeight;
                }
            }
            pages.push({ start: pageStart, end: lines.length });

            let activePage = pages[0];
            if (s.fullpage_typewriter_auto_page !== false && pages.length > 1) {
                const getPageStartTime = (page) => {
                    for (let li = page.start; li < page.end; li++) {
                        const token = lines[li].find(item => item && item.text && item.text.trim().length > 0);
                        if (token && Number.isFinite(Number(token.start))) return Number(token.start);
                    }
                    return Infinity;
                };

                for (let pi = 1; pi < pages.length; pi++) {
                    if (currentTime >= getPageStartTime(pages[pi])) activePage = pages[pi];
                    else break;
                }
            }

            visibleLineIndices = [];
            for (let li = activePage.start; li < activePage.end; li++) visibleLineIndices.push(li);
            visibleLines = visibleLineIndices.map(li => lines[li]);
        }

        // Measure actual widths of all lines using their specific font size/weight
        const measureTokens = (tokens, li) => {
            ctx.font = getLineFontStr(li);
            let total = 0;
            for (let i = 0; i < tokens.length; i++) {
                total += this._measureTextWithSpacing(ctx, tokens[i].text, letterSpacing);
            }
            return total;
        };

        const lineWidths = visibleLines.map((line, li) => measureTokens(line, visibleLineIndices[li]));
        let maxLineW = 0;
        for (const w of lineWidths) maxLineW = Math.max(maxLineW, w);

        const lineSpacing = s.line_spacing || 8;
        let totalH = 0;
        for (let li = 0; li < visibleLines.length; li++) {
            totalH += getLineHeight(visibleLineIndices[li]);
        }
        totalH += (visibleLines.length - 1) * lineSpacing;

        // Position calculation
        let cx, cy;
        if (advEnabled) {
            cx = advX + advW / 2;
            cy = advY + advH / 2;
        } else {
            cx = typeof s.pos_x === 'number' && s.pos_x <= 1 ? s.pos_x * videoW : (s.pos_x || videoW / 2);
            cy = typeof s.pos_y === 'number' && s.pos_y <= 1 ? s.pos_y * videoH : (s.pos_y || videoH * 0.5);
        }

        let rectX, rectY, rectW, rectH;
        if (advEnabled) {
            rectX = advX; rectY = advY; rectW = advW; rectH = advH;
        } else {
            rectX = cx - maxLineW / 2 - padLeft;
            rectY = cy - totalH / 2 - padTop;
            rectW = maxLineW + padLeft + padRight;
            rectH = totalH + padTop + padBottom;
        }

        ctx.save();

        // 4. Background box rendering
        if (s.use_box) {
            ctx.save();
            const bgColor = s.color_bg || '#000000';
            const bgAlpha = (s.opacity_bg ?? 180) / 255;
            ctx.globalAlpha = bgAlpha;
            const rad = s.box_radius || 12;

            ctx.beginPath();
            let r = Math.min(rad, rectW / 2, rectH / 2);
            ctx.moveTo(rectX + r, rectY);
            ctx.lineTo(rectX + rectW - r, rectY);
            ctx.quadraticCurveTo(rectX + rectW, rectY, rectX + rectW, rectY + r);
            ctx.lineTo(rectX + rectW, rectY + rectH - r);
            ctx.quadraticCurveTo(rectX + rectW, rectY + rectH, rectX + rectW - r, rectY + rectH);
            ctx.lineTo(rectX + r, rectY + rectH);
            ctx.quadraticCurveTo(rectX, rectY + rectH, rectX, rectY + rectH - r);
            ctx.lineTo(rectX, rectY + r);
            ctx.quadraticCurveTo(rectX, rectY, rectX + r, rectY);
            ctx.closePath();

            ctx.fillStyle = bgColor;
            ctx.fill();
            ctx.restore();
        }

        // 5. Draw text character/word by character
        let cursorX = null;
        let cursorY = null;
        let cursorLineIdx = 0;
        let hasWritingStarted = false;
        const tipKind = s.fullpage_typewriter_cursor_kind || 'char';
        const imageTip = isImageOrVectorWritingTip(tipKind);
        const twAlign = (s.fullpage_typewriter_align || 'center').toLowerCase();

        // Initialize cursor position to the start of the first line
        if (visibleLines[0] && visibleLines[0].length > 0) {
            const firstLineW = lineWidths[0];
            if (advEnabled) {
                if (advAlign === 'left') cursorX = advX + padLeft;
                else if (advAlign === 'right') cursorX = advX + advW - padRight - firstLineW;
                else cursorX = advX + advW / 2 - firstLineW / 2;
            } else {
                if (twAlign === 'left') cursorX = cx - maxLineW / 2;
                else if (twAlign === 'right') cursorX = cx + maxLineW / 2 - firstLineW;
                else cursorX = cx - firstLineW / 2;
            }
            cursorY = cy - totalH / 2;
        }

        const useStroke = s.use_stroke !== false;
        const outlineColor = s.color_outline || '#3E2723';
        const borderW = s.border_width || 3;
        const outlineAlpha = 1.0;
        const shadowBlur = s.shadow_blur || 0;
        const shadowOffX = s.shadow_offset_x ?? 0;
        const shadowOffY = s.shadow_offset_y ?? 2;
        const shadowColor = s.color_shadow || '#000000';
        const shadowAlpha = (s.opacity_shadow || 150) / 255;

        for (let li = 0; li < visibleLines.length; li++) {
            const globalLi = visibleLineIndices[li];
            const lineTokens = visibleLines[li];
            const lineW = lineWidths[li];
            let startX;
            if (advEnabled) {
                if (advAlign === 'left') startX = advX + padLeft;
                else if (advAlign === 'right') startX = advX + advW - padRight - lineW;
                else startX = advX + advW / 2 - lineW / 2;
            } else {
                if (twAlign === 'left') startX = cx - maxLineW / 2;
                else if (twAlign === 'right') startX = cx + maxLineW / 2 - lineW;
                else startX = cx - lineW / 2;
            }

            let currX = textDirection === 'rtl' ? startX + lineW : startX;
            let y = advEnabled ? advY + padTop : cy - totalH / 2;
            for (let prevLi = 0; prevLi < li; prevLi++) {
                y += getLineHeight(visibleLineIndices[prevLi]) + lineSpacing;
            }

            ctx.font = getLineFontStr(globalLi);

            for (const tok of lineTokens) {
                const tokW = this._measureTextWithSpacing(ctx, tok.text, letterSpacing);
                const tokenX = textDirection === 'rtl' ? currX - tokW : currX;

                let color, opacity;
                let isHighlight = false;
                if (currentTime >= tok.end) {
                    color = (globalLi === 0) ? (s.fullpage_typewriter_first_line_color || firstSegStyle.color_text || s.color_text || '#FFFFFF') : (s.color_text || '#FFFFFF');
                    opacity = 1.0;
                } else if (currentTime >= tok.start && currentTime < tok.end) {
                    color = imageTip ? ((globalLi === 0 ? s.fullpage_typewriter_first_line_color : '') || s.color_text || '#FFFFFF') : (s.color_high || '#FFD700');
                    opacity = 1.0;
                    isHighlight = true;
                } else {
                    color = (globalLi === 0) ? (s.fullpage_typewriter_first_line_color || firstSegStyle.color_text || s.color_text || '#FFFFFF') : (s.color_text || '#FFFFFF');
                    opacity = s.fullpage_typewriter_unrevealed_opacity ?? s.tw_unrevealed_opacity ?? 0.0;
                }

                if (currentTime >= tok.start && !/^\s+$/.test(tok.text)) {
                    const p = imageTip && !tok._sentenceToken && tok.end > tok.start
                        ? Math.max(0, Math.min(1, (currentTime - tok.start) / (tok.end - tok.start))) : 1;
                    cursorX = textDirection === 'rtl' ? tokenX + tokW * (1-p) : tokenX + tokW * p;
                    cursorY = y;
                    cursorLineIdx = globalLi;
                    hasWritingStarted = true;
                }

                if (opacity > 0.001) {
                    ctx.save();
                    ctx.globalAlpha = opacity;
                    let currentShadowColor = shadowColor;
                    if (shadowColor && shadowColor.includes(',')) {
                        const shadowColors = shadowColor.split(',').map(c => c.trim());
                        currentShadowColor = isHighlight ? (shadowColors[1] || shadowColors[0]) : shadowColors[0];
                    }
                    // Full-page typewriter has no whole-line expansion pass:
                    // draw it token-by-token so it remains in sync with reveal.
                    if (s.stroke_expand_enabled) {
                        this._renderWordStrokeExpand(ctx, s, tok.text, tokenX, y,
                            getLineFontStr(globalLi), letterSpacing);
                    }
                    this._drawWord(ctx, tok.text, tokenX, y, color,
                        useStroke && !s.stroke_expand_enabled, outlineColor, borderW, outlineAlpha,
                        shadowBlur, shadowOffX, shadowOffY, currentShadowColor, shadowAlpha, letterSpacing, s);
                    ctx.restore();
                }

                currX += textDirection === 'rtl' ? -tokW : tokW;
            }
        }

        // Decorative tips hold during speech pauses and never blink out.
        this._writingTipPosition = hasWritingStarted ? { x: cursorX, y: cursorY, line: cursorLineIdx, time: currentTime, size: getLineHeight(cursorLineIdx) / 1.2, font: getLineFontStr(cursorLineIdx) } : null;
        if (s.fullpage_typewriter_cursor && !s._writingDeferCursor && cursorX !== null && cursorY !== null) {
            if (imageTip && hasWritingStarted) {
                const activeSize = getLineHeight(cursorLineIdx) / 1.2;
                const scale = Math.max(.2, Math.min(4, Number(s.fullpage_typewriter_cursor_scale) || 1));
                const drawTip=tipKind==='image' ? (ctx,kind,x,y,size,angle)=>this._drawWritingCursorImage(ctx,s,x,y,size,angle,currentTime) : drawSpeechWritingTip;
                drawTip(ctx, tipKind,
                    cursorX + (Number(s.fullpage_typewriter_cursor_offset_x) || 0),
                    cursorY + activeSize * .9 + (Number(s.fullpage_typewriter_cursor_offset_y) || 0),
                    activeSize * scale, Number(s.fullpage_typewriter_cursor_angle) || 0);
            } else if (!imageTip && Math.floor(currentTime * 2) % 2 === 0) {
                ctx.save();
                ctx.fillStyle = s.fullpage_typewriter_cursor_color || '#FFD700';
                ctx.font = getLineFontStr(cursorLineIdx);
                ctx.fillText(s.fullpage_typewriter_cursor_char || '|', cursorX, cursorY);
                ctx.restore();
            }
        }

        ctx.restore();
    }

    _getScatterGroups(s, segment, videoW, videoH) {
        const seedVal = parseInt(s.scatter_seed) || 1;
        const minScale = s.scatter_min_scale ?? 0.8;
        const maxScale = s.scatter_max_scale ?? 1.5;
        const minRotate = s.scatter_min_rotate ?? -10;
        const maxRotate = s.scatter_max_rotate ?? 10;
        const key = s.scatter_max_words + '_' + s.scatter_accum_prob + '_' +
                    s.scatter_area_left + '_' + s.scatter_area_right + '_' +
                    s.scatter_area_top + '_' + s.scatter_area_bottom + '_' +
                    seedVal + '_' + minScale + '_' + maxScale + '_' +
                    minRotate + '_' + maxRotate + '_' + videoW + '_' + videoH;

        // Cache groups on the segment object to avoid recalculating every frame (highly optimized!)
        if (segment._scatterGroups && segment._scatterGroupsKey === key) {
            return segment._scatterGroups;
        }

        let words = segment.words;
        if (!words || words.length === 0) {
            const text = segment.edited_text || segment.text || '';
            const rawWords = text.split(/\s+/).filter(Boolean);
            const segStart = segment.start || 0;
            const segEnd = segment.end || 0;
            const dur = Math.max(0.001, segEnd - segStart);
            words = rawWords.map((w, i) => ({
                word: w,
                start: segStart + dur * (i / rawWords.length),
                end: segStart + dur * ((i + 1) / rawWords.length)
            }));
        }

        const maxWords = Math.max(1, parseInt(s.scatter_max_words) || 3);
        const groups = [];
        let i = 0;
        let groupIdx = 0;

        while (i < words.length) {
            const seed = (groupIdx + 1) * 17.31 + (segment.start || 0) * 42.13 + seedVal * 12.37;
            const randVal = this._seededRand(seed);
            const groupSize = Math.floor(randVal * maxWords) + 1;
            const groupWords = words.slice(i, i + groupSize);

            if (groupWords.length === 0) break;

            const gStart = groupWords[0].start;
            const gEnd = groupWords[groupWords.length - 1].end;

            const accumSeed = (groupIdx + 1) * 93.71 + (segment.start || 0) * 153.29 + seedVal * 23.41;
            const rAccum = this._seededRand(accumSeed);
            const accumProb = s.scatter_accum_prob ?? 0.5;
            const shouldAccumulate = rAccum < accumProb;

            const xSeed = (groupIdx + 1) * 29.57 + (segment.start || 0) * 101.37 + seedVal * 34.57;
            const ySeed = (groupIdx + 1) * 43.19 + (segment.start || 0) * 89.23 + seedVal * 45.69;
            const rX = this._seededRand(xSeed);
            const rY = this._seededRand(ySeed);

            const leftLimit = (s.scatter_area_left ?? 15) / 100 * videoW;
            const rightLimit = (s.scatter_area_right ?? 85) / 100 * videoW;
            const topLimit = (s.scatter_area_top ?? 25) / 100 * videoH;
            const bottomLimit = (s.scatter_area_bottom ?? 75) / 100 * videoH;

            const posX = leftLimit + rX * (rightLimit - leftLimit);
            const posY = topLimit + rY * (bottomLimit - topLimit);

            const scaleSeed = (groupIdx + 1) * 13.91 + (segment.start || 0) * 64.81 + seedVal * 56.73;
            const rScale = this._seededRand(scaleSeed);
            const scale = minScale + rScale * (maxScale - minScale);

            const rotateSeed = (groupIdx + 1) * 57.23 + (segment.start || 0) * 111.43 + seedVal * 67.89;
            const rRotate = this._seededRand(rotateSeed);
            const angle = minRotate + rRotate * (maxRotate - minRotate);

            groups.push({
                words: groupWords,
                gStart: gStart,
                gEnd: gEnd,
                shouldAccumulate: shouldAccumulate,
                posX: posX,
                posY: posY,
                scale: scale,
                angle: angle,
                clearTime: gEnd // temporary
            });

            i += groupSize;
            groupIdx++;
        }

        // Post-process to calculate clearTime
        for (let g = 0; g < groups.length; g++) {
            let clearTime = groups[g].gEnd;
            for (let next = g; next < groups.length; next++) {
                clearTime = groups[next].gEnd;
                if (!groups[next].shouldAccumulate) {
                    break;
                }
            }
            groups[g].clearTime = clearTime;
        }

        segment._scatterGroups = groups;
        segment._scatterGroupsKey = key;

        return groups;
    }

    _renderScatterPop(s, segment, currentTime, videoW, videoH) {
        const ctx = this.ctx;
        const groups = this._getScatterGroups(s, segment, videoW, videoH);
        const directionSample = segment.edited_text || segment.text || '';
        const textDirection = (typeof ReelsTextDirection !== 'undefined')
            ? ReelsTextDirection.resolve(s.text_direction, directionSample)
            : 'ltr';
        ctx.direction = textDirection;
        ctx.textAlign = 'left';

        const fontFamily = s.font_family || 'Arial';
        const fallbackFamily = _resolveGenericFallback(fontFamily);
        const fontWeight = _resolveFontWeight(s.font_weight, s.bold !== false ? 700 : 400);
        const italic = s.italic || false;
        const letterSpacing = textDirection === 'rtl' ? 0 : (s.letter_spacing || 0);
        const wordSpacing = s.word_spacing || 0;

        const useStroke = s.use_stroke !== false;
        const outlineColor = s.color_outline || '#3E2723';
        const borderW = s.border_width || 3;
        const outlineAlpha = 1.0;
        const shadowBlur = s.shadow_blur || 0;
        const shadowOffX = s.shadow_offset_x ?? 0;
        const shadowOffY = s.shadow_offset_y ?? 2;
        const shadowColor = s.color_shadow || '#000000';
        const shadowAlpha = (s.opacity_shadow || 150) / 255;

        for (const group of groups) {
            if (currentTime < group.gStart || currentTime > group.clearTime) {
                continue;
            }

            ctx.save();

            const scaledFontSize = (s.fontsize || 74) * group.scale;
            const fontStr = `${italic ? 'italic ' : ''}${fontWeight} ${scaledFontSize}px "${fontFamily}", ${fallbackFamily}`;
            ctx.font = fontStr;
            ctx.textBaseline = 'top';

            const spaceW = ctx.measureText(' ').width + wordSpacing;
            const wordWidths = group.words.map(w => this._measureTextWithSpacing(ctx, w.word, letterSpacing));
            let groupW = 0;
            for (let i = 0; i < wordWidths.length; i++) {
                groupW += wordWidths[i];
                if (i < wordWidths.length - 1) {
                    groupW += spaceW;
                }
            }

            const padLeft = (s.box_padding_left ?? s.box_padding_x ?? 16) * group.scale;
            const padRight = (s.box_padding_right ?? s.box_padding_x ?? 16) * group.scale;
            const padTop = (s.box_padding_top ?? s.box_padding_y ?? 12) * group.scale;
            const padBottom = (s.box_padding_bottom ?? s.box_padding_y ?? 12) * group.scale;

            const bx = -groupW / 2 - padLeft;
            const by = -(scaledFontSize * 1.2) / 2 - padTop;
            const bw = groupW + padLeft + padRight;
            const bh = (scaledFontSize * 1.2) + padTop + padBottom;

            // Clamp center coordinates to keep the scattered bubble within the video frame
            let renderX = group.posX;
            let renderY = group.posY;
            if (bw < videoW) {
                renderX = Math.max(bw / 2, Math.min(videoW - bw / 2, renderX));
            } else {
                renderX = videoW / 2;
            }
            if (bh < videoH) {
                renderY = Math.max(bh / 2, Math.min(videoH - bh / 2, renderY));
            } else {
                renderY = videoH / 2;
            }

            ctx.translate(renderX, renderY);
            ctx.rotate(group.angle * Math.PI / 180);

            if (s.use_box) {
                ctx.save();
                ctx.fillStyle = s.color_bg || '#6A0DAD';
                ctx.globalAlpha = (s.opacity_bg ?? 220) / 255;
                const rad = (s.box_radius || 12) * group.scale;
                this._roundRect(ctx, bx, by, bw, bh, rad);
                ctx.fill();
                ctx.restore();
            }

            let currX = textDirection === 'rtl' ? groupW / 2 : -groupW / 2;
            const wordY = -(scaledFontSize * 1.2) / 2;

            for (let wi = 0; wi < group.words.length; wi++) {
                const w = group.words[wi];
                const wordStr = w.word;
                const wordW = wordWidths[wi];
                const wordX = textDirection === 'rtl' ? currX - wordW : currX;

                let wordColor = s.color_text || '#FFFFFF';
                let isHighlight = false;
                if (currentTime >= w.start && currentTime <= w.end) {
                    wordColor = s.color_high || '#FFD700';
                    isHighlight = true;
                }

                let currentShadowColor = shadowColor;
                if (shadowColor && shadowColor.includes(',')) {
                    const shadowColors = shadowColor.split(',').map(c => c.trim());
                    currentShadowColor = isHighlight ? (shadowColors[1] || shadowColors[0]) : shadowColors[0];
                }

                this._drawWord(ctx, wordStr, wordX, wordY, wordColor,
                    useStroke && !s.stroke_expand_enabled, outlineColor, borderW * group.scale, outlineAlpha,
                    shadowBlur * group.scale, shadowOffX * group.scale, shadowOffY * group.scale, currentShadowColor, shadowAlpha, letterSpacing * group.scale, s);

                currX += textDirection === 'rtl' ? -(wordW + spaceW) : (wordW + spaceW);
            }

            ctx.restore();
        }
    }

    _getTimedWords(segment) {
        let words = segment.words;
        if (words && words.length > 0) {
            return words.map(w => ({
                word: w.word || '',
                start: Number.isFinite(w.start) ? w.start : (segment.start || 0),
                end: Number.isFinite(w.end) ? w.end : (segment.end || 0)
            })).filter(w => w.word);
        }

        const text = segment.edited_text || segment.text || '';
        const rawWords = text.split(/\s+/).filter(Boolean);
        const segStart = segment.start || 0;
        const segEnd = segment.end || 0;
        const dur = Math.max(0.001, segEnd - segStart);
        return rawWords.map((w, i) => ({
            word: w,
            start: segStart + dur * (i / Math.max(1, rawWords.length)),
            end: segStart + dur * ((i + 1) / Math.max(1, rawWords.length))
        }));
    }

    // ── 智能动态混排 (Smart Copy-Adaptive Mixed Typography Engine) ──
    _scoreMixedLayoutToken(token, idx, total) {
        const raw = String(token?.text || '').trim();
        const clean = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
        if (!clean) return 0.1;

        const stopWords = new Set([
            'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from',
            'and', 'or', 'but', 'so', 'nor', 'yet', 'is', 'am', 'are', 'was', 'were',
            'be', 'been', 'being', 'as', 'if', 'it', 'its', 'that', 'this', 'these', 'those',
            'my', 'your', 'his', 'her', 'our', 'their', 'i', 'you', 'he', 'she', 'we', 'they',
            'me', 'him', 'us', 'them', 'do', 'does', 'did', 'have', 'has', 'had', 'will',
            'would', 'can', 'could', 'should', 'may', 'might', 'must', 'into', 'onto', 'upon',
            '的', '了', '着', '过', '和', '与', '及', '在', '是', '把', '被', '让', '给', '向', '往', '于', '而', '或',
        ]);
        if (stopWords.has(clean)) return 0.25;

        const impactWords = new Set([
            'god', 'jesus', 'lord', 'christ', 'amen', 'pray', 'prayer', 'miracle', 'blessing',
            'blessed', 'faith', 'grace', 'mercy', 'spirit', 'holy', 'heaven', 'angel', 'cross',
            'never', 'always', 'stop', 'watch', 'wait', 'listen', 'warning', 'today', 'tonight',
            'now', 'immediately', 'forever', 'everything', 'nothing', 'everyone', 'no', 'yes',
            'love', 'peace', 'power', 'heal', 'healed', 'healing', 'breakthrough', 'victory',
            'protect', 'saved', 'free', 'danger', 'enemy', 'curse', 'family', 'daughter', 'son',
            'mother', 'father', 'child', 'children', 'heart', 'soul', 'life', 'secret', 'truth',
        ]);

        let score = 1.0;
        if (impactWords.has(clean)) score += 1.5;
        if (/[!?！？]/u.test(raw)) score += 0.9;
        if (/\d/.test(clean)) score += 0.8;
        if (clean.length >= 5 && clean.length <= 10) score += 0.45;
        else if (clean.length >= 11) score += 0.25;
        else if (clean.length <= 2 && !/\p{Script=Han}/u.test(clean)) score -= 0.35;

        // Slight natural emphasis on the opening hook or final punchline word
        if (idx === total - 1 && total >= 2) score += 0.3;
        else if (idx === 0 && total >= 3) score += 0.15;

        return Math.max(0.15, score);
    }

    _partitionMixedLayoutGroups(tokens) {
        if (!Array.isArray(tokens) || tokens.length === 0) return [];
        const isMostlyCjk = tokens.filter(t => t.isCjk).length > tokens.length * 0.5;
        const unpunctuatedMax = isMostlyCjk ? 12 : 10;
        const idealMax = isMostlyCjk ? 10 : 8;
        const hardMax = isMostlyCjk ? 12 : 10;
        const minGroupSize = isMostlyCjk ? 3 : 2;

        const leadConnectors = new Set([
            'and', 'but', 'or', 'so', 'because', 'when', 'while', 'if', 'that', 'which',
            'who', 'where', 'before', 'after', 'until', 'since', 'though', 'although',
            'to', 'for', 'with', 'in', 'on', 'at', 'from', 'by', 'as', 'into', 'through',
        ]);

        // Keep <= 10 words on a single screen unless there is a clear mid-sentence punctuation break
        if (tokens.length <= unpunctuatedMax) {
            const midBreak = tokens.findIndex((t, idx) =>
                idx >= minGroupSize &&
                idx <= tokens.length - minGroupSize - 1 &&
                (t.hasStrongBreak || (tokens.length >= 8 && t.hasClauseBreak))
            );
            if (midBreak >= 0 && tokens.length >= 6) {
                return [
                    tokens.slice(0, midBreak + 1),
                    tokens.slice(midBreak + 1),
                ];
            }
            return [tokens];
        }

        const groups = [];
        let cursor = 0;
        while (cursor < tokens.length) {
            const remaining = tokens.length - cursor;
            if (remaining <= unpunctuatedMax) {
                groups.push(tokens.slice(cursor));
                break;
            }

            // Target a balanced split so the remainder never becomes a 1-word orphan
            const targetLen = remaining <= hardMax + minGroupSize
                ? Math.ceil(remaining / 2)
                : idealMax;
            const searchMin = Math.max(minGroupSize, Math.min(targetLen - 2, remaining - minGroupSize));
            const searchMax = Math.min(hardMax, remaining - minGroupSize);

            let bestSplit = cursor + Math.max(minGroupSize, Math.min(targetLen, searchMax));
            let bestScore = -Infinity;

            for (let i = searchMin; i <= searchMax; i++) {
                const idx = cursor + i - 1;
                const tok = tokens[idx];
                const nextTok = tokens[idx + 1];
                let score = 0;

                // Distance from ideal target length
                score -= Math.abs(i - targetLen) * 0.35;

                // Punctuation & speech pause boundaries
                if (tok.hasStrongBreak) score += 4.0;
                else if (tok.hasClauseBreak) score += 2.6;

                const timeGap = (Number(nextTok?.start) || 0) - (Number(tok?.end) || 0);
                if (timeGap >= 0.25) score += 2.2;
                else if (timeGap >= 0.12) score += 1.0;

                // Prefer breaking right before a connector/preposition, never right after an article/preposition
                if (nextTok && leadConnectors.has(nextTok.clean)) score += 1.1;
                if (tok.weight <= 0.3) score -= 1.8;

                if (score > bestScore) {
                    bestScore = score;
                    bestSplit = cursor + i;
                }
            }

            groups.push(tokens.slice(cursor, bestSplit));
            cursor = bestSplit;
        }

        return groups;
    }

    /**
     * Checks whether a 4-token group consists exclusively of short, visually
     * balanced words (no long word paired with a short word), which is the
     * ONLY case where the 4-row Left-Right-Left-Right interleaved pattern
     *   [词1]
     *          [词2]
     *   [词3]
     *          [词4]
     * looks clean and balanced.
     */
    _isFourShortWordsBalanced(group) {
        if (!Array.isArray(group) || group.length !== 4) return false;
        const lengths = group.map(t => {
            const core = String(t.clean || t.text || '').trim();
            return t.isCjk ? core.length * 2 : core.length;
        });
        const maxLen = Math.max(...lengths);
        const minLen = Math.min(...lengths);
        // Every word must be short (<= 6 letters / <= 3 CJK chars) and no stark long-vs-short mismatch
        return minLen >= 2 && maxLen <= 6 && (maxLen - minLen) <= 3;
    }

    _selectSmartMixedMode(group, requestedMode, seed) {
        const n = group.length;
        if (n <= 1) return 'single';
        if (requestedMode && requestedMode !== 'cycle') return requestedMode;

        // Smart copy-aware mode selection when in 'cycle' (自动轮换) mode
        if (n === 2) {
            const wDiff = Math.abs(group[0].weight - group[1].weight);
            if (wDiff >= 0.55) return 'focus';
            return Math.abs(seed) % 2 === 0 ? 'stack' : 'stairs';
        }

        const weights = group.map(t => t.weight);
        const maxWeight = Math.max(...weights);
        const maxIdx = weights.indexOf(maxWeight);
        const totalChars = group.reduce((sum, t) => sum + t.text.length, 0);

        if (n === 4) {
            // 4 short, balanced words -> prioritize the signature Left-Right-Left-Right interleaved layout
            if (this._isFourShortWordsBalanced(group)) {
                return 'stairs';
            }
            // Long word + short word in a 4-word group -> NEVER use 4-row staggered stairs;
            // pair short words with neighbors using centered focus / collage / stack
            if (maxIdx > 0 && maxIdx < n - 1 && maxWeight >= 1.3) {
                return 'focus';
            }
            const mixedLenModes = ['focus', 'collage', 'stack'];
            return mixedLenModes[Math.abs(seed) % mixedLenModes.length];
        }

        if (n === 3) {
            if (maxIdx > 0 && maxIdx < n - 1 && maxWeight >= 1.35) {
                return Math.abs(seed) % 3 === 0 ? 'collage' : 'focus';
            }
            const shortModes = ['focus', 'stairs', 'collage', 'stack'];
            return shortModes[Math.abs(seed) % shortModes.length];
        }

        if (n >= 5 && n <= 6) {
            // Medium copy (5-6 words): bias toward focus/stack/collage; avoid 4-row alternating stairs when word lengths vary
            const firstLastStrong = (group[0].weight >= 1.25 || group[n - 1].weight >= 1.25);
            const midStrong = maxIdx >= 1 && maxIdx <= n - 2 && maxWeight >= 1.4;
            if (midStrong && Math.abs(seed) % 2 === 0) return 'focus';
            if (firstLastStrong && Math.abs(seed) % 3 === 1) return 'stack';
            const medModes = ['stack', 'focus', 'collage'];
            return medModes[Math.abs(seed) % medModes.length];
        }

        // Longer copy (7+ words): avoid 'stairs' indent waste; prefer structured 3-4 row stack/collage/focus
        const longModes = totalChars > 36
            ? ['stack', 'collage', 'stack', 'focus']
            : ['stack', 'collage', 'focus'];
        return longModes[Math.abs(seed) % longModes.length];
    }

    _splitTokensIntoBalancedRows(tokens, targetRows) {
        const n = tokens.length;
        const k = Math.max(1, Math.min(targetRows, n));
        if (k === 1) return [tokens];
        if (k === n) return tokens.map(t => [t]);

        // Dynamic programming / greedy character-balanced partition that avoids stranding stop words at row ends
        const charWeights = tokens.map(t => Math.max(2, t.text.length));
        const totalW = charWeights.reduce((a, b) => a + b, 0);
        const idealRowW = totalW / k;

        const rows = [];
        let cursor = 0;
        for (let r = 0; r < k - 1; r++) {
            const rowsLeft = k - r;
            const minEnd = cursor + 1;
            const maxEnd = n - (rowsLeft - 1);
            let bestEnd = minEnd;
            let bestCost = Infinity;
            let accumW = 0;

            for (let end = minEnd; end <= maxEnd; end++) {
                accumW += charWeights[end - 1];
                const lastTok = tokens[end - 1];
                let cost = Math.abs(accumW - idealRowW);
                // Penalize ending a row with an article/preposition (e.g. "the", "to", "in", "a")
                if (lastTok.weight <= 0.3 && end < maxEnd) cost += 4.5;
                // Reward breaking at punctuation
                if (lastTok.hasClauseBreak) cost -= 2.5;
                if (cost < bestCost) {
                    bestCost = cost;
                    bestEnd = end;
                }
            }
            rows.push(tokens.slice(cursor, bestEnd));
            cursor = bestEnd;
        }
        rows.push(tokens.slice(cursor));
        return rows.filter(r => r.length > 0);
    }

    _buildSmartMixedRows(group, mode) {
        const n = group.length;
        if (n === 1) {
            return [{
                tokens: group,
                scales: [1.42],
                emphasisFlags: [true],
                align: 'center',
                indent: 0,
                fitTarget: 1.0,
            }];
        }

        if (n === 2) {
            const firstBigger = group[0].weight > group[1].weight + 0.15;
            if (mode === 'stairs') {
                return [
                    { tokens: [group[0]], scales: [firstBigger ? 1.32 : 1.05], emphasisFlags: [firstBigger], align: 'left', indent: 0 },
                    { tokens: [group[1]], scales: [firstBigger ? 1.05 : 1.38], emphasisFlags: [!firstBigger], align: 'left', indent: 0.55 },
                ];
            }
            if (mode === 'collage' && (group[0].text.length + group[1].text.length <= 11)) {
                return [{
                    tokens: group,
                    scales: firstBigger ? [1.48, 0.86] : [0.86, 1.48],
                    emphasisFlags: [firstBigger, !firstBigger],
                    align: 'center',
                    indent: 0,
                }];
            }
            return [
                { tokens: [group[0]], scales: [firstBigger ? 1.45 : 0.94], emphasisFlags: [firstBigger], align: 'center', indent: 0, fitTarget: firstBigger ? 1.0 : 0.82 },
                { tokens: [group[1]], scales: [firstBigger ? 0.94 : 1.48], emphasisFlags: [!firstBigger], align: 'center', indent: 0, fitTarget: firstBigger ? 0.82 : 1.0 },
            ];
        }

        if (mode === 'focus') {
            // Find the strongest focal word (preferring middle positions, or final word for 3-word phrases)
            let focusIdx = Math.floor(n / 2);
            let bestFocusScore = -Infinity;
            const startCand = 1;
            const endCand = n === 3 ? 2 : Math.max(1, n - 2);
            for (let i = startCand; i <= endCand; i++) {
                const centerBias = 1 - Math.abs(i - (n - 1) / 2) * 0.18;
                const sc = group[i].weight * centerBias;
                if (sc > bestFocusScore) {
                    bestFocusScore = sc;
                    focusIdx = i;
                }
            }

            // If the chosen focus word is a tiny stop word, include its neighbor
            let focusStart = focusIdx;
            let focusEnd = focusIdx + 1;
            if (group[focusIdx].text.length <= 3 && n >= 5 && focusIdx + 1 < n - 1) {
                focusEnd = focusIdx + 2;
            }

            const before = group.slice(0, focusStart);
            const focusTokens = group.slice(focusStart, focusEnd);
            const after = group.slice(focusEnd);

            const built = [];
            if (before.length > 0) {
                const beforeChars = before.reduce((s, t) => s + t.text.length, 0);
                let topRows = [before];
                if (before.length >= 5 && beforeChars >= 22) {
                    const candidate = this._splitTokensIntoBalancedRows(before, 2);
                    if (candidate.every(r => r.length >= 2 && r.reduce((s, t) => s + t.text.length, 0) >= 8)) {
                        topRows = candidate;
                    }
                }
                topRows.forEach(r => built.push({
                    tokens: r,
                    scales: r.map(() => 0.86),
                    emphasisFlags: r.map(() => false),
                    align: 'center',
                    indent: 0,
                    fitTarget: 0.96,
                }));
            }
            const focusCharLen = focusTokens.reduce((s, t) => s + t.text.length, 0);
            const focusScale = focusCharLen <= 5 ? 1.78 : focusCharLen <= 9 ? 1.56 : 1.36;
            built.push({
                tokens: focusTokens,
                scales: focusTokens.map(() => focusScale),
                emphasisFlags: focusTokens.map(() => true),
                align: 'center',
                indent: 0,
                fitTarget: 1.02,
            });
            if (after.length > 0) {
                const afterChars = after.reduce((s, t) => s + t.text.length, 0);
                let botRows = [after];
                if (after.length >= 5 && afterChars >= 22) {
                    const candidate = this._splitTokensIntoBalancedRows(after, 2);
                    if (candidate.every(r => r.length >= 2 && r.reduce((s, t) => s + t.text.length, 0) >= 8)) {
                        botRows = candidate;
                    }
                }
                botRows.forEach(r => built.push({
                    tokens: r,
                    scales: r.map(() => 0.88),
                    emphasisFlags: r.map(() => false),
                    align: 'center',
                    indent: 0,
                    fitTarget: 0.96,
                }));
            }
            return built;
        }

        if (mode === 'stack') {
            // 'stack' (首尾大字):
            // Never leave a single short word on a small-font middle row between two big-font edge rows!
            // Pack middle words together onto one compact middle row so its width fills the space between top and bottom.
            if (n === 3) {
                const midLen = group[1].text.length;
                const edgeAvgLen = (group[0].text.length + group[2].text.length) / 2;
                if (midLen < edgeAvgLen + 2) {
                    // Combine the short middle word with the shorter edge so there is no skinny 1-word middle row
                    const attachTop = group[0].text.length <= group[2].text.length;
                    const topRow = attachTop ? [group[0], group[1]] : [group[0]];
                    const botRow = attachTop ? [group[2]] : [group[1], group[2]];
                    return [
                        {
                            tokens: topRow,
                            scales: topRow.map(() => (attachTop ? 0.96 : 1.44)),
                            emphasisFlags: topRow.map(() => !attachTop),
                            align: 'center',
                            indent: 0,
                            fitTarget: 0.98,
                        },
                        {
                            tokens: botRow,
                            scales: botRow.map(() => (attachTop ? 1.46 : 0.96)),
                            emphasisFlags: botRow.map(() => attachTop),
                            align: 'center',
                            indent: 0,
                            fitTarget: 1.0,
                        },
                    ];
                }
                return [
                    { tokens: [group[0]], scales: [1.44], emphasisFlags: [true], align: 'center', indent: 0, fitTarget: 1.0 },
                    { tokens: [group[1]], scales: [0.95], emphasisFlags: [false], align: 'center', indent: 0, fitTarget: 0.96 },
                    { tokens: [group[2]], scales: [1.44], emphasisFlags: [true], align: 'center', indent: 0, fitTarget: 1.0 },
                ];
            }

            // For n >= 4: reserve plenty of words for the middle small-font row(s)
            // Edge rows take 1 word by default; only take 2 words on an edge if n >= 6 and the edge word is a tiny stop word (<= 2 chars)
            const topCount = (n >= 6 && group[0].text.length <= 2 && group[0].weight <= 0.35) ? 2 : 1;
            const botCount = (n - topCount >= 5 && group[n - 1].text.length <= 3 && group[n - 2]?.weight <= 0.35) ? 2 : 1;
            const midTokens = group.slice(topCount, n - botCount);
            const midChars = midTokens.reduce((s, t) => s + t.text.length, 0);

            // Only split midTokens into 2 rows if there are enough words & characters that BOTH middle rows have >= 2 words and >= 10 chars
            let midRows = [midTokens];
            if (midTokens.length >= 5 && midChars >= 22) {
                const candidate = this._splitTokensIntoBalancedRows(midTokens, 2);
                const bothRich = candidate.length === 2 &&
                    candidate.every(r => r.length >= 2 && r.reduce((s, t) => s + t.text.length, 0) >= 9);
                if (bothRich) {
                    midRows = candidate;
                }
            }

            const rawRows = [group.slice(0, topCount), ...midRows, group.slice(n - botCount)];

            return rawRows.filter(r => r.length > 0).map((r, idx, arr) => {
                const isEdge = idx === 0 || idx === arr.length - 1;
                const rowChars = r.reduce((s, t) => s + t.text.length, 0);
                const edgeScale = rowChars <= 5 ? 1.52 : rowChars <= 9 ? 1.36 : 1.20;
                const midScale = rowChars >= 18 ? 0.78 : rowChars >= 12 ? 0.86 : 0.94;
                return {
                    tokens: r,
                    scales: r.map(() => (isEdge ? edgeScale : midScale)),
                    emphasisFlags: r.map(() => isEdge),
                    align: 'center',
                    indent: 0,
                    fitTarget: isEdge ? 1.0 : 0.96,
                };
            });
        }

        if (mode === 'collage') {
            // Adaptive 2 rows (3-4 words), 3 rows (5-7 words), 4 rows (8+ words)
            const targetRows = n <= 4 ? 2 : n <= 7 ? 3 : 4;
            const rawRows = this._splitTokensIntoBalancedRows(group, targetRows);
            return rawRows.map((r, rIdx) => {
                if (r.length === 1) {
                    const sc = r[0].text.length <= 6 ? 1.48 : 1.28;
                    return {
                        tokens: r,
                        scales: [sc],
                        emphasisFlags: [true],
                        align: 'center',
                        indent: 0,
                    };
                }
                // Pick the highest-weight word in the row to be the big word (instead of blindly index 0 if index 0 is a stop word)
                let bigIdx = 0;
                let bestW = -Infinity;
                r.forEach((tok, i) => {
                    const edgeBonus = (i === (rIdx % 2 === 0 ? 0 : r.length - 1)) ? 0.18 : 0;
                    if (tok.weight + edgeBonus > bestW) {
                        bestW = tok.weight + edgeBonus;
                        bigIdx = i;
                    }
                });
                const bigTokLen = r[bigIdx].text.length;
                const bigScale = bigTokLen <= 5 ? (rIdx % 2 === 0 ? 1.56 : 1.44) : bigTokLen <= 9 ? 1.34 : 1.20;
                const smallScale = 0.82;
                return {
                    tokens: r,
                    scales: r.map((_, i) => (i === bigIdx ? bigScale : smallScale)),
                    emphasisFlags: r.map((_, i) => i === bigIdx),
                    align: 'center',
                    indent: 0,
                };
            });
        }

        // 'stairs' (阶梯错位 / 左右穿插):
        // ONLY use 4-row 1-word-per-row Left-Right-Left-Right interleaved zigzag when all 4 words are short & balanced:
        //   [词1]
        //          [词2]
        //   [词3]
        //          [词4]
        // When long words are mixed with short words, group short words with neighbors into 2-3 balanced rows instead.
        if (this._isFourShortWordsBalanced(group)) {
            const leftRightIndents = [0, 1.15, 0, 1.15];
            return group.map((tok, rIdx) => {
                const isEmph = rIdx === 3 || tok.weight >= 1.45;
                return {
                    tokens: [tok],
                    scales: [isEmph ? 1.22 : 1.14],
                    emphasisFlags: [isEmph],
                    align: 'left',
                    indent: leftRightIndents[rIdx],
                    interleavedZigzag: true,
                    zigzagCol: rIdx % 2, // 0 = left col, 1 = right col
                };
            });
        }

        const targetRows = n <= 3 ? n : n === 4 ? 2 : n <= 6 ? 3 : 4;
        const rawRows = this._splitTokensIntoBalancedRows(group, targetRows);
        const indentPattern = rawRows.length === 2
            ? [0, 0.55]
            : rawRows.length === 3
                ? [0, 0.48, 0.96]
                : [0, 0.62, 0.25, 0.88];
        return rawRows.map((r, rIdx) => {
            const isLastRow = rIdx === rawRows.length - 1;
            const hasHighKeyword = r.some(t => t.weight >= 1.45);
            const rowEmph = isLastRow || hasHighKeyword;
            const sc = rowEmph ? 1.24 : (rIdx === 0 ? 1.08 : 0.96);
            return {
                tokens: r,
                scales: r.map(() => sc),
                emphasisFlags: r.map(t => isLastRow || t.weight >= 1.45),
                align: 'left',
                indent: indentPattern[rIdx] || 0,
            };
        });
    }

    // Plan the entire group before revealing words: earlier words never reflow.
    // Both preview and WYSIWYG export enter through renderSubtitle above.
    _renderMixedLayout(s, segment, currentTime, videoW, videoH) {
        if (currentTime < segment.start || currentTime >= segment.end) return;
        const text = this._applyTextTransform(segment.edited_text ?? segment.text ?? '', s);
        const timed = getSpeechWritingTokens(segment, text, true);
        let offset = 0;
        const indexed = timed.map(t => {
            const item = { ...t, offset };
            offset += t.text.length;
            return item;
        });
        // Keep Latin words intact; Han characters can reveal individually.
        const matches = [...text.matchAll(/\p{Script=Han}|[^\s\p{Script=Han}]+/gu)];
        const rawTokens = matches.map((m, idx) => {
            const chars = indexed.filter(t => t.offset >= m.index && t.offset < m.index + m[0].length);
            const spoken = chars.find(t => /[\p{L}\p{N}]/u.test(t.text)) || chars[0];
            const lastChar = chars[chars.length - 1] || spoken;
            const rawStr = m[0];
            return {
                text: rawStr,
                clean: rawStr.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase(),
                start: spoken?.start ?? segment.start,
                end: lastChar?.end ?? spoken?.end ?? segment.end,
                index: m.index,
                isCjk: /\p{Script=Han}/u.test(rawStr),
                hasClauseBreak: /[.!?;:,—–…。！？；：，、]["'”’)]*$/u.test(rawStr),
                hasStrongBreak: /[.!?;—。！？；]["'”’)]*$/u.test(rawStr),
                tokenIdx: idx,
            };
        });
        if (!rawTokens.length) return;
        rawTokens.forEach((tok, idx) => {
            tok.weight = this._scoreMixedLayoutToken(tok, idx, rawTokens.length);
        });

        // Smart clause & length-balanced screen groups (no 1-word orphans, respects punctuation)
        const groups = this._partitionMixedLayoutGroups(rawTokens);
        const groupIndex = groups.findIndex((g, i) => {
            const gStart = i === 0 ? Math.min(segment.start, g[0].start) : g[0].start;
            return currentTime >= gStart && (i === groups.length - 1 || currentTime < groups[i + 1][0].start);
        });
        if (groupIndex < 0) return;
        const group = groups[groupIndex];

        const contextIndex = this._contextSegments?.findIndex(seg => seg === segment ||
            (seg.start === segment.start && seg.end === segment.end && seg.text === segment.text)) ?? -1;
        const seed = (contextIndex >= 0 ? contextIndex : [...text].reduce((n, c) => n + c.codePointAt(0), 0)) + groupIndex;
        const mode = this._selectSmartMixedMode(group, s.mixed_layout, seed);

        const ctx = this.ctx;
        const base = Math.max(12, Number(s.fontsize) || 74);
        const family = s.font_family || 'Arimo';
        const font = (size, isEmph = false) => {
            const baseWeight = _resolveFontWeight(s.font_weight, s.bold === false ? 400 : 700);
            const weight = isEmph && typeof baseWeight === 'number' ? Math.min(900, baseWeight + 100) : baseWeight;
            return `${s.italic ? 'italic ' : ''}${weight} ${size}px "${family}", ${_resolveGenericFallback(family)}`;
        };

        const rowSpecs = this._buildSmartMixedRows(group, mode);
        const alignPref = String(
            s.text_align || (s.advanced_textbox_enabled ? (s.advanced_textbox_align || s.adv_text_align) : '') || ''
        ).toLowerCase();
        if (alignPref === 'left') {
            rowSpecs.forEach(r => {
                r.align = 'left';
                r.indent = 0;
                r.interleavedZigzag = false;
            });
        } else if (alignPref === 'right') {
            rowSpecs.forEach(r => {
                r.align = 'right';
                r.indent = 0;
                r.interleavedZigzag = false;
            });
        } else if (alignPref === 'smart_left_center') {
            // 智能对齐（搭配智能混排）：主要左对齐 + 重点/冲击短行居中，禁止右对齐与右侧阶梯缩进
            rowSpecs.forEach((r, idx) => {
                r.indent = 0;
                r.interleavedZigzag = false;
                const rowChars = r.tokens.reduce((sum, t) => sum + (t.text?.length || 0), 0);
                const allEmph = Array.isArray(r.emphasisFlags) && r.emphasisFlags.length > 0 && r.emphasisFlags.every(Boolean);
                const isFocalSingle = r.tokens.length === 1 && allEmph && (rowChars <= 9 || (r.scales?.[0] || 1) >= 1.38);
                const isFocusCenter = mode === 'focus' && allEmph;
                if (rowSpecs.length === 1) {
                    r.align = isFocalSingle ? 'center' : 'left';
                } else if (isFocusCenter || (isFocalSingle && idx > 0)) {
                    r.align = 'center';
                } else {
                    r.align = 'left';
                }
            });
            if (rowSpecs.length >= 2 && rowSpecs.every(r => r.align === 'center')) {
                rowSpecs[0].align = 'left';
            }
        }
        const isZigzag4 = rowSpecs.some(r => r.interleavedZigzag);
        const wordGapRatio = 0.16;
        const rowGapRatio = isZigzag4 ? 0.05 : 0.08;

        // First pass: measure each row's natural width and height
        const measuredRows = rowSpecs.map(rowSpec => {
            const sizes = rowSpec.scales.map(sc => base * sc);
            const widths = rowSpec.tokens.map((tok, i) => {
                ctx.font = font(sizes[i], rowSpec.emphasisFlags?.[i]);
                return ctx.measureText(tok.text).width;
            });
            const gap = base * wordGapRatio;
            const naturalWidth = widths.reduce((a, b) => a + b, 0) + Math.max(0, widths.length - 1) * gap;
            return {
                ...rowSpec,
                sizes,
                widths,
                gap,
                naturalWidth,
                indentPx: (rowSpec.indent || 0) * base,
            };
        });

        // For 4-short-word Left-Right-Left-Right interleaved zigzag:
        // align [词2] and [词4] to a clean right-hand lane based on the left column's actual pixel width
        if (isZigzag4 && measuredRows.length === 4) {
            const leftColMaxW = Math.max(measuredRows[0].naturalWidth, measuredRows[2].naturalWidth);
            const rightColOffset = Math.max(base * 1.05, leftColMaxW * 0.78);
            measuredRows[0].indentPx = 0;
            measuredRows[1].indentPx = rightColOffset;
            measuredRows[2].indentPx = 0;
            measuredRows[3].indentPx = rightColOffset;
        }

        // Second pass: poster width harmonization for centered modes ('stack' & 'focus')
        // Balances big edge/focus lines and compact middle lines so there are no wide empty gaps on the sides
        if ((mode === 'stack' || mode === 'focus') && measuredRows.length >= 2) {
            const maxNaturalW = Math.max(...measuredRows.map(r => r.naturalWidth));
            const avgNaturalW = measuredRows.reduce((sum, r) => sum + r.naturalWidth, 0) / measuredRows.length;
            const refWidth = avgNaturalW * 0.65 + maxNaturalW * 0.35;
            if (refWidth > 1) {
                measuredRows.forEach(r => {
                    if (!r.fitTarget) return;
                    const desiredW = refWidth * r.fitTarget;
                    const rawFactor = desiredW / Math.max(1, r.naturalWidth);
                    const clampedFactor = Math.max(0.76, Math.min(1.36, Math.pow(rawFactor, 0.65)));
                    r.sizes = r.sizes.map(sz => sz * clampedFactor);
                    r.widths = r.tokens.map((tok, i) => {
                        ctx.font = font(r.sizes[i], r.emphasisFlags?.[i]);
                        return ctx.measureText(tok.text).width;
                    });
                    r.naturalWidth = r.widths.reduce((a, b) => a + b, 0) + Math.max(0, r.widths.length - 1) * r.gap;
                });
            }
        }

        // Third pass: compute final coordinates (x, y) for each token item
        let blockWidth = 0;
        measuredRows.forEach(r => {
            blockWidth = Math.max(blockWidth, r.indentPx + r.naturalWidth);
        });

        const items = [];
        let cursorY = 0;
        measuredRows.forEach((r, rIdx) => {
            const maxRowFont = Math.max(...r.sizes);
            const rowHeight = maxRowFont * (isZigzag4 ? 1.04 : 1.07);
            let cursorX = r.align === 'center'
                ? (blockWidth - r.naturalWidth) / 2
                : r.align === 'right'
                    ? (blockWidth - r.naturalWidth)
                    : r.indentPx;
            const rowStart = r.tokens[0]?.start ?? group.start;

            r.tokens.forEach((tok, i) => {
                const sz = r.sizes[i];
                const w = r.widths[i];
                const isEmph = Boolean(r.emphasisFlags?.[i]);
                items.push({
                    ...tok,
                    rowIndex: rIdx,
                    rowStart,
                    wordIndex: items.length,
                    x: cursorX,
                    // Baseline-align mixed sizes within the same row
                    y: cursorY + (maxRowFont - sz) * 0.88,
                    size: sz,
                    width: w,
                    height: sz * 1.12,
                    isEmphasis: isEmph,
                });
                cursorX += w + r.gap;
            });

            cursorY += rowHeight + (rIdx < measuredRows.length - 1 ? base * rowGapRatio : 0);
        });

        const totalHeight = Math.max(1, cursorY);
        const availableW = videoW * Math.max(0.2, Math.min(0.95, (Number(s.wrap_width_percent) || 80) / 100));
        const availableH = videoH * 0.65;
        const scale = Math.min(1.08, availableW / Math.max(1, blockWidth), availableH / totalHeight);
        const cx = (Number(s.pos_x ?? 0.5) <= 1 ? Number(s.pos_x ?? 0.5) * videoW : Number(s.pos_x));
        const cy = (Number(s.pos_y ?? 0.48) <= 1 ? Number(s.pos_y ?? 0.48) * videoH : Number(s.pos_y));

        const useHighlightColor = Boolean(
            s.highlight_enabled !== false &&
            s.karaoke_highlight !== false &&
            s.color_high &&
            String(s.color_high).trim().toLowerCase() !== String(s.color_text || '#FFFFFF').trim().toLowerCase()
        );

        const anim = (typeof ReelsAnimEngine !== 'undefined' ? ReelsAnimEngine : (typeof window !== 'undefined' ? window.ReelsAnimEngine : null));
        const animInType = String(s.anim_in_type || 'none').trim() || 'none';
        const animOutType = String(s.anim_out_type || 'none').trim() || 'none';
        const inDur = Math.max(0.08, Number(s.anim_in_duration) || 0.28);
        const outDur = Math.max(0, Number(s.anim_out_duration) || 0.25);
        const groupDur = Math.max(0.01, group.end - group.start);
        const dtToEnd = group.end - currentTime;

        // Group-level exit animation (preserves layout while fading/sliding/shrinking out at group end)
        let groupOutAlpha = 1;
        let groupOutScale = 1;
        let groupOutDx = 0;
        let groupOutDy = 0;
        const effectiveOutDur = Math.min(outDur, groupDur * 0.45);
        if (animOutType !== 'none' && effectiveOutDur > 0 && dtToEnd >= 0 && dtToEnd < effectiveOutDur) {
            const rawOut = Math.max(0, Math.min(1, dtToEnd / effectiveOutDur));
            const easeOutProg = rawOut * rawOut * (3 - 2 * rawOut);
            const exitProg = 1 - easeOutProg;
            groupOutAlpha = Math.max(0.02, easeOutProg);
            if (animOutType === 'pop') {
                groupOutScale = Math.max(0.18, 0.25 + 0.75 * easeOutProg);
            } else if (animOutType === 'slide_up') {
                groupOutDy = -exitProg * (base * 0.45);
            } else if (animOutType === 'slide_down') {
                groupOutDy = exitProg * (base * 0.45);
            } else if (animOutType === 'slide_left') {
                groupOutDx = -exitProg * (base * 0.55);
            } else if (animOutType === 'slide_right') {
                groupOutDx = exitProg * (base * 0.55);
            }
        }

        const isCharAnim = [
            'char_float_up',
            'char_pop_elastic',
            'char_wave',
            'char_drop_bounce',
            'char_squash_bounce',
            'char_center_spread',
        ].includes(animInType);

        ctx.save();
        ctx.translate(cx + groupOutDx, cy + groupOutDy);
        ctx.rotate((Number(s.rotation) || 0) * Math.PI / 180);
        ctx.scale(scale * groupOutScale, scale * groupOutScale);
        ctx.translate(-blockWidth / 2, -totalHeight / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const baseAlpha = Number(s.opacity_text_global ?? 1);
        ctx.globalAlpha *= baseAlpha * groupOutAlpha;

        const isMixedBoxWipe = Boolean(s.box_wipe_enabled || animInType === 'box_wipe');
        if (s.use_box || isMixedBoxWipe) {
            const padX = Number.isFinite(Number(s.box_padding_x)) ? Number(s.box_padding_x) : 14;
            const padY = Number.isFinite(Number(s.box_padding_y)) ? Number(s.box_padding_y) : 8;
            const bgAlpha = Math.max(0, Math.min(1, Number(s.opacity_bg ?? 200) / 255));
            const bgRad = Math.max(0, Number(s.box_radius ?? 0));
            const rowBoxes = [];
            const rowWidths = [];
            for (let rIdx = 0; rIdx < measuredRows.length; rIdx++) {
                const rowItems = items.filter(it => it.rowIndex === rIdx);
                if (!rowItems.length) continue;
                const minX = Math.min(...rowItems.map(it => it.x)) - padX;
                const maxX = Math.max(...rowItems.map(it => it.x + it.width)) + padX;
                const minY = Math.min(...rowItems.map(it => it.y)) - padY * 0.5;
                const maxY = Math.max(...rowItems.map(it => it.y + it.height)) + padY * 0.5;
                const w = Math.max(1, maxX - minX);
                rowWidths.push(w);
                rowBoxes.push({ x: minX, y: minY, w, h: Math.max(1, maxY - minY) });
            }
            const wipedRowWidths = (isMixedBoxWipe && anim && typeof anim.computeBoxWipeLineWidths === 'function')
                ? anim.computeBoxWipeLineWidths(currentTime, group.start, group.end, rowWidths)
                : rowWidths;
            ctx.save();
            ctx.globalAlpha *= bgAlpha;
            ctx.fillStyle = s.color_bg || '#000000';
            for (let bi = 0; bi < rowBoxes.length; bi++) {
                const rb = rowBoxes[bi];
                const drawW = wipedRowWidths[bi] || 0;
                if (drawW <= 0.5) continue;
                if (bgRad > 0) {
                    this._roundRect(ctx, rb.x, rb.y, drawW, rb.h, Math.min(bgRad, drawW / 2, rb.h / 2));
                    ctx.fill();
                } else {
                    ctx.fillRect(rb.x, rb.y, drawW, rb.h);
                }
            }
            ctx.restore();
        }

        // Resolve active spoken word index across the group (bridging inter-word silence/space gaps)
        let activeSpokenIdx = items.findIndex(it => currentTime >= it.start && currentTime < it.end);
        if (activeSpokenIdx < 0) {
            for (let k = items.length - 1; k >= 0; k--) {
                if (currentTime >= items[k].start - 1e-6) {
                    activeSpokenIdx = k;
                    break;
                }
            }
            if (activeSpokenIdx < 0 && items.length > 0) {
                activeSpokenIdx = 0;
            }
        }

        for (const item of items) {
            if (s.only_show_active_word && item.wordIndex !== activeSpokenIdx) {
                continue;
            }

            let triggerStart = (groupIndex === 0 && item.wordIndex === 0)
                ? Math.min(segment.start, item.start)
                : item.start;
            if ((animInType === 'box_wipe' || s.box_wipe_enabled) && !s.hide_until_spoken) {
                triggerStart = groupIndex === 0 ? Math.min(segment.start, group.start) : group.start;
            } else if (animInType === 'bullet_reveal') {
                triggerStart = (groupIndex === 0 && item.rowIndex === 0)
                    ? Math.min(segment.start, item.rowStart ?? item.start)
                    : (item.rowStart ?? item.start);
            } else if (animInType === 'metronome') {
                const bpm = Math.max(30, Number(s.metronome_bpm) || 120);
                triggerStart = group.start + item.wordIndex * (60 / bpm);
            }

            let isUnreadMetronome = false;
            let isUnreadSemiTransparent = false;
            if (currentTime < triggerStart) {
                if (animInType === 'metronome') {
                    const unreadOp = Math.max(0, Math.min(1, Number(s.metro_unread_opacity ?? 0) / 255));
                    if (unreadOp <= 0.01) continue;
                    isUnreadMetronome = true;
                } else if (s.hide_until_spoken && Number(s.unread_opacity ?? 0) > 0) {
                    isUnreadSemiTransparent = true;
                } else {
                    continue;
                }
            }

            const elapsed = Math.max(0, currentTime - triggerStart);
            const sizeRatio = item.size / Math.max(24, base);
            let wordScaleX = 1;
            let wordScaleY = 1;
            let wordAlpha = 1;
            let offsetX = 0;
            let offsetY = 0;
            let rotateDeg = 0;
            let blurPx = 0;
            let flashIntensity = 0;

            if (isUnreadMetronome) {
                wordAlpha = Math.max(0, Math.min(1, Number(s.metro_unread_opacity ?? 0) / 255));
            } else if (isUnreadSemiTransparent) {
                wordAlpha = Math.max(0, Math.min(1, Number(s.unread_opacity ?? 0) / 100));
            } else if (animInType === 'none') {
                const popDur = 0.12;
                if (elapsed < popDur) {
                    const t = elapsed / popDur;
                    const easeOut = 1 - Math.pow(1 - t, 3);
                    const overshoot = item.isEmphasis ? Math.sin(t * Math.PI) * 0.06 : 0;
                    const sc = (item.isEmphasis ? 0.84 : 0.90) + (1 - (item.isEmphasis ? 0.84 : 0.90)) * easeOut + overshoot;
                    wordScaleX = sc;
                    wordScaleY = sc;
                    wordAlpha = 0.45 + 0.55 * easeOut;
                    offsetY = (1 - easeOut) * (base * 0.08);
                }
            } else if (animInType === 'fade') {
                if (elapsed < inDur) {
                    const t = elapsed / inDur;
                    const easeOut = 1 - Math.pow(1 - t, 3);
                    wordAlpha = Math.max(0.05, easeOut);
                    offsetY = (1 - easeOut) * (item.size * 0.06);
                }
            } else if (animInType.startsWith('slide_')) {
                if (elapsed < inDur) {
                    const t = elapsed / inDur;
                    const easeOut = 1 - Math.pow(1 - t, 3);
                    const rem = 1 - easeOut;
                    const dist = Math.max(22, item.size * 0.52);
                    if (animInType === 'slide_up') offsetY = rem * dist;
                    else if (animInType === 'slide_down') offsetY = -rem * dist;
                    else if (animInType === 'slide_left') offsetX = rem * dist;
                    else if (animInType === 'slide_right') offsetX = -rem * dist;
                    wordAlpha = Math.min(1, 0.15 + 0.85 * (1 - Math.pow(1 - t, 2)));
                }
            } else if (animInType === 'pop') {
                if (elapsed < inDur) {
                    const t = elapsed / inDur;
                    const c1 = 1.70158 + (item.isEmphasis ? 0.45 : 0);
                    const c3 = c1 + 1;
                    const easeBack = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
                    const sc = Math.max(0.12, 0.18 + 0.82 * easeBack);
                    wordScaleX = sc;
                    wordScaleY = sc;
                    wordAlpha = Math.min(1, t * 2.6);
                }
            } else if (animInType === 'word_pop_random' || animInType === 'word_pop_random_pulse') {
                const popDur = Math.max(0.08, Number(s.word_pop_random_duration || s.word_pop_random_pulse_duration || inDur) || 0.22);
                const readOpacity = Math.max(0.1, Math.min(1, Number(s.word_pop_random_read_opacity ?? 1.0)));
                wordAlpha = readOpacity;
                if (elapsed < popDur) {
                    const minS = Math.max(1.06, Number(s.word_pop_random_pulse_min_scale || 1.10));
                    const maxS = Math.max(minS, Math.min(1.48, Number(s.word_pop_random_pulse_max_scale || s.word_pop_random_max_scale || 1.36)));
                    const key = (item.wordIndex + 1) * 12.9898 + group.start * 78.233 + item.start * 37.719;
                    const rand = Math.abs((Math.sin(key) * 43758.5453) % 1);
                    const peak = (minS + (maxS - minS) * rand) * (item.isEmphasis ? 1.05 : 1.0);
                    const inHalf = popDur * 0.45;
                    let sc = 1;
                    if (elapsed <= inHalf) {
                        const p = elapsed / Math.max(0.001, inHalf);
                        const c1 = 1.70158, c3 = c1 + 1;
                        const eb = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
                        sc = 0.68 + (peak - 0.68) * eb;
                    } else {
                        const p = (elapsed - inHalf) / Math.max(0.001, popDur - inHalf);
                        const ec = 1 - Math.pow(1 - p, 3);
                        sc = peak - (peak - 1) * ec;
                    }
                    wordScaleX = sc;
                    wordScaleY = sc;
                }
            } else if (animInType === 'char_bounce') {
                const bounceDur = Math.max(0.18, inDur);
                const bounceH = (Number(s.char_bounce_height) || 20) * sizeRatio;
                if (elapsed < bounceDur) {
                    const t = elapsed / bounceDur;
                    offsetY = -bounceH * Math.sin(Math.PI * t) * (1 - 0.25 * t);
                    wordAlpha = Math.min(1, 0.25 + t * 2.2);
                }
            } else if (animInType === 'letter_jump') {
                const jumpDur = Math.max(0.12, Math.min(Number(s.letter_jump_duration) || inDur || 0.24, Math.max(0.16, item.end - item.start)));
                const jumpScale = Math.max(1.08, Math.min(2.2, Number(s.letter_jump_scale) || 1.35));
                if (elapsed < jumpDur) {
                    const half = jumpDur / 2;
                    const sc = elapsed < half
                        ? 1 + (jumpScale - 1) * (1 - Math.pow(1 - elapsed / half, 3))
                        : jumpScale - (jumpScale - 1) * (1 - Math.pow(1 - (elapsed - half) / half, 3));
                    wordScaleX = sc;
                    wordScaleY = sc;
                }
            } else if (animInType === 'floating') {
                const enterDur = Math.min(0.18, inDur);
                if (elapsed < enterDur) {
                    const t = elapsed / enterDur;
                    const easeOut = 1 - Math.pow(1 - t, 3);
                    wordAlpha = 0.35 + 0.65 * easeOut;
                    offsetY += (1 - easeOut) * (item.size * 0.12);
                }
                const amp = (Number(s.floating_amplitude) || 8) * sizeRatio * 0.65;
                const period = Math.max(0.4, Number(s.floating_period) || 2.0);
                offsetY += amp * Math.sin((2 * Math.PI * (currentTime - group.start)) / period + item.rowIndex * 0.9 + item.wordIndex * 0.45);
            } else if (animInType === 'bullet_reveal') {
                if (elapsed < inDur) {
                    const t = elapsed / inDur;
                    const easeOut = 1 - Math.pow(1 - t, 3);
                    offsetY = (1 - easeOut) * (item.size * 0.34);
                    wordAlpha = Math.max(0.05, easeOut);
                }
            } else if (animInType === 'flash_highlight') {
                const flashDur = Math.max(0.12, Number(s.flash_duration) || inDur * 0.65 || 0.16);
                if (elapsed < flashDur) {
                    flashIntensity = 1 - elapsed / flashDur;
                    const sc = 1 + 0.10 * flashIntensity;
                    wordScaleX = sc;
                    wordScaleY = sc;
                }
            } else if (animInType === 'holy_glow') {
                if (elapsed < inDur) {
                    const t = elapsed / inDur;
                    const easeOut = 1 - Math.pow(1 - t, 3);
                    wordAlpha = 0.35 + 0.65 * easeOut;
                    offsetY = (1 - easeOut) * (item.size * 0.08);
                }
            } else if (animInType === 'blur_sharp') {
                if (elapsed < inDur) {
                    const t = elapsed / inDur;
                    const easeOut = 1 - Math.pow(1 - t, 3);
                    const maxBlur = Math.max(2, Number(s.blur_sharp_max) || 18);
                    blurPx = Math.round(maxBlur * (1 - easeOut));
                    wordAlpha = 0.25 + 0.75 * easeOut;
                }
            } else if (animInType === 'typewriter') {
                const stampDur = Math.min(0.08, inDur * 0.5);
                if (elapsed < stampDur) {
                    const t = elapsed / Math.max(0.01, stampDur);
                    const sc = 0.92 + 0.08 * t;
                    wordScaleX = sc;
                    wordScaleY = sc;
                }
            } else if (animInType === 'scatter_pop' || animInType === 'word_random_position') {
                if (elapsed < inDur) {
                    const t = elapsed / inDur;
                    const c1 = 1.70158, c3 = c1 + 1;
                    const easeBack = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
                    const sc = Math.max(0.15, 0.22 + 0.78 * easeBack);
                    wordScaleX = sc;
                    wordScaleY = sc;
                    rotateDeg = (1 - easeBack) * ((item.wordIndex % 2 === 0 ? -1 : 1) * 7);
                    wordAlpha = Math.min(1, t * 2.5);
                }
            }

            const isCurrentSpoken = item.wordIndex === activeSpokenIdx;
            if (s.highlight_scale_enabled && isCurrentSpoken && !isUnreadMetronome && !isUnreadSemiTransparent) {
                const hlZoom = Math.max(0.5, Math.min(3.0, (Number(s.highlight_scale) || 125) / 100));
                wordScaleX *= hlZoom;
                wordScaleY *= hlZoom;
            }
            let wordColor = (useHighlightColor && isCurrentSpoken)
                ? s.color_high
                : (s.color_text || '#FFFFFF');
            if (animInType === 'metronome') {
                wordColor = isUnreadMetronome
                    ? (s.metro_unread_color || '#808080')
                    : ((useHighlightColor && isCurrentSpoken) ? s.color_high : (s.metro_read_color || s.color_text || '#FFFFFF'));
            } else if (flashIntensity > 0.35 && s.flash_color) {
                wordColor = s.flash_color;
            }

            ctx.save();
            const centerX = item.x + item.width / 2;
            const centerY = item.y + item.height / 2;
            ctx.translate(centerX + offsetX, centerY + offsetY);
            if (Math.abs(rotateDeg) > 0.01) {
                ctx.rotate((rotateDeg * Math.PI) / 180);
            }
            ctx.scale(wordScaleX, wordScaleY);
            ctx.translate(-centerX, -centerY);
            ctx.globalAlpha *= wordAlpha;
            if (blurPx > 0 && 'filter' in ctx) {
                ctx.filter = `blur(${blurPx}px)`;
            }
            ctx.font = font(item.size, item.isEmphasis);

            // Optional dynamic word box when enabled
            if (isCurrentSpoken && s.dynamic_box && typeof this._roundRect === 'function' && typeof ctx.fill === 'function') {
                const dynPad = (Number(s.high_padding) || 6) * sizeRatio;
                ctx.save();
                ctx.globalAlpha *= (Number(s.opacity_high_bg ?? 200) / 255);
                this._roundRect(
                    ctx,
                    item.x - dynPad,
                    item.y - dynPad * 0.4,
                    item.width + dynPad * 2,
                    item.height + dynPad * 0.8,
                    Number(s.dynamic_radius) || 6
                );
                if (s.dynamic_box_stroke && typeof ctx.stroke === 'function') {
                    ctx.strokeStyle = s.color_high_bg || '#FFD700';
                    ctx.lineWidth = Number(s.dynamic_box_stroke_width) || 2;
                    ctx.stroke();
                } else {
                    ctx.fillStyle = s.color_high_bg || '#FFD700';
                    ctx.fill();
                }
                ctx.restore();
            }

            // Optional Holy Glow halo
            if (animInType === 'holy_glow' && typeof ctx.strokeText === 'function') {
                const glowRadius = Math.max(1, Math.min(16, Math.round((Number(s.holy_glow_radius) || 6) * sizeRatio)));
                const glowColor = s.holy_glow_color || '#FFFFAA';
                const pulse = 0.65 + 0.35 * Math.sin((2 * Math.PI * (currentTime - group.start)) / Math.max(0.3, Number(s.holy_glow_period) || 3.0));
                ctx.save();
                for (let gr = glowRadius; gr > 0; gr--) {
                    const ga = (80 * pulse * (gr / glowRadius) * 0.5) / 255;
                    ctx.globalAlpha *= Math.max(0.05, ga);
                    ctx.strokeStyle = glowColor;
                    ctx.lineWidth = gr * 2;
                    ctx.lineJoin = 'round';
                    ctx.strokeText(item.text, item.x, item.y);
                }
                ctx.restore();
            }

            // Per-character entrance animations while active, settling to whole-word draw once complete
            const chars = isCharAnim ? Array.from(item.text) : null;
            const charDur = Math.max(0.06, Number(s.char_anim_duration) || 0.24);
            const charStagger = Math.max(0.005, Number(s.char_anim_stagger) || 0.035);
            const charIntensity = Math.max(0.2, Number(s.char_anim_intensity) || 1.0);
            const totalCharWindow = chars
                ? Math.max(0, chars.length - 1) * charStagger + charDur * (animInType === 'char_wave' ? 1.6 : 1.0)
                : 0;

            if (isCharAnim && chars && chars.length > 1 && elapsed < totalCharWindow) {
                let charX = item.x;
                for (let ci = 0; ci < chars.length; ci++) {
                    const ch = chars[ci];
                    const chW = ctx.measureText(ch).width;
                    const tf = anim && typeof anim.computeCharAnimTransform === 'function'
                        ? anim.computeCharAnimTransform(animInType, currentTime, ci, chars.length, triggerStart, item.end, {
                            intensity: charIntensity,
                            duration: charDur,
                            stagger: charStagger,
                            fontSize: item.size,
                        })
                        : { dx: 0, dy: 0, scaleX: 1, scaleY: 1, alpha: 1 };
                    if (tf.alpha > 0.005) {
                        ctx.save();
                        ctx.globalAlpha *= tf.alpha;
                        const chCx = charX + chW / 2;
                        const chCy = item.y + item.height / 2;
                        if (tf.dx !== 0 || tf.dy !== 0) {
                            ctx.translate(tf.dx, tf.dy);
                        }
                        if (Math.abs(tf.scaleX - 1) > 0.001 || Math.abs(tf.scaleY - 1) > 0.001) {
                            ctx.translate(chCx, chCy);
                            ctx.scale(tf.scaleX, tf.scaleY);
                            ctx.translate(-chCx, -chCy);
                        }
                        this._drawWord(ctx, ch, charX, item.y, wordColor,
                            !!s.use_stroke, s.color_outline || '#000000', Number(s.border_width) || 0, 1,
                            Number(s.shadow_blur) || 0, Number(s.shadow_offset_x) || 0, Number(s.shadow_offset_y) || 0,
                            s.color_shadow || '#000000', Number(s.opacity_shadow ?? 210) / 255, 0, s);
                        ctx.restore();
                    }
                    charX += chW;
                }
            } else if (animInType === 'typewriter' && s.typewriter_reveal_type === 'char') {
                const twChars = Array.from(item.text);
                const revealWin = Math.max(0.08, Math.min(inDur, Math.max(0.12, (item.end - item.start) * 0.85)));
                const revealedCount = elapsed >= revealWin
                    ? twChars.length
                    : Math.max(1, Math.min(twChars.length, Math.floor((elapsed / revealWin) * twChars.length) + 1));
                const revealedText = twChars.slice(0, revealedCount).join('');
                this._drawWord(ctx, revealedText, item.x, item.y, wordColor,
                    !!s.use_stroke, s.color_outline || '#000000', Number(s.border_width) || 0, 1,
                    Number(s.shadow_blur) || 0, Number(s.shadow_offset_x) || 0, Number(s.shadow_offset_y) || 0,
                    s.color_shadow || '#000000', Number(s.opacity_shadow ?? 210) / 255, 0, s);
            } else {
                this._drawWord(ctx, item.text, item.x, item.y, wordColor,
                    !!s.use_stroke, s.color_outline || '#000000', Number(s.border_width) || 0, 1,
                    Number(s.shadow_blur) || 0, Number(s.shadow_offset_x) || 0, Number(s.shadow_offset_y) || 0,
                    s.color_shadow || '#000000', Number(s.opacity_shadow ?? 210) / 255, 0, s);
            }
            ctx.restore();
        }
        ctx.restore();
    }

    renderKineticGlowBackdrop(style, videoW, videoH) {
        const s = style || {};
        const ctx = this.ctx;
        const clamp01 = (v) => Math.max(0, Math.min(1, v));
        const cx = (typeof s.pos_x === 'number' && s.pos_x <= 1)
            ? s.pos_x * videoW : (Number(s.pos_x) || videoW * 0.5);
        const cy = (typeof s.pos_y === 'number' && s.pos_y <= 1)
            ? s.pos_y * videoH : (Number(s.pos_y) || videoH * 0.40);

        ctx.save();
        const dimOpacity = clamp01(Number(s.kinetic_background_dim ?? 0.50));
        ctx.fillStyle = `rgba(0,0,0,${dimOpacity})`;
        ctx.fillRect(0, 0, videoW, videoH);

        const tintOpacity = clamp01(Number(s.kinetic_tint_opacity ?? 0.18));
        ctx.fillStyle = `rgba(118,108,0,${tintOpacity})`;
        ctx.fillRect(0, 0, videoW, videoH);

        const vignetteStrength = clamp01(Number(s.kinetic_vignette_strength ?? 0.96));
        const vignetteRadiusFactor = Math.max(0.35, Math.min(1.2, Number(s.kinetic_vignette_radius ?? 0.62)));
        const vignetteRadius = Math.max(videoW, videoH) * vignetteRadiusFactor;
        const vignette = ctx.createRadialGradient(cx, cy, Math.min(videoW, videoH) * 0.10, cx, cy, vignetteRadius);
        vignette.addColorStop(0, 'rgba(0,0,0,0)');
        vignette.addColorStop(0.46, `rgba(0,0,0,${vignetteStrength * 0.20})`);
        vignette.addColorStop(1, `rgba(0,0,0,${vignetteStrength})`);
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, videoW, videoH);

        const spotlightOpacity = clamp01(Number(s.kinetic_spotlight_opacity ?? 0.24));
        const spotlightRadius = Math.min(videoW, videoH) * 0.34;
        const glowColor = s.kinetic_glow_color || s.holy_glow_color || '#E7FF00';
        const [glowR, glowG, glowB] = this._parseColor(glowColor);
        const spotlight = ctx.createRadialGradient(cx, cy, 0, cx, cy, spotlightRadius);
        spotlight.addColorStop(0, `rgba(${glowR},${glowG},${glowB},${spotlightOpacity})`);
        spotlight.addColorStop(0.34, `rgba(${glowR},${glowG},${glowB},${spotlightOpacity * 0.48})`);
        spotlight.addColorStop(1, `rgba(${glowR},${glowG},${glowB},0)`);
        ctx.fillStyle = spotlight;
        ctx.fillRect(0, 0, videoW, videoH);
        ctx.restore();
    }

    _renderKineticGlowStack(s, segment, currentTime, videoW, videoH) {
        const segStart = Number(segment.start) || 0;
        const segEnd = Number(segment.end) || segStart;
        if (currentTime < segStart || currentTime > segEnd) return;

        const words = this._getTimedWords(segment).map(w => ({
            ...w,
            word: this._applyTextTransform(w.word || '', s),
        }));
        if (!words.length) return;

        let activeIdx = -1;
        for (let i = 0; i < words.length; i++) {
            if (currentTime >= words[i].start) activeIdx = i;
            else break;
        }
        if (activeIdx < 0) return;

        const ctx = this.ctx;
        const clamp01 = (v) => Math.max(0, Math.min(1, v));
        const maxGroupWords = Math.max(2, Math.min(6, parseInt(s.kinetic_group_words, 10) || 4));
        let groupStart = 0;
        let wordsInGroup = 0;
        for (let i = 0; i < activeIdx; i++) {
            wordsInGroup++;
            const endsPhrase = /[.!?;:，。！？；：]$/.test(words[i].word || '');
            if (endsPhrase || wordsInGroup >= maxGroupWords) {
                groupStart = i + 1;
                wordsInGroup = 0;
            }
        }

        const visible = [];
        for (let i = groupStart; i <= activeIdx; i++) {
            visible.push({ ...words[i], globalIndex: i });
        }
        if (!visible.length) return;

        const cx = (typeof s.pos_x === 'number' && s.pos_x <= 1)
            ? s.pos_x * videoW : (Number(s.pos_x) || videoW * 0.5);
        const cy = (typeof s.pos_y === 'number' && s.pos_y <= 1)
            ? s.pos_y * videoH : (Number(s.pos_y) || videoH * 0.40);

        const segIn = clamp01((currentTime - segStart) / 0.12);
        const segOut = clamp01((segEnd - currentTime) / 0.18);
        const overallAlpha = Math.min(segIn, segOut);
        const groupIntro = clamp01((currentTime - words[groupStart].start) / 0.12);

        if (groupStart > 0 && groupIntro < 1) {
            ctx.save();
            ctx.fillStyle = `rgba(0,0,0,${(1 - groupIntro) * 0.72})`;
            ctx.fillRect(0, 0, videoW, videoH);
            ctx.restore();
        }

        const fontFamily = s.font_family || 'Playfair Display';
        const fallbackFamily = _resolveGenericFallback(fontFamily);
        const fontWeight = _resolveFontWeight(s.font_weight, 800);
        const italic = !!s.italic;
        const baseSize = Math.max(22, Number(s.fontsize) || 92);
        const minScale = Number(s.kinetic_scale_min ?? 0.62);
        const maxScale = Math.max(minScale, Number(s.kinetic_scale_max ?? 1.34));
        const maxTextWidth = Math.max(80, videoW * (Number(s.wrap_width_percent ?? 76) / 100));
        const popDuration = Math.max(0.06, Number(s.kinetic_pop_duration ?? 0.22));
        const oldOpacity = clamp01(Number(s.kinetic_old_word_opacity ?? 0.92));
        const letterSpacing = Number(s.letter_spacing) || 0;
        const lineGap = Math.max(0, Number(s.kinetic_line_gap ?? 0.08)) * baseSize;
        const glowBlur = Math.max(0, Number(s.kinetic_glow_blur ?? 38));
        const glowColor = s.kinetic_glow_color || s.holy_glow_color || '#E7FF00';
        const textColor = s.color_text || '#FFFDF2';

        const layout = visible.map((w, localIndex) => {
            // Reference layout: a small lead word, one oversized hero word,
            // then a smaller trailing word with a slight rightward offset.
            const scalePattern = [
                minScale,
                maxScale,
                Math.min(maxScale, minScale * 1.08),
                minScale + (maxScale - minScale) * 0.42,
            ];
            let finalScale = scalePattern[localIndex % scalePattern.length];
            const localT = clamp01((currentTime - w.start) / popDuration);
            const eased = 1 - Math.pow(1 - localT, 3);
            const isActive = w.globalIndex === activeIdx;
            const entranceScale = isActive ? (1.30 - 0.30 * eased) : 1;
            let fontSize = baseSize * finalScale * entranceScale;
            let fontStr = `${italic ? 'italic ' : ''}${fontWeight} ${fontSize}px "${fontFamily}", ${fallbackFamily}`;
            ctx.font = fontStr;
            let width = this._measureTextWithSpacing(ctx, w.word, letterSpacing);
            if (width > maxTextWidth) {
                const fit = maxTextWidth / Math.max(1, width);
                fontSize *= fit;
                fontStr = `${italic ? 'italic ' : ''}${fontWeight} ${fontSize}px "${fontFamily}", ${fallbackFamily}`;
                ctx.font = fontStr;
                width = this._measureTextWithSpacing(ctx, w.word, letterSpacing);
            }
            const xOffsetPattern = [-0.38, 0, 0.42, -0.22];
            return {
                ...w,
                isActive,
                localT,
                eased,
                fontSize,
                fontStr,
                width,
                xOffset: xOffsetPattern[localIndex % xOffsetPattern.length] * baseSize,
                // Reserve the complete visual height of each word before placing
                // the next line. This keeps the deliberately large hero word
                // from colliding with the smaller lead/trailing words.
                advance: Math.max(baseSize * 0.5, fontSize * 0.92 + lineGap),
            };
        });

        const totalH = layout.reduce((sum, item) => sum + item.advance, 0);
        let y = cy - totalH / 2;
        ctx.save();
        ctx.textBaseline = 'top';
        for (const item of layout) {
            ctx.font = item.fontStr;
            const drawX = cx - item.width / 2 + item.xOffset;
            const wordAlpha = item.isActive
                ? (0.24 + 0.76 * item.eased)
                : oldOpacity;
            const wordGlow = item.isActive
                ? (0.35 + 0.65 * item.eased)
                : Number(s.kinetic_old_glow_opacity ?? 0.62);

            ctx.save();
            ctx.globalAlpha = overallAlpha * wordAlpha;
            this._drawWord(
                ctx, item.word, drawX, y, textColor,
                false, '#000000', 0, 0,
                glowBlur * (item.isActive ? 1 : 0.72), 0, 0,
                glowColor, clamp01(wordGlow), letterSpacing, s
            );
            ctx.restore();
            y += item.advance;
        }
        ctx.restore();
    }

    _renderWordRandomPosition(s, segment, currentTime, videoW, videoH) {
        const ctx = this.ctx;
        const words = this._getTimedWords(segment);
        if (!words.length) return;

        const activeIdx = words.findIndex(w => currentTime >= w.start && currentTime <= w.end);
        if (activeIdx < 0) return;

        const wordInfo = words[activeIdx];
        const wordStr = wordInfo.word;
        const seedVal = parseInt(s.scatter_seed) || 1;

        const fontFamily = s.font_family || 'Arial';
        const fallbackFamily = _resolveGenericFallback(fontFamily);
        const fontWeight = _resolveFontWeight(s.font_weight, s.bold !== false ? 700 : 400);
        const italic = s.italic || false;
        const textDirection = (typeof ReelsTextDirection !== 'undefined')
            ? ReelsTextDirection.resolve(s.text_direction, segment.edited_text || segment.text || wordStr)
            : 'ltr';
        ctx.direction = textDirection;
        ctx.textAlign = 'left';
        const letterSpacing = textDirection === 'rtl' ? 0 : (s.letter_spacing || 0);
        const minScale = Number(s.scatter_min_scale ?? 0.95);
        const maxScale = Math.max(minScale, Number(s.scatter_max_scale ?? 1.35));
        const minRotate = Number(s.scatter_min_rotate ?? -6);
        const maxRotate = Math.max(minRotate, Number(s.scatter_max_rotate ?? 6));

        const scaleRand = this._seededRand((activeIdx + 1) * 13.91 + (segment.start || 0) * 64.81 + seedVal * 56.73);
        const rotateRand = this._seededRand((activeIdx + 1) * 57.23 + (segment.start || 0) * 111.43 + seedVal * 67.89);
        const xRand = this._seededRand((activeIdx + 1) * 29.57 + (segment.start || 0) * 101.37 + seedVal * 34.57);
        const yRand = this._seededRand((activeIdx + 1) * 43.19 + (segment.start || 0) * 89.23 + seedVal * 45.69);

        const scale = minScale + scaleRand * (maxScale - minScale);
        const angle = minRotate + rotateRand * (maxRotate - minRotate);
        const scaledFontSize = (s.fontsize || 74) * scale;
        const fontStr = `${italic ? 'italic ' : ''}${fontWeight} ${scaledFontSize}px "${fontFamily}", ${fallbackFamily}`;
        ctx.font = fontStr;
        ctx.textBaseline = 'top';

        const wordW = this._measureTextWithSpacing(ctx, wordStr, letterSpacing * scale);
        const wordH = scaledFontSize * 1.2;
        const padLeft = s.use_box ? (s.box_padding_left ?? s.box_padding_x ?? 16) * scale : 0;
        const padRight = s.use_box ? (s.box_padding_right ?? s.box_padding_x ?? 16) * scale : 0;
        const padTop = s.use_box ? (s.box_padding_top ?? s.box_padding_y ?? 12) * scale : 0;
        const padBottom = s.use_box ? (s.box_padding_bottom ?? s.box_padding_y ?? 12) * scale : 0;
        const boxW = wordW + padLeft + padRight;
        const boxH = wordH + padTop + padBottom;

        let leftLimit;
        let rightLimit;
        let topLimit;
        let bottomLimit;
        if (s.random_position_use_layout_range !== false) {
            const centerX = (typeof s.pos_x === 'number' && s.pos_x <= 1) ? s.pos_x * videoW : (s.pos_x || videoW / 2);
            const centerY = (typeof s.pos_y === 'number' && s.pos_y <= 1) ? s.pos_y * videoH : (s.pos_y || videoH * 0.5);
            const rangeW = Math.max(20, Math.min(120, parseFloat(s.wrap_width_percent) || 70)) / 100 * videoW;
            const rangeH = Math.max(10, Math.min(100, parseFloat(s.random_position_height_percent) || 35)) / 100 * videoH;
            leftLimit = centerX - rangeW / 2;
            rightLimit = centerX + rangeW / 2;
            topLimit = centerY - rangeH / 2;
            bottomLimit = centerY + rangeH / 2;
        } else {
            leftLimit = (s.scatter_area_left ?? 15) / 100 * videoW;
            rightLimit = (s.scatter_area_right ?? 85) / 100 * videoW;
            topLimit = (s.scatter_area_top ?? 25) / 100 * videoH;
            bottomLimit = (s.scatter_area_bottom ?? 75) / 100 * videoH;
        }
        let renderX = leftLimit + xRand * Math.max(0, rightLimit - leftLimit);
        let renderY = topLimit + yRand * Math.max(0, bottomLimit - topLimit);
        if (boxW < videoW) renderX = Math.max(boxW / 2, Math.min(videoW - boxW / 2, renderX));
        if (boxH < videoH) renderY = Math.max(boxH / 2, Math.min(videoH - boxH / 2, renderY));

        const progress = Math.max(0, Math.min(1, (currentTime - wordInfo.start) / Math.max(0.001, wordInfo.end - wordInfo.start)));
        const popDur = Math.max(0.04, Number(s.word_pop_random_duration ?? 0.18));
        const localT = Math.min(1, (currentTime - wordInfo.start) / popDur);
        const ease = 1 - Math.pow(1 - localT, 3);
        const popScale = (0.82 + 0.18 * ease) * (s.highlight_scale_enabled ? Math.max(0.5, Math.min(3.0, (Number(s.highlight_scale) || 125) / 100)) : 1.0);
        const fadeOut = progress > 0.82 ? Math.max(0, 1 - (progress - 0.82) / 0.18) : 1;

        ctx.save();
        ctx.globalAlpha *= fadeOut;
        ctx.translate(renderX, renderY);
        ctx.rotate(angle * Math.PI / 180);
        ctx.scale(popScale, popScale);

        const bx = -boxW / 2;
        const by = -boxH / 2;
        const wordX = -wordW / 2;
        const wordY = -wordH / 2;

        if (s.use_box) {
            ctx.save();
            ctx.fillStyle = s.color_bg || '#000000';
            ctx.globalAlpha *= (s.opacity_bg ?? 180) / 255;
            this._roundRect(ctx, bx, by, boxW, boxH, (s.box_radius || 10) * scale);
            ctx.fill();
            ctx.restore();
        }

        const useStroke = s.use_stroke !== false;
        const outlineColor = s.color_outline || '#3E2723';
        const borderW = (s.border_width || 3) * scale;
        const shadowBlur = s.shadow_blur || 0;
        const shadowOffX = s.shadow_offset_x ?? 0;
        const shadowOffY = s.shadow_offset_y ?? 2;
        const shadowColor = s.color_shadow || '#000000';
        const shadowAlpha = (s.opacity_shadow || 150) / 255;
        const highlightEnabled = s.highlight_enabled !== false && s.karaoke_highlight !== false;
        const wordColor = highlightEnabled ? (s.color_high || s.color_text || '#FFFFFF') : (s.color_text || '#FFFFFF');

        this._drawWord(ctx, wordStr, wordX, wordY, wordColor,
            useStroke && !s.stroke_expand_enabled, outlineColor, borderW, 1,
            shadowBlur * scale, shadowOffX * scale, shadowOffY * scale, shadowColor, shadowAlpha, letterSpacing * scale, s);
        ctx.restore();
    }
}

function _resolveFontWeight(weight, fallback = 700) {
    const n = parseInt(weight, 10);
    const base = Number.isFinite(n) ? n : fallback;
    return Math.max(100, Math.min(900, base));
}

function _resolveGenericFallback(fontFamily) {
    const f = String(fontFamily || '').toLowerCase();
    const serifHints = [
        'serif', 'times', 'georgia', 'playfair', 'crimson', 'lora', 'gelasio',
        'caslon', 'vidaloka', 'yeseva', 'dm serif', 'young serif', 'rye',
        'song', 'ming', 'mincho',
    ];
    return serifHints.some(k => f.includes(k)) ? 'serif' : 'sans-serif';
}

// ═══════════════════════════════════════════════════════
// SRT Parser
// ═══════════════════════════════════════════════════════

function parseSRT(srtContent) {
    const segments = [];
    const blocks = srtContent.trim().split(/\n\s*\n/);
    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 3) continue;
        const index = parseInt(lines[0]);
        const timeMatch = lines[1].match(
            /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
        );
        if (!timeMatch) continue;
        const start = +timeMatch[1] * 3600 + +timeMatch[2] * 60 + +timeMatch[3] + +timeMatch[4] / 1000;
        const end = +timeMatch[5] * 3600 + +timeMatch[6] * 60 + +timeMatch[7] + +timeMatch[8] / 1000;
        const text = lines.slice(2).join('\n');
        segments.push({ index, start, end, text, words: [] });
    }
    return segments;
}

function formatSRTTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// ═══════════════════════════════════════════════════════
// ASS Generator (enhanced from AutoSub)
// ═══════════════════════════════════════════════════════

function generateASS(segments, style) {
    const s = style || {};
    const fontFamily = s.font_family || 'Arial';
    const fontSize = s.fontsize || 74;
    const fontWeight = _resolveFontWeight(s.font_weight, s.bold !== false ? 700 : 400);
    const bold = fontWeight >= 600 ? -1 : 0;
    const italic = s.italic ? -1 : 0;

    function toASSColor(hex, alpha = 0) {
        if (!hex) hex = '#FFFFFF';
        hex = hex.replace('#', '');
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        const r = hex.substr(0, 2);
        const g = hex.substr(2, 2);
        const b = hex.substr(4, 2);
        const a = String(alpha.toString(16)).padStart(2, '0').toUpperCase();
        return `&H${a}${b}${g}${r}`;
    }

    const primaryColor = toASSColor(s.color_text || '#FFFFFF');
    const outlineColor = toASSColor(s.color_outline || '#3E2723');
    const shadowColor = toASSColor(s.color_shadow || '#000000', Math.round(255 - (s.opacity_shadow || 150)));
    const borderW = s.use_stroke !== false ? (s.border_width || 3) : 0;
    const shadowDist = Math.max(
        Math.abs(s.shadow_offset_x || 0),
        Math.abs(s.shadow_offset_y || 0),
        s.shadow_blur ? Math.min(s.shadow_blur, 4) : 0
    );
    const spacing = s.letter_spacing || 0;

    let alignment = 2;
    const posY = s.pos_y || 0.85;
    if (posY < 0.3) alignment = 8;
    else if (posY < 0.6) alignment = 5;

    const marginV = Math.max(0, Math.round((1 - (typeof posY === 'number' && posY <= 1 ? posY : 0.85)) * 100));

    const header = `[Script Info]
Title: Batch Reels Subtitle
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontFamily},${fontSize},${primaryColor},${primaryColor},${outlineColor},${shadowColor},${bold},${italic},0,0,100,100,${spacing},0,1,${borderW},${shadowDist},${alignment},10,10,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

    function toASSTime(sec) {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
    }

    function buildSegmentOverrideTags(segStyle = {}) {
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
        const sx = typeof segStyle.pos_x === 'number' ? segStyle.pos_x : parseFloat(segStyle.pos_x);
        const sy = typeof segStyle.pos_y === 'number' ? segStyle.pos_y : parseFloat(segStyle.pos_y);
        if (Number.isFinite(sx) || Number.isFinite(sy)) {
            const px = Number.isFinite(sx) ? (sx <= 1 ? sx * 1920 : sx) : 960;
            const py = Number.isFinite(sy) ? (sy <= 1 ? sy * 1080 : sy) : 918;
            tags += `\\an5\\pos(${Math.round(px)},${Math.round(py)})`;
        }
        return tags;
    }

    const events = segments.map(seg => {
        const sourceText = seg.text || '';
        const rawText = sourceText.replace(/\n/g, '\\N');
        const segmentStyle = seg.style_override || seg.subtitle_style || {};
        let segOverrideTags = buildSegmentOverrideTags(segmentStyle);
        const directionSetting = segmentStyle.text_direction || s.text_direction || 'auto';
        const resolvedDirection = (typeof ReelsTextDirection !== 'undefined')
            ? ReelsTextDirection.resolve(directionSetting, sourceText)
            : 'ltr';
        const directionMark = resolvedDirection === 'rtl' ? '\u200F' : '\u200E';
        if (resolvedDirection === 'rtl') segOverrideTags += '\\fsp0';

        // ── 富文本 ASS 内联样式 ──
        if (seg.styled_ranges && seg.styled_ranges.length > 0 && typeof ReelsRichText !== 'undefined') {
            const chunks = ReelsRichText.splitByRanges(seg.text || '', seg.styled_ranges, {
                fontsize: fontSize,
                color: s.color_text || '#FFFFFF',
                bold: bold !== 0,
                font_weight: s.font_weight || (bold !== 0 ? 700 : 400),
                italic: italic !== 0,
            });
            let assText = '';
            for (const c of chunks) {
                let overrides = '';
                // 颜色覆盖
                if (c.style.color && c.style.color !== (s.color_text || '#FFFFFF')) {
                    overrides += `\\c${toASSColor(c.style.color)}`;
                }
                // 字号覆盖
                if (c.style.fontsize && c.style.fontsize !== fontSize) {
                    overrides += `\\fs${c.style.fontsize}`;
                }
                // 粗体覆盖
                if (c.style.bold !== undefined) {
                    const segBold = c.style.bold ? -1 : 0;
                    if (segBold !== bold) overrides += `\\b${segBold === -1 ? 1 : 0}`;
                }
                if (c.style.font_weight !== undefined) {
                    const segWeight = Math.max(100, Math.min(900, parseInt(c.style.font_weight, 10) || 400));
                    if (segWeight !== (parseInt(s.font_weight, 10) || (bold !== 0 ? 700 : 400))) overrides += `\\b${segWeight}`;
                }
                if (c.style.italic !== undefined) {
                    const segItalic = c.style.italic ? -1 : 0;
                    if (segItalic !== italic) {
                        overrides += `\\i${segItalic === -1 ? 1 : 0}`;
                    }
                }
                const segChunkText = c.text.replace(/\n/g, '\\N');
                if (overrides) {
                    assText += `{${overrides}}${segChunkText}`;
                } else {
                    assText += segChunkText;
                }
            }
            return `Dialogue: 0,${toASSTime(seg.start)},${toASSTime(seg.end)},Default,,0,0,0,,${segOverrideTags ? `{${segOverrideTags}}` : ''}${directionMark}${assText}`;
        }

        return `Dialogue: 0,${toASSTime(seg.start)},${toASSTime(seg.end)},Default,,0,0,0,,${segOverrideTags ? `{${segOverrideTags}}` : ''}${directionMark}${rawText}`;
    });

    return header + '\n' + events.join('\n') + '\n';
}

// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

if (typeof window !== 'undefined') {
    window.ReelsCanvasRenderer = ReelsCanvasRenderer;
    window.parseSRT = parseSRT;
    window.formatSRTTime = formatSRTTime;
    window.generateASS = generateASS;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ReelsCanvasRenderer,
        parseSRT,
        formatSRTTime,
        generateASS,
        getSubtitleLayoutMaxScale,
        getTopBaselineGlyphBounds,
        getAmbientGlowCompositeOperation,
    };
}
