export interface Finding {
  rule: string;
  severity: "high" | "medium" | "low";
  line: number;
  message: string;
  snippet: string;
}

interface Rule {
  id: string;
  severity: Finding["severity"];
  languages: string[];
  test: RegExp;
  message: string;
  /** Optional guard to suppress obvious false positives. */
  unless?: RegExp;
}

/**
 * Heuristic bug patterns. This is deliberately a small, high-signal rule set
 * rather than a real linter: its job is to give the model concrete, line-level
 * evidence to reason about, not to be exhaustive. Every finding is presented to
 * the model as a *hint*, and the system prompt tells it to verify against the
 * actual source before drawing conclusions.
 */
const RULES: Rule[] = [
  // --- JavaScript / TypeScript ---
  {
    id: "js/loose-equality",
    severity: "low",
    languages: ["javascript", "typescript"],
    test: /[^=!<>]==[^=]|[^!]!=[^=]/,
    message: "Loose equality (== / !=) performs type coercion; `null == undefined` is true and `0 == ''` is true.",
  },
  {
    id: "js/assignment-in-condition",
    severity: "high",
    languages: ["javascript", "typescript"],
    test: /\b(?:if|while)\s*\([^)]*[^=!<>]=[^=][^)]*\)/,
    message: "Assignment inside a condition. `if (x = y)` assigns and is almost always a typo for `===`.",
  },
  {
    id: "js/off-by-one-loop",
    severity: "high",
    languages: ["javascript", "typescript"],
    test: /for\s*\([^;]*;\s*\w+\s*<=\s*[\w.]+\.length\s*;/,
    message: "Loop runs to `<= length`, one past the last valid index. Use `<`.",
  },
  {
    id: "js/for-in-array",
    severity: "medium",
    languages: ["javascript", "typescript"],
    test: /for\s*\(\s*(?:const|let|var)\s+\w+\s+in\s+/,
    message: "`for...in` iterates keys as strings and includes inherited properties. Use `for...of` or `.forEach` for arrays.",
  },
  {
    id: "js/unawaited-promise",
    severity: "high",
    languages: ["javascript", "typescript"],
    test: /^\s*(?:(?:const|let|var)\s+\w+\s*=\s*)?[\w.]+\.(?:then|catch)\s*\(/,
    message: "Promise chain without a `.catch` or `await` nearby — rejections here become unhandled.",
    unless: /\.catch\s*\(/,
  },
  {
    id: "js/missing-await",
    severity: "high",
    languages: ["javascript", "typescript"],
    test: /(?:const|let|var)\s+\w+\s*=\s*(?!await\b)(?:fetch|[\w.]*(?:Async|Promise))\s*\(/,
    message: "Call looks asynchronous but the result is not awaited — the variable will hold a Promise, not a value.",
  },
  {
    id: "js/json-parse-unguarded",
    severity: "medium",
    languages: ["javascript", "typescript"],
    test: /JSON\.parse\s*\(/,
    message: "`JSON.parse` throws on malformed input. Wrap in try/catch if the source is untrusted.",
  },
  {
    id: "js/switch-fallthrough",
    severity: "medium",
    languages: ["javascript", "typescript"],
    test: /^\s*case\s+.+:\s*(?!\s*(?:\/\/|$))(?!.*\b(?:break|return|throw|continue)\b).+$/,
    message: "`case` body with no `break`/`return` falls through to the next case.",
  },
  {
    id: "js/var-in-loop",
    severity: "medium",
    languages: ["javascript"],
    test: /for\s*\(\s*var\s+\w+/,
    message: "`var` is function-scoped; closures created in this loop all capture the final value. Use `let`.",
  },
  {
    id: "js/array-mutation-during-iteration",
    severity: "high",
    languages: ["javascript", "typescript"],
    test: /\.forEach\s*\([^)]*\)\s*(?:=>|\{)[\s\S]{0,80}?\.(?:splice|shift|pop)\s*\(/,
    message: "Mutating an array while iterating it skips elements.",
  },

  // --- Python ---
  {
    id: "py/mutable-default-arg",
    severity: "high",
    languages: ["python"],
    test: /def\s+\w+\s*\([^)]*=\s*(?:\[\s*\]|\{\s*\}|set\s*\(\s*\))/,
    message: "Mutable default argument is created once at definition time and shared across every call.",
  },
  {
    id: "py/bare-except",
    severity: "medium",
    languages: ["python"],
    test: /^\s*except\s*:\s*$/,
    message: "Bare `except:` swallows KeyboardInterrupt and SystemExit, and hides the real error.",
  },
  {
    id: "py/identity-vs-equality",
    severity: "medium",
    languages: ["python"],
    test: /[^!<>=]==\s*(?:None|True|False)\b/,
    message: "Compare singletons with `is` / `is not`, not `==`.",
  },
  {
    id: "py/range-off-by-one",
    severity: "high",
    languages: ["python"],
    test: /range\s*\(\s*len\s*\([^)]*\)\s*\+\s*1\s*\)/,
    message: "`range(len(x) + 1)` runs one index past the end of the sequence.",
  },
  {
    id: "py/index-off-by-one",
    severity: "high",
    languages: ["python"],
    test: /\[\s*len\s*\([^)]*\)\s*\]/,
    message: "Indexing at `len(x)` is always out of range; the last index is `len(x) - 1`.",
  },

  // --- Language agnostic ---
  {
    id: "any/division-unguarded",
    severity: "medium",
    languages: ["javascript", "typescript", "python", "java"],
    test: /\/\s*(?:len\s*\(|[\w.]+\.length\b|\w+_count\b|\bcount\b)/,
    message: "Division by a length/count that can be zero.",
  },
  {
    id: "any/todo-marker",
    severity: "low",
    languages: ["javascript", "typescript", "python", "java"],
    test: /\b(?:TODO|FIXME|XXX|HACK)\b/,
    message: "Unfinished-work marker left in the code.",
  },
];

function stripComments(line: string, language: string): string {
  if (language === "python") return line.replace(/#.*$/, "");
  return line.replace(/\/\/.*$/, "");
}

export function analyzeSource(content: string, language: string): Finding[] {
  const lang = normalizeLanguage(language);
  const lines = content.split(/\r?\n/);
  const findings: Finding[] = [];

  for (const rule of RULES) {
    if (!rule.languages.includes(lang)) continue;

    for (let i = 0; i < lines.length; i++) {
      const original = lines[i];
      const code = stripComments(original, lang);
      // TODO markers are the one rule that should look inside comments.
      const subject = rule.id === "any/todo-marker" ? original : code;
      if (!subject.trim()) continue;
      if (!rule.test.test(subject)) continue;
      if (rule.unless && rule.unless.test(subject)) continue;

      findings.push({
        rule: rule.id,
        severity: rule.severity,
        line: i + 1,
        message: rule.message,
        snippet: original.trim().slice(0, 200),
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
  return findings.slice(0, 40);
}

export function normalizeLanguage(language: string): string {
  const l = (language || "").toLowerCase();
  if (["js", "jsx", "mjs", "cjs", "javascript"].includes(l)) return "javascript";
  if (["ts", "tsx", "typescript"].includes(l)) return "typescript";
  if (["py", "python", "python3"].includes(l)) return "python";
  if (["java"].includes(l)) return "java";
  return l || "unknown";
}

export function languageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    java: "java",
    go: "go",
    rb: "ruby",
    rs: "rust",
  };
  return map[ext] ?? "unknown";
}
