const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ffmpegService = require('./ffmpeg');
const gladiaService = require('./gladia');
const cloudTranscription = require('./cloudTranscription');
const elevenlabsService = require('./elevenlabs');
const subtitleService = require('./subtitle');
const settingsService = require('./settings');
const subtitleUtils = require('./subtitleUtils');
const autoEditMatcherV2 = require('./autoEditMatcherV2');

async function asyncPool(limit, items, iteratorFn) {
    const ret = [];
    const executing = new Set();
    for (const item of items) {
        const p = Promise.resolve().then(() => iteratorFn(item));
        ret.push(p);
        executing.add(p);
        const clean = () => executing.delete(p);
        p.then(clean, clean);
        if (executing.size >= limit) {
            await Promise.race(executing);
        }
    }
    return Promise.all(ret);
}

const ENGLISH_NUMBER_VALUES = Object.freeze({
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90,
});
const ENGLISH_ORDINAL_VALUES = Object.freeze({
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
    ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14,
    fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
    twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70,
    eightieth: 80, ninetieth: 90, hundredth: 100, thousandth: 1000,
});
const ENGLISH_MONTH_VALUES = Object.freeze({
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
    may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9,
    sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
});

function numericTokenValue(token) {
    const ordinal = String(token || '').match(/^(\d+)(?:st|nd|rd|th)$/);
    if (ordinal) return Number(ordinal[1]);
    if (/^\d+$/.test(token)) return Number(token);
    return ENGLISH_NUMBER_VALUES[token] ?? ENGLISH_ORDINAL_VALUES[token] ?? null;
}

// ASR often writes "two" / "third", while scripts use "2" / "3rd".  Canonicalize
// the common English cardinal and ordinal forms before all matching calculations.
function normalizeEnglishNumbers(text) {
    const tokens = String(text || '').normalize('NFKC').toLowerCase()
        .replace(/[‐‑‒–—-]/g, ' ')
        .match(/[a-z]+|\d+(?:st|nd|rd|th)?|[^\s]/g) || [];
    const output = [];
    for (let index = 0; index < tokens.length;) {
        const token = tokens[index];
        // Only interpret a month as a date component beside a numeric day. This
        // preserves ordinary text such as "may be".
        if (token in ENGLISH_MONTH_VALUES) {
            const nextDay = numericTokenValue(tokens[index + 1]);
            const previousDay = numericTokenValue(tokens[index - 1]);
            if (Number.isInteger(nextDay) && nextDay >= 1 && nextDay <= 31) {
                output.push(String(ENGLISH_MONTH_VALUES[token]), String(nextDay));
                index += 2;
                continue;
            }
            if (Number.isInteger(previousDay) && previousDay >= 1 && previousDay <= 31) {
                // Canonicalize spoken day-month dates to the same month-day order.
                if (output[output.length - 1] === String(previousDay)) output.pop();
                output.push(String(ENGLISH_MONTH_VALUES[token]), String(previousDay));
                index++;
                continue;
            }
        }
        const digitOrdinal = token.match(/^(\d+)(?:st|nd|rd|th)$/);
        if (digitOrdinal) {
            output.push(digitOrdinal[1]);
            index++;
            continue;
        }
        if (!(token in ENGLISH_NUMBER_VALUES) && !(token in ENGLISH_ORDINAL_VALUES)) {
            output.push(token);
            index++;
            continue;
        }
        let value = 0;
        let current = 0;
        let consumed = 0;
        let ordinal = false;
        while (index + consumed < tokens.length) {
            const part = tokens[index + consumed];
            if (part === 'and' && consumed > 0) { consumed++; continue; }
            if (part === 'hundred' || part === 'thousand') {
                current = (current || 1) * (part === 'hundred' ? 100 : 1000);
                if (part === 'thousand') { value += current; current = 0; }
            } else if (part in ENGLISH_NUMBER_VALUES) {
                current += ENGLISH_NUMBER_VALUES[part];
            } else if (part in ENGLISH_ORDINAL_VALUES) {
                current += ENGLISH_ORDINAL_VALUES[part];
                ordinal = true;
                consumed++;
                break;
            } else {
                break;
            }
            consumed++;
        }
        // Do not merge adjacent standalone cardinal words ("one, two") into 3.
        if (consumed > 1 && !ordinal && !['hundred', 'thousand'].includes(tokens[index + 1])
            && ENGLISH_NUMBER_VALUES[token] < 20 && ENGLISH_NUMBER_VALUES[tokens[index + 1]] < 20) {
            output.push(String(ENGLISH_NUMBER_VALUES[token]));
            index++;
        } else {
            output.push(String(value + current));
            index += consumed || 1;
        }
    }
    return output.join('');
}

function normalizeText(text) {
    return normalizeEnglishNumbers(text).replace(/[^\p{L}\p{N}]/gu, '');
}

function extendPlanForAudienceResponse(plan, keywords) {
    if (!plan?.words?.length || !Number.isInteger(plan.wordEndIdx) || plan.wordEndIdx < 0) return null;
    const matchedWord = plan.words[plan.wordEndIdx];
    if (!matchedWord || !Number.isFinite(matchedWord.end)) return null;
    const latestStart = matchedWord.end + 2;
    for (let index = plan.wordEndIdx + 1; index < plan.words.length; index++) {
        const word = plan.words[index];
        if (!word || !Number.isFinite(word.start) || word.start > latestStart) break;
        if (!keywords.has(normalizeText(word.raw))) continue;
        const end = Math.min(plan.duration || Infinity, word.end + 0.2);
        if (end <= plan.end) return null;
        plan.end = end;
        plan.audienceResponse = { text: word.raw, start: word.start, end: word.end };
        return plan.audienceResponse;
    }
    return null;
}

function splitScriptLines(scriptText) {
    return String(scriptText || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
}

function findRepeatedScriptBlockStarts(allLines, scriptText) {
    const documentLines = (allLines || []).map(normalizeText).filter(Boolean);
    const blockLines = splitScriptLines(scriptText).map(normalizeText).filter(Boolean);
    if (blockLines.length === 0 || blockLines.length > documentLines.length) return [];

    const starts = [];
    for (let start = 0; start <= documentLines.length - blockLines.length; start++) {
        if (blockLines.every((line, offset) => documentLines[start + offset] === line)) {
            starts.push(start + 1);
        }
    }
    return starts.length > 1 ? starts : [];
}

function normalizedEditSimilarity(left, right) {
    const a = normalizeText(left);
    const b = normalizeText(right);
    if (!a || !b) return 0;
    const prev = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = prev[0];
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const old = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = old;
        }
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length, 1);
}

function findFuzzyBoundaryOverlap(scriptWordObjects, recognizedText, side = 'start') {
    const recognizedWords = String(recognizedText || '').split(/\s+/).map(normalizeText).filter(Boolean);
    const scriptEntries = (scriptWordObjects || [])
        .map((word, originalIndex) => ({ normalized: normalizeText(word.raw || word), originalIndex }))
        .filter(entry => entry.normalized);
    const scriptWords = scriptEntries.map(entry => entry.normalized);
    if (!recognizedWords.length || !scriptEntries.length) return 0;
    const maxScriptWords = Math.min(10, scriptEntries.length);
    const maxRecognizedWords = Math.min(10, recognizedWords.length);
    let best = { count: 0, score: 0 };
    for (let scriptCount = 1; scriptCount <= maxScriptWords; scriptCount++) {
        const scriptPart = side === 'start'
            ? scriptWords.slice(0, scriptCount)
            : scriptWords.slice(scriptWords.length - scriptCount);
        for (let recognizedCount = 1; recognizedCount <= maxRecognizedWords; recognizedCount++) {
            const recognizedPart = side === 'start'
                ? recognizedWords.slice(recognizedWords.length - recognizedCount)
                : recognizedWords.slice(0, recognizedCount);
            const scriptJoined = scriptPart.join('');
            const recognizedJoined = recognizedPart.join('');
            const hasCompactScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u
                .test(`${scriptJoined}${recognizedJoined}`);
            if (Math.min(scriptJoined.length, recognizedJoined.length) < (hasCompactScript ? 2 : 5)) continue;
            const lengthRatio = Math.min(scriptJoined.length, recognizedJoined.length) / Math.max(scriptJoined.length, recognizedJoined.length);
            if (lengthRatio < 0.65) continue;
            const score = normalizedEditSimilarity(scriptJoined, recognizedJoined);
            if (score >= 0.82 && (scriptCount > best.count || (scriptCount === best.count && score > best.score))) {
                best = { count: scriptCount, score };
            }
        }
    }
    if (!best.count) return 0;
    return side === 'start'
        ? scriptEntries[best.count - 1].originalIndex + 1
        : scriptWordObjects.length - scriptEntries[scriptEntries.length - best.count].originalIndex;
}

async function buildManualTranscription(clipPath, fullText) {
    let duration = 60;
    try {
        duration = await ffmpegService.getDuration(clipPath) || 60;
    } catch {}

    let rawWords;
    if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(fullText)) {
        rawWords = String(fullText || '').split('').map(char => char.trim()).filter(Boolean);
    } else {
        rawWords = String(fullText || '').split(/\s+/).filter(Boolean);
    }

    const count = rawWords.length;
    const words = [];
    for (let j = 0; j < count; j++) {
        const wordStart = (duration / count) * j;
        const wordEnd = (duration / count) * (j + 1);
        words.push({
            word: rawWords[j],
            start: wordStart,
            end: wordEnd,
            score: 0.99,
            confidence: 0.99
        });
    }

    const wordTimeInfo = [{
        text: fullText,
        audio_start: 0,
        audio_end: duration,
        words
    }];
    return {
        wordTimeInfo,
        fullText,
        source: 'manual_transcript'
    };
}

function flattenWords(wordTimeInfo) {
    const words = [];
    for (const seg of wordTimeInfo || []) {
        for (const w of seg.words || []) {
            const raw = String(w.word || '').trim();
            const norm = normalizeText(raw);
            const start = Number(w.start);
            const end = Number(w.end);
            if (!raw || !norm || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
            // 手动 SRT 会在每个词上带上所属字幕条目的原始时间码。
            // 普通 API 词级转录没有这两个字段，仍沿用原有的词级切点。
            const srtStart = Number(w.srtStart);
            const srtEnd = Number(w.srtEnd);
            words.push({
                raw, norm, start, end, score: w.score || 0,
                srtStart: Number.isFinite(srtStart) ? srtStart : null,
                srtEnd: Number.isFinite(srtEnd) ? srtEnd : null,
            });
        }
    }
    return words;
}

/**
 * 手动 SRT 的词内时间是为了匹配而平均分配的，不能拿它作为最终裁点。
 * 命中手动 SRT 时，以首尾命中词所属字幕条目的原始 timecode 裁切，
 * 从而保证剪辑边界与用户提供的 SRT 完全一致。
 */
function getManualSrtCutRange(words, startIdx, endIdx, duration) {
    const first = words?.[startIdx];
    const last = words?.[endIdx];
    if (!first || !last || !Number.isFinite(first.srtStart) || !Number.isFinite(last.srtEnd)) return null;
    const start = Math.max(0, first.srtStart);
    const end = Math.min(Number.isFinite(duration) && duration > 0 ? duration : last.srtEnd, last.srtEnd);
    return end > start ? { start, end } : null;
}

function lcsLength(a, b) {
    if (!a || !b) return 0;
    const prev = new Array(b.length + 1).fill(0);
    const cur = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        }
        for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
}

function scoreCandidate(candidate, targetNorm) {
    if (!candidate || !targetNorm) return 0;
    if (candidate === targetNorm) return 1;
    const containsBonus = candidate.includes(targetNorm) || targetNorm.includes(candidate) ? 0.08 : 0;
    const lcs = lcsLength(candidate, targetNorm);
    const base = lcs / Math.max(candidate.length, targetNorm.length);
    const lenPenalty = Math.abs(candidate.length - targetNorm.length) / Math.max(candidate.length, targetNorm.length, 1);
    return Math.max(0, Math.min(1, base + containsBonus - lenPenalty * 0.12));
}

// “可匹配”允许省词或短句嵌在长句中；“整段视频重复”则不能使用同一宽松标准。
// 否则相邻两个连续朗读的素材只要重叠约 80%，就会被错误标成重复片段。
function isLikelyDuplicateTranscription(left, right) {
    if (!left || !right || left.length < 12 || right.length < 12) return false;
    const lengthRatio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
    return lengthRatio >= 0.9 && scoreCandidate(left, right) >= 0.92;
}

function wordLcsLength(a, b) {
    if (!a || !b || a.length === 0 || b.length === 0) return 0;
    const prev = new Array(b.length + 1).fill(0);
    const cur = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        }
        for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
}

function scoreWordCandidate(candidateWords, targetWords) {
    const lcs = wordLcsLength(candidateWords, targetWords);
    if (lcs === 0) return 0;
    const precision = lcs / candidateWords.length;
    const recall = lcs / targetWords.length;
    const f1 = (2 * precision * recall) / (precision + recall);
    const candidateSet = new Set(candidateWords);
    const distinctive = targetWords.filter(word => word.length >= 4 || /\d/.test(word));
    const keywordRecall = distinctive.length
        ? distinctive.filter(word => candidateSet.has(word)).length / distinctive.length
        : recall;
    const lengthRatio = Math.min(candidateWords.length, targetWords.length) / Math.max(candidateWords.length, targetWords.length, 1);
    
    let penalty = 0;
    if (candidateWords.length > 0) {
        if (!targetWords.includes(candidateWords[0])) {
            penalty += 0.08;
        }
        if (!targetWords.includes(candidateWords[candidateWords.length - 1])) {
            penalty += 0.08;
        }
    }
    return Math.max(0, Math.min(1, f1 * 0.7 + keywordRecall * 0.2 + lengthRatio * 0.1 - penalty));
}

function findBestWordWindow(words, targetText, minScore = 0.52) {
    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(targetText);

    if (!hasCJK) {
        // Spaced languages (English, etc.): Word-based matching
        const targetWords = String(targetText || '').split(/\s+/).map(w => normalizeText(w)).filter(Boolean);
        if (targetWords.length === 0 || words.length === 0) return null;

        const scriptWordsNorm = words.map(w => w.norm);

        // 1. Exact subarray match
        const targetStr = targetWords.join(' ');
        for (let i = 0; i <= scriptWordsNorm.length - targetWords.length; i++) {
            const sub = scriptWordsNorm.slice(i, i + targetWords.length).join(' ');
            if (sub === targetStr) {
                return {
                    startIdx: i,
                    endIdx: i + targetWords.length - 1,
                    score: 1.0,
                    matchedText: words.slice(i, i + targetWords.length).map(w => w.raw).join(' ')
                };
            }
        }

        // 2. LCS based sliding window
        let best = null;
        const targetLen = targetWords.length;
        const minLen = Math.max(1, Math.floor(targetLen * 0.45));
        const maxLen = Math.max(targetLen + 4, Math.ceil(targetLen * 1.5));

        for (let i = 0; i < scriptWordsNorm.length; i++) {
            for (let j = i; j < scriptWordsNorm.length; j++) {
                const len = j - i + 1;
                if (len > maxLen) break;
                if (len < minLen) continue;
                const candidateWords = scriptWordsNorm.slice(i, j + 1);
                const score = scoreWordCandidate(candidateWords, targetWords);
                if (!best || score > best.score) {
                    best = {
                        startIdx: i,
                        endIdx: j,
                        score,
                        matchedText: words.slice(i, j + 1).map(w => w.raw).join(' '),
                    };
                }
            }
        }
        return best && best.score >= minScore ? best : null;
    } else {
        // Original character-based matching for CJK
        const targetNorm = normalizeText(targetText);
        if (!targetNorm || words.length === 0) return null;

        const fullText = words.map(w => w.norm).join('');
        const exactOffset = fullText.indexOf(targetNorm);
        if (exactOffset >= 0) {
            let cursor = 0;
            let startIdx = 0;
            let endIdx = words.length - 1;
            for (let i = 0; i < words.length; i++) {
                const next = cursor + words[i].norm.length;
                if (exactOffset >= cursor && exactOffset < next) startIdx = i;
                if (exactOffset + targetNorm.length > cursor && exactOffset + targetNorm.length <= next) {
                    endIdx = i;
                    break;
                }
                cursor = next;
            }
            return {
                startIdx,
                endIdx,
                score: 1,
                matchedText: words.slice(startIdx, endIdx + 1).map(w => w.raw).join(' '),
            };
        }

        let best = null;
        const minChars = Math.max(1, Math.floor(targetNorm.length * 0.45));
        const maxChars = Math.max(targetNorm.length + 12, Math.ceil(targetNorm.length * 1.9));

        for (let i = 0; i < words.length; i++) {
            let candidate = '';
            for (let j = i; j < words.length; j++) {
                candidate += words[j].norm;
                if (candidate.length > maxChars) break;
                if (candidate.length < minChars) continue;
                const score = scoreCandidate(candidate, targetNorm);
                if (!best || score > best.score) {
                    best = {
                        startIdx: i,
                        endIdx: j,
                        score,
                        matchedText: words.slice(i, j + 1).map(w => w.raw).join(' '),
                    };
                }
            }
        }
        return best && best.score >= minScore ? best : null;
    }
}

function findBestWordWindowAvoidingRanges(words, targetText, minScore = 0.52, blockedRanges = [], globalOffset = 0) {
    const overlapRatio = (startIdx, endIdx) => {
        if (!blockedRanges.length || endIdx < startIdx) return 0;
        let overlap = 0;
        for (const range of blockedRanges) {
            const s = Math.max(globalOffset + startIdx, range.start);
            const e = Math.min(globalOffset + endIdx, range.end);
            if (e >= s) overlap += e - s + 1;
        }
        return overlap / Math.max(1, endIdx - startIdx + 1);
    };

    const scoreWithOverlap = (baseScore, startIdx, endIdx) => {
        const overlap = overlapRatio(startIdx, endIdx);
        return baseScore - Math.min(0.75, overlap * 0.75);
    };

    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(targetText);
    let best = null;

    if (!hasCJK) {
        const targetWords = String(targetText || '').split(/\s+/).map(w => normalizeText(w)).filter(Boolean);
        if (targetWords.length === 0 || words.length === 0) return null;
        const scriptWordsNorm = words.map(w => w.norm);
        const targetLen = targetWords.length;
        const minLen = Math.max(1, Math.floor(targetLen * 0.45));
        const maxLen = Math.max(targetLen + 4, Math.ceil(targetLen * 1.5));

        for (let i = 0; i < scriptWordsNorm.length; i++) {
            for (let j = i; j < scriptWordsNorm.length; j++) {
                const len = j - i + 1;
                if (len > maxLen) break;
                if (len < minLen) continue;
                const candidateWords = scriptWordsNorm.slice(i, j + 1);
                const baseScore = candidateWords.join(' ') === targetWords.join(' ')
                    ? 1
                    : scoreWordCandidate(candidateWords, targetWords);
                if (baseScore < minScore) continue;
                const adjustedScore = scoreWithOverlap(baseScore, i, j);
                if (!best || adjustedScore > best.adjustedScore || (adjustedScore === best.adjustedScore && baseScore > best.score)) {
                    best = {
                        startIdx: i,
                        endIdx: j,
                        score: baseScore,
                        adjustedScore,
                        matchedText: words.slice(i, j + 1).map(w => w.raw).join(' '),
                    };
                }
            }
        }
    } else {
        const targetNorm = normalizeText(targetText);
        if (!targetNorm || words.length === 0) return null;
        const minChars = Math.max(1, Math.floor(targetNorm.length * 0.45));
        const maxChars = Math.max(targetNorm.length + 12, Math.ceil(targetNorm.length * 1.9));

        for (let i = 0; i < words.length; i++) {
            let candidate = '';
            for (let j = i; j < words.length; j++) {
                candidate += words[j].norm;
                if (candidate.length > maxChars) break;
                if (candidate.length < minChars) continue;
                const baseScore = candidate === targetNorm ? 1 : scoreCandidate(candidate, targetNorm);
                if (baseScore < minScore) continue;
                const adjustedScore = scoreWithOverlap(baseScore, i, j);
                if (!best || adjustedScore > best.adjustedScore || (adjustedScore === best.adjustedScore && baseScore > best.score)) {
                    best = {
                        startIdx: i,
                        endIdx: j,
                        score: baseScore,
                        adjustedScore,
                        matchedText: words.slice(i, j + 1).map(w => w.raw).join(' '),
                    };
                }
            }
        }
    }

    return best && best.adjustedScore >= Math.max(0.18, minScore * 0.55) ? best : null;
}

function recognizedNormFromWords(words) {
    return (words || []).map(w => w.norm).join('');
}

function findBestScriptWindowForClip(words, lines, minScore = 0.52) {
    const clipNorm = recognizedNormFromWords(words);
    if (!clipNorm || !Array.isArray(lines) || lines.length === 0) return null;

    let best = null;
    const clipLen = clipNorm.length;
    const maxTargetChars = Math.max(clipLen + 80, Math.ceil(clipLen * 2.2), 20);
    const minTargetChars = Math.max(1, Math.floor(clipLen * 0.25));

    for (let startLine = 0; startLine < lines.length; startLine++) {
        let targetText = '';
        let targetNorm = '';
        for (let endLine = startLine; endLine < lines.length; endLine++) {
            targetText = targetText ? `${targetText}\n${lines[endLine]}` : lines[endLine];
            targetNorm += normalizeText(lines[endLine]);
            if (!targetNorm) continue;
            if (targetNorm.length > maxTargetChars) break;

            const window = findBestWordWindow(words, targetText, minScore);
            if (!window) continue;

            const lengthScore = 1 - Math.min(1, Math.abs(targetNorm.length - clipLen) / Math.max(targetNorm.length, clipLen, 1));
            const rangePenalty = Math.max(0, endLine - startLine) * 0.006;
            const thresholdPenalty = window.score < minScore ? (minScore - window.score) * 0.18 : 0;
            const score = Math.max(0, Math.min(1, window.score * 0.74 + lengthScore * 0.26 - rangePenalty - thresholdPenalty));

            if (targetNorm.length < minTargetChars && score < 0.98) continue;
            if (!best || score > best.score) {
                best = {
                    startLine,
                    endLine,
                    text: targetText,
                    targetNorm,
                    score,
                    wordWindow: window,
                    matchedText: window.matchedText,
                    lengthScore,
                };
            }
        }
    }

    if (best) return best;
    const fallback = findBestWordWindow(words, lines.join('\n'), minScore);
    if (!fallback) return null;
    return {
        startLine: 0,
        endLine: lines.length - 1,
        text: lines.join('\n'),
        targetNorm: normalizeText(lines.join('\n')),
        score: fallback.score,
        wordWindow: fallback,
        matchedText: fallback.matchedText,
        lengthScore: 0,
    };
}

