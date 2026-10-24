/**
 * Why a host call did not complete normally. Recorded in the call's evidence
 * and carried by the {@link ScriptApiError} a filter sees from `next()`.
 */
export type CallErrorCode =
  | 'denied'
  | 'unknown-method'
  | 'invalid-arguments'
  | 'invalid-result'
  | 'app-error'
  | 'host-failure'
  | 'host-timeout'
  | 'response-too-large'
  | 'revoked';

/** The error name a script sees for each code, unless the thrower chose another. */
const guestNames: Readonly<Record<CallErrorCode, string>> = {
  'denied': 'PermissionDeniedError',
  'unknown-method': 'UnknownMethodError',
  'invalid-arguments': 'InvalidArgumentsError',
  'invalid-result': 'HostError',
  'app-error': 'HostError',
  'host-failure': 'HostError',
  'host-timeout': 'HostTimeoutError',
  'response-too-large': 'ResponseTooLargeError',
  'revoked': 'RevokedError',
};

const errorNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface ScriptApiErrorOptions {
  /** The message the script sees. Write it for the script's author; it must not hold secrets or internal detail. */
  readonly message: string;
  /** The error's name in the script, such as `NotFoundError`. Letters, digits and underscores, up to 64 characters. */
  readonly name?: string;
  readonly code?: CallErrorCode;
  readonly cause?: unknown;
}

/**
 * An error meant for the script. A handler or filter throws it to fail a call
 * with a name and message the script can read and catch. Any other exception a
 * handler throws reaches the script only as a generic `HostError`.
 */
export class ScriptApiError extends Error {
  readonly code: CallErrorCode;
  readonly guestName: string;

  constructor(options: ScriptApiErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ScriptApiError';
    this.code = options.code ?? 'app-error';
    const guestName = options.name ?? guestNames[this.code];
    if (!errorNamePattern.test(guestName)) {
      throw new TypeError(`'${guestName}' is not a usable error name. Use letters, digits and underscores.`);
    }
    this.guestName = guestName;
  }
}

/** Refuses a call from a filter. The script sees a `PermissionDeniedError` it can catch. */
export function denyCall(message: string): ScriptApiError {
  return new ScriptApiError({ code: 'denied', message });
}

/** Thrown for invalid configuration: a contract, a capability or a limit the host got wrong. */
export class ScriptBoxConfigurationError extends Error {
  override readonly name = 'ScriptBoxConfigurationError';
}

/** Thrown by `execute` on a session that is running another execution. Executions on one session never queue. */
export class SessionBusyError extends Error {
  override readonly name = 'SessionBusyError';
}

/** Thrown by `execute` on a session that has been disposed. */
export class SessionDisposedError extends Error {
  override readonly name = 'SessionDisposedError';
}

/** Thrown when the bundled runtime artifacts do not match what this package was built with. */
export class ProtocolMismatchError extends Error {
  override readonly name = 'ProtocolMismatchError';
}
