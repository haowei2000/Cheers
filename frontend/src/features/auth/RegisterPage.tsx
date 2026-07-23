import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { register, requestRegisterCode } from "@/api/auth";
import { acceptInviteLink } from "@/api/invites";
import { useAuthStore } from "@/stores/authStore";
import { useChatStore } from "@/stores/chatStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function RegisterPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Invite-link token (from /invite/:token): lets sign-up through even when the
  // instance has open registration disabled, then auto-joins the workspace.
  const inviteToken = params.get("invite") ?? "";
  const selectWorkspace = useChatStore((s) => s.selectWorkspace);
  const selectChannel = useChatStore((s) => s.selectChannel);
  const setAuth = useAuthStore((s) => s.setAuth);
  const [form, setForm] = useState({
    username: "",
    display_name: "",
    email: "",
    code: "",
    password: "",
    confirm: "",
  });
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [cooldown, setCooldown] = useState(0); // seconds until "resend" is allowed
  // Per-field client-validation messages shown inline under the offending field,
  // so people fix the problem while the context is fresh (HIG: validate on blur).
  // Server-side failures still surface via toast.
  const [errors, setErrors] = useState<Partial<Record<keyof typeof form, string>>>({});
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    // Clear a field's error the moment the user edits it — the red ring shouldn't
    // linger while they're mid-correction. Editing the password also clears a stale
    // "Passwords don't match" on confirm, since it may now match again.
    setErrors((prev) => {
      if (!prev[k] && !(k === "password" && prev.confirm)) return prev;
      const nextErrors = { ...prev, [k]: undefined };
      if (k === "password") nextErrors.confirm = undefined;
      return nextErrors;
    });
  };

  // Validate the cheap-to-fix fields on blur. Only flag non-empty values —
  // emptiness is already gated by the disabled submit button, so an error on an
  // untouched-but-blurred field would be premature.
  const validateEmail = () => {
    const v = form.email.trim();
    setErrors((e) => ({ ...e, email: v && !EMAIL_RE.test(v) ? "Enter a valid email address" : undefined }));
  };
  const validatePassword = () => {
    setErrors((e) => ({
      ...e,
      password: form.password && form.password.length < 12 ? "Use at least 12 characters" : undefined,
    }));
  };
  const validateConfirm = () => {
    setErrors((e) => ({
      ...e,
      confirm: form.confirm && form.confirm !== form.password ? "Passwords don't match" : undefined,
    }));
  };

  // Tick down the resend cooldown once a code has been sent.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function sendCode() {
    if (!EMAIL_RE.test(form.email.trim())) {
      toast.error("Enter a valid email first");
      return;
    }
    setSendingCode(true);
    try {
      await requestRegisterCode(form.email.trim(), inviteToken || undefined);
      toast.success("Verification code sent — check your inbox");
      setCooldown(60);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send code");
    } finally {
      setSendingCode(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Client-side checks anchor to the offending field inline rather than firing a
    // detached toast, so the message sits where the fix happens.
    const email = form.email.trim();
    const nextErrors: Partial<Record<keyof typeof form, string>> = {};
    if (!email || !EMAIL_RE.test(email)) nextErrors.email = "Enter a valid email address";
    if (form.password.length < 12) nextErrors.password = "Use at least 12 characters";
    if (form.password !== form.confirm) nextErrors.confirm = "Passwords don't match";
    if (Object.keys(nextErrors).length > 0) {
      setErrors((prev) => ({ ...prev, ...nextErrors }));
      return;
    }
    // Username + code presence is already enforced by the disabled submit button;
    // this stays as a defensive backstop.
    if (!form.username.trim() || !form.code.trim()) {
      toast.error("Enter your username and the verification code we emailed you");
      return;
    }
    setErrors({});
    setLoading(true);
    try {
      const res = await register({
        username: form.username.trim(),
        password: form.password,
        email: form.email.trim(),
        code: form.code.trim(),
        display_name: form.display_name.trim() || undefined,
        invite_token: inviteToken || undefined,
      });
      if (!res.user_id || !res.access_token) throw new Error("Registration response is incomplete");
      setAuth(
        {
          user_id: res.user_id,
          display_name: res.display_name ?? null,
          username: form.username.trim(),
          role: res.role,
        },
        res.access_token
      );
      if (inviteToken) {
        // Redeem the invite with the fresh session so the new account lands in
        // the workspace. If the link died in the meantime, the landing page
        // explains why — the account itself is already created.
        try {
          const joined = await acceptInviteLink(inviteToken);
          toast.success("Welcome — you've joined the workspace 🎉");
          selectWorkspace(joined.workspace_id);
          if (joined.channel_joined && joined.channel_id) selectChannel(joined.channel_id);
        } catch {
          navigate(`/invite/${inviteToken}`, { replace: true });
          return;
        }
      }
      navigate("/chat", { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign-up failed");
    } finally {
      setLoading(false);
    }
  }

  const labelCls = "text-xs font-medium text-zinc-400 uppercase tracking-wide";
  return (
    <div className="h-full overflow-y-auto bg-zinc-950 flex justify-center p-4">
      <div className="w-full max-w-sm my-auto">
        <div className="flex flex-col items-center mb-8">
          <img src="/cheers-icon.svg" alt="" className="w-12 h-12 mb-4" aria-hidden="true" />
          <h1 className="text-2xl font-bold text-zinc-50 tracking-tight">Create your account</h1>
          <p className="text-zinc-400 text-sm mt-1">
            {inviteToken
              ? "You've been invited — your new account will join the workspace automatically."
              : "Join Cheers in a few seconds."}
          </p>
        </div>

        <form
          onSubmit={submit}
          className="bg-zinc-900 rounded-2xl p-6 shadow-xl space-y-4"
        >
          <div className="space-y-1.5">
            <label className={labelCls}>Username</label>
            <Input
              type="text"
              placeholder="jane"
              autoComplete="username"
              autoFocus
              value={form.username}
              onChange={set("username")}
            />
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>Display name (optional)</label>
            <Input type="text" placeholder="Jane Doe" value={form.display_name} onChange={set("display_name")} />
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>Email</label>
            <div className="flex gap-2">
              <Input
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                value={form.email}
                onChange={set("email")}
                onBlur={validateEmail}
                error={!!errors.email}
                aria-invalid={!!errors.email}
                aria-describedby={errors.email ? "email-error" : undefined}
              />
              <Button
                type="button"
                variant="secondary"
                className="shrink-0 whitespace-nowrap"
                loading={sendingCode}
                disabled={cooldown > 0 || !form.email.trim()}
                onClick={sendCode}
              >
                {cooldown > 0 ? `Resend ${cooldown}s` : "Send code"}
              </Button>
            </div>
            {errors.email && (
              <p id="email-error" role="alert" className="text-xs text-red-400">
                {errors.email}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>Verification code</label>
            <Input
              type="text"
              placeholder="8-character code"
              className="font-mono tracking-widest uppercase"
              value={form.code}
              onChange={set("code")}
            />
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>Password</label>
            <Input
              type="password"
              placeholder="min 12 characters"
              autoComplete="new-password"
              value={form.password}
              onChange={set("password")}
              onBlur={validatePassword}
              error={!!errors.password}
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? "password-error" : undefined}
            />
            {errors.password && (
              <p id="password-error" role="alert" className="text-xs text-red-400">
                {errors.password}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>Confirm password</label>
            <Input
              type="password"
              placeholder="repeat password"
              autoComplete="new-password"
              value={form.confirm}
              onChange={set("confirm")}
              onBlur={validateConfirm}
              error={!!errors.confirm}
              aria-invalid={!!errors.confirm}
              aria-describedby={errors.confirm ? "confirm-error" : undefined}
            />
            {errors.confirm && (
              <p id="confirm-error" role="alert" className="text-xs text-red-400">
                {errors.confirm}
              </p>
            )}
          </div>

          <Button
            type="submit"
            className="w-full mt-2"
            loading={loading}
            disabled={
              !form.username.trim() ||
              !form.email.trim() ||
              !form.code.trim() ||
              !form.password
            }
          >
            Create account
          </Button>

          <p className="text-center text-xs text-zinc-400">
            Already have an account?{" "}
            <Link to="/login" className="text-indigo-400 hover:text-indigo-300">
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
