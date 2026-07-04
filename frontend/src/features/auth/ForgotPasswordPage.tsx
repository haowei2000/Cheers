import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { forgotPassword } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    try {
      await forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <img src="/cheers-icon.svg" alt="" className="w-12 h-12 mb-4" aria-hidden="true" />
          <h1 className="text-2xl font-bold text-zinc-50 tracking-tight">Reset your password</h1>
          <p className="text-zinc-500 text-sm mt-1">We'll email you a one-time code.</p>
        </div>

        <div className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800 shadow-xl">
          {sent ? (
            <div className="space-y-4">
              <p className="text-sm text-zinc-400">
                If <span className="text-zinc-200">{email}</span> has an account, a reset code
                has been sent. Enter it on the next screen.
              </p>
              <Button
                className="w-full"
                onClick={() => navigate(`/reset?email=${encodeURIComponent(email.trim())}`)}
              >
                Enter code
              </Button>
              <p className="text-center text-xs text-zinc-500">
                <Link to="/login" className="text-indigo-400 hover:text-indigo-300">
                  Back to sign in
                </Link>
              </p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
                  Email
                </label>
                <Input
                  type="email"
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full mt-2" loading={loading} disabled={!email.trim()}>
                Send reset code
              </Button>
              <p className="text-center text-xs text-zinc-500">
                <Link to="/login" className="text-indigo-400 hover:text-indigo-300">
                  Back to sign in
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
