const MASK = "********";

// Every secret the user typed in this process. Whatever reaches the terminal goes through
// `redact`, so a key can never be printed, not even inside an error message from a library.
const secrets = new Set<string>();

export function registerSecret(value: string): void {
  if (value) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(MASK);
  return out;
}

/** Test helper: forgets every registered secret. */
export function clearSecrets(): void {
  secrets.clear();
}
