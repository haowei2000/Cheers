import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { login } from "@/api/auth";
import { useAuthStore } from "@/stores/authStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [form, setForm] = useState({ login: "", password: "" });
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.login || !form.password) return;
    setLoading(true);
    try {
      const res = await login(form);
      setAuth(
        {
          user_id: res.user_id,
          display_name: res.display_name,
          username: form.login,
          role: res.role,
        },
        res.access_token
      );
      navigate("/chat", { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    // h-full + internal scroll (the app root is overflow-hidden); my-auto centers the
    // card when it fits and lets it scroll when the on-screen keyboard shrinks the
    // viewport, instead of clipping the top.
    <div className="h-full overflow-y-auto bg-zinc-950 flex justify-center p-4">
      <div className="w-full max-w-sm my-auto">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4 shadow-lg shadow-indigo-500/20 overflow-hidden">
            <img
              src="/cheers-icon.svg"
              alt=""
              className="w-12 h-12"
              aria-hidden="true"
            />
          </div>
          <h1 className="text-2xl font-bold text-zinc-50 tracking-tight">
            Cheers
          </h1>
          <p className="text-zinc-500 text-sm mt-1">Sign in to continue</p>
        </div>

        {/* Card */}
        <form
          onSubmit={handleSubmit}
          className="bg-zinc-900 rounded-2xl p-6 shadow-xl space-y-4"
        >
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
              Username or Email
            </label>
            <Input
              type="text"
              placeholder="you@example.com"
              autoComplete="username"
              autoFocus
              value={form.login}
              onChange={(e) => setForm((f) => ({ ...f, login: e.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
              Password
            </label>
            <Input
              type="password"
              placeholder="••••••••"
              autoComplete="current-password"
              value={form.password}
              onChange={(e) =>
                setForm((f) => ({ ...f, password: e.target.value }))
              }
            />
          </div>

          <Button
            type="submit"
            className="w-full mt-2"
            loading={loading}
            disabled={!form.login || !form.password}
          >
            Sign in
          </Button>

          <div className="flex items-center justify-between text-xs text-zinc-500">
            <Link to="/register" className="text-indigo-400 hover:text-indigo-300">
              Create account
            </Link>
            <Link to="/forgot" className="text-indigo-400 hover:text-indigo-300">
              Forgot password?
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
