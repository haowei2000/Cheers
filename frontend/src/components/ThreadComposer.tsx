/* ThreadComposer — shared composer for the thread side-panel and the
 * full-page thread view.
 *
 * Matches the main channel composer's visible capabilities that apply to
 * threads: multi-line auto-grow textarea, Enter-to-send / Shift-Enter for
 * newline, and a mention dropdown over channel users + bots.
 *
 * Not yet wired: file upload, secret mode, explicit reply-quote (thread
 * replies are already implicitly scoped to the thread root, so per-reply
 * replying inside a thread is low value right now). */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChannelBot, ChannelUser } from "../types";

export interface ThreadComposerProps {
  placeholder: string;
  channelBots: ChannelBot[];
  channelUsers: ChannelUser[];
  onSend: (text: string) => Promise<void> | void;
  /** Optional hint shown under the composer. */
  hint?: React.ReactNode;
}

type MentionTarget = {
  id: string;
  username: string;
  label: string;
  kind: "bot" | "user";
};

export function ThreadComposer({
  placeholder,
  channelBots,
  channelUsers,
  onSend,
  hint,
}: ThreadComposerProps) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const [mention, setMention] = useState<{
    filter: string;
    start: number;
  } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const candidates = useMemo<MentionTarget[]>(
    () => [
      ...channelBots.map((b) => ({
        id: b.member_id,
        username: b.username,
        label: b.display_name || b.username,
        kind: "bot" as const,
      })),
      ...channelUsers.map((u) => ({
        id: u.member_id,
        username: u.username,
        label: u.display_name || u.username,
        kind: "user" as const,
      })),
    ],
    [channelBots, channelUsers],
  );

  const filtered = useMemo(() => {
    if (!mention) return [] as MentionTarget[];
    const f = mention.filter.toLowerCase();
    if (!f) return candidates.slice(0, 8);
    return candidates
      .filter(
        (c) =>
          c.username.toLowerCase().includes(f) ||
          c.label.toLowerCase().includes(f),
      )
      .slice(0, 8);
  }, [mention, candidates]);

  useEffect(() => {
    if (filtered.length === 0) setMentionIdx(0);
    else if (mentionIdx >= filtered.length) setMentionIdx(filtered.length - 1);
  }, [filtered, mentionIdx]);

  const submit = async () => {
    const text = v.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await onSend(text);
      setV("");
      setMention(null);
    } finally {
      setBusy(false);
    }
  };

  const pickMention = (target: MentionTarget) => {
    if (!mention) return;
    const before = v.slice(0, mention.start);
    const after = v.slice(ref.current?.selectionStart ?? v.length);
    const inserted = `@${target.username} `;
    const next = before + inserted + after;
    setV(next);
    setMention(null);
    const caret = (before + inserted).length;
    setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    }, 0);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const s = e.target.value;
    setV(s);
    const pos = e.target.selectionStart;
    const upto = s.slice(0, pos);
    const m = /@(\w*)$/.exec(upto);
    setMention(m ? { filter: m[1], start: pos - m[0].length } : null);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx(
          (i) => (i - 1 + filtered.length) % filtered.length,
        );
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        pickMention(filtered[mentionIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Auto-grow: target 1–6 visible lines, cap at 180px like the main composer.
  const rows = Math.max(1, Math.min(6, v.split("\n").length));
  const minH = 40;
  const maxH = 180;
  const measuredH = Math.min(maxH, Math.max(minH, rows * 22 + 18));

  return (
    <div style={{ position: "relative" }}>
      <div
        className="an-composer"
        style={{ borderRadius: 10, padding: 0 }}
      >
        <textarea
          ref={ref}
          value={v}
          onChange={handleChange}
          onKeyDown={handleKey}
          placeholder={placeholder}
          rows={1}
          className="an-composer-textarea"
          style={{
            height: measuredH,
            minHeight: minH,
            paddingTop: 10,
            paddingBottom: 6,
            fontSize: 13,
            lineHeight: 1.5,
          }}
          disabled={busy}
        />
        <div className="an-composer-bar">
          <div className="an-composer-hint">
            {hint ?? (
              <>
                <kbd>@</kbd> 提及 · <kbd>↵</kbd> 发送 · <kbd>⇧↵</kbd> 换行
              </>
            )}
          </div>
          <button
            type="button"
            className="an-composer-send"
            onClick={submit}
            disabled={!v.trim() || busy}
          >
            {busy ? "发送中…" : "回复"}
          </button>
        </div>
      </div>
      {mention && filtered.length > 0 && (
        <ul
          className="an-menu"
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 8,
            right: 8,
            zIndex: 50,
            maxHeight: 220,
            overflowY: "auto",
            listStyle: "none",
            margin: 0,
          }}
          role="listbox"
        >
          <li
            className="an-menu-head"
            style={{ listStyle: "none" }}
          >
            @提及 · {filtered.length} 项
          </li>
          {filtered.map((c, i) => (
            <li
              key={`${c.kind}:${c.id}`}
              role="option"
              className={"an-menu-item" + (i === mentionIdx ? " active" : "")}
              style={{ listStyle: "none" }}
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(c);
              }}
              onMouseEnter={() => setMentionIdx(i)}
            >
              <span
                className="an-mi-ico"
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: c.kind === "bot" ? 6 : 999,
                  background:
                    c.kind === "bot" ? "var(--green)" : "var(--accent)",
                  color: "#fff",
                  fontSize: 10,
                  fontWeight: 700,
                  display: "inline-grid",
                  placeItems: "center",
                }}
              >
                {(c.label || c.username).slice(0, 1).toUpperCase()}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ color: "var(--fg-1)", fontWeight: 500 }}>
                  @{c.username}
                </span>
                {c.label !== c.username && (
                  <span
                    className="an-mi-sub"
                    style={{ color: "var(--fg-3)", fontSize: 11 }}
                  >
                    {c.label}
                  </span>
                )}
              </span>
              <span
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: "0.7px",
                  color:
                    c.kind === "bot" ? "var(--green)" : "var(--accent)",
                  textTransform: "uppercase",
                }}
              >
                {c.kind === "bot" ? "bot" : "user"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
