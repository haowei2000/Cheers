// Activity grouping — turns the flat `channel.activity.read` stream (messages ∪
// operations) into EPISODES for the node-rail view. An episode is a causal unit
// of channel history: a human's message (usually @mentioning a bot) plus all the
// bot replies, approvals and file operations that follow it, until the next human
// message. This is what lets the Activity board read as "what happened" instead
// of a firehose of individual rows. Pure/deterministic (no React, no clock) so it
// stays unit-testable and cheap to recompute.

export interface Mention {
  member_id: string;
  member_type: "user" | "bot";
}

export interface MessageData {
  msg_id?: string;
  sender_type?: "user" | "bot";
  sender_id?: string;
  content?: string;
  msg_type?: string;
  mentions?: Mention[];
  file_ids?: string[];
  reply_to_msg_id?: string | null;
  created_at?: string;
}

export interface OperationData {
  op_type?: string;
  actor_type?: "user" | "bot" | "system";
  actor_id?: string | null;
  target_ref?: string | null;
  created_at?: string;
}

export interface ActivityEvent {
  event_type: "message" | "operation";
  channel_seq: number;
  created_at?: string | null;
  data: MessageData & OperationData;
}

/** Normalized event kind — the vocabulary the rail + detail render against. */
export type EventKind =
  | "trigger" // human message that @mentions a bot — opens an episode
  | "user_msg" // human message, no bot mention
  | "bot_msg" // bot message
  | "approval" // permission card (msg_type = "permission")
  | "file" // message carrying file attachments
  | "write" // workspace/fs operation
  | "op"; // any other operation

export interface NormEvent {
  seq: number;
  ts?: string | null;
  kind: EventKind;
  actorId?: string | null;
  actorType?: "user" | "bot" | "system";
  msgId?: string;
  excerpt: string;
  mentions: Mention[];
  fileCount: number;
  opType?: string;
  targetRef?: string | null;
}

export interface EpisodeCounts {
  messages: number;
  approvals: number;
  files: number;
  writes: number;
}

export interface Episode {
  id: string;
  /** The human who triggered it, or null for a bot-initiated / orphan run. */
  triggerActorId?: string | null;
  /** The bot(s) most active in the episode — drives the node marker + color. */
  dominantActorId?: string | null;
  /** Short headline: the trigger message excerpt, else a synthesized label. */
  title: string;
  /** Ordered oldest→newest within the episode. */
  events: NormEvent[];
  participants: Set<string>;
  counts: EpisodeCounts;
  startTs?: string | null;
  endTs?: string | null;
  seqStart: number;
  seqEnd: number;
  /** Best message to jump the chat to (the trigger, else the first message). */
  jumpMsgId?: string;
}

const WRITE_RE = /^(workspace|fs|file)[._]/i;

