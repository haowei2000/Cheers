import { createContext } from "react";
import type { FileInfo } from "@/types";

/**
 * Open a clicked file reference, already bound by the provider to the message's
 * sender bot. The token is a filename/path the user clicked; resolution to the
 * right store happens downstream. Null on non-bot messages. Consumed by MarkdownRenderer.
 */
export const PathOpenContext = createContext<((ref: string) => void) | null>(null);

/** A clicked file reference + the context needed to resolve it by provenance. */
export interface RefClick {
  senderBotId: string;
  ref: string;
  files?: FileInfo[];
}

/** Resolve+open a clicked file reference. Provided by ChannelView. */
export const ResolveRefContext = createContext<((c: RefClick) => void) | null>(null);

/** Heuristic: does a backtick-wrapped inline-code token look like a workspace file path? */
export function looksLikePath(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 200 || /\s/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // URL / scheme
  const hasSlash = t.includes("/");
  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(t);
  return hasSlash || hasExt;
}

/**
 * Strip an optional `<shell> -c/-lc "<inner>"` wrapper and return the inner
 * command, so a normalized command like `/bin/zsh -lc "git commit -m '…'"` or
 * `bash -c 'git commit ...'` is reduced to `git commit -m '…'`. Returns the input
 * unchanged when it isn't a recognizable shell-wrapper form.
 */
function unwrapShell(command: string): string {
  // <optional path>/<sh|bash|zsh|dash> <flags…> -…c… "<inner>"  (single or double quoted).
  const m = command.match(
    /^(?:\S*\/)?(?:ba|z|da)?sh\s+(?:-\S+\s+)*-\S*c\S*\s+(['"])([\s\S]*)\1\s*$/
  );
  return m ? m[2] : command;
}

/**
 * Split a command into whitespace-delimited tokens while keeping single/double
 * quoted runs intact — so `--help` inside a commit message stays part of its
 * quoted token instead of being read as a bare flag.
 */
function shellTokens(s: string): string[] {
  return s.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
}

// git global options that consume the FOLLOWING token as their argument (the
// separate-arg forms). The `--opt=value` variants are self-contained single
// tokens and need no special handling.
const GIT_GLOBAL_OPTS_WITH_ARG = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
]);

/**
 * True iff `command` (after stripping an optional shell wrapper) is really `git`
 * invoking subcommand `sub`, and it isn't a `--help`/`-h` man-page invocation.
 * Git's global options are skipped first (with their arguments), so
 * `git -C <dir> commit`, `git -c k=v commit`, and `git --git-dir=… commit` all
 * match — not just the bare `git commit` form. Quote-aware so a mention of the
 * subcommand inside a message argument doesn't count.
 */
function firstGitSubcommandIs(command: string, sub: string): boolean {
  const tokens = shellTokens(unwrapShell(command.trim()).trim());
  if (tokens[0] !== "git") return false;
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    i += GIT_GLOBAL_OPTS_WITH_ARG.has(tokens[i]) ? 2 : 1;
  }
  if (tokens[i] !== sub) return false;
  return !tokens.slice(i + 1).some((t) => t === "--help" || t === "-h");
}

/**
 * Conservative check for a real `git commit`, tolerant of shell wrappers
 * (`/bin/zsh -lc "git commit …"`, `bash -c 'git commit …'`). Deliberately does
 * NOT match `git commit --help`, `git log`, `echo "git commit"`, or a commit
 * whose message merely mentions the words "git commit".
 */
export function looksLikeGitCommit(command: string): boolean {
  return firstGitSubcommandIs(command, "commit");
}

/** Same conservative heuristic for `git push` (used by posture guidance). */
export function looksLikeGitPush(command: string): boolean {
  return firstGitSubcommandIs(command, "push");
}
