import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { ChevronDown, Copy, Hash, Link2, X } from "lucide-react";
import {
  createInviteLink,
  inviteUrl,
  listInviteLinks,
  revokeInviteLink,
  type InviteLink,
} from "@/api/invites";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ItemSection, OperationsItem } from "@/components/ui/item";
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

function shortDate(timestamp: string | null): string | null {
  if (!timestamp) return null;
  let iso = timestamp.replace(" ", "T");
  if (/[+-]\d{2}$/.test(iso)) iso = `${iso}:00`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
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
  const [expiry, setExpiry] = useState(String(24 * 7));
  const [uses, setUses] = useState("");
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(true);

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

  async function create() {
    setCreating(true);
    try {
      const link = await createInviteLink(workspaceId, {
        expires_in_hours: expiry === "" ? null : Number(expiry),
        max_uses: uses === "" ? null : Number(uses),
        channel_id: channelId ?? null,
      });
      await copyToClipboard(inviteUrl(link.token));
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create link");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(link: InviteLink) {
    try {
      await revokeInviteLink(workspaceId, link.link_id);
      toast.success("Invite link revoked");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revoke");
    }
  }

  if (!allowed) return null;

  const activeCount = links.filter((link) => link.status === "active").length;

  return (
    <section>
      <ItemSection label="Links" controlSize="regular">
        <div role="listitem">
          <OperationsItem
            presentationLevel="max"
            controlSize="comfortable"
            leading={<Link2 className="h-4 w-4 text-zinc-400" />}
            title="Create invite link"
            subtitle={`Anyone with a link can join${channelId ? " and lands in this channel" : ""}.`}
            metadata="No account is required. Revoke a link to stop it working."
            criticalStatus={
              <span className="font-utility text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                {activeCount} active
              </span>
            }
            trailing={
              <ChevronDown
                className={`h-4 w-4 text-zinc-500 transition-transform ${createOpen ? "rotate-180" : ""}`}
              />
            }
            className={createOpen ? "border-l-zinc-200 bg-zinc-900 text-zinc-100" : undefined}
            aria-expanded={createOpen}
            onClick={() => setCreateOpen((value) => !value)}
          />

          {createOpen && (
            <div className="border-b border-zinc-800/90 px-2 py-3">
              <fieldset className="flex flex-col gap-2 sm:flex-row sm:items-end" aria-label="Create invite link">
                <label className="min-w-0 flex-1 font-utility text-xs text-zinc-400">
                  Expiry
                  <Select value={expiry} onChange={(event) => setExpiry(event.target.value)} className="mt-1">
                    {EXPIRY_OPTIONS.map((option) => (
                      <option key={option.label} value={String(option.hours)}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="min-w-0 flex-1 font-utility text-xs text-zinc-400">
                  Uses
                  <Select value={uses} onChange={(event) => setUses(event.target.value)} className="mt-1">
                    {USES_OPTIONS.map((option) => (
                      <option key={option.label} value={String(option.uses)}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </label>
                <Button controlSize="regular" loading={creating} onClick={() => void create()}>
                  <Link2 className="h-4 w-4" />
                  Create link
                </Button>
              </fieldset>
            </div>
          )}
        </div>

        {links.length === 0 ? (
          <OperationsItem
            controlSize="regular"
            leading={<Link2 className="h-4 w-4 text-zinc-500" />}
            title="No invite links yet"
            subtitle="Create a bounded link when someone needs access."
          />
        ) : (
          links.map((link) => {
            const dead = link.status !== "active";
            const expiryText = link.expires_at
              ? `Expires ${shortDate(link.expires_at) ?? link.expires_at.slice(0, 10)}`
              : "Never expires";
            const useText = `${link.use_count}${link.max_uses != null ? `/${link.max_uses}` : ""} used`;
            return (
              <OperationsItem
                key={link.link_id}
                presentationLevel="max"
                controlSize="regular"
                leading={<Link2 className="h-4 w-4 text-zinc-500" />}
                title={
                  <span className="block max-w-full truncate font-mono text-xs">
                    {inviteUrl(link.token)}
                  </span>
                }
                subtitle={
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    {link.channel_name && !channelId && (
                      <span className="inline-flex min-w-0 items-center gap-0.5 truncate">
                        <Hash className="h-3 w-3 shrink-0" />
                        {link.channel_name}
                      </span>
                    )}
                    <span>{useText}</span>
                  </span>
                }
                metadata={expiryText}
                criticalStatus={
                  dead ? (
                    <span className="font-utility text-[10px] font-semibold uppercase tracking-wide text-amber-400">
                      {link.status === "expired" ? "Expired" : "Used up"}
                    </span>
                  ) : undefined
                }
                actions={
                  <>
                    {!dead && (
                      <IconButton
                        label="Copy invite link"
                        controlSize="compact"
                        onClick={() => void copyToClipboard(inviteUrl(link.token))}
                      >
                        <Copy className="h-4 w-4" />
                      </IconButton>
                    )}
                    <IconButton
                      label="Revoke invite link"
                      tone="danger"
                      controlSize="compact"
                      onClick={() => void revoke(link)}
                    >
                      <X className="h-4 w-4" />
                    </IconButton>
                  </>
                }
              />
            );
          })
        )}
      </ItemSection>
    </section>
  );
}
