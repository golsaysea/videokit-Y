#!/usr/bin/env node
/**
 * Generate curated 48kHz stereo MP3 opening themes & sound effects into assets/intro-audio/.
 * Pure Node DSP synthesizer -> FFmpeg libmp3lame encoder (zero external audio dependencies).
 *
 * Run: node scripts/generate-intro-audio.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SAMPLE_RATE = 48000;
const OUT_DIR = path.resolve(__dirname, '..', 'assets', 'intro-audio');

function createPrng(seed = 1337) {
    let s = seed >>> 0;
    return () => {
        s |= 0;
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function midiToHz(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
}

function createStereoBuffer(durationSec) {
    const len = Math.max(1, Math.ceil(durationSec * SAMPLE_RATE));
    return {
        len,
        durationSec,
        L: new Float64Array(len),
        R: new Float64Array(len),
    };
}

function addStereoSample(buf, idx, valL, valR) {
    if (idx < 0 || idx >= buf.len) return;
    buf.L[idx] += valL;
    buf.R[idx] += valR;
}

function panGains(pan = 0) {
    const clamped = Math.max(-1, Math.min(1, pan));
    const angle = ((clamped + 1) * 0.25) * Math.PI;
    return [Math.cos(angle), Math.sin(angle)];
}

/**
 * Polyphonic lush warm pad / strings / brass / pipe organ note with detuned harmonics + LPF sweep.
 */
function renderHarmonicVoice(buf, {
    start = 0,
    dur = 2.5,
    midi = 60,
    amp = 0.16,
    pan = 0,
    attack = 0.08,
    release = 0.85,
    detuneCents = 8,
    voices = 3,
    harmonics = [1, 0.55, 0.34, 0.2, 0.12, 0.06, 0.03],
    cutoffStart = 600,
    cutoffPeak = 2800,
    cutoffEnd = 900,
    vibratoHz = 4.8,
    vibratoDepth = 0.0025,
    pitchBendStart = 0,
    pitchBendDur = 0.08,
    seed = 101,
}) {
    const rand = createPrng(seed);
    const freq = midiToHz(midi);
    const s0 = Math.max(0, Math.round(start * SAMPLE_RATE));
    const nSamples = Math.min(buf.len - s0, Math.round((dur + release) * SAMPLE_RATE));
    if (nSamples <= 0) return;

    const [panL, panR] = panGains(pan);
    const voiceParams = [];
    for (let v = 0; v < voices; v++) {
        const frac = voices > 1 ? (v / (voices - 1)) * 2 - 1 : 0;
        const ratio = Math.pow(2, (frac * detuneCents) / 1200);
        const vp = frac * 0.38;
        voiceParams.push({
            ratio,
            phase: rand() * Math.PI * 2,
            panSpreadL: Math.cos(((vp + 1) * 0.25) * Math.PI),
            panSpreadR: Math.sin(((vp + 1) * 0.25) * Math.PI),
        });
    }

    let lpStateL = 0;
    let lpStateR = 0;
    let lpStateL2 = 0;
    let lpStateR2 = 0;

    for (let i = 0; i < nSamples; i++) {
        const t = i / SAMPLE_RATE;
        let env = 1;
        if (t < attack) {
            const u = t / Math.max(0.001, attack);
            env = u * u * (3 - 2 * u);
        } else if (t > dur) {
            const u = (t - dur) / Math.max(0.001, release);
            env = Math.exp(-3.8 * u) * Math.max(0, 1 - u);
        } else {
            env = 1 - 0.12 * ((t - attack) / Math.max(0.01, dur - attack));
        }

        const envNorm = Math.min(1, t / Math.max(0.01, dur));
        const fc = t < attack
            ? cutoffStart + (cutoffPeak - cutoffStart) * (t / Math.max(0.001, attack))
            : cutoffPeak + (cutoffEnd - cutoffPeak) * envNorm;
        const alpha = Math.min(0.85, (2 * Math.PI * fc) / (SAMPLE_RATE + 2 * Math.PI * fc));

        const bend = (pitchBendStart !== 0 && t < pitchBendDur)
            ? pitchBendStart * (1 - t / pitchBendDur)
            : 0;
        const vib = 1 + vibratoDepth * Math.sin(2 * Math.PI * vibratoHz * t) * Math.min(1, t / 0.35);

        let rawL = 0;
        let rawR = 0;
        for (const vp of voiceParams) {
            const instFreq = freq * vp.ratio * vib * Math.pow(2, bend / 12);
            vp.phase += (2 * Math.PI * instFreq) / SAMPLE_RATE;
            let sample = 0;
            for (let k = 0; k < harmonics.length; k++) {
                sample += harmonics[k] * Math.sin((k + 1) * vp.phase);
            }
            sample /= harmonics.length;
            rawL += sample * vp.panSpreadL;
            rawR += sample * vp.panSpreadR;
        }
        rawL /= Math.sqrt(voices);
        rawR /= Math.sqrt(voices);

        // Two-pole warm low-pass filter
        lpStateL += alpha * (rawL - lpStateL);
        lpStateL2 += alpha * (lpStateL - lpStateL2);
        lpStateR += alpha * (rawR - lpStateR);
        lpStateR2 += alpha * (lpStateR - lpStateR2);

        const out = env * amp;
        addStereoSample(buf, s0 + i, lpStateL2 * out * panL * 1.4, lpStateR2 * out * panR * 1.4);
    }
}

/**
 * Plucked harp / acoustic string / felt piano / celesta / bell note.
 */
function renderPluckOrBell(buf, {
    start = 0,
    dur = 1.6,
    midi = 60,
    amp = 0.2,
    pan = 0,
    type = 'harp', // 'harp' | 'piano' | 'celesta' | 'glock' | 'tubular' | 'pizz'
    seed = 202,
}) {
    const rand = createPrng(seed);
    const f0 = midiToHz(midi);
    const s0 = Math.max(0, Math.round(start * SAMPLE_RATE));
    const nSamples = Math.min(buf.len - s0, Math.round(dur * SAMPLE_RATE));
    if (nSamples <= 0) return;
    const [panL, panR] = panGains(pan);

    const specMap = {
        harp: {
            partials: [1, 2, 3, 4, 5, 6, 7],
            amps: [1.0, 0.56, 0.30, 0.16, 0.08, 0.04, 0.02],
            decays: [1.6, 2.5, 3.8, 5.4, 7.2, 9.5, 12.0],
            attack: 0.004,
            clickAmt: 0.08,
        },
        piano: {
            partials: [1, 2.001, 3.004, 4.01, 5.02, 6.04],
            amps: [1.0, 0.65, 0.36, 0.2, 0.09, 0.04],
            decays: [1.3, 2.1, 3.4, 5.2, 7.8, 11.0],
            attack: 0.003,
            clickAmt: 0.12,
        },
        celesta: {
            partials: [1, 2.0, 3.98, 6.1, 8.9],
            amps: [1.0, 0.35, 0.18, 0.07, 0.03],
            decays: [2.2, 4.2, 7.5, 11.0, 15.0],
            attack: 0.003,
            clickAmt: 0.05,
        },
        glock: {
            partials: [1, 2.756, 5.404, 8.933],
            amps: [1.0, 0.42, 0.18, 0.07],
            decays: [2.6, 5.8, 10.5, 16.0],
            attack: 0.0015,
            clickAmt: 0.14,
        },
        tubular: {
            partials: [1, 1.99, 2.98, 4.02, 5.44],
            amps: [1.0, 0.72, 0.52, 0.28, 0.14],
            decays: [1.05, 1.5, 2.4, 3.8, 5.8],
            attack: 0.005,
            clickAmt: 0.10,
        },
        pizz: {
            partials: [1, 2, 3, 4],
            amps: [1.0, 0.45, 0.22, 0.08],
            decays: [5.5, 8.5, 12.0, 16.0],
            attack: 0.002,
            clickAmt: 0.18,
        },
    };
    const spec = specMap[type] || specMap.harp;
    const phases = spec.partials.map(() => rand() * 0.25);

    for (let i = 0; i < nSamples; i++) {
        const t = i / SAMPLE_RATE;
        const att = t < spec.attack ? (t / spec.attack) : 1;
        let val = 0;
        for (let k = 0; k < spec.partials.length; k++) {
            const pFreq = f0 * spec.partials[k];
            if (pFreq > SAMPLE_RATE * 0.44) continue;
            val += spec.amps[k] * Math.exp(-t * spec.decays[k]) * Math.sin(2 * Math.PI * pFreq * t + phases[k]);
        }
        // Subtle hammer/pluck transient
        if (t < 0.025 && spec.clickAmt > 0) {
            const n = (rand() * 2 - 1) * Math.exp(-t * 240);
            val += n * spec.clickAmt;
        }
        const tailFade = i > nSamples - 400 ? (nSamples - i) / 400 : 1;
        const out = val * att * tailFade * amp * 0.72;
        addStereoSample(buf, s0 + i, out * panL, out * panR);
    }
}

/**
 * Filtered stereo noise sweep / swish / parchment rustle / ice shimmer / door creak.
 */
