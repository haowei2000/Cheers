/**
 * Transport from this MCP server to AgentNexus.
 *
 * NOTE on topology: a bot has exactly one (control, data) WebSocket pair, and a
 * second connection with the same bot token is superseded (close 4402). So this
 * server CANNOT open its own bridge WS. Instead it forwards each resource call
 * to the connector over local IPC; the connector emits a `resource_req` frame on
 * its existing data WS and relays back the matching `resource_res`.
 *
 * The default implementation talks to a connector-hosted loopback HTTP endpoint.
 * Swap in a unix-socket implementation by implementing `ResourceTransport`.
 */
import { setTimeout as delay } from "node:timers/promises";

/** Mirrors the gateway resource_req frame (minus envelope fields). */
export interface ResourceRequest {
  resource: string;
  params: Record<string, unknown>;
}

/** Mirrors the gateway resource_res payload. */
export interface ResourceResponse {
  ok: boolean;
  data?: unknown;
  /** Stable error code on failure, e.g. NOT_MEMBER, PERMISSION_DENIED. */
  code?: string;
  error?: string;
}

export interface ResourceTransport {
  request(req: ResourceRequest): Promise<ResourceResponse>;
}

export class HttpLoopbackTransport implements ResourceTransport {
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
  ) {}

  async request(req: ResourceRequest): Promise<ResourceResponse> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: ac.signal,
      });
      if (!res.ok) {
        return {
          ok: false,
          code: `IPC_HTTP_${res.status}`,
          error: `connector IPC returned ${res.status}`,
        };
      }
      const body = (await res.json()) as ResourceResponse;
      return body;
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        code: aborted ? "IPC_TIMEOUT" : "IPC_UNAVAILABLE",
        error: aborted ? "connector IPC timed out" : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Used in tests / dry runs without a connector. */
export class StubTransport implements ResourceTransport {
  async request(req: ResourceRequest): Promise<ResourceResponse> {
    await delay(0);
    return { ok: false, code: "NOT_WIRED", error: `stub transport: ${req.resource}` };
  }
}