function clampMs(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function buildLineSubtitleItems({ lines, lineStart, lineEnd, words, clipStartSec, cutDurationSec, timelineStartMs, minScore }) {
    const items = [];
    const scopedWords = words.slice(lineStart, lineEnd + 1);
    const totalMs = Math.max(1, Math.round(cutDurationSec * 1000));
    const lineCount = Math.max(1, lines.length);
    let cursor = 0;
    let lastEnd = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const searchWords = scopedWords.slice(cursor);
        const match = searchWords.length
            ? findBestWordWindow(searchWords, line, Math.max(0.1, minScore * 0.45))
            : null;
        let localStart;
        let localEnd;

        if (match && searchWords[match.startIdx] && searchWords[match.endIdx] && match.score >= 0.28) {
            localStart = Math.round((searchWords[match.startIdx].start - clipStartSec) * 1000);
            localEnd = Math.round((searchWords[match.endIdx].end - clipStartSec) * 1000);
            cursor = Math.max(cursor + 1, cursor + match.endIdx + 1);
        } else {
            localStart = Math.round((totalMs / lineCount) * i);
            localEnd = Math.round((totalMs / lineCount) * (i + 1));
        }

        localStart = clampMs(localStart, 0, totalMs - 1);
        localEnd = clampMs(localEnd, localStart + 1, totalMs);
        if (localStart < lastEnd) localStart = Math.min(lastEnd, totalMs - 1);
        if (localEnd <= localStart) localEnd = Math.min(totalMs, localStart + Math.max(1, Math.round(totalMs / lineCount)));
        lastEnd = localEnd;

        items.push({
            start: timelineStartMs + localStart,
            end: timelineStartMs + localEnd,
            text: line,
        });
    }

    return items;
}

function computeAutoEditTransitionSec(prevDuration, currentDuration, transitionType, requestedDuration) {
    if (!transitionType || transitionType === 'none') return 0;
    const req = Math.max(0, Math.min(3, Number(requestedDuration) || 0));
    if (req <= 0.03) return 0;
    const safe = Math.min(req, Number(prevDuration || 0) * 0.45, Number(currentDuration || 0) * 0.45);
    return safe > 0.05 ? safe : 0;
}

function hasSentenceEndingPunctuation(text) {
    return /[.!?。！？][\s"'”’)\]]*$/.test(String(text || ''));
}

function normalizeAutoEditSpeed(value) {
    const speed = Number(value);
    return Number.isFinite(speed) && speed >= 0.25 && speed <= 4 ? speed : 1;
}

// 裁切缓存不能只靠路径或文件名：原素材被同名覆盖时必须失效。读取首尾各
// 64KB 加上大小、修改时间，成本很低且能可靠识别正常剪辑流程中的素材变化。
function getAutoEditClipFingerprint(clipPath) {
    try {
        const stat = fs.statSync(clipPath);
        const hash = crypto.createHash('sha256');
        hash.update(`${path.resolve(clipPath)}|${stat.size}|${Math.round(stat.mtimeMs)}`);
        const sampleSize = Math.min(64 * 1024, stat.size);
        if (sampleSize > 0) {
            const fd = fs.openSync(clipPath, 'r');
            try {
                const head = Buffer.alloc(sampleSize);
                fs.readSync(fd, head, 0, sampleSize, 0);
                hash.update(head);
                if (stat.size > sampleSize) {
                    const tail = Buffer.alloc(sampleSize);
                    fs.readSync(fd, tail, 0, sampleSize, Math.max(0, stat.size - sampleSize));
                    hash.update(tail);
                }
            } finally { fs.closeSync(fd); }
        }
        return hash.digest('hex');
    } catch (_) {
        return `unavailable:${String(clipPath || '')}`;
    }
}

function readAutoEditCutCache(cacheDir) {
    const manifestPath = path.join(cacheDir, '裁切缓存清单.json');
    try {
        const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const entries = Array.isArray(data?.entries) ? data.entries : [];
        return new Map(entries.filter(item => item?.signature && item?.path && fs.existsSync(item.path))
            .map(item => [item.signature, item]));
    } catch (_) {
        return new Map();
    }
}

function writeAutoEditCutCache(cacheDir, entries) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const manifestPath = path.join(cacheDir, '裁切缓存清单.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
        version: 1,
        updated_at: new Date().toISOString(),
        entries: [...entries.values()],
    }, null, 2), 'utf8');
}

function extendPlanAtBoundary(plan, targetText, side, leadPad, tailPad) {
    if (!plan || !Array.isArray(plan.words) || plan.words.length === 0 || !normalizeText(targetText)) return null;
    let sliceStart;
    let sliceEnd;
    if (side === 'previous') {
        if (!Number.isInteger(plan.wordEndIdx) || plan.wordEndIdx < 0) return null;
        sliceStart = plan.wordEndIdx + 1;
        sliceEnd = Math.min(plan.words.length, sliceStart + 4);
    } else {
        if (!Number.isInteger(plan.wordStartIdx) || plan.wordStartIdx < 0) return null;
        sliceStart = Math.max(0, plan.wordStartIdx - 4);
        sliceEnd = plan.wordStartIdx;
    }
    const nearby = plan.words.slice(sliceStart, sliceEnd);
    if (nearby.length === 0) return null;

    let match = findBestWordWindow(nearby, targetText, 0.72);
    if (!match) {
        const targetNorm = normalizeText(targetText);
        let best = null;
        for (let startIdx = 0; startIdx < nearby.length; startIdx++) {
            for (let endIdx = startIdx; endIdx < nearby.length; endIdx++) {
                const candidateNorm = nearby.slice(startIdx, endIdx + 1).map(word => word.norm).join('');
                const lengthRatio = Math.min(candidateNorm.length, targetNorm.length) / Math.max(candidateNorm.length, targetNorm.length, 1);
                if (lengthRatio < 0.65) continue;
                const score = normalizedEditSimilarity(candidateNorm, targetNorm);
                if (score >= 0.82 && (!best || score > best.score)) best = { startIdx, endIdx, score };
            }
        }
        match = best;
    }
    if (!match) return null;

    const globalStart = sliceStart + match.startIdx;
    const globalEnd = sliceStart + match.endIdx;
    if (side === 'previous' && globalStart !== plan.wordEndIdx + 1) return null;
    if (side === 'next' && globalEnd !== plan.wordStartIdx - 1) return null;

    if (side === 'previous') {
        plan.wordEndIdx = globalEnd;
        const srtRange = getManualSrtCutRange(plan.words, plan.wordStartIdx, globalEnd, plan.duration);
        plan.end = srtRange ? srtRange.end : Math.min(plan.duration || Infinity, plan.words[globalEnd].end + tailPad);
    } else {
        plan.wordStartIdx = globalStart;
        const srtRange = getManualSrtCutRange(plan.words, globalStart, plan.wordEndIdx, plan.duration);
        plan.start = srtRange ? srtRange.start : Math.max(0, plan.words[globalStart].start - leadPad);
    }
    return { globalStart, globalEnd, score: match.score };
}

/**
 * Recover a very small script gap at the boundary of two otherwise matched clips.
 * This is deliberately conservative: it only handles one or two words, requires
 * those words to be found close to an existing cut, and uses punctuation only to
 * decide which neighbouring clip gets first refusal.
 */
function recoverSmallBoundaryGaps(plans, scriptWords, leadPad, tailPad) {
    const recoveries = [];
    if (!Array.isArray(plans) || !Array.isArray(scriptWords)) return recoveries;

    const tryAttach = (plan, gapStart, gapEnd, side) => {
        if (!plan || !Array.isArray(plan.words) || plan.words.length === 0) return null;
        const target = scriptWords.slice(gapStart, gapEnd + 1).map(w => w.raw).join(' ');
        const extension = extendPlanAtBoundary(plan, target, side, leadPad, tailPad);
        if (!extension) return null;
        const { globalStart, globalEnd } = extension;

        if (side === 'previous') {
            plan.scriptWordEnd = gapEnd;
        } else {
            plan.scriptWordStart = gapStart;
        }
        const gapWords = scriptWords.slice(gapStart, gapEnd + 1);
        for (let offset = 0; offset < gapWords.length; offset++) {
            const clipIdx = Math.min(globalEnd, globalStart + offset);
            plan.matchedWordsArray.push({ scriptWordIdx: gapWords[offset].wordIndex, clipWordIdx: clipIdx });
        }
        return { side, target, score: extension.score };
    };

    const matched = plans.filter(plan => plan.scriptWordStart >= 0 && plan.scriptWordEnd >= 0)
        .sort((a, b) => a.scriptWordStart - b.scriptWordStart);
    for (let i = 0; i < matched.length - 1; i++) {
        const previous = matched[i];
        const next = matched[i + 1];
        const gapStart = previous.scriptWordEnd + 1;
        const gapEnd = next.scriptWordStart - 1;
        const gapSize = gapEnd - gapStart + 1;
        if (gapSize < 1 || gapSize > 2) continue;

        const previousRaw = scriptWords[previous.scriptWordEnd]?.raw || '';
        const gapRaw = scriptWords.slice(gapStart, gapEnd + 1).map(w => w.raw).join(' ');
        const preferPrevious = !hasSentenceEndingPunctuation(previousRaw) || hasSentenceEndingPunctuation(gapRaw);
        const order = preferPrevious
            ? [[previous, 'previous'], [next, 'next']]
            : [[next, 'next'], [previous, 'previous']];
        for (const [plan, side] of order) {
            const recovered = tryAttach(plan, gapStart, gapEnd, side);
            if (recovered) {
                recoveries.push({ gapStart, gapEnd, sourceIndex: plan.sourceIndex, ...recovered });
                break;
            }
        }
    }
    return recoveries;
}

/**
 * Consecutive source clips can both contain a little of the sentence at their
 * shared boundary (ASR commonly hears the next sentence at the tail of the
 * previous clip).  Keep that boundary text with the later clip, rather than
 * exporting it twice.  This intentionally does not touch a true full duplicate
 * clip: those two plans begin at the same script position and remain reviewable.
 */
function trimOverlappingBoundaryReadings(plans, scriptWords, leadPad, tailPad) {
    const trimmed = [];
    const ordered = (plans || []).filter(plan => plan?.scriptWordStart >= 0 && plan?.scriptWordEnd >= plan.scriptWordStart)
        .slice().sort((a, b) => a.sourceIndex - b.sourceIndex);
    for (let index = 0; index < ordered.length - 1; index++) {
        const previous = ordered[index];
        const next = ordered[index + 1];
        const overlapStart = Math.max(previous.scriptWordStart, next.scriptWordStart);
        const overlapEnd = Math.min(previous.scriptWordEnd, next.scriptWordEnd);
        // Only trim a tail duplicated by the immediately following source clip.
        if (overlapStart !== next.scriptWordStart || overlapEnd !== previous.scriptWordEnd
            || previous.scriptWordStart >= next.scriptWordStart
            || !Array.isArray(previous.matchedWordsArray) || previous.matchedWordsArray.length === 0) continue;
        const firstRepeated = previous.matchedWordsArray
            .filter(pair => pair.scriptWordIdx >= overlapStart)
            .sort((a, b) => a.clipWordIdx - b.clipWordIdx)[0];
        const lastKept = previous.matchedWordsArray
            .filter(pair => pair.scriptWordIdx < overlapStart)
            .sort((a, b) => b.clipWordIdx - a.clipWordIdx)[0];
        if (!firstRepeated || !lastKept || lastKept.clipWordIdx < previous.wordStartIdx) continue;

        const previousEndBeforeTrim = previous.end;
        previous.scriptWordEnd = overlapStart - 1;
        previous.wordEndIdx = lastKept.clipWordIdx;
        previous.matchedWordsArray = previous.matchedWordsArray.filter(pair => pair.scriptWordIdx < overlapStart);
        const srtRange = getManualSrtCutRange(previous.words, previous.wordStartIdx, previous.wordEndIdx, previous.duration);
        previous.end = srtRange ? srtRange.end : Math.min(previous.duration || Infinity, previous.words[previous.wordEndIdx].end + tailPad);
        trimmed.push({
            id: `boundary-${previous.sourceIndex + 1}-${next.sourceIndex + 1}-${overlapStart}-${overlapEnd}`,
            previous: previous.sourceIndex,
            next: next.sourceIndex,
            previous_source_index: previous.sourceIndex + 1,
            next_source_index: next.sourceIndex + 1,
            script_word_start: overlapStart,
            script_word_end: overlapEnd,
            text: scriptWords.slice(overlapStart, overlapEnd + 1).map(word => word.raw).join(' '),
            word_count: overlapEnd - overlapStart + 1,
            wordCount: overlapEnd - overlapStart + 1,
            assignment: 'next',
            confirmed: false,
            previous_end_before_trim: previousEndBeforeTrim,
            previous_end_after_trim: previous.end,
        });
    }
    return trimmed;
}

function getWordLineIndex(wordsList, idx) {
    if (!Array.isArray(wordsList) || idx === undefined || idx === null || idx < 0 || idx >= wordsList.length) return -1;
    return typeof wordsList[idx]?.lineIndex === 'number' ? wordsList[idx].lineIndex : -1;
}

function srtAssPath(p) {
    return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function extractUtterances(data) {
    if (Array.isArray(data)) return data;
    if (!data) return [];

    let utterances = null;
    if (data.result?.transcription?.utterances) {
        utterances = data.result.transcription.utterances;
    } else if (Array.isArray(data.results)) {
        utterances = data.results;
    } else if (data.transcription?.utterances) {
        utterances = data.transcription.utterances;
    } else if (Array.isArray(data.result?.transcription)) {
        utterances = data.result.transcription;
    } else if (Array.isArray(data.result?.utterances)) {
        utterances = data.result.utterances;
    }

    if (Array.isArray(utterances)) {
        return utterances.map(item => {
            const words = (item.words || []).map(w => ({
                word: w.word || '',
                start: w.start !== undefined ? w.start : (w.time_begin || 0),
                end: w.end !== undefined ? w.end : (w.time_end || 0),
                score: w.confidence !== undefined ? w.confidence : (w.score || 0)
            }));
            return {
                text: item.text || item.transcription || '',
                audio_start: item.start !== undefined ? item.start : (item.time_begin || 0),
                audio_end: item.end !== undefined ? item.end : (item.time_end || 0),
                words
            };
        });
    }
    return [];
}

async function transcribeClip(clipPath, language, transcriptionConfig, cacheDir, force, manualSubtitlePath, signal = null, savedTranscriptionDir = '', onProgress = null) {
    if (signal?.aborted) throw new Error('任务已停止');
    // 如果用户手动指定了字幕文件路径
    if (manualSubtitlePath && fs.existsSync(manualSubtitlePath)) {
        const ext = path.parse(manualSubtitlePath).ext.toLowerCase();
        try {
            console.log(`[自动剪辑] 使用用户界面手动指定的字幕文件: ${manualSubtitlePath}`);
            if (ext === '.srt') {
                const srtContent = fs.readFileSync(manualSubtitlePath, 'utf-8');
                const items = subtitleService.parseSRT(srtContent);
                const wordTimeInfo = [];
                const fullTextList = [];
                for (const item of items) {
                    const startSec = item.start / 1000;
                    const endSec = item.end / 1000;
                    fullTextList.push(item.text);

                    let rawWords;
                    if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(item.text)) {
                        rawWords = item.text.split('').map(char => char.trim()).filter(Boolean);
                    } else {
                        rawWords = item.text.split(/\s+/).filter(Boolean);
                    }

                    const count = rawWords.length;
                    const duration = endSec - startSec;
                    const words = [];
                    for (let j = 0; j < count; j++) {
                        const wordStart = startSec + (count > 0 ? (duration / count) * j : 0);
                        const wordEnd = startSec + (count > 0 ? (duration / count) * (j + 1) : 0);
                        words.push({
                            word: rawWords[j],
                            start: wordStart,
                            end: wordEnd,
                            srtStart: startSec,
                            srtEnd: endSec,
                            score: 0.99,
                            confidence: 0.99
                        });
                    }

                    wordTimeInfo.push({
                        text: item.text,
                        audio_start: startSec,
                        audio_end: endSec,
                        words
                    });
                }

                return {
                    wordTimeInfo,
                    fullText: fullTextList.join(' '),
                    source: 'manual_srt'
                };
            } else if (ext === '.json') {
                const rawData = JSON.parse(fs.readFileSync(manualSubtitlePath, 'utf-8'));
                const wordTimeInfo = extractUtterances(rawData);
                const txtPath = manualSubtitlePath.replace(/\.json$/i, '.txt');
                let fullText = '';
                if (fs.existsSync(txtPath)) {
                    fullText = fs.readFileSync(txtPath, 'utf-8').trim();
                } else {
                    fullText = wordTimeInfo.map(utterance => utterance.text || '').join(' ').trim();
                }
                return {
                    wordTimeInfo,
                    fullText,
                    source: 'manual',
                };
            } else if (ext === '.txt') {
                const fullText = fs.readFileSync(manualSubtitlePath, 'utf-8').trim();
                let duration = 60;
                try {
                    const ffmpegService = require('./ffmpeg');
                    duration = await ffmpegService.getDuration(clipPath) || 60;
                } catch {}

                let rawWords;
                if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(fullText)) {
                    rawWords = fullText.split('').map(char => char.trim()).filter(Boolean);
                } else {
                    rawWords = fullText.split(/\s+/).filter(Boolean);
                }

                const count = rawWords.length;
                const words = [];
                for (let j = 0; j < count; j++) {
                    const wordStart = (duration / count) * j;
                    const wordEnd = (duration / count) * (j + 1);
                    words.push({
                        word: rawWords[j],
                        start: wordStart,
                        end: wordEnd,
                        srtStart: startSec,
                        srtEnd: endSec,
                        score: 0.99,
                        confidence: 0.99
                    });
                }

                const wordTimeInfo = [{
                    text: fullText,
                    audio_start: 0,
                    audio_end: duration,
                    words
                }];

                return {
                    wordTimeInfo,
                    fullText,
                    source: 'manual_txt'
                };
            }
        } catch (err) {
            console.error(`[自动剪辑] 解析手动指定的字幕文件 ${manualSubtitlePath} 失败:`, err);
        }
    }

    // 支持手动指定转录结果文件：检查视频同目录下是否存在同名或带有 _transcription 后缀的 .json 和 .txt 文件
    const parsed = path.parse(clipPath);
    const savedDir = String(savedTranscriptionDir || '').trim();
    const manualJsonPaths = [
        path.join(parsed.dir, `${parsed.name}_transcription.json`),
        path.join(parsed.dir, `${parsed.name}.json`),
        // 文案自动剪辑会把每段识别结果保存到 _auto_edit。此前重新打开
        // 同一套素材再分析时只查临时缓存，应用重启后缓存不存在便会整套重转。
        // 把该工程目录作为可信旁车来源，可直接恢复已有逐词时间轴。
        ...(savedDir && path.resolve(savedDir) !== path.resolve(parsed.dir)
            ? [path.join(savedDir, `${parsed.name}_transcription.json`)] : [])
    ];
    const manualTxtPaths = [
        path.join(parsed.dir, `${parsed.name}_transcription.txt`),
        path.join(parsed.dir, `${parsed.name}.txt`),
        ...(savedDir && path.resolve(savedDir) !== path.resolve(parsed.dir)
            ? [path.join(savedDir, `${parsed.name}_transcription.txt`)] : [])
    ];

    let foundJson = manualJsonPaths.find(p => fs.existsSync(p));
    let foundTxt = manualTxtPaths.find(p => fs.existsSync(p));

    // “重新转录”应跳过自动发现的同名旁车文件；否则之前生成的空
    // _transcription.json/.txt 会永远覆盖新的接口识别结果。
    // 用户在界面中明确选择的 manualSubtitlePath 已在上方处理，不受影响。
    if (!force && foundJson && foundTxt) {
        try {
            console.log(`[自动剪辑] 检测到同名本地手动转录文件，跳过 API 识别: ${foundJson}`);
            const rawData = JSON.parse(fs.readFileSync(foundJson, 'utf-8'));
            const wordTimeInfo = extractUtterances(rawData);
            const fullText = fs.readFileSync(foundTxt, 'utf-8').trim();
            if (fullText && wordTimeInfo.length > 0) {
                return { wordTimeInfo, fullText, source: 'manual' };
            }
            console.warn(`[自动剪辑] 自动发现的同名转录文件为空，将忽略并调用接口: ${foundJson}`);
        } catch (readErr) {
            console.error(`[自动剪辑] 读取手动转录文件失败:`, readErr);
        }
    }

    const manualSrtPaths = [
        path.join(parsed.dir, `${parsed.name}_transcription.srt`),
        path.join(parsed.dir, `${parsed.name}.srt`)
    ];
    let foundSrt = manualSrtPaths.find(p => fs.existsSync(p));

    if (!force && foundSrt) {
        try {
            console.log(`[自动剪辑] 检测到同名本地手动 SRT 文件，跳过 API 识别: ${foundSrt}`);
            const srtContent = fs.readFileSync(foundSrt, 'utf-8');
            const items = subtitleService.parseSRT(srtContent);
            const wordTimeInfo = [];
            const fullTextList = [];

            for (const item of items) {
                const startSec = item.start / 1000;
                const endSec = item.end / 1000;
                fullTextList.push(item.text);

                let rawWords;
                if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(item.text)) {
                    rawWords = item.text.split('').map(char => char.trim()).filter(Boolean);
                } else {
                    rawWords = item.text.split(/\s+/).filter(Boolean);
                }

                const count = rawWords.length;
                const duration = endSec - startSec;
                const words = [];
                for (let j = 0; j < count; j++) {
                    const wordStart = startSec + (count > 0 ? (duration / count) * j : 0);
                    const wordEnd = startSec + (count > 0 ? (duration / count) * (j + 1) : 0);
                    words.push({
                        word: rawWords[j],
                        start: wordStart,
                        end: wordEnd,
                        score: 0.99,
                        confidence: 0.99
                    });
                }

                wordTimeInfo.push({
                    text: item.text,
                    audio_start: startSec,
                    audio_end: endSec,
                    words
                });
            }

            const fullText = fullTextList.join(' ').trim();
            if (fullText && wordTimeInfo.length > 0) {
                return { wordTimeInfo, fullText, source: 'manual_srt' };
            }
            console.warn(`[自动剪辑] 自动发现的同名 SRT 为空，将忽略并调用接口: ${foundSrt}`);
        } catch (readErr) {
            console.error(`[自动剪辑] 读取/解析手动 SRT 文件失败:`, readErr);
        }
    }

    fs.mkdirSync(cacheDir, { recursive: true });
    const stat = fs.statSync(clipPath);
    // 缓存必须与首选平台绑定。否则从 Deepgram 切到 Groq/Gladia 后会继续
    // 命中旧平台的结果，表面看起来像“切换平台没有生效”。v2 同时隔离旧格式缓存。
    const cacheProvider = Array.isArray(transcriptionConfig)
        ? 'gladia-legacy'
        : String(transcriptionConfig?.primary || 'auto').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const cacheKey = crypto
        .createHash('sha1')
        .update(`v2|${cacheProvider}|${clipPath}|${stat.size}|${Math.floor(stat.mtimeMs)}`)
        .digest('hex')
        .slice(0, 12);
    const baseName = path.parse(clipPath).name.replace(/[^\w.-]+/g, '_');
    let langCode = 'auto';
    let langEnName = 'auto';
    if (language && language !== 'auto') {
        langCode = language;
        for (const [code, info] of Object.entries(subtitleUtils.LANGUAGES)) {
            if (info.name === language || info.code === language) {
                langCode = code;
                langEnName = info.language;
                break;
            }
        }
        if (langEnName === 'auto') {
            langEnName = subtitleUtils.getLanguage(langCode) || langCode;
        }
    }
    const jsonPath = path.join(cacheDir, `${langCode}_${baseName}_${cacheKey}_autoedit.json`);
    const txtPath = path.join(cacheDir, `${langCode}_${baseName}_${cacheKey}_autoedit.txt`);

    if (!force && fs.existsSync(jsonPath) && fs.existsSync(txtPath)) {
        const cachedText = fs.readFileSync(txtPath, 'utf-8').trim();
        let cachedWords = [];
        try {
            cachedWords = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        } catch (cacheErr) {
            console.warn(`[自动剪辑] 转录缓存损坏，将重新识别: ${txtPath}`, cacheErr.message);
        }
        // 空结果来自接口偶发异常、上传失败或响应解析问题，不能永久复用。
        if (cachedText && Array.isArray(cachedWords) && cachedWords.length > 0) {
            return {
                wordTimeInfo: cachedWords,
                fullText: cachedText,
                source: 'cache',
            };
        }
        console.warn(`[自动剪辑] 检测到空转录缓存，忽略缓存并重新调用识别: ${txtPath}`);
    }
    // Keep the historical array argument working for saved/legacy callers.
    // New calls use the encrypted provider configuration from the main process.
    const runTranscription = () => Array.isArray(transcriptionConfig)
        ? gladiaService.transcribeAudioFull(clipPath, transcriptionConfig, langEnName, jsonPath, txtPath, 5.0, onProgress, signal)
        : cloudTranscription.transcribeWithFallback(clipPath, transcriptionConfig, langEnName, jsonPath, txtPath, 5.0, onProgress, signal);
    let result = await runTranscription();
    const hasRecognizedText = value => Boolean(
        value?.fullText?.trim() && Array.isArray(value?.wordTimeInfo) && value.wordTimeInfo.length > 0
    );
    if (!hasRecognizedText(result)) {
        console.warn(`[自动剪辑] 云端转录首次未返回文字，自动重试一次: ${clipPath}`);
        result = await runTranscription();
    }
    if (!hasRecognizedText(result)) {
        // 不保留空结果，避免下一次分析继续误用。
        for (const emptyPath of [jsonPath, txtPath]) {
            try { if (fs.existsSync(emptyPath)) fs.unlinkSync(emptyPath); } catch (_) { }
        }
        throw new Error('TRANSCRIPTION_EMPTY_RESULT：语音识别服务连续两次返回空响应。请试听原片、检查语言设置后再单独重试。');
    }
    return { ...result, source: result.provider || (Array.isArray(transcriptionConfig) ? 'gladia' : 'cloud') };
}

