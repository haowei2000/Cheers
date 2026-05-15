import { useEffect, useState } from "react";
import { AppIcon } from "../../../components/icons/AppIcon";

export function getSecretSecondsLeft(
  createdAt?: string | null,
  now = Date.now(),
): number | null {
  if (!createdAt) return null;
  const createdMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs)) return null;
  return Math.max(0, 60 - Math.floor((now - createdMs) / 1000));
}

export function SecretMessageVeil({
  canReveal,
  createdAt,
  onReveal,
}: {
  canReveal: boolean;
  createdAt?: string | null;
  onReveal: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const secondsLeft = getSecretSecondsLeft(createdAt, now);
  const expired = secondsLeft !== null && secondsLeft <= 0;

  useEffect(() => {
    if (secondsLeft === null || secondsLeft <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  return (
    <div className={`an-secret-veil${expired ? " is-expired" : ""}`}>
      <span className="an-secret-veil-icon">
        <AppIcon name="lock" className="w-5 h-5" />
      </span>
      <div className="an-secret-veil-body">
        <span className="an-secret-veil-label">
          {expired ? "加密消息已过期" : "加密消息"}
        </span>
        <span className="an-secret-veil-meta">
          {expired
            ? "一次性查看窗口已关闭"
            : secondsLeft !== null
              ? `剩余 ${secondsLeft}s · 仅 Bot 可读`
              : "仅 Bot 可读"}
        </span>
      </div>
      {!expired && canReveal && (
        <button
          type="button"
          className="an-secret-veil-reveal"
          onClick={onReveal}
        >
          查看
        </button>
      )}
    </div>
  );
}
