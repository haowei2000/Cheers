/* WorkspaceRail — narrow vertical strip on the far-left showing every
 * workspace as a clickable tile. Discord/Slack-style.
 *
 * The Personal workspace (kind === "personal") pins to the top with a
 * distinct circular tile — that's where DMs live. Team workspaces follow
 * with their letter tiles, and a "+" tile at the bottom opens the
 * create-workspace modal. */
import type { Workspace } from "../types";
import { AvatarVisual } from "./AvatarVisual";

export interface WorkspaceRailProps {
  workspaces: Workspace[];
  selectedWorkspaceId: string;
  onSelect: (workspaceId: string) => void;
  onCreate?: () => void;
}

const WS_LETTER_COLORS = [
  "#5b4bc4",
  "#087f5b",
  "#8a5600",
  "#1d5f9e",
  "#b91c1c",
  "#6d5bd0",
];
const wsColor = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return WS_LETTER_COLORS[h % WS_LETTER_COLORS.length];
};

function Tile({
  label,
  initials,
  color,
  avatarUrl,
  active,
  round,
  title,
  onClick,
}: {
  label: string;
  initials: string;
  color: string;
  avatarUrl?: string | null;
  active: boolean;
  round?: boolean;
  title?: string;
  onClick: () => void;
}) {
  // Keep the tile readable; full workspace names stay in title/tooltips.
  const len = [...initials].length;
  const fontSize = len === 2 ? 13 : 14;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      className="an-wsr-tile"
      data-active={active ? "1" : undefined}
      style={{
        background: color,
        borderRadius: round ? 999 : 12,
        fontSize,
      }}
    >
      <AvatarVisual
        avatarUrl={avatarUrl}
        background="transparent"
        className={avatarUrl ? "an-wsr-img" : ""}
        fallback={initials}
        label={label}
        radius={round ? 999 : 12}
        size={40}
      />
    </button>
  );
}

export function WorkspaceRail({
  workspaces,
  selectedWorkspaceId,
  onSelect,
  onCreate,
}: WorkspaceRailProps) {
  const personal = workspaces.find((w) => w.kind === "personal");
  const teams = workspaces.filter((w) => w.kind !== "personal");

  return (
    <aside className="an-wsr">
      {personal && (
        <>
          <Tile
            label={personal.name}
            initials="P"
            color="var(--accent)"
            avatarUrl={personal.avatar_url}
            active={selectedWorkspaceId === personal.workspace_id}
            round
            title={`${personal.name} · DMs`}
            onClick={() => onSelect(personal.workspace_id)}
          />
          <div className="an-wsr-sep" />
        </>
      )}
      {teams.map((w) => {
        // Pick up to the first 2 visually meaningful chars from the name.
        // Trim whitespace so " AgentNexus " doesn't render as " A".
        const trimmed = w.name.trim();
        const initials = [...trimmed].slice(0, 2).join("").toUpperCase();
        return (
          <Tile
            key={w.workspace_id}
            label={w.name}
            initials={initials || "?"}
            color={wsColor(w.workspace_id)}
            avatarUrl={w.avatar_url}
            active={selectedWorkspaceId === w.workspace_id}
            title={w.name}
            onClick={() => onSelect(w.workspace_id)}
          />
        );
      })}
      {onCreate && (
        <button
          type="button"
          className="an-wsr-tile an-wsr-add"
          onClick={onCreate}
          title="Create workspace"
          aria-label="Create workspace"
        >
          +
        </button>
      )}
    </aside>
  );
}
