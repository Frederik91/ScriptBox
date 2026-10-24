import { Worker } from 'node:worker_threads';
import { readCompileResponse, type CompileDiagnostic } from './compile-protocol.ts';

export type CompileOutcome =
  | { readonly kind: 'compiled'; readonly js: string; readonly map: string }
  | { readonly kind: 'rejected'; readonly category: 'invalid-source' | 'type-check'; readonly diagnostics: readonly CompileDiagnostic[] }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'memory' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string };

interface Slot {
  worker: Worker | undefined;
  /** The heap limit the slot's worker was started with. */
  heapMb: number;
  busy: boolean;
}

/**
 * TypeScript compiler workers, shared by a runtime's sessions. A worker
 * compiles one script at a time and is reused; a worker that overruns its
 * time or heap is terminated and replaced. Compiling never runs on the
 * application's event loop.
 */
export class CompilerPool {
  private readonly slots: Slot[];
  private readonly waiting: (() => void)[] = [];
  private readonly defaultHeapMb: number;
  private nextId = 1;
  private disposed = false;

  constructor(size: number, heapMb: number) {
    this.slots = Array.from({ length: Math.max(1, size) }, () => ({ worker: undefined, heapMb, busy: false }));
    this.defaultHeapMb = heapMb;
  }

  /** Starts the workers ahead of the first compile, which otherwise pays for loading TypeScript. */
  warmUp(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const slot of this.slots) {
      if (!slot.busy && slot.worker === undefined) {
        const worker = this.spawn(this.defaultHeapMb);
        slot.worker = worker;
        slot.heapMb = this.defaultHeapMb;
        pending.push(new Promise((resolve) => worker.once('online', resolve)));
      }
    }
    return Promise.all(pending).then(() => undefined);
  }

  async compile(
    source: string,
    declarations: string,
    declarationsKey: string,
    timeoutMs: number,
    heapMb: number,
    signal: AbortSignal,
  ): Promise<CompileOutcome> {
    const deadline = performance.now() + timeoutMs;
    const slot = await this.acquire(deadline, signal);
    if (slot === undefined) {
      return signal.aborted ? { kind: 'cancelled' } : { kind: 'timeout' };
    }
    try {
      return await this.run(slot, source, declarations, declarationsKey, deadline - performance.now(), heapMb, signal);
    } finally {
      slot.busy = false;
      this.waiting.shift()?.();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const resolve of this.waiting.splice(0)) {
      resolve();
    }
    await Promise.all(this.slots.map(async (slot) => {
      const worker = slot.worker;
      slot.worker = undefined;
      if (worker !== undefined) {
        await worker.terminate();
      }
    }));
  }

  private spawn(heapMb: number): Worker {
    const worker = new Worker(new URL('./compiler-worker.js', import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: Math.min(32, Math.floor(heapMb / 4)) },
      env: {},
      execArgv: [],
    });
    // Unref'd so idle compilers never keep the application alive. Piped stdio
    // would hold a reference, so the worker writes nothing instead.
    worker.unref();
    return worker;
  }

  private async acquire(deadline: number, signal: AbortSignal): Promise<Slot | undefined> {
    for (;;) {
      if (this.disposed || signal.aborted || performance.now() >= deadline) {
        return undefined;
      }
      const slot = this.slots.find((s) => !s.busy);
      if (slot !== undefined) {
        slot.busy = true;
        return slot;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.max(0, deadline - performance.now()));
        signal.addEventListener('abort', done, { once: true });
        this.waiting.push(done);
        function done(): void {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        }
      });
    }
  }

  private run(slot: Slot, source: string, declarations: string, declarationsKey: string, timeoutMs: number, heapMb: number, signal: AbortSignal): Promise<CompileOutcome> {
    // A worker's heap limit is fixed when it starts, so a compile with another limit gets a new worker.
    if (slot.worker !== undefined && slot.heapMb !== heapMb) {
      void slot.worker.terminate();
      slot.worker = undefined;
    }
    const worker = slot.worker ?? this.spawn(heapMb);
    slot.worker = worker;
    slot.heapMb = heapMb;
    const id = this.nextId++;
    return new Promise<CompileOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: CompileOutcome, kill: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        if (kill) {
          slot.worker = undefined;
          void worker.terminate();
        }
        resolve(outcome);
      };
      const onMessage = (raw: unknown): void => {
        const response = readCompileResponse(raw);
        if (response?.id !== id) {
          return;
        }
        switch (response.t) {
          case 'compiled':
            finish({ kind: 'compiled', js: response.js, map: response.map }, false);
            return;
          case 'rejected':
            finish({ kind: 'rejected', category: response.category, diagnostics: response.diagnostics }, false);
            return;
          case 'failed':
            finish({ kind: 'failed', message: response.message }, true);
            return;
        }
      };
      const onError = (error: Error): void => {
        const code: unknown = Reflect.get(error, 'code');
        finish(code === 'ERR_WORKER_OUT_OF_MEMORY' ? { kind: 'memory' } : { kind: 'failed', message: error.message }, true);
      };
      const onExit = (): void => {
        finish({ kind: 'failed', message: 'The compiler worker exited.' }, true);
      };
      const onAbort = (): void => {
        finish({ kind: 'cancelled' }, true);
      };
      const timer = setTimeout(() => {
        finish({ kind: 'timeout' }, true);
      }, Math.max(0, timeoutMs));
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      signal.addEventListener('abort', onAbort, { once: true });
      worker.postMessage({ t: 'compile', id, source, declarations, declarationsKey });
    });
  }
}
