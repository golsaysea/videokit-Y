const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const https = require('https');
const { spawn } = require('child_process');
const settings = require('./settings');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const BASE_HOST = 'speech.platform.bing.com';
const BASE_PATH = '/consumer/speech/synthesize/readaloud';
const VOICES_URL = `https://${BASE_HOST}${BASE_PATH}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.', 1)[0];
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const WIN_EPOCH_SECONDS = 11644473600;
const TICKS_PER_SECOND = 10000000;

const _SHA256_INITIAL = [
    0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
    0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
];
const _SHA256_STATE = [
    0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A,
    0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2,
];
const _SHA256_SCHEDULE = [
    0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA,
    0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
    0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33,
    0xD258B060, 0x72766564,
];
const _SHA256_ROUND_CONSTANTS = [
    0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
    0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
    0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
    0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
    0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
    0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
    0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
    0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];
const _SHA256_ADJUSTMENT = 0xC9DC06A7;
const _SHA256_BLOCK_CONSTANTS = [
    ..._SHA256_ROUND_CONSTANTS.slice(0, 14),
    _SHA256_ADJUSTMENT,
    ..._SHA256_ROUND_CONSTANTS.slice(15),
];
const _SHA256_SIGMA0_ADJUSTMENT = 0x059C0B80;
const _SHA256_SIGMA1_ADJUSTMENT = 0x000B92C0;
const _CS64_COEFFICIENTS = [
    [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038], [0xC89C5933, 0xB328CBDF],
    [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C], [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB],
    [0x06064CF3, 0xFA51A3DA], [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
    [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167],
];
const _CS64_FACTOR = 0x82893933;
const _CS64_ADJUSTMENT0 = 0xF2F90B1A;
const _CS64_ADJUSTMENT1 = 0x0B1A0000;

const _rotr32 = (v, n) => ((v >>> n) | (v << (32 - n))) >>> 0;
const _rol16 = v => ((v << 16) | (v >>> 16)) >>> 0;
const _sigma0 = v => (_rotr32(v, 7) ^ _rotr32(v, 18) ^ (v >>> 3)) >>> 0;
const _sigma1 = v => (_rotr32(v, 17) ^ _rotr32(v, 19) ^ (v >>> 10)) >>> 0;
const _u32Mul = (a, b) => Math.imul(a, b) >>> 0;

function _expandSha256Schedule(words, firstWord = 16) {
    for (let i = firstWord; i < 64; i++) {
        words.push((_sigma1(words[i - 2]) + words[i - 7] + _sigma0(words[i - 15]) + words[i - 16]) >>> 0);
    }
}

function _sha256Rounds(state, words, firstRound = 0) {
    let [a, b, c, d, e, f, g, h] = state;
    const constants = firstRound === 14 ? _SHA256_BLOCK_CONSTANTS : _SHA256_ROUND_CONSTANTS;
    for (let i = firstRound; i < 64; i++) {
        const s1 = _rotr32(e, 6) ^ _rotr32(e, 11) ^ _rotr32(e, 25);
        const ch = (g ^ (e & (f ^ g))) >>> 0;
        const t1 = (h + s1 + ch + constants[i] + words[i]) >>> 0;
        const s0 = _rotr32(a, 2) ^ _rotr32(a, 13) ^ _rotr32(a, 22);
        const maj = ((a & b) | (c & (a | b))) >>> 0;
        const t2 = (s0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    return [a, b, c, d, e, f, g, h];
}

function _sha256Init(data7) {
    const words = new Array(14).fill(0);
    words.push(((data7[0] << 16) | (data7[1] << 8) | data7[2]) >>> 0);
    words.push(data7.readUInt32BE(3));
    for (let i = 16; i < 30; i++) {
        let value = _SHA256_SCHEDULE[i - 16];
        if (i - 2 >= 14) {
            value = (value + (i === 16 ? (_sigma1(words[i - 2]) ^ _SHA256_SIGMA1_ADJUSTMENT) : _sigma1(words[i - 2]))) >>> 0;
        }
        if (i - 7 >= 14) value = (value + words[i - 7]) >>> 0;
        if (i - 15 >= 14) {
            value = (value + (i === 29 ? (_sigma0(words[i - 15]) ^ _SHA256_SIGMA0_ADJUSTMENT) : _sigma0(words[i - 15]))) >>> 0;
        }
        words.push(value >>> 0);
    }
    words.push((_sigma1(words[28]) + words[23] + _sigma0(words[15]) + words[14] + _SHA256_ADJUSTMENT - _SHA256_ROUND_CONSTANTS[14]) >>> 0);
    _expandSha256Schedule(words, 31);
    const working = _sha256Rounds(_SHA256_STATE, words, 14);
    return _SHA256_INITIAL.map((x, idx) => (x + working[idx]) >>> 0);
}

function _sha256Digest(data) {
    const length = 57 + data.length;
    const padZeroCount = ((55 - length) % 64 + 64) % 64;
    const tail = data.subarray(7);
    const padded = Buffer.alloc(tail.length + 1 + padZeroCount + 8);
    tail.copy(padded, 0);
    padded[tail.length] = 0x80;
    padded.writeBigUInt64BE(BigInt(length * 8), padded.length - 8);
    let state = _sha256Init(data.subarray(0, 7));
    for (let offset = 0; offset < padded.length; offset += 64) {
        const words = [];
        for (let j = 0; j < 16; j++) words.push(padded.readUInt32BE(offset + j * 4));
        _expandSha256Schedule(words, 16);
        const working = _sha256Rounds(state, words, 0);
        state = state.map((x, idx) => (x + working[idx]) >>> 0);
    }
    const out = Buffer.alloc(32);
    for (let i = 0; i < 8; i++) out.writeUInt32BE(state[i], i * 4);
    return out;
}

function _wordsLe4Even(data) {
    const rem = (4 - (data.length % 4)) % 4;
    const padded = rem ? Buffer.concat([data, Buffer.alloc(rem)]) : data;
    const words = [];
    for (let i = 0; i < padded.length; i += 4) words.push(padded.readUInt32LE(i));
    if (words.length % 2 === 1) words.push(0);
    return words;
}

function _cs64Digest(data, digest) {
    const keyA = (digest.readUInt32LE(0) | 1) >>> 0;
    const keyB = (digest.readUInt32LE(4) | 1) >>> 0;
    const factors = [_u32Mul(keyA, _CS64_FACTOR), _u32Mul(keyB, _CS64_FACTOR)];
    const terms = _CS64_COEFFICIENTS.map(([coeff], idx) => _u32Mul(coeff, factors[idx % 2]));
    const offsets = _CS64_COEFFICIENTS.map(([, off]) => off >>> 0);
    const words = _wordsLe4Even(Buffer.concat([Buffer.from([0]), data]));
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        let term = _u32Mul(word, i % 2 === 0 ? keyA : keyB);
        let offset = _u32Mul(_rol16(word), i % 2 === 0 ? 0xEF0569FB : 0xC31713DB);
        if (i === 0) {
            term = (term + _u32Mul(_CS64_ADJUSTMENT0, factors[0])) >>> 0;
            offset = (offset + _CS64_ADJUSTMENT1) >>> 0;
        }
        terms.push(term);
        offsets.push(offset);
    }
    let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
    for (let i = 0; i < terms.length; i += 2) {
        const x = terms[i], y = terms[i + 1];
        let t = _rol16((offsets[i] + x) >>> 0);
        let q = _u32Mul(t, 0x76F50F34);
        swapAcc = (swapAcc + ((_u32Mul(_rol16(q), 0xC3EFEA97) + q) >>> 0)) >>> 0;
        t = _rol16((offsets[i + 1] + y) >>> 0);
        q = _u32Mul(t, 0x1881CE3C);
        swapLast = (_u32Mul(_rol16(q), 0x35BD1EC9) + q) >>> 0;
        swapAcc = (swapAcc + swapLast) >>> 0;

        state = (_u32Mul(state, keyA) + x) >>> 0;
        state = _u32Mul(_rol16(state), 0xCF98B111);
        state = _u32Mul(_rol16(state), 0x87085B9F);
        state = _u32Mul(_rol16(state), 0x12CEB96D);
        state = _u32Mul(_rol16(state), 0x257E1D83);
        acc = (acc + state) >>> 0;
        t = (_u32Mul(state, keyB) + y) >>> 0;
        t = _u32Mul(_rol16(t), 0xA27416F5);
        t = _u32Mul(_rol16(t), 0xD38396FF);
        state = _u32Mul(_rol16(_u32Mul(_rol16(t), 0x7C932B89)), 0xBFA49F69);
        acc = (acc + state) >>> 0;
    }
    const csBuf = Buffer.alloc(8);
    csBuf.writeUInt32LE((swapLast ^ state) >>> 0, 0);
    csBuf.writeUInt32LE((swapAcc ^ acc) >>> 0, 4);
    return `${csBuf.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`;
}

let clockSkewSeconds = 0;

const BASE_HEADERS = {
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
};

const VOICE_HEADERS = {
    Authority: BASE_HOST,
    'Sec-CH-UA': `" Not;A Brand";v="99", "Microsoft Edge";v="${CHROMIUM_MAJOR_VERSION}", "Chromium";v="${CHROMIUM_MAJOR_VERSION}"`,
    'Sec-CH-UA-Mobile': '?0',
    Accept: '*/*',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    ...BASE_HEADERS,
};

const FALLBACK_VOICES = [
    { ShortName: 'en-US-AvaMultilingualNeural', FriendlyName: 'Microsoft AvaMultilingual Online (Natural) - English (United States)', Locale: 'en-US', Gender: 'Female', LocalName: 'Ava Multilingual', DisplayName: 'Ava Multilingual' },
    { ShortName: 'en-US-EmmaMultilingualNeural', FriendlyName: 'Microsoft EmmaMultilingual Online (Natural) - English (United States)', Locale: 'en-US', Gender: 'Female', LocalName: 'Emma Multilingual', DisplayName: 'Emma Multilingual' },
    { ShortName: 'en-US-AndrewMultilingualNeural', FriendlyName: 'Microsoft AndrewMultilingual Online (Natural) - English (United States)', Locale: 'en-US', Gender: 'Male', LocalName: 'Andrew Multilingual', DisplayName: 'Andrew Multilingual' },
    { ShortName: 'en-US-BrianMultilingualNeural', FriendlyName: 'Microsoft BrianMultilingual Online (Natural) - English (United States)', Locale: 'en-US', Gender: 'Male', LocalName: 'Brian Multilingual', DisplayName: 'Brian Multilingual' },
    { ShortName: 'en-US-AriaNeural', FriendlyName: 'Microsoft Aria Online (Natural) - English (United States)', Locale: 'en-US', Gender: 'Female', LocalName: 'Aria', DisplayName: 'Aria' },
    { ShortName: 'en-US-JennyNeural', FriendlyName: 'Microsoft Jenny Online (Natural) - English (United States)', Locale: 'en-US', Gender: 'Female', LocalName: 'Jenny', DisplayName: 'Jenny' },
    { ShortName: 'en-US-GuyNeural', FriendlyName: 'Microsoft Guy Online (Natural) - English (United States)', Locale: 'en-US', Gender: 'Male', LocalName: 'Guy', DisplayName: 'Guy' },
    { ShortName: 'en-US-ChristopherNeural', FriendlyName: 'Microsoft Christopher Online (Natural) - English (United States)', Locale: 'en-US', Gender: 'Male', LocalName: 'Christopher', DisplayName: 'Christopher' },
    { ShortName: 'en-GB-SoniaNeural', FriendlyName: 'Microsoft Sonia Online (Natural) - English (United Kingdom)', Locale: 'en-GB', Gender: 'Female', LocalName: 'Sonia', DisplayName: 'Sonia' },
    { ShortName: 'en-GB-RyanNeural', FriendlyName: 'Microsoft Ryan Online (Natural) - English (United Kingdom)', Locale: 'en-GB', Gender: 'Male', LocalName: 'Ryan', DisplayName: 'Ryan' },
    { ShortName: 'zh-CN-XiaoxiaoNeural', FriendlyName: 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)', Locale: 'zh-CN', Gender: 'Female', LocalName: '晓晓', DisplayName: 'Xiaoxiao' },
    { ShortName: 'zh-CN-YunxiNeural', FriendlyName: 'Microsoft Yunxi Online (Natural) - Chinese (Mainland)', Locale: 'zh-CN', Gender: 'Male', LocalName: '云希', DisplayName: 'Yunxi' },
    { ShortName: 'zh-CN-YunjianNeural', FriendlyName: 'Microsoft Yunjian Online (Natural) - Chinese (Mainland)', Locale: 'zh-CN', Gender: 'Male', LocalName: '云健', DisplayName: 'Yunjian' },
    { ShortName: 'zh-CN-XiaoyiNeural', FriendlyName: 'Microsoft Xiaoyi Online (Natural) - Chinese (Mainland)', Locale: 'zh-CN', Gender: 'Female', LocalName: '晓伊', DisplayName: 'Xiaoyi' },
    { ShortName: 'it-IT-ElsaNeural', FriendlyName: 'Microsoft Elsa Online (Natural) - Italian (Italy)', Locale: 'it-IT', Gender: 'Female', LocalName: 'Elsa', DisplayName: 'Elsa' },
    { ShortName: 'it-IT-DiegoNeural', FriendlyName: 'Microsoft Diego Online (Natural) - Italian (Italy)', Locale: 'it-IT', Gender: 'Male', LocalName: 'Diego', DisplayName: 'Diego' },
];

function connectId() {
    return crypto.randomUUID().replace(/-/g, '');
}

function generateMuid() {
    return crypto.randomBytes(16).toString('hex').toUpperCase();
}

function edgeDateString() {
    const date = new Date(Date.now() + clockSkewSeconds * 1000);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')} ${date.getUTCFullYear()} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')} GMT+0000 (Coordinated Universal Time)`;
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function removeIncompatibleCharacters(value) {
    return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
}

function generateSecMsGec() {
    let seconds = Math.floor(Date.now() / 1000 + clockSkewSeconds + WIN_EPOCH_SECONDS);
    seconds -= seconds % 300;
    const ticks = seconds * TICKS_PER_SECOND;
    const strToHash = Buffer.from(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`, 'ascii');
    const digest = _sha256Digest(strToHash);
    return _cs64Digest(strToHash, digest);
}

function adjustClockSkewFromDateHeader(dateHeader) {
    if (!dateHeader) return false;
    const parsed = Date.parse(dateHeader);
    if (!Number.isFinite(parsed)) return false;
    const serverSeconds = parsed / 1000;
    const localSeconds = Date.now() / 1000 + clockSkewSeconds;
    clockSkewSeconds += serverSeconds - localSeconds;
    return true;
}

function normalizeLocale(voice) {
    const parts = String(voice || '').replace(/^edge:/, '').split('-');
    return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : 'en-US';
}

function buildSsml(text, options = {}) {
    const voice = options.voice || 'en-US-AvaMultilingualNeural';
    const rate = options.rate || '+0%';
    const pitch = options.pitch || '+0Hz';
    const locale = normalizeLocale(voice);
    const escapedText = escapeXml(removeIncompatibleCharacters(text));
    return [
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">`,
        `<voice name="${voice}">`,
        `<prosody rate="${rate}" pitch="${pitch}">${escapedText}</prosody>`,
        '</voice>',
        '</speak>',
    ].join('');
}

function buildConfigMessage() {
    const payload = {
        context: {
            synthesis: {
                audio: {
                    metadataoptions: {
                        sentenceBoundaryEnabled: 'true',
                        wordBoundaryEnabled: 'false',
                    },
                    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
                },
            },
        },
    };
    return [
        `X-Timestamp:${edgeDateString()}`,
        'Content-Type:application/json; charset=utf-8',
        'Path:speech.config',
        '',
        JSON.stringify(payload),
        '',
    ].join('\r\n');
}

function buildSsmlMessage(requestId, ssml) {
    return [
        `X-RequestId:${requestId}`,
        'Content-Type:application/ssml+xml',
        `X-Timestamp:${edgeDateString()}Z`,
        'Path:ssml',
        '',
        ssml,
    ].join('\r\n');
}

function parseHeaders(text) {
    const headers = {};
    for (const line of String(text).split(/\r\n|\n|\r/)) {
        const index = line.indexOf(':');
        if (index > -1) headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    return headers;
}

function parseTextMessage(text) {
    const splitAt = String(text).indexOf('\r\n\r\n');
    if (splitAt === -1) return [parseHeaders(text), ''];
    return [parseHeaders(String(text).slice(0, splitAt)), String(text).slice(splitAt + 4)];
}

function parseBinaryMessage(data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (bytes.length < 2) throw new Error('收到的音频包不完整。');
    const headerLength = bytes.readUInt16BE(0);
    const headerEnd = 2 + headerLength;
    if (headerEnd > bytes.length) throw new Error('收到的音频包头部异常。');
    const headerText = bytes.subarray(2, headerEnd).toString('utf8');
    return [parseHeaders(headerText), bytes.subarray(headerEnd)];
}

function formatSrtTimestamp(ticks100ns) {
    const totalMs = Math.max(0, Math.round(Number(ticks100ns || 0) / 10000));
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function buildSrtFromMetadata(cues, fallbackText = '') {
    if (!Array.isArray(cues) || !cues.length) {
        const clean = String(fallbackText || '').trim();
        if (!clean) return '';
        const sentences = clean.split(/(?<=[.!?。！？\n])\s*/).map(s => s.trim()).filter(Boolean);
        if (!sentences.length) return `1\n00:00:00,000 --> 00:00:03,000\n${clean}\n`;
        let cursorMs = 0;
        return sentences.map((line, idx) => {
            const durMs = Math.max(1200, Math.min(8000, line.length * 160));
            const start = formatSrtTimestamp(cursorMs * 10000);
            cursorMs += durMs;
            const end = formatSrtTimestamp(cursorMs * 10000);
            return `${idx + 1}\n${start} --> ${end}\n${line}\n`;
        }).join('\n');
    }
    return cues.map((cue, idx) => {
        const start = formatSrtTimestamp(cue.offset);
        const end = formatSrtTimestamp(cue.offset + Math.max(cue.duration || 0, 5000000));
        return `${idx + 1}\n${start} --> ${end}\n${cue.text}\n`;
    }).join('\n');
}

function encodeWsFrame(opcode, payloadBuffer) {
    const payload = Buffer.isBuffer(payloadBuffer) ? payloadBuffer : Buffer.from(payloadBuffer);
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
        masked[i] = payload[i] ^ mask[i & 3];
    }
    return Buffer.concat([header, mask, masked]);
}

function synthesizeViaNativeWsOnce(text, options = {}, timeoutMs = 45000) {
    const cleanText = String(text || '').trim();
    if (!cleanText) throw new Error('配音文案不能为空');

    const requestId = connectId();
    const wsPath = `${BASE_PATH}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${requestId}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
    const ssml = buildSsml(cleanText, options);
    const wsKey = crypto.randomBytes(16).toString('base64');

    return new Promise((resolve, reject) => {
        const audioChunks = [];
        const cues = [];
        let audioReceived = false;
        let settled = false;
        let upgraded = false;
        let rxBuffer = Buffer.alloc(0);
        let fragOpcode = 0;
        let fragChunks = [];
        let timer = null;

        const socket = tls.connect({
            host: BASE_HOST,
            port: 443,
            servername: BASE_HOST,
            ALPNProtocols: ['http/1.1'],
        });

        function finish(error, result) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try { socket.destroy(); } catch (_) {}
            if (error) reject(error);
            else resolve(result);
        }

        function resetTimer() {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                finish(new Error('微软在线配音超时，请检查网络后重试'));
            }, timeoutMs);
        }

        resetTimer();

        socket.on('secureConnect', () => {
            resetTimer();
            const reqLines = [
                `GET ${wsPath} HTTP/1.1`,
                `Host: ${BASE_HOST}`,
                'Pragma: no-cache',
                'Cache-Control: no-cache',
                `User-Agent: ${BASE_HEADERS['User-Agent']}`,
                'Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
                `Accept-Encoding: ${BASE_HEADERS['Accept-Encoding']}`,
                `Accept-Language: ${BASE_HEADERS['Accept-Language']}`,
                `Cookie: muid=${generateMuid()};`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Key: ${wsKey}`,
                'Sec-WebSocket-Version: 13',
                '',
                '',
            ];
            socket.write(reqLines.join('\r\n'));
        });

        socket.on('error', err => {
            if (audioReceived && audioChunks.length > 0) {
                finish(null, {
                    audio: Buffer.concat(audioChunks),
                    srt: buildSrtFromMetadata(cues, cleanText),
                    usedKey: null,
                });
                return;
            }
            finish(new Error(`连接 Edge-TTS 服务失败：${err.message}`));
        });

        socket.on('close', () => {
            if (settled) return;
            if (!audioReceived) {
                finish(new Error('微软服务未返回音频，请稍后重试'));
                return;
            }
            finish(null, {
                audio: Buffer.concat(audioChunks),
                srt: buildSrtFromMetadata(cues, cleanText),
                usedKey: null,
            });
        });

        function handleWsMessage(opcode, payload) {
            resetTimer();
            if (opcode === 0x1) {
                const [headers, body] = parseTextMessage(payload.toString('utf8'));
                if (headers.Path === 'audio.metadata' && body) {
                    try {
                        const meta = JSON.parse(body);
                        for (const item of (meta.Metadata || [])) {
                            if ((item.Type === 'SentenceBoundary' || item.Type === 'WordBoundary') && item.Data) {
                                const cueText = item.Data.text?.Text || item.Data.Text || '';
                                if (cueText) {
                                    cues.push({
                                        offset: Number(item.Data.Offset || 0),
                                        duration: Number(item.Data.Duration || 0),
                                        text: cueText,
                                    });
                                }
                            }
                        }
                    } catch (_) {}
                } else if (headers.Path === 'turn.end') {
                    if (!audioReceived) {
                        finish(new Error('微软服务未返回音频，请稍后重试'));
                    } else {
                        finish(null, {
                            audio: Buffer.concat(audioChunks),
                            srt: buildSrtFromMetadata(cues, cleanText),
                            usedKey: null,
                        });
                    }
                }
            } else if (opcode === 0x2) {
                const [headers, audioData] = parseBinaryMessage(payload);
                if (headers.Path === 'audio' && audioData.byteLength > 0) {
                    audioChunks.push(Buffer.from(audioData));
                    audioReceived = true;
                }
            } else if (opcode === 0x8) {
                if (audioReceived) {
                    finish(null, {
                        audio: Buffer.concat(audioChunks),
                        srt: buildSrtFromMetadata(cues, cleanText),
                        usedKey: null,
                    });
                } else {
                    finish(new Error('连接提前关闭，未收到音频数据'));
                }
            } else if (opcode === 0x9) {
                socket.write(encodeWsFrame(0xA, payload));
            }
        }

        function processFrames() {
            while (rxBuffer.length >= 2 && !settled) {
                const b0 = rxBuffer[0];
                const b1 = rxBuffer[1];
                const fin = (b0 & 0x80) !== 0;
                const opcode = b0 & 0x0f;
                const masked = (b1 & 0x80) !== 0;
                let payloadLen = b1 & 0x7f;
                let offset = 2;

                if (payloadLen === 126) {
                    if (rxBuffer.length < 4) return;
                    payloadLen = rxBuffer.readUInt16BE(2);
                    offset = 4;
                } else if (payloadLen === 127) {
                    if (rxBuffer.length < 10) return;
                    payloadLen = Number(rxBuffer.readBigUInt64BE(2));
                    offset = 10;
                }

                const maskBytes = masked ? 4 : 0;
                if (rxBuffer.length < offset + maskBytes + payloadLen) return;

                let payload = rxBuffer.subarray(offset + maskBytes, offset + maskBytes + payloadLen);
                if (masked) {
                    const mask = rxBuffer.subarray(offset, offset + 4);
                    const unmasked = Buffer.alloc(payloadLen);
                    for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ mask[i & 3];
                    payload = unmasked;
                }
                rxBuffer = rxBuffer.subarray(offset + maskBytes + payloadLen);

                if (opcode === 0x0) {
                    fragChunks.push(Buffer.from(payload));
                    if (fin) {
                        const full = Buffer.concat(fragChunks);
                        const op = fragOpcode;
                        fragChunks = [];
                        fragOpcode = 0;
                        handleWsMessage(op, full);
                    }
                } else if (!fin && (opcode === 0x1 || opcode === 0x2)) {
                    fragOpcode = opcode;
                    fragChunks = [Buffer.from(payload)];
                } else {
                    handleWsMessage(opcode, Buffer.from(payload));
                }
            }
        }

        socket.on('data', chunk => {
            if (settled) return;
            rxBuffer = Buffer.concat([rxBuffer, chunk]);
            if (!upgraded) {
                const headerEnd = rxBuffer.indexOf('\r\n\r\n');
                if (headerEnd === -1) return;
                const headerStr = rxBuffer.subarray(0, headerEnd).toString('utf8');
                rxBuffer = rxBuffer.subarray(headerEnd + 4);
                const statusLine = headerStr.split(/\r\n/)[0] || '';
                const statusMatch = statusLine.match(/HTTP\/1\.[01]\s+(\d+)/);
                const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
                const respHeaders = parseHeaders(headerStr);
                if (statusCode !== 101) {
                    const err = new Error(`Edge-TTS WebSocket unexpected response: HTTP ${statusCode}`);
                    err.statusCode = statusCode;
                    err.serverDate = respHeaders.Date || respHeaders.date;
                    finish(err);
                    return;
                }
                upgraded = true;
                socket.write(encodeWsFrame(0x1, Buffer.from(buildConfigMessage(), 'utf8')));
                socket.write(encodeWsFrame(0x1, Buffer.from(buildSsmlMessage(requestId, ssml), 'utf8')));
            }
            if (upgraded && rxBuffer.length > 0) {
                try {
                    processFrames();
                } catch (e) {
                    finish(e);
                }
            }
        });
    });
}

