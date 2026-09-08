// Structured file edits — the client half of the gateway's `fs.patch` verb.
//
// A lens that saves through `fs.write` sends the WHOLE document, which costs two things
// a canvas cannot afford. Comments: `yamlDoc.applyEdits` preserves them by diffing, but
// it documents one loss — an array whose LENGTH changed is replaced wholesale, because
// per-index diffing cannot tell an insert from N edits. That is exactly what adding or
// deleting a canvas node does. Concurrency: a whole-document write holds everything as
// it looked when the file was opened, so an agent touching any other part of the file
// makes the save conflict, and the conflict is unrecoverable — you cannot replay a
// stale document. An op remains small and version-checked, but an array-indexed path is
// never replayed after a conflict: a concurrent edit may have moved another object into
// `nodes[3]`, turning a seemingly valid retry into silent corruption.
//
// The op vocabulary and the failure modes below MIRROR `apply_value_op` in
// server/src/resource/fs.rs. They have to agree exactly: this module applies the ops
// optimistically to local state while the gateway applies them to the file, and a
// divergence would show the user something that was never written.

export type PatchPath = ReadonlyArray<string | number>;

export type PatchOp =
  | { op: "set"; path: PatchPath; value: unknown }
  | { op: "insert"; path: PatchPath; index: number; value: unknown }
  | { op: "remove"; path: PatchPath }
  | { op: "move"; path: PatchPath; from: number; to: number };

/** The gateway caps a single `fs.patch` call at this many ops. */
export const MAX_PATCH_OPS = 100;

export class PatchError extends Error {}

function fail(message: string): never {
  throw new PatchError(message);
}

/** A mapping, in the sense the server means: an object that is NOT an array.
 *  `as_object_mut()` returns None for a sequence, so a bare `typeof x === "object"`
 *  would accept documents the gateway rejects. */
function asMapping(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resolve(root: unknown, path: PatchPath): unknown {
  let cursor = root;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(cursor) || part < 0 || part >= cursor.length) {
        fail(`sequence index ${part} is out of bounds`);
      }
      cursor = cursor[part];
    } else {
      const map = asMapping(cursor);
      if (!map || !(part in map)) fail(`missing mapping key \`${part}\``);
      cursor = map[part];
    }
  }
  return cursor;
}

function applyOne(root: unknown, op: PatchOp): unknown {
  switch (op.op) {
    case "set": {
      // An empty path replaces the document itself, so this is the one op that can
      // change what `root` refers to — hence the return value.
      if (op.path.length === 0) return op.value;
      const last = op.path[op.path.length - 1];
      const parent = resolve(root, op.path.slice(0, -1));
      if (typeof last === "number") {
        if (!Array.isArray(parent)) fail("set parent must be a sequence");
        if (last < 0 || last >= parent.length) fail("set index is out of bounds");
        parent[last] = op.value;
      } else {
        const map = asMapping(parent);
        if (!map) fail("set parent must be a mapping");
        // Unlike every other op, `set` on a key CREATES it when absent.
        map[last] = op.value;
      }
      return root;
    }
    case "insert": {
      const items = resolve(root, op.path);
      if (!Array.isArray(items)) fail("insert target must be a sequence");
      // `index === length` appends; anything beyond is a mistake, not a grow.
      if (op.index < 0 || op.index > items.length) fail("insert index exceeds sequence length");
      items.splice(op.index, 0, op.value);
      return root;
    }
    case "remove": {
      if (op.path.length === 0) fail("cannot remove the document root");
      const last = op.path[op.path.length - 1];
      const parent = resolve(root, op.path.slice(0, -1));
      if (typeof last === "number") {
        if (!Array.isArray(parent)) fail("remove parent must be a sequence");
        if (last < 0 || last >= parent.length) fail("remove index is out of bounds");
        parent.splice(last, 1);
      } else {
        const map = asMapping(parent);
        if (!map || !(last in map)) fail("remove key does not exist");
        delete map[last];
      }
      return root;
    }
    case "move": {
      const items = resolve(root, op.path);
      if (!Array.isArray(items)) fail("move target must be a sequence");
      if (op.from < 0 || op.to < 0 || op.from >= items.length || op.to >= items.length) {
        fail("move index is out of bounds");
      }
      if (op.from !== op.to) items.splice(op.to, 0, ...items.splice(op.from, 1));
      return root;
    }
  }
}

/** The op that puts `root` back the way it was before `op` — the unit an undo stack
 *  stores. Every op has an exact inverse, which is why undo here is a stack of ops
 *  rather than a stack of document snapshots: it stays small, and it replays through
 *  the same path a forward edit does. */
function inverseOf(root: unknown, op: PatchOp): PatchOp {
  switch (op.op) {
    case "set": {
      if (op.path.length === 0) return { op: "set", path: [], value: structuredClone(root) };
      const last = op.path[op.path.length - 1];
      const parent = resolve(root, op.path.slice(0, -1));
      if (typeof last === "number") {
        const items = parent as unknown[];
        return { op: "set", path: op.path, value: structuredClone(items[last]) };
      }
      const map = asMapping(parent);
      // `set` on an absent key CREATES it, so the inverse of that is a removal, not a
      // restore. Getting this backwards would leave `undefined` values behind in the
      // document after an undo.
      if (!map || !(last in map)) return { op: "remove", path: op.path };
      return { op: "set", path: op.path, value: structuredClone(map[last]) };
    }
    case "insert":
      return { op: "remove", path: [...op.path, op.index] };
    case "remove": {
      if (op.path.length === 0) fail("cannot remove the document root");
      const last = op.path[op.path.length - 1];
      const parent = resolve(root, op.path.slice(0, -1));
      if (typeof last === "number") {
        const items = parent as unknown[];
        if (last >= items.length) fail("remove index is out of bounds");
        return { op: "insert", path: op.path.slice(0, -1), index: last, value: structuredClone(items[last]) };
      }
      const map = asMapping(parent);
      if (!map || !(last in map)) fail("remove key does not exist");
      return { op: "set", path: op.path, value: structuredClone(map[last]) };
    }
    case "move":
      return { op: "move", path: op.path, from: op.to, to: op.from };
  }
}

/** Inverses for a whole batch, in the order that undoes it.
 *
 *  Each inverse is computed against the state that op actually saw, so the walk applies
 *  forward as it goes; the result is reversed because undoing a batch runs it
 *  backwards. */
export function invertPatchOps(root: unknown, ops: readonly PatchOp[]): PatchOp[] {
  let state = structuredClone(root);
  const inverses: PatchOp[] = [];
  for (const op of ops) {
    inverses.push(inverseOf(state, op));
    state = applyOne(state, op);
  }
  return inverses.reverse();
}

/** Apply ops to a COPY of `root` and return it — the caller's data is never mutated,
 *  so a batch that throws part-way leaves the previous state intact rather than a
 *  half-applied one. The gateway is atomic for the same reason. */
export function applyPatchOps(root: unknown, ops: readonly PatchOp[]): unknown {
  let next = structuredClone(root);
  for (const op of ops) next = applyOne(next, op);
  return next;
}
