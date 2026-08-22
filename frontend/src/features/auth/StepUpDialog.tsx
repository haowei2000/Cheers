import { useEffect, useState } from "react";
import { Fingerprint, KeyRound, Mail, ShieldCheck } from "lucide-react";
import { errorMessage } from "@/api/client";
import {
  cancelStepUpFlow,
  sendStepUpEmail,
  startStepUpFlow,
  stepUpPasskeyOptions,
  verifyStepUpCode,
  verifyStepUpPasskey,
  verifyStepUpPassword,
  type StepUpFlowResponse,
} from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  cancelStepUp,
  completeStepUp,
  pendingStepUpActionClass,
  StepUpCancelledError,
  usePendingStepUpId,
} from "@/lib/stepUpCoordinator";
import { getPasskey } from "@/lib/webauthn";
import type { ActionKey } from "@/components/ui/action-labels";

type FlowResponse = StepUpFlowResponse;

type Method = "password" | "email" | "totp" | "recovery_code";

export function StepUpDialog() {
  const requestId = usePendingStepUpId();
  const [flow, setFlow] = useState<FlowResponse | null>(null);
  const [method, setMethod] = useState<Method | null>(null);
  const [value, setValue] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (requestId === null) return;
    let active = true;
    setFlow(null);
    setMethod(null);
    setValue("");
    setEmailSent(false);
    setError("");
    void startStepUpFlow(pendingStepUpActionClass()).then((next) => {
      if (active) setFlow(next);
    }).catch((reason) => {
      if (!active) return;
      cancelStepUp(new StepUpCancelledError(errorMessage(reason, "Could not start identity confirmation")));
    });
    return () => { active = false; };
  }, [requestId]);

  if (requestId === null) return null;

  const close = () => {
    if (busy) return;
    if (flow?.transaction_id) {
      void cancelStepUpFlow(flow.transaction_id).catch(() => undefined);
    }
    cancelStepUp();
  };

  const finish = (response: FlowResponse) => {
    if (response.status === "verified") completeStepUp();
    else {
      setFlow(response);
      setMethod(response.methods?.includes("totp") ? "totp" : "recovery_code");
      setValue("");
    }
  };

  const run = async (work: () => Promise<FlowResponse>) => {
    setBusy(true);
    setError("");
    try {
      finish(await work());
    } catch (reason) {
      setError(errorMessage(reason, "Identity confirmation failed"));
    } finally {
      setBusy(false);
    }
  };

  const usePasskey = () => void run(async () => {
    const options = await stepUpPasskeyOptions(flow!.transaction_id);
    const credential = await getPasskey(options);
    return verifyStepUpPasskey(flow!.transaction_id, credential);
  });

  const submitCode = () => void run(() => method === "password"
    ? verifyStepUpPassword(flow!.transaction_id, value)
    : verifyStepUpCode(flow!.transaction_id, method!, value));

  const sendEmail = () => {
    setBusy(true);
    setError("");
    void sendStepUpEmail(flow!.transaction_id).then(() => {
      setEmailSent(true);
      setValue("");
    }).catch((reason) => {
      setError(errorMessage(reason, "Could not send a verification code"));
    }).finally(() => setBusy(false));
  };

  const methods = flow?.methods ?? [];
  return (
    <Dialog title="Confirm it's you" onClose={close} maxWidth="max-w-sm">
      <p className="text-regular text-content-secondary">
        Confirm your identity to continue this sensitive action. Your session and current work stay open.
      </p>

      {!flow && <p className="text-regular text-content-muted">Preparing verification…</p>}

      {flow && !method && (
        <div className="space-y-2">
          {methods.includes("passkey") && (
            <Button action="usePasskey" variant="emphasis" controlWidth="fill" content="iconText" onClick={usePasskey} loading={busy}>
              <Fingerprint className="h-4 w-4" />
            </Button>
          )}
          <p className="pt-1 text-compact font-medium text-content-muted">Try another method</p>
          {methods.includes("password") && <MethodButton icon={KeyRound} action="changePassword" onClick={() => setMethod("password")} />}
          {methods.includes("totp") && <MethodButton icon={ShieldCheck} action="authenticator" onClick={() => setMethod("totp")} />}
          {methods.includes("email") && <MethodButton icon={Mail} action="emailCode" onClick={() => setMethod("email")} />}
        </div>
      )}

      {flow && method && (
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); submitCode(); }}>
          {method === "email" && !emailSent ? (
            <Button action="sendCode" type="button" variant="secondary" controlWidth="fill" onClick={sendEmail} loading={busy} />
          ) : (
            <>
              <Input
                type={method === "password" ? "password" : "text"}
                inputMode={method === "password" ? undefined : "numeric"}
                autoComplete={method === "password" ? "current-password" : "one-time-code"}
                placeholder={method === "password" ? "Password" : "Verification or recovery code"}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                disabled={busy}
              />
              <Button action="continue" type="submit" variant="emphasis" controlWidth="fill" disabled={!value.trim()} loading={busy} />
            </>
          )}
          <Button action="anotherMethod" type="button" variant="plain" controlWidth="fill" onClick={() => { setMethod(null); setValue(""); setEmailSent(false); setError(""); }} />
        </form>
      )}

      {error && <p role="alert" className="text-regular text-danger-400">{error}</p>}
    </Dialog>
  );
}

function MethodButton({ icon: Icon, action, onClick }: {
  icon: typeof KeyRound;
  action: ActionKey;
  onClick: () => void;
}) {
  return (
    <Button action={action} variant="secondary" controlWidth="fill" content="iconText" onClick={onClick}>
      <Icon className="h-4 w-4" />
    </Button>
  );
}
