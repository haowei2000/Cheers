/** @file Composer banner that attaches a session pasted from another app (Codex, Claude Code). */

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { contentIconClasses } from "@/components/ui/content-size";
import { EditorialIcon } from "@/components/ui/editorial-icons";
import { ItemList, OperationsItem } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import {
  attachSessionReference,
  resolveSessionReference,
  type SessionReferenceMatch,
} from "@/api/sessionControl";
import type { SessionReference } from "./sessionReference";

export type SessionAttachPhase = "idle" | "resolving" | "choosing" | "attaching";

interface BannerProps {
  reference: SessionReference;
  phase: SessionAttachPhase;
  matches: SessionReferenceMatch[];
  /** The match being attached, while `phase` is "attaching". */
  attachingBotId?: string | null;
  error?: string | null;
  onLookUp: () => void;
  onAttach: (match: SessionReferenceMatch) => void;
  onDismiss: () => void;
}

function headline({ reference, phase, matches }: BannerProps): string {
  if (phase === "resolving") return `Looking up this ${reference.app}…`;
  if (phase === "choosing" || phase === "attaching") {
    return matches.length === 1
      ? `${reference.app} found`
      : `${reference.app} found on ${matches.length} agents`;
  }
  return `${reference.app} link in your draft`;
}

/** Presentational banner; `useSessionAttach` owns the lookup/attach flow. */
export function SessionAttachBanner(props: BannerProps) {
  const { reference, phase, matches, attachingBotId, error, onLookUp, onAttach, onDismiss } = props;
  const busy = phase === "resolving" || phase === "attaching";
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-2 max-md:px-3">
      <section
        className="rounded-sm bg-panel px-3 py-2 shadow-2xs"
        aria-label={`Attach ${reference.app}`}
      >
        <div className="flex min-h-9 items-center gap-2">
          <EditorialIcon name="session" className="shrink-0 text-content-strong" />
          <p className="min-w-0 flex-1 truncate font-utility text-compact font-medium text-content-strong">
            {headline(props)}
          </p>
          {phase === "idle" && (
            <Button
              action="lookup"
              variant="secondary"
              content="text"
              controlSize="compact"
              type="button"
              onClick={onLookUp}
              aria-label={`Look up ${reference.app}`}
            />
          )}
          {phase === "resolving" && <Spinner className="shrink-0 text-content-muted" />}
          <Button
            action="dismiss"
            variant="plain"
            content="icon"
            controlSize="compact"
            type="button"
            onClick={onDismiss}
            disabled={phase === "attaching"}
            aria-label={`Dismiss ${reference.app} link`}
            title="Dismiss"
            className="shrink-0"
          >
            <X className={contentIconClasses.regular} />
          </Button>
        </div>
        {error && (
          <p role="alert" className="font-utility text-compact text-danger-400">
            {error}
          </p>
        )}
        {matches.length > 0 && (
          <ItemList presentationLevel="medium" controlSize="regular" aria-label="Matching sessions">
            {matches.map((match) => {
              const agent = match.display_name || match.username;
              const where = match.device_name ? `${agent} on ${match.device_name}` : agent;
              const title = match.session.title || match.session.session_id;
              return (
                <OperationsItem
                  key={match.bot_id}
                  title={title}
                  subtitle={`${where} · ${match.session.cwd}`}
                  criticalStatus={
                    match.session.cwd_allowed ? undefined : (
                      <span
                        className="shrink-0 font-utility text-compact text-warning-400"
                        title={match.session.cwd_error ?? undefined}
                      >
                        Folder not allowed
                      </span>
                    )
                  }
                  actions={
                    <Button
                      action="attach"
                      variant="primary"
                      content="text"
                      controlSize="compact"
                      type="button"
                      onClick={() => onAttach(match)}
                      loading={phase === "attaching" && attachingBotId === match.bot_id}
                      disabled={busy || !match.session.cwd_allowed}
                      aria-label={`Attach ${title} through ${where}`}
                    />
                  }
                />
              );
            })}
          </ItemList>
        )}
      </section>
    </div>
  );
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Lookup → choose → attach for one pasted reference. The flow resets whenever
 * the reference changes, so editing the link never attaches a stale match.
 */
export function useSessionAttach({
  channelId,
  reference,
  onAttached,
}: {
  channelId: string;
  reference: SessionReference | null;
  onAttached: (sessionId: string, botId: string, reference: SessionReference) => void;
}) {
  const [phase, setPhase] = useState<SessionAttachPhase>("idle");
  const [matches, setMatches] = useState<SessionReferenceMatch[]>([]);
  const [attachingBotId, setAttachingBotId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const raw = reference?.raw ?? null;

  useEffect(() => {
    setPhase("idle");
    setMatches([]);
    setAttachingBotId(null);
    setError(null);
  }, [channelId, raw]);

  const lookUp = useCallback(async () => {
    if (!raw) return;
    setPhase("resolving");
    setError(null);
    try {
      const { matches: found } = await resolveSessionReference(channelId, raw);
      setMatches(found);
      setPhase(found.length > 0 ? "choosing" : "idle");
      if (found.length === 0) setError("No connected agent has this session.");
    } catch (cause) {
      setPhase("idle");
      setError(errorText(cause, "Could not look up this session."));
    }
  }, [channelId, raw]);

  const attach = useCallback(
    async (match: SessionReferenceMatch) => {
      if (!reference) return;
      setPhase("attaching");
      setAttachingBotId(match.bot_id);
      setError(null);
      try {
        const attached = await attachSessionReference(channelId, match.bot_id, reference.raw);
        onAttached(attached.session_id, match.bot_id, reference);
      } catch (cause) {
        setPhase("choosing");
        setError(errorText(cause, "Could not attach this session."));
      } finally {
        setAttachingBotId(null);
      }
    },
    [channelId, reference, onAttached]
  );

  return { phase, matches, attachingBotId, error, lookUp, attach };
}
