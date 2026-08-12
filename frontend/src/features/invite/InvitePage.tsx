import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { Hash, Users } from "lucide-react";
import {
  acceptInviteLink,
  getInvitePreview,
  type InviteLinkPreview,
} from "@/api/invites";
import { useAuthStore } from "@/stores/authStore";
import { useChatStore } from "@/stores/chatStore";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  PublicPageShell,
  publicLinkClass,
  publicPanelClass,
} from "@/components/public/PublicPageShell";

// Public landing page for a shared invite URL (/invite/:token). Signed-in
// visitors join with one click; signed-out visitors are routed to sign-in (with
// a redirect back here) or to sign-up (which carries the token so registration
// works even when the instance has open sign-ups disabled, then auto-joins).
export default function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const selectWorkspace = useChatStore((s) => s.selectWorkspace);
  const selectChannel = useChatStore((s) => s.selectChannel);

  const [preview, setPreview] = useState<InviteLinkPreview | null>(null);
  const [failed, setFailed] = useState(false);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    getInvitePreview(token)
      .then(setPreview)
      .catch(() => setFailed(true));
  }, [token]);

  async function join() {
    setJoining(true);
    try {
      const res = await acceptInviteLink(token);
      toast.success(
        res.already_member
          ? "You're already a member"
          : `Joined ${preview?.workspace_name ?? "the workspace"} 🎉`
      );
      selectWorkspace(res.workspace_id);
      if (res.channel_joined && res.channel_id) selectChannel(res.channel_id);
      navigate("/chat", { replace: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't join");
      setJoining(false);
    }
  }

  const dead =
    failed || (preview && preview.status !== "valid") ? (
      <>
        <h1 className="text-comfortable font-semibold text-zinc-100">
          {preview?.status === "expired"
            ? "This invite link has expired"
            : preview?.status === "exhausted"
              ? "This invite link has been used up"
              : "This invite link is invalid"}
        </h1>
        <p className="text-regular text-zinc-400">
          Ask whoever shared it with you for a new link.
        </p>
        <Link
          to={user ? "/chat" : "/login"}
          className={`text-regular ${publicLinkClass}`}
        >
          {user ? "Back to Cheers" : "Go to sign in"}
        </Link>
      </>
    ) : null;

  return (
    <PublicPageShell
      eyebrow="Cheers · Invitation desk"
      title={preview?.status === "valid" ? "You are invited" : "Workspace invitation"}
      description="Review the invitation before entering the shared workspace."
    >
        <div className={`${publicPanelClass} flex flex-col items-center gap-3 text-center`}>
          {!preview && !failed && <Spinner contentSize="large" className="text-zinc-600 my-6" />}

          {dead}

          {preview?.status === "valid" && (
            <>
              <Avatar
                name={preview.workspace_name ?? "?"}
                src={preview.workspace_avatar_url ?? undefined}
                id={preview.workspace_id}
                size="large"
              />
              <div>
                <p className="text-regular text-zinc-400">
                  {preview.inviter ?? "Someone"} invited you to join
                </p>
                <h1 className="text-comfortable font-semibold text-zinc-100 mt-1">
                  {preview.workspace_name}
                </h1>
              </div>
              <div className="flex items-center gap-3 text-compact text-zinc-400">
                <span className="inline-flex items-center gap-1">
                  <Users className="w-3.5 h-3.5" />
                  {preview.member_count ?? 0} member{(preview.member_count ?? 0) === 1 ? "" : "s"}
                </span>
                {preview.channel_name && (
                  <span className="inline-flex items-center gap-1">
                    <Hash className="w-3.5 h-3.5" />
                    {preview.channel_name}
                  </span>
                )}
              </div>

              {user ? (
                <Button action="join" controlWidth="fill" className="mt-2" loading={joining} onClick={() => void join()}>
                  Join {preview.workspace_name}
                </Button>
              ) : (
                <>
                  <Button action="create" controlWidth="fill"
                    className="mt-2"
                    onClick={() => navigate(`/register?invite=${encodeURIComponent(token)}`)}
                  >
                    Create an account to join
                  </Button>
                  <p className="text-compact text-zinc-400">
                    Already have an account?{" "}
                    <Link
                      to={`/login?redirect=${encodeURIComponent(`/invite/${token}`)}`}
                      className={publicLinkClass}
                    >
                      Sign in
                    </Link>
                  </p>
                </>
              )}
            </>
          )}
        </div>
    </PublicPageShell>
  );
}