function renderFilteredNoise(buf, {
    start = 0,
    dur = 0.6,
    amp = 0.18,
    panStart = -0.3,
    panEnd = 0.3,
    freqStart = 450,
    freqEnd = 2400,
    q = 1.6,
    attack = 0.06,
    release = 0.22,
    texture = 'smooth', // 'smooth' | 'crinkle' | 'sparkle'
    seed = 303,
}) {
    const rand = createPrng(seed);
    const s0 = Math.max(0, Math.round(start * SAMPLE_RATE));
    const nSamples = Math.min(buf.len - s0, Math.round(dur * SAMPLE_RATE));
    if (nSamples <= 0) return;

    // Two independent decorrelated pink-ish noise + biquad bandpass filters (L/R)
    const state = {
        L: { b0: 0, b1: 0, b2: 0, x1: 0, x2: 0, y1: 0, y2: 0 },
        R: { b0: 0, b1: 0, b2: 0, x1: 0, x2: 0, y1: 0, y2: 0 },
    };

    let flutterPhase = rand() * Math.PI * 2;
    for (let i = 0; i < nSamples; i++) {
        const t = i / SAMPLE_RATE;
        const u = Math.min(1, t / Math.max(0.001, dur));
        let env = 1;
        if (t < attack) env = t / Math.max(0.001, attack);
        else if (t > dur - release) env = Math.max(0, (dur - t) / Math.max(0.001, release));

        let crinkle = 1;
        if (texture === 'crinkle') {
            flutterPhase += (2 * Math.PI * (26 + 38 * rand())) / SAMPLE_RATE;
            crinkle = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(flutterPhase), 2);
        } else if (texture === 'sparkle') {
            crinkle = rand() < 0.04 ? 2.4 : 0.42;
        }

        const fc = Math.max(80, Math.min(15000, freqStart * Math.pow(freqEnd / Math.max(40, freqStart), u)));
        const w0 = (2 * Math.PI * fc) / SAMPLE_RATE;
        const alpha = Math.sin(w0) / (2 * Math.max(0.4, q));
        const b0 = alpha;
        const b2 = -alpha;
        const a0 = 1 + alpha;
        const a1 = -2 * Math.cos(w0);
        const a2 = 1 - alpha;

        const pan = panStart + (panEnd - panStart) * u;
        const [panL, panR] = panGains(pan);

        const processCh = (st, white) => {
            // Simple 1-pole pink approximation + bandpass
            st.b0 = 0.99 * st.b0 + white * 0.14;
            const src = texture === 'sparkle' ? white : (white * 0.45 + st.b0 * 2.2);
            const y = (b0 * src + b2 * st.x2 - a1 * st.y1 - a2 * st.y2) / a0;
            st.x2 = st.x1; st.x1 = src;
            st.y2 = st.y1; st.y1 = y;
            return y;
        };

        const outL = processCh(state.L, rand() * 2 - 1) * env * crinkle * amp;
        const outR = processCh(state.R, rand() * 2 - 1) * env * crinkle * amp;
        addStereoSample(buf, s0 + i, outL * panL, outR * panR);
    }
}

/**
 * Taiko / Bass Drum / Wood Door Thud / Crisp Snare / Mechanical Shutter Tick / Bird Call.
 */
function renderImpactOrPerc(buf, {
    start = 0,
    dur = 0.9,
    startHz = 115,
    endHz = 44,
    pitchDecay = 0.085,
    amp = 0.42,
    pan = 0,
    noiseBurst = 0.25,
    noiseFreq = 900,
    decayRate = 5.5,
    seed = 404,
}) {
    const rand = createPrng(seed);
    const s0 = Math.max(0, Math.round(start * SAMPLE_RATE));
    const nSamples = Math.min(buf.len - s0, Math.round(dur * SAMPLE_RATE));
    if (nSamples <= 0) return;
    const [panL, panR] = panGains(pan);

    let phase = 0;
    let noiseLp = 0;
    const nAlpha = (2 * Math.PI * noiseFreq) / (SAMPLE_RATE + 2 * Math.PI * noiseFreq);

    for (let i = 0; i < nSamples; i++) {
        const t = i / SAMPLE_RATE;
        const freq = endHz + (startHz - endHz) * Math.exp(-t / Math.max(0.005, pitchDecay));
        phase += (2 * Math.PI * freq) / SAMPLE_RATE;

        const att = t < 0.003 ? t / 0.003 : 1;
        const body = (Math.sin(phase) + 0.25 * Math.sin(phase * 1.98)) * Math.exp(-t * decayRate);

        const white = rand() * 2 - 1;
        noiseLp += nAlpha * (white - noiseLp);
        const snap = noiseBurst * noiseLp * Math.exp(-t * 32);

        const tailFade = i > nSamples - 200 ? (nSamples - i) / 200 : 1;
        const sample = (body + snap) * att * tailFade * amp;
        addStereoSample(buf, s0 + i, sample * panL, sample * panR);
    }
}

function renderMechanicalTick(buf, { start = 0, amp = 0.22, pan = 0, baseHz = 1400, seed = 505 }) {
    const rand = createPrng(seed);
    const s0 = Math.max(0, Math.round(start * SAMPLE_RATE));
    const nSamples = Math.min(buf.len - s0, Math.round(0.065 * SAMPLE_RATE));
    const [panL, panR] = panGains(pan);
    for (let i = 0; i < nSamples; i++) {
        const t = i / SAMPLE_RATE;
        const click = Math.sin(2 * Math.PI * baseHz * t) * Math.exp(-t * 140)
            + 0.65 * Math.sin(2 * Math.PI * (baseHz * 2.13) * t) * Math.exp(-t * 210)
            + 0.45 * (rand() * 2 - 1) * Math.exp(-t * 260);
        const out = click * amp;
        addStereoSample(buf, s0 + i, out * panL, out * panR);
    }
}

function renderSongbirdChirp(buf, {
    start = 0,
    dur = 0.22,
    fStart = 2800,
    fPeak = 4400,
    fEnd = 3300,
    amp = 0.14,
    pan = 0.25,
    warbleHz = 36,
}) {
    const s0 = Math.max(0, Math.round(start * SAMPLE_RATE));
    const nSamples = Math.min(buf.len - s0, Math.round(dur * SAMPLE_RATE));
    const [panL, panR] = panGains(pan);
    let phase = 0;
    for (let i = 0; i < nSamples; i++) {
        const t = i / SAMPLE_RATE;
        const u = t / Math.max(0.001, dur);
        const env = Math.sin(Math.PI * u) * (1 - 0.15 * u);
        const arc = u < 0.45
            ? fStart + (fPeak - fStart) * Math.sin((u / 0.45) * (Math.PI / 2))
            : fPeak + (fEnd - fPeak) * ((u - 0.45) / 0.55);
        const freq = arc * (1 + 0.045 * Math.sin(2 * Math.PI * warbleHz * t));
        phase += (2 * Math.PI * freq) / SAMPLE_RATE;
        const out = (Math.sin(phase) + 0.14 * Math.sin(phase * 2)) * env * amp;
        addStereoSample(buf, s0 + i, out * panL, out * panR);
    }
}

/**
 * Stereo Schroeder early-reflection + hall reverb with gentle HF damping.
 */
function applyStereoReverb(buf, { wet = 0.24, rt60 = 1.6, preDelayMs = 14 } = {}) {
    if (wet <= 0) return;
    const n = buf.len;
    const preDelaySamples = Math.round((preDelayMs / 1000) * SAMPLE_RATE);

    const combDelaysL = [1557, 1617, 1491, 1422].map(d => Math.round(d * (SAMPLE_RATE / 44100)));
    const combDelaysR = [1580, 1640, 1514, 1445].map(d => Math.round(d * (SAMPLE_RATE / 44100)));
    const allpassDelays = [225, 556].map(d => Math.round(d * (SAMPLE_RATE / 44100)));

    const decayFactor = (d) => Math.pow(0.001, d / (rt60 * SAMPLE_RATE));

    const makeChannelTank = (inputArr, delays) => {
        const combs = delays.map(d => ({
            buf: new Float64Array(d),
            idx: 0,
            lp: 0,
            g: decayFactor(d),
        }));
        const allpasses = allpassDelays.map(d => ({
            buf: new Float64Array(d),
            idx: 0,
            g: 0.5,
        }));
        const out = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const x = i >= preDelaySamples ? inputArr[i - preDelaySamples] : 0;
            let sum = 0;
            for (const c of combs) {
                const y = c.buf[c.idx];
                c.lp = y * 0.68 + c.lp * 0.32;
                c.buf[c.idx] = x + c.lp * c.g;
                c.idx = (c.idx + 1) % c.buf.length;
                sum += y;
            }
            let ap = sum * 0.28;
            for (const a of allpasses) {
                const bufOut = a.buf[a.idx];
                const v = ap + bufOut * a.g;
                a.buf[a.idx] = v;
                ap = bufOut - v * a.g;
                a.idx = (a.idx + 1) % a.buf.length;
            }
            out[i] = ap;
        }
        return out;
    };

    const dryWeight = 1 - wet * 0.3;
    const revL = makeChannelTank(buf.L, combDelaysL);
    const revR = makeChannelTank(buf.R, combDelaysR);
    for (let i = 0; i < n; i++) {
        const dryL = buf.L[i];
        const dryR = buf.R[i];
        buf.L[i] = dryL * dryWeight + (revL[i] * 0.8 + revR[i] * 0.2) * wet;
        buf.R[i] = dryR * dryWeight + (revR[i] * 0.8 + revL[i] * 0.2) * wet;
    }
}

