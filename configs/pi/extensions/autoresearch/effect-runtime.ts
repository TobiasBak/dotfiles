import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberId,
  Layer,
  ManagedRuntime,
  Option,
  Queue,
  Scope,
} from "effect";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ClockIdsConfigShape {
  readonly now: () => number;
  readonly continuationDelayMs: number;
  readonly dashboardIntervalMs: number;
}

export type AutoresearchServices = Scope.Scope;
export type AutoresearchManagedRuntime = ManagedRuntime.ManagedRuntime<never, never>;

/** Creates the one runtime shared by all autoresearch controllers in an extension instance. */
export function makeAutoresearchRuntime(
  _pi: ExtensionAPI,
  _config: Partial<ClockIdsConfigShape> & Pick<ClockIdsConfigShape, "now">,
): AutoresearchManagedRuntime {
  return ManagedRuntime.make(Layer.empty);
}

interface Envelope<Event> {
  readonly event: Event;
  readonly handled: Deferred.Deferred<void, Error> | undefined;
  readonly reply: Deferred.Deferred<unknown, Error> | undefined;
}

export interface SerializedController<Event> {
  /** Enqueue from inside the controller scope. */
  readonly offer: (event: Event) => Effect.Effect<void>;
  /** Enqueue and await completion of the handler. */
  readonly dispatch: (event: Event) => Promise<void>;
  /** Backward-compatible name for an awaited dispatch. */
  readonly runPromise: (event: Event) => Promise<void>;
  /** Safe callback bridge. Failures are observed and shutdown awaits the bridge. */
  readonly tell: (event: Event) => void;
  readonly request: <A>(makeEvent: (reply: Deferred.Deferred<A, Error>) => Event) => Promise<A>;
  readonly interrupt: () => Promise<void>;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * A single-consumer actor. Its root scope owns every forkScoped task created by
 * a handler. Awaited envelopes are acknowledged exactly once, including when a
 * handler defects or shutdown drains pending work.
 */
export function makeSerializedController<Event>(
  runtime: AutoresearchManagedRuntime,
  handle: (event: Event) => Effect.Effect<void, never, Scope.Scope>,
  reportDefect: (message: string) => void,
): SerializedController<Event> {
  const ready = Deferred.unsafeMake<Queue.Queue<Envelope<Event>>, Error>(FiberId.none);
  const pendingTells = new Set<Promise<void>>();
  let interrupted = false;

  const failEnvelope = (envelope: Envelope<Event>, error: Error): Effect.Effect<void> => Effect.gen(function* () {
    if (envelope.reply) yield* Deferred.fail(envelope.reply, error).pipe(Effect.asVoid);
    if (envelope.handled) yield* Deferred.fail(envelope.handled, error).pipe(Effect.asVoid);
  });

  const processEnvelope = (envelope: Envelope<Event>): Effect.Effect<void, never, Scope.Scope> => handle(envelope.event).pipe(
    Effect.onExit((exit) => {
      if (Exit.isFailure(exit)) {
        const error = new Error(`Serialized controller handler failed: ${Cause.pretty(exit.cause)}`);
        return failEnvelope(envelope, error).pipe(
          Effect.zipRight(Effect.sync(() => reportDefect(error.message))),
        );
      }
      return Effect.gen(function* () {
        if (envelope.reply) {
          const result = yield* Deferred.poll(envelope.reply);
          if (Option.isNone(result)) {
            yield* Deferred.fail(envelope.reply, new Error("Serialized controller request completed without a reply"));
          }
        }
        if (envelope.handled) yield* Deferred.succeed(envelope.handled, undefined);
      });
    }),
    Effect.asVoid,
  );

  const root = runtime.runFork(Effect.scoped(Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Envelope<Event>>();
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      interrupted = true;
      const pending = yield* Queue.takeAll(queue);
      const error = new Error("Serialized controller shut down before handling the request");
      for (const envelope of pending) yield* failEnvelope(envelope, error);
      yield* Queue.shutdown(queue);
    }));
    yield* Deferred.succeed(ready, queue);
    yield* Queue.take(queue).pipe(Effect.flatMap(processEnvelope), Effect.forever);
  })).pipe(
    Effect.onExit((exit) => Exit.isFailure(exit) && !interrupted
      ? Effect.sync(() => reportDefect(Cause.pretty(exit.cause)))
      : Effect.void),
  ));

  const enqueue = (envelope: Envelope<Event>): Effect.Effect<void, Error> => interrupted
    ? Effect.fail(new Error("Serialized controller is shut down"))
    : Deferred.await(ready).pipe(
        Effect.flatMap((queue) => Queue.offer(queue, envelope)),
        Effect.flatMap((accepted) => accepted
          ? Effect.void
          : Effect.fail(new Error("Serialized controller queue is shut down"))),
      );

  const offer = (event: Event): Effect.Effect<void> => enqueue({ event, handled: undefined, reply: undefined }).pipe(
    Effect.catchAll((error) => Effect.sync(() => reportDefect(error.message))),
  );

  const dispatch = (event: Event): Promise<void> => runtime.runPromise(Effect.gen(function* () {
    const handled = yield* Deferred.make<void, Error>();
    yield* enqueue({ event, handled, reply: undefined });
    yield* Deferred.await(handled);
  }));

  const tell = (event: Event): void => {
    const pending = dispatch(event);
    pendingTells.add(pending);
    pending.then(
      () => pendingTells.delete(pending),
      (cause) => {
        pendingTells.delete(pending);
        try { reportDefect(asError(cause).message); } catch {}
      },
    );
  };

  const request = <A>(makeEvent: (reply: Deferred.Deferred<A, Error>) => Event): Promise<A> => runtime.runPromise(
    Effect.gen(function* () {
      const handled = yield* Deferred.make<void, Error>();
      const reply = yield* Deferred.make<A, Error>();
      yield* enqueue({
        event: makeEvent(reply),
        handled,
        reply: reply as Deferred.Deferred<unknown, Error>,
      });
      yield* Deferred.await(handled);
      return yield* Deferred.await(reply);
    }),
  );

  const interrupt = async (): Promise<void> => {
    if (!interrupted) {
      interrupted = true;
      await runtime.runPromise(Fiber.interrupt(root).pipe(Effect.asVoid));
    }
    if (pendingTells.size > 0) await Promise.allSettled([...pendingTells]);
  };

  return { offer, dispatch, runPromise: dispatch, tell, request, interrupt };
}

export function scopedSleep(milliseconds: number): Effect.Effect<void> {
  return Effect.sleep(`${Math.max(0, milliseconds)} millis`);
}

/** Forks into the controller's application scope, not the short-lived handler fiber. */
export function forkControllerTask<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Fiber.RuntimeFiber<A, E>, never, R | Scope.Scope> {
  return Effect.forkScoped(effect);
}