/** Strip file tags + collapse whitespace to one readable line. */
export function excerpt(content?: string, max = 120): string {
  if (!content) return "";
  const t = content.replace(/<#file:[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Classify one raw event into a NormEvent. `hasBotMention` needs the member map
 *  so a human @bot reads as a "trigger" (episode opener) vs a plain user message. */
function normalize(e: ActivityEvent, isBot: (id?: string | null) => boolean): NormEvent {
  const d = e.data;
  const ts = d.created_at ?? e.created_at ?? null;
  if (e.event_type === "operation") {
    const opType = d.op_type ?? "op";
    return {
      seq: e.channel_seq,
      ts,
      kind: WRITE_RE.test(opType) ? "write" : "op",
      actorId: d.actor_id ?? null,
      actorType: d.actor_type,
      excerpt: "",
      mentions: [],
      fileCount: 0,
      opType,
      targetRef: d.target_ref ?? null,
    };
  }
  const mentions = d.mentions ?? [];
  const fileCount = d.file_ids?.length ?? 0;
  const isUser = d.sender_type === "user";
  const mentionsBot = mentions.some((m) => m.member_type === "bot" || isBot(m.member_id));
  let kind: EventKind;
  if (d.msg_type === "permission") kind = "approval";
  else if (isUser && mentionsBot) kind = "trigger";
  else if (isUser) kind = "user_msg";
  else if (fileCount > 0) kind = "file";
  else kind = "bot_msg";
  return {
    seq: e.channel_seq,
    ts,
    kind,
    actorId: d.sender_id ?? null,
    actorType: d.sender_type,
    msgId: d.msg_id,
    excerpt: excerpt(d.content),
    mentions,
    fileCount,
  };
}

function emptyCounts(): EpisodeCounts {
  return { messages: 0, approvals: 0, files: 0, writes: 0 };
}

/** Group the (any-order) activity stream into episodes, newest episode first.
 *  A human message starts a new episode; consecutive human messages from the
 *  same person with no bot/op activity between them fold into one (a multi-line
 *  ask is one episode, not three). */
export function buildEpisodes(
  events: ActivityEvent[],
  isBot: (id?: string | null) => boolean
): Episode[] {
  // Process oldest→newest so causal order is correct, regardless of input order.
  const asc = [...events].sort((a, b) => a.channel_seq - b.channel_seq);
  const norm = asc.map((e) => normalize(e, isBot));

  const episodes: Episode[] = [];
  let cur: Episode | null = null;
  let sawActivitySinceTrigger = false; // bot/op event since the last human msg?

  const newEpisode = (n: NormEvent, trigger: boolean): Episode => ({
    id: `ep-${n.seq}`,
    triggerActorId: trigger ? n.actorId : null,
    dominantActorId: null,
    title: n.excerpt || "",
    events: [],
    participants: new Set<string>(),
    counts: emptyCounts(),
    startTs: n.ts,
    endTs: n.ts,
    seqStart: n.seq,
    seqEnd: n.seq,
    jumpMsgId: n.msgId,
  });

  for (const n of norm) {
    const isHuman = n.kind === "trigger" || n.kind === "user_msg" || n.actorType === "user";
    if (isHuman) {
      // Fold a follow-up human line into the current episode only if it's the
      // same person and nothing happened since — otherwise open a new episode.
      const sameAsker =
        cur != null &&
        cur.triggerActorId != null &&
        cur.triggerActorId === n.actorId &&
        !sawActivitySinceTrigger;
      if (cur == null || !sameAsker) {
        cur = newEpisode(n, true);
        episodes.push(cur);
        sawActivitySinceTrigger = false;
      }
    } else if (cur == null) {
      // Bot/op with no preceding human message — an orphan (bot-initiated) run.
      cur = newEpisode(n, false);
      episodes.push(cur);
      sawActivitySinceTrigger = false;
    } else {
      sawActivitySinceTrigger = true;
    }

    const ep = cur;
    ep.events.push(n);
    if (n.actorId) ep.participants.add(n.actorId);
    ep.endTs = n.ts;
    ep.seqEnd = n.seq;
    if (!ep.jumpMsgId && n.msgId) ep.jumpMsgId = n.msgId;
    if (n.kind === "approval") ep.counts.approvals += 1;
    else if (n.kind === "write") ep.counts.writes += 1;
    else if (n.kind === "file") ep.counts.files += n.fileCount || 1;
    if (n.kind !== "write" && n.kind !== "op") ep.counts.messages += 1;
  }

  // Dominant actor = the non-human participant with the most events (else trigger).
  for (const ep of episodes) {
    const tally = new Map<string, number>();
    for (const n of ep.events) {
      if (n.actorId && n.actorType !== "user") tally.set(n.actorId, (tally.get(n.actorId) ?? 0) + 1);
    }
    let best: string | null = ep.triggerActorId ?? null;
    let bestN = -1;
    for (const [id, c] of tally) if (c > bestN) ((best = id), (bestN = c));
    ep.dominantActorId = best;
    if (!ep.title) ep.title = ""; // filled by the panel from actor name
  }

  return episodes.reverse(); // newest episode first
}

/** An episode is "notable" (survives the Highlights filter) when it carries a
 *  decision or a durable artifact, not just chatter. */
export function isNotableEpisode(ep: Episode): boolean {
  return ep.counts.approvals > 0 || ep.counts.files > 0 || ep.counts.writes > 0;
}

/** Emphasis for the rail marker: bigger/brighter node for episodes that did
 *  something consequential or ran long. */
export function episodeEmphasis(ep: Episode): boolean {
  return isNotableEpisode(ep) || ep.counts.messages >= 4;
}

// ── burst collapse (the "All" rail) ─────────────────────────────────────────
export interface RailRun {
  key: string;
  kind: EventKind;
  actorId?: string | null;
  count: number;
  sample: string;
  seq: number; // newest seq in the run (rail is newest-first)
  ts?: string | null; // newest timestamp in the run
  episodeId: string;
}

/** Collapse an episode's events into rail runs: consecutive same-kind same-actor
 *  low-signal events (writes, plain messages) merge into one "×N" run; approvals,
 *  triggers and files always stand alone. Returned newest-first. */
export function collapseEpisode(ep: Episode): RailRun[] {
  const runs: RailRun[] = [];
  const mergeable = (k: EventKind) => k === "write" || k === "op" || k === "bot_msg" || k === "user_msg";
  for (const n of ep.events) {
    const last = runs[runs.length - 1];
    if (
      last &&
      last.kind === n.kind &&
      last.actorId === n.actorId &&
      mergeable(n.kind)
    ) {
      last.count += 1;
      last.seq = n.seq;
      last.ts = n.ts;
      if (!last.sample && n.excerpt) last.sample = n.excerpt;
    } else {
      runs.push({
        key: `run-${n.seq}`,
        kind: n.kind,
        actorId: n.actorId,
        count: 1,
        sample: n.excerpt,
        seq: n.seq,
        ts: n.ts,
        episodeId: ep.id,
      });
    }
  }
  return runs.reverse();
}
