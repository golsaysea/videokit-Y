'use strict';

// Shared by the normal preload and the disposable export renderer. Electron's
// MessagePortMain cannot deserialize ArrayBuffers sent in a transfer list.
// Keep the persistent channel, but send pixels using structured cloning.
function createReelsFrameBridge(ipcRenderer, options = {}) {
    const requests = new Map();
    const pipelines = new Map();
    const openTimeoutMs = options.openTimeoutMs ?? 8000;
    const ackTimeoutMs = options.ackTimeoutMs ?? 45000;
    const trace = options.trace || ((message) => console.log(`[ReelsFrame] ${message}`));
    const message = error => error?.message || String(error || '帧通道失败');

    function finishRequest(id, error) {
        const request = requests.get(id);
        if (!request) return;
        requests.delete(id);
        clearTimeout(request.timer);
        if (error) request.reject(error); else request.resolve(id);
    }

    function close(id, error) {
        const pipeline = pipelines.get(id);
        if (!pipeline) { finishRequest(id, error || new Error('帧通道已关闭')); return; }
        pipelines.delete(id);
        pipeline.closed = true;
        clearTimeout(pipeline.timer);
        const reason = error || new Error('帧通道已关闭');
        finishRequest(id, reason);
        const cleanEnd = !error && pipeline.ready && pipeline.pending.size === 0;
        for (const waiter of pipeline.pending.values()) waiter.reject(reason);
        pipeline.pending.clear();
        try { pipeline.port.postMessage({ type: cleanEnd ? 'end' : 'cancel', error: message(reason) }); } catch (_) { }
        pipeline.port.onmessage = pipeline.port.onmessageerror = pipeline.port.onclose = null;
        try { pipeline.port.close(); } catch (_) { }
        if (!cleanEnd) {
            trace(`failed session=${pipeline.sessionId} pipe=${id}: ${message(reason)}`);
            // Independent control IPC still works if the MessagePort is broken.
            Promise.resolve().then(() => ipcRenderer.invoke('reels-compose-wysiwyg', 'abort', { sessionId: pipeline.sessionId })).catch(() => {});
        }
    }

    function armWatchdog(id, pipeline) {
        clearTimeout(pipeline.timer);
        if (!pipeline.pending.size) return;
        pipeline.timer = setTimeout(() => {
            const seq = pipeline.pending.keys().next().value;
            close(id, new Error(`等待视频帧 ACK 超时：session=${pipeline.sessionId}，seq=${seq}，待确认=${pipeline.pending.size}，${ackTimeoutMs}ms 内无确认进展`));
        }, ackTimeoutMs);
    }

    const onReady = (event, data = {}) => {
        const port = event.ports?.[0];
        const request = requests.get(data.requestId);
        if (!request) { try { port?.close(); } catch (_) { } return; }
        if (!data.ok || !port) {
            try { port?.close(); } catch (_) { }
            finishRequest(data.requestId, new Error(data.error || '无法建立帧通道'));
            return;
        }
        const id = data.requestId;
        const pipeline = { port, sessionId: request.sessionId, pending: new Map(), ready: false, closed: false, nextSeq: 0, timer: null };
        pipelines.set(id, pipeline);
        port.onmessage = event => {
            const ack = event.data;
            if (!ack || typeof ack !== 'object') { close(id, new Error('帧通道确认消息无法解码')); return; }
            if (ack.type === 'ready' && ack.protocol === 1 && !pipeline.ready) {
                pipeline.ready = true;
                trace(`ready session=${pipeline.sessionId} pipe=${id}`);
                finishRequest(id);
                return;
            }
            if (ack.type === 'fatal') { close(id, new Error(ack.error || '编码端帧通道失败')); return; }
            if (ack.type !== 'ack' || !Number.isInteger(ack.seq)) { close(id, new Error('帧通道收到无效确认')); return; }
            const waiter = pipeline.pending.get(ack.seq);
            if (!waiter) { close(id, new Error(`帧通道收到未知或重复 ACK：seq=${ack.seq}`)); return; }
            if (!ack.ok) { close(id, new Error(ack.error || `视频帧写入失败：seq=${ack.seq}`)); return; }
            pipeline.pending.delete(ack.seq);
            waiter.resolve(ack);
            if (ack.seq < 3 || ack.seq % 120 === 0) trace(`ack-recv session=${pipeline.sessionId} seq=${ack.seq}`);
            // This is an idle timeout, not a deadline for queued frames. Each
            // successful ACK proves forward progress and restarts the timer.
            armWatchdog(id, pipeline);
        };
        port.onmessageerror = () => close(id, new Error('帧通道消息解码失败'));
        port.onclose = () => close(id, new Error('视频帧通道意外断开'));
        try { port.start?.(); port.postMessage({ type: 'hello', protocol: 1 }); }
        catch (error) { close(id, error); }
    };
    const onFailed = (_event, data = {}) => close(data.requestId, new Error(data.error || '编码端帧通道失败'));
    ipcRenderer.on('reels-frame-pipeline-ready', onReady);
    ipcRenderer.on('reels-frame-pipeline-failed', onFailed);

    const api = {
        createReelsFramePipeline(sessionId) {
            return new Promise((resolve, reject) => {
                const id = `${options.prefix || 'reels'}-pipe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                const timer = setTimeout(() => {
                    const error = new Error(`建立视频帧通道超时：session=${sessionId}`);
                    if (pipelines.has(id)) close(id, error); else finishRequest(id, error);
                    Promise.resolve().then(() => ipcRenderer.invoke('reels-compose-wysiwyg', 'abort', { sessionId })).catch(() => {});
                }, openTimeoutMs);
                requests.set(id, { resolve, reject, timer, sessionId });
                try { ipcRenderer.send('reels-frame-pipeline-open', { sessionId, requestId: id }); }
                catch (error) { finishRequest(id, error); }
            });
        },
        sendReelsFramePipeline(id, seq, raw) {
            return new Promise((resolve, reject) => {
                const pipeline = pipelines.get(id);
                if (!pipeline?.ready || pipeline.closed) { reject(new Error('视频帧通道不存在或已关闭')); return; }
                if (!Number.isInteger(seq) || seq !== pipeline.nextSeq || pipeline.pending.size >= 3) {
                    const error = new Error(`视频帧发送顺序或在途数量无效：seq=${seq}`);
                    reject(error); close(id, error); return;
                }
                pipeline.nextSeq++;
                const wasEmpty = pipeline.pending.size === 0;
                pipeline.pending.set(seq, { resolve, reject });
                if (wasEmpty) armWatchdog(id, pipeline);
                try {
                    pipeline.port.postMessage({ type: 'frame', seq, raw });
                    if (seq < 3 || seq % 120 === 0) trace(`send session=${pipeline.sessionId} seq=${seq} bytes=${raw?.byteLength}`);
                } catch (error) { close(id, error); }
            });
        },
        closeReelsFramePipeline: (id, reason) => close(id, reason ? new Error(String(reason)) : null),
    };
    function cancelAll(error = new Error('__CANCELLED__')) {
        for (const id of [...pipelines.keys()]) close(id, error);
        for (const [id, request] of [...requests]) {
            finishRequest(id, error);
            Promise.resolve().then(() => ipcRenderer.invoke('reels-compose-wysiwyg', 'abort', { sessionId: request.sessionId })).catch(() => {});
        }
    }
    return {
        api, cancelAll,
        dispose() {
            cancelAll(new Error('渲染窗口已关闭'));
            ipcRenderer.removeListener('reels-frame-pipeline-ready', onReady);
            ipcRenderer.removeListener('reels-frame-pipeline-failed', onFailed);
        },
    };
}

module.exports = { createReelsFrameBridge };
