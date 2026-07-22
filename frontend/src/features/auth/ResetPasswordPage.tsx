import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { resetPassword } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

  const labelCls = "text-xs font-medium text-zinc-400 uppercase tracking-wide";
  return (
    <div className="h-full overflow-y-auto bg-zinc-950 flex justify-center p-4">
      <div className="w-full max-w-sm my-auto">
        <div className="flex flex-col items-center mb-8">
          <img src="/cheers-icon.svg" alt="" className="w-12 h-12 mb-4" aria-hidden="true" />
          <h1 className="text-2xl font-bold text-zinc-50 tracking-tight">Set a new password</h1>
          <p className="text-zinc-400 text-sm mt-1">Enter the code we emailed you.</p>
        </div>

        <form
          onSubmit={submit}
          className="bg-zinc-900 rounded-2xl p-6 shadow-xl space-y-4"
        >
          <div className="space-y-1.5">
            <label className={labelCls}>Email</label>
            <Input
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>Reset code</label>
            <Input
              type="text"
              placeholder="8-character code"
              autoFocus
              className="font-mono tracking-widest uppercase"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>New password</label>
            <Input
              type="password"
              placeholder="min 12 characters"
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>Confirm new password</label>
            <Input
              type="password"
              placeholder="repeat new password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          <Button
            type="submit"
            className="w-full mt-2"
            loading={loading}
            disabled={!email.trim() || !code.trim() || !pw}
          >
            Reset password
          </Button>
          <p className="text-center text-xs text-zinc-400">
            <Link to="/login" className="text-indigo-400 hover:text-indigo-300">
              Back to sign in
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
