/** Renders a unified diff with per-line colouring. */
export default function Diff({ diff }: { diff: string }) {
  const lines = diff.split("\n");

  return (
    <pre className="diff">
      {lines.map((line, i) => {
        let cls = "diff-ctx";
        if (line.startsWith("+++") || line.startsWith("---")) cls = "diff-meta";
        else if (line.startsWith("@@")) cls = "diff-hunk";
        else if (line.startsWith("+")) cls = "diff-add";
        else if (line.startsWith("-")) cls = "diff-del";

        return (
          <div key={i} className={`diff-line ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
