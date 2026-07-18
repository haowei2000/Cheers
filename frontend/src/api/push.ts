import { apiJson } from "./client";

/** The VAPID application-server key for PushManager.subscribe, or null when
 * the deployment has Web Push disabled (no VAPID key configured). */
export async function getVapidPublicKey(): Promise<string | null> {
  const res = await apiJson<{ key: string | null }>("/push/vapid-public-key");
  return res.key;
}

export interface PushSubscriptionBody {
  endpoint: string;
  /** Client public key (`getKey("p256dh")`), base64url unpadded. */
  p256dh: string;
  /** Client auth secret (`getKey("auth")`), base64url unpadded. */
  auth: string;
  user_agent?: string;
}

/** Register (or re-register) this browser's push subscription. Upsert by endpoint. */
export async function registerPushSubscription(
  body: PushSubscriptionBody
): Promise<void> {
  await apiJson("/push/subscriptions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Drop one subscription (toggle off / sign out). Scoped to the caller's rows. */
export async function deletePushSubscription(endpoint: string): Promise<void> {
  await apiJson("/push/subscriptions", {
    method: "DELETE",
    body: JSON.stringify({ endpoint }),
  });
}
