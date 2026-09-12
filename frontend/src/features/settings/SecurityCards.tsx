import { ButtonGroup } from "@/components/ui/button-group";
import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight,
  ExternalLink,
  Fingerprint,
  LifeBuoy,
  Mail,
  KeyRound,
  Laptop,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
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
  listTrustedDevices,
  regenerateRecoveryCodes,
  revokeAllTrustedDevices,
  revokeTrustedDevice,
  setEmailTwoFactor,
  setPasswordTwoFactor,
  setupTwoFactor,
  twoFactorStatus,
  type PasskeyCredential,
  type TrustedDevice,
  type TwoFactorMethods,
  type TwoFactorStatus,
} from "@/api/auth";
import { createPasskey, passkeyTransactionId } from "@/lib/webauthn";
import { ActionButton } from "@/components/ui/action-button";
import { Dialog } from "@/components/ui/dialog";
import { ItemList, OperationsItem } from "@/components/ui/item";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { CollectionConfirmationItem } from "@/components/ui/collection-manager";

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

/** Row subtitle naming the armed factors, so the card says how the account is
 * protected rather than only that it is. */
export function twoFactorSummary(methods: TwoFactorMethods | undefined): string {
  if (!methods) return "Require another verification step when you sign in";
  const armed = [
    methods.passkey ? "passkey" : null,
    methods.totp ? "authenticator app" : null,
    methods.email ? "email code" : null,
    methods.password ? "password" : null,
  ].filter((name): name is string => name !== null);
  if (!armed.length) return "Use a passkey, an authenticator app, or an email code";
  return `Using ${armed.join(", ")}`;
}

/** On/Off marker for one second factor, matching the card's own status voice. */
function MethodState({ on }: { on: boolean }) {
  return (
    <span className={on ? "text-success-400" : "text-content-muted"}>
      {on ? "On" : "Off"}
    </span>
  );
}

/** Two-step verification. Any armed method — authenticator app, passkey, or
 * emailed code — turns it on and can complete the second step at sign-in; the
 * account is not required to enrol an authenticator first. */