async function synthesizeNative(text, options = {}, timeoutMs = 45000) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await synthesizeViaNativeWsOnce(text, options, timeoutMs);
        } catch (error) {
            lastError = error;
            if (error.statusCode === 403 && error.serverDate) {
                adjustClockSkewFromDateHeader(error.serverDate);
            }
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
                continue;
            }
        }
    }
    throw lastError || new Error('连接 Edge-TTS 服务失败。');
}

function splitTextIntoChunks(text, maxChars = 180) {
    const clean = String(text || '').trim();
    if (!clean) return [];
    const rawParts = clean.split(/(?<=[.!?。！？；;\n])\s*/).map(s => s.trim()).filter(Boolean);
    const chunks = [];
    let current = '';
    for (const part of rawParts) {
        if ((current + ' ' + part).trim().length <= maxChars) {
            current = (current + ' ' + part).trim();
        } else {
            if (current) chunks.push(current);
            if (part.length <= maxChars) {
                current = part;
            } else {
                for (let i = 0; i < part.length; i += maxChars) {
                    chunks.push(part.slice(i, i + maxChars));
                }
                current = '';
            }
        }
    }
    if (current) chunks.push(current);
    return chunks.length ? chunks : [clean.slice(0, maxChars)];
}

function fetchHttpsBuffer(url, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': BASE_HEADERS['User-Agent'] }, timeout: timeoutMs }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                fetchHttpsBuffer(res.headers.location, timeoutMs).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('timeout', () => req.destroy(new Error('请求超时')));
        req.on('error', reject);
    });
}

