import { useCallback, useEffect, useState } from "react";
import { Fingerprint, ExternalLink } from "lucide-react";
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
import { ActionButton } from "@/components/ui/action-button";
import { Dialog } from "@/components/ui/dialog";
import { ItemList, OperationsItem } from "@/components/ui/item";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";

const inputCls =
  "bg-zinc-800 text-content-primary";

/** Authenticator (TOTP) setup / disable — mirrors iOS TwoFactorSettingsView. */
export function TwoFactorCard() {
  const [open, setOpen] = useState(false);
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

  function closeDialog() {
    if (busy) return;
    setPhase("idle");
    setSecret("");
    setProvisioningUri("");
    setCode("");
    setBackupCodes([]);
    setOpen(false);
  }

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
      setOpen(false);
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
    <>
      <ActionButton
        action="manageTwoFactor"
        context="security"
        controlWidth="fill"
        accessibleLabel={enabled ? "Manage two-factor authentication" : "Set up two-factor authentication"}
        loading={busy && !open}
        disabled={enabled == null}
        onClick={() => {
          setOpen(true);
          if (!enabled) void beginSetup();
        }}
      />
      {open && (
        <Dialog title={enabled ? "Manage 2FA" : "Set up 2FA"} onClose={closeDialog}>
          {phase === "idle" && enabled && (
            <div className="space-y-3">
              <p className="text-caption">Two-factor authentication is on. You can turn it off using an authenticator or backup code.</p>
              <ActionButton action="disable" context="security" accessibleLabel="Turn off authenticator app" onClick={() => { setCode(""); setPhase("disable"); }} />
            </div>
          )}
          {phase === "idle" && !enabled && (
            <p className="text-caption">{busy ? "Preparing authenticator setup…" : "Authenticator setup could not be started. Close this dialog and try again."}</p>
          )}

          {phase === "setup" && (
            <div className="space-y-3">
          <p className="text-compact text-content-muted">
            Add this account in your authenticator app using the secret below
            (or open the otpauth link).
          </p>
          <div className="rounded-sm bg-zinc-800 px-3 py-2 font-code text-regular text-content-primary break-all">
            {secret}
          </div>
          <div className="flex flex-wrap gap-2">
            <ActionButton action="copy" context="security" accessibleLabel="Copy authenticator secret" controlSize="compact" onClick={() => void copySecret()} />
            {provisioningUri && (
              <a
                href={provisioningUri}
                className="inline-flex items-center gap-1 font-utility text-regular font-medium text-accent-300 underline underline-offset-4 hover:text-accent-200"
              >
                Open otpauth:// <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </div>
          <Field label="Verification code">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              autoComplete="one-time-code"
              className={inputCls}
            />
          </Field>
          <div className="flex gap-2">
            <ActionButton action="enable" context="security" accessibleLabel="Enable authenticator app" loading={busy} disabled={!code.trim()} onClick={() => void confirmEnable()} />
            <ActionButton
              action="cancel"
              context="dialog"
              onClick={() => {
                closeDialog();
              }}
              accessibleLabel="Cancel authenticator setup"
            />
          </div>
            </div>
          )}

          {phase === "backup" && (
            <div className="space-y-3">
          <p className="text-compact text-warning-200/90">
            Save these backup codes now — each works once if you lose your authenticator.
          </p>
          <ul className="rounded-sm bg-zinc-800 px-3 py-2 font-code text-regular text-content-primary space-y-1">
            {/* design-system-exempt: code-list — recovery codes preserve ordered code semantics. */}
            {backupCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <ActionButton action="copy" context="security" accessibleLabel="Copy backup codes" onClick={() => void copyBackup()} />
            <ActionButton action="done" context="security" accessibleLabel="Finish authenticator setup"
              onClick={() => {
                closeDialog();
              }}
            />
          </div>
            </div>
          )}

          {phase === "disable" && (
            <div className="space-y-3">
          <p className="text-compact text-content-muted">
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
            <ActionButton
              action="disable"
              context="security"
              accessibleLabel="Confirm turning off authenticator app"
              loading={busy}
              disabled={busy || !code.trim()}
              onClick={() => void confirmDisable()}
            />
            <ActionButton
              action="cancel"
              context="dialog"
              onClick={() => {
                closeDialog();
              }}
              accessibleLabel="Cancel turning off authenticator app"
            />
          </div>
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}

/** Passkey list / add / delete — mirrors iOS PasskeySettingsView. */
export function PasskeyCard() {
  const [addOpen, setAddOpen] = useState(false);
  const [available, setAvailable] = useState(false);
  const [rpId, setRpId] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<PasskeyCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");

  function closeAddDialog() {
    if (busy) return;
    setName("");
    setAddOpen(false);
  }

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
      setAddOpen(false);
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
    <section className="border-t border-zinc-600/70 py-5">
      <p className="text-regular font-medium text-content-secondary flex items-center gap-2 mb-1">
        <Fingerprint className="w-4 h-4 text-accent-400" /> Passkeys
      </p>
      <p className="text-compact text-content-muted mb-4">
        Sign in with Face ID, Touch ID, or a device passkey when 2FA is required.
      </p>

      <p className="text-regular text-content-secondary mb-3">
        Status:{" "}
        <span className={available ? "text-success-400" : "text-content-muted"}>
          {loading ? "…" : available ? "Available" : "Not configured on server"}
        </span>
        {rpId && (
          <span className="ml-2 font-code text-compact text-content-muted">{rpId}</span>
        )}
      </p>

      {loading ? (
        <p className="text-compact text-content-muted">Loading…</p>
      ) : credentials.length === 0 ? (
        <p className="text-compact text-content-muted mb-3">No passkeys yet.</p>
      ) : (
        <ItemList presentationLevel="medium" controlSize="regular" className="mb-4">
          {credentials.map((c) => (
            <OperationsItem
              key={c.credential_pk}
              title={`${c.name} · added ${c.created_at.slice(0, 10)}`}
              trailing={c.last_used_at ? <span className="text-compact text-content-muted">Used {c.last_used_at.slice(0, 10)}</span> : undefined}
              actions={<ActionButton action="delete" context="toolbar" accessibleLabel={`Delete passkey ${c.name}`} onClick={() => void remove(c.credential_pk)} />}
            />
          ))}
        </ItemList>
      )}

      {available && <ActionButton action="add" context="security" accessibleLabel="Add passkey" onClick={() => setAddOpen(true)} />}
      {addOpen && (
        <Dialog title="Add passkey" onClose={closeAddDialog}>
          <p className="text-caption">Give this passkey an optional device name before the system security prompt opens.</p>
          <Field label="Name (optional)" htmlFor="passkey-name">
            <Input id="passkey-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="This MacBook" />
          </Field>
          <div className="flex justify-end gap-2">
            <ActionButton action="cancel" context="dialog" onClick={closeAddDialog} disabled={busy} />
            <ActionButton action="add" context="security" accessibleLabel="Add passkey" loading={busy} onClick={() => void add()} />
          </div>
        </Dialog>
      )}
    </section>
  );
}
