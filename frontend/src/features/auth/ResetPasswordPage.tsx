import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { resetPassword } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PublicPageShell,
  publicLabelClass,
  publicLinkClass,
  publicPanelClass,
} from "@/components/public/PublicPageShell";

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw.length < 12) {
      toast.error("Password must be at least 12 characters");
      return;
    }
    if (pw !== confirm) {
      toast.error("Passwords don't match");
      return;
    }
    setLoading(true);
    try {
      await resetPassword({ email: email.trim(), code: code.trim(), new_password: pw });
      toast.success("Password reset — please sign in.");
      navigate("/login", { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setLoading(false);
    }
  }

  const labelCls = publicLabelClass;
  return (
    <PublicPageShell title="Set a new password" description="Enter the code we emailed you.">
        <form
          onSubmit={submit}
          className={publicPanelClass}
        >
          <div className="space-y-2">
            <label className={labelCls}>Email</label>
            <Input
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className={labelCls}>Reset code</label>
            <Input
              type="text"
              placeholder="8-character code"
              autoFocus
              className="font-code tracking-overline uppercase"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className={labelCls}>New password</label>
            <Input
              type="password"
              placeholder="min 12 characters"
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className={labelCls}>Confirm new password</label>
            <Input
              type="password"
              placeholder="repeat new password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          <Button action="send" controlWidth="fill"
            type="submit"
            className="mt-2"
            loading={loading}
            disabled={!email.trim() || !code.trim() || !pw}
          >
            Reset password
          </Button>
          <p className="text-center text-compact text-content-muted">
            <Link to="/login" className={publicLinkClass}>
              Back to sign in
            </Link>
          </p>
        </form>
    </PublicPageShell>
  );
}