export function TwoFactorCard() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [phase, setPhase] = useState<"overview" | "setup" | "backup" | "disable">("overview");
  const [secret, setSecret] = useState("");
  const [provisioningUri, setProvisioningUri] = useState("");
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [qrCodeFailed, setQrCodeFailed] = useState(false);
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    twoFactorStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
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

  const methods = status?.methods;
  const enabled = status?.enabled ?? false;

  function closeDialog() {
    if (busy) return;
    setPhase("overview");
    setSecret("");
    setProvisioningUri("");
    setQrCodeDataUrl(null);
    setQrCodeFailed(false);
    setCode("");
    setBackupCodes([]);
    setOpen(false);
  }

  /** Freshly minted recovery codes are returned once, so show them immediately. */
  function afterArming(codes: string[], message: string) {
    reload();
    toast.success(message);
    if (codes.length) {
      setBackupCodes(codes);
      setPhase("backup");
    } else {
      setPhase("overview");
    }
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
      setCode("");
      afterArming(res.backup_codes, "Authenticator app is on");
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
      setCode("");
      setPhase("overview");
      reload();
      toast.success("Authenticator app removed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove the authenticator app");
    } finally {
      setBusy(false);
    }
  }

  async function toggleEmail() {
    if (!methods) return;
    const next = !methods.email;
    setBusy(true);
    try {
      const res = await setEmailTwoFactor(next);
      afterArming(res.backup_codes, next ? "Email codes are on" : "Email codes are off");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update email codes");
    } finally {
      setBusy(false);
    }
  }

  async function togglePassword() {
    if (!methods) return;
    const next = !methods.password;
    setBusy(true);
    try {
      const res = await setPasswordTwoFactor(next);
      afterArming(res.backup_codes, next ? "Password step is on" : "Password step is off");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update the password step");
    } finally {
      setBusy(false);
    }
  }

  async function newRecoveryCodes() {
    setBusy(true);
    try {
      const res = await regenerateRecoveryCodes();
      setBackupCodes(res.backup_codes);
      setPhase("backup");
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't generate recovery codes");
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
        subtitle={twoFactorSummary(methods)}
        criticalStatus={status ? <MethodState on={enabled} /> : undefined}
        trailing={<ChevronRight className="h-4 w-4 text-content-muted" aria-hidden="true" />}
        aria-label="Manage two-step verification"
        disabled={status == null}
        onClick={() => {
          setPhase("overview");
          setOpen(true);
        }}
      />
      {open && status && methods && (
        <Dialog title="Two-step verification" onClose={closeDialog}>
          {phase === "overview" && (
            <div className="space-y-3">
              <p className="text-caption">
                {enabled
                  ? "A second step is required when you sign in. Any method below can complete it."
                  : "Turn on any one method below. You do not need an authenticator app."}
              </p>
              <ItemList presentationLevel="medium" controlSize="regular">
                <OperationsItem
                  leading={<Fingerprint className="h-4 w-4 text-content-muted" />}
                  title="Passkey"
                  subtitle={
                    methods.passkey
                      ? "Armed by the passkeys on this account"
                      : "Add a passkey under Passkeys to turn this on"
                  }
                  criticalStatus={<MethodState on={methods.passkey} />}
                  aria-label="Passkey second factor"
                  disabled
                />
                <OperationsItem
                  leading={<Smartphone className="h-4 w-4 text-content-muted" />}
                  title="Authenticator app"
                  subtitle="Six-digit codes from an app on your phone"
                  criticalStatus={<MethodState on={methods.totp} />}
                  trailing={
                    <ChevronRight className="h-4 w-4 text-content-muted" aria-hidden="true" />
                  }
                  aria-label={
                    methods.totp ? "Remove the authenticator app" : "Set up an authenticator app"
                  }
                  disabled={busy}
                  onClick={() => {
                    setCode("");
                    if (methods.totp) setPhase("disable");
                    else void beginSetup();
                  }}
                />
                <OperationsItem
                  leading={<Mail className="h-4 w-4 text-content-muted" />}
                  title="Email code"
                  subtitle={
                    methods.email || status.email_available
                      ? "A one-time code sent to your address"
                      : "Add an email address and a password or passkey first"
                  }
                  criticalStatus={<MethodState on={methods.email} />}
                  trailing={
                    <ChevronRight className="h-4 w-4 text-content-muted" aria-hidden="true" />
                  }
                  aria-label={methods.email ? "Turn off email codes" : "Turn on email codes"}
                  disabled={busy || (!methods.email && !status.email_available)}
                  onClick={() => void toggleEmail()}
                />
                <OperationsItem
                  leading={<KeyRound className="h-4 w-4 text-content-muted" />}
                  title="Password"
                  subtitle={
                    methods.password || status.password_available
                      ? "Re-enter your password after signing in with a passkey or provider"
                      : "Needs a password plus a passkey or linked provider to sign in with first"
                  }
                  criticalStatus={<MethodState on={methods.password} />}
                  trailing={
                    <ChevronRight className="h-4 w-4 text-content-muted" aria-hidden="true" />
                  }
                  aria-label={methods.password ? "Turn off the password step" : "Turn on the password step"}
                  disabled={busy || (!methods.password && !status.password_available)}
                  onClick={() => void togglePassword()}
                />
                <OperationsItem
                  leading={<LifeBuoy className="h-4 w-4 text-content-muted" />}
                  title="Recovery codes"
                  subtitle={
                    enabled
                      ? `${status.recovery_codes_remaining} unused — they work when every other method is unavailable`
                      : "Generated when you turn on your first method"
                  }
                  criticalStatus={
                    <span
                      className={
                        status.recovery_codes_remaining > 0
                          ? "text-content-muted"
                          : "text-warning-200/90"
                      }
                    >
                      {status.recovery_codes_remaining}
                    </span>
                  }
                  trailing={
                    <ChevronRight className="h-4 w-4 text-content-muted" aria-hidden="true" />
                  }
                  aria-label="Generate new recovery codes"
                  disabled={busy || !enabled}
                  onClick={() => void newRecoveryCodes()}
                />
              </ItemList>
            </div>
          )}

          {phase === "setup" && (
            <div className="space-y-3">
          <div>
            <p className="text-regular font-semibold text-content-primary">Authenticator app</p>
            <p className="mt-1 text-compact text-content-muted">
              Scan the QR code with your authenticator app. This is one way to turn on two-step verification; a passkey or an email code works too.
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
            <ActionButton action="enable" context="security" accessibleLabel="Turn on the authenticator app" loading={busy} disabled={!code.trim()} onClick={() => void confirmEnable()} />
            <ActionButton
              action="back"
              context="dialog"
              onClick={() => {
                setCode("");
                setPhase("overview");
              }}
              accessibleLabel="Back to two-step verification methods"
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
                setBackupCodes([]);
                setPhase("overview");
              }}
            />
          </div>
            </div>
          )}

          {phase === "disable" && (
            <div className="space-y-3">
          <p className="text-compact text-content-muted">
            Enter an authenticator or recovery code to remove the authenticator app. Your other methods keep protecting this account.
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
              accessibleLabel="Confirm removing the authenticator app"
              loading={busy}
              disabled={busy || !code.trim()}
              onClick={() => void confirmDisable()}
            />
            <ActionButton
              action="back"
              context="dialog"
              onClick={() => {
                setCode("");
                setPhase("overview");
              }}
              accessibleLabel="Back to two-step verification methods"
            />
          </div>
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}

/** Devices that skip the second step at sign-in.
 *
 * These used to be invisible 30-day state: you ticked "remember me" once and
 * had no way to see or undo it. Arming a factor now revokes them all, and this
 * card covers the rest — a shared laptop you want challenged again. */
export function TrustedDevicesCard() {
  const [devices, setDevices] = useState<TrustedDevice[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<TrustedDevice | "all" | null>(null);

  const reload = useCallback(() => {
    setLoadError(false);
    setDevices(null);
    listTrustedDevices()
      .then(setDevices)
      .catch(() => setLoadError(true));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function revokeOne(device: TrustedDevice) {
    setBusy(true);
    try {
      await revokeTrustedDevice(device.trusted_device_id);
      toast.success("This device will be asked to verify again");
      setRevokeTarget(null);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't revoke this device");
    } finally {
      setBusy(false);
    }
  }

  async function revokeAll() {
    setBusy(true);
    try {
      const res = await revokeAllTrustedDevices();
      toast.success(`${res.revoked} device${res.revoked === 1 ? "" : "s"} will verify again`);
      setRevokeTarget(null);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't revoke devices");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-t border-zinc-600/70 py-5">
      <div className="mb-4 min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex items-center gap-2 text-regular font-medium text-content-secondary">
            <Laptop className="h-4 w-4 text-content-muted" /> Remembered devices
            {devices != null && devices.length > 0 && (
              <span className="text-compact font-normal text-content-muted">
                {devices.length} remembered
              </span>
            )}
          </p>
          {devices != null && devices.length > 0 && (
            <ButtonGroup label="Remembered device actions">
              <ActionButton
                action="revoke"
                context="security"
                accessibleLabel="Ask every device to verify again"
                loading={busy}
                disabled={busy || revokeTarget !== null}
                onClick={() => setRevokeTarget("all")}
              />
            </ButtonGroup>
          )}
        </div>
        <p className="mt-1 text-compact text-content-muted">
          These devices skip the second step for 30 days. Turning on a new verification method clears the list.
        </p>
      </div>

      {loadError ? (
        <ItemList presentationLevel="medium" controlSize="regular">
          <OperationsItem
            title="Couldn't load remembered devices"
            subtitle="The current remembered-device status is unavailable."
            actions={
              <ActionButton
                action="retry"
                context="settings"
                accessibleLabel="Retry loading remembered devices"
                onClick={reload}
              />
            }
          />
        </ItemList>
      ) : devices == null ? (
        <p className="text-compact text-content-muted">Loading…</p>
      ) : devices.length === 0 ? (
        <p className="text-compact text-content-muted">No remembered devices.</p>
      ) : (
        <ItemList presentationLevel="medium" controlSize="regular">
          {revokeTarget === "all" && (
            <CollectionConfirmationItem
              title="Every remembered device"
              description="Every remembered device will need the second verification step again."
              action="revoke"
              prompt="Revoke all?"
              busy={busy}
              onCancel={() => setRevokeTarget(null)}
              onConfirm={() => void revokeAll()}
            />
          )}
          {devices.map((d) => (
            revokeTarget !== "all" && revokeTarget?.trusted_device_id === d.trusted_device_id ? (
              <CollectionConfirmationItem
                key={d.trusted_device_id}
                title={d.device_name || "Unnamed device"}
                description="This device will need the second verification step again."
                action="revoke"
                prompt="Revoke?"
                busy={busy}
                onCancel={() => setRevokeTarget(null)}
                onConfirm={() => void revokeOne(d)}
              />
            ) : (
              <OperationsItem
                key={d.trusted_device_id}
                title={`${d.device_name || "Unnamed device"}${d.current ? " · this device" : ""}`}
                subtitle={`Expires ${new Date(d.expires_at).toLocaleDateString()}`}
                trailing={
                  <span className="text-compact text-content-muted">
                    {d.last_used_at
                      ? `Used ${new Date(d.last_used_at).toLocaleDateString()}`
                      : `Added ${new Date(d.created_at).toLocaleDateString()}`}
                  </span>
                }
                actions={
                  <ActionButton
                    action="revoke"
                    context="security"
                    accessibleLabel={`Stop remembering ${d.device_name || "this device"}`}
                    disabled={busy || revokeTarget !== null}
                    onClick={() => setRevokeTarget(d)}
                  />
                }
              />
            )
          ))}
        </ItemList>
      )}
    </section>
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
  const [newRecoveryCodes, setNewRecoveryCodes] = useState<string[]>([]);

  async function copyNewRecoveryCodes() {
    try {
      await navigator.clipboard.writeText(newRecoveryCodes.join("\n"));
      toast.success("Recovery codes copied");
    } catch {
      toast.error("Clipboard unavailable");
    }
  }

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
      const res = await passkeyRegisterFinish(transactionId, credential);
      setName("");
      setAddOpen(false);
      // A first passkey turns two-step verification on by itself, and the server
      // mints recovery codes once. Losing the only passkey must not lock you out.
      if (res.backup_codes.length) {
        setNewRecoveryCodes(res.backup_codes);
        toast.success("Passkey added — two-step verification is on");
      } else {
        toast.success("Passkey added");
      }
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
      <div className="mb-4 min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex items-center gap-2 text-regular font-semibold text-content-primary">
            <Fingerprint className="h-4 w-4 text-accent-400" /> Passkeys
            {!loading && available && (
              <span className="text-compact font-normal text-content-muted">
                {credentials.length} added
              </span>
            )}
          </p>
          {available && (
            <ButtonGroup label="Passkey actions">
              <ActionButton
                action="add"
                context="security"
                accessibleLabel="Add passkey"
                onClick={() => setAddOpen(true)}
              />
            </ButtonGroup>
          )}
        </div>
        <p className="mt-1 text-compact text-content-muted">
          {loading
            ? "Loading passkeys…"
            : available
              ? "Use Face ID, Touch ID, or your device lock for verification."
              : "Passkeys are not configured on this server."}
          {rpId && <span className="ml-2 font-code">{rpId}</span>}
        </p>
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

      {newRecoveryCodes.length > 0 && (
        <Dialog title="Save your recovery codes" onClose={() => setNewRecoveryCodes([])}>
          <div className="space-y-3">
            <p className="text-compact text-warning-200/90">
              This passkey turned on two-step verification. Save these recovery codes now — each works once if you lose access to your passkey.
            </p>
            <ul className="rounded-sm bg-zinc-800 px-3 py-2 font-code text-regular text-content-primary space-y-1">
              {/* design-system-exempt: code-list — recovery codes preserve ordered code semantics. */}
              {newRecoveryCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <ActionButton action="copy" context="security" accessibleLabel="Copy recovery codes" onClick={() => void copyNewRecoveryCodes()} />
              <ActionButton action="done" context="security" accessibleLabel="Finish saving recovery codes" onClick={() => setNewRecoveryCodes([])} />
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
