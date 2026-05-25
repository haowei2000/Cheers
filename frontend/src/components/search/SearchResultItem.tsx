import type { ReactNode } from "react";
import type { SearchSelection } from "../../types";
import { setAgentNexusFileRefs } from "../../lib/file-drag";
import { FileTypeIcon } from "../icons/FileTypeIcon";
import { MemberIdentity } from "../members";
import { SearchHighlight } from "./SearchHighlight";
import { itemKey, labelFor, sigilFor, subFor } from "./searchResultUtils";

export function SearchResultItem({
  selection,
  query,
  action,
  onSelect,
}: {
  selection: SearchSelection;
  query: string;
  action?: ReactNode;
  onSelect: (selection: SearchSelection) => void;
}) {
  const rich =
    selection.type === "file" ||
    selection.type === "message" ||
    selection.type === "todo" ||
    selection.type === "task";
  const sub = subFor(selection);

  if (selection.type === "user" || selection.type === "bot") {
    const label = labelFor(selection);
    return (
      <button
        key={itemKey(selection)}
        type="button"
        className="an-search-hit an-search-member-hit"
        onClick={() => onSelect(selection)}
      >
        <MemberIdentity
          avatarSize={28}
          member={{
            ...selection.item,
            member_type: selection.type,
            member_id:
              selection.type === "user"
                ? selection.item.user_id
                : selection.item.bot_id,
          }}
          kind={selection.type}
          badge={selection.type === "bot" ? undefined : null}
          primary={<SearchHighlight text={label} query={query} />}
          sub={sub}
        />
        {action && <span className="an-search-action">{action}</span>}
      </button>
    );
  }

  return (
    <button
      key={itemKey(selection)}
      type="button"
      draggable={selection.type === "file"}
      onDragStart={
        selection.type === "file"
          ? (event) =>
              setAgentNexusFileRefs(event.dataTransfer, [
                {
                  file_id: selection.item.file_id,
                  original_filename: selection.item.original_filename || undefined,
                  content_type: selection.item.content_type || undefined,
                  size_bytes: selection.item.size_bytes || undefined,
                  status: selection.item.status,
                  channel_id: selection.item.channel_id,
                  channel_label: selection.item.channel_name,
                  scope_type: "channel",
                  scope_id: selection.item.channel_id,
                  summary_3lines: selection.item.snippet,
                  created_at: selection.item.created_at,
                },
              ])
          : undefined
      }
      className={`an-search-hit ${rich ? "is-rich" : ""}`}
      onClick={() => onSelect(selection)}
    >
      {selection.type === "file" ? (
        <span className="an-search-file-ico">
          <FileTypeIcon
            contentType={selection.item.content_type}
            filename={selection.item.original_filename || selection.item.file_id}
            size={18}
          />
        </span>
      ) : (
        <span className="an-search-sigil">{sigilFor(selection.type)}</span>
      )}
      <span className="an-search-main">
        <span className="an-search-name">
          <SearchHighlight text={labelFor(selection)} query={query} />
        </span>
        {sub && <span className="an-search-sub">{sub}</span>}
        {selection.type === "file" && selection.item.snippet && (
          <span className="an-search-meta">
            <SearchHighlight text={selection.item.snippet} query={query} />
          </span>
        )}
        {selection.type === "task" && selection.item.snippet && (
          <span className="an-search-meta">
            <SearchHighlight text={selection.item.snippet} query={query} />
          </span>
        )}
        {selection.type === "message" && (
          <span className="an-search-meta">
            <SearchHighlight text={selection.item.snippet} query={query} />
          </span>
        )}
      </span>
      {action && <span className="an-search-action">{action}</span>}
    </button>
  );
}