function buildSubtitleItemsFromAudioWords(lines, words, audioDurationSec, minScore = 0.52) {
    const items = [];
    const totalMs = Math.max(1, Math.round((Number(audioDurationSec) || 0) * 1000));
    const lineCount = Math.max(1, lines.length);
    let cursor = 0;

    // First pass: match lines
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const scopedWords = words.slice(cursor);
        const match = scopedWords.length
            ? findBestWordWindow(scopedWords, line, Math.max(0.1, minScore * 0.45))
            : null;

        let startMs = null;
        let endMs = null;
        if (match && match.score >= 0.24 && scopedWords[match.startIdx] && scopedWords[match.endIdx]) {
            const globalStart = cursor + match.startIdx;
            const globalEnd = cursor + match.endIdx;
            startMs = Math.round(words[globalStart].start * 1000);
            endMs = Math.round(words[globalEnd].end * 1000);
            cursor = Math.max(cursor + 1, globalEnd + 1);
        }

        items.push({ start: startMs, end: endMs, text: line });
    }

    // Second pass: interpolate unmatched lines
    let idx = 0;
    while (idx < items.length) {
        if (items[idx].start === null) {
            let startNullIdx = idx;
            while (idx < items.length && items[idx].start === null) {
                idx++;
            }
            let endNullIdx = idx - 1;

            let prevTimeMs = 0;
            for (let k = startNullIdx - 1; k >= 0; k--) {
                if (items[k].end !== null) {
                    prevTimeMs = items[k].end;
                    break;
                }
            }

            let nextTimeMs = totalMs;
            for (let k = endNullIdx + 1; k < items.length; k++) {
                if (items[k].start !== null) {
                    nextTimeMs = items[k].start;
                    break;
                }
            }

            const interval = Math.max(0, nextTimeMs - prevTimeMs);
            const count = endNullIdx - startNullIdx + 1;
            const step = interval / (count + 1);

            for (let k = startNullIdx; k <= endNullIdx; k++) {
                const offset = k - startNullIdx;
                items[k].start = Math.round(prevTimeMs + step * (offset + 0.1));
                items[k].end = Math.round(prevTimeMs + step * (offset + 0.9));
            }
        } else {
            idx++;
        }
    }

    // Ensure timings are valid and sorted
    let lastEndMs = 0;
    for (let i = 0; i < items.length; i++) {
        let startMs = items[i].start;
        let endMs = items[i].end;
        startMs = clampMs(startMs, 0, Math.max(0, totalMs - 1));
        endMs = clampMs(endMs, startMs + 1, totalMs);
        if (startMs < lastEndMs) startMs = Math.min(lastEndMs, Math.max(0, totalMs - 1));
        if (endMs <= startMs) endMs = Math.min(totalMs, startMs + Math.max(1, Math.round(totalMs / lineCount)));
        lastEndMs = endMs;
        items[i].start = startMs;
        items[i].end = endMs;
    }

    return items;
}

async function generateSrtForAudioScript(opts = {}) {
    const audioPath = opts.audioPath || opts.audio_path;
    const lines = splitScriptLines(opts.scriptText || opts.script_text || '');
    if (!audioPath || !fs.existsSync(audioPath)) throw new Error('缺少有效音频文件，无法重新生成字幕');
    if (lines.length === 0) throw new Error('缺少文案，无法重新生成字幕');

    const transcriptionConfig = opts.transcriptionConfig || settingsService.loadTranscriptionProviders();
    if (!Object.values(transcriptionConfig.providers || {}).some(provider => provider.keys?.length)) throw new Error('未配置 Deepgram 或 Groq API Key，无法重新转录换声后的音频');

    const language = opts.language || 'auto';
    const cacheDir = settingsService.getSecureTmpDir('videokit_autoedit_cache');
    const transcription = await transcribeClip(audioPath, language, transcriptionConfig, cacheDir, opts.force === true);
    const words = flattenWords(transcription.wordTimeInfo);
    const duration = await ffmpegService.getDuration(audioPath).catch(() => {
        const lastWord = words[words.length - 1];
        return lastWord ? lastWord.end : lines.length * 2;
    });
    const srtItems = buildSubtitleItemsFromAudioWords(
        lines,
        words,
        duration,
        Math.max(0.1, Math.min(1, Number(opts.minScore ?? opts.min_score ?? 0.52)))
    );
    const srtPath = opts.srtPath || opts.srt_path || audioPath.replace(/\.[^.]+$/, '_retimed.srt');
    subtitleService.writeSRT(srtItems, srtPath);
    return {
        srt_path: srtPath,
        items_count: srtItems.length,
        recognized_text: transcription.fullText || '',
        transcription_source: transcription.source,
    };
}

function adjustPlanMatchedRange(plan, newStartLine, newEndLine, lines, minScore, duration, leadPad, tailPad) {
    plan.scriptStartLine = newStartLine;
    plan.scriptEndLine = newEndLine;
    const targetText = lines.slice(newStartLine, newEndLine + 1).join('\n');
    plan.scriptText = targetText;
    const wordWindow = findBestWordWindow(plan.words, targetText, minScore * 0.45);
    if (wordWindow) {
        plan.wordStartIdx = wordWindow.startIdx;
        plan.wordEndIdx = wordWindow.endIdx;
        plan.matchedText = wordWindow.matchedText;
        plan.matchScore = wordWindow.score;
        const srtRange = getManualSrtCutRange(plan.words, wordWindow.startIdx, wordWindow.endIdx, duration);
        plan.start = srtRange ? srtRange.start : Math.max(0, plan.words[wordWindow.startIdx].start - leadPad);
        plan.end = srtRange ? srtRange.end : Math.min(duration || plan.words[wordWindow.endIdx].end + tailPad, plan.words[wordWindow.endIdx].end + tailPad);
    } else {
        plan.start = 0;
        plan.end = duration;
    }
}

function generateVisualDiffMarkdown(scriptText, transcriptionText) {
    const DiffMatchPatch = require('diff-match-patch');
    const dmp = new DiffMatchPatch();
    const diffs = dmp.diff_main(scriptText, transcriptionText);
    dmp.diff_cleanupSemantic(diffs);
    
    let markdown = '';
    for (const [op, text] of diffs) {
        if (op === 0) {
            markdown += text;
        } else if (op === -1) {
            markdown += `<del style="background-color: #ffeef0; color: #b30000; text-decoration: line-through; padding: 0 4px; border-radius: 2px; font-weight: bold;">${text}</del>`;
        } else if (op === 1) {
            markdown += `<ins style="background-color: #e6ffec; color: #008000; text-decoration: none; padding: 0 4px; border-radius: 2px; font-weight: bold;">${text}</ins>`;
        }
    }
    return markdown;
}

