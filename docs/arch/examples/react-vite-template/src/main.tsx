import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { connect, type Assignment, type Host } from "./cheers";
import "./styles.css";

/** `- [ ] task` / `- [x] task`, capturing the bullet prefix so a rewrite preserves
 *  indentation and bullet style byte-for-byte. */
const TASK = /^(\s*[-*]\s+)\[([ xX])\]\s+(.*)$/;

interface Line {
  raw: string;
  task: { prefix: string; done: boolean; text: string } | null;
}

const parse = (content: string): Line[] =>
  content.split("\n").map((raw) => {
    const m = raw.match(TASK);
    return m
      ? { raw, task: { prefix: m[1], done: m[2].toLowerCase() === "x", text: m[3] } }
      : { raw, task: null };
  });

/** Rewrite ONLY the task lines; every other line survives untouched. This is the core
 *  courtesy of a markdown renderer — the file stays something a human and a bot can both
 *  keep editing by hand. */
const serialize = (lines: Line[]): string =>
  lines
    .map((l) => (l.task ? `${l.task.prefix}[${l.task.done ? "x" : " "}] ${l.task.text}` : l.raw))
    .join("\n");

function Checklist({ host, file }: { host: Host; file: Assignment }) {
  const [lines, setLines] = useState<Line[]>(() => parse(file.content));
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  // A fresh assignment (first render, or the re-render after a conflicted save) replaces
  // local state wholesale — the host's content is always the truth.
  useEffect(() => setLines(parse(file.content)), [file]);

  const toggle = useCallback(
    (index: number) => {
      const next = lines.map((l, i) =>
        i === index && l.task ? { ...l, task: { ...l.task, done: !l.task.done } } : l
      );
      setLines(next);
      setSaving(true);
      host
        .save(serialize(next))
        .then((r) => setStatus(`saved v${r.version}`))
        .catch((e: Error) => setStatus(e.message))
        .finally(() => setSaving(false));
    },
    [lines, host]
  );

  const tasks = lines.filter((l) => l.task);
  const done = tasks.filter((l) => l.task!.done).length;

  return (
    <div className="wrap">
      <div className="rows">
        {lines.map((l, i) =>
          l.task ? (
            <label className="task" key={i}>
              <input
                type="checkbox"
                checked={l.task.done}
                disabled={saving}
                onChange={() => toggle(i)}
              />
              {/* React escapes by default — untrusted content never becomes markup. */}
              <span className={l.task.done ? "done" : undefined}>{l.task.text}</span>
            </label>
          ) : (
            <div className="plain" key={i}>
              {l.raw}
            </div>
          )
        )}
      </div>
      <div className="status">
        {done}/{tasks.length} done {status && `· ${status}`}
      </div>
    </div>
  );
}

function App() {
  const [state, setState] = useState<{ host: Host; file: Assignment } | null>(null);

  useEffect(() => {
    // connect() posts cheers:ready for us, after the listener is wired.
    const host = connect((file) => {
      // Runtime verdict: `match` got us shortlisted, but only a real parse can decide.
      if (!file.content.split("\n").some((l) => TASK.test(l))) {
        host.unsupported("no task lines (- [ ] / - [x]) in this file");
        setState(null);
        return;
      }
      setState({ host, file });
    });
  }, []);

  if (!state) return <div className="status">Waiting for the host to assign a file…</div>;
  // Remount on a new assignment so the checklist never mixes two versions of the file.
  return <Checklist key={state.file.version} host={state.host} file={state.file} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
