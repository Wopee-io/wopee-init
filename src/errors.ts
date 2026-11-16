/**
 * How the `next` commands start. `@latest`, so npx does not rerun an older init it cached under
 * the bare name.
 */
export const INIT_COMMAND = "npx -y @wopee-io/init@latest";

export type InitErrorCode =
  | "usage"
  | "no_tty"
  | "cancelled"
  | "invalid_credentials"
  | "missing_credentials"
  | "network"
  | "instance"
  | "api_error"
  | "unsafe_env_file"
  | "invalid_config"
  | "conflict"
  | "pairing_unavailable"
  | "pairing_denied"
  | "pairing_expired"
  | "no_pairing"
  | "action_required";

const EXIT_CODES: Record<InitErrorCode, number> = {
  usage: 2,
  no_tty: 2,
  no_pairing: 2,
  cancelled: 130,
  invalid_credentials: 3,
  missing_credentials: 3,
  network: 4,
  instance: 4,
  api_error: 4,
  pairing_unavailable: 4,
  unsafe_env_file: 5,
  invalid_config: 5,
  conflict: 5,
  pairing_denied: 6,
  pairing_expired: 6,
  // EX_TEMPFAIL: not a failure, the user has a step to take before `--resume` finishes.
  action_required: 75,
};

/** An expected failure: its message is shown as-is, without a stack trace. */
export class InitError extends Error {
  readonly code: InitErrorCode;
  /** The command to run next, for agents reading the JSON output. */
  readonly next?: string;
  /** Extra fields for the JSON output, e.g. the link an `action_required` hands back. */
  readonly details?: Record<string, unknown>;

  constructor(
    code: InitErrorCode,
    message: string,
    next?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "InitError";
    this.code = code;
    this.next = next;
    this.details = details;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}
