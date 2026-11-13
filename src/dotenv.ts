const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
const SAFE_VALUE_RE = /^[A-Za-z0-9_\-.:/+=@,]*$/;

function unquote(raw: string): string {
  const quote = raw[0];
  if ((quote === '"' || quote === "'") && raw.length >= 2) {
    const end = raw.indexOf(quote, 1);
    if (end > 0) {
      const inner = raw.slice(1, end);
      return quote === '"'
        ? inner.replace(/\\n/g, "\n").replace(/\\(["\\])/g, "$1")
        : inner;
    }
  }
  // Unquoted: an inline comment starts at " #".
  const hash = raw.search(/\s#/);
  return (hash >= 0 ? raw.slice(0, hash) : raw).trim();
}

/** Parses dotenv text. A later line wins, as in dotenv itself. */
export function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = LINE_RE.exec(line);
    if (match) values.set(match[1], unquote(match[2]));
  }
  return values;
}

function formatValue(value: string): string {
  if (SAFE_VALUE_RE.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/**
 * Sets each entry in dotenv text and keeps every other line, comment and the line endings.
 * An existing key is rewritten in place (its last definition), a new one is appended.
 */
export function upsertDotenv(
  text: string,
  entries: Record<string, string>,
): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  for (const [key, value] of Object.entries(entries)) {
    const formatted = `${key}=${formatValue(value)}`;
    let index = -1;
    lines.forEach((line, i) => {
      if (!/^\s*#/.test(line) && LINE_RE.exec(line)?.[1] === key) index = i;
    });
    if (index >= 0) lines[index] = formatted;
    else lines.push(formatted);
  }
  return lines.length ? lines.join(eol) + eol : "";
}
