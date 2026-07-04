// Generic data-loading hook for workbench panels that read a channel resource
// verb (e.g. a future `channel.plan.read` or `channel.usage.read`) through the
// same `sendResourceReq` seam the File panel already uses for `fs.*`.
//
// This is the shared frontend foundation for the Phase-A "telemetry → artifact" panels
// (plan board, cost dashboard): it owns loading/error/data + manual refetch, so
// each panel only declares its verb + params and renders the result.
import { useCallback, useEffect, useState } from "react";
import type { SendResourceReq } from "./fsClient";

export interface ResourceQueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Re-run the query on demand (e.g. after a live event or a user action). */
  refetch: () => void;
}

/**
 * Run `send(resource, params)` and expose its result as {data,loading,error}.
 * Re-runs whenever `resource` or the serialized `params` change. Pass
 * `enabled=false` to hold off (e.g. until a channel is selected).
 */
export function useResourceQuery<T = unknown>(
  send: SendResourceReq,
  resource: string,
  params: Record<string, unknown>,
  enabled = true
): ResourceQueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Serialize params so the effect only re-runs on a real value change, not on
  // each render's new object identity.
  const paramsKey = JSON.stringify(params);

  const run = useCallback(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    send(resource, params)
      .then((res) => {
        if (!cancelled) setData(res as T);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `paramsKey` stands in for `params` (stable across identical values).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send, resource, paramsKey, enabled]);

  useEffect(() => {
    const cleanup = run();
    return cleanup;
  }, [run]);

  return { data, loading, error, refetch: run };
}
