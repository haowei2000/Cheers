/// <reference lib="webworker" />
import { parseExtensionPackage, type ParsedExtension } from "./package";

export interface ParseRequest {
  id: number;
  input: ArrayBuffer | Uint8Array;
  scope: "global" | "personal" | "temporary";
}

export type ParseResponse =
  | { id: number; ok: true; parsed: ParsedExtension }
  | { id: number; ok: false; message: string };

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { id, input, scope } = event.data;
  parseExtensionPackage(input, scope).then(
    (parsed) => (self as unknown as Worker).postMessage({ id, ok: true, parsed } satisfies ParseResponse),
    (error: unknown) =>
      (self as unknown as Worker).postMessage({
        id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      } satisfies ParseResponse),
  );
};
