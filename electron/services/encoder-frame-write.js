'use strict';

// Resolve only after the write callback and (when required) drain have both
// completed. Timeout, cancellation, stream closure and process exit are errors.
function writeEncoderFrame(session, buffer, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const stream = session.proc.stdin;
        const signal = session.writeAbortController?.signal;
        if (session.closed || session.encoderExited || stream.destroyed || stream.writableEnded || stream.writable === false || signal?.aborted) {
            reject(new Error(signal?.reason?.message || '编码器写入管道已关闭')); return;
        }
        let settled = false, returned = false, written = false, drained = false, needsDrain = false;
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stream.removeListener('error', onError);
            stream.removeListener('close', onClose);
            stream.removeListener('finish', onClose);
            stream.removeListener('drain', onDrain);
            session.proc.removeListener('error', onError);
            session.proc.removeListener('exit', onExit);
            session.proc.removeListener('close', onExit);
            signal?.removeEventListener('abort', onAbort);
            if (error) reject(error); else resolve();
        };
        const complete = () => { if (returned && written && (!needsDrain || drained)) finish(); };
        const onError = error => finish(error);
        const onClose = () => finish(new Error('编码器写帧期间输入管道关闭'));
        const onExit = (code, exitSignal) => finish(new Error(`编码器写帧期间退出：code=${code}，signal=${exitSignal || 'none'}；${session.stderr || ''}`));
        const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('__CANCELLED__'));
        const onDrain = () => { drained = true; complete(); };
        const timer = setTimeout(() => finish(new Error(`编码器写帧超时：${timeoutMs}ms；${session.stderr || ''}`)), timeoutMs);
        stream.once('error', onError);
        stream.once('close', onClose);
        stream.once('finish', onClose);
        stream.once('drain', onDrain);
        session.proc.once('error', onError);
        session.proc.once('exit', onExit);
        session.proc.once('close', onExit);
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            needsDrain = !stream.write(buffer, error => {
                if (error) { finish(error); return; }
                written = true;
                complete();
            });
            returned = true;
            complete();
        } catch (error) { finish(error); }
    });
}

module.exports = { writeEncoderFrame };