/**
 * DC block + peak normalize to targetPeak (~0.84 = -1.5 dBFS) + soft saturation + fade ends.
 */
function finalizeStereoBuffer(buf, targetPeak = 0.84) {
    // 1. Soft edge fade-in (4ms) & smooth end fade-out (320ms)
    const fadeIn = Math.min(buf.len, Math.round(0.004 * SAMPLE_RATE));
    const fadeOut = Math.min(buf.len, Math.round(0.32 * SAMPLE_RATE));
    for (let i = 0; i < fadeIn; i++) {
        const g = i / fadeIn;
        buf.L[i] *= g;
        buf.R[i] *= g;
    }
    for (let i = 0; i < fadeOut; i++) {
        const idx = buf.len - 1 - i;
        const g = i / fadeOut;
        const ease = g * g * (3 - 2 * g);
        buf.L[idx] *= ease;
        buf.R[idx] *= ease;
    }

    // 2. Peak measure & normalize
    let maxAbs = 0.0001;
    for (let i = 0; i < buf.len; i++) {
        const aL = Math.abs(buf.L[i]);
        const aR = Math.abs(buf.R[i]);
        if (aL > maxAbs) maxAbs = aL;
        if (aR > maxAbs) maxAbs = aR;
    }
    const scale = targetPeak / maxAbs;
    for (let i = 0; i < buf.len; i++) {
        buf.L[i] = Math.tanh(buf.L[i] * scale * 1.08) * 0.94;
        buf.R[i] = Math.tanh(buf.R[i] * scale * 1.08) * 0.94;
    }
}

