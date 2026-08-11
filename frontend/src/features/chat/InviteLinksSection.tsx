import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Copy, Link2, Trash2 } from "lucide-react";
import {
  createInviteLink,
  inviteUrl,
  listInviteLinks,
  revokeInviteLink,
  type InviteLink,
} from "@/api/invites";
import {
  CollectionDeleteItem,
  CollectionEditorItem,
  CollectionEmptyItem,
  CollectionManager,
  type CollectionMode,
} from "@/components/ui/collection-manager";
import { controlIconClasses } from "@/components/ui/control-size";
import { Field } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { OperationsItem } from "@/components/ui/item";
import { Select } from "@/components/ui/select";

const EXPIRY_OPTIONS = [
  { label: "Expires in 1 day", hours: 24 },
  { label: "Expires in 7 days", hours: 24 * 7 },
  { label: "Expires in 30 days", hours: 24 * 30 },
  { label: "Never expires", hours: "" },
] as const;
const USES_OPTIONS = [
  { label: "Unlimited uses", uses: "" },
  { label: "1 use", uses: 1 },
  { label: "5 uses", uses: 5 },
  { label: "25 uses", uses: 25 },
  { label: "100 uses", uses: 100 },
] as const;

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  toast.success("Invite link copied");
}

function linkTitle(link: InviteLink, channelScoped: boolean): string {
  if (link.channel_name && !channelScoped) return `Invite to #${link.channel_name}`;
  return channelScoped ? "Channel invite link" : "Workspace invite link";
}

export function InviteLinksSection({
  workspaceId,
  channelId,
}: {
  workspaceId: string;
  channelId?: string;
}) {
  const [links, setLinks] = useState<InviteLink[]>([]);
  const [allowed, setAllowed] = useState(true);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<CollectionMode>({ kind: "browse" });
  const [expiry, setExpiry] = useState(String(24 * 7));
  const [uses, setUses] = useState("");
  const [saving, setSaving] = useState(false);

  async function refresh() {
    try {
      const all = await listInviteLinks(workspaceId);
      setLinks(channelId ? all.filter((link) => link.channel_id === channelId) : all);
      setAllowed(true);
    } catch {
      setAllowed(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [workspaceId, channelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleLinks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return links;
    return links.filter((link) => (
      `${linkTitle(link, Boolean(channelId))} ${link.status} ${link.channel_name ?? ""} ${link.token}`
        .toLocaleLowerCase()
        .includes(normalized)
    ));
  }, [channelId, links, query]);

  const cancel = () => setMode({ kind: "browse" });
  const beginAdd = () => {
    setExpiry(String(24 * 7));
    setUses("");
    setMode({ kind: "add" });
  };

  async function create() {
    setSaving(true);
    try {
      const link = await createInviteLink(workspaceId, {
        expires_in_hours: expiry === "" ? null : Number(expiry),
        max_uses: uses === "" ? null : Number(uses),
        channel_id: channelId ?? null,
      });
      await copyToClipboard(inviteUrl(link.token));
      await refresh();
      setMode({ kind: "browse" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create link");
    } finally {
      setSaving(false);
    }
  }

  async function revoke(link: InviteLink) {
    setSaving(true);
    try {
      await revokeInviteLink(workspaceId, link.link_id);
      toast.success("Invite link revoked");
      await refresh();
      setMode({ kind: "browse" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revoke");
    } finally {
      setSaving(false);
    }
  }

  if (!allowed) return null;

  return (
    <section className="border-t border-zinc-800 pt-3">
      <CollectionManager
        label="Links"
        count={links.length}
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder="Search invite links"
        addLabel="Add link"
        onAdd={beginAdd}
        addDisabled={mode.kind !== "browse"}
      >
        {mode.kind === "add" && (
          <CollectionEditorItem
            mode="add"
            title="Add invite link"
            onCancel={cancel}
            onSave={() => void create()}
            saveLabel="Create link"
            saving={saving}
          >
            <Field label="Expiry">
              <Select controlSize="regular" value={expiry} onChange={(event) => setExpiry(event.target.value)}>
                {EXPIRY_OPTIONS.map((option) => (
                  <option key={option.label} value={String(option.hours)}>{option.label}</option>
                ))}
              </Select>
            </Field>
            <Field label="Uses">
              <Select controlSize="regular" value={uses} onChange={(event) => setUses(event.target.value)}>
                {USES_OPTIONS.map((option) => (
                  <option key={option.label} value={String(option.uses)}>{option.label}</option>
                ))}
              </Select>
            </Field>
          </CollectionEditorItem>
        )}

        {visibleLinks.map((link) => {
          if (mode.kind === "delete" && mode.id === link.link_id) {
            return (
              <CollectionDeleteItem
                key={link.link_id}
                title={`Revoke ${linkTitle(link, Boolean(channelId))}?`}
                description="The invite URL will stop working immediately."
                onCancel={cancel}
                onConfirm={() => void revoke(link)}
                deleting={saving}
              />
            );
          }
          const inactive = link.status !== "active";
          return (
            <OperationsItem
              key={link.link_id}
              presentationLevel="medium"
              controlSize="regular"
              leading={<Link2 className={controlIconClasses.regular} />}
              title={linkTitle(link, Boolean(channelId))}
              status={inactive ? undefined : (
                <span className="font-utility text-xs uppercase tracking-wide text-zinc-500">Active</span>
              )}
              criticalStatus={inactive ? (
                <span className="font-utility text-xs font-semibold uppercase tracking-wide text-amber-400">
                  {link.status === "expired" ? "Expired" : "Used up"}
                </span>
              ) : undefined}
              actions={(
                <>
                  {!inactive && (
                    <IconButton
                      label="Copy invite link"
                      controlSize="compact"
                      onClick={() => void copyToClipboard(inviteUrl(link.token))}
                    >
                      <Copy className={controlIconClasses.compact} />
                    </IconButton>
                  )}
                  <IconButton
                    label="Revoke invite link"
                    tone="danger"
                    controlSize="compact"
                    onClick={() => setMode({ kind: "delete", id: link.link_id })}
                  >
                    <Trash2 className={controlIconClasses.compact} />
                  </IconButton>
                </>
              )}
            />
          );
        })}

        {visibleLinks.length === 0 && mode.kind !== "add" && (
          <CollectionEmptyItem
            query={query}
            onClear={() => setQuery("")}
          />
        )}
      </CollectionManager>
    </section>
  );
}
