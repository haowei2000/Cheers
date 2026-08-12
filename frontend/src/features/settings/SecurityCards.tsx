import { useCallback, useEffect, useState } from "react";
import { KeyRound, ShieldCheck, Fingerprint, Copy, Check } from "lucide-react";
import toast from "react-hot-toast";
import {
  deletePasskey,
  disableTwoFactor,
  enableTwoFactor,
  getAuthCapabilities,
  listPasskeys,
  passkeyRegisterFinish,
  passkeyRegisterOptions,
  setupTwoFactor,
  twoFactorStatus,
  type PasskeyCredential,
} from "@/api/auth";
import { createPasskey, passkeyTransactionId } from "@/lib/webauthn";
import { Button } from "@/components/ui/button";
import { ItemList, OperationsItem } from "@/components/ui/item";
import { Input } from "@/components/ui/input";

const inputCls =
  "bg-zinc-800 text-zinc-100";

/** Authenticator (TOTP) setup / disable — mirrors iOS TwoFactorSettingsView. */
export function TwoFactorCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<"idle" | "setup" | "backup" | "disable">("idle");
  const [secret, setSecret] = useState("");
  const [provisioningUri, setProvisioningUri] = useState("");
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    twoFactorStatus()
      .then((s) => setEnabled(s.enabled))
      .catch(() => setEnabled(null));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function beginSetup() {
    setBusy(true);
    try {
      const res = await setupTwoFactor();
      setSecret(res.secret);
      setProvisioningUri(res.provisioning_uri);
      setCode("");
      setPhase("setup");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start 2FA setup");
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnable() {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const res = await enableTwoFactor(code.trim());
      setBackupCodes(res.backup_codes);
      setEnabled(true);
      setPhase("backup");
      setCode("");
      toast.success("Two-factor authentication is on");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDisable() {
    if (!code.trim()) return;
    setBusy(true);
    try {
      await disableTwoFactor(code.trim());
      setEnabled(false);
      setPhase("idle");
      setCode("");
      toast.success("Two-factor authentication is off");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't disable 2FA");
    } finally {
      setBusy(false);
    }
  }

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      toast.success("Secret copied");
    } catch {
      toast.error("Clipboard unavailable");
    }
  }

  async function copyBackup() {
    try {
      await navigator.clipboard.writeText(backupCodes.join("\n"));
      toast.success("Backup codes copied");
    } catch {
      toast.error("Clipboard unavailable");
    }
  }

  return (
    <div className="bg-zinc-900 rounded-sm p-6 mt-4">
      <p className="text-regular font-medium text-zinc-200 flex items-center gap-2 mb-1">
        <ShieldCheck className="w-4 h-4 text-indigo-400" /> Authenticator app
      </p>
      <p className="text-compact text-zinc-400 mb-4">
        Use an authenticator app (or backup codes) when signing in.
      </p>

      {phase === "idle" && (
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-regular text-zinc-200">
              Status:{" "}
              <span className={enabled ? "text-emerald-400" : "text-zinc-500"}>
                {enabled == null ? "…" : enabled ? "On" : "Off"}
              </span>
            </p>
          </div>
          {enabled ? (
            <Button
              variant="danger"
              controlSize="compact"
              disabled={busy}
              onClick={() => {
                setCode("");
                setPhase("disable");
              }}
            >
              Turn off
            </Button>
          ) : (
            <Button controlSize="compact" disabled={busy || enabled == null} onClick={() => void beginSetup()}>
              {busy ? "Starting…" : "Set up"}
            </Button>
          )}
        </div>
      )}

      {phase === "setup" && (
        <div className="space-y-3 max-w-md">
          <p className="text-compact text-zinc-400">
            Add this account in your authenticator app using the secret below
            (or open the otpauth link).
          </p>
          <div className="rounded-sm bg-zinc-800 px-3 py-2 font-mono text-regular text-zinc-100 break-all">
            {secret}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" controlSize="compact" onClick={() => void copySecret()}>
              <Copy className="w-3.5 h-3.5" /> Copy secret
            </Button>
            {provisioningUri && (
              <a
                href={provisioningUri}
                className="inline-flex items-center rounded-sm bg-zinc-800 px-3 py-2 text-compact text-indigo-300 hover:text-indigo-200"
              >
                Open otpauth://
              </a>
            )}
          </div>
          <label className="block text-compact font-medium text-zinc-400 uppercase tracking-wide">
            Verification code
          </label>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            autoComplete="one-time-code"
            className={inputCls}
          />
          <div className="flex gap-2">
            <Button disabled={busy || !code.trim()} onClick={() => void confirmEnable()}>
              {busy ? "Verifying…" : "Enable"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setPhase("idle");
                setCode("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {phase === "backup" && (
        <div className="space-y-3 max-w-md">
          <p className="text-compact text-amber-200/90">
            Save these backup codes now — each works once if you lose your authenticator.
          </p>
          <ul className="rounded-sm bg-zinc-800 px-3 py-2 font-mono text-regular text-zinc-100 space-y-1">
            {/* design-system-exempt: code-list — recovery codes preserve ordered code semantics. */}
            {backupCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button variant="secondary" controlSize="compact" onClick={() => void copyBackup()}>
              <Copy className="w-3.5 h-3.5" /> Copy codes
            </Button>
            <Button
              controlSize="compact"
              onClick={() => {
                setPhase("idle");
                setBackupCodes([]);
              }}
            >
              <Check className="w-3.5 h-3.5" /> Done
            </Button>
          </div>
        </div>
      )}

      {phase === "disable" && (
        <div className="space-y-3 max-w-sm">
          <p className="text-compact text-zinc-400">
            Enter an authenticator or backup code to turn off 2FA.
          </p>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Authenticator or backup code"
            autoComplete="one-time-code"
            className={inputCls}
          />
          <div className="flex gap-2">
            <Button
              variant="danger"
              disabled={busy || !code.trim()}
              onClick={() => void confirmDisable()}
            >
              {busy ? "Turning off…" : "Confirm turn off"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setPhase("idle");
                setCode("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Passkey list / add / delete — mirrors iOS PasskeySettingsView. */
export function PasskeyCard() {
  const [available, setAvailable] = useState(false);
  const [rpId, setRpId] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<PasskeyCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const caps = await getAuthCapabilities();
      setAvailable(Boolean(caps.passkey));
      setRpId(caps.passkey_rp_id ?? null);
      if (caps.passkey) {
        setCredentials(await listPasskeys());
      } else {
        setCredentials([]);
      }
    } catch {
      setAvailable(false);
      setCredentials([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function add() {
    setBusy(true);
    try {
      const options = await passkeyRegisterOptions(name.trim() || undefined);
      const transactionId = passkeyTransactionId(options);
      const credential = await createPasskey(options);
      await passkeyRegisterFinish(transactionId, credential);
      setName("");
      toast.success("Passkey added");
      await reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't add passkey";
      if (/cancel|abort/i.test(msg)) return;
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function remove(pk: string) {
    if (!window.confirm("Delete this passkey?")) return;
    try {
      await deletePasskey(pk);
      toast.success("Passkey deleted");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete passkey");
    }
  }

  return (
    <div className="bg-zinc-900 rounded-sm p-6 mt-4">
      <p className="text-regular font-medium text-zinc-200 flex items-center gap-2 mb-1">
        <Fingerprint className="w-4 h-4 text-indigo-400" /> Passkeys
      </p>
      <p className="text-compact text-zinc-400 mb-4">
        Sign in with Face ID, Touch ID, or a device passkey when 2FA is required.
      </p>

      <p className="text-regular text-zinc-300 mb-3">
        Status:{" "}
        <span className={available ? "text-emerald-400" : "text-zinc-500"}>
          {loading ? "…" : available ? "Available" : "Not configured on server"}
        </span>
        {rpId && (
          <span className="ml-2 font-mono text-compact text-zinc-500">{rpId}</span>
        )}
      </p>

      {loading ? (
        <p className="text-compact text-zinc-500">Loading…</p>
      ) : credentials.length === 0 ? (
        <p className="text-compact text-zinc-500 mb-3">No passkeys yet.</p>
      ) : (
        <ItemList presentationLevel="medium" controlSize="regular" className="mb-4">
          {credentials.map((c) => (
            <OperationsItem
              key={c.credential_pk}
              title={`${c.name} · added ${c.created_at.slice(0, 10)}`}
              trailing={c.last_used_at ? <span className="text-compact text-zinc-400">Used {c.last_used_at.slice(0, 10)}</span> : undefined}
              actions={<Button variant="danger" controlSize="compact" onClick={() => void remove(c.credential_pk)}>
                Delete
              </Button>}
              className="border-0 bg-zinc-800/70"
            />
          ))}
        </ItemList>
      )}

      {available && (
        <div className="flex flex-wrap items-end gap-2 max-w-md">
          <div className="flex-1 min-w-[10rem]">
            <label className="block text-compact font-medium text-zinc-400 uppercase tracking-wide mb-1">
              Name (optional)
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="This MacBook"
              className={inputCls}
            />
          </div>
          <Button disabled={busy} onClick={() => void add()}>
            <KeyRound className="w-3.5 h-3.5" />
            {busy ? "Waiting…" : "Add passkey"}
          </Button>
        </div>
      )}
    </div>
  );
}
