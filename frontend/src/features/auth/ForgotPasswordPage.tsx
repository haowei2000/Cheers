import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { forgotPassword } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PublicPageShell,
  publicLabelClass,
  publicLinkClass,
  publicPanelClass,
} from "@/components/public/PublicPageShell";

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
    <PublicPageShell
      title="Reset your password"
      description="We'll email you a one-time code."
    >
        <div className={publicPanelClass}>
          {sent ? (
            <div className="space-y-4">
              <p className="text-regular text-zinc-400">
                If <span className="text-zinc-200">{email}</span> has an account, a reset code
                has been sent. Enter it on the next screen.
              </p>
              <Button controlWidth="fill"
                onClick={() => navigate(`/reset?email=${encodeURIComponent(email.trim())}`)}
              >
                Enter code
              </Button>
              <p className="text-center text-compact text-zinc-400">
                <Link to="/login" className={publicLinkClass}>
                  Back to sign in
                </Link>
              </p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-2">
                <label className={publicLabelClass}>
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
              <Button controlWidth="fill" type="submit" className="mt-2" loading={loading} disabled={!email.trim()}>
                Send reset code
              </Button>
              <p className="text-center text-compact text-zinc-400">
                <Link to="/login" className={publicLinkClass}>
                  Back to sign in
                </Link>
              </p>
            </form>
          )}
        </div>
    </PublicPageShell>
  );
}