async function synthesizeCloudFallback(text, options = {}) {
    const locale = normalizeLocale(options.voice || 'en-US-AvaMultilingualNeural');
    const rateNum = parseInt(String(options.rate || '+0%'), 10) || 0;
    const slowParam = rateNum <= -20 ? '0.24' : '1';
    const chunks = splitTextIntoChunks(text, 180);
    const buffers = [];
    for (const chunk of chunks) {
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=${encodeURIComponent(locale)}&ttsspeed=${slowParam}&client=tw-ob`;
        const buf = await fetchHttpsBuffer(url, 20000);
        if (buf && buf.length > 0) buffers.push(buf);
    }
    if (!buffers.length) throw new Error('在线语音合成未返回音频数据');
    return {
        audio: Buffer.concat(buffers),
        usedKey: null,
        srt: buildSrtFromMetadata([], text),
    };
}

function fetchVoicesNative(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const req = https.get(VOICES_URL, { headers: VOICE_HEADERS, timeout: timeoutMs }, res => {
            if (res.headers?.date) adjustClockSkewFromDateHeader(res.headers.date);
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`语音列表加载失败：HTTP ${res.statusCode}`));
                return;
            }
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                try {
                    const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    resolve(raw);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('timeout', () => { req.destroy(new Error('加载语音列表超时')); });
        req.on('error', reject);
    });
}

function formatVoiceEntry(v) {
    const shortName = String(v.ShortName || v.voice_id || '').replace(/^edge:/, '');
    const locale = v.Locale || v.locale || '';
    const gender = v.Gender || v.gender || '';
    return {
        voice_id: 'edge:' + shortName,
        ShortName: shortName,
        name: v.FriendlyName || v.DisplayName || v.name || shortName,
        FriendlyName: v.FriendlyName || v.DisplayName || v.name || shortName,
        LocalName: v.LocalName || v.DisplayName || v.FriendlyName || shortName,
        DisplayName: v.DisplayName || v.LocalName || v.FriendlyName || shortName,
        locale,
        Locale: locale,
        gender,
        Gender: gender,
        category: `${locale} · ${gender}`,
    };
}

function pythonPath() {
    if (process.env.VIDEOKIT_EDGE_PYTHON) return process.env.VIDEOKIT_EDGE_PYTHON;
    const root = path.join(__dirname, '..', '..');
    const candidates = [
        path.join(root, '.venv-edge', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
        ...(process.resourcesPath ? [path.join(process.resourcesPath, 'vendor', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')] : []),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new Error('尚未安装微软配音环境，请运行 VideoKit 目录的 setup-edge-tts.cmd 后重试');
    return found;
}

function invokePythonBridge(payload, timeout = 600000) {
    return new Promise((resolve, reject) => {
        let python;
        try { python = pythonPath(); } catch (error) { reject(error); return; }
        const packagedBridge = process.resourcesPath && path.join(process.resourcesPath, 'edge-tts', 'edge_tts_bridge.py');
        const bridge = packagedBridge && fs.existsSync(packagedBridge) ? packagedBridge : path.join(__dirname, 'edge_tts_bridge.py');
        const child = spawn(python, ['-u', bridge], {
            windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1' },
        });
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        let out = '', err = '', settled = false;
        const finish = (error, result) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            if (error) reject(error); else resolve(result);
        };
        const timer = setTimeout(() => { child.kill(); finish(new Error('微软在线配音超时，请检查网络后重试')); }, timeout);
        child.on('error', error => finish(new Error(`无法启动微软配音：${error.message}`)));
        child.stdin.on('error', error => finish(error));
        child.stdout.on('data', chunk => { out += chunk.toString('utf8'); });
        child.stderr.on('data', chunk => { err = (err + chunk.toString('utf8')).slice(-3000); });
        child.on('close', code => {
            try {
                const result = JSON.parse(out);
                if (code !== 0 || result.error) throw new Error(result.error || err || '微软配音失败');
                finish(null, result);
            } catch (error) {
                finish(new Error(err.includes('No module named') ? '微软配音依赖缺失，请运行 setup-edge-tts.cmd' : `微软在线朗读失败：${error.message}`));
            }
        });
        child.stdin.end(JSON.stringify(payload));
    });
}

function parseVoice(voice) {
    const shortName = String(voice || '').replace(/^edge:/, '');
    if (!/^[a-z]{2,3}-[A-Za-z0-9-]+Neural$/.test(shortName)) throw new Error('请选择有效的微软 Edge 音色');
    return shortName;
}

function normalizeRate(rate = '+0%') {
    const s = String(rate || '+0%').trim();
    if (/^[+-]\d+%$/.test(s) && Math.abs(parseInt(s, 10)) <= 100) return s;
    throw new Error('语速必须介于 -100% 与 +100%');
}

function normalizePitch(pitch = '+0Hz') {
    const s = String(pitch || '+0Hz').trim();
    if (/^[+-]\d+Hz$/i.test(s) && Math.abs(parseInt(s, 10)) <= 100) return s;
    return '+0Hz';
}

let voicesCache = null;

async function listVoices(refresh = false) {
    if (!refresh && voicesCache) return voicesCache;
    if (process.env.VIDEOKIT_EDGE_PYTHON) {
        const result = await invokePythonBridge({ action: 'voices' }, 45000);
        if (!Array.isArray(result.voices) || !result.voices.length) throw new Error('微软没有返回可用音色');
        voicesCache = { voices: result.voices.map(formatVoiceEntry) };
        return voicesCache;
    }
    try {
        const rawList = await fetchVoicesNative(20000);
        if (Array.isArray(rawList) && rawList.length > 0) {
            voicesCache = { voices: rawList.map(formatVoiceEntry), status: 'ok' };
            return voicesCache;
        }
    } catch (_) {
        try {
            const result = await invokePythonBridge({ action: 'voices' }, 30000);
            if (Array.isArray(result.voices) && result.voices.length > 0) {
                voicesCache = { voices: result.voices.map(formatVoiceEntry), status: 'ok' };
                return voicesCache;
            }
        } catch (__) {}
    }
    voicesCache = { voices: FALLBACK_VOICES.map(formatVoiceEntry), status: 'fallback' };
    return voicesCache;
}

async function synthesize(text, voice, rate = '+0%', pitch = '+0Hz') {
    const shortName = parseVoice(voice);
    if (!String(text || '').trim()) throw new Error('配音文案不能为空');
    const validRate = normalizeRate(rate);
    const validPitch = normalizePitch(pitch);

    if (process.env.VIDEOKIT_EDGE_PYTHON) {
        const output = path.join(settings.getSecureTmpDir(), `edge_${crypto.randomUUID()}.mp3`);
        try {
            const result = await invokePythonBridge({ action: 'synthesize', text, voice: shortName, rate: validRate, output });
            return { audio: fs.readFileSync(output), usedKey: null, srt: result.srt || '' };
        } finally {
            if (fs.existsSync(output)) fs.unlinkSync(output);
        }
    }

    try {
        return await synthesizeNative(text, { voice: shortName, rate: validRate, pitch: validPitch }, 30000);
    } catch (nativeErr) {
        try {
            const output = path.join(settings.getSecureTmpDir(), `edge_${crypto.randomUUID()}.mp3`);
            try {
                const result = await invokePythonBridge({ action: 'synthesize', text, voice: shortName, rate: validRate, pitch: validPitch, output });
                return { audio: fs.readFileSync(output), usedKey: null, srt: result.srt || '' };
            } finally {
                if (fs.existsSync(output)) fs.unlinkSync(output);
            }
        } catch (_) {
            throw nativeErr;
        }
    }
}

function safeSegment(value, fallback = 'Default') {
    const cleaned = String(value || '')
        .trim()
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/[. ]+$/g, '')
        .slice(0, 80);
    return cleaned || fallback;
}

function safeFileName(value, fallback = 'voice.mp3') {
    const cleaned = path.basename(String(value || '').trim())
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/[. ]+$/g, '')
        .slice(0, 140);
    return cleaned || fallback;
}

function resolveTaskFolder(baseFolder, taskName) {
    const os = require('os');
    const root = path.resolve(String(baseFolder || path.join(os.homedir(), 'Downloads')));
    const trimmedTask = String(taskName || '').trim();
    if (!trimmedTask) return root;
    return path.join(root, safeSegment(trimmedTask, '第一期'));
}

const _crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    _crcTable[n] = c >>> 0;
}

function _crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = _crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function _dosDateTime(date = new Date()) {
    const year = Math.max(date.getFullYear(), 1980);
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { dosTime, dosDate };
}

function createZipBuffer(entries) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const { dosTime, dosDate } = _dosDateTime();

    for (const entry of entries) {
        const data = Buffer.from(entry.data);
        const name = Buffer.from(entry.name, 'utf8');
        const crc = _crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(dosTime, 10);
        local.writeUInt16LE(dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        chunks.push(local, name, data);

        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(20, 6);
        header.writeUInt16LE(0x0800, 8);
        header.writeUInt16LE(0, 10);
        header.writeUInt16LE(dosTime, 12);
        header.writeUInt16LE(dosDate, 14);
        header.writeUInt32LE(crc, 16);
        header.writeUInt32LE(data.length, 20);
        header.writeUInt32LE(data.length, 24);
        header.writeUInt16LE(name.length, 28);
        header.writeUInt16LE(0, 30);
        header.writeUInt16LE(0, 32);
        header.writeUInt16LE(0, 34);
        header.writeUInt16LE(0, 36);
        header.writeUInt32LE(0, 38);
        header.writeUInt32LE(offset, 42);
        central.push(header, name);

        offset += local.length + name.length + data.length;
    }

    const centralStart = offset;
    const centralBuffer = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...chunks, centralBuffer, end]);
}

function _uniqueName(name, used) {
    if (!used.has(name)) {
        used.add(name);
        return name;
    }
    const parsed = path.parse(name);
    let index = 2;
    while (used.has(`${parsed.name}_${index}${parsed.ext}`)) index += 1;
    const next = `${parsed.name}_${index}${parsed.ext}`;
    used.add(next);
    return next;
}

async function preview(data = {}) {
    const text = String(data.text || '').trim();
    if (!text) throw new Error('试听文案不能为空');
    const res = await synthesize(text, data.voice, data.rate || '+0%', data.pitch || '+0Hz');
    return {
        audio_base64: res.audio.toString('base64'),
        srt: res.srt || '',
    };
}

async function saveItem(data = {}) {
    const text = String(data.text || '').trim();
    if (!text) throw new Error('配音文案不能为空');
    const folder = resolveTaskFolder(data.baseFolder, data.taskName);
    await fs.promises.mkdir(folder, { recursive: true });

    const requestedName = safeFileName(data.fileName, 'voice.mp3');
    const baseName = path.parse(requestedName).name || 'voice';
    const mp3Name = `${baseName}.mp3`;
    const mp4Name = `${baseName}.mp4`;
    const srtName = `${baseName}.srt`;

    const res = await synthesize(text, data.voice, data.rate || '+0%', data.pitch || '+0Hz');
    const mp3Path = path.join(folder, mp3Name);
    const mp4Path = path.join(folder, mp4Name);
    const srtPath = path.join(folder, srtName);

    await fs.promises.writeFile(mp3Path, res.audio);
    if (res.srt) {
        await fs.promises.writeFile(srtPath, res.srt, 'utf8');
    }

    try {
        const ffmpeg = require('./ffmpeg');
        await ffmpeg.runCommand('ffmpeg', [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', mp3Path,
            '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
            mp4Path,
        ]);
    } catch (_) {
        await fs.promises.copyFile(mp3Path, mp4Path);
    }

    return {
        folder,
        fileName: mp3Name,
        baseName,
        paths: {
            mp3: mp3Path,
            mp4: mp4Path,
            srt: res.srt ? srtPath : '',
        },
        audio_base64: res.audio.toString('base64'),
        srt: res.srt || '',
    };
}

async function createZip(data = {}) {
    const folder = resolveTaskFolder(data.baseFolder, data.taskName);
    const formats = Array.isArray(data.formats) && data.formats.length ? data.formats : ['mp3'];
    const files = Array.isArray(data.files) ? data.files : [];
    if (!files.length) throw new Error('没有可打包的文件。');

    await fs.promises.mkdir(folder, { recursive: true });
    const used = new Set();
    const entries = [];
    for (const file of files) {
        for (const format of formats) {
            const fmt = format === 'mp4' ? 'mp4' : format === 'srt' ? 'srt' : 'mp3';
            const sourcePath = file.paths?.[fmt] || (fmt !== 'srt' ? file.paths?.mp3 : '');
            if (!sourcePath || !fs.existsSync(sourcePath)) continue;
            const buf = await fs.promises.readFile(sourcePath);
            const baseName = safeSegment(file.baseName || path.parse(file.fileName || 'voice').name, 'voice');
            const name = _uniqueName(`${baseName}.${fmt}`, used);
            entries.push({ name, data: buf });
        }
    }
    if (!entries.length) throw new Error('没有可打包的文件。');

    const zipName = safeFileName(data.zipName || 'tts_batch.zip', 'tts_batch.zip');
    const finalName = zipName.toLowerCase().endsWith('.zip') ? zipName : `${zipName}.zip`;
    const zipPath = path.join(folder, finalName);
    await fs.promises.writeFile(zipPath, createZipBuffer(entries));
    return { zipPath, folder, count: entries.length };
}

module.exports = { listVoices, synthesize, parseVoice, preview, saveItem, createZip, resolveTaskFolder };
