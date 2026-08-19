import { AlertTriangle, Globe2, Hourglass, Laptop, PackageCheck, ShieldCheck } from "lucide-react";
import { Banner } from "@/components/ui/banner";
import { Button as UiButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  expandedPermissions,
  installDisposition,
  permissionSummary,
  type ExtensionInstallCandidate,
  type InstalledExtensionIdentity,
} from "./extensionInstall";

export function ExtensionInstallDialog({
  candidate,
  installed,
  busy,
  onConfirm,
  onClose,
}: {
  candidate: ExtensionInstallCandidate;
  installed?: InstalledExtensionIdentity;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { extension } = candidate;
  const manifest = extension.manifest;
  const disposition = installDisposition(extension, installed);
  const permissions = permissionSummary(manifest);
  const expanded = expandedPermissions(manifest.permissions ?? {}, installed?.permissions);
  const temporary = candidate.scope === "temporary";
  const action = temporary ? "Load" : disposition === "update" ? "Update" : disposition === "replace" ? "Replace" : "Install";
  const scope = candidate.scope === "global" ? "Global · all clients" : temporary ? "This session only" : "This Mac";

  return <Dialog title={`${action} ${manifest.title}`} onClose={() => !busy && onClose()} maxWidth="max-w-lg">
    <div className="flex items-start gap-3 rounded-sm bg-zinc-950/40 px-3 py-3">
      {candidate.scope === "global" ? <Globe2 className="mt-1 h-4 w-4 text-accent-300" /> : temporary ? <Hourglass className="mt-1 h-4 w-4 text-warning-300" /> : <Laptop className="mt-1 h-4 w-4 text-success-300" />}
      <div className="min-w-0 flex-1">
        <p className="text-regular font-medium text-content-primary">{manifest.title} · {manifest.version}</p>
        <p className="mt-1 text-compact text-content-muted">{scope} · {candidate.sourceLabel}</p>
        {manifest.description && <p className="mt-2 text-compact text-content-secondary">{manifest.description}</p>}
      </div>
    </div>

    {disposition === "already" && <Banner severity="success" icon={PackageCheck}>This exact package is already installed.</Banner>}
    {disposition === "replace" && <Banner severity="warning" icon={AlertTriangle}>The installed version is {installed?.version}. This package is not a newer SemVer release and will replace the existing bytes.</Banner>}
    {manifest.permissions?.network === "unrestricted" && <Banner severity="warning" icon={AlertTriangle}>This renderer may send rendered content to any HTTP(S) or WebSocket destination.</Banner>}
    {expanded.length > 0 && installed && <Banner severity="warning" icon={ShieldCheck}>New permissions: {expanded.join(", ")}</Banner>}

    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-sm bg-zinc-950/30 px-3 py-3 text-compact">
      <dt className="text-content-muted">Contributes</dt><dd className="text-content-secondary">{manifest.contributes.scenes?.length ?? 0} scenes · {manifest.contributes.renderers?.length ?? 0} renderers · {manifest.contributes.automations?.length ?? 0} automations</dd>
      <dt className="text-content-muted">Permissions</dt><dd className="break-words text-content-secondary">{permissions.length ? permissions.join(", ") : "None"}</dd>
      <dt className="text-content-muted">Network</dt><dd className="text-content-secondary">{manifest.permissions?.network === "unrestricted" ? "Unrestricted" : "Blocked by CSP"}</dd>
      <dt className="text-content-muted">SHA-256</dt><dd className="break-all font-code text-minimal text-content-muted">{extension.sha256}</dd>
    </dl>

    <p className="text-compact text-content-muted">{temporary
      ? "Loading activates this package for the current session only — nothing is stored, and it is gone when you reload. Its renderer runs as soon as a file selects it."
      : "Installation validates and stores the package without running code. A personal renderer starts only after you select it for a file."}</p>
    <div className="flex justify-end gap-2">
      <UiButton action="cancel" content="text" variant="secondary" controlSize="regular" disabled={busy} onClick={onClose}>{disposition === "already" ? "Close" : "Cancel"}</UiButton>
      {disposition !== "already" && <UiButton action={temporary ? "loadTemporarily" : disposition === "update" ? "update" : "install"} content="text" variant={disposition === "replace" ? "danger" : "primary"} controlSize="regular" disabled={busy} onClick={onConfirm}>{busy ? `${action}…` : action}</UiButton>}
    </div>
  </Dialog>;
}
