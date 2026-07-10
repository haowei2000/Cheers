import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { register, requestRegisterCode } from "@/api/auth";
import { useAuthStore } from "@/stores/authStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function RegisterPage() {
  const navigate = useNavigate();
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
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

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
      await requestRegisterCode(form.email.trim());
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
    if (!form.username.trim() || form.password.length < 8) {
      toast.error("A username and an 8+ character password are required");
      return;
    }
    if (!EMAIL_RE.test(form.email.trim())) {
      toast.error("A valid email is required");
      return;
    }
    if (!form.code.trim()) {
      toast.error("Enter the verification code we emailed you");
      return;
    }
    if (form.password !== form.confirm) {
      toast.error("Passwords don't match");
      return;
    }
    setLoading(true);
    try {
      const res = await register({
        username: form.username.trim(),
        password: form.password,
        email: form.email.trim(),
        code: form.code.trim(),
        display_name: form.display_name.trim() || undefined,
      });
      setAuth(
        {
          user_id: res.user_id,
          display_name: res.display_name,
          username: form.username.trim(),
          role: res.role,
        },
        res.access_token
      );
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
          <p className="text-zinc-500 text-sm mt-1">Join Cheers in a few seconds.</p>
        </div>

        <form
          onSubmit={submit}
          className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800 shadow-xl space-y-4"
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
              placeholder="min 8 characters"
              autoComplete="new-password"
              value={form.password}
              onChange={set("password")}
            />
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>Confirm password</label>
            <Input
              type="password"
              placeholder="repeat password"
              autoComplete="new-password"
              value={form.confirm}
              onChange={set("confirm")}
            />
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

          <p className="text-center text-xs text-zinc-500">
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
