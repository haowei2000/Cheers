# Workbench Write-Back: the Gateway Owns the YAML Patch

> **Language**: English | 中文镜像待补
>
> **Status**: Accepted · **Date**: 2026-07-19 · **Owner**: haowei
>
> Settles §6 of [WORKBENCH_LENS_SPEC.md](WORKBENCH_LENS_SPEC.md).

## Context

Declarative lenses make board files **commented YAML** ([spec §2](WORKBENCH_LENS_SPEC.md)).
The reason for YAML is comments: in a file a human and an agent both edit, comments are how
each explains itself to the other. That choice only pays off if **writes preserve them** —
a `parse → serialize` round trip erases every comment and would make the whole decision
pointless.

Preserving comments means patching the parsed document (a CST carrying comments, key order
and blank lines), touching only changed nodes. That is not a one-liner. The existing web
implementation ([yamlDoc.ts](../../frontend/src/features/chat/workbench/yamlDoc.ts), 67
dense lines) already documents four behaviours that are easy to get subtly wrong:

- unparseable input, multi-document streams, and anchors/aliases fall back to a full
  re-stringify (patching through an alias would silently edit the anchor's other readers);
- an array whose **length** changed is replaced wholesale, losing comments inside it;
- a same-length **reorder** is not detected — items are patched per index, so item comments
  stay put and can end up annotating a different item;
- YAML 1.1 vs 1.2: a bare `no`/`yes`/`on`/`off` round-trips differently for PyYAML-based
  agent stacks than for a 1.2 reader.

So the question is not *how* to patch, but **where it runs** — because whoever runs it must
reproduce all of the above identically.

Four clients now read the workbench: web, desktop, native iOS, native Android. `apps/ios`
additionally has a **zero-dependency policy** — no SPM packages — so a Swift implementation
would mean hand-writing a comment-preserving YAML round-tripper.

## Decision

**The gateway owns write-back. Clients send structured edits, never whole documents.**

A new resource verb carries an ordered list of document operations against a path, plus the
optimistic-lock version:

```
fs.patch { channel_id, path, if_version, ops: [ … ] }
  → { path, version }   |   VERSION_CONFLICT
```

Operations are **generic document edits addressed by path** — deliberately not lens-aware:

| op | meaning |
|---|---|
| `set`    | replace the scalar/node at a path |
| `insert` | insert an element into a sequence at an index |
| `remove` | delete a key or sequence element |
| `move`   | relocate a sequence element (the kanban card drag, the list reorder) |

The gateway parses the YAML into a CST, applies the ops, re-emits with comments and
untouched nodes preserved, and writes under the existing optimistic lock. `move` exists as
its own op precisely because it is the case a naive diff cannot recover (see the reorder
bullet above) — expressing intent removes the ambiguity instead of guessing at it.

**The gateway does not learn what a kanban is.** It edits YAML documents by path; the lens
binding stays entirely client-side. That keeps the layering the same as today's `fs.*`.

### The read side: the gateway parses too

Owning the write side is only half the problem, and the other half is what decides whether
native clients can run lenses at all.

**To render a table or a list, a client must first parse the YAML.** `apps/ios` has a
zero-dependency policy and Foundation ships **no YAML parser** — only `JSONSerialization`.
So a native client would need either a hand-written YAML subset parser (the trap
`codemap.plugin.html` already fell into, and a guaranteed source of drift from the server's
full parser) or a new third-party dependency.

**Decision: `fs.read` also returns a parsed representation.** The gateway parses the YAML
and returns the data as JSON alongside the raw `content` it already sends:

```
fs.read { channel_id, path } → { path, version, content, data? }
                                        raw text ↑     ↑ parsed, JSON — omitted when
                                     (editor fallback)   the file isn't valid YAML
```

This makes the principle symmetric and complete:

> **YAML is a storage format for humans and agents. The wire is JSON. The format never
> leaves the gateway.**

Consequences:

- **Every client can run lenses**, including ones with no YAML library. iOS, Android and
  any future client render from JSON they already decode.
- **The 1.1-vs-1.2 boolean ambiguity is resolved once**, server-side, instead of differently
  in each client's parser.
- **Clients cannot disagree about what a file means**, because only one parser exists.
- The editor fallback is unaffected — it uses `content`, which is unchanged.

Cost: `fs.read` responses grow for large boards (raw text plus parsed data). Mitigate with
an opt-out flag if it ever matters; do not pre-optimise.

### What does not change

- `fs.write` (whole content + `if_version`) stays exactly as-is. The **editor fallback**
  ([spec §5](WORKBENCH_LENS_SPEC.md)) and every **sandboxed HTML plugin** keep using it —
  the [plugin contract](../developer/PLUGIN_DEVELOPMENT.md) is untouched. Both paths share
  one optimistic lock, so they interleave safely.
- Conflict semantics are unchanged: on `VERSION_CONFLICT` the client re-reads and redraws.

## Consequences

- **One implementation of the subtle part.** Comment-preservation behaviour is identical on
  every client because there is only one copy of it.
- **iOS needs no YAML writer at all**, so the zero-dependency policy survives contact with
  YAML boards.
- **Better audit.** The activity/audit surfaces see a semantic edit ("set `tasks[3].done`")
  instead of an opaque new blob — strictly more useful than a whole-file diff.
- **Smaller writes.** A checkbox toggle sends one op, not the whole board. Marginal today;
  it matters for large files on mobile networks.
- **Two write paths now exist** (`fs.write` and `fs.patch`). Acceptable because they are
  cleanly split by caller — free-form text editing vs. structured lens edits — and share
  the lock. This must be documented, or someone will add a third.
- **The gateway gains a YAML dependency and a new failure surface.** A patch that cannot be
  applied (path no longer exists after a concurrent bot write) must fail loudly as a
  conflict, never silently no-op.

### Spike result: `yamlpath`, and it is better than the web implementation

The stated risk was the Rust side — `serde_yaml` does not preserve comments, and Rust's
comment-preserving-editor story is weaker than JS's. **Spiked 2026-07-19; resolved.**

Candidates measured, not guessed:

| crate | verdict |
|---|---|
| `yaml-rust2` 0.11 | round-trip **destroys every comment** — parse→emit, as feared |
| `yaml-patch` 0.1.1 | unrelated 164-line crate built on `serde_yaml`; no preservation |
| **`yamlpath` 1.27** | **chosen** — "Format-preserving YAML feature extraction", tree-sitter based, MIT, from [zizmor](https://github.com/zizmorcore/zizmor) |

`yamlpath` does not re-serialize at all. It resolves a path (`Route` of `Key`/`Index`
components) to an exact **byte span**, and we splice. Everything outside the span survives
**by construction**, which is a stronger guarantee than diffing.

Verified on a fixture carrying a header comment, an interior comment, a trailing inline
comment, a blank line and a sibling key — setting `tasks[0].done` from `false` to `true`:

```
[PASS] header comment kept     [PASS] blank line kept
[PASS] inner comment kept      [PASS] value changed
[PASS] trailing comment kept   [PASS] sibling untouched
```

Against the four hazards from §Context:

- **anchors/aliases** — `Document::has_anchors()` detects them, so the gateway can refuse
  exactly where the web implementation bails. The crate surfaces this as a first-class
  concern.
- **multi-document streams** — parse succeeds; the bail policy is ours to set explicitly.
- **array length change** — sequence elements are individually addressable
  (`tasks[1]` → span `(128, 156)`), so `insert` / `remove` / `move` are splices. **This is
  where the gateway beats `yamlDoc.ts`**: the web side replaces a length-changed array
  wholesale and loses comments inside it, because a data diff cannot distinguish an insert
  from N edits. Explicit ops carry that intent, so nothing has to be guessed and the
  comments survive.
- **reorder** — same reason. `move` as its own op is what makes the case the web version
  silently gets wrong (item comments annotating the wrong item) representable at all.
- **YAML 1.1 booleans** — the writer controls the emitted text, so quoting a bare `no`
  is straightforward (verified).

**Consequence worth stating plainly:** the gateway implementation will be *more* faithful
than the current web one. `yamlDoc.ts` should eventually delegate to `fs.patch` rather than
keep its own diff-based path, or the two will disagree about what survives an edit.

The spike lives in the session scratchpad; port it to `server/` with these fixtures as
tests.

## Alternatives considered

- **Patch per client.** No server work, matches today's protocol exactly. Rejected: the CST
  logic and all four subtle behaviours would be reimplemented per client, and a divergence
  here does not throw an error — it **silently mangles a user's file**, which is the worst
  failure mode available to us. This project has already been bitten by typed-boundary and
  lens-semantics drift between implementations.
- **Client patches, server validates.** Worst of both: the logic still exists twice, plus a
  new disagreement surface between them.
- **CRDT / OT.** Real concurrent editing. Massively disproportionate — workbench editing is
  turn-based (a human toggles, an agent writes between turns), and the optimistic lock plus
  re-render already handles it. Revisit only if simultaneous multi-human editing becomes a
  goal.
- **Keep JSON to avoid the problem entirely.** This is the problem being deliberately taken
  on: JSON has no comments, which is what forced `.workbench.json`'s `_doc` field. Paying a
  server-side cost to get commentable board files is the trade being made.

## Next steps

1. ~~Spike the Rust comment-preserving YAML editor~~ — **done 2026-07-19, `yamlpath` 1.27**
   (see above). No longer blocking.
2. Specify `fs.patch` and the `data` field of `fs.read` in
   [WIRE_PROTOCOL.md](WIRE_PROTOCOL.md) and the resource verb table.
3. Implement in the gateway, porting the spike's fixtures as tests: `fs.patch` (4 ops) and
   `fs.read`'s parsed `data`. `fs.write` stays untouched.
4. Build the **editor fallback** on iOS (`fs.write` only — no YAML, no patching). This
   unblocks the human half of the loop immediately and proves the write path end to end.
5. Then the three interactive widgets (`table` / `list` / `form`) on `fs.patch` + `data` —
   web and iOS from the same wire contract.
6. Retire `yamlDoc.ts`'s diff-based path in favour of `fs.patch`, or the two will disagree
   about what survives an edit (see the spike note).

## References

- [WORKBENCH_LENS_SPEC.md](WORKBENCH_LENS_SPEC.md) — the declarative lens model this serves
- [WORKBENCH.md](WORKBENCH.md) — the three-layer model
- [PLUGIN_DEVELOPMENT.md](../developer/PLUGIN_DEVELOPMENT.md) — the HTML plugin contract,
  unchanged by this decision
- [yamlDoc.ts](../../frontend/src/features/chat/workbench/yamlDoc.ts) — the reference
  implementation whose behaviour the gateway must reproduce
