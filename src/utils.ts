import { base64ToArrayBuffer } from "obsidian";

const TEXT_EXTENSIONS = [
  ".css",
  ".md",
  ".json",
  ".txt",
  ".csv",
  ".js",
  ".log",
] as const;

/**
 * Decodes a base64 encoded string, this properly
 * handles emojis and other non ASCII chars.
 *
 * @param s base64 encoded string
 * @returns Decoded string
 */
export function decodeBase64String(s: string): string {
  const buffer = base64ToArrayBuffer(s);
  const decoder = new TextDecoder();
  return decoder.decode(buffer);
}

/**
 * Copies the provided text to the system clipboard.
 * Uses the modern Clipboard API with a fallback to older APIs.
 *
 * @param text The string to be copied to clipboard
 * @returns A promise that resolves when the text has been copied
 */
export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // Fallback for devices like iOS that don't support Clipboard API
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);

    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
}

/**
 * Checks if a file path has one of the predefined text extensions.
 * This is a best guess at best.
 *
 * @param filePath The path of the file to check
 * @returns True if the file has a text extension, false otherwise
 */
export function hasTextExtension(filePath: string) {
  for (const extension of TEXT_EXTENSIONS) {
    if (filePath.endsWith(extension)) {
      return true;
    }
  }
  return false;
}

/**
 * Calculates the SHA1 git gives a blob with this content.
 *
 * @param content The blob content
 * @returns The hex SHA1
 */
export async function gitBlobSHA(content: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(content);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const store = new Uint8Array(header.length + bytes.length);
  store.set(header);
  store.set(bytes, header.length);
  const hash = await crypto.subtle.digest("SHA-1", store);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Encodes text as UTF-8.
 *
 * @param text The text to encode
 * @returns A buffer holding exactly the encoded bytes
 */
export function textToArrayBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/**
 * Checks if a file path has one of the given extensions.
 *
 * @param filePath The path of the file to check
 * @param extensions Comma separated extensions, with or without the dot
 * @returns True if the file has one of the extensions, ignoring case
 */
export function isMediaFile(filePath: string, extensions: string) {
  const name = filePath.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  const extension = name.slice(dot + 1).toLowerCase();
  return extensions
    .split(",")
    .map((e) => e.trim().replace(/^\./, "").toLowerCase())
    .includes(extension);
}

// Indentation and block quote markers before the content of a line
const LINE_PREFIX = /^[ \t>]*/;
// A code fence, which may follow block quote and list markers
const FENCE = /^(?:[ \t>]|(?:[-*+]|\d+[.)])[ \t])*(`{3,}|~{3,})(.*)$/;

/**
 * Splits a row of a Markdown table into its cells, without the spaces around
 * them. The pipes at both ends are optional, and an escaped pipe (`\|`) is
 * part of its cell.
 *
 * @param row The row, without what's before its first cell or pipe
 * @returns The cells, null if the line has no pipe separating cells
 */
function tableCells(row: string): string[] | null {
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "|" && !escaped) {
      cells.push(cell);
      cell = "";
    } else {
      cell += row[i];
    }
    escaped = row[i] === "\\" && !escaped;
  }
  if (cells.length === 0) {
    return null;
  }
  if (cell !== "") {
    // No pipe closes the row
    cells.push(cell);
  }
  if (cells[0] === "") {
    // A pipe opens the row
    cells.shift();
  }
  return cells.map((c) => c.replace(/^[ \t]+|[ \t]+$/g, ""));
}

/**
 * Rewrites a note so that formatting no longer tells two versions apart:
 * line endings, whitespace at the end of lines, blank lines at the end of the
 * file, and the layout of tables. Every row of a table gets the same form:
 * cells without the spaces around them, delimiter cells as `---` with their
 * alignment colons, a pipe at both ends. Everything else stays as it is, and
 * so does anything in a fenced code block.
 */
function canonicalNote(text: string): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const row = (cells: string[]) => `|${cells.map((c) => ` ${c} |`).join("")}`;
  // The marker that opened the code block we're in
  let fence: string | null = null;
  // What precedes each row of the table we're in
  let table: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(FENCE);
    if (fence !== null) {
      if (
        marker !== null &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        marker[2] === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (marker !== null) {
      fence = marker[1];
      table = null;
      continue;
    }
    const prefix = (lines[i].match(LINE_PREFIX) as RegExpMatchArray)[0];
    const cells = tableCells(lines[i].slice(prefix.length));
    if (cells !== null && table === prefix) {
      lines[i] = prefix + row(cells);
      continue;
    }
    table = null;
    if (
      i === 0 ||
      cells === null ||
      cells.length === 0 ||
      !cells.every((c) => /^:?-+:?$/.test(c))
    ) {
      continue;
    }
    // A delimiter row: with the row before it, it starts a table if that one
    // has as many cells and is indented and quoted the same way
    const header = lines[i - 1];
    const headerCells =
      (header.match(LINE_PREFIX) as RegExpMatchArray)[0] === prefix
        ? tableCells(header.slice(prefix.length))
        : null;
    if (headerCells !== null && headerCells.length === cells.length) {
      lines[i - 1] = prefix + row(headerCells);
      lines[i] =
        prefix +
        row(
          cells.map(
            (c) =>
              `${c.startsWith(":") ? ":" : ""}---${c.endsWith(":") ? ":" : ""}`,
          ),
        );
      table = prefix;
    }
  }
  return lines.join("\n");
}

/**
 * Checks if two versions of a note differ only by formatting, which Obsidian
 * changes on its own: it pads the cells of a table to align its columns as
 * soon as one of them is touched.
 *
 * Line endings, whitespace at the end of lines, blank lines at the end of the
 * file and the layout of table rows (the spaces around cells, the dashes of
 * the delimiter row, the pipes at both ends) are formatting. Anything else is
 * not: the text of a cell, the alignment of a column, indentation, and
 * whatever is in a fenced code block.
 *
 * @param a One version of the note
 * @param b The other version
 * @returns True if the versions are the same apart from formatting
 */
export function differOnlyByFormatting(a: string, b: string): boolean {
  return canonicalNote(a) === canonicalNote(b);
}

/**
 * Retries an async function until its return value satisfies a condition or max retries is reached.
 * Uses exponential backoff between retry attempts.
 *
 * @param fn - The async function to execute and potentially retry
 * @param condition - Function that evaluates if the result is acceptable
 * @param maxRetries - Maximum number of retry attempts (default: 5)
 * @param initialDelay - Initial delay in ms before first retry (default: 1000)
 * @param backoffFactor - Multiplicative factor for delay between retries (default: 2)
 * @returns The result of the function execution
 */
export async function retryUntil<T>(
  fn: () => Promise<T>,
  condition: (result: T) => boolean,
  maxRetries: number = 5,
  initialDelay: number = 1000,
  backoffFactor: number = 2,
): Promise<T> {
  let retries = 0;
  let delay = initialDelay;

  while (true) {
    const result = await fn();

    if (condition(result) || retries >= maxRetries) {
      return result;
    }

    retries++;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay *= backoffFactor;
  }
}
