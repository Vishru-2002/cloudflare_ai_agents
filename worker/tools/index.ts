import type { CodeArtifact, ToolArgs } from "../../shared/protocol";
import type { AiToolDef } from "../ai/client";
import { culpritFrame, parseStackTrace } from "./stacktrace";
import { analyzeSource, languageFromPath, normalizeLanguage } from "./static";

export interface ToolContext {
  artifacts: CodeArtifact[];
  /** The error text/stack the user supplied for this session, if any. */
  errorText: string | null;
}

export interface ToolResult {
  ok: boolean;
  data: unknown;
}

export interface ToolImpl {
  def: AiToolDef;
  run: (args: ToolArgs, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

/**
 * Every tool result is appended to the conversation and re-sent on the next
 * iteration, so an unbounded result is paid for on every subsequent turn. Cap
 * hard — this single constant is the difference between ~40 and ~150 agent
 * turns per day on the free Neuron allowance.
 */
const MAX_RESULT_CHARS = 2000;

function truncate(text: string, limit = MAX_RESULT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]`;
}

function findArtifact(ctx: ToolContext, path: unknown): CodeArtifact | null {
  if (typeof path !== "string" || !path.trim()) return ctx.artifacts[0] ?? null;
  const needle = path.trim().toLowerCase();
  return (
    ctx.artifacts.find((a) => a.path.toLowerCase() === needle) ??
    ctx.artifacts.find((a) => a.path.toLowerCase().endsWith(needle)) ??
    ctx.artifacts.find((a) => a.path.toLowerCase().includes(needle)) ??
    null
  );
}

function numberLines(content: string, from: number, to: number): string {
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, from);
  const end = Math.min(lines.length, to);
  const width = String(end).length;
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    out.push(`${String(i).padStart(width, " ")} | ${lines[i - 1]}`);
  }
  return out.join("\n");
}

const listFiles: ToolImpl = {
  def: {
    name: "list_files",
    description:
      "List the source files attached to this debugging session, with their language and line count. Call this first if you do not know what code is available.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  run: (_args, ctx) => ({
    ok: true,
    data: {
      files: ctx.artifacts.map((a) => ({
        path: a.path,
        language: a.language,
        lines: a.content.split(/\r?\n/).length,
        bytes: a.bytes,
      })),
      hasErrorText: Boolean(ctx.errorText),
    },
  }),
};

const readFile: ToolImpl = {
  def: {
    name: "read_file",
    description:
      "Read a numbered slice of an attached source file. Prefer a narrow range around a suspect line over reading the whole file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, or a suffix of it. Omit to use the only attached file." },
        start_line: { type: "number", description: "First line to read (1-based). Defaults to 1." },
        end_line: { type: "number", description: "Last line to read. Defaults to start_line + 60." },
      },
      required: [],
    },
  },
  run: (args, ctx) => {
    const artifact = findArtifact(ctx, args.path);
    if (!artifact) return { ok: false, data: { error: "No such file in this session. Call list_files first." } };

    const total = artifact.content.split(/\r?\n/).length;
    const start = Number(args.start_line) > 0 ? Math.floor(Number(args.start_line)) : 1;
    const end = Number(args.end_line) > 0 ? Math.floor(Number(args.end_line)) : start + 60;

    return {
      ok: true,
      data: {
        path: artifact.path,
        language: artifact.language,
        totalLines: total,
        range: [Math.max(1, start), Math.min(total, end)],
        source: truncate(numberLines(artifact.content, start, end)),
      },
    };
  },
};

const analyzeCode: ToolImpl = {
  def: {
    name: "analyze_code",
    description:
      "Run static bug-pattern analysis over an attached file. Returns line-level findings (off-by-one loops, unawaited promises, mutable default arguments, and similar). Findings are heuristics — always confirm against the source with read_file before concluding.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to analyze. Omit to analyze every attached file." },
      },
      required: [],
    },
  },
  run: (args, ctx) => {
    const targets =
      typeof args.path === "string" && args.path.trim()
        ? [findArtifact(ctx, args.path)].filter(Boolean as unknown as (v: CodeArtifact | null) => v is CodeArtifact)
        : ctx.artifacts;

    if (targets.length === 0) return { ok: false, data: { error: "No files to analyze." } };

    const results = targets.map((a) => ({
      path: a.path,
      findings: analyzeSource(a.content, normalizeLanguage(a.language || languageFromPath(a.path))),
    }));

    const total = results.reduce((sum, r) => sum + r.findings.length, 0);
    return { ok: true, data: { totalFindings: total, results } };
  },
};

const parseTrace: ToolImpl = {
  def: {
    name: "parse_stack_trace",
    description:
      "Parse a JavaScript, Python or Java stack trace into structured frames and identify the deepest frame in user code (skipping node_modules/site-packages).",
    parameters: {
      type: "object",
      properties: {
        trace: {
          type: "string",
          description: "The raw stack trace. Omit to use the error text attached to this session.",
        },
      },
      required: [],
    },
  },
  run: (args, ctx) => {
    const trace = typeof args.trace === "string" && args.trace.trim() ? args.trace : ctx.errorText;
    if (!trace) return { ok: false, data: { error: "No stack trace supplied or attached to this session." } };

    const parsed = parseStackTrace(trace);
    const culprit = culpritFrame(parsed);
    return {
      ok: true,
      data: {
        language: parsed.language,
        errorType: parsed.errorType,
        errorMessage: parsed.errorMessage,
        frameCount: parsed.frames.length,
        likelyCulprit: culprit,
        frames: parsed.frames.slice(0, 12),
      },
    };
  },
};

const findSymbol: ToolImpl = {
  def: {
    name: "find_symbol",
    description:
      "Locate where a function, class or variable is defined and where it is referenced, across all attached files.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name to look for." },
      },
      required: ["name"],
    },
  },
  run: (args, ctx) => {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return { ok: false, data: { error: "A symbol name is required." } };

    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const defPattern = new RegExp(
      `(?:function\\s+${escaped}\\b|class\\s+${escaped}\\b|def\\s+${escaped}\\b|` +
        `(?:const|let|var)\\s+${escaped}\\b|${escaped}\\s*[:=]\\s*(?:function|\\(|async))`,
    );
    const refPattern = new RegExp(`\\b${escaped}\\b`);

    const definitions: Array<{ path: string; line: number; text: string }> = [];
    const references: Array<{ path: string; line: number; text: string }> = [];

    for (const artifact of ctx.artifacts) {
      const lines = artifact.content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i].trim();
        if (!refPattern.test(lines[i])) continue;
        const entry = { path: artifact.path, line: i + 1, text: text.slice(0, 160) };
        if (defPattern.test(lines[i])) definitions.push(entry);
        else if (references.length < 25) references.push(entry);
      }
    }

    return {
      ok: true,
      data: {
        symbol: name,
        definitions,
        referenceCount: references.length,
        references: references.slice(0, 15),
      },
    };
  },
};

const searchCode: ToolImpl = {
  def: {
    name: "search_code",
    description: "Search all attached files for a literal substring and return matching lines with line numbers.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Literal text to search for (case-insensitive)." },
      },
      required: ["query"],
    },
  },
  run: (args, ctx) => {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return { ok: false, data: { error: "A search query is required." } };

    const needle = query.toLowerCase();
    const matches: Array<{ path: string; line: number; text: string }> = [];

    for (const artifact of ctx.artifacts) {
      const lines = artifact.content.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < 30; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({ path: artifact.path, line: i + 1, text: lines[i].trim().slice(0, 160) });
        }
      }
    }

    return { ok: true, data: { query, matchCount: matches.length, matches } };
  },
};

export const TOOLS: ToolImpl[] = [listFiles, readFile, analyzeCode, parseTrace, findSymbol, searchCode];

export const TOOL_DEFS: AiToolDef[] = TOOLS.map((t) => t.def);

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.def.name, t]));

/** Execute a tool by name. Never throws — errors become results the model can read and recover from. */
export async function runTool(
  name: string,
  args: ToolArgs,
  ctx: ToolContext,
): Promise<{ ok: boolean; text: string }> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) {
    const available = TOOLS.map((t) => t.def.name).join(", ");
    return { ok: false, text: JSON.stringify({ error: `Unknown tool "${name}". Available: ${available}` }) };
  }

  try {
    const result = await tool.run(args, ctx);
    return { ok: result.ok, text: truncate(JSON.stringify(result.data)) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, text: JSON.stringify({ error: `Tool "${name}" failed: ${message}` }) };
  }
}
