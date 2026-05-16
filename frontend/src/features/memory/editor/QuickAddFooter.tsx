import { useState } from "react";
import { getAuthToken as getStoredToken } from "../../../api";

const API = "/api/v1";

export function QuickAddFooter({
  channelId,
  layer,
  onAdded,
}: {
  channelId: string;
  layer: string;
  onAdded: () => void;
}) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const text = v.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const token = getStoredToken();
      const res = await fetch(`${API}/channels/${channelId}/memory/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ layer, title: null, content: text }),
      });
      if (res.ok) {
        setV("");
        onAdded();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex items-center gap-2 flex-shrink-0"
      style={{
        padding: "10px 14px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-1)",
      }}
    >
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            setV("");
          }
        }}
        placeholder="Teach the agents..."
        disabled={busy}
        className="an-input"
        style={{
          flex: 1,
          fontSize: 12,
          padding: "0 10px",
          height: 28,
          lineHeight: "28px",
        }}
      />
      <button
        type="button"
        onClick={submit}
        disabled={!v.trim() || busy}
        className="an-btn an-btn-sm"
        title="Save as a new entry (Enter also works)"
        style={{ height: 28, padding: "0 12px", flexShrink: 0 }}
      >
        {busy ? "..." : "Save"}
      </button>
    </div>
  );
}
