const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accepts a bare value or a whole line copied from the API Keys page, such as
 * `WOPEE_PROJECT_UUID=…` or `export WOPEE_API_KEY="…"`.
 */
export function parsePasted(name: string, input: string): string {
  const trimmed = input.trim();
  const match = new RegExp(`^(?:export\\s+)?${name}\\s*=\\s*(.*)$`).exec(
    trimmed,
  );
  const value = (match ? match[1] : trimmed).trim();
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

export function validateProjectUuid(
  input: string | undefined,
): string | undefined {
  const value = parsePasted("WOPEE_PROJECT_UUID", input ?? "");
  if (!value) return "Paste the project UUID from the API Keys page";
  if (!UUID_RE.test(value))
    return "That is not a project UUID (expected 8-4-4-4-12 hex characters)";
  return undefined;
}

export function validateApiKey(input: string | undefined): string | undefined {
  const value = parsePasted("WOPEE_API_KEY", input ?? "");
  if (!value) return "Paste the API key you just generated";
  if (/\s/.test(value))
    return "An API key has no spaces; copy it again with the copy button";
  return undefined;
}

export const isProjectUuid = (value: string | undefined): value is string =>
  !!value && UUID_RE.test(value);
