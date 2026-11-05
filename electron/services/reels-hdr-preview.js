const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const VIDEO = /\.(mp4|mov|m4v|mkv|webm|avi|ts|mts|m2ts|3gp)$/i;
const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']);
const BT2020_SPACES = new Set(['bt2020nc', 'bt2020c', 'bt2020_ncl', 'bt2020_cl']);
const BT2020_TRANSFERS = new Set(['bt2020-10', 'bt2020-12']);
const P3_PRIMARIES = new Set(['smpte431', 'smpte432', 'ebe', 'p3', 'display-p3']);
const UNKNOWN_VALUES = new Set(['', 'unknown', 'unspecified', 'reserved']);

function _normTag(val) {
    const s = String(val || '').trim().toLowerCase();
    return UNKNOWN_VALUES.has(s) ? '' : s;
}

function _isHighBitDepth(stream = {}) {
    const pixFmt = String(stream.pix_fmt || '').toLowerCase();
    const bits = Number(stream.bits_per_raw_sample || 0);
    if (bits >= 10) return true;
    return /(?:10le|10be|12le|12be|16le|16be|p010|p016|yuv420p10|yuv422p10|yuv444p10)/.test(pixFmt);
}

function _hasDolbyVisionSideData(stream = {}) {
    const list = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
    return list.some(item => /dovi|dolby\s*vision/i.test(String(item?.side_data_type || item?.type || '')));
}

/**
 * 自动识别视频色域与动态范围：
 * - HLG (arib-std-b67)、PQ (smpte2084)、Dolby Vision
 * - BT.2020 SDR (bt2020 primaries / bt2020nc / bt2020-10 / bt2020-12)
 * - Display P3 / DCI-P3 (smpte431 / smpte432)
 * - 标准 BT.709 视频直接保留
 * - 元数据不完整的高位深/半缺失宽色域视频使用安全兼容处理
 */
function classifyVideoColorProfile(stream = {}) {
    if (!stream || typeof stream !== 'object') {
        return { needsConversion: false, reason: 'no-stream', isHdr: false, isWideGamut: false, hasIncompleteMetadata: false };
    }
    const transfer = _normTag(stream.color_transfer);
    const primaries = _normTag(stream.color_primaries);
    const space = _normTag(stream.color_space);
    const highBit = _isHighBitDepth(stream);
    const hasDovi = _hasDolbyVisionSideData(stream);

    const isHdrTransfer = HDR_TRANSFERS.has(transfer) || hasDovi;
    const isBt2020 = primaries === 'bt2020' || BT2020_SPACES.has(space) || BT2020_TRANSFERS.has(transfer);
    const isP3 = P3_PRIMARIES.has(primaries) || P3_PRIMARIES.has(space);

    // 任意宽色域/HDR 标记出现，但其它关键色彩标签缺失时，属于元数据不完整
    const hasPartialColorTags = Boolean(
        (isHdrTransfer || isBt2020 || isP3) && (!transfer || !primaries || !space)
    );
    const hasUnlabeledHighBit = Boolean(highBit && !transfer && !primaries && !space);
    const hasIncompleteMetadata = hasPartialColorTags || hasUnlabeledHighBit;

    if (isHdrTransfer) {
        const reason = hasDovi ? 'dovi' : (transfer === 'arib-std-b67' ? 'hlg' : 'pq');
        return {
            needsConversion: true,
            reason,
            isHdr: true,
            isWideGamut: true,
            hasIncompleteMetadata,
            safeInputPrimaries: primaries || (isBt2020 ? 'bt2020' : (isP3 ? 'smpte432' : 'bt2020')),
            safeInputTransfer: transfer || (hasDovi ? 'smpte2084' : 'arib-std-b67'),
            safeInputSpace: space || 'bt2020nc',
        };
    }

    if (isBt2020) {
        return {
            needsConversion: true,
            reason: 'bt2020-sdr',
            isHdr: false,
            isWideGamut: true,
            hasIncompleteMetadata,
            safeInputPrimaries: primaries || 'bt2020',
            safeInputTransfer: transfer || 'bt709',
            safeInputSpace: space || 'bt2020nc',
        };
    }

    if (isP3) {
        return {
            needsConversion: true,
            reason: 'p3',
            isHdr: false,
            isWideGamut: true,
            hasIncompleteMetadata,
            safeInputPrimaries: primaries || 'smpte432',
            safeInputTransfer: transfer || 'bt709',
            safeInputSpace: space || 'bt709',
        };
    }

    if (hasUnlabeledHighBit) {
        return {
            needsConversion: true,
            reason: 'incomplete-metadata-highbit',
            isHdr: false,
            isWideGamut: false,
            hasIncompleteMetadata: true,
            safeInputPrimaries: 'bt709',
            safeInputTransfer: 'bt709',
            safeInputSpace: 'bt709',
        };
    }

    // 原本就是 BT.709 或标准 8-bit SDR 的视频直接保留
    return {
        needsConversion: false,
        reason: (primaries === 'bt709' || transfer === 'bt709' || space === 'bt709') ? 'bt709' : 'sdr-default',
        isHdr: false,
        isWideGamut: false,
        hasIncompleteMetadata: false,
        safeInputPrimaries: 'bt709',
        safeInputTransfer: 'bt709',
        safeInputSpace: 'bt709',
    };
}

function buildBt709ConversionFilter(profile = {}, useSafeCompatibleFallback = false) {
    if (useSafeCompatibleFallback || (profile.hasIncompleteMetadata && !profile.isHdr)) {
        return [
            'fps=30',
            "scale=w='min(iw,1280)':h='min(ih,1280)':force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709:out_range=tv",
            'format=yuv420p',
            'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA',
            'sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL',
        ].join(',');
    }
    const tonemap = profile.isHdr ? ':tonemapping=bt.2390:apply_dolbyvision=true' : '';
    return [
        'fps=30',
        `libplacebo=w='min(iw,1280)':h='min(ih,1280)':force_original_aspect_ratio=decrease:force_divisible_by=2:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv${tonemap}:gamut_mode=perceptual`,
        'format=yuv420p',
        'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA',
        'sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL',
    ].join(',');
}

// Backwards-compatible no-transcode preview API. Export retains color classification above.
function createPreviewService() {
    const prepare = async source => source;
    prepare.clearCache = async () => 0;
    return prepare;
}
const prepareReelsPreview = createPreviewService();
const clearReelsPreviewCache = (...args) => prepareReelsPreview.clearCache(...args);
module.exports = { prepareReelsPreview, clearReelsPreviewCache, createPreviewService, classifyVideoColorProfile, buildBt709ConversionFilter };