async function autoEditByScript(opts = {}) {
    const throwIfCancelled = () => {
        if (opts.signal?.aborted) throw new Error('任务已停止');
    };
    throwIfCancelled();
    // 重新分析的权威来源必须是当前 clips 列表。旧审核快照里可能仍残留
    // 已替换、已删除或已排除片段；若每次都把它们合并回来，会凭空多出
    // 一个“第 33/33 个片段”并可能卡在过期素材上。只有调用方明确要求时，
    // 才允许审核快照补充 source（常规批量导出已在前端先合并当前 clips）。
    const reviewSnapshot = Array.isArray(opts.reviewSegments || opts.review_segments)
        ? (opts.reviewSegments || opts.review_segments) : [];
    const clips = (opts.clips || []).filter(p => p && fs.existsSync(p));
    const seenClipPaths = new Set(clips.map(p => path.resolve(p).normalize('NFC')));
    for (const review of (opts.mergeReviewSources === true ? reviewSnapshot : [])) {
        const source = String(review?.source || '');
        const key = source ? path.resolve(source).normalize('NFC') : '';
        if (review?.enabled !== false && source && key && fs.existsSync(source) && !seenClipPaths.has(key)) {
            clips.push(source);
            seenClipPaths.add(key);
        }
    }
    const lines = splitScriptLines(opts.scriptText || opts.script_text || '');
    if (clips.length === 0) throw new Error('缺少有效视频片段');
    if (lines.length === 0) throw new Error('缺少断行文案');

    const clipPathCounts = {};
    for (const c of clips) {
        clipPathCounts[c] = (clipPathCounts[c] || 0) + 1;
    }

    const manualSubtitleMap = opts.manualSubtitleMap || opts.manual_subtitle_map || {};
    const manualTranscripts = opts.manualTranscripts || opts.manual_transcripts || {};
    const transcriptionConfig = opts.transcriptionConfig || settingsService.loadTranscriptionProviders();
    const everyClipHasLocalText = clips.every(clip => manualTranscripts[clip] || manualSubtitleMap[clip]);
    if (!Object.values(transcriptionConfig.providers || {}).some(provider => provider.keys?.length) && !everyClipHasLocalText) {
        throw new Error('部分片段没有本地字幕或手动转录，请配置 Deepgram 或 Groq API Key 后再分析');
    }

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}_${hh}${mm}`;
    const firstClipName = path.basename(clips[0], path.extname(clips[0]));

    const outputDir = opts.outputDir || opts.output_dir || path.join(path.dirname(clips[0]), '_auto_edit');
    fs.mkdirSync(outputDir, { recursive: true });

    const ignoreMismatch = opts.ignoreMismatch === true || opts.ignore_mismatch === true;
    const language = opts.language || 'auto';
    const matchingEngine = autoEditMatcherV2.normalizeEngine(opts.matchingEngine || opts.matching_engine);
    const isMultilingualV2 = matchingEngine === autoEditMatcherV2.ENGINE_ID;
    const isCompareMode = matchingEngine === autoEditMatcherV2.COMPARE_ENGINE_ID;
    const usesMultilingualV2 = isMultilingualV2 || isCompareMode;
    const matchingEngineVersion = usesMultilingualV2 ? autoEditMatcherV2.ENGINE_VERSION : 1;
    const reportPath = path.join(outputDir, isCompareMode ? 'comparison_report.md' : (isMultilingualV2 ? 'alignment_report_v2.md' : 'mismatch_report.md'));
    const projectPath = path.join(outputDir, isCompareMode ? 'auto_edit_comparison_project.json' : (isMultilingualV2 ? 'auto_edit_project_v2.json' : 'auto_edit_project.json'));
    // 默认保留自然的句前/句后呼吸空间。旧版紧凑节奏为 0.04/0.08，
    // 连续片段容易显得抢拍；用户仍可在界面中手动改回旧值。
    const leadPad = Math.max(0, Number(opts.leadPad ?? opts.lead_pad ?? 0.12));
    const tailPad = Math.max(0, Number(opts.tailPad ?? opts.tail_pad ?? 0.22));
    const keepAudienceResponses = opts.keepAudienceResponses === true || opts.keep_audience_responses === true;
    const audienceResponseKeywords = new Set(String(opts.audienceResponseKeywords ?? opts.audience_response_keywords ?? 'Amen,阿们')
        .split(/[\n,，]+/).map(normalizeText).filter(Boolean));
    const minScore = Math.max(0.1, Math.min(1, Number(opts.minScore ?? opts.min_score ?? 0.52)));
    const forceTranscribe = opts.forceTranscribe === true || opts.force_transcribe === true;
    const forceTranscribePaths = new Set((opts.forceTranscribePaths || opts.force_transcribe_paths || [])
        .map(item => String(item || '').replace(/\\/g, '/')));
    const burnSubtitles = opts.burnSubtitles === true || opts.burn_subtitles === true;
    const firstResolution = await ffmpegService.getResolution(clips[0]);
    const [sourceWidth, sourceHeight] = String(firstResolution || '').split('x').map(Number);
    const sourceFps = await ffmpegService.getFrameRate(clips[0]);
    const targetWidth = parseInt(opts.targetWidth || opts.target_width || sourceWidth || 1080, 10);
    const targetHeight = parseInt(opts.targetHeight || opts.target_height || sourceHeight || 1920, 10);
    const fps = Number(opts.fps) > 0 ? Number(opts.fps) : (sourceFps || 30);
    const fitMode = opts.fitMode === 'contain' || opts.fit_mode === 'contain' ? 'contain' : 'cover';
    const videoFitFilter = fitMode === 'contain'
        ? `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black`
        : `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight}`;
    // 审核页可为每个片段单独设定画面缩放。先完成统一适配，再以成片中心为
    // 基准缩放：缩小补黑边，放大从中心裁切，保证不会因小于 100% 而让 crop 失败。
    const visualScaleFilter = (value) => {
        const percent = Math.max(50, Math.min(200, Number(value) || 100));
        if (Math.abs(percent - 100) < 0.001) return '';
        const factor = (percent / 100).toFixed(4);
        const scaled = `scale=trunc(iw*${factor}/2)*2:trunc(ih*${factor}/2)*2`;
        return percent < 100
            ? `${scaled},pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black`
            : `${scaled},crop=${targetWidth}:${targetHeight}`;
    };
    const crf = parseInt(opts.crf || 18, 10);
    const preset = opts.preset || 'fast';
    const matchMode = opts.matchMode || opts.match_mode || 'script';
    const useLinePerClip = ['line_per_clip', 'one_line_per_clip', 'legacy'].includes(String(matchMode));
    const transitionType = opts.transitionType || opts.transition_type || opts.transition || 'none';
    const transitionDuration = Math.max(0, Math.min(3, Number(opts.transitionDuration ?? opts.transition_duration ?? 0.35) || 0));
    const exportMp3 = opts.exportMp3 !== false && opts.export_mp3 !== false;
    const voiceChangerEnabled = opts.voiceChangerEnabled === true || opts.voice_changer_enabled === true;
    const voiceChangerVoiceId = String(opts.voiceChangerVoiceId || opts.voice_changer_voice_id || '').trim();
    const voiceChangerReplaceAudio = opts.voiceChangerReplaceAudio !== false && opts.voice_changer_replace_audio !== false;
    const voiceChangerModelId = opts.voiceChangerModelId || opts.voice_changer_model_id || 'eleven_multilingual_sts_v2';
    const voiceChangerOutputFormat = opts.voiceChangerOutputFormat || opts.voice_changer_output_format || 'mp3_44100_128';
    const voiceChangerStability = Number(opts.voiceChangerStability ?? opts.voice_changer_stability ?? 0.5);
    const voiceChangerSimilarity = Number(opts.voiceChangerSimilarity ?? opts.voice_changer_similarity ?? 0.75);
    const voiceChangerRemoveNoise = opts.voiceChangerRemoveNoise === true || opts.voice_changer_remove_noise === true;
    const manualAudioPath = String(opts.manualAudioPath || opts.manual_audio_path || '').trim();
    const manualAudioReplace = opts.manualAudioReplace === true || opts.manual_audio_replace === true || Boolean(manualAudioPath);
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const emitProgress = (progress) => {
        if (!onProgress) return;
        try {
            onProgress({
                ...progress,
                percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
            });
        } catch (_) { }
    };

    const sessionId = crypto.randomBytes(4).toString('hex');
    const tmpDir = path.join(os.tmpdir(), `videokit_autoedit_${sessionId}`);
    const cacheDir = settingsService.getSecureTmpDir('videokit_autoedit_cache');
    fs.mkdirSync(tmpDir, { recursive: true });

    const selected = [];
    const tempClips = [];
    const srtItems = [];
    let timelineCursorMs = 0;

    try {
        const plans = [];
        const workflowMode = opts.workflowMode || 'cut_first';
        let rawConcatPath = '';

        const joinWordsSmart = (wordsList) => {
            let text = '';
            for (let idx = 0; idx < wordsList.length; idx++) {
                const w = wordsList[idx];
                if (idx > 0) {
                    const prev = wordsList[idx - 1];
                    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(prev) || /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(w);
                    if (!hasCJK) {
                        text += ' ';
                    }
                }
                text += w;
            }
            return text;
        };

        // 初始化扁平的文案单词列表，记录每个单词所在的视觉行 index
        const scriptWords = [];
        let wordIdx = 0;
        for (let l = 0; l < lines.length; l++) {
            const lineText = lines[l];
            let lineWords;
            if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(lineText)) {
                // Array.from keeps a complete Unicode character intact.  Preserve its
                // source offsets too: the offsets let the export path put the user's
                // punctuation back after word-level matching has finished.
                let offset = 0;
                lineWords = [];
                for (const char of Array.from(lineText)) {
                    const start = offset;
                    offset += char.length;
                    if (char.trim()) lineWords.push({ raw: char, start, end: offset });
                }
            } else {
                // 文案常见 `blessed.Share`、`Amen,"because` 这类漏空格写法。
                // 不能只按空格切，否则会把两个已读词拼成一个不存在的长词，
                // 再好的 ASR 也无法匹配。保留词内连字符/撇号，其他标点均作边界。
                lineWords = Array.from(lineText.matchAll(/[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu))
                    .map(match => ({ raw: match[0], start: match.index, end: match.index + match[0].length }));
            }
            for (let lineWordIndex = 0; lineWordIndex < lineWords.length; lineWordIndex++) {
                const w = lineWords[lineWordIndex];
                scriptWords.push({
                    raw: w.raw,
                    norm: normalizeText(w.raw),
                    lineIndex: l,
                    charStart: w.start,
                    charEnd: w.end,
                    isFirstInLine: lineWordIndex === 0,
                    isLastInLine: lineWordIndex === lineWords.length - 1,
                    wordIndex: wordIdx++
                });
            }
        }

        // Matching operates on words and deliberately ignores punctuation.  Rendering
        // must do the opposite: reuse exact slices of the original script so commas,
        // decimal points, quotation marks and all other author-provided punctuation
        // survive both review and export.
        const scriptTextFromWords = (words) => {
            const output = [];
            let group = [];
            const flush = () => {
                if (!group.length) return;
                const first = group[0];
                const last = group[group.length - 1];
                const source = lines[first.lineIndex] || '';
                const start = first.isFirstInLine ? 0 : first.charStart;
                const end = last.isLastInLine ? source.length : last.charEnd;
                output.push(source.slice(start, end).trim());
                group = [];
            };
            for (const word of words || []) {
                if (group.length && word.lineIndex !== group[group.length - 1].lineIndex) flush();
                group.push(word);
            }
            flush();
            return output.filter(Boolean).join('\n');
        };
        let globalTranscriptionText = '';
        const isOneToOne = (workflowMode === 'concat_first' || useLinePerClip);

        if (workflowMode === 'concat_first') {
            rawConcatPath = path.join(tmpDir, `raw_concatenated_${sessionId}.mp4`);
            emitProgress({
                percent: 10,
                stage: 'concat_raw',
                message: '正在合并原始视频片段...',
            });
            await ffmpegService.concatClips({
                clips,
                outputPath: rawConcatPath,
                targetWidth,
                targetHeight,
                fps,
                crf,
                preset,
            });

            emitProgress({
                percent: 25,
                stage: 'transcribe',
                message: '正在进行单次语音转录识别...',
            });
            const transcription = await transcribeClip(rawConcatPath, language, transcriptionConfig, cacheDir, forceTranscribe, null, opts.signal);
            globalTranscriptionText = transcription.fullText;
            const words = flattenWords(transcription.wordTimeInfo);
            const duration = await ffmpegService.getDuration(rawConcatPath);

            const clipBoundaries = [];
            let accumulatedTime = 0;
            for (let i = 0; i < clips.length; i++) {
                const dur = await ffmpegService.getDuration(clips[i]) || 0;
                clipBoundaries.push({
                    index: i,
                    start: accumulatedTime,
                    end: accumulatedTime + dur,
                    path: clips[i]
                });
                accumulatedTime += dur;
            }

            const clipWordsMap = Array.from({ length: clips.length }, () => []);

            let wordCursor = 0;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                
                // Determine fallback time window for this line
                const totalDuration = duration || accumulatedTime;
                const fallbackStartSec = (totalDuration / lines.length) * i;
                const fallbackEndSec = (totalDuration / lines.length) * (i + 1);

                const scopedWords = words.slice(wordCursor);
                const match = scopedWords.length
                    ? findBestWordWindow(scopedWords, line, Math.max(0.1, minScore * 0.55))
                    : null;

                let matchedWords = [];
                let s_i = 0;
                let e_i = totalDuration;
                let origStartSec = fallbackStartSec;
                let origEndSec = fallbackEndSec;

                if (match && match.score >= 0.30 && scopedWords[match.startIdx] && scopedWords[match.endIdx]) {
                    const globalStart = wordCursor + match.startIdx;
                    const globalEnd = wordCursor + match.endIdx;
                    matchedWords = words.slice(globalStart, globalEnd + 1);
                    s_i = Math.max(0, words[globalStart].start - leadPad);
                    e_i = Math.min(totalDuration, words[globalEnd].end + tailPad);
                    origStartSec = words[globalStart].start;
                    origEndSec = words[globalEnd].end;
                    wordCursor = Math.max(wordCursor + 1, globalEnd + 1);
                } else {
                    // Fallback to all words in the actual clip range
                    matchedWords = words.filter(w => w.start >= fallbackStartSec - 0.05 && w.end <= fallbackEndSec + 0.05);
                    s_i = Math.max(0, fallbackStartSec - leadPad);
                    e_i = Math.min(totalDuration, fallbackEndSec + tailPad);
                }

                // Find which clip overlaps the midpoint of this matched section
                const midPoint = (origStartSec + origEndSec) / 2;
                const matchingClip = clipBoundaries.find(b => midPoint >= b.start && midPoint <= b.end) || clipBoundaries[0];
                const origClipIndex = matchingClip ? matchingClip.index : 0;
                const origClipPath = matchingClip ? matchingClip.path : rawConcatPath;

                if (origClipIndex >= 0 && origClipIndex < clips.length) {
                    clipWordsMap[origClipIndex].push(...matchedWords);
                }

                const matchedText = matchedWords.map(w => w.raw).join(' ');

                const lineWords = scriptWords.filter(w => w.lineIndex === i);
                let lineWordStart = -1;
                let lineWordEnd = -1;
                if (lineWords.length > 0) {
                    lineWordStart = lineWords[0].wordIndex;
                    lineWordEnd = lineWords[lineWords.length - 1].wordIndex;
                }

                plans.push({
                    sourceIndex: origClipIndex,
                    clipPath: rawConcatPath,
                    realClipPath: origClipPath,
                    transcription: {
                        wordTimeInfo: [],
                        fullText: matchedText,
                        source: 'concat_align'
                    },
                    words: matchedWords,
                    duration: totalDuration,
                    scriptStartLine: i,
                    scriptEndLine: i,
                    scriptText: line,
                    scriptWordStart: lineWordStart,
                    scriptWordEnd: lineWordEnd,
                    matchedText,
                    matchScore: matchedWords.length > 0 ? 1.0 : 0.0,
                    start: s_i,
                    end: e_i,
                    origStartSec,
                    origEndSec
                });
            }

            // Emit progress and save individual split files
            for (let i = 0; i < clips.length; i++) {
                const boundary = clipBoundaries[i];
                const clipWords = clipWordsMap[i];
                const clipStatus = clipWords.length > 0 ? 'transcribed' : 'empty';
                
                emitProgress({
                    stage: 'transcribe',
                    clip_index: i,
                    clip_status: clipStatus,
                    clip_error: clipWords.length > 0 ? null : '未获得可用的逐词识别结果',
                    message: `片段 #${i + 1} 语音识别完成 (${clipWords.length > 0 ? '已转录' : '未获得识别结果'})`,
                });

                try {
                    const clipBaseName = path.parse(boundary.path).name;
                    const outTxtPath = path.join(outputDir, `${clipBaseName}_transcription.txt`);
                    const outJsonPath = path.join(outputDir, `${clipBaseName}_transcription.json`);
                    
                    const clipDur = boundary.end - boundary.start;
                    const adjustedWords = clipWords.map(w => {
                        const localStart = w.start - boundary.start;
                        const localEnd = w.end - boundary.start;
                        return {
                            word: w.raw,
                            start: Math.max(0, Math.min(clipDur, localStart)),
                            end: Math.max(0, Math.min(clipDur, localEnd)),
                            score: w.score || 0.99,
                            confidence: w.score || 0.99
                        };
                    });
                    
                    const clipText = adjustedWords.map(w => w.word).join(' ');
                    const clipWordTimeInfo = [{
                        text: clipText,
                        audio_start: 0,
                        audio_end: clipDur,
                        words: adjustedWords
                    }];

                    fs.writeFileSync(outTxtPath, clipText, 'utf-8');
                    fs.writeFileSync(outJsonPath, JSON.stringify(clipWordTimeInfo, null, 2), 'utf-8');
                } catch (writeErr) {
                    console.error(`[自动剪辑] 保存片段 ${boundary.path} 的分拆转录结果到输出目录失败:`, writeErr);
                }
            }
        } else {
            // Every supplied clip must enter analysis. In one-line-per-clip mode an
            // extra clip is reported as unmatched instead of silently disappearing.
            const clipCount = clips.length;
            emitProgress({
                percent: 5,
                stage: 'start',
                current: 0,
                total: clipCount,
                message: `准备转录 ${clipCount} 个片段`,
            });

            const filteredScriptWords = scriptWords.filter(w => w.norm);
            let scriptCursor = 0;
            const usedScriptRanges = [];

            const overlapWithUsedRanges = (start, end) => {
                if (start === -1 || end === -1 || end < start) return 0;
                let overlap = 0;
                for (const range of usedScriptRanges) {
                    const s = Math.max(start, range.start);
                    const e = Math.min(end, range.end);
                    if (e >= s) overlap += e - s + 1;
                }
                return overlap;
            };

            const concurrency = (typeof transcriptionConfig?.concurrency === 'number' && transcriptionConfig.concurrency > 0)
                ? transcriptionConfig.concurrency
                : (typeof settingsService.getEffectiveConcurrency === 'function'
                    ? settingsService.getEffectiveConcurrency(transcriptionConfig)
                    : (transcriptionConfig?.primary === 'deepgram' ? 20 : 1));
            console.log(`[自动剪辑] 开始多片段并发转录: 共 ${clipCount} 个片段，并发数: ${concurrency} (首选: ${transcriptionConfig?.primary || 'deepgram'})`);

            const clipResults = new Array(clipCount);
            let completedCount = 0;
            let startedCount = 0;
            const providerLabel = ({ deepgram: 'Deepgram', groq: 'Groq', gladia: 'Gladia' })[transcriptionConfig?.primary] || '自动选择';

            await asyncPool(concurrency, Array.from({ length: clipCount }, (_, idx) => idx), async (i) => {
                if (opts.signal?.aborted) throw new Error('任务已停止');
                const clipPath = clips[i];
                startedCount++;
                emitProgress({
                    percent: 8 + Math.round((completedCount / Math.max(clipCount, 1)) * 42),
                    stage: 'transcribe',
                    current: completedCount,
                    total: clipCount,
                    active_count: startedCount - completedCount,
                    queued_count: Math.max(0, clipCount - startedCount),
                    provider_label: providerLabel,
                    clip_index: i,
                    clip_status: 'transcribing',
                    message: `语音识别进行中：已完成 ${completedCount}/${clipCount} · 正在识别 ${startedCount - completedCount} · 排队 ${Math.max(0, clipCount - startedCount)}`,
                });
                let transcription;
                let isFailed = false;
                let errorMsg = null;
                try {
                    const manualText = manualTranscripts[clipPath];
                    if (manualText) {
                        console.log(`[自动剪辑] 使用用户微调的手动转录文本进行匹配: ${manualText}`);
                        transcription = await buildManualTranscription(clipPath, manualText);
                    } else {
                        const forceThisClip = forceTranscribe || forceTranscribePaths.has(String(clipPath).replace(/\\/g, '/'));
                        transcription = await transcribeClip(
                            clipPath, language, transcriptionConfig, cacheDir, forceThisClip,
                            manualSubtitleMap[clipPath], opts.signal, outputDir,
                            message => {
                                const actualProvider = /Deepgram/i.test(message) ? 'Deepgram'
                                    : (/Groq/i.test(message) ? 'Groq' : (/Gladia/i.test(message) ? 'Gladia' : providerLabel));
                                emitProgress({
                                    stage: 'transcribe', current: completedCount, total: clipCount,
                                    active_count: Math.max(0, startedCount - completedCount),
                                    queued_count: Math.max(0, clipCount - startedCount),
                                    clip_index: i, clip_status: 'transcribing', provider_label: actualProvider,
                                    message: `语音识别进行中 · 当前平台 ${actualProvider} · ${message}`,
                                });
                            }
                        );
                    }
                } catch (err) {
                    if (opts.signal?.aborted || String(err?.message || '') === '任务已停止') throw err;
                    console.error(`[自动剪辑] 片段 ${i + 1}/${clipCount} 转录失败:`, err);
                    isFailed = true;
                    errorMsg = err.message || String(err);
                    transcription = {
                        wordTimeInfo: [],
                        fullText: `(转录失败: ${errorMsg})`,
                        source: 'failed'
                    };
                }
                const isCache = transcription.source === 'cache';
                const isTextEmpty = !transcription.fullText || transcription.fullText.trim() === '' || transcription.fullText.startsWith('(转录失败:');
                const emptyMessage = '识别服务未返回有效文字结果，请重新识别';
                let clipStatus = 'transcribed';
                if (isFailed) {
                    clipStatus = 'failed';
                } else if (isTextEmpty) {
                    clipStatus = 'empty';
                } else if (isCache) {
                    clipStatus = 'cached';
                }

                const completedProviderLabel = isCache
                    ? '缓存'
                    : (({ deepgram: 'Deepgram', groq: 'Groq', gladia: 'Gladia' })[transcription.provider] || providerLabel);
                completedCount++;
                emitProgress({
                    percent: 8 + Math.round((completedCount / Math.max(clipCount, 1)) * 42),
                    stage: 'transcribe',
                    current: completedCount,
                    total: clipCount,
                    active_count: Math.max(0, startedCount - completedCount),
                    queued_count: Math.max(0, clipCount - startedCount),
                    provider_label: completedProviderLabel,
                    clip_index: i,
                    clip_status: clipStatus,
                    clip_error: isFailed ? errorMsg : (isTextEmpty ? emptyMessage : null),
                    message: `片段转录 (${completedCount}/${clipCount}): ${path.basename(clipPath)} (${isFailed ? '失败' : (isTextEmpty ? '空结果' : (isCache ? '使用缓存' : '已识别'))}) · ${concurrency}并发`,
                });

                const words = flattenWords(transcription.wordTimeInfo);

                // 保存每个片段的转录结果（.txt 和 .json）到输出文件夹（当前文件夹）
                try {
                    const clipBaseName = path.parse(clipPath).name;
                    const outTxtPath = path.join(outputDir, `${clipBaseName}_transcription.txt`);
                    const outJsonPath = path.join(outputDir, `${clipBaseName}_transcription.json`);
                    fs.writeFileSync(outTxtPath, transcription.fullText || '', 'utf-8');
                    fs.writeFileSync(outJsonPath, JSON.stringify(transcription.wordTimeInfo || [], null, 2), 'utf-8');

                    // 如果转录为空，将提取出来的音频 wav 文件拷贝到输出目录供用户排查声音
                    if (!transcription.wordTimeInfo || transcription.wordTimeInfo.length === 0) {
                        let langCode = 'auto';
                        if (language && language !== 'auto') {
                            langCode = language;
                            for (const [code, info] of Object.entries(subtitleUtils.LANGUAGES)) {
                                if (info.name === language || info.code === language) {
                                    langCode = code;
                                    break;
                                }
                            }
                        }
                        const stat = fs.statSync(clipPath);
                        const cacheKey = crypto
                            .createHash('sha1')
                            .update(`${clipPath}|${stat.size}|${Math.floor(stat.mtimeMs)}`)
                            .digest('hex')
                            .slice(0, 12);
                        const baseName = path.parse(clipPath).name.replace(/[^\w.-]+/g, '_');
                        const cacheWavPath = path.join(cacheDir, `${langCode}_${baseName}_${cacheKey}_autoedit.wav`);
                        if (fs.existsSync(cacheWavPath)) {
                            const outWavPath = path.join(outputDir, `${clipBaseName}_extracted_audio.wav`);
                            fs.copyFileSync(cacheWavPath, outWavPath);
                            console.log(`[自动剪辑] 片段转录为空，已拷贝提取的音频文件到输出目录: ${outWavPath}`);
                        }
                    }
                } catch (writeErr) {
                    console.error(`[自动剪辑] 保存片段 ${clipPath} 的转录结果到输出目录失败:`, writeErr);
                }

                clipResults[i] = {
                    transcription,
                    words,
                    isFailed,
                    errorMsg,
                    clipStatus,
                };
            });

            // 阶段二：严格按原始片段顺序进行文本匹配与时间线规划
            for (let i = 0; i < clipCount; i++) {
                const clipPath = clips[i];
                const { transcription, words, isFailed, errorMsg, clipStatus } = clipResults[i];
                const duration = await ffmpegService.getDuration(clipPath);

                let scriptWordStart = -1;
                let scriptWordEnd = -1;
                let matchedText = '';
                let matchScore = 0;
                let wordStartIdx = -1;
                let wordEndIdx = -1;
                let duplicateOfSourceIndex = -1;
                const matchedWordsArray = [];

                if (words.length > 0) {
                    if (useLinePerClip) {
                        const lineWindow = i < lines.length ? findBestWordWindow(words, lines[i], minScore) : null;
                        if (lineWindow) {
                            const lineWords = filteredScriptWords.filter(w => w.lineIndex === i);
                            if (lineWords.length > 0) {
                                scriptWordStart = lineWords[0].wordIndex;
                                scriptWordEnd = lineWords[lineWords.length - 1].wordIndex;
                            }
                            matchedText = lineWindow.matchedText;
                            matchScore = lineWindow.score;
                            wordStartIdx = lineWindow.startIdx;
                            wordEndIdx = lineWindow.endIdx;
                        }
                    } else {
                        const clipText = words.map(w => w.norm).join(' ');
                        const currentTranscriptionNorm = normalizeText(transcription.fullText);
                        const duplicatePlan = currentTranscriptionNorm.length >= 12
                            ? plans.find(previous => {
                                const previousNorm = normalizeText(previous.transcription?.fullText);
                                return isLikelyDuplicateTranscription(currentTranscriptionNorm, previousNorm);
                            })
                            : null;

                        // 即使两个片段高度相似，只要还有未分配的文案，后一个仍
                        // 必须走正常匹配。只有整篇文案已经分配完，才归为重复并
                        // 展示同一文案区间给人工确认。
                        if (duplicatePlan && duplicatePlan.scriptWordStart !== -1 && filteredScriptWords.length === 0) {
                            duplicateOfSourceIndex = duplicatePlan.sourceIndex;
                            scriptWordStart = duplicatePlan.scriptWordStart;
                            scriptWordEnd = duplicatePlan.scriptWordEnd;
                            matchedText = duplicatePlan.matchedText;
                            matchScore = duplicatePlan.matchScore;
                            const clipWindow = findBestWordWindow(words, duplicatePlan.matchedText, minScore * 0.4);
                            wordStartIdx = clipWindow?.startIdx ?? 0;
                            wordEndIdx = clipWindow?.endIdx ?? (words.length - 1);
                            const scriptSlice = filteredScriptWords.filter(word => word.wordIndex >= scriptWordStart && word.wordIndex <= scriptWordEnd);
                            for (let idx = 0; idx < scriptSlice.length; idx++) {
                                const clipIdx = Math.min(wordEndIdx, wordStartIdx + Math.round(idx * Math.max(0, wordEndIdx - wordStartIdx) / Math.max(1, scriptSlice.length - 1)));
                                matchedWordsArray.push({ scriptWordIdx: scriptSlice[idx].wordIndex, clipWordIdx: clipIdx });
                            }
                            console.log(`[自动剪辑] 片段 #${i + 1} 与片段 #${duplicatePlan.sourceIndex + 1} 转录内容重复，继承同一文案区间`);
                        } else {
                        let match = null;
                        let globalStart = -1;
                        let globalEnd = -1;

                        const candidates = [];
                        const pushCandidate = (candidate, offset, source, minAcceptScore, orderBonus = 0) => {
                            if (!candidate || candidate.score < minAcceptScore) return;
                            const start = offset + candidate.startIdx;
                            const end = offset + candidate.endIdx;
                            const length = Math.max(1, end - start + 1);
                            const overlap = overlapWithUsedRanges(start, end);
                            const overlapPenalty = Math.min(0.22, (overlap / length) * 0.22);
                            const rangeAdjustedScore = Number.isFinite(candidate.adjustedScore)
                                ? candidate.adjustedScore
                                : candidate.score - overlapPenalty;
                            candidates.push({
                                match: candidate,
                                globalStart: start,
                                globalEnd: end,
                                source,
                                adjustedScore: rangeAdjustedScore + orderBonus,
                            });
                        };

                        // 低相似度绝不能“凑一个位置”。此前这里为了容忍 ASR 差异，
                        // 把 25%～28% 的候选也放进比较；结果会让诸如 37% 的片段占用
                        // 完全无关的文案，并把真正的精确句子反标成遗漏。低于可靠阈值
                        // 的片段宁可留作未匹配，交给审核，不得分配到任何文案行。
                        const reliableMatchScore = Math.max(0.60, minScore * 0.95);
                        const globalMatch = filteredScriptWords.length
                            ? findBestWordWindow(filteredScriptWords, clipText, reliableMatchScore)
                            : null;
                        pushCandidate(globalMatch, 0, 'global', reliableMatchScore, 0);

                        const searchSlice = filteredScriptWords.slice(scriptCursor);
                        const cursorMatch = searchSlice.length
                            ? findBestWordWindow(searchSlice, clipText, reliableMatchScore)
                            : null;
                        pushCandidate(cursorMatch, scriptCursor, 'cursor', reliableMatchScore, 0.025);

                        if (candidates.length > 0) {
                            candidates.sort((a, b) => {
                                if (Math.abs(b.adjustedScore - a.adjustedScore) > 0.001) {
                                    return b.adjustedScore - a.adjustedScore;
                                }
                                if (Math.abs((b.match.score || 0) - (a.match.score || 0)) > 0.001) {
                                    return (b.match.score || 0) - (a.match.score || 0);
                                }
                                return a.globalStart - b.globalStart;
                            });
                            const best = candidates[0];
                            match = best.match;
                            globalStart = best.globalStart;
                            globalEnd = best.globalEnd;
                            usedScriptRanges.push({ start: globalStart, end: globalEnd });
                            if (globalEnd >= scriptCursor) {
                                scriptCursor = globalEnd + 1;
                            }
                        }

                        if (globalStart !== -1 && globalEnd !== -1) {
                            scriptWordStart = filteredScriptWords[globalStart].wordIndex;
                            scriptWordEnd = filteredScriptWords[globalEnd].wordIndex;
                            matchedText = match.matchedText;
                            matchScore = match.score;

                            const clipWindow = findBestWordWindow(words, matchedText, minScore * 0.45);
                            if (clipWindow) {
                                wordStartIdx = clipWindow.startIdx;
                                wordEndIdx = clipWindow.endIdx;
                                const scriptSlice = filteredScriptWords.slice(globalStart, globalEnd + 1);
                                const clipSlice = words.slice(wordStartIdx, wordEndIdx + 1);
                                
                                const N = scriptSlice.length;
                                const M = clipSlice.length;
                                const dp = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(0));
                                for (let i = 1; i <= N; i++) {
                                    for (let j = 1; j <= M; j++) {
                                        if (scriptSlice[i - 1].norm === clipSlice[j - 1].norm) {
                                            dp[i][j] = dp[i - 1][j - 1] + 1;
                                        } else {
                                            dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                                        }
                                    }
                                }
                                
                                const matchedPairs = [];
                                let i_align = N, j_align = M;
                                while (i_align > 0 && j_align > 0) {
                                    if (scriptSlice[i_align - 1].norm === clipSlice[j_align - 1].norm) {
                                        matchedPairs.push({ scriptIdx: i_align - 1, clipIdx: j_align - 1 });
                                        i_align--;
                                        j_align--;
                                    } else if (dp[i_align - 1][j_align] >= dp[i_align][j_align - 1]) {
                                        i_align--;
                                    } else {
                                        j_align--;
                                    }
                                }
                                matchedPairs.reverse();
                                
                                if (matchedPairs.length > 0) {
                                    for (const pair of matchedPairs) {
                                        matchedWordsArray.push({
                                            scriptWordIdx: scriptSlice[pair.scriptIdx].wordIndex,
                                            clipWordIdx: wordStartIdx + pair.clipIdx
                                        });
                                    }
                                } else {
                                    // Fallback to proportional mapping
                                    for (let idx = 0; idx < N; idx++) {
                                        const cIdx = Math.min(M - 1, Math.round(idx * (M - 1) / Math.max(1, N - 1)));
                                        matchedWordsArray.push({
                                            scriptWordIdx: scriptSlice[idx].wordIndex,
                                            clipWordIdx: wordStartIdx + cIdx
                                        });
                                    }
                                }
                            }
                        }
                        }
                    }
                }

                let start = 0;
                let end = duration || 0;
                const isUniqueClip = clipPathCounts[clipPath] === 1;

                if (wordStartIdx !== -1 && wordEndIdx !== -1 && words[wordStartIdx] && words[wordEndIdx]) {
                    const srtRange = getManualSrtCutRange(words, wordStartIdx, wordEndIdx, duration);
                    start = srtRange ? srtRange.start : Math.max(0, words[wordStartIdx].start - leadPad);
                    end = srtRange ? srtRange.end : Math.min(duration || words[wordEndIdx].end + tailPad, words[wordEndIdx].end + tailPad);
                } else if (isUniqueClip && words.length > 0) {
                    start = Math.max(0, words[0].start - leadPad);
                    end = Math.min(duration || words[words.length - 1].end + tailPad, words[words.length - 1].end + tailPad);
                }
                if (!end || end <= start) {
                    end = duration || start + 0.1;
                }

                plans.push({
                    planId: `clip-${i}`,
                    sourceIndex: i,
                    clipPath,
                    transcription,
                    words,
                    duration,
                    scriptWordStart,
                    scriptWordEnd,
                    origScriptWordStart: scriptWordStart,
                    origScriptWordEnd: scriptWordEnd,
                    matchedWordsArray,
                    wordStartIdx,
                    wordEndIdx,
                    matchedText: matchedText || transcription.fullText || '',
                    matchScore,
                    duplicateOfSourceIndex,
                    start,
                    end,
                });
            }
        }

        // 1. 如果是“先剪后合 (常规)”且非“一行对应一个片段”，则对计划按脚本字位置重新排序，确保文案顺序正确
        if (workflowMode !== 'concat_first' && !useLinePerClip) {
            plans.sort((a, b) => {
                const aStart = (a.scriptWordStart !== undefined && a.scriptWordStart !== -1) ? a.scriptWordStart : 999999;
                const bStart = (b.scriptWordStart !== undefined && b.scriptWordStart !== -1) ? b.scriptWordStart : 999999;
                if (aStart !== bStart) return aStart - bStart;
                if ((b.matchScore || 0) !== (a.matchScore || 0)) return (b.matchScore || 0) - (a.matchScore || 0);
                return a.sourceIndex - b.sourceIndex;
            });
        }

        let boundaryOverlaps = [];
        if (workflowMode !== 'concat_first') {
            boundaryOverlaps = trimOverlappingBoundaryReadings(plans, scriptWords, leadPad, tailPad);
            for (const trim of boundaryOverlaps) {
                console.log(`[自动剪辑] 已移除片段 #${trim.previous + 1} 与 #${trim.next + 1} 的 ${trim.wordCount} 个边界重复词，归到后一片段`);
            }
            const recoveredGaps = recoverSmallBoundaryGaps(plans, scriptWords, leadPad, tailPad);
            for (const recovery of recoveredGaps) {
                console.log(`[自动剪辑] 已恢复边界漏词“${recovery.target}”，归到${recovery.side === 'previous' ? '上一段' : '下一段'} #${recovery.sourceIndex + 1}`);
            }
        }

        // 2. 初始化所有计划的 scriptStartLine / scriptEndLine（防空隙填充逻辑报错或清除）
        for (const plan of plans) {
            if (workflowMode !== 'concat_first') {
                plan.scriptStartLine = getWordLineIndex(scriptWords, plan.scriptWordStart);
                plan.scriptEndLine = getWordLineIndex(scriptWords, plan.scriptWordEnd);
            }
        }

        // 3. [已禁用空隙自动填充] 不再强制将未读/丢失的文案单词分配给邻近的片段，而是保留精确匹配区间，并在报告中独立记录丢失文案。
        /*
        if (!isOneToOne && plans.length > 0) {
            const matchedPlans = plans.filter(p => p.scriptWordStart !== -1);
            if (matchedPlans.length > 0) {
                // 填充头部空隙
                if (matchedPlans[0].scriptWordStart > 0) {
                    console.log(`[自动剪辑] 填充头部文案单词空隙: 单词 [0-${matchedPlans[0].scriptWordStart - 1}] 分配给片段 #${matchedPlans[0].sourceIndex + 1}`);
                    matchedPlans[0].scriptWordStart = 0;
                }

                // 填充片段之间的空隙
                for (let i = 0; i < matchedPlans.length - 1; i++) {
                    const currentEnd = matchedPlans[i].scriptWordEnd;
                    const nextStart = matchedPlans[i+1].scriptWordStart;
                    if (nextStart > currentEnd + 1) {
                        console.log(`[自动剪辑] 填充中间文案单词空隙: 单词 [${currentEnd + 1}-${nextStart - 1}] 分配给片段 #${matchedPlans[i].sourceIndex + 1}`);
                        matchedPlans[i].scriptWordEnd = nextStart - 1;
                    }
                }

                // 填充尾部空隙
                const lastIdx = matchedPlans.length - 1;
                if (matchedPlans[lastIdx].scriptWordEnd < scriptWords.length - 1) {
                    console.log(`[自动剪辑] 填充尾部文案单词空隙: 单词 [${matchedPlans[lastIdx].scriptWordEnd + 1}-${scriptWords.length - 1}] 分配给片段 #${matchedPlans[lastIdx].sourceIndex + 1}`);
                    matchedPlans[lastIdx].scriptWordEnd = scriptWords.length - 1;
                }
            }
        }
        */

        // 4. 同步更新对应的 scriptStartLine / scriptEndLine，并将 scriptText 设为精确词级别的匹配文案
        for (const plan of plans) {
            if (workflowMode !== 'concat_first') {
                plan.scriptStartLine = getWordLineIndex(scriptWords, plan.scriptWordStart);
                plan.scriptEndLine = getWordLineIndex(scriptWords, plan.scriptWordEnd);
                
                if (plan.scriptWordStart !== -1 && plan.scriptWordEnd !== -1) {
                    const sliced = scriptWords.slice(plan.scriptWordStart, plan.scriptWordEnd + 1);
                    plan.scriptText = scriptTextFromWords(sliced);
                } else {
                    plan.scriptText = '';
                }
            }
        }

        const unmatchedPlans = plans.filter(p => {
            if (workflowMode === 'concat_first') {
                const hasAnyWords = plans.some(plan => plan.words && plan.words.length > 0);
                return p.scriptStartLine === -1 || !hasAnyWords;
            }
            return p.scriptStartLine === -1 || !p.words || p.words.length === 0;
        });
        if (unmatchedPlans.length > 0) {
            // 在报错中断前，主动向前端发送未成功匹配或转录为空的片段状态更新，确保 UI 显示识别有问题
            for (const p of plans) {
                const isEmpty = !p.words || p.words.length === 0;
                const isUnmatched = p.scriptStartLine === -1;
                if (isEmpty || isUnmatched) {
                    const transcriptionFailed = p.transcription?.source === 'failed';
                    const failureText = String(p.transcription?.fullText || '').replace(/^\(转录失败:\s*|\)$/g, '');
                    emitProgress({
                        stage: 'transcribe',
                        clip_index: p.sourceIndex,
                        clip_status: transcriptionFailed ? 'failed' : (isEmpty ? 'empty' : 'unmatched'),
                        clip_error: transcriptionFailed ? failureText : (isEmpty ? '识别服务未返回文字，请重试' : '未匹配到任何断行文案'),
                        message: `片段 #${p.sourceIndex + 1} ${transcriptionFailed ? '识别失败' : (isEmpty ? '未获得识别文字' : '未匹配到文案')}`,
                    });
                }
            }

            const emptyPlans = unmatchedPlans.filter(p => !p.words || p.words.length === 0);
            const textUnmatchedPlans = unmatchedPlans.filter(p => p.words && p.words.length > 0 && p.scriptStartLine === -1);
            const hasReviewTimeline = Array.isArray(opts.reviewSegments || opts.review_segments) && (opts.reviewSegments || opts.review_segments).length > 0;
            const allowReview = opts.analysisOnly === true || opts.analysis_only === true || hasReviewTimeline;
            if (allowReview) {
                console.warn(`[自动剪辑] ${emptyPlans.length} 个片段转录为空，${textUnmatchedPlans.length} 个片段未匹配文案；保留为审核警告，不阻断分析流程`);
            } else {
                const details = [];
                if (emptyPlans.length) details.push(`未获得识别结果 ${emptyPlans.length} 个: [ ${emptyPlans.map(p => path.basename(p.realClipPath || p.clipPath)).join(', ')} ]`);
                if (textUnmatchedPlans.length) details.push(`已有识别文字但未匹配文案 ${textUnmatchedPlans.length} 个: [ ${textUnmatchedPlans.map(p => path.basename(p.realClipPath || p.clipPath)).join(', ')} ]`);
                throw new Error(`检测到 ${unmatchedPlans.length} 个片段需要处理：\n${details.join('\n')}\n\n请重新转录或先进入快速分析审核。`);
            }
        }

        // === 文案匹配度检测 ===
        emitProgress({ percent: 51, stage: 'matching', current: 0, total: plans.length, message: `正在核对 ${plans.length} 个片段与文案的匹配结果...` });
        const allClipsMatchInfo = [];
        let hasMismatch = false;
        
        const DiffMatchPatch = require('diff-match-patch');
        const dmp = new DiffMatchPatch();

        // Calculate global script and global transcription text
        const globalScript = lines.join('\n');
        let globalGenText = '';
        if (workflowMode === 'concat_first') {
            globalGenText = globalTranscriptionText || '';
        } else {
            globalGenText = plans.map(p => p.transcription.fullText || p.matchedText || '').join(' ');
        }

        const cleanGenGlobal = normalizeText(globalGenText);
        const cleanSourceGlobal = normalizeText(globalScript);
        
        const globalDiffs = dmp.diff_main(cleanGenGlobal, cleanSourceGlobal);
        dmp.diff_cleanupSemantic(globalDiffs);
        let globalEqualLen = 0;
        for (const [op, text] of globalDiffs) {
            if (op === 0) globalEqualLen += text.length;
        }
        const globalMaxLen = Math.max(cleanGenGlobal.length, cleanSourceGlobal.length);
        const globalSimilarity = globalMaxLen === 0 ? 1 : globalEqualLen / globalMaxLen;
        const globalSimPercent = Math.round(globalSimilarity * 100);

        // Global mismatch is triggered if overall similarity is less than 80%
        if (globalSimPercent < 80) {
            hasMismatch = true;
        }

        let anyClipMismatch = false;
        // Populate individual clip match info for reporting and UI dialog
        if (workflowMode === 'concat_first') {
            for (let i = 0; i < plans.length; i++) {
                const plan = plans[i];
                let similarity = 1.0;
                if (plan.scriptText && plan.words && plan.words.length > 0) {
                    const cleanGen = normalizeText(plan.matchedText);
                    const cleanSource = normalizeText(plan.scriptText);
                    const diffs = dmp.diff_main(cleanGen, cleanSource);
                    dmp.diff_cleanupSemantic(diffs);
                    let equalLen = 0;
                    for (const [op, text] of diffs) {
                        if (op === 0) equalLen += text.length;
                    }
                    const maxLen = Math.max(cleanGen.length, cleanSource.length);
                    similarity = maxLen === 0 ? 1 : equalLen / maxLen;
                } else {
                    similarity = 0.0;
                }

                const simPercent = Math.round(similarity * 100);
                const isMismatch = simPercent < 80;
                if (isMismatch) anyClipMismatch = true;

                allClipsMatchInfo.push({
                    clipIndex: i,
                    sourceIndex: plan.sourceIndex,
                    fileName: path.basename(plan.realClipPath || plan.clipPath),
                    clipPath: plan.realClipPath || plan.clipPath,
                    scriptText: plan.scriptText || '',
                    recognizedText: plan.matchedText || '',
                    similarity: simPercent,
                    isMismatch,
                    scriptStartLine: plan.scriptStartLine,
                    scriptEndLine: plan.scriptEndLine,
                    scriptWordStart: plan.scriptWordStart,
                    scriptWordEnd: plan.scriptWordEnd,
                    start: plan.start,
                    end: plan.end
                });
                emitProgress({ percent: 51 + Math.round(((i + 1) / Math.max(plans.length, 1)) * 1), stage: 'matching', current: i + 1, total: plans.length, clip_index: plan.sourceIndex, clip_status: isMismatch ? 'mismatch' : 'matched', match_result: isMismatch ? 'failed' : 'passed', message: `文案匹配 (${i + 1}/${plans.length}): ${path.basename(plan.realClipPath || plan.clipPath)} (${isMismatch ? '需审核' : '通过'})` });
            }
        } else {
            for (let i = 0; i < plans.length; i++) {
                const plan = plans[i];
                let similarity = 1.0;
                if (plan.scriptWordStart !== -1 && plan.words && plan.words.length > 0) {
                    const cleanGen = normalizeText(plan.transcription.fullText || plan.matchedText);
                    const cleanSource = normalizeText(plan.scriptText);
                    const diffs = dmp.diff_main(cleanGen, cleanSource);
                    dmp.diff_cleanupSemantic(diffs);
                    let equalLen = 0;
                    for (const [op, text] of diffs) {
                        if (op === 0) equalLen += text.length;
                    }
                    const maxLen = Math.max(cleanGen.length, cleanSource.length);
                    similarity = maxLen === 0 ? 1 : equalLen / maxLen;
                } else {
                    similarity = 0.0;
                }

                const simPercent = Math.round(similarity * 100);
                const isMismatch = simPercent < 85;
                if (isMismatch) anyClipMismatch = true;

                allClipsMatchInfo.push({
                    clipIndex: i,
                    sourceIndex: plan.sourceIndex,
                    fileName: path.basename(plan.realClipPath || plan.clipPath),
                    clipPath: plan.realClipPath || plan.clipPath,
                    scriptText: plan.scriptText || '',
                    recognizedText: plan.transcription.fullText || plan.matchedText || '',
                    similarity: simPercent,
                    isMismatch,
                    scriptStartLine: getWordLineIndex(scriptWords, plan.scriptWordStart),
                    scriptEndLine: getWordLineIndex(scriptWords, plan.scriptWordEnd),
                    scriptWordStart: plan.scriptWordStart,
                    scriptWordEnd: plan.scriptWordEnd,
                    start: plan.start,
                    end: plan.end
                });
                emitProgress({ percent: 51 + Math.round(((i + 1) / Math.max(plans.length, 1)) * 1), stage: 'matching', current: i + 1, total: plans.length, clip_index: plan.sourceIndex, clip_status: isMismatch ? 'mismatch' : 'matched', match_result: isMismatch ? 'failed' : 'passed', message: `文案匹配 (${i + 1}/${plans.length}): ${path.basename(plan.realClipPath || plan.clipPath)} (${isMismatch ? '需审核' : '通过'})` });
            }
        }

        if (anyClipMismatch) {
            hasMismatch = true;
        }

        emitProgress({ percent: 52, stage: 'matching', current: plans.length, total: plans.length, message: '文案匹配已完成，正在整理审核结果...' });

        console.log(`[自动剪辑] 全局文案匹配检测: 相似度为 ${globalSimPercent}% (阈值 80%), 单个片段存在不匹配: ${anyClipMismatch}, 是否触发阻断: ${hasMismatch && !ignoreMismatch}`);

        // 5. 计算视频音频中完全丢失/漏读的文案区块
        const missingBlocksInfo = [];
        const coveredWordIndices = new Set();
        for (let i = 0; i < plans.length; i++) {
            throwIfCancelled();
            const plan = plans[i];
            const matchInfo = allClipsMatchInfo[i];
            const similarity = matchInfo ? matchInfo.similarity : 0;
            // 只有当该片段识别出的发音相似度 >= 50% 时，才认为对应的参考文案字真正被读到了。
            // 否则（如 0% 匹配的错误片段或严重漏读片段），它所指定的参考文案仍然算作“缺失/漏读文案”，放入单独的补充卡片中。
            if (similarity >= 50 && plan.scriptWordStart !== -1 && plan.scriptWordEnd !== -1) {
                for (let w = plan.scriptWordStart; w <= plan.scriptWordEnd; w++) {
                    coveredWordIndices.add(w);
                }
            }
        }

        const missingScriptBlocks = [];
        let currentGap = null;

        for (let idx = 0; idx < scriptWords.length; idx++) {
            if (!coveredWordIndices.has(idx)) {
                if (!currentGap) {
                    currentGap = { start: idx, end: idx };
                } else {
                    currentGap.end = idx;
                }
            } else {
                if (currentGap) {
                    missingScriptBlocks.push(currentGap);
                    currentGap = null;
                }
            }
        }
        if (currentGap) {
            missingScriptBlocks.push(currentGap);
        }

        let blockIndex = 0;
        for (let i = 0; i < missingScriptBlocks.length; i++) {
            const block = missingScriptBlocks[i];
            const blockWords = scriptWords.slice(block.start, block.end + 1);
            const text = joinWordsSmart(blockWords.map(w => w.raw));
            if (normalizeText(text).length === 0) {
                continue; // Skip purely punctuation missing blocks
            }
            const startLine = blockWords[0]?.lineIndex ?? 0;
            const endLine = blockWords[blockWords.length - 1]?.lineIndex ?? 0;
            missingBlocksInfo.push({
                index: blockIndex++,
                startIdx: block.start,
                endIdx: block.end,
                text,
                startLine,
                endLine
            });
        }
        if (missingBlocksInfo.length > 0) {
            console.log(`[自动剪辑] 检测到全局漏读/缺失的文案区块数量: ${missingBlocksInfo.length}`);
        }

        // 二次核对：词级分配偶尔会留下“未覆盖”空洞，但实际识别全文中已经读到了该文案。
        // 这种情况不应继续报为缺失。同时记录缺失块位于哪两个片段之间，供审核时间线精确插入占位行。
        const refreshPlanScriptAndMatch = (plan) => {
            if (!plan || plan.scriptWordStart < 0 || plan.scriptWordEnd < plan.scriptWordStart) return;
            const sliced = scriptWords.slice(plan.scriptWordStart, plan.scriptWordEnd + 1);
            plan.scriptStartLine = getWordLineIndex(scriptWords, plan.scriptWordStart);
            plan.scriptEndLine = getWordLineIndex(scriptWords, plan.scriptWordEnd);
            plan.scriptText = scriptTextFromWords(sliced);

            const info = allClipsMatchInfo.find(item => item.sourceIndex === plan.sourceIndex);
            if (!info) return;
            const recognized = normalizeText(plan.transcription?.fullText || plan.matchedText || '');
            const target = normalizeText(plan.scriptText);
            const diffs = dmp.diff_main(recognized, target);
            dmp.diff_cleanupSemantic(diffs);
            const equalLength = diffs.reduce((total, [op, text]) => total + (op === 0 ? text.length : 0), 0);
            const similarity = Math.round((Math.max(recognized.length, target.length) ? equalLength / Math.max(recognized.length, target.length) : 1) * 100);
            info.scriptText = plan.scriptText;
            info.scriptStartLine = plan.scriptStartLine;
            info.scriptEndLine = plan.scriptEndLine;
            info.scriptWordStart = plan.scriptWordStart;
            info.scriptWordEnd = plan.scriptWordEnd;
            info.similarity = similarity;
            info.isMismatch = similarity < (workflowMode === 'concat_first' ? 80 : 85);
        };
        for (let i = missingBlocksInfo.length - 1; i >= 0; i--) {
            const block = missingBlocksInfo[i];
            const previous = plans
                .filter(plan => Number.isInteger(plan.scriptWordEnd) && plan.scriptWordEnd >= 0 && plan.scriptWordEnd < block.startIdx)
                .sort((a, b) => b.scriptWordEnd - a.scriptWordEnd)[0] || null;
            const next = plans
                .filter(plan => Number.isInteger(plan.scriptWordStart) && plan.scriptWordStart > block.endIdx)
                .sort((a, b) => a.scriptWordStart - b.scriptWordStart)[0] || null;

            // 相邻片段可能已经读到了缺失块边缘，只是存在单复数、词尾或轻微转录差异。
            // 先收缩这些已读边缘，避免把整句都显示成“丢失”。
            let remainingWords = scriptWords.slice(block.startIdx, block.endIdx + 1);
            let prefixReadCount = previous
                ? findFuzzyBoundaryOverlap(remainingWords, previous.transcription?.fullText || previous.matchedText || '', 'start')
                : 0;
            if (prefixReadCount > 0) {
                const prefixText = joinWordsSmart(remainingWords.slice(0, prefixReadCount).map(word => word.raw));
                const extension = extendPlanAtBoundary(previous, prefixText, 'previous', leadPad, tailPad);
                if (extension) {
                    previous.scriptWordEnd = block.startIdx + prefixReadCount - 1;
                    refreshPlanScriptAndMatch(previous);
                    block.startIdx += prefixReadCount;
                    remainingWords = remainingWords.slice(prefixReadCount);
                } else {
                    prefixReadCount = 0;
                }
            }
            let suffixReadCount = next && remainingWords.length
                ? findFuzzyBoundaryOverlap(remainingWords, next.transcription?.fullText || next.matchedText || '', 'end')
                : 0;
            if (suffixReadCount > 0) {
                const suffixText = joinWordsSmart(remainingWords.slice(remainingWords.length - suffixReadCount).map(word => word.raw));
                const extension = extendPlanAtBoundary(next, suffixText, 'next', leadPad, tailPad);
                if (extension) {
                    next.scriptWordStart = block.endIdx - suffixReadCount + 1;
                    refreshPlanScriptAndMatch(next);
                    block.endIdx -= suffixReadCount;
                    remainingWords = remainingWords.slice(0, remainingWords.length - suffixReadCount);
                } else {
                    suffixReadCount = 0;
                }
            }
            if (remainingWords.length === 0) {
                console.log(`[自动剪辑] 缺失块边界二次核对已读到，移除误报: ${block.text}`);
                missingBlocksInfo.splice(i, 1);
                continue;
            }
            // 不把“句号/换行”当作硬边界。短文案若已经出现在相邻片段的完整
            // ASR 词序中，就直接按语义归属；只有全局转写也找不到时才报红。
            const meaningfulRemaining = remainingWords.filter(word => normalizeText(word.raw));
            const applyPlanWindow = (plan, match, side) => {
                if (side === 'previous') {
                    plan.wordEndIdx = Math.max(Number(plan.wordEndIdx) || 0, match.endIdx);
                    plan.end = Math.min(plan.duration || Infinity, (plan.words[plan.wordEndIdx]?.end || plan.end) + tailPad);
                } else {
                    plan.wordStartIdx = Math.min(Number.isInteger(plan.wordStartIdx) ? plan.wordStartIdx : match.startIdx, match.startIdx);
                    plan.start = Math.max(0, (plan.words[plan.wordStartIdx]?.start || plan.start) - leadPad);
                }
            };
            if (previous && next && meaningfulRemaining.length >= 2 && meaningfulRemaining.length <= 12) {
                const wholeText = joinWordsSmart(remainingWords.map(word => word.raw));
                const candidates = [
                    { plan: previous, side: 'previous', match: findBestWordWindow(previous.words, wholeText, 0.78) },
                    { plan: next, side: 'next', match: findBestWordWindow(next.words, wholeText, 0.78) },
                ].filter(candidate => candidate.match).sort((a, b) => b.match.score - a.match.score);
                if (candidates.length) {
                    const best = candidates[0];
                    applyPlanWindow(best.plan, best.match, best.side);
                    if (best.side === 'previous') previous.scriptWordEnd = block.endIdx;
                    else next.scriptWordStart = block.startIdx;
                    refreshPlanScriptAndMatch(best.plan);
                    console.log(`[自动剪辑] 语义边界命中，整块归${best.side === 'previous' ? '上一' : '下一'}段: ${wholeText}`);
                    missingBlocksInfo.splice(i, 1);
                    continue;
                }
                // 同一句跨两段时，枚举拆点，要求两边都在各自完整转写中高置信命中。
                let split = null;
                for (let pivot = 1; pivot < remainingWords.length; pivot++) {
                    const previousText = joinWordsSmart(remainingWords.slice(0, pivot).map(word => word.raw));
                    const nextText = joinWordsSmart(remainingWords.slice(pivot).map(word => word.raw));
                    const previousMatch = findBestWordWindow(previous.words, previousText, 0.76);
                    const nextMatch = findBestWordWindow(next.words, nextText, 0.76);
                    if (!previousMatch || !nextMatch) continue;
                    const score = previousMatch.score + nextMatch.score;
                    if (!split || score > split.score) split = { pivot, previousText, nextText, previousMatch, nextMatch, score };
                }
                if (split) {
                    applyPlanWindow(previous, split.previousMatch, 'previous');
                    applyPlanWindow(next, split.nextMatch, 'next');
                    previous.scriptWordEnd = block.startIdx + split.pivot - 1;
                    next.scriptWordStart = block.startIdx + split.pivot;
                    refreshPlanScriptAndMatch(previous);
                    refreshPlanScriptAndMatch(next);
                    console.log(`[自动剪辑] 语义跨片段命中: 上段「${split.previousText}」；下段「${split.nextText}」`);
                    missingBlocksInfo.splice(i, 1);
                    continue;
                }
            }
            block.text = joinWordsSmart(remainingWords.map(word => word.raw));
            block.startLine = remainingWords[0]?.lineIndex ?? 0;
            block.endLine = remainingWords[remainingWords.length - 1]?.lineIndex ?? 0;

            block.previous_source_index = previous ? previous.sourceIndex + 1 : null;
            block.next_source_index = next ? next.sourceIndex + 1 : null;
            block.position_hint = previous && next
                ? `位于片段 #${previous.sourceIndex + 1} 与片段 #${next.sourceIndex + 1} 之间`
                : (previous ? `位于片段 #${previous.sourceIndex + 1} 之后` : (next ? `位于片段 #${next.sourceIndex + 1} 之前` : '未能确定相邻片段'));
            block.issue_type = 'confirmed_missing_script';
            block.detection_method = 'full_transcript_and_boundary_recheck';
        }

        // 完整性兜底：原文中的每个有效字词必须归属某个目标片段或缺失占位，禁止静默丢失。
        const accountedWordIndices = new Set();
        for (const plan of plans) {
            if (Number.isInteger(plan.scriptWordStart) && Number.isInteger(plan.scriptWordEnd) && plan.scriptWordStart >= 0) {
                for (let index = plan.scriptWordStart; index <= plan.scriptWordEnd; index++) accountedWordIndices.add(index);
            }
        }
        for (const block of missingBlocksInfo) {
            for (let index = block.startIdx; index <= block.endIdx; index++) accountedWordIndices.add(index);
        }
        let safetyGap = null;
        const appendSafetyGap = () => {
            if (!safetyGap) return;
            const words = scriptWords.slice(safetyGap.start, safetyGap.end + 1);
            if (words.some(word => normalizeText(word.raw))) {
                missingBlocksInfo.push({
                    startIdx: safetyGap.start,
                    endIdx: safetyGap.end,
                    text: joinWordsSmart(words.map(word => word.raw)),
                    startLine: words[0]?.lineIndex ?? 0,
                    endLine: words[words.length - 1]?.lineIndex ?? 0,
                    issue_type: 'confirmed_missing_script',
                    detection_method: 'coverage_safety_check',
                });
                console.warn(`[自动剪辑] 完整性核对发现未归属文案，已恢复为缺失占位: ${joinWordsSmart(words.map(word => word.raw))}`);
            }
            safetyGap = null;
        };
        for (let index = 0; index < scriptWords.length; index++) {
            if (!accountedWordIndices.has(index) && normalizeText(scriptWords[index].raw)) {
                if (!safetyGap) safetyGap = { start: index, end: index };
                else safetyGap.end = index;
            } else {
                appendSafetyGap();
            }
        }
        appendSafetyGap();
        missingBlocksInfo.sort((a, b) => a.startIdx - b.startIdx);
        missingBlocksInfo.forEach((block, index) => {
            block.index = index;
            const previous = plans
                .filter(plan => Number.isInteger(plan.scriptWordEnd) && plan.scriptWordEnd >= 0 && plan.scriptWordEnd < block.startIdx)
                .sort((a, b) => b.scriptWordEnd - a.scriptWordEnd)[0] || null;
            const next = plans
                .filter(plan => Number.isInteger(plan.scriptWordStart) && plan.scriptWordStart > block.endIdx)
                .sort((a, b) => a.scriptWordStart - b.scriptWordStart)[0] || null;
            block.previous_source_index = previous ? previous.sourceIndex + 1 : null;
            block.next_source_index = next ? next.sourceIndex + 1 : null;
            block.position_hint = previous && next
                ? `位于片段 #${previous.sourceIndex + 1} 与片段 #${next.sourceIndex + 1} 之间`
                : (previous ? `位于片段 #${previous.sourceIndex + 1} 之后` : (next ? `位于片段 #${next.sourceIndex + 1} 之前` : '未能确定相邻片段'));
            block.issue_type = block.issue_type || 'confirmed_missing_script';
            block.detection_method = block.detection_method || 'full_transcript_and_boundary_recheck';
        });

        // V2 独立使用语言感知词窗重新计算每段入点/出点。
        // 经典切点始终保留；仅当某一段无法可靠定位时，该段才单独回退经典切点。
        const v2CutResults = usesMultilingualV2
            ? plans.map(plan => {
                const cut = autoEditMatcherV2.calculateCut(plan, { language, leadPad, tailPad });
                plan.legacyStart = cut.legacyStart;
                plan.legacyEnd = cut.legacyEnd;
                plan.v2Start = cut.start;
                plan.v2End = cut.end;
                plan.v2CutAvailable = cut.applied;
                plan.cutEngine = isCompareMode ? 'legacy' : cut.engine;
                plan.v2CutScore = cut.score;
                plan.v2CutReason = cut.reason;
                if (cut.applied && !isCompareMode) {
                    plan.start = cut.start;
                    plan.end = cut.end;
                    plan.wordStartIdx = cut.wordStartIdx;
                    plan.wordEndIdx = cut.wordEndIdx;
                    plan.matchedText = cut.matchedText || plan.matchedText;
                }
                return cut;
            })
            : [];

        if (keepAudienceResponses) {
            plans.forEach(plan => extendPlanForAudienceResponse(plan, audienceResponseKeywords));
        }

        // V2 同时重新解释风险：识别文字不同默认属于待确认，不直接等同于“确定漏读”。
        const v2Assessment = isMultilingualV2
            || isCompareMode
            ? autoEditMatcherV2.assessAnalysis({
                plans,
                matchInfo: allClipsMatchInfo,
                missingBlocks: missingBlocksInfo,
                language,
            })
            : null;
        if (v2Assessment) {
            for (let index = 0; index < allClipsMatchInfo.length; index++) {
                const info = allClipsMatchInfo[index];
                const assessment = v2Assessment.segments[index];
                if (!assessment) continue;
                info.legacySimilarity = info.similarity;
                info.similarity = assessment.effectiveSimilarity;
                info.isMismatch = assessment.status !== 'ready';
                info.verificationLevel = assessment.verificationLevel;
                info.issueReason = assessment.issueReason;
                info.confidence = assessment.confidence;
                info.cutEngine = plans[index]?.cutEngine || 'legacy';
                info.cutScore = plans[index]?.v2CutScore || 0;
                info.legacyStart = plans[index]?.legacyStart;
                info.legacyEnd = plans[index]?.legacyEnd;
                info.v2Start = plans[index]?.v2Start;
                info.v2End = plans[index]?.v2End;
                info.v2CutAvailable = plans[index]?.v2CutAvailable === true;
                info.start = plans[index]?.start;
                info.end = plans[index]?.end;
            }
            missingBlocksInfo.splice(0, missingBlocksInfo.length, ...v2Assessment.missingBlocks);
            hasMismatch = v2Assessment.hasReviewWarnings;
            anyClipMismatch = v2Assessment.segments.some(item => item.status !== 'ready');
            console.log(`[自动剪辑][${isCompareMode ? '对比模式' : 'V2'}] V2 切点可用 ${v2CutResults.filter(item => item.applied).length}/${v2CutResults.length} 段；${v2Assessment.segments.filter(item => item.status === 'warning').length} 段识别差异待确认`);
        }

        // Always generate the matching/mismatch report to make it convenient to inspect results
        try {
            let reportContent = '';
            if (usesMultilingualV2) {
                reportContent += isCompareMode
                    ? `# 🔀 经典版与智能版 V2 切点对比报告\n\n`
                    : `# ${hasMismatch ? '⚠️' : '✅'} 智能版 V2 多语言对齐审核报告\n\n`;
                reportContent += `> V2 只把语音识别结果作为审核证据。文字差异不等于实际漏读，所有未确认差异均按“待试听确认”处理，不会阻止剪辑导出。\n\n`;
            } else if (hasMismatch) {
                reportContent += `# ⚠️ 视频文案与音频不匹配检测报告 (Mismatch Report)\n\n`;
            } else {
                reportContent += `# ✅ 视频文案与音频匹配成功报告 (Alignment Report)\n\n`;
            }
            reportContent += `匹配引擎: \`${matchingEngine}\`（版本 ${matchingEngineVersion}）\n\n`;
            reportContent += `生成时间: ${new Date().toLocaleString()}\n\n`;
            
            const globalScriptText = lines.join('\n');
            const diffHtml = generateVisualDiffMarkdown(globalScriptText, globalGenText);

            reportContent += `## 📝 完整文本对照分析 (Full Text Comparison Analysis)\n\n`;
            reportContent += `<details open>\n`;
            reportContent += `<summary><b>🔍 点击展开/折叠 完整对比差异 (Visual Diff)</b></summary>\n\n`;
            reportContent += usesMultilingualV2
                ? `> 💡 提示：<del style="background-color: #ffeef0; color: #b30000; text-decoration: line-through; padding: 0 4px; border-radius: 2px;">红色删除线部分</del> 表示**参考文案与语音识别文字存在差异，尚未确认是否漏读**；\n`
                : `> 💡 提示：<del style="background-color: #ffeef0; color: #b30000; text-decoration: line-through; padding: 0 4px; border-radius: 2px;">红色删除线部分</del> 表示**参考文案中有但视频音频漏读/丢失**的内容；\n`;
            reportContent += `> <ins style="background-color: #e6ffec; color: #008000; text-decoration: none; padding: 0 4px; border-radius: 2px;">绿色高亮部分</ins> 表示**实际发音多读或识别出多余**的内容。\n\n`;
            reportContent += `${diffHtml}\n\n`;
            reportContent += `</details>\n\n`;
            
            reportContent += `<details>\n`;
            reportContent += `<summary><b>📖 点击展开/折叠 完整原始参考文案 (Original Script)</b></summary>\n\n`;
            reportContent += `\`\`\`text\n${globalScriptText.trim()}\n\`\`\`\n\n`;
            reportContent += `</details>\n\n`;

            reportContent += `<details>\n`;
            reportContent += `<summary><b>🎙️ 点击展开/折叠 完整实际识别发音 (Transcribed Text)</b></summary>\n\n`;
            reportContent += `\`\`\`text\n${globalGenText.trim()}\n\`\`\`\n\n`;
            reportContent += `</details>\n\n`;
            
            reportContent += `---\n\n`;

            if (workflowMode !== 'concat_first') {
                if (missingBlocksInfo.length > 0) {
                    reportContent += usesMultilingualV2
                        ? `## ⚠️ 待试听确认的未归属文案\n\n`
                        : `## ❌ 视频音频中漏读/丢失的文案 (Missing Script Sections)\n\n`;
                    reportContent += usesMultilingualV2
                        ? `以下文案没有被当前识别结果可靠归属到片段。它们可能是识别误差或片段边界误差，不能据此认定演员漏读，请试听相邻片段确认：\n\n`
                        : `以下文案在所有视频片段的语音中都**没有检测到对应的读音**。您可以选择忽略这些文案，或者为它们补录新的视频片段：\n\n`;
                    for (const b of missingBlocksInfo) {
                        reportContent += `### ${usesMultilingualV2 ? '🟡 待确认区块' : '🔴 丢失区块'} #${b.index + 1} (对应文案行号: ${b.startLine + 1} - ${b.endLine + 1})\n`;
                        reportContent += `> \`\`\`text\n> ${b.text}\n> \`\`\`\n`;
                        if (usesMultilingualV2) reportContent += `- **说明**: ${b.issue_reason}\n`;
                        reportContent += `- **操作**: [action:add-supplementary-clip|line:${b.startLine}]\n\n`;
                    }
                    reportContent += `---\n\n`;
                } else {
                    reportContent += usesMultilingualV2
                        ? `## ⚠️ 待试听确认的未归属文案\n\n`
                        : `## ❌ 视频音频中漏读/丢失的文案 (Missing Script Sections)\n\n`;
                    reportContent += usesMultilingualV2
                        ? `🟢 当前没有需要试听确认的未归属文案。\n\n`
                        : `🟢 没有检测到任何漏读/丢失的文案。\n\n`;
                    reportContent += `---\n\n`;
                }
            }

            if (workflowMode === 'concat_first') {
                reportContent += usesMultilingualV2
                    ? `说明: 合并后的完整视频转录与总文案原始相似度为 \`${globalSimPercent}%\`。该数值仅用于辅助定位，V2 不会据此认定漏读或阻断导出。\n\n`
                    : `说明: 合并后的完整视频转录与总文案相似度为 \`${globalSimPercent}%\`。${hasMismatch ? '🔴 未达到 80% 的匹配阈值或存在片段不匹配。' : '🟢 已达到 80% 的安全匹配阈值。'}\n\n`;
                reportContent += `## 📊 片段对齐分析\n\n`;
                
                const mismatches = allClipsMatchInfo.filter(m => m.isMismatch);
                
                for (const m of allClipsMatchInfo) {
                    reportContent += `### ${m.isMismatch ? (usesMultilingualV2 ? '🟡' : '🔴') : '🟢'} 片段 #${m.sourceIndex + 1}: ${m.fileName}\n`;
                    reportContent += `- **视频路径**: \`${m.clipPath}\` [time:${m.start},${m.end}]\n`;
                    reportContent += `- **片段局部匹配度**: \`${m.similarity}%\`\n`;
                    if (usesMultilingualV2) {
                        reportContent += isCompareMode
                            ? `- **经典切点**: \`${Number(m.legacyStart).toFixed(3)}s - ${Number(m.legacyEnd).toFixed(3)}s\`\n- **V2 切点**: \`${Number(m.v2Start).toFixed(3)}s - ${Number(m.v2End).toFixed(3)}s\`${m.v2CutAvailable ? '' : '（不可用，默认经典）'}\n`
                            : `- **实际采用切点**: \`${Number(m.start).toFixed(3)}s - ${Number(m.end).toFixed(3)}s\`（${m.cutEngine === autoEditMatcherV2.ENGINE_ID ? 'V2 独立切点' : '本段回退经典切点'}）\n`;
                    }
                    reportContent += `- **应读参考文案**: "${m.scriptText.trim()}"\n`;
                    reportContent += `- **实际识别发音**: "${m.recognizedText.trim() || '(未检测到发音)'}"\n`;
                    if (usesMultilingualV2 && m.issueReason) reportContent += `- **V2 判断**: ${m.issueReason}\n`;
                    if (m.isMismatch) {
                        reportContent += `- **操作**: [action:replace-clip|path:${m.clipPath}|index:${m.sourceIndex}] [action:retranscribe-clip|path:${m.clipPath}|index:${m.sourceIndex}]\n`;
                    }
                    reportContent += `\n`;
                }
                
                if (!usesMultilingualV2 && hasMismatch && mismatches.length > 0) {
                    reportContent += `---\n\n`;
                    reportContent += `## 🤖 Flow 智能体重新生成指令\n\n`;
                    reportContent += `请将下面的指令直接复制并发送给您的 Flow 视频生成智能体：\n\n`;
                    reportContent += `\`\`\`text\n`;
                    reportContent += `请根据以下提示重新生成文案不匹配 of 视频片段，确保视频中的发音与要求完全一致：\n\n`;
                    for (const m of mismatches) {
                        reportContent += `【重制片段 #${m.sourceIndex + 1}】\n`;
                        reportContent += `文件名: ${m.fileName}\n`;
                        reportContent += `要求读的文案: "${m.scriptText.replace(/\r?\n/g, ' ')}"\n\n`;
                    }
                    reportContent += `\`\`\`\n`;
                }
            } else {
                reportContent += usesMultilingualV2
                    ? `说明: 以下是识别文字与参考文案的辅助对比。V2 使用语言感知分词、动态审核阈值和逐词置信度；差异只进入审核，不自动认定漏读，也不阻断导出。\n\n`
                    : `说明: 以下是各个片段识别出的实际发音内容与参考文案对比分析。${hasMismatch ? '⚠️ 部分片段匹配度较低（阈值设定为 85% 相似度，全局低于 80% 触发阻断）。' : '🟢 全片段匹配通过。'}\n\n`;
                reportContent += `---\n\n`;
                reportContent += `## 📊 片段对齐清单\n\n`;
                
                const mismatches = allClipsMatchInfo.filter(m => m.isMismatch);
                for (const m of allClipsMatchInfo) {
                    reportContent += `### ${m.isMismatch ? (usesMultilingualV2 ? '🟡' : '🔴') : '🟢'} 片段 #${m.sourceIndex + 1}: ${m.fileName}\n`;
                    reportContent += `- **视频路径**: \`${m.clipPath}\` [time:${m.start},${m.end}]\n`;
                    reportContent += `- **匹配度 (Similarity)**: \`${m.similarity}%\`\n`;
                    if (usesMultilingualV2) {
                        reportContent += isCompareMode
                            ? `- **经典切点**: \`${Number(m.legacyStart).toFixed(3)}s - ${Number(m.legacyEnd).toFixed(3)}s\`\n- **V2 切点**: \`${Number(m.v2Start).toFixed(3)}s - ${Number(m.v2End).toFixed(3)}s\`${m.v2CutAvailable ? '' : '（不可用，默认经典）'}\n`
                            : `- **实际采用切点**: \`${Number(m.start).toFixed(3)}s - ${Number(m.end).toFixed(3)}s\`（${m.cutEngine === autoEditMatcherV2.ENGINE_ID ? 'V2 独立切点' : '本段回退经典切点'}）\n`;
                    }
                    reportContent += `- **应读参考文案**:\n  \`\`\`text\n  ${m.scriptText.trim()}\n  \`\`\`\n`;
                    reportContent += `- **视频实际识别**:\n  \`\`\`text\n  ${m.recognizedText.trim() || '(识别服务未返回文字结果)'}\n  \`\`\`\n`;
                    if (usesMultilingualV2 && m.issueReason) {
                        reportContent += `- **V2 判断**: ${m.issueReason}\n`;
                    }
                    if (m.isMismatch) {
                        reportContent += `- **操作**: [action:replace-clip|path:${m.clipPath}|index:${m.sourceIndex}] [action:retranscribe-clip|path:${m.clipPath}|index:${m.sourceIndex}]\n`;
                    }
                    reportContent += `\n`;
                }
 
                if (!usesMultilingualV2 && hasMismatch && mismatches.length > 0) {
                    reportContent += `---\n\n`;
                    reportContent += `## 🤖 Flow 智能体重新生成指令\n\n`;
                    reportContent += `请将下面的指令直接复制并发送给您的 Flow 视频生成智能体：\n\n`;
                    reportContent += `\`\`\`text\n`;
                    reportContent += `请根据以下提示重新生成文案不匹配的视频片段，确保视频中的发音与要求完全一致：\n\n`;
                    for (const m of mismatches) {
                        reportContent += `【重制片段 #${m.sourceIndex + 1}】\n`;
                        reportContent += `文件名: ${m.fileName}\n`;
                        reportContent += `要求读的文案: "${m.scriptText.replace(/\r?\n/g, ' ')}"\n\n`;
                    }
                    reportContent += `\`\`\`\n`;
                }
            }
 
            fs.writeFileSync(reportPath, reportContent, 'utf-8');
            console.log(`[自动剪辑] 已在输出文件夹生成匹配报告: ${reportPath}`);
        } catch (reportErr) {
            console.error('[自动剪辑] 生成匹配报告失败:', reportErr);
        }

        const forceMismatch = opts.forceMismatch === true || opts.force_mismatch === true;
        if (opts.analysisOnly === true || opts.analysis_only === true) {
            const analysisSegments = plans.map((plan, index) => {
                const info = allClipsMatchInfo[index] || {};
                const duplicateScriptLines = findRepeatedScriptBlockStarts(lines, plan.scriptText);
                const hasDuplicateScript = duplicateScriptLines.length > 0;
                const isDuplicateClip = Number.isInteger(plan.duplicateOfSourceIndex) && plan.duplicateOfSourceIndex >= 0;
                const transcriptionFailed = plan.transcription?.source === 'failed';
                const recognizedText = plan.transcription?.fullText || plan.matchedText || '';
                const recognitionEmpty = normalizeText(recognizedText).length === 0;
                const scriptUnmatched = plan.scriptStartLine === -1 || !plan.scriptText;
                const v2Segment = v2Assessment?.segments[index] || null;
                const issueReasons = [];
                if (v2Segment) {
                    if (v2Segment.issueReason) issueReasons.push(v2Segment.issueReason);
                } else {
                    if (transcriptionFailed) issueReasons.push(String(plan.transcription?.error || recognizedText || '转录失败').replace(/^\(转录失败:\s*|\)$/g, ''));
                    else if (recognitionEmpty) issueReasons.push('识别服务未返回文字');
                    if (scriptUnmatched) issueReasons.push('未匹配到断行文案');
                    if (info.isMismatch) issueReasons.push(`文案相似度 ${info.similarity || 0}%，低于 85%`);
                }
                if (isDuplicateClip) issueReasons.push(`与原片段 #${plan.duplicateOfSourceIndex + 1} 朗读内容重复`);
                else if (hasDuplicateScript) issueReasons.push(`当前片段对应的整段文案从第 ${duplicateScriptLines.join('、')} 行开始重复出现；片段 #${plan.sourceIndex + 1} 可能对应多个位置，请核对前后片段顺序（不是视频重复）`);
                const baseStatus = v2Segment
                    ? v2Segment.status
                    : (transcriptionFailed || recognitionEmpty ? 'error' : (scriptUnmatched || info.isMismatch ? 'warning' : 'ready'));
                // 重复视频必须作为待确认问题返回审核页，而不是静默处理后被
                // 汇总成“全部通过”。是否排除由用户在审核页明确选择。
                const segmentStatus = isDuplicateClip
                    ? 'warning'
                    : (baseStatus === 'error'
                    ? 'error'
                    : (baseStatus === 'warning' || hasDuplicateScript ? 'warning' : 'ready'));
                return {
                    segment_id: plan.planId || `clip-${plan.sourceIndex}`,
                    index: index + 1,
                    source_index: plan.sourceIndex + 1,
                    source: plan.realClipPath || plan.clipPath,
                    script_start_line: Number.isInteger(info.scriptStartLine) && info.scriptStartLine >= 0 ? info.scriptStartLine + 1 : null,
                    script_end_line: Number.isInteger(info.scriptEndLine) && info.scriptEndLine >= 0 ? info.scriptEndLine + 1 : null,
                    script: plan.scriptText || '',
                    recognized_text: recognizedText,
                    matched_text: plan.matchedText || '',
                    match_score: Math.round((plan.matchScore || 0) * 1000) / 1000,
                    similarity: info.similarity || 0,
                    status: segmentStatus,
                    issue_reason: issueReasons.join('；'),
                    verification_level: v2Segment?.verificationLevel || (segmentStatus === 'ready' ? 'legacy_match' : 'legacy_warning'),
                    recognition_confidence: v2Segment?.confidence || null,
                    ambiguity: isDuplicateClip
                        ? `与原片段 #${plan.duplicateOfSourceIndex + 1} 朗读内容重复，已继承同一文案位置`
                        : (hasDuplicateScript ? `整段文案从第 ${duplicateScriptLines.join('、')} 行开始重复；片段 #${plan.sourceIndex + 1} 的匹配位置有歧义（不是视频重复）` : ''),
                    duplicate_script_lines: duplicateScriptLines,
                    duplicate_of_source_index: isDuplicateClip ? plan.duplicateOfSourceIndex + 1 : null,
                    duplicate_status: isDuplicateClip ? 'pending_confirmation' : null,
                    // 与旧审核规则一致：重复项保持可见、可试听、由用户确认处理。
                    // 不在后台擅自取消勾选或删除文案；审核页会把同文案两项并排成组。
                    enabled: true,
                    start: plan.start,
                    end: plan.end,
                    cut_timing_source: getManualSrtCutRange(plan.words, plan.wordStartIdx, plan.wordEndIdx, plan.duration) ? 'srt_timecode' : 'word_timing',
                    cut_engine: plan.cutEngine || 'legacy',
                    cut_score: Math.round((plan.v2CutScore || 0) * 1000) / 1000,
                    cut_reason: plan.v2CutReason || '',
                    legacy_start: Number.isFinite(plan.legacyStart) ? plan.legacyStart : plan.start,
                    legacy_end: Number.isFinite(plan.legacyEnd) ? plan.legacyEnd : plan.end,
                    v2_start: Number.isFinite(plan.v2Start) ? plan.v2Start : plan.start,
                    v2_end: Number.isFinite(plan.v2End) ? plan.v2End : plan.end,
                    v2_cut_available: plan.v2CutAvailable === true,
                    cut_selection: isCompareMode ? 'classic' : (plan.cutEngine === autoEditMatcherV2.ENGINE_ID ? 'v2' : 'classic'),
                    duration: Math.round((plan.end - plan.start) * 1000) / 1000,
                    speed: normalizeAutoEditSpeed(plan.speed),
                    source_duration: Math.round((plan.duration || plan.end) * 1000) / 1000,
                    transcription_source: plan.transcription.source,
                    word_timeline: (plan.words || []).map(word => ({
                        word: word.raw,
                        start: word.start,
                        end: word.end,
                    })),
                };
            });
            // 重复组关系必须与当前可编辑文案解耦。用户把边界词迁移到
            // 保留片段后，两段文字不再完全相同，但仍然属于同一组。分析时固化
            // 组 ID 和成员，审核页重开后也能继续正确处理。
            const duplicateParents = analysisSegments.map((_, index) => index);
            const findDuplicateRoot = index => {
                while (duplicateParents[index] !== index) {
                    duplicateParents[index] = duplicateParents[duplicateParents[index]];
                    index = duplicateParents[index];
                }
                return index;
            };
            const unionDuplicateRows = (left, right) => {
                const leftRoot = findDuplicateRoot(left);
                const rightRoot = findDuplicateRoot(right);
                if (leftRoot !== rightRoot) duplicateParents[rightRoot] = leftRoot;
            };
            const rowsBySourceIndex = new Map(analysisSegments.map((segment, index) => [Number(segment.source_index), index]));
            const rowsByScript = new Map();
            analysisSegments.forEach((segment, index) => {
                const scriptKey = normalizeText(segment.script || '');
                if (scriptKey) {
                    if (rowsByScript.has(scriptKey)) unionDuplicateRows(rowsByScript.get(scriptKey), index);
                    else rowsByScript.set(scriptKey, index);
                }
                const duplicateSourceIndex = Number(segment.duplicate_of_source_index);
                if (duplicateSourceIndex > 0 && rowsBySourceIndex.has(duplicateSourceIndex)) {
                    unionDuplicateRows(rowsBySourceIndex.get(duplicateSourceIndex), index);
                }
            });
            // 整段视频重复以识别全文为主。分配后的目标文案可能因边界词
            // （如 Third）不再完全相同，但识别全文高度相似时仍必须进入同一组。
            // 0.92 与原有 duplicatePlan 阈值一致；短于 12 个归一化字符不做整段判定。
            for (let left = 0; left < analysisSegments.length; left++) {
                const leftText = normalizeText(analysisSegments[left].recognized_text || '');
                if (leftText.length < 12) continue;
                for (let right = left + 1; right < analysisSegments.length; right++) {
                    const rightText = normalizeText(analysisSegments[right].recognized_text || '');
                    if (!isLikelyDuplicateTranscription(leftText, rightText)) continue;
                    unionDuplicateRows(left, right);
                }
            }
            const duplicateComponents = new Map();
            analysisSegments.forEach((segment, index) => {
                const root = findDuplicateRoot(index);
                if (!duplicateComponents.has(root)) duplicateComponents.set(root, []);
                duplicateComponents.get(root).push(segment);
            });
            duplicateComponents.forEach(members => {
                if (members.length < 2) return;
                const sourceIndices = members.map(member => Number(member.source_index)).filter(Number.isFinite).sort((a, b) => a - b);
                const groupId = `duplicate-${sourceIndices.join('-')}`;
                members.forEach(member => {
                    member.duplicate_group_id = groupId;
                    member.duplicate_group_source_indices = sourceIndices;
                    member.duplicate_status = member.duplicate_status || 'pending_confirmation';
                    if (member.status === 'ready') member.status = 'warning';
                    const groupReason = `与同组片段 ${sourceIndices.filter(index => index !== Number(member.source_index)).map(index => `#${index}`).join('、')} 朗读内容高度相似`;
                    if (!String(member.issue_reason || '').includes('朗读内容高度相似')) {
                        member.issue_reason = [member.issue_reason, groupReason].filter(Boolean).join('；');
                    }
                });
            });
            const analysisSummary = {
                total: analysisSegments.length,
                ready: analysisSegments.filter(segment => segment.status === 'ready').length,
                warning: analysisSegments.filter(segment => segment.status === 'warning').length,
                error: analysisSegments.filter(segment => segment.status === 'error').length,
                missing_blocks: missingBlocksInfo.length,
            };
            const projectData = {
                version: usesMultilingualV2 ? 2 : 1,
                created_at: new Date().toISOString(),
                matching_engine: matchingEngine,
                matching_engine_version: matchingEngineVersion,
                language,
                clips,
                script_text: lines.join('\n'),
                output_settings: { width: targetWidth, height: targetHeight, fps, source: 'first_clip', fit_mode: fitMode },
                missing_blocks: missingBlocksInfo,
                boundary_overlaps: boundaryOverlaps,
                segments: analysisSegments,
                match_summary: analysisSummary,
            };
            fs.writeFileSync(projectPath, JSON.stringify(projectData, null, 2), 'utf-8');
            return {
                success: true,
                analysis_only: true,
                message: `分析完成: ${analysisSegments.length} 段，请审核后正式导出`,
                matching_engine: matchingEngine,
                matching_engine_version: matchingEngineVersion,
                language,
                output_dir: outputDir,
                report_path: reportPath,
                project_path: projectPath,
                output_settings: { width: targetWidth, height: targetHeight, fps, source: 'first_clip', fit_mode: fitMode },
                missing_blocks: missingBlocksInfo,
                boundary_overlaps: boundaryOverlaps,
                segments: analysisSegments,
                match_summary: analysisSummary,
            };
        }
        if (!usesMultilingualV2 && (hasMismatch || forceMismatch) && !ignoreMismatch) {
            throw new Error(JSON.stringify({
                code: 'AUTOEDIT_TEXT_MISMATCH',
                mismatches: allClipsMatchInfo,
                missingBlocks: missingBlocksInfo,
                report_path: reportPath,
                output_dir: outputDir
            }));
        }

        const reviewSegments = Array.isArray(opts.reviewSegments || opts.review_segments) ? (opts.reviewSegments || opts.review_segments) : [];
        const hasReviewedTimeline = reviewSegments.length > 0;
        if (reviewSegments.length > 0) {
            const byId = new Map(plans.map(plan => [plan.planId || `clip-${plan.sourceIndex}`, plan]));
            const bySource = new Map();
            const bySourceIndex = new Map();
            const byBaseName = new Map();
            const normalizeReviewPath = value => String(value || '').replace(/\\/g, '/').normalize('NFC');
            for (const plan of plans) {
                const source = plan.realClipPath || plan.clipPath;
                const sourceKey = normalizeReviewPath(source);
                if (!bySource.has(sourceKey)) bySource.set(sourceKey, []);
                bySource.get(sourceKey).push(plan);
                const baseName = path.basename(sourceKey).toLocaleLowerCase();
                if (!byBaseName.has(baseName)) byBaseName.set(baseName, []);
                byBaseName.get(baseName).push(plan);
                // Public analysis/review payloads use one-based source_index;
                // internal plans keep the zero-based array index.
                const sourceIndex = Number(plan.sourceIndex) + 1;
                if (Number.isFinite(sourceIndex)) {
                    if (!bySourceIndex.has(sourceIndex)) bySourceIndex.set(sourceIndex, []);
                    bySourceIndex.get(sourceIndex).push(plan);
                }
            }
            const usedFallbackPlans = new Set();
            const reviewedPlans = [];
            for (const review of reviewSegments) {
                if (review.enabled === false) continue;
                let plan = review.segment_id ? byId.get(review.segment_id) : null;
                if (!plan) {
                    plan = (bySource.get(normalizeReviewPath(review.source)) || []).find(item => !usedFallbackPlans.has(item));
                }
                // 补充片段会先移入任务文件夹；macOS 文件系统 Unicode 规范化、
                // 路径分隔符或旧审核快照都可能让完整路径的字符串比较失败。
                // 文件名仅在当前任务里唯一时才作为安全回退，绝不猜测同名文件。
                if (!plan && review.source) {
                    const candidates = (byBaseName.get(path.basename(normalizeReviewPath(review.source)).toLocaleLowerCase()) || [])
                        .filter(item => !usedFallbackPlans.has(item));
                    if (candidates.length === 1) plan = candidates[0];
                }
                if (!plan) {
                    const sourceIndex = Number(review.source_index ?? review.sourceIndex);
                    if (Number.isFinite(sourceIndex)) {
                        plan = (bySourceIndex.get(sourceIndex) || []).find(item => !usedFallbackPlans.has(item));
                    }
                }
                // 手动补充/从“已选素材”重新建立审核时，审核快照里的文件可能
                // 不在本次转录计划数组中，但源文件仍真实存在。此时保留该审核片段
                // 并按用户审核的时长导出，而不是误报为丢片后中止整个任务。
                if (!plan && review.source && fs.existsSync(review.source)) {
                    const sourceDuration = Number(review.source_duration || review.duration)
                        || await ffmpegService.getDuration(review.source)
                        || Math.max(0.1, Number(review.end) || 0);
                    plan = {
                        planId: review.segment_id || `review-source-${reviewedPlans.length}`,
                        sourceIndex: Number.isFinite(Number(review.source_index ?? review.sourceIndex))
                            ? Number(review.source_index ?? review.sourceIndex) - 1
                            : plans.length + reviewedPlans.length,
                        clipPath: review.source,
                        realClipPath: review.source,
                        duration: sourceDuration,
                        start: 0,
                        end: sourceDuration,
                        scriptText: String(review.script || review.text || ''),
                        words: Array.isArray(review.word_timeline) ? review.word_timeline : [],
                        isManualReviewSource: true,
                    };
                }
                if (!plan) {
                    throw new Error(`审核片段无法定位，已停止导出以避免静默丢片: ${review.source || review.segment_id || '未知片段'}`);
                }
                usedFallbackPlans.add(plan);
                const start = Number(review.start);
                const end = Number(review.end);
                if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) {
                    const safeStart = Math.min(start, Math.max(0, plan.duration - 0.001));
                    const safeEnd = Math.min(end, plan.duration);
                    if (safeEnd <= safeStart) {
                        throw new Error(`审核片段切点超出原片时长，已停止导出: ${review.source || review.segment_id || '未知片段'}`);
                    }
                    plan.start = safeStart;
                    plan.end = safeEnd;
                }
                plan.speed = normalizeAutoEditSpeed(review.speed);
                plan.visualScale = Math.max(50, Math.min(200, Number(review.visual_scale) || 100));
                // 删除画面区间使用原片时间轴。画面和原声都会被移除，字幕由后续
                // SRT 生成逻辑并入上一条 cue，避免在成片中留下无画面的空白时长。
                plan.visualRemoveRanges = (Array.isArray(review.visual_remove_ranges) ? review.visual_remove_ranges : [])
                    .map(range => ({ start: Number(range?.start), end: Number(range?.end), keepSubtitles: range?.keep_subtitles === true }))
                    .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
                    .map(range => ({ start: Math.max(plan.start, range.start), end: Math.min(plan.end, range.end), keepSubtitles: range.keepSubtitles }))
                    .filter(range => range.end > range.start + 0.01)
                    .sort((a, b) => a.start - b.start)
                    .reduce((all, range) => {
                        const previous = all[all.length - 1];
                        if (previous && range.start <= previous.end + 0.02) {
                            previous.end = Math.max(previous.end, range.end);
                            previous.keepSubtitles = previous.keepSubtitles || range.keepSubtitles;
                        }
                        else all.push(range);
                        return all;
                    }, []);
                plan.cutSelection = ['classic', 'v2', 'manual'].includes(review.cut_selection) ? review.cut_selection : 'manual';
                // A saved review normally echoes the automatically generated script.
                // Keep the freshly rebuilt version in that case, because it retains
                // punctuation from the original manuscript.  Only replace it with a
                // review value when the reviewer intentionally edited the copy (or
                // when this is a manually-added source with no generated script).
                if (typeof review.script === 'string' && review.script.trim()
                    && (review.manually_modified === true || !plan.scriptText)) {
                    plan.scriptText = review.script.trim();
                }
                plan.manualSubtitles = Array.isArray(review.manual_subtitles)
                    ? review.manual_subtitles.filter(cue => cue && String(cue.text || '').trim())
                    : [];
                plan.isOpeningHook = review.is_hook === true || review.isHook === true;
                plan.hookKeepAudio = review.hook_keep_audio !== false && review.hookKeepAudio !== false;
                if (plan.isOpeningHook) {
                    // 开场钩子只保留原画/原声，不能继承该素材此前的匹配文案、
                    // 手工字幕或逐词字幕；否则会在无台词画面烧出错误字幕。
                    plan.scriptText = '';
                    plan.manualSubtitles = [];
                    plan.words = [];
                }
                // 手工补的漏读字幕会单独写入 SRT；必须先从普通文案中剔除，
                // 否则模糊匹配会用后面的识别词匹配到整行，把“漏句 + 下一句”
                // 又输出成一条普通字幕。
                for (const cue of plan.manualSubtitles) {
                    const tokens = String(cue.text || '').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
                    if (!tokens.length) continue;
                    const escaped = tokens.map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\p{L}\\p{N}]+');
                    plan.scriptText = String(plan.scriptText || '').replace(new RegExp(escaped, 'iu'), '').replace(/\n{2,}/g, '\n').trim();
                }
                reviewedPlans.push(plan);
            }
            if (reviewedPlans.length === 0) throw new Error('审核时间线中没有可导出的片段');
            plans.splice(0, plans.length, ...reviewedPlans);
        }

        const outputKey = crypto.createHash('sha256').update(JSON.stringify({
            folders: [...new Set(clips.map(clip => path.dirname(path.resolve(clip))))].sort(),
            script: opts.script_text || opts.scriptText || ''
        })).digest('hex').slice(0, 8);
        const outputPath = opts.outputPath || opts.output_path || path.join(outputDir, `auto_edit_${outputKey}.mp4`);
        try {
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        } catch (e) {
            console.warn(`[AutoEdit] Failed to create directory: ${e.message}`);
        }
        const outputBaseName = path.basename(outputPath, path.extname(outputPath)) || 'auto_edit';
        const projectDir = path.join(path.dirname(outputPath), `${outputBaseName}-工程`);
        const processedClipsDir = path.join(projectDir, '处理片段');
        const cutCacheDir = path.join(projectDir, '裁切缓存');
        const cutCacheEntries = readAutoEditCutCache(cutCacheDir);

        const coveredLines = new Set();
        let previousCutDuration = 0;
        const wordTimelineTimes = new Array(scriptWords.length).fill(null);

        for (let i = 0; i < plans.length; i++) {
            const plan = plans[i];
            const clipPath = plan.clipPath;
            emitProgress({
                percent: 52 + Math.round((i / Math.max(plans.length, 1)) * 30),
                stage: 'trim',
                current: i + 1,
                total: plans.length,
                message: `正在裁切第 ${i + 1}/${plans.length} 个匹配片段`,
            });

            const cutPath = path.join(tmpDir, `auto_${String(i + 1).padStart(4, '0')}.mp4`);
            const hasAudio = await ffmpegService.hasAudioTrack(clipPath);
            if (plan.end - plan.start < 0.35 && Number.isFinite(plan.duration) && plan.duration > 0.35) {
                plan.end = Math.min(plan.duration, plan.start + 0.35);
                if (plan.end - plan.start < 0.35) {
                    plan.start = Math.max(0, plan.end - 0.35);
                }
            }
            const args = ['-y'];
            args.push('-ss', plan.start.toFixed(3));
            args.push('-to', plan.end.toFixed(3));
            args.push('-i', clipPath);

            const clipSpeeds = opts.clipSpeeds || opts.clip_speeds || {};
            const targetClipPath = plan.realClipPath || clipPath;
            const speed = hasReviewedTimeline
                ? normalizeAutoEditSpeed(plan.speed)
                : normalizeAutoEditSpeed(clipSpeeds[targetClipPath]);
            const vPts = (1.0 / speed).toFixed(5);
            const scaleFilter = visualScaleFilter(plan.visualScale);
            const visualRemoveRanges = Array.isArray(plan.visualRemoveRanges) ? plan.visualRemoveRanges : [];
            // -ss 后 t 从剪辑入点开始计；FFmpeg 的 select/aselect 同时删掉
            // 视频和声音，故最终时长会真正缩短，而不是黑屏占位。
            const removeExpr = visualRemoveRanges.length
                ? visualRemoveRanges.map(range => {
                    const from = Math.max(0, range.start - plan.start).toFixed(3);
                    const to = Math.max(0, range.end - plan.start).toFixed(3);
                    return `between(t\\,${from}\\,${to})`;
                }).join('+')
                : '';
            const videoRemoveFilter = removeExpr ? `select='not(${removeExpr})',setpts=N/FRAME_RATE/TB,` : '';
            const audioRemoveFilter = removeExpr ? `aselect='not(${removeExpr})',asetpts=N/SR/TB,` : '';

            let atempoFilter = '';
            if (speed >= 0.5 && speed <= 2.0) {
                atempoFilter = `atempo=${speed}`;
            } else if (speed > 2.0 && speed <= 4.0) {
                atempoFilter = `atempo=2.0,atempo=${(speed/2.0).toFixed(4)}`;
            } else if (speed < 0.5 && speed >= 0.25) {
                atempoFilter = `atempo=0.5,atempo=${(speed/0.5).toFixed(4)}`;
            } else {
                atempoFilter = `anull`;
            }

            let filterComplex;
            const keepSourceAudio = hasAudio && !(plan.isOpeningHook && plan.hookKeepAudio === false);
            if (keepSourceAudio) {
                // 每段在输入寻址后必须清零 PTS 并用 aresample 对齐音画起点，防止 VFR/AI 生成视频在拼接后口型偏移或视频轨提前结束。
                filterComplex = `[0:v]${videoRemoveFilter}setpts=${vPts}*(PTS-STARTPTS),${videoFitFilter}${scaleFilter ? `,${scaleFilter}` : ''},fps=${fps},settb=1/${fps},setsar=1[v];[0:a]aresample=async=1:first_pts=0,${audioRemoveFilter}asetpts=PTS-STARTPTS,${atempoFilter},aformat=sample_rates=48000:channel_layouts=stereo[a]`;
            } else {
                args.push('-f', 'lavfi', '-i', 'anullsrc=cl=stereo:r=48000');
                filterComplex = `[0:v]${videoRemoveFilter}setpts=${vPts}*(PTS-STARTPTS),${videoFitFilter}${scaleFilter ? `,${scaleFilter}` : ''},fps=${fps},settb=1/${fps},setsar=1[v];[1:a]asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[a]`;
            }

            args.push(
                '-filter_complex', filterComplex,
                '-map', '[v]', '-map', '[a]',
                '-c:v', 'libx264', '-crf', String(crf), '-preset', preset, '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '192k',
                '-avoid_negative_ts', 'make_zero',
                '-shortest',
                '-movflags', '+faststart',
                cutPath
            );

            // 每段独立复用：只要素材本身及所有会影响画面/声音的裁切参数
            // 未变，就直接复制上次已编码的片段到本次临时拼接目录。
            const sourceForCache = plan.realClipPath || clipPath;
            const cacheKeyPayload = {
                version: 2,
                source: path.resolve(sourceForCache),
                source_fingerprint: getAutoEditClipFingerprint(sourceForCache),
                start: Number(plan.start.toFixed(3)),
                end: Number(plan.end.toFixed(3)),
                speed: Number(speed.toFixed(4)),
                visual_scale: Number(plan.visualScale || 100),
                visual_remove_ranges: visualRemoveRanges.map(range => ({
                    start: Number(range.start.toFixed(3)), end: Number(range.end.toFixed(3)),
                    keep_subtitles: range.keepSubtitles === true,
                })),
                keep_source_audio: keepSourceAudio,
                output: { width: targetWidth, height: targetHeight, fps, fit_mode: fitMode, crf, preset },
            };
            const cutCacheSignature = crypto.createHash('sha256').update(JSON.stringify(cacheKeyPayload)).digest('hex');
            const cachedCut = cutCacheEntries.get(cutCacheSignature);
            plan.cutCacheSignature = cutCacheSignature;
            plan.cutCacheHit = Boolean(cachedCut?.path && fs.existsSync(cachedCut.path));
            if (cachedCut?.path && fs.existsSync(cachedCut.path)) {
                fs.copyFileSync(cachedCut.path, cutPath);
                emitProgress({
                    percent: 52 + Math.round((i / Math.max(plans.length, 1)) * 30),
                    stage: 'trim', current: i + 1, total: plans.length,
                    message: `复用已裁切片段 ${i + 1}/${plans.length}`,
                });
            } else {
                await ffmpegService.runCommand('ffmpeg', args, { timeout: 1800000, signal: opts.signal });
                const cachePath = path.join(cutCacheDir, `${cutCacheSignature}.mp4`);
                fs.mkdirSync(cutCacheDir, { recursive: true });
                fs.copyFileSync(cutPath, cachePath);
                cutCacheEntries.set(cutCacheSignature, {
                    signature: cutCacheSignature,
                    path: cachePath,
                    source: sourceForCache,
                    source_start: cacheKeyPayload.start,
                    source_end: cacheKeyPayload.end,
                    created_at: new Date().toISOString(),
                });
                // 每完成一段便落盘。即使用户在后续拼接或烧录阶段停止，已经
                // 裁好的未修改片段下次仍然可复用。
                writeAutoEditCutCache(cutCacheDir, cutCacheEntries);
            }

            const cutDuration = await ffmpegService.getDuration(cutPath) || (plan.end - plan.start);
            tempClips.push(cutPath);

            const boundaryTransitionSec = i > 0
                ? computeAutoEditTransitionSec(previousCutDuration, cutDuration, transitionType, transitionDuration)
                : 0;
            const cutDurationMs = Math.max(1, Math.round(cutDuration * 1000));
            const srtStart = Math.max(0, timelineCursorMs - Math.round(boundaryTransitionSec * 1000));
            const srtEnd = srtStart + cutDurationMs;
            const removedRangeFor = (sourceStart, sourceEnd) => visualRemoveRanges.find(range => sourceStart < range.end - 0.01 && sourceEnd > range.start + 0.01);
            const removedBefore = sourceTime => visualRemoveRanges.reduce((total, range) => total + Math.max(0, Math.min(sourceTime, range.end) - range.start), 0);
            const mergeIntoPreviousSubtitle = text => {
                const previous = srtItems[srtItems.length - 1];
                if (previous && text && !String(previous.text).includes(text)) previous.text = `${previous.text}\n${text}`;
            };

            if (hasReviewedTimeline && plan.scriptText) {
                const reviewedLines = splitScriptLines(plan.scriptText);
                const lineMatches = [];
                let wordCursor = 0;
                for (const line of reviewedLines) {
                    const scopedWords = (plan.words || []).slice(wordCursor);
                    const multilingualMatch = usesMultilingualV2 && scopedWords.length
                        ? autoEditMatcherV2.findBestCutWindow(scopedWords, line, language)
                        : null;
                    const match = multilingualMatch || (
                        scopedWords.length ? findBestWordWindow(scopedWords, line, 0.45) : null
                    );
                    if (!match || !scopedWords[match.startIdx] || !scopedWords[match.endIdx]) {
                        continue;
                    }
                    const firstWord = scopedWords[match.startIdx];
                    const lastWord = scopedWords[match.endIdx];

                    // 检查此句是否落入本次裁切的 [plan.start, plan.end] 范围内：
                    // 如果该行在裁切入点之前结束，或在裁切出点之后开始，则已被用户剪掉，不生成字幕！
                    if (lastWord.end <= plan.start + 0.05 || firstWord.start >= plan.end - 0.05) {
                        wordCursor += match.endIdx + 1;
                        continue;
                    }

                    const clampedStartSec = Math.max(plan.start, firstWord.start);
                    const clampedEndSec = Math.min(plan.end, lastWord.end);
                    if (clampedEndSec > clampedStartSec) {
                        const removedRange = removedRangeFor(clampedStartSec, clampedEndSec);
                        if (removedRange) {
                            // 用户要的是字幕仍可见，而非保留被删画面的时长：把它
                            // 写到前一条字幕上，时长由前一条字幕自身决定。
                            if (removedRange.keepSubtitles) mergeIntoPreviousSubtitle(line);
                            wordCursor += match.endIdx + 1;
                            continue;
                        }
                        const lineStartMs = srtStart + Math.round(((clampedStartSec - plan.start - removedBefore(clampedStartSec)) / speed) * 1000);
                        const lineEndMs = srtStart + Math.round(((clampedEndSec - plan.start - removedBefore(clampedEndSec)) / speed) * 1000);
                        if (lineEndMs > lineStartMs + 50) {
                            lineMatches.push({
                                text: line,
                                start: Math.max(srtStart, lineStartMs),
                                end: Math.min(srtEnd, lineEndMs),
                            });
                        }
                    }
                    wordCursor += match.endIdx + 1;
                }

                if (lineMatches.length > 0) {
                    srtItems.push(...lineMatches);
                } else if (!plan.words || plan.words.length === 0) {
                    // 没有可靠逐词定位时仍严格保留用户断行，按每行有效字符数分配片段时长。
                    const weights = reviewedLines.map(line => Math.max(1, normalizeText(line).length));
                    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
                    let cursorMs = srtStart;
                    reviewedLines.forEach((line, lineIndex) => {
                        const isLast = lineIndex === reviewedLines.length - 1;
                        const lineEnd = isLast
                            ? srtEnd
                            : Math.min(srtEnd, cursorMs + Math.round((cutDurationMs * weights[lineIndex]) / totalWeight));
                        srtItems.push({ start: cursorMs, end: Math.max(cursorMs + 50, lineEnd), text: line });
                        cursorMs = lineEnd;
                    });
                }
            }

            // 手工补的漏识别字幕是独立 cue：只插入指定的小区间，绝不重排
            // 或拉伸 AI 已对齐的后续字幕。
            for (const cue of plan.manualSubtitles || []) {
                const sourceStart = Math.max(plan.start, Number(cue.start) || plan.start);
                const sourceEnd = Math.min(plan.end, Math.max(sourceStart + 0.1, Number(cue.end) || sourceStart + 2));
                const cueStart = srtStart + Math.round(((sourceStart - plan.start) / speed) * 1000);
                const cueEnd = srtStart + Math.round(((sourceEnd - plan.start) / speed) * 1000);
                if (cueEnd > cueStart + 50) {
                    srtItems.push({ start: Math.max(srtStart, cueStart), end: Math.min(srtEnd, cueEnd), text: String(cue.text).trim() });
                }
            }

            if (!hasReviewedTimeline && plan.scriptWordStart !== -1) {
                if (workflowMode === 'concat_first') {
                    const subStartMs = srtStart + Math.round(((plan.origStartSec - plan.start) / speed) * 1000);
                    const subEndMs = srtStart + Math.round(((plan.origEndSec - plan.start) / speed) * 1000);
                    srtItems.push({
                        start: Math.max(0, subStartMs),
                        end: Math.min(srtStart + Math.round(cutDuration * 1000), subEndMs),
                        text: plan.scriptText,
                    });
                } else {
                    // 1. Calculate times for originally matched words
                    if (plan.matchedWordsArray) {
                        for (const item of plan.matchedWordsArray) {
                            const scriptWordIdx = item.scriptWordIdx;
                            const clipWord = plan.words[item.clipWordIdx];
                            if (clipWord) {
                                const startMs = srtStart + Math.round(((clipWord.start - plan.start) / speed) * 1000);
                                const endMs = srtStart + Math.round(((clipWord.end - plan.start) / speed) * 1000);
                                wordTimelineTimes[scriptWordIdx] = {
                                    start: Math.max(srtStart, Math.min(srtEnd, startMs)),
                                    end: Math.max(srtStart, Math.min(srtEnd, endMs))
                                };
                            }
                        }
                    }

                    // 2. Fill in times for unmatched/gap words assigned to this plan
                    const runStart = plan.scriptWordStart;
                    const runEnd = plan.scriptWordEnd;
                    let runIdx = runStart;
                    while (runIdx <= runEnd) {
                        if (wordTimelineTimes[runIdx] === null) {
                            let nullStart = runIdx;
                            while (runIdx <= runEnd && wordTimelineTimes[runIdx] === null) {
                                runIdx++;
                            }
                            let nullEnd = runIdx - 1;
                            
                            let prevTime = srtStart;
                            for (let k = nullStart - 1; k >= runStart; k--) {
                                if (wordTimelineTimes[k] !== null) {
                                    prevTime = wordTimelineTimes[k].end;
                                    break;
                                }
                            }
                            
                            let nextTime = srtEnd;
                            for (let k = nullEnd + 1; k <= runEnd; k++) {
                                if (wordTimelineTimes[k] !== null) {
                                    nextTime = wordTimelineTimes[k].start;
                                    break;
                                }
                            }
                            
                            const durationMs = Math.max(0, nextTime - prevTime);
                            const count = nullEnd - nullStart + 1;
                            const step = durationMs / (count + 1);
                            
                            for (let k = nullStart; k <= nullEnd; k++) {
                                const offset = k - nullStart;
                                wordTimelineTimes[k] = {
                                    start: Math.round(prevTime + step * (offset + 0.1)),
                                    end: Math.round(prevTime + step * (offset + 0.9))
                                };
                            }
                        } else {
                            runIdx++;
                        }
                    }
                }
                const pStartLine = getWordLineIndex(scriptWords, plan.scriptWordStart);
                const pEndLine = getWordLineIndex(scriptWords, plan.scriptWordEnd);
                if (pStartLine !== -1 && pEndLine !== -1) {
                    for (let n = pStartLine; n <= pEndLine; n++) coveredLines.add(n);
                }
            }
            timelineCursorMs = srtEnd;
            previousCutDuration = cutDuration;

            const pStartLine = getWordLineIndex(scriptWords, plan.scriptWordStart);
            const pEndLine = getWordLineIndex(scriptWords, plan.scriptWordEnd);

            selected.push({
                segment_id: plan.planId || `clip-${plan.sourceIndex}`,
                index: i + 1,
                source_index: plan.sourceIndex + 1,
                source: plan.realClipPath || clipPath,
                script_start_line: pStartLine !== -1 ? pStartLine + 1 : null,
                script_end_line: pEndLine !== -1 ? pEndLine + 1 : null,
                script: plan.scriptText,
                is_hook: plan.isOpeningHook === true,
                hook_keep_audio: plan.hookKeepAudio !== false,
                recognized_text: plan.transcription.fullText || '',
                matched_text: plan.matchedText,
                match_score: Math.round((plan.matchScore || 0) * 1000) / 1000,
                start: plan.start,
                end: plan.end,
                cut_timing_source: getManualSrtCutRange(plan.words, plan.wordStartIdx, plan.wordEndIdx, plan.duration) ? 'srt_timecode' : 'word_timing',
                cut_selection: plan.cutSelection || (
                    plan.cutEngine === autoEditMatcherV2.ENGINE_ID ? 'v2' : 'classic'
                ),
                cut_engine: plan.cutSelection === 'manual'
                    ? 'manual'
                    : (
                        plan.cutSelection === 'v2' || plan.cutEngine === autoEditMatcherV2.ENGINE_ID
                            ? autoEditMatcherV2.ENGINE_ID
                            : 'legacy'
                    ),
                cut_score: Math.round((plan.v2CutScore || 0) * 1000) / 1000,
                legacy_start: Number.isFinite(plan.legacyStart) ? plan.legacyStart : plan.start,
                legacy_end: Number.isFinite(plan.legacyEnd) ? plan.legacyEnd : plan.end,
                v2_start: Number.isFinite(plan.v2Start) ? plan.v2Start : plan.start,
                v2_end: Number.isFinite(plan.v2End) ? plan.v2End : plan.end,
                v2_cut_available: plan.v2CutAvailable === true,
                duration: Math.round((plan.end - plan.start) * 1000) / 1000,
                source_duration: Number(plan.duration) || Math.round((plan.end - plan.start) * 1000) / 1000,
                audience_response: plan.audienceResponse || null,
                transcription_source: plan.transcription.source,
                word_timeline: (plan.words || [])
                    .filter(word => word.end > plan.start - 0.05 && word.start < plan.end + 0.05)
                    .map(word => ({
                        word: word.raw,
                        start: Math.max(0, (word.start - plan.start) / speed),
                        end: Math.min(cutDuration, (word.end - plan.start) / speed),
                    })),
            });
        }

        if (!hasReviewedTimeline && workflowMode !== 'concat_first') {
            for (let l = 0; l < lines.length; l++) {
                const lineWords = scriptWords.filter(w => w.lineIndex === l);
                if (lineWords.length === 0) continue;
                
                let lineStartMs = null;
                let lineEndMs = null;
                
                for (const w of lineWords) {
                    const t = wordTimelineTimes[w.wordIndex];
                    if (t !== null) {
                        if (lineStartMs === null || t.start < lineStartMs) lineStartMs = t.start;
                        if (lineEndMs === null || t.end > lineEndMs) lineEndMs = t.end;
                    }
                }
                
                if (lineStartMs !== null && lineEndMs !== null) {
                    srtItems.push({
                        start: lineStartMs,
                        end: lineEndMs,
                        text: lines[l]
                    });
                } else {
                    console.log(`[自动剪辑] 字幕行 #${l + 1} (${lines[l]}) 在视频中未匹配到对应的读音，跳过字幕生成`);
                }
            }
        }

        if (tempClips.length === 1) {
            emitProgress({
                percent: 86,
                stage: 'encode',
                current: 1,
                total: 1,
                message: '正在生成最终视频',
            });
            await ffmpegService.runCommand('ffmpeg', [
                '-y', '-i', tempClips[0],
                '-vf', `${videoFitFilter},fps=${fps},setsar=1`,
                '-c:v', 'libx264', '-crf', String(crf), '-preset', preset,
                '-c:a', 'aac', '-b:a', '192k',
                outputPath,
            ], { timeout: 1800000 });
        } else {
            const useTransitions = transitionType && transitionType !== 'none' && transitionDuration > 0;
            const concatFn = useTransitions ? ffmpegService.concatClipsWithTransitions : ffmpegService.concatClips;
            emitProgress({
                percent: 86,
                stage: 'concat',
                current: tempClips.length,
                total: tempClips.length,
                message: useTransitions ? '正在拼接视频并添加转场' : '正在拼接视频',
            });
            await concatFn({
                clips: tempClips,
                outputPath,
                targetWidth,
                targetHeight,
                fps,
                crf,
                preset,
                transition: transitionType,
                transitionDuration,
                skipNormalization: true,
            });
        }

        let srtPath = '';
        const subtitleUnavailable = srtItems.length === 0;
        if (subtitleUnavailable) {
            // 视频已经成功编码时，字幕匹配失败不能把整个导出误报为失败。
            // 返回空 srt_path，前端可明确显示“成片完成、字幕未生成”。
            console.warn('[自动剪辑] 未生成可用字幕行，保留已导出的无字幕成片');
            emitProgress({ percent: 92, stage: 'subtitle', current: 0, total: 0, message: '字幕未生成，保留无字幕成片' });
        } else {
            srtPath = outputPath.replace(/\.[^.]+$/, '') + '.srt';
            emitProgress({
                percent: 92,
                stage: 'subtitle',
                current: srtItems.length,
                total: srtItems.length,
                message: '正在写入最终字幕',
            });

            // 统一对 SRT 字幕条目进行排序并做时间去重重叠调整，从根本上解决字幕一闪一闪的闪烁问题
            srtItems.sort((a, b) => a.start - b.start);
            for (let idx = 1; idx < srtItems.length; idx++) {
                if (srtItems[idx].start < srtItems[idx - 1].end) {
                    srtItems[idx - 1].end = srtItems[idx].start;
                    if (srtItems[idx - 1].end <= srtItems[idx - 1].start) {
                        srtItems[idx - 1].end = srtItems[idx - 1].start + 50;
                        srtItems[idx].start = srtItems[idx - 1].end;
                        if (srtItems[idx].end <= srtItems[idx].start) {
                            srtItems[idx].end = srtItems[idx].start + 50;
                        }
                    }
                }
            }
            subtitleService.writeSRT(srtItems, srtPath);
        }

        // 临时裁切片段过去会在 finally 中删除，导致用户只能保留最终拼接成片，
        // 无法在二剪时直接复用已经确认过切点、变速和画面删除后的单段素材。
        // 把它们固定保存到成片同名工程包；原始素材仍保留在别处，二者互不替代。
        const processedClips = [];
        try {
            fs.mkdirSync(processedClipsDir, { recursive: true });
            // 自动剪辑本身导出完成就应是完整可回溯工程，不能依赖后续是否送入 Reels。
            // 保留用户输入的断行，方便二剪时直接查看或复用文案。
            fs.writeFileSync(path.join(projectDir, '文案.txt'), lines.join('\n'), 'utf8');
            for (let index = 0; index < tempClips.length; index++) {
                const sourceCut = tempClips[index];
                const plan = plans[index] || {};
                const sourceName = path.basename(plan.realClipPath || plan.clipPath || `片段_${index + 1}`).replace(/\.[^.]+$/, '');
                const safeName = sourceName.replace(/[\\/:*?"<>|]/g, '_');
                const fileName = `${String(index + 1).padStart(3, '0')}_${safeName}_${Number(plan.start || 0).toFixed(2)}-${Number(plan.end || 0).toFixed(2)}.mp4`;
                const savedPath = path.join(processedClipsDir, fileName);
                fs.copyFileSync(sourceCut, savedPath);
                processedClips.push({
                    index: index + 1,
                    path: savedPath,
                    source: plan.realClipPath || plan.clipPath || '',
                    source_start: Number(plan.start || 0),
                    source_end: Number(plan.end || 0),
                    script: plan.scriptText || '',
                    cache_signature: plan.cutCacheSignature || '',
                    reused_from_cache: plan.cutCacheHit === true,
                });
            }
            fs.writeFileSync(path.join(processedClipsDir, '处理片段清单.json'), JSON.stringify({
                version: 1,
                created_at: new Date().toISOString(),
                output_path: outputPath,
                cut_cache_dir: cutCacheDir,
                clips: processedClips,
            }, null, 2), 'utf8');
        } catch (error) {
            // 工程包收集失败不能让已成功导出的成片报失败；把原因返回前端清单即可。
            console.warn(`[AutoEdit] 保存处理片段失败: ${error.message}`);
        }

        let mp3Path = '';
        if (exportMp3 || voiceChangerEnabled) {
            mp3Path = outputPath.replace(/\.[^.]+$/, '_voicechanger.mp3');
            emitProgress({
                percent: 94,
                stage: 'mp3',
                current: 1,
                total: 1,
                message: '正在导出 Voice Changer MP3',
            });
            await ffmpegService.runCommand('ffmpeg', [
                '-y', '-i', outputPath,
                '-vn',
                '-c:a', 'libmp3lame', '-b:a', '192k', '-ac', '2',
                mp3Path,
            ], { timeout: 1800000 });
        }

        let voiceChangedMp3Path = '';
        let voiceChangedVideoPath = '';
        let manualAudioVideoPath = '';
        let finalVideoForSubtitles = outputPath;
        if (voiceChangerEnabled) {
            if (!voiceChangerVoiceId) throw new Error('已开启高级 Voice Changer，但缺少 ElevenLabs Voice ID');
            const elevenlabsKeys = elevenlabsService.loadKeys();
            if (!elevenlabsKeys || elevenlabsKeys.length === 0) throw new Error('未配置 ElevenLabs API Key，无法执行 Voice Changer');

            voiceChangedMp3Path = outputPath.replace(/\.[^.]+$/, '_voicechanged.mp3');
            emitProgress({
                percent: 96,
                stage: 'voice_change',
                current: 1,
                total: 1,
                message: '正在调用 ElevenLabs Voice Changer',
            });
            const voiceSettings = {};
            if (Number.isFinite(voiceChangerStability)) voiceSettings.stability = Math.max(0, Math.min(1, voiceChangerStability));
            if (Number.isFinite(voiceChangerSimilarity)) voiceSettings.similarity_boost = Math.max(0, Math.min(1, voiceChangerSimilarity));
            const { audio } = await elevenlabsService.requestSpeechToSpeechWithRotation(elevenlabsKeys, voiceChangerVoiceId, mp3Path, {
                modelId: voiceChangerModelId,
                outputFormat: voiceChangerOutputFormat,
                voiceSettings,
                removeBackgroundNoise: voiceChangerRemoveNoise,
            });
            fs.writeFileSync(voiceChangedMp3Path, audio);

            if (voiceChangerReplaceAudio) {
                voiceChangedVideoPath = outputPath.replace(/\.[^.]+$/, '_voicechanged.mp4');
                emitProgress({
                    percent: 97,
                    stage: 'replace_audio',
                    current: 1,
                    total: 1,
                    message: '正在替换最终视频声音',
                });
                await ffmpegService.runCommand('ffmpeg', [
                    '-y',
                    '-i', outputPath,
                    '-i', voiceChangedMp3Path,
                    '-map', '0:v:0',
                    '-map', '1:a:0',
                    '-c:v', 'copy',
                    '-c:a', 'aac',
                    '-b:a', '192k',
                    '-shortest',
                    '-movflags', '+faststart',
                    voiceChangedVideoPath,
                ], { timeout: 1800000 });
                finalVideoForSubtitles = voiceChangedVideoPath;
            }
        }

        if (manualAudioReplace) {
            if (!manualAudioPath || !fs.existsSync(manualAudioPath)) throw new Error('已选择手动替换音频，但音频文件不存在');
            manualAudioVideoPath = outputPath.replace(/\.[^.]+$/, '_manualaudio.mp4');
            emitProgress({
                percent: voiceChangerEnabled ? 98 : 96,
                stage: 'manual_replace_audio',
                current: 1,
                total: 1,
                message: '正在用手动音频替换最终视频声音',
            });
            await ffmpegService.runCommand('ffmpeg', [
                '-y',
                '-i', finalVideoForSubtitles,
                '-i', manualAudioPath,
                '-map', '0:v:0',
                '-map', '1:a:0',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-shortest',
                '-movflags', '+faststart',
                manualAudioVideoPath,
            ], { timeout: 1800000 });
            finalVideoForSubtitles = manualAudioVideoPath;
        }

        let subtitledPath = '';
        if (burnSubtitles && srtPath) {
            subtitledPath = finalVideoForSubtitles.replace(/\.[^.]+$/, '_subtitled.mp4');
            emitProgress({
                percent: voiceChangerEnabled ? 98 : 97,
                stage: 'burn',
                current: 1,
                total: 1,
                message: '正在烧录字幕',
            });
            await ffmpegService.runCommand('ffmpeg', [
                '-y', '-i', finalVideoForSubtitles,
                '-vf', `subtitles='${srtAssPath(srtPath)}'`,
                '-c:v', 'libx264', '-crf', String(crf), '-preset', preset,
                '-c:a', 'copy',
                subtitledPath,
            ], { timeout: 1800000 });
        }
        emitProgress({
            percent: 100,
            stage: 'done',
            current: selected.length,
            total: selected.length,
            message: '自动剪辑完成',
        });

        return {
            success: true,
            message: `自动剪辑完成: ${selected.length} 段${subtitleUnavailable ? '（字幕未生成，已保留无字幕成片）' : ''}`,
            output_path: outputPath,
            srt_path: srtPath,
            mp3_path: mp3Path,
            voice_changed_mp3_path: voiceChangedMp3Path,
            voice_changed_video_path: voiceChangedVideoPath,
            manual_audio_path: manualAudioPath,
            manual_audio_video_path: manualAudioVideoPath,
            subtitled_path: subtitledPath,
            final_video_path: subtitledPath || manualAudioVideoPath || voiceChangedVideoPath || outputPath,
            output_dir: outputDir,
            report_path: reportPath,
            // 送入 Reels 后需要能恢复整条自动剪辑链路，而不只是拿到成片。
            // 前端将这些字段写进二剪工程；路径均是本地引用，不复制大媒体文件。
            project_path: projectPath,
            clips,
            script_text: lines.join('\n'),
            review_segments: reviewSegments,
            processed_clips_dir: processedClipsDir,
            processed_clips: processedClips,
            matching_engine: matchingEngine,
            matching_engine_version: matchingEngineVersion,
            language,
            used_clip_count: selected.length,
            unused_clip_count: Math.max(0, clips.length - selected.length),
            unused_script_count: Math.max(0, lines.length - coveredLines.size),
            transition_type: transitionType,
            transition_duration: transitionDuration,
            output_settings: { width: targetWidth, height: targetHeight, fps, source: 'first_clip', fit_mode: fitMode },
            segments: selected,
        };
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
    }
}

module.exports = {
    autoEditByScript,
    generateSrtForAudioScript,
    splitScriptLines,
    normalizeText,
    findBestWordWindow,
    findBestScriptWindowForClip,
    computeAutoEditTransitionSec,
    _test: { getWordLineIndex, scoreCandidate, scoreWordCandidate, isLikelyDuplicateTranscription, transcribeClip, recoverSmallBoundaryGaps, trimOverlappingBoundaryReadings, hasSentenceEndingPunctuation, findRepeatedScriptBlockStarts, findFuzzyBoundaryOverlap, normalizeAutoEditSpeed },
};
