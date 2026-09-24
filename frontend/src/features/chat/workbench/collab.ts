/**
 * Utilities for real-time collaborative editing in Cheers Workbench.
 * Includes a clean 3-way line-based text merge and presence focus helpers.
 */

import type { PresenceFocus } from "../hooks/useChatRealtime";

export interface MergeResult {
  merged: string;
  hasConflict: boolean;
  conflictsCount: number;
}

/**
 * Clean 3-way line-based merge.
 * Given:
 * - base: text when last fetched / saved from server
 * - local: local text with user's modifications
 * - remote: remote text with someone else's / bot's modifications
 *
 * Produces clean merged text if non-overlapping edits occurred.
 * If concurrent edits overlap on the same line region, inserts standard conflict markers:
 * <<<<<<< LOCAL
 * ...local lines...
 * =======
 * ...remote lines...
 * >>>>>>> REMOTE
 */
export function merge3Way(base: string, local: string, remote: string): MergeResult {
  // Fast paths
  if (local === remote || base === remote) {
    return { merged: local, hasConflict: false, conflictsCount: 0 };
  }
  if (base === local) {
    return { merged: remote, hasConflict: false, conflictsCount: 0 };
  }

  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");

  // Diff local against base
  const localDiff = computeLineDiff(baseLines, localLines);
  // Diff remote against base
  const remoteDiff = computeLineDiff(baseLines, remoteLines);

  const result: string[] = [];
  let baseIdx = 0;
  let localDiffIdx = 0;
  let remoteDiffIdx = 0;
  let hasConflict = false;
  let conflictsCount = 0;

  while (baseIdx < baseLines.length || localDiffIdx < localDiff.length || remoteDiffIdx < remoteDiff.length) {
    const lChunk = localDiff[localDiffIdx];
    const rChunk = remoteDiff[remoteDiffIdx];

    const lMatches = lChunk && lChunk.baseStart <= baseIdx && baseIdx < lChunk.baseStart + lChunk.baseCount;
    const rMatches = rChunk && rChunk.baseStart <= baseIdx && baseIdx < rChunk.baseStart + rChunk.baseCount;

    if (!lMatches && !rMatches) {
      if (baseIdx < baseLines.length) {
        result.push(baseLines[baseIdx]);
        baseIdx++;
      } else {
        break;
      }
    } else if (lMatches && !rMatches) {
      // Only local changed this region
      result.push(...lChunk.newLines);
      baseIdx += lChunk.baseCount;
      localDiffIdx++;
    } else if (!lMatches && rMatches) {
      // Only remote changed this region
      result.push(...rChunk.newLines);
      baseIdx += rChunk.baseCount;
      remoteDiffIdx++;
    } else if (lMatches && rMatches) {
      // Both touched overlapping region!
      const lText = lChunk.newLines.join("\n");
      const rText = rChunk.newLines.join("\n");

      if (lText === rText) {
        // Both made the exact same modification
        result.push(...lChunk.newLines);
      } else {
        // Real conflict!
        hasConflict = true;
        conflictsCount++;
        result.push("<<<<<<< LOCAL (Your edit)");
        result.push(...lChunk.newLines);
        result.push("=======");
        result.push(...rChunk.newLines);
        result.push(">>>>>>> REMOTE (Incoming edit)");
      }
      const span = Math.max(lChunk.baseCount, rChunk.baseCount);
      baseIdx += span;
      localDiffIdx++;
      remoteDiffIdx++;
    }
  }

  // Trailing lines added at end of document
  while (localDiffIdx < localDiff.length) {
    result.push(...localDiff[localDiffIdx].newLines);
    localDiffIdx++;
  }
  while (remoteDiffIdx < remoteDiff.length) {
    result.push(...remoteDiff[remoteDiffIdx].newLines);
    remoteDiffIdx++;
  }

  return {
    merged: result.join("\n"),
    hasConflict,
    conflictsCount,
  };
}

interface DiffChunk {
  baseStart: number;
  baseCount: number;
  newLines: string[];
}

/**
 * Basic block-level line diff generator against base.
 */
function computeLineDiff(baseLines: string[], newLines: string[]): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let b = 0;
  let n = 0;

  while (b < baseLines.length && n < newLines.length) {
    if (baseLines[b] === newLines[n]) {
      b++;
      n++;
      continue;
    }

    const bStart = b;
    const nStart = n;

    // Look ahead to find common sync line
    let foundB = -1;
    let foundN = -1;
    const lookahead = 30;

    outer: for (let d = 1; d <= lookahead; d++) {
      for (let ib = b; ib <= Math.min(baseLines.length - 1, b + d); ib++) {
        for (let in_ = n; in_ <= Math.min(newLines.length - 1, n + d); in_++) {
          if (baseLines[ib] === newLines[in_]) {
            foundB = ib;
            foundN = in_;
            break outer;
          }
        }
      }
    }

    if (foundB !== -1 && foundN !== -1) {
      chunks.push({
        baseStart: bStart,
        baseCount: foundB - bStart,
        newLines: newLines.slice(nStart, foundN),
      });
      b = foundB;
      n = foundN;
    } else {
      // Consumed to end
      chunks.push({
        baseStart: bStart,
        baseCount: baseLines.length - bStart,
        newLines: newLines.slice(nStart),
      });
      b = baseLines.length;
      n = newLines.length;
    }
  }

  if (b < baseLines.length || n < newLines.length) {
    chunks.push({
      baseStart: b,
      baseCount: baseLines.length - b,
      newLines: newLines.slice(n),
    });
  }

  return chunks;
}

/**
 * Filter and format presence focus info for the current file path.
 */
export interface CollaboratorInfo {
  id: string;
  name: string;
  isBot: boolean;
  isSelf: boolean;
}

export function filterCollaborators(
  focusList: readonly PresenceFocus[] = [],
  currentPath: string | null | undefined,
  currentUserId?: string | null,
  memberNames?: Record<string, string> | ReadonlyMap<string, string>
): CollaboratorInfo[] {
  if (!currentPath) return [];

  const list: CollaboratorInfo[] = [];
  const seen = new Set<string>();

  const lookupName = (id: string | undefined): string | undefined => {
    if (!id || !memberNames) return undefined;
    if (memberNames instanceof Map || "get" in memberNames) {
      return (memberNames as ReadonlyMap<string, string>).get(id);
    }
    return (memberNames as Record<string, string>)[id];
  };

  for (const item of focusList) {
    if (item.path !== currentPath) continue;
    const key = `${item.user_id}:${item.bot_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const isSelf = !!currentUserId && item.user_id === currentUserId;
    const isBot = !!item.bot_id && !item.user_id;
    const resolvedName = isBot ? lookupName(item.bot_id) : lookupName(item.user_id);
    const name = isBot
      ? resolvedName ?? `Bot ${item.bot_id.slice(0, 6)}`
      : isSelf
      ? "You"
      : resolvedName ?? `User ${item.user_id.slice(0, 6)}`;

    list.push({
      id: key,
      name,
      isBot,
      isSelf,
    });
  }

  return list;
}
