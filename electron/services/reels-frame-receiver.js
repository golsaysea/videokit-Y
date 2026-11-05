'use strict';

function createReelsFrameReceiver({ port, sessionId, frameBytes, writeFrame, onFailure = () => {}, trace = () => {} }) {
    const pipeline = { port, pending: Promise.resolve(), failed: null, closed: false, expectedSeq: 0, queued: 0, ending: false, ready: false };
    function dispose() {
        if (pipeline.closed) return;
        pipeline.closed = true;
        port.removeListener('message', onMessage);
        port.removeListener('close', onClose);
        try { port.close(); } catch (_) { }
    }
    function fail(error) {
        if (pipeline.failed || pipeline.closed) return;
        pipeline.failed = error?.message || String(error);
        trace(`failed session=${sessionId}: ${pipeline.failed}`);
        try { port.postMessage({ type: 'fatal', error: pipeline.failed }); } catch (_) { }
        // The caller reports via control IPC and aborts FFmpeg independently of
        // this port. An ACK postMessage exception must never be swallowed.
        try { onFailure(new Error(pipeline.failed)); }
        catch (error) { trace(`failure-report-error session=${sessionId}: ${error.message}`); }
        finally { dispose(); }
    }
    function post(data) {
        try { port.postMessage(data); return true; }
        catch (error) { fail(new Error(`发送 ${data.type} 失败：${error.message}`)); return false; }
    }
    function onClose() {
        if (!pipeline.ending) fail(new Error('视频帧通道意外断开'));
        else dispose();
    }
    function onMessage(event) {
        if (pipeline.closed) return;
        const data = event?.data;
        if (!data || typeof data !== 'object') { fail(new Error('视频帧消息无法解码')); return; }
        if (data.type === 'hello' && data.protocol === 1 && !pipeline.ready) {
            pipeline.ready = true;
            post({ type: 'ready', protocol: 1 });
            return;
        }
        if (data.type === 'cancel') { fail(new Error(data.error || '__CANCELLED__')); return; }
        if (data.type === 'end' && pipeline.ready && pipeline.queued === 0) { pipeline.ending = true; return; }
        if (data.type !== 'frame' || !pipeline.ready || pipeline.ending) { fail(new Error('视频帧通道协议无效')); return; }
        if (!Number.isInteger(data.seq) || data.seq !== pipeline.expectedSeq) {
            fail(new Error(`帧序号不连续：收到 ${data.seq}，期望 ${pipeline.expectedSeq}`)); return;
        }
        if (data.raw?.byteLength !== frameBytes) {
            fail(new Error(`帧数据不完整：seq=${data.seq}，实际 ${data.raw?.byteLength ?? 0} 字节，期望 ${frameBytes} 字节`)); return;
        }
        if (pipeline.queued >= 3) { fail(new Error('视频帧通道积压超过三帧')); return; }
        pipeline.expectedSeq++;
        pipeline.queued++;
        const sample = data.seq < 3 || data.seq % 120 === 0;
        if (sample) trace(`main-recv session=${sessionId} seq=${data.seq} bytes=${data.raw.byteLength}`);
        pipeline.pending = pipeline.pending.then(async () => {
            if (pipeline.closed || pipeline.failed) return;
            const result = await writeFrame(data.raw);
            if (pipeline.closed || pipeline.failed) return;
            if (!result?.ok) throw new Error(result?.error || '视频帧写入失败');
            if (sample) trace(`write-done session=${sessionId} seq=${data.seq}`);
            // Mark capacity available before publishing the ACK. A renderer may
            // immediately send the next frame once it receives this message.
            pipeline.queued--;
            if (post({ type: 'ack', seq: data.seq, ok: true }) && sample) trace(`ack-send session=${sessionId} seq=${data.seq}`);
        }).catch(fail);
    }
    pipeline.dispose = dispose;
    pipeline.fail = fail;
    port.on('message', onMessage);
    port.on('close', onClose);
    try { port.start(); } catch (error) { fail(error); }
    return pipeline;
}

module.exports = { createReelsFrameReceiver };
