import { useEffect, useState } from "react";
import { FolderPlus, Settings2 } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { invokeDesktop, pickFolder } from "@/lib/desktop";
import { AgentPicker } from "./AgentPicker";

/** Mirror of the Rust `ConfigFields` (connector.rs). */
interface ConfigFields {
  account_id: string;
  adapter_command: string;
  adapter_args: string[];
  allowed_roots: string[];
  default_cwd: string | null;
  auto_allow: boolean;
  env_inherit: boolean;
  env_allow: string[];
  forward_to_backend: boolean;
  wait_timeout_ms: number;
  on_timeout: string;
  max_concurrent: number;
  max_duration_ms: number;
  heartbeat_interval_ms: number;
  file_upload_allow: boolean;
}

const lines = (v: string): string[] =>
  v.split("\n").map((s) => s.trim()).filter(Boolean);
const text = (v: string[]): string => v.join("\n");

/**
 * Form editor for a connector's config — the important settings up front, the
 * detailed ones under "More", and the raw TOML as a final escape hatch. Reads
 * the account's fields, writes only those back (structure-preserving), so
 * comments and unmanaged keys survive. Works for any existing instance.
 */
export function ConnectorConfigForm({
  name,
  configPath,
  busy,
  onClose,
  onSave,
}: {
  name: string;
  configPath: string;
  busy: boolean;
  onClose: () => void;
  onSave: (restart: boolean, apply: () => Promise<unknown>) => void;
}) {
  const [f, setF] = useState<ConfigFields | null>(null);
  const [more, setMore] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const [raw, setRaw] = useState("");
  const [argsOpen, setArgsOpen] = useState(false);
  // Which agent tile is highlighted; "custom" until the picker matches one.
  const [agentKey, setAgentKey] = useState("custom");
  // True when `default_cwd` is set but under none of the workspace roots — the
  // connector rejects this at startup with "default_cwd must be under
  // allowed_roots", so warn before the user saves instead of after a crash.
  const [cwdUnderRoot, setCwdUnderRoot] = useState<boolean | null>(null);

  useEffect(() => {
    invokeDesktop<ConfigFields>("connector_config_read_fields", { path: configPath })
      .then(setF)
      .catch((e) => toast.error(typeof e === "string" ? e : "couldn't read config"));
  }, [configPath]);

  function patch(p: Partial<ConfigFields>) {
    setF((prev) => (prev ? { ...prev, ...p } : prev));
  }

  // Re-check the cwd-vs-roots rule whenever either changes. No-op in the
  // browser (the desktop-only command is gated inside invokeDesktop).
  useEffect(() => {
    if (!f) {
      setCwdUnderRoot(null);
      return;
    }
    let cancelled = false;
    invokeDesktop<boolean>("connector_validate_workspace", {
      defaultCwd: f.default_cwd ?? null,
      allowedRoots: f.allowed_roots,
    })
      .then((ok) => {
        if (!cancelled) setCwdUnderRoot(ok);
      })
      .catch(() => {
        if (!cancelled) setCwdUnderRoot(null); // fall back to silent
      });
    return () => {
      cancelled = true;
    };
  }, [f?.default_cwd, f?.allowed_roots]);

  async function openRaw() {
    try {
      setRaw(await invokeDesktop<string>("connector_read_config", { path: configPath }));
      setRawMode(true);
    } catch (e) {
      toast.error(typeof e === "string" ? e : "couldn't read raw config");
    }
  }

  if (!f) {
    return <p className="text-xs text-zinc-500 mt-3">Loading config…</p>;
  }

  if (rawMode) {
    return (
      <div className="mt-3 space-y-2">
        <p className="text-xs text-zinc-500">Raw TOML — full control.</p>
        <Textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={16}
          className="font-mono text-xs"
          spellCheck={false}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              onSave(true, () =>
                invokeDesktop("connector_write_config", { path: configPath, content: raw })
              )
            }
          >
            Save &amp; restart
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() =>
              onSave(false, () =>
                invokeDesktop("connector_write_config", { path: configPath, content: raw })
              )
            }
          >
            Save only
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setRawMode(false)}>
            Back to form
          </Button>
        </div>
      </div>
    );
  }

  const apply = () =>
    invokeDesktop("connector_config_write_fields", { path: configPath, fields: f });

  const numField = (
    label: string,
    val: number,
    set: (n: number) => void
  ) => (
    <Field label={label}>
      <Input
        type="number"
        value={val}
        onChange={(e) => set(Number(e.target.value) || 0)}
      />
    </Field>
  );

  return (
    <div className="mt-3 space-y-4">
      <p className="text-xs text-zinc-500">
        Editing <b>{name}</b> — account <code className="bg-zinc-800 rounded px-1">{f.account_id}</code>.
      </p>

      {/* ── Important ── */}
      <div className="grid gap-3">
        {/* Agent: pick from installed agents (or custom); command + args on one row. */}
        <Field label="Agent">
          <AgentPicker
            value={agentKey}
            onPick={(key, cmdPath) => {
              setAgentKey(key);
              if (cmdPath) patch({ adapter_command: cmdPath });
            }}
          />
        </Field>
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <Input
              value={f.adapter_command}
              onChange={(e) => patch({ adapter_command: e.target.value })}
              placeholder="/opt/homebrew/bin/codex-acp"
            />
          </div>
          <button
            type="button"
            title="Command arguments"
            onClick={() => setArgsOpen((o) => !o)}
            className={`shrink-0 rounded-lg px-2.5 py-2 text-xs flex items-center gap-1 ${
              argsOpen || f.adapter_args.length
                ? "bg-zinc-700 text-zinc-100"
                : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Settings2 className="w-3.5 h-3.5" /> Args
            {f.adapter_args.length > 0 && ` (${f.adapter_args.length})`}
          </button>
        </div>
        {argsOpen && (
          <Field label="Command arguments (one per line)">
            <Textarea
              value={text(f.adapter_args)}
              onChange={(e) => patch({ adapter_args: lines(e.target.value) })}
              rows={2}
              className="font-mono text-xs"
            />
          </Field>
        )}

        <Field label="Workspace roots">
          <Textarea
            value={text(f.allowed_roots)}
            onChange={(e) => patch({ allowed_roots: lines(e.target.value) })}
            rows={3}
            className="font-mono text-xs"
            placeholder={"~/Projects\n~/.cheers/workspace"}
          />
          <button
            type="button"
            className="mt-1 text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
            onClick={() =>
              void pickFolder().then((p) => {
                if (p && !f.allowed_roots.includes(p)) {
                  patch({ allowed_roots: [...f.allowed_roots, p] });
                }
              })
            }
          >
            <FolderPlus className="w-3.5 h-3.5" /> Add folder…
          </button>
        </Field>
        <Field label="Default working directory">
          <div className="flex gap-2">
            <Input
              value={f.default_cwd ?? ""}
              onChange={(e) => patch({ default_cwd: e.target.value })}
              placeholder="~/Projects"
              className="flex-1"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void pickFolder().then((p) => p && patch({ default_cwd: p }))}
            >
              <FolderPlus className="w-3.5 h-3.5" /> Choose…
            </Button>
          </div>
          {cwdUnderRoot === false && f.default_cwd?.trim() && (
            <p className="mt-1 text-xs text-amber-400">
              This directory is not under any workspace root — the connector will
              refuse to start.{" "}
              <button
                type="button"
                className="underline hover:text-amber-300"
                onClick={() => {
                  const cwd = f.default_cwd?.trim();
                  if (cwd && !f.allowed_roots.includes(cwd)) {
                    patch({ allowed_roots: [...f.allowed_roots, cwd] });
                  }
                }}
              >
                Add it to workspace roots
              </button>
            </p>
          )}
        </Field>
        <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer w-fit">
          <input
            type="checkbox"
            checked={f.auto_allow}
            onChange={(e) => patch({ auto_allow: e.target.checked })}
          />
          Auto-approve tool calls (skip permission prompts) — use with care
        </label>
      </div>

      {/* ── More ── */}
      <div>
        <button
          type="button"
          className="text-xs text-zinc-400 hover:text-zinc-200"
          onClick={() => setMore((m) => !m)}
        >
          {more ? "▾" : "▸"} More settings
        </button>
        {more && (
          <div className="grid gap-3 mt-3 pl-2 border-l border-zinc-800">
            <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer w-fit">
              <input
                type="checkbox"
                checked={f.env_inherit}
                onChange={(e) => patch({ env_inherit: e.target.checked })}
              />
              Inherit the app's environment
            </label>
            <Field label="Environment variables to pass through (one per line)">
              <Textarea
                value={text(f.env_allow)}
                onChange={(e) => patch({ env_allow: lines(e.target.value) })}
                rows={3}
                className="font-mono text-xs"
                placeholder={"HOME\nPATH\nANTHROPIC_API_KEY"}
              />
            </Field>
            <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer w-fit">
              <input
                type="checkbox"
                checked={f.forward_to_backend}
                onChange={(e) => patch({ forward_to_backend: e.target.checked })}
              />
              Forward permission prompts to the agent
            </label>
            <Field label="Permission wait, on timeout">
              <div className="flex gap-2">
                <Input
                  type="number"
                  value={f.wait_timeout_ms}
                  onChange={(e) => patch({ wait_timeout_ms: Number(e.target.value) || 0 })}
                  className="flex-1"
                />
                <select
                  value={f.on_timeout}
                  onChange={(e) => patch({ on_timeout: e.target.value })}
                  className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="cancel">cancel</option>
                  <option value="reject">reject</option>
                  <option value="allow">allow</option>
                </select>
              </div>
            </Field>
            {numField("Max concurrent prompts", f.max_concurrent, (n) =>
              patch({ max_concurrent: n })
            )}
            {numField("Max prompt duration (ms)", f.max_duration_ms, (n) =>
              patch({ max_duration_ms: n })
            )}
            {numField("Heartbeat interval (ms)", f.heartbeat_interval_ms, (n) =>
              patch({ heartbeat_interval_ms: n })
            )}
            <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer w-fit">
              <input
                type="checkbox"
                checked={f.file_upload_allow}
                onChange={(e) => patch({ file_upload_allow: e.target.checked })}
              />
              Allow file uploads
            </label>
            <button
              type="button"
              className="text-xs text-zinc-500 hover:text-zinc-300 w-fit"
              onClick={() => void openRaw()}
            >
              Edit raw TOML…
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => onSave(true, apply)}>
          Save &amp; restart
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => onSave(false, apply)}>
          Save only
        </Button>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
