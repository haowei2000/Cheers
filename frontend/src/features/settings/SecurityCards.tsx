import { useCallback, useEffect, useState } from "react";
import { ChevronRight, ExternalLink, Fingerprint, ShieldCheck } from "lucide-react";
import QRCode from "qrcode";
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

export function authenticatorQrDataUrl(provisioningUri: string): Promise<string> {
  if (!provisioningUri.startsWith("otpauth://totp/")) {
    return Promise.reject(new Error("Invalid authenticator provisioning URI"));
  }
  return QRCode.toDataURL(provisioningUri, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 192,
    color: { dark: "#111111", light: "#ffffff" },
  });
}

/** Two-step verification entry point. TOTP enables the policy; login can then
 * use any enrolled/available factor (TOTP, recovery code, email, or passkey). */
export function TwoFactorCard() {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<"idle" | "setup" | "backup" | "disable">("idle");
  const [secret, setSecret] = useState("");
  const [provisioningUri, setProvisioningUri] = useState("");
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [qrCodeFailed, setQrCodeFailed] = useState(false);
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

  useEffect(() => {
    if (!provisioningUri) {
      setQrCodeDataUrl(null);
      setQrCodeFailed(false);
      return;
    }
    let active = true;
    setQrCodeDataUrl(null);
    setQrCodeFailed(false);
    void authenticatorQrDataUrl(provisioningUri)
      .then((dataUrl) => {
        if (active) setQrCodeDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) setQrCodeFailed(true);
      });
    return () => {
      active = false;
    };
  }, [provisioningUri]);

  function closeDialog() {
    if (busy) return;
    setPhase("idle");
    setSecret("");
    setProvisioningUri("");
    setQrCodeDataUrl(null);
    setQrCodeFailed(false);
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
      toast.error(e instanceof Error ? e.message : "Couldn't start two-step verification");
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
      toast.success("Two-step verification is on");
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
      toast.success("Two-step verification is off");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't turn off two-step verification");
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
      <OperationsItem
        leading={<ShieldCheck className="h-4 w-4 text-content-muted" />}
        title="Two-step verification"
        subtitle={enabled
          ? "Use an authenticator, email code, passkey, or recovery code"
          : "Require another verification step when you sign in"}
        criticalStatus={enabled != null ? (
          <span className={enabled ? "text-success-400" : "text-content-muted"}>
            {enabled ? "On" : "Off"}
          </span>
        ) : undefined}
        trailing={<ChevronRight className="h-4 w-4 text-content-muted" aria-hidden="true" />}
        aria-label={enabled ? "Manage two-step verification" : "Set up two-step verification"}
        disabled={enabled == null}
        onClick={() => {
          setOpen(true);
          if (!enabled) void beginSetup();
        }}
      />
      {open && (
        <Dialog title="Two-step verification" onClose={closeDialog}>
          {phase === "idle" && enabled && (
            <div className="space-y-3">
              <p className="text-caption">
                An extra verification step is required at sign-in. Use any method offered for your account: authenticator app, email code, passkey, or recovery code.
              </p>
              <ActionButton action="disable" context="security" accessibleLabel="Turn off two-step verification" onClick={() => { setCode(""); setPhase("disable"); }} />
            </div>
          )}
          {phase === "idle" && !enabled && (
            <p className="text-caption">{busy ? "Preparing two-step verification…" : "Setup could not be started. Close this dialog and try again."}</p>
          )}

          {phase === "setup" && (
            <div className="space-y-3">
          <div>
            <p className="text-regular font-medium text-content-secondary">Authenticator app</p>
            <p className="mt-1 text-compact text-content-muted">
              Scan the QR code with your authenticator app. This turns on two-step verification; other available methods can also complete the second step.
            </p>
          </div>
          <div className="grid grid-cols-[12rem_minmax(0,1fr)] items-start gap-4 max-sm:grid-cols-1">
            <div className="flex h-48 w-48 items-center justify-center rounded-sm bg-white" aria-live="polite">
              {qrCodeDataUrl ? (
                <img
                  src={qrCodeDataUrl}
                  alt="QR code for adding Cheers to an authenticator app"
                  width={192}
                  height={192}
                  className="h-48 w-48 rounded-sm"
                />
              ) : qrCodeFailed ? (
                <span className="px-4 text-center text-compact text-content-on-light">
                  QR code unavailable. Use the setup key.
                </span>
              ) : (
                <span className="px-4 text-center text-compact text-content-on-light">
                  Generating QR code…
                </span>
              )}
            </div>
            <div className="min-w-0 space-y-2">
              <p className="text-compact font-medium text-content-secondary">Can&apos;t scan it?</p>
              <div className="rounded-sm bg-zinc-800 px-3 py-2 font-code text-regular text-content-primary break-all">
                {secret}
              </div>
              <div className="flex flex-wrap gap-2">
                <ActionButton action="copy" context="security" accessibleLabel="Copy authenticator secret" controlSize="compact" onClick={() => void copySecret()} />
                {provisioningUri && (
                  <a
                    href={provisioningUri}
                    className="inline-flex min-h-11 items-center gap-1 font-utility text-regular font-medium text-accent-300 underline underline-offset-4 hover:text-accent-200"
                  >
                    Open authenticator app <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                )}
              </div>
            </div>
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
            <ActionButton action="enable" context="security" accessibleLabel="Turn on two-step verification" loading={busy} disabled={!code.trim()} onClick={() => void confirmEnable()} />
            <ActionButton
              action="cancel"
              context="dialog"
              onClick={() => {
                closeDialog();
              }}
              accessibleLabel="Cancel two-step verification setup"
            />
          </div>
            </div>
          )}

          {phase === "backup" && (
            <div className="space-y-3">
          <p className="text-compact text-warning-200/90">
            Save these recovery codes now. Each code works once when your other verification methods are unavailable.
          </p>
          <ul className="rounded-sm bg-zinc-800 px-3 py-2 font-code text-regular text-content-primary space-y-1">
            {/* design-system-exempt: code-list — recovery codes preserve ordered code semantics. */}
            {backupCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <ActionButton action="copy" context="security" accessibleLabel="Copy recovery codes" onClick={() => void copyBackup()} />
            <ActionButton action="done" context="security" accessibleLabel="Finish two-step verification setup"
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
            Enter an authenticator or recovery code to turn off two-step verification.
          </p>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Authenticator or recovery code"
            autoComplete="one-time-code"
            className={inputCls}
          />
          <div className="flex gap-2">
            <ActionButton
              action="disable"
              context="security"
              accessibleLabel="Confirm turning off two-step verification"
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
              accessibleLabel="Cancel turning off two-step verification"
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
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-regular font-medium text-content-secondary">
            <Fingerprint className="h-4 w-4 text-accent-400" /> Passkeys
            {!loading && available && (
              <span className="text-compact font-normal text-content-muted">
                {credentials.length} added
              </span>
            )}
          </p>
          <p className="mt-1 text-compact text-content-muted">
            {loading
              ? "Loading passkeys…"
              : available
                ? "Use Face ID, Touch ID, or your device lock for verification."
                : "Passkeys are not configured on this server."}
            {rpId && <span className="ml-2 font-code">{rpId}</span>}
          </p>
        </div>
        {available && (
          <ActionButton action="add" context="security" accessibleLabel="Add passkey" onClick={() => setAddOpen(true)} />
        )}
      </div>

      {loading ? (
        null
      ) : credentials.length === 0 ? (
        available ? <p className="text-compact text-content-muted">No passkeys added.</p> : null
      ) : (
        <ItemList presentationLevel="medium" controlSize="regular">
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
