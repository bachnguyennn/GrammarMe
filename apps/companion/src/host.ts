/**
 * Native messaging host loop. Reads framed requests from Chrome on `input`, writes framed replies on
 * `output`. Several requests may be in flight; at most one `check` and one `signIn` at a time. When
 * `input` ends (the extension disconnected), all work is aborted and the loop resolves.
 */
import { AI_MAX_INPUT_CHARS, COMPANION_ERROR_TEXT, parseCompanionRequest } from '@grammarme/core/companion';
import type { CompanionErrorCode, CompanionReply, CompanionRequest } from '@grammarme/core/companion';
import type { Companion } from './companion.ts';
import { CompanionError } from './errors.ts';
import { encodeMessage, FrameDecoder } from './framing.ts';
import { logEvent } from './log.ts';

type DonePayload = Omit<Extract<CompanionReply, { type: 'done'; ok: true }>, 'id' | 'type' | 'ok'>;

export interface HostIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

const SHUTDOWN_GRACE_MS = 5_000;

export function runHost(companion: Companion, io: HostIo): Promise<void> {
  const decoder = new FrameDecoder();
  const running = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  let checkBusy = false;
  let signInBusy = false;
  let closed = false;

  const send = (reply: CompanionReply): void => {
    if (closed) return;
    let frame: Buffer;
    try {
      frame = encodeMessage(reply);
    } catch {
      frame = encodeMessage({ id: reply.id, type: 'done', ok: false, error: 'internal', message: COMPANION_ERROR_TEXT.internal });
    }
    io.output.write(frame);
  };

  const fail = (id: string, error: CompanionErrorCode, message?: string): void =>
    send({ id, type: 'done', ok: false, error, message: message ?? COMPANION_ERROR_TEXT[error] });

  const start = (id: string, op: (signal: AbortSignal) => Promise<DonePayload>, onEnd?: () => void): void => {
    const controller = new AbortController();
    running.set(id, controller);
    const task = (async () => {
      try {
        const payload = await op(controller.signal);
        send({ id, type: 'done', ok: true, ...payload });
      } catch (e) {
        if (e instanceof CompanionError) {
          fail(id, e.code, e.message);
        } else {
          logEvent('unexpected_error', { name: e instanceof Error ? e.name : typeof e });
          fail(id, 'internal');
        }
      } finally {
        running.delete(id);
        onEnd?.();
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  const dispatch = (req: CompanionRequest): void => {
    if (req.type !== 'cancel' && running.has(req.id)) return fail(req.id, 'bad_request', 'A request with this id is already running.');
    switch (req.type) {
      case 'status':
        return start(req.id, async () => ({ status: await companion.status() }));
      case 'signIn':
        if (signInBusy) return fail(req.id, 'busy', 'A ChatGPT sign-in is already in progress.');
        signInBusy = true;
        return start(
          req.id,
          async (signal) => ({ status: await companion.signIn((url) => send({ id: req.id, type: 'authUrl', url }), signal) }),
          () => (signInBusy = false),
        );
      case 'signOut':
        return start(req.id, async () => {
          const { revoked } = await companion.signOut();
          return { revoked, status: await companion.status() };
        });
      case 'models':
        return start(req.id, async (signal) => ({ models: await companion.models(signal), status: await companion.status() }));
      case 'setModel':
        return start(req.id, async (signal) => ({ status: await companion.setModel(req.model, signal) }));
      case 'test':
        return start(req.id, async (signal) => ({ latencyMs: await companion.test(signal) }));
      case 'check':
        if (checkBusy) return fail(req.id, 'busy');
        checkBusy = true;
        return start(
          req.id,
          async (signal) => ({ check: await companion.check({ task: req.task, mode: req.mode, text: req.text }, signal) }),
          () => (checkBusy = false),
        );
      case 'cancel':
        running.get(req.target)?.abort();
        return send({ id: req.id, type: 'done', ok: true });
    }
  };

  const onMessage = (raw: unknown): void => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = typeof r.id === 'string' && r.id.length <= 64 ? r.id : '';
    if (r.type === 'check' && typeof r.text === 'string' && r.text.length > AI_MAX_INPUT_CHARS) return fail(id, 'too_long');
    const req = parseCompanionRequest(raw);
    if (!req) return fail(id, 'bad_request');
    dispatch(req);
  };

  return new Promise<void>((resolve) => {
    let ending = false;
    const shutdown = async () => {
      if (ending) return;
      ending = true;
      for (const controller of running.values()) controller.abort();
      const grace = new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS).unref());
      await Promise.race([Promise.allSettled([...pending]), grace]);
      closed = true;
      resolve();
    };

    io.input.on('data', (chunk: Buffer | string) => {
      if (ending) return;
      for (const frame of decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)) {
        if (frame.kind === 'message') onMessage(frame.value);
        else fail('', 'bad_request', frame.reason === 'oversize' ? 'Message too large.' : 'Message is not valid JSON.');
      }
    });
    io.input.on('end', () => void shutdown());
    io.input.on('close', () => void shutdown());
    io.input.on('error', () => void shutdown());
    io.output.on('error', () => {
      // Chrome went away mid-write (EPIPE). Stop writing and wind down.
      closed = true;
      void shutdown();
    });
  });
}