function writeMp3ViaFfmpeg(buf, outMp3Path) {
    const pcm = Buffer.allocUnsafe(buf.len * 2 * 4);
    for (let i = 0; i < buf.len; i++) {
        pcm.writeFloatLE(buf.L[i], i * 8);
        pcm.writeFloatLE(buf.R[i], i * 8 + 4);
    }
    const res = spawnSync('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'f32le',
        '-ar', String(SAMPLE_RATE),
        '-ac', '2',
        '-i', 'pipe:0',
        '-c:a', 'libmp3lame',
        '-q:a', '2',
        outMp3Path,
    ], {
        input: pcm,
        maxBuffer: 32 * 1024 * 1024,
    });
    if (res.status !== 0) {
        throw new Error(`ffmpeg failed for ${path.basename(outMp3Path)}: ${res.stderr?.toString()}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 14 BESPOKE STUDIO OPENING THEMES (~3.8s each, tailored to each opener!)
// ═══════════════════════════════════════════════════════════════════════

const TRACK_GENERATORS = {
    // 1. Theater velvet curtain grand fanfare (warm brass/strings + curtain swish)
    curtain_grand_fanfare() {
        const buf = createStereoBuffer(3.8);
        renderFilteredNoise(buf, { start: 0.0, dur: 0.85, amp: 0.24, panStart: -0.5, panEnd: 0.5, freqStart: 320, freqEnd: 1500, q: 1.3, attack: 0.08, release: 0.3, seed: 11 });
        renderFilteredNoise(buf, { start: 0.05, dur: 0.80, amp: 0.20, panStart: 0.5, panEnd: -0.5, freqStart: 360, freqEnd: 1400, q: 1.4, attack: 0.10, release: 0.28, seed: 12 });
        renderImpactOrPerc(buf, { start: 0.14, dur: 1.2, startHz: 92, endHz: 46, amp: 0.34, noiseBurst: 0.08, decayRate: 4.2, seed: 13 });
        // Lush Cmaj9 -> Gsus4 -> Cmaj9 warm brass/strings chord
        const chord = [48, 60, 64, 67, 71, 74]; // C3 C4 E4 G4 B4 D5
        chord.forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.08 + i * 0.04, dur: 2.35, midi: m, amp: i < 2 ? 0.16 : 0.11,
            pan: (i - 2.5) * 0.22, attack: 0.16, release: 1.15, detuneCents: 9,
            cutoffStart: 500, cutoffPeak: 2400, cutoffEnd: 950,
            harmonics: [1, 0.72, 0.45, 0.28, 0.16, 0.08],
            seed: 100 + i,
        }));
        renderPluckOrBell(buf, { start: 0.55, dur: 2.4, midi: 79, amp: 0.14, pan: -0.35, type: 'celesta', seed: 120 });
        renderPluckOrBell(buf, { start: 0.85, dur: 2.3, midi: 84, amp: 0.15, pan: 0.35, type: 'celesta', seed: 121 });
        applyStereoReverb(buf, { wet: 0.28, rt60: 1.8 });
        finalizeStereoBuffer(buf, 0.85);
        return buf;
    },

    // 2. Morning sheer breeze + delicate golden harp glissando + pastel pad
    morning_sheer_harp() {
        const buf = createStereoBuffer(3.8);
        renderFilteredNoise(buf, { start: 0.0, dur: 1.4, amp: 0.16, panStart: -0.6, panEnd: 0.6, freqStart: 700, freqEnd: 2600, q: 1.8, attack: 0.2, release: 0.6, texture: 'sparkle', seed: 21 });
        [53, 60, 64, 69].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.05, dur: 2.5, midi: m, amp: 0.12, pan: (i - 1.5) * 0.3,
            attack: 0.32, release: 1.1, detuneCents: 7, cutoffStart: 420, cutoffPeak: 1450, cutoffEnd: 700,
            harmonics: [1, 0.4, 0.18, 0.07],
            seed: 200 + i,
        }));
        const arp = [65, 69, 72, 76, 79, 81, 84, 88]; // Fmaj9 glissando
        arp.forEach((m, i) => renderPluckOrBell(buf, {
            start: 0.10 + i * 0.085, dur: 2.2, midi: m, amp: 0.16, pan: -0.55 + i * 0.15, type: 'harp', seed: 210 + i,
        }));
        renderPluckOrBell(buf, { start: 1.35, dur: 2.1, midi: 84, amp: 0.12, pan: 0.25, type: 'celesta', seed: 230 });
        applyStereoReverb(buf, { wet: 0.32, rt60: 2.0 });
        finalizeStereoBuffer(buf, 0.84);
        return buf;
    },

    // 3. Patriotic North America anthem (snare cadence + waving satin + noble brass fanfare)
    patriotic_freedom_anthem() {
        const buf = createStereoBuffer(3.8);
        // Flag fabric flutter
        renderFilteredNoise(buf, { start: 0.0, dur: 0.95, amp: 0.17, panStart: -0.45, panEnd: 0.45, freqStart: 350, freqEnd: 1100, q: 1.2, attack: 0.05, release: 0.3, seed: 31 });
        // Crisp marching field snare cadence
        const snareHits = [0.02, 0.11, 0.20, 0.29, 0.35, 0.42];
        snareHits.forEach((t, idx) => renderImpactOrPerc(buf, {
            start: t, dur: 0.22, startHz: 195, endHz: 135, amp: idx === snareHits.length - 1 ? 0.26 : 0.14,
            pan: -0.18, noiseBurst: 0.85, noiseFreq: 2200, decayRate: 16, seed: 320 + idx,
        }));
        renderImpactOrPerc(buf, { start: 0.42, dur: 1.25, startHz: 105, endHz: 48, amp: 0.38, pan: 0, noiseBurst: 0.1, decayRate: 4.5, seed: 330 });
        // Noble brass fanfare: F4 -> G4 -> Bb4 fanfare + warm BbMaj chord
        renderHarmonicVoice(buf, { start: 0.08, dur: 0.36, midi: 65, amp: 0.14, pan: -0.25, attack: 0.04, release: 0.18, cutoffStart: 900, cutoffPeak: 3100, cutoffEnd: 1800, seed: 340 });
        renderHarmonicVoice(buf, { start: 0.28, dur: 0.34, midi: 67, amp: 0.14, pan: 0.25, attack: 0.04, release: 0.18, cutoffStart: 900, cutoffPeak: 3200, cutoffEnd: 1800, seed: 341 });
        [46, 58, 62, 65, 70, 74].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.42, dur: 2.25, midi: m, amp: i < 2 ? 0.17 : 0.13,
            pan: (i - 2.5) * 0.24, attack: 0.07, release: 1.05, detuneCents: 10,
            cutoffStart: 700, cutoffPeak: 3400, cutoffEnd: 1350,
            harmonics: [1, 0.82, 0.58, 0.40, 0.25, 0.14, 0.08],
            seed: 350 + i,
        }));
        // Subtle bright cymbal wash
        renderFilteredNoise(buf, { start: 0.42, dur: 2.1, amp: 0.14, panStart: 0.25, panEnd: -0.1, freqStart: 5800, freqEnd: 3200, q: 0.9, attack: 0.02, release: 1.6, texture: 'sparkle', seed: 370 });
        applyStereoReverb(buf, { wet: 0.25, rt60: 1.7 });
        finalizeStereoBuffer(buf, 0.85);
        return buf;
    },

    // 4. Eagle canyon war drum & brush ink slash whoosh
    eagle_canyon_drum() {
        const buf = createStereoBuffer(3.8);
        // Fast ink/wings diagonal slash
        renderFilteredNoise(buf, { start: 0.02, dur: 0.42, amp: 0.34, panStart: -0.75, panEnd: 0.75, freqStart: 280, freqEnd: 3200, q: 1.9, attack: 0.04, release: 0.18, seed: 41 });
        // Deep cinematic taiko strike
        renderImpactOrPerc(buf, { start: 0.16, dur: 1.65, startHz: 118, endHz: 41, pitchDecay: 0.075, amp: 0.62, pan: 0, noiseBurst: 0.32, noiseFreq: 950, decayRate: 3.1, seed: 42 });
        renderImpactOrPerc(buf, { start: 0.54, dur: 1.15, startHz: 102, endHz: 46, pitchDecay: 0.08, amp: 0.36, pan: -0.25, noiseBurst: 0.18, noiseFreq: 750, decayRate: 4.5, seed: 43 });
        // Canyon wind + D5 heroic drone + rising fifth horn
        renderFilteredNoise(buf, { start: 0.3, dur: 2.5, amp: 0.14, panStart: 0.35, panEnd: -0.35, freqStart: 620, freqEnd: 420, q: 2.2, attack: 0.25, release: 1.2, seed: 44 });
        [38, 50, 57, 62, 69].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.18 + i * 0.05, dur: 2.35, midi: m, amp: i < 2 ? 0.18 : 0.11,
            pan: (i - 2) * 0.25, attack: 0.22, release: 1.1, detuneCents: 11,
            cutoffStart: 420, cutoffPeak: 2200, cutoffEnd: 780,
            harmonics: [1, 0.75, 0.48, 0.26, 0.14],
            seed: 450 + i,
        }));
        applyStereoReverb(buf, { wet: 0.30, rt60: 2.1 });
        finalizeStereoBuffer(buf, 0.85);
        return buf;
    },

    // 5. Northern Cardinal woodland song + gentle wing flutter + warm celesta
    cardinal_woodland_chime() {
        const buf = createStereoBuffer(3.8);
        // Wing flutter
        renderFilteredNoise(buf, { start: 0.04, dur: 0.38, amp: 0.17, panStart: -0.5, panEnd: 0.4, freqStart: 650, freqEnd: 2200, q: 1.5, attack: 0.04, release: 0.16, texture: 'crinkle', seed: 51 });
        // Authentic bright two-note cardinal whistle phrase
        renderSongbirdChirp(buf, { start: 0.12, dur: 0.19, fStart: 2700, fPeak: 4250, fEnd: 3150, amp: 0.18, pan: -0.25, warbleHz: 28 });
        renderSongbirdChirp(buf, { start: 0.36, dur: 0.22, fStart: 2950, fPeak: 4550, fEnd: 3500, amp: 0.19, pan: 0.28, warbleHz: 34 });
        renderSongbirdChirp(buf, { start: 0.66, dur: 0.16, fStart: 3200, fPeak: 4650, fEnd: 4100, amp: 0.14, pan: 0.12, warbleHz: 40 });
        // Warm Fmaj7 acoustic harp & celesta bed
        [53, 60, 65, 69].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.15, dur: 2.35, midi: m, amp: 0.11, pan: (i - 1.5) * 0.28,
            attack: 0.24, release: 1.1, detuneCents: 6, cutoffStart: 500, cutoffPeak: 1400, cutoffEnd: 700,
            harmonics: [1, 0.42, 0.18, 0.08],
            seed: 520 + i,
        }));
        [69, 72, 77, 81, 84].forEach((m, i) => renderPluckOrBell(buf, {
            start: 0.35 + i * 0.14, dur: 2.0, midi: m, amp: 0.14, pan: -0.4 + i * 0.2, type: i % 2 ? 'celesta' : 'harp', seed: 540 + i,
        }));
        applyStereoReverb(buf, { wet: 0.30, rt60: 1.9 });
        finalizeStereoBuffer(buf, 0.84);
        return buf;
    },

    // 6. Parchment page turn / vintage newspaper tear + warm intimate felt piano
    parchment_paper_quill() {
        const buf = createStereoBuffer(3.8);
        // Realistic paper turn crinkle & soft thump
        renderFilteredNoise(buf, { start: 0.04, dur: 0.56, amp: 0.28, panStart: 0.5, panEnd: -0.5, freqStart: 1500, freqEnd: 4400, q: 1.4, attack: 0.05, release: 0.22, texture: 'crinkle', seed: 61 });
        renderImpactOrPerc(buf, { start: 0.34, dur: 0.22, startHz: 140, endHz: 68, amp: 0.16, pan: -0.35, noiseBurst: 0.35, noiseFreq: 1800, decayRate: 14, seed: 62 });
        // Warm felt-piano Gmaj9 gentle cadence
        const pianoNotes = [
            { t: 0.10, m: 55, a: 0.18, p: -0.25 },
            { t: 0.32, m: 62, a: 0.16, p: -0.1 },
            { t: 0.54, m: 66, a: 0.17, p: 0.15 },
            { t: 0.78, m: 71, a: 0.18, p: 0.3 },
            { t: 1.06, m: 74, a: 0.16, p: 0.05 },
            { t: 1.42, m: 78, a: 0.14, p: -0.2 },
        ];
        pianoNotes.forEach((n, i) => renderPluckOrBell(buf, {
            start: n.t, dur: 2.3, midi: n.m, amp: n.a, pan: n.p, type: 'piano', seed: 630 + i,
        }));
        [55, 62, 66].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.28, dur: 2.2, midi: m, amp: 0.08, pan: (i - 1) * 0.25,
            attack: 0.35, release: 1.0, cutoffStart: 350, cutoffPeak: 1100, cutoffEnd: 550, harmonics: [1, 0.35, 0.12], seed: 650 + i,
        }));
        applyStereoReverb(buf, { wet: 0.26, rt60: 1.65 });
        finalizeStereoBuffer(buf, 0.84);
        return buf;
    },

    // 7. Dark cinema sub-bass boom + mysterious metallic shimmer + warm Am9 piano
    dark_cinema_pulse() {
        const buf = createStereoBuffer(3.8);
        // Deep cinema sub boom
        renderImpactOrPerc(buf, { start: 0.04, dur: 1.85, startHz: 86, endHz: 36, pitchDecay: 0.11, amp: 0.58, pan: 0, noiseBurst: 0.12, noiseFreq: 480, decayRate: 2.4, seed: 71 });
        // Atmospheric high air swell
        renderFilteredNoise(buf, { start: 0.05, dur: 1.9, amp: 0.14, panStart: -0.4, panEnd: 0.4, freqStart: 500, freqEnd: 2800, q: 2.5, attack: 0.45, release: 0.9, seed: 72 });
        [45, 52, 57, 60, 64, 71].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.12, dur: 2.4, midi: m, amp: i < 2 ? 0.15 : 0.10,
            pan: (i - 2.5) * 0.24, attack: 0.35, release: 1.15, detuneCents: 10,
            cutoffStart: 280, cutoffPeak: 1650, cutoffEnd: 620,
            harmonics: [1, 0.6, 0.35, 0.18, 0.08],
            seed: 730 + i,
        }));
        renderPluckOrBell(buf, { start: 0.45, dur: 2.5, midi: 69, amp: 0.16, pan: -0.25, type: 'piano', seed: 750 });
        renderPluckOrBell(buf, { start: 0.98, dur: 2.3, midi: 76, amp: 0.14, pan: 0.28, type: 'piano', seed: 751 });
        applyStereoReverb(buf, { wet: 0.34, rt60: 2.3 });
        finalizeStereoBuffer(buf, 0.85);
        return buf;
    },

    // 8. Wooden doors & plantation shutters opening into warm daylight chord
    wooden_doors_sanctuary() {
        const buf = createStereoBuffer(3.8);
        // Solid cedar latch click + warm wood slide thud
        renderMechanicalTick(buf, { start: 0.05, amp: 0.24, pan: -0.15, baseHz: 920, seed: 81 });
        renderImpactOrPerc(buf, { start: 0.10, dur: 0.55, startHz: 135, endHz: 52, pitchDecay: 0.05, amp: 0.36, pan: -0.22, noiseBurst: 0.28, noiseFreq: 720, decayRate: 7.5, seed: 82 });
        renderFilteredNoise(buf, { start: 0.12, dur: 0.72, amp: 0.16, panStart: -0.35, panEnd: 0.35, freqStart: 380, freqEnd: 1200, q: 1.5, attack: 0.08, release: 0.3, seed: 83 });
        // Daylight blooms through the open doorway: Dmaj9 warm organ/strings + acoustic pluck
        [50, 57, 62, 66, 69, 73].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.22 + i * 0.05, dur: 2.3, midi: m, amp: 0.12, pan: (i - 2.5) * 0.22,
            attack: 0.24, release: 1.05, detuneCents: 7, cutoffStart: 480, cutoffPeak: 2100, cutoffEnd: 880,
            harmonics: [1, 0.58, 0.34, 0.18, 0.08],
            seed: 840 + i,
        }));
        [66, 69, 73, 76, 81].forEach((m, i) => renderPluckOrBell(buf, {
            start: 0.38 + i * 0.12, dur: 2.1, midi: m, amp: 0.13, pan: -0.35 + i * 0.18, type: 'harp', seed: 860 + i,
        }));
        applyStereoReverb(buf, { wet: 0.28, rt60: 1.85 });
        finalizeStereoBuffer(buf, 0.84);
        return buf;
    },

    // 9. Winter frost melt & shimmering ice crystal bells
    winter_crystal_bells() {
        const buf = createStereoBuffer(3.8);
        // Shimmering snow wind swirl
        renderFilteredNoise(buf, { start: 0.0, dur: 1.65, amp: 0.19, panStart: -0.65, panEnd: 0.65, freqStart: 2200, freqEnd: 6500, q: 1.5, attack: 0.18, release: 0.8, texture: 'sparkle', seed: 91 });
        // Warm EbMaj9 frosty string bed
        [51, 58, 63, 67].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.10, dur: 2.4, midi: m, amp: 0.11, pan: (i - 1.5) * 0.3,
            attack: 0.30, release: 1.1, detuneCents: 8, cutoffStart: 420, cutoffPeak: 1750, cutoffEnd: 780,
            harmonics: [1, 0.45, 0.20, 0.09],
            seed: 920 + i,
        }));
        // Cascading crystal glockenspiel / celesta droplets
        const crystal = [75, 79, 82, 86, 87, 91, 94];
        crystal.forEach((m, i) => renderPluckOrBell(buf, {
            start: 0.08 + i * 0.16, dur: 2.0, midi: m, amp: 0.14, pan: (i % 2 ? 0.35 : -0.35), type: i % 2 ? 'glock' : 'celesta', seed: 940 + i,
        }));
        applyStereoReverb(buf, { wet: 0.35, rt60: 2.2 });
        finalizeStereoBuffer(buf, 0.84);
        return buf;
    },

    // 10. 3·2·1 film countdown crisp mechanical ticks + rising tension + final ding
    countdown_321_tension() {
        const buf = createStereoBuffer(3.8);
        // Three precise second ticks ("3 ... 2 ... 1 ... GO!")
        [0.05, 0.82, 1.58].forEach((t, idx) => {
            renderMechanicalTick(buf, { start: t, amp: 0.32, pan: (idx - 1) * 0.15, baseHz: 1350 + idx * 140, seed: 1001 + idx });
            renderImpactOrPerc(buf, { start: t, dur: 0.35, startHz: 150, endHz: 58, amp: 0.25, pan: 0, noiseBurst: 0.22, noiseFreq: 1600, decayRate: 11, seed: 1010 + idx });
            renderPluckOrBell(buf, { start: t, dur: 0.65, midi: 72 + idx * 2, amp: 0.14, pan: (idx - 1) * 0.25, type: 'pizz', seed: 1020 + idx });
        });
        // Tension rising shimmer
        renderFilteredNoise(buf, { start: 0.1, dur: 2.25, amp: 0.18, panStart: -0.3, panEnd: 0.3, freqStart: 520, freqEnd: 4600, q: 2.2, attack: 1.4, release: 0.35, seed: 1030 });
        // Triumphant final opening hit + bright bell at 2.30s
        renderImpactOrPerc(buf, { start: 2.30, dur: 1.3, startHz: 125, endHz: 44, amp: 0.44, pan: 0, noiseBurst: 0.18, noiseFreq: 1100, decayRate: 4.0, seed: 1040 });
        renderPluckOrBell(buf, { start: 2.30, dur: 1.45, midi: 84, amp: 0.22, pan: 0, type: 'glock', seed: 1041 });
        applyStereoReverb(buf, { wet: 0.22, rt60: 1.4 });
        finalizeStereoBuffer(buf, 0.85);
        return buf;
    },

    // 11. Christmas wonderland glockenspiel & sleigh bells warm holiday overture
    xmas_wonder_glockenspiel() {
        const buf = createStereoBuffer(3.8);
        // Sleigh-bell sparkle shaker
        [0.05, 0.42, 0.80, 1.18, 1.56].forEach((t, i) => renderFilteredNoise(buf, {
            start: t, dur: 0.28, amp: 0.15, panStart: -0.4 + i * 0.18, panEnd: 0.4 - i * 0.12,
            freqStart: 4200, freqEnd: 8800, q: 2.0, attack: 0.02, release: 0.18, texture: 'sparkle', seed: 1100 + i,
        }));
        // Festive F -> C/E -> F major sleigh bells / glockenspiel motif (C5 F5 G5 A5 C6!)
        const motif = [
            { t: 0.08, m: 72, tp: 'celesta' },
            { t: 0.30, m: 77, tp: 'glock' },
            { t: 0.52, m: 79, tp: 'celesta' },
            { t: 0.74, m: 81, tp: 'glock' },
            { t: 1.02, m: 84, tp: 'glock' },
            { t: 1.36, m: 81, tp: 'celesta' },
            { t: 1.68, m: 89, tp: 'glock' },
        ];
        motif.forEach((n, i) => renderPluckOrBell(buf, {
            start: n.t, dur: 1.9, midi: n.m, amp: 0.17, pan: -0.35 + (i % 3) * 0.35, type: n.tp, seed: 1120 + i,
        }));
        [53, 60, 65, 69].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.08, dur: 2.5, midi: m, amp: 0.13, pan: (i - 1.5) * 0.25,
            attack: 0.22, release: 1.1, detuneCents: 9, cutoffStart: 500, cutoffPeak: 2200, cutoffEnd: 850,
            harmonics: [1, 0.55, 0.3, 0.14],
            seed: 1140 + i,
        }));
        applyStereoReverb(buf, { wet: 0.30, rt60: 1.9 });
        finalizeStereoBuffer(buf, 0.85);
        return buf;
    },

    // 12. Sacred morning prayer church organ + angelic choir swell + golden bell
    sacred_prayer_organ() {
        const buf = createStereoBuffer(3.8);
        // Reverent E major pipe organ + warm choir harmonics
        [40, 52, 59, 64, 68, 71, 76].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.04 + i * 0.04, dur: 2.5, midi: m, amp: i < 2 ? 0.15 : 0.10,
            pan: (i - 3) * 0.20, attack: 0.32, release: 1.2, detuneCents: 6,
            cutoffStart: 420, cutoffPeak: 1950, cutoffEnd: 820,
            harmonics: [1, 0.8, 0.5, 0.38, 0.2, 0.12],
            vibratoHz: 4.2, vibratoDepth: 0.002,
            seed: 1200 + i,
        }));
        renderPluckOrBell(buf, { start: 0.18, dur: 3.1, midi: 76, amp: 0.19, pan: 0, type: 'tubular', seed: 1230 });
        renderPluckOrBell(buf, { start: 1.15, dur: 2.4, midi: 71, amp: 0.13, pan: -0.25, type: 'tubular', seed: 1231 });
        applyStereoReverb(buf, { wet: 0.38, rt60: 2.4 });
        finalizeStereoBuffer(buf, 0.84);
        return buf;
    },

    // 13. Holiday gift unwrapping (ribbon whoosh + joyful pizzicato + magic sparkle bells)
    holiday_gift_sparkle() {
        const buf = createStereoBuffer(3.8);
        // Crisp ribbon unwrap swish
        renderFilteredNoise(buf, { start: 0.02, dur: 0.45, amp: 0.24, panStart: -0.6, panEnd: 0.6, freqStart: 1200, freqEnd: 4600, q: 1.5, attack: 0.04, release: 0.18, texture: 'crinkle', seed: 1301 });
        // Bouncy joyful pizzicato chord G4 -> B4 -> D5 -> G5
        [67, 71, 74, 79].forEach((m, i) => renderPluckOrBell(buf, {
            start: 0.14 + i * 0.16, dur: 0.8, midi: m, amp: 0.20, pan: -0.3 + i * 0.2, type: 'pizz', seed: 1310 + i,
        }));
        // Magic sparkle glissando bloom
        [79, 83, 86, 90, 91, 95].forEach((m, i) => renderPluckOrBell(buf, {
            start: 0.72 + i * 0.09, dur: 1.9, midi: m, amp: 0.14, pan: 0.45 - i * 0.18, type: 'glock', seed: 1320 + i,
        }));
        [55, 62, 67].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.45, dur: 2.0, midi: m, amp: 0.10, pan: (i - 1) * 0.25,
            attack: 0.25, release: 1.0, cutoffStart: 500, cutoffPeak: 1800, cutoffEnd: 750, harmonics: [1, 0.45, 0.2], seed: 1340 + i,
        }));
        applyStereoReverb(buf, { wet: 0.27, rt60: 1.75 });
        finalizeStereoBuffer(buf, 0.84);
        return buf;
    },

    // 14. Modern viral hook punch (whoosh riser -> sub drop -> clean pluck accent)
    viral_hook_punch() {
        const buf = createStereoBuffer(3.8);
        renderFilteredNoise(buf, { start: 0.0, dur: 0.22, amp: 0.28, panStart: -0.5, panEnd: 0.5, freqStart: 420, freqEnd: 5200, q: 1.8, attack: 0.05, release: 0.06, seed: 1401 });
        renderImpactOrPerc(buf, { start: 0.18, dur: 1.1, startHz: 112, endHz: 39, pitchDecay: 0.07, amp: 0.52, pan: 0, noiseBurst: 0.24, noiseFreq: 1300, decayRate: 4.5, seed: 1402 });
        [0.48, 0.96, 1.44, 1.92].forEach((t, i) => {
            renderMechanicalTick(buf, { start: t, amp: 0.15, pan: i % 2 ? 0.28 : -0.28, baseHz: 1650 + i * 110, seed: 1410 + i });
            renderPluckOrBell(buf, { start: t, dur: 0.9, midi: [64, 67, 71, 76][i], amp: 0.15, pan: i % 2 ? 0.22 : -0.22, type: 'pizz', seed: 1420 + i });
        });
        [52, 59, 64].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.20, dur: 2.3, midi: m, amp: 0.09, pan: (i - 1) * 0.28,
            attack: 0.20, release: 1.0, cutoffStart: 450, cutoffPeak: 1700, cutoffEnd: 680, harmonics: [1, 0.45, 0.2], seed: 1430 + i,
        }));
        applyStereoReverb(buf, { wet: 0.22, rt60: 1.35 });
        finalizeStereoBuffer(buf, 0.85);
        return buf;
    },

    // 15. CRT / VHS retro TV power-on glitch (magnetic degauss thump + static burst + analog fifth synth swell)
    crt_glitch_powerup() {
        const buf = createStereoBuffer(3.8);
        // Magnetic relay click + low power-supply hum thump
        renderMechanicalTick(buf, { start: 0.02, amp: 0.24, pan: 0, baseHz: 2400, seed: 1501 });
        renderImpactOrPerc(buf, { start: 0.04, dur: 0.9, startHz: 118, endHz: 54, pitchDecay: 0.05, amp: 0.46, pan: 0, noiseBurst: 0.22, noiseFreq: 2100, decayRate: 5.2, seed: 1502 });
        // Analog CRT static burst & VCR tracking sweep
        renderFilteredNoise(buf, { start: 0.05, dur: 0.36, amp: 0.24, panStart: -0.7, panEnd: 0.7, freqStart: 900, freqEnd: 6200, q: 1.9, attack: 0.015, release: 0.14, texture: 'crinkle', seed: 1503 });
        renderFilteredNoise(buf, { start: 0.42, dur: 0.28, amp: 0.14, panStart: 0.6, panEnd: -0.6, freqStart: 3200, freqEnd: 850, q: 2.1, attack: 0.02, release: 0.12, texture: 'sparkle', seed: 1504 });
        // Retro analog polysynth C minor -> Eb warm fifths
        [48, 55, 60, 67, 72].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.16 + i * 0.03, dur: 2.4, midi: m, amp: i < 2 ? 0.14 : 0.10,
            pan: (i - 2) * 0.28, attack: 0.14, release: 1.0, detuneCents: 14,
            cutoffStart: 500, cutoffPeak: 3100, cutoffEnd: 950,
            harmonics: [1, 0.72, 0.48, 0.30, 0.18],
            seed: 1510 + i,
        }));
        [72, 79, 84].forEach((m, i) => renderPluckOrBell(buf, {
            start: 0.26 + i * 0.12, dur: 1.6, midi: m, amp: 0.13, pan: -0.3 + i * 0.3, type: 'celesta', seed: 1525 + i,
        }));
        applyStereoReverb(buf, { wet: 0.28, rt60: 1.65 });
        finalizeStereoBuffer(buf, 0.84);
        return buf;
    },

    // 16. 35mm Film burn & light leak whoosh (projector flutter + warm analog flare swell + golden bell)
    film_burn_whoosh() {
        const buf = createStereoBuffer(3.8);
        // Celluloid reel air whoosh rising into flash peak
        renderFilteredNoise(buf, { start: 0.0, dur: 0.78, amp: 0.30, panStart: -0.65, panEnd: 0.65, freqStart: 280, freqEnd: 3800, q: 1.35, attack: 0.14, release: 0.26, texture: 'smooth', seed: 1601 });
        renderImpactOrPerc(buf, { start: 0.38, dur: 1.3, startHz: 86, endHz: 38, pitchDecay: 0.08, amp: 0.44, pan: 0, noiseBurst: 0.14, noiseFreq: 980, decayRate: 3.6, seed: 1602 });
        // Soft 24fps film gate clicks
        [0.06, 0.16, 0.26].forEach((t, i) => renderMechanicalTick(buf, {
            start: t, amp: 0.11, pan: (i % 2 ? 0.35 : -0.35), baseHz: 1950 + i * 240, seed: 1605 + i,
        }));
        // Warm amber Dmaj9 cinematic chord swell
        [50, 57, 62, 66, 69, 73].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.14 + i * 0.035, dur: 2.5, midi: m, amp: i < 2 ? 0.14 : 0.095,
            pan: (i - 2.5) * 0.22, attack: 0.22, release: 1.1, detuneCents: 10,
            cutoffStart: 420, cutoffPeak: 2450, cutoffEnd: 780,
            harmonics: [1, 0.60, 0.36, 0.20, 0.10],
            seed: 1620 + i,
        }));
        renderPluckOrBell(buf, { start: 0.42, dur: 2.3, midi: 74, amp: 0.16, pan: 0.18, type: 'piano', seed: 1640 });
        applyStereoReverb(buf, { wet: 0.34, rt60: 2.0 });
        finalizeStereoBuffer(buf, 0.84);
        return buf;
    },

    // 17. Polaroid shutter snap & paper cutout slide (double mechanical leaf shutter + paper rustle + cozy guitar/piano)
    polaroid_shutter_snap() {
        const buf = createStereoBuffer(3.8);
        // Classic Polaroid double-click shutter + motor ejection whir
        renderMechanicalTick(buf, { start: 0.05, amp: 0.28, pan: -0.12, baseHz: 2900, seed: 1701 });
        renderMechanicalTick(buf, { start: 0.11, amp: 0.22, pan: 0.15, baseHz: 2150, seed: 1702 });
        // Tactile matte photo paper slide
        renderFilteredNoise(buf, { start: 0.16, dur: 0.55, amp: 0.22, panStart: -0.5, panEnd: 0.5, freqStart: 1350, freqEnd: 4200, q: 1.65, attack: 0.05, release: 0.20, texture: 'crinkle', seed: 1703 });
        // Cozy nostalgia Fmaj7 acoustic pluck + warm piano chord
        [65, 69, 72, 76, 81].forEach((m, i) => renderPluckOrBell(buf, {
            start: 0.22 + i * 0.14, dur: 1.9, midi: m, amp: 0.18, pan: -0.36 + i * 0.18, type: i < 3 ? 'piano' : 'harp', seed: 1710 + i,
        }));
        [53, 60, 65].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.28, dur: 2.2, midi: m, amp: 0.10, pan: (i - 1) * 0.24,
            attack: 0.24, release: 1.0, cutoffStart: 480, cutoffPeak: 1850, cutoffEnd: 740,
            harmonics: [1, 0.48, 0.22, 0.10],
            seed: 1730 + i,
        }));
        applyStereoReverb(buf, { wet: 0.28, rt60: 1.65 });
        finalizeStereoBuffer(buf, 0.84);
        return buf;
    },

    // 18. Prism glass refraction shimmer (crystalline celesta/glock arpeggio + sleek obsidian sub-air pad)
    prism_glass_shimmer() {
        const buf = createStereoBuffer(3.8);
        renderFilteredNoise(buf, { start: 0.0, dur: 0.65, amp: 0.22, panStart: 0.6, panEnd: -0.6, freqStart: 2200, freqEnd: 7400, q: 2.2, attack: 0.06, release: 0.25, texture: 'sparkle', seed: 1801 });
        renderImpactOrPerc(buf, { start: 0.12, dur: 1.1, startHz: 78, endHz: 36, pitchDecay: 0.09, amp: 0.42, pan: 0, noiseBurst: 0.06, decayRate: 3.4, seed: 1802 });
        // Shimmering B major 9 glass refraction cascade
        [71, 78, 83, 85, 87, 90, 95].forEach((m, i) => renderPluckOrBell(buf, {
            start: 0.10 + i * 0.11, dur: 2.2, midi: m, amp: 0.15, pan: -0.55 + i * 0.18, type: i % 2 === 0 ? 'celesta' : 'glock', seed: 1810 + i,
        }));
        [47, 54, 63, 66].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.08 + i * 0.04, dur: 2.5, midi: m, amp: 0.11, pan: (i - 1.5) * 0.25,
            attack: 0.22, release: 1.15, detuneCents: 9, cutoffStart: 560, cutoffPeak: 2700, cutoffEnd: 920,
            harmonics: [1, 0.50, 0.28, 0.14],
            seed: 1830 + i,
        }));
        applyStereoReverb(buf, { wet: 0.36, rt60: 2.15 });
        finalizeStereoBuffer(buf, 0.84);
        return buf;
    },

    // 19. Heavenly cloud parting breeze (organic stereo wind parting whoosh + airy Fmaj9 harp/celesta mist)
    cloud_part_heavenly_breeze() {
        const buf = createStereoBuffer(3.8);
        // Volumetric wind parting sweep: low-to-airy stereo whoosh expanding outward
        renderFilteredNoise(buf, {
            start: 0.0, dur: 0.95, amp: 0.30, panStart: -0.65, panEnd: 0.65,
            freqStart: 220, freqEnd: 2600, q: 1.05, attack: 0.16, release: 0.42, texture: 'smooth', seed: 1901,
        });
        renderFilteredNoise(buf, {
            start: 0.22, dur: 1.15, amp: 0.20, panStart: 0.55, panEnd: -0.55,
            freqStart: 620, freqEnd: 3800, q: 1.35, attack: 0.20, release: 0.55, texture: 'sparkle', seed: 1902,
        });
        // Ethereal airy Fmaj9 heavenly pad sustain
        [53, 60, 64, 69, 72, 76].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.08 + i * 0.05, dur: 2.9, midi: m, amp: i < 2 ? 0.12 : 0.085,
            pan: (i - 2.5) * 0.24, attack: 0.34, release: 1.35, detuneCents: 11,
            cutoffStart: 380, cutoffPeak: 2100, cutoffEnd: 720,
            harmonics: [1, 0.48, 0.24, 0.10], seed: 1910 + i,
        }));
        // Delicate silver angel harp mist arpeggio
        [72, 76, 79, 84, 88].forEach((m, i) => renderPluckOrBell(buf, {
            start: 0.24 + i * 0.15, dur: 2.1, midi: m, amp: 0.11,
            pan: -0.45 + i * 0.22, type: i % 2 === 0 ? 'harp' : 'celesta', seed: 1930 + i,
        }));
        applyStereoReverb(buf, { wet: 0.42, rt60: 2.35 });
        finalizeStereoBuffer(buf, 0.84);
        return buf;
    },

    // 20. Golden dawn angelic cloud swoosh (warm atmospheric breath + serene Gmaj9 prayer piano & strings)
    cloud_dawn_angelic_swoosh() {
        const buf = createStereoBuffer(3.8);
        renderFilteredNoise(buf, {
            start: 0.0, dur: 1.05, amp: 0.28, panStart: 0.0, panEnd: 0.72,
            freqStart: 190, freqEnd: 2200, q: 1.15, attack: 0.18, release: 0.48, texture: 'smooth', seed: 2001,
        });
        renderImpactOrPerc(buf, {
            start: 0.14, dur: 1.2, startHz: 72, endHz: 36, pitchDecay: 0.12, amp: 0.34, pan: 0,
            noiseBurst: 0.08, decayRate: 3.0, seed: 2002,
        });
        // Warm sunrise Gmaj9 string bed
        [55, 62, 66, 71, 74].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.10 + i * 0.045, dur: 2.85, midi: m, amp: i < 2 ? 0.13 : 0.09,
            pan: (i - 2) * 0.24, attack: 0.30, release: 1.25, detuneCents: 9,
            cutoffStart: 420, cutoffPeak: 2250, cutoffEnd: 780,
            harmonics: [1, 0.55, 0.30, 0.14], seed: 2010 + i,
        }));
        [74, 79, 83, 86].forEach((m, i) => renderPluckOrBell(buf, {
            start: 0.28 + i * 0.16, dur: 2.2, midi: m, amp: 0.13,
            pan: -0.35 + i * 0.24, type: 'piano', seed: 2030 + i,
        }));
        applyStereoReverb(buf, { wet: 0.38, rt60: 2.20 });
        finalizeStereoBuffer(buf, 0.84);
        return buf;
    },

    // 21. Cinema trailer sub-bass boom impact (phone-audible punch + deep sub drop + hall tail)
    impact_cinema_boom() {
        const buf = createStereoBuffer(3.2);
        // Immediate chest & phone-speaker mid punch + sub drop (145Hz -> 30Hz)
        renderImpactOrPerc(buf, { start: 0.01, dur: 1.85, startHz: 148, endHz: 30, pitchDecay: 0.095, amp: 0.72, pan: 0, noiseBurst: 0.42, noiseFreq: 1850, decayRate: 2.3, seed: 2101 });
        renderImpactOrPerc(buf, { start: 0.015, dur: 0.75, startHz: 260, endHz: 68, pitchDecay: 0.04, amp: 0.46, pan: 0, noiseBurst: 0.55, noiseFreq: 3400, decayRate: 7.5, seed: 2102 });
        // Wide dark metallic transient splash
        renderFilteredNoise(buf, { start: 0.005, dur: 0.65, amp: 0.30, panStart: -0.65, panEnd: 0.65, freqStart: 3200, freqEnd: 280, q: 1.15, attack: 0.004, release: 0.48, texture: 'smooth', seed: 2103 });
        // Deep unison sub bed holding resonance tail
        [36, 48].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.02, dur: 1.9, midi: m, amp: 0.16 - i * 0.04, pan: 0, attack: 0.02, release: 1.45, detuneCents: 6, cutoffStart: 950, cutoffPeak: 1400, cutoffEnd: 180, harmonics: [1, 0.35, 0.12], seed: 2110 + i,
        }));
        applyStereoReverb(buf, { wet: 0.34, rt60: 1.95, preDelayMs: 12 });
        finalizeStereoBuffer(buf, 0.88);
        return buf;
    },

    // 22. Reverse air riser into massive downbeat slam (0..0.48s tension rise -> 0.48s slam!)
    impact_riser_slam() {
        const buf = createStereoBuffer(3.2);
        // Steep rising filtered air whoosh (0..0.48s)
        renderFilteredNoise(buf, { start: 0.0, dur: 0.49, amp: 0.42, panStart: -0.75, panEnd: 0.75, freqStart: 180, freqEnd: 7800, q: 2.1, attack: 0.38, release: 0.03, texture: 'smooth', seed: 2201 });
        // Rising harmonic synth tension pitch-up feel
        [52, 64].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.04, dur: 0.45, midi: m, amp: 0.16, pan: (i === 0 ? -0.35 : 0.35), attack: 0.36, release: 0.04, pitchBendStart: -7, pitchBendDur: 0.42, cutoffStart: 400, cutoffPeak: 4200, cutoffEnd: 5200, harmonics: [1, 0.65, 0.4], seed: 2205 + i,
        }));
        // Heavy 0.48s slam impact
        renderImpactOrPerc(buf, { start: 0.475, dur: 1.45, startHz: 165, endHz: 32, pitchDecay: 0.075, amp: 0.76, pan: 0, noiseBurst: 0.52, noiseFreq: 2800, decayRate: 3.1, seed: 2210 });
        renderMechanicalTick(buf, { start: 0.475, amp: 0.34, pan: 0, baseHz: 2100, seed: 2211 });
        applyStereoReverb(buf, { wet: 0.28, rt60: 1.65, preDelayMs: 8 });
        finalizeStereoBuffer(buf, 0.88);
        return buf;
    },

    // 23. Crisp supersonic whip crack whoosh (ultra-snappy 0.7s pan L->R air cut)
    impact_whip_whoosh() {
        const buf = createStereoBuffer(3.2);
        renderFilteredNoise(buf, { start: 0.0, dur: 0.56, amp: 0.56, panStart: -0.9, panEnd: 0.9, freqStart: 320, freqEnd: 6400, q: 1.7, attack: 0.14, release: 0.24, texture: 'smooth', seed: 2301 });
        renderFilteredNoise(buf, { start: 0.08, dur: 0.44, amp: 0.40, panStart: 0.75, panEnd: -0.75, freqStart: 4200, freqEnd: 520, q: 1.5, attack: 0.04, release: 0.30, texture: 'smooth', seed: 2302 });
        // Crisp center crack punch at whip peak (0.16s)
        renderImpactOrPerc(buf, { start: 0.14, dur: 0.52, startHz: 210, endHz: 52, pitchDecay: 0.038, amp: 0.52, pan: 0, noiseBurst: 0.55, noiseFreq: 3800, decayRate: 9.0, seed: 2303 });
        applyStereoReverb(buf, { wet: 0.18, rt60: 0.95, preDelayMs: 6 });
        finalizeStereoBuffer(buf, 0.88);
        return buf;
    },

    // 24. Deep sacred cathedral bronze bell toll (commanding church chime + low sub bloom)
    impact_sacred_cathedral_bell() {
        const buf = createStereoBuffer(3.2);
        renderImpactOrPerc(buf, { start: 0.01, dur: 1.15, startHz: 112, endHz: 36, pitchDecay: 0.08, amp: 0.42, pan: 0, noiseBurst: 0.14, noiseFreq: 1400, decayRate: 3.4, seed: 2401 });
        // Deep bronze church bell octaves & fifth (C3, G3, C4, E4 shimmer)
        renderPluckOrBell(buf, { start: 0.01, dur: 2.65, midi: 48, amp: 0.44, pan: -0.08, type: 'tubular', seed: 2402 });
        renderPluckOrBell(buf, { start: 0.012, dur: 2.55, midi: 60, amp: 0.32, pan: 0.10, type: 'tubular', seed: 2403 });
        renderPluckOrBell(buf, { start: 0.015, dur: 2.35, midi: 67, amp: 0.20, pan: -0.22, type: 'tubular', seed: 2404 });
        applyStereoReverb(buf, { wet: 0.40, rt60: 2.3, preDelayMs: 18 });
        finalizeStereoBuffer(buf, 0.86);
        return buf;
    },

    // 25. Tense double heartbeat thump ("lub-dub" emotional hook)
    impact_heartbeat_double() {
        const buf = createStereoBuffer(3.2);
        // Lub (stronger primary thump) + Dub (slightly pitched, tighter second beat at 0.34s)
        renderImpactOrPerc(buf, { start: 0.02, dur: 0.38, startHz: 98, endHz: 34, pitchDecay: 0.055, amp: 0.72, pan: 0, noiseBurst: 0.16, noiseFreq: 520, decayRate: 6.2, seed: 2501 });
        renderImpactOrPerc(buf, { start: 0.34, dur: 0.52, startHz: 112, endHz: 38, pitchDecay: 0.048, amp: 0.82, pan: 0, noiseBurst: 0.20, noiseFreq: 640, decayRate: 5.2, seed: 2502 });
        // Subtle moody air tension swell underneath
        renderFilteredNoise(buf, { start: 0.0, dur: 1.45, amp: 0.14, panStart: -0.4, panEnd: 0.4, freqStart: 180, freqEnd: 780, q: 1.2, attack: 0.22, release: 0.65, texture: 'smooth', seed: 2503 });
        applyStereoReverb(buf, { wet: 0.26, rt60: 1.35, preDelayMs: 10 });
        finalizeStereoBuffer(buf, 0.88);
        return buf;
    },

    // 26. Rolling thunder crack & dramatic boom (sharp crack into rolling low rumble)
    impact_thunder_crack() {
        const buf = createStereoBuffer(3.2);
        // Lightning snap transient
        renderMechanicalTick(buf, { start: 0.01, amp: 0.42, pan: -0.25, baseHz: 2600, seed: 2601 });
        renderFilteredNoise(buf, { start: 0.01, dur: 0.26, amp: 0.46, panStart: -0.6, panEnd: 0.6, freqStart: 4800, freqEnd: 900, q: 0.9, attack: 0.003, release: 0.18, texture: 'crinkle', seed: 2602 });
        // Massive rolling thunder strikes
        renderImpactOrPerc(buf, { start: 0.02, dur: 1.85, startHz: 135, endHz: 28, pitchDecay: 0.11, amp: 0.68, pan: -0.18, noiseBurst: 0.48, noiseFreq: 1250, decayRate: 2.1, seed: 2603 });
        renderImpactOrPerc(buf, { start: 0.16, dur: 1.75, startHz: 105, endHz: 26, pitchDecay: 0.14, amp: 0.56, pan: 0.24, noiseBurst: 0.36, noiseFreq: 780, decayRate: 1.9, seed: 2604 });
        renderFilteredNoise(buf, { start: 0.08, dur: 2.05, amp: 0.24, panStart: 0.5, panEnd: -0.5, freqStart: 920, freqEnd: 190, q: 0.85, attack: 0.06, release: 1.15, texture: 'crinkle', seed: 2605 });
        applyStereoReverb(buf, { wet: 0.38, rt60: 2.2, preDelayMs: 16 });
        finalizeStereoBuffer(buf, 0.88);
        return buf;
    },

    // 27. Sharp DSLR camera shutter freeze + subtle sub punch (instant scroll-stopper snap)
    impact_camera_flash_shutter() {
        const buf = createStereoBuffer(3.2);
        // Twin DSLR mechanical shutter mirror slap
        renderMechanicalTick(buf, { start: 0.015, amp: 0.56, pan: -0.15, baseHz: 3200, seed: 2701 });
        renderMechanicalTick(buf, { start: 0.072, amp: 0.44, pan: 0.18, baseHz: 2350, seed: 2702 });
        // Flash capacitor pop & tight bass anchor
        renderImpactOrPerc(buf, { start: 0.015, dur: 0.72, startHz: 180, endHz: 42, pitchDecay: 0.045, amp: 0.54, pan: 0, noiseBurst: 0.42, noiseFreq: 4200, decayRate: 6.4, seed: 2703 });
        renderFilteredNoise(buf, { start: 0.06, dur: 0.42, amp: 0.18, panStart: -0.5, panEnd: 0.5, freqStart: 4800, freqEnd: 1600, q: 1.8, attack: 0.01, release: 0.32, texture: 'sparkle', seed: 2704 });
        applyStereoReverb(buf, { wet: 0.22, rt60: 1.1, preDelayMs: 8 });
        finalizeStereoBuffer(buf, 0.88);
        return buf;
    },

    // 28. Deep felt grand piano emotional drop chord (storytelling / faith teaser)
    impact_piano_deep_chord() {
        const buf = createStereoBuffer(3.2);
        // Deep bass weight D2 + D3 + heartfelt D minor add9 felt piano voicing
        renderImpactOrPerc(buf, { start: 0.015, dur: 1.35, startHz: 82, endHz: 34, pitchDecay: 0.09, amp: 0.36, pan: 0, noiseBurst: 0.06, noiseFreq: 480, decayRate: 2.8, seed: 2801 });
        [38, 50, 57, 62, 64, 65, 69].forEach((m, i) => renderPluckOrBell(buf, {
            start: 0.015 + i * 0.018, dur: 2.45, midi: m, amp: i < 2 ? 0.30 : 0.19, pan: (i - 3) * 0.14, type: 'piano', seed: 2810 + i,
        }));
        [50, 57, 65].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.04, dur: 2.25, midi: m, amp: 0.09, pan: (i - 1) * 0.25, attack: 0.16, release: 1.25, cutoffStart: 420, cutoffPeak: 1450, cutoffEnd: 520, harmonics: [1, 0.42, 0.18], seed: 2830 + i,
        }));
        applyStereoReverb(buf, { wet: 0.36, rt60: 2.15, preDelayMs: 14 });
        finalizeStereoBuffer(buf, 0.85);
        return buf;
    },

    // 29. Cold steel blade draw & metallic shimmer ring (sharp edgy hook)
    impact_sword_metallic_ring() {
        const buf = createStereoBuffer(3.2);
        // Fast high-sheen steel scrape sweep
        renderFilteredNoise(buf, { start: 0.0, dur: 0.34, amp: 0.46, panStart: -0.75, panEnd: 0.75, freqStart: 1800, freqEnd: 9200, q: 3.2, attack: 0.02, release: 0.18, texture: 'sparkle', seed: 2901 });
        renderMechanicalTick(buf, { start: 0.11, amp: 0.42, pan: 0.1, baseHz: 3900, seed: 2902 });
        // Crisp sub anchor + high metallic glock/tubular resonance ring
        renderImpactOrPerc(buf, { start: 0.10, dur: 0.85, startHz: 195, endHz: 46, pitchDecay: 0.045, amp: 0.44, pan: 0, noiseBurst: 0.40, noiseFreq: 4600, decayRate: 5.8, seed: 2903 });
        [76, 83, 88].forEach((m, i) => renderPluckOrBell(buf, {
            start: 0.105 + i * 0.012, dur: 1.75, midi: m, amp: 0.22 - i * 0.04, pan: (i - 1) * 0.35, type: 'glock', seed: 2910 + i,
        }));
        applyStereoReverb(buf, { wet: 0.34, rt60: 1.8, preDelayMs: 10 });
        finalizeStereoBuffer(buf, 0.86);
        return buf;
    },

    // 30. Urgent breaking-news stinger hit (punchy double stab + sub drop)
    impact_news_breaking_hit() {
        const buf = createStereoBuffer(3.2);
        // Double percussive punch at 0.01s and 0.22s
        renderImpactOrPerc(buf, { start: 0.01, dur: 0.45, startHz: 180, endHz: 48, pitchDecay: 0.04, amp: 0.56, pan: -0.1, noiseBurst: 0.48, noiseFreq: 3200, decayRate: 8.5, seed: 3001 });
        renderImpactOrPerc(buf, { start: 0.22, dur: 1.15, startHz: 155, endHz: 35, pitchDecay: 0.065, amp: 0.70, pan: 0, noiseBurst: 0.44, noiseFreq: 2600, decayRate: 4.2, seed: 3002 });
        // Tight G minor breaking stab
        [43, 55, 62, 67, 70].forEach((m, i) => renderHarmonicVoice(buf, {
            start: 0.215, dur: 0.95, midi: m, amp: i < 2 ? 0.16 : 0.11, pan: (i - 2) * 0.22,
            attack: 0.008, release: 0.65, detuneCents: 14, cutoffStart: 900, cutoffPeak: 4200, cutoffEnd: 950,
            harmonics: [1, 0.78, 0.54, 0.34, 0.20], seed: 3010 + i,
        }));
        applyStereoReverb(buf, { wet: 0.24, rt60: 1.25, preDelayMs: 8 });
        finalizeStereoBuffer(buf, 0.88);
        return buf;
    },
};

function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const entries = Object.entries(TRACK_GENERATORS);
    console.log(`[IntroAudioGen] Generating ${entries.length} studio opening MP3 tracks -> ${OUT_DIR}`);
    for (const [id, genFn] of entries) {
        const outPath = path.join(OUT_DIR, `${id}.mp3`);
        const buf = genFn();
        writeMp3ViaFfmpeg(buf, outPath);
        const bytes = fs.statSync(outPath).size;
        console.log(`  ✔ ${id}.mp3 (${(bytes / 1024).toFixed(1)} KB, ${buf.durationSec.toFixed(1)}s)`);
    }
    console.log(`[IntroAudioGen] All ${entries.length} tracks generated successfully.`);
}

main();
