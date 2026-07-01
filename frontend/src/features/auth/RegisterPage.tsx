import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { register } from "@/api/auth";
import { useAuthStore } from "@/stores/authStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function RegisterPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [form, setForm] = useState({
    username: "",
    display_name: "",
    email: "",
    password: "",
    confirm: "",
  });
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.username.trim() || form.password.length < 8) {
      toast.error("A username and an 8+ character password are required");
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) {
      toast.error("A valid email is required");
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
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
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
            <Input
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              value={form.email}
              onChange={set("email")}
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
            disabled={!form.username.trim() || !form.email.trim() || !form.password}
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
