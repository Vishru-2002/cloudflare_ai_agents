export interface StackFrame {
  raw: string;
  fn: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
}

export interface ParsedTrace {
  language: "javascript" | "python" | "java" | "unknown";
  errorType: string | null;
  errorMessage: string | null;
  frames: StackFrame[];
}

const JS_FRAME_WITH_FN = /^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)\s*$/;
const JS_FRAME_BARE = /^\s*at\s+(.+?):(\d+):(\d+)\s*$/;
const PY_FRAME = /^\s*File\s+"(.+?)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?\s*$/;
const JAVA_FRAME = /^\s*at\s+([\w.$<>]+)\((.+?):(\d+)\)\s*$/;
const JS_ERROR_HEAD = /^([A-Za-z_$][\w$]*(?:Error|Exception))(?::\s*(.*))?$/;
const PY_ERROR_HEAD = /^([A-Za-z_][\w.]*(?:Error|Exception|Warning))(?::\s*(.*))?$/;

/**
 * Parses JavaScript/TypeScript, Python and Java stack traces into structured
 * frames. Written by hand rather than pulled from npm so it runs unchanged on
 * the Workers runtime with no dependencies.
 */
export function parseStackTrace(trace: string): ParsedTrace {
  const lines = trace.split(/\r?\n/);
  const frames: StackFrame[] = [];
  let language: ParsedTrace["language"] = "unknown";
  let errorType: string | null = null;
  let errorMessage: string | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    let match = JS_FRAME_WITH_FN.exec(line);
    if (match) {
      language = language === "unknown" ? "javascript" : language;
      frames.push({
        raw: line.trim(),
        fn: match[1],
        file: match[2],
        line: Number(match[3]),
        column: Number(match[4]),
      });
      continue;
    }

    match = JAVA_FRAME.exec(line);
    if (match) {
      language = "java";
      frames.push({
        raw: line.trim(),
        fn: match[1],
        file: match[2],
        line: Number(match[3]),
        column: null,
      });
      continue;
    }

    match = JS_FRAME_BARE.exec(line);
    if (match) {
      language = language === "unknown" ? "javascript" : language;
      frames.push({
        raw: line.trim(),
        fn: null,
        file: match[1],
        line: Number(match[2]),
        column: Number(match[3]),
      });
      continue;
    }

    match = PY_FRAME.exec(line);
    if (match) {
      language = "python";
      frames.push({
        raw: line.trim(),
        fn: match[3] ?? null,
        file: match[1],
        line: Number(match[2]),
        column: null,
      });
      continue;
    }

    // Not a frame — it may be the error header. Python puts it last,
    // JavaScript first, so keep the most specific match we find.
    const head = JS_ERROR_HEAD.exec(line.trim()) ?? PY_ERROR_HEAD.exec(line.trim());
    if (head) {
      errorType = head[1];
      errorMessage = head[2]?.trim() || null;
      if (language === "unknown" && head[1].includes("Error")) {
        language = line.includes("Traceback") ? "python" : language;
      }
    }
  }

  if (/Traceback \(most recent call last\)/.test(trace)) language = "python";

  return { language, errorType, errorMessage, frames };
}

/** The frame most likely to contain the bug: the deepest frame in user code. */
export function culpritFrame(parsed: ParsedTrace): StackFrame | null {
  const isVendor = (f: StackFrame) =>
    !!f.file &&
    /node_modules|site-packages|<anonymous>|internal\/|dist\/|\.min\.js/.test(f.file);

  // Python traces run outermost-first, JS innermost-first.
  const ordered = parsed.language === "python" ? [...parsed.frames].reverse() : parsed.frames;
  return ordered.find((f) => !isVendor(f)) ?? ordered[0] ?? null;
}
