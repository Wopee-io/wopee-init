export type InitErrorCode =
  | "usage"
  | "no_tty"
  | "cancelled"
  | "invalid_credentials"
  | "network"
  | "instance"
  | "api_error"
  | "unsafe_env_file"
  | "invalid_config"
  | "conflict";

const EXIT_CODES: Record<InitErrorCode, number> = {
  usage: 2,
  no_tty: 2,
  cancelled: 130,
  invalid_credentials: 3,
  network: 4,
  instance: 4,
  api_error: 4,
  unsafe_env_file: 5,
  invalid_config: 5,
  conflict: 5,
};

/** An expected failure: its message is shown as-is, without a stack trace. */
export class InitError extends Error {
  readonly code: InitErrorCode;

  constructor(code: InitErrorCode, message: string) {
    super(message);
    this.name = "InitError";
    this.code = code;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}
