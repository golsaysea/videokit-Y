/* Reels renderer → utility process: bounded ACK and cancellation pipeline. */
function createReelsFramePipeline(sessionId, batchSize = 3, options = {}) {
    // FRAME_PIPELINE_ACK_V1: bounded MessagePort pipeline with explicit failure
    // and cancellation. Pixel ArrayBuffers are cloned, never transferred.
    const api = window.electronAPI || {};
    const canStream = typeof api.createReelsFramePipeline === 'function'
        && typeof api.sendReelsFramePipeline === 'function';
    const limit = Math.max(1, Math.min(3, batchSize));
    let pipelineId = null;
    let pipelineReady = null;
    let seq = 0;
    let inFlight = [];
    let legacyFrames = [];
    let failure = null;
    let closed = false;
    let cancelTimer = null;
    let rejectFailure;
    const failed = new Promise((_, reject) => { rejectFailure = reject; });
    failed.catch(() => {});

    const stopWatching = () => { if (cancelTimer) clearInterval(cancelTimer); cancelTimer = null; };
    const fail = error => {
        if (failure || closed) return;
        failure = new Error(error?.message || String(error));
        stopWatching();
        if (pipelineId) { try { api.closeReelsFramePipeline?.(pipelineId, failure.message); } catch (_) { } }
        pipelineId = null;
        legacyFrames = [];
        rejectFailure(failure);
        Promise.resolve().then(() => api.reelsComposeWysiwyg('abort', { sessionId })).catch(() => {});
    };
    const checkCancelled = () => {
        if (options.isCancelled?.()) fail(new Error('__CANCELLED__'));
        if (failure) throw failure;
    };
    const wait = promise => Promise.race([promise, failed]);

    const ensurePipeline = async () => {
        checkCancelled();
        if (closed) throw new Error('视频帧流水线已关闭');
        if (options.isCancelled && !cancelTimer) {
            cancelTimer = setInterval(() => {
                if (options.isCancelled()) fail(new Error('__CANCELLED__'));
            }, 100);
        }
        if (!canStream) return null;
        if (!pipelineReady) {
            pipelineReady = api.createReelsFramePipeline(sessionId)
                .then(id => {
                    if (failure || closed) { api.closeReelsFramePipeline?.(id, failure?.message || '流水线已关闭'); throw failure || new Error('流水线已关闭'); }
                    pipelineId = id;
                    return id;
                })
                .catch(error => {
                    fail(error);
                    throw error;
                });
        }
        return wait(pipelineReady);
    };
    const flushLegacy = async () => {
        if (!legacyFrames.length) return;
        const batch = legacyFrames;
        legacyFrames = [];
        const result = await wait(api.reelsComposeWysiwyg('frames', { sessionId, frames: batch }));
        const ok = result === true || (result && result.ok);
        if (!ok) throw new Error((result && result.error) || '批量写入视频帧失败');
    };
    const closeChannel = () => {
        stopWatching();
        if (pipelineId && typeof api.closeReelsFramePipeline === 'function') {
            try { api.closeReelsFramePipeline(pipelineId); } catch (_) { }
        }
        pipelineId = null;
    };

    return {
        async send(raw) {
            const id = await ensurePipeline();
            if (!id) {
                legacyFrames.push(raw);
                if (legacyFrames.length >= limit) await flushLegacy();
                return;
            }

            const pending = Promise.resolve(api.sendReelsFramePipeline(id, seq++, raw));
            // Observe failures immediately, including the second/third frame,
            // rather than waiting until that Promise reaches the queue head.
            pending.catch(fail);
            inFlight.push(pending);
            if (inFlight.length >= limit) {
                await wait(inFlight.shift());
            }
            checkCancelled();
        },
        async drain() {
            try {
                const id = await ensurePipeline();
                if (!id) await flushLegacy();
                else await wait(Promise.all(inFlight));
                checkCancelled();
            } finally {
                inFlight = [];
                closeChannel();
                closed = true;
            }
        },
        abort(error = new Error('__CANCELLED__')) { fail(error); inFlight = []; closeChannel(); closed = true; },
    };
}

window.ReelsFramePipeline = { create: createReelsFramePipeline };
