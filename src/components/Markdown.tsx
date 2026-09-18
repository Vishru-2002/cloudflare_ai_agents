import { Fragment, type ReactNode } from "react";

/**
 * A deliberately small Markdown renderer for assistant replies.
 *
 * It builds React elements rather than HTML strings, so model output can never
 * inject markup — and it avoids pulling a Markdown library plus a sanitiser
 * into the bundle for the handful of constructs the agent actually emits.
 */

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Inline code, then bold. Order matters: code spans win.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    if (match[1]) {
      nodes.push(<code key={`${keyPrefix}-c${i++}`}>{match[1].slice(1, -1)}</code>);
    } else if (match[2]) {
      nodes.push(<strong key={`${keyPrefix}-b${i++}`}>{match[2].slice(2, -2)}</strong>);
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export default function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre key={key++} className="md-code">
          {lang && <span className="md-code-lang">{lang}</span>}
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Heading
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = (["h3", "h4", "h5", "h5"] as const)[level - 1];
      blocks.push(<Tag key={key++}>{renderInline(heading[2], `h${key}`)}</Tag>);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        body.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={key++}>{renderInline(body.join(" "), `q${key}`)}</blockquote>,
      );
      continue;
    }

    // List
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `l${key}-${idx}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Paragraph
    if (line.trim() === "") {
      i++;
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trimStart().startsWith("```") &&
      !lines[i].startsWith(">") &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^#{1,4}\s+/.test(lines[i])
    ) {
      paragraph.push(lines[i]);
      i++;
    }
    blocks.push(<p key={key++}>{renderInline(paragraph.join(" "), `p${key}`)}</p>);
  }

  return <Fragment>{blocks}</Fragment>;
}
