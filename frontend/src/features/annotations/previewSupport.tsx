// In-memory HTTP fixture used only by standalone component previews.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SavedAnnotation } from "@/api/annotations";
import { AnnotationProvider } from "./AnnotationProvider";

const notes: SavedAnnotation[] = [];
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (!url.includes("/channels/preview/annotations"))
    return originalFetch(input, init);
  const id = url.split("/annotations/")[1];
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const method = init?.method ?? "GET";
  const item = notes.find((note) => note.id === id);
  let result: unknown = { notes, import_warning: null };
  if (method === "POST") {
    const now = new Date().toISOString();
    const created: SavedAnnotation = {
      ...body,
      id: crypto.randomUUID(),
      channel_id: "preview",
      author_id: "preview-user",
      revision: 1,
      created_at: now,
      updated_at: now,
    };
    notes.push(created);
    result = created;
  } else if (item && method === "PATCH") {
    item.note = body.note;
    item.revision += 1;
    item.updated_at = new Date().toISOString();
    result = item;
  } else if (item && method === "DELETE") {
    notes.splice(notes.indexOf(item), 1);
    result = { deleted: true };
  }
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json" },
  });
};
const client = new QueryClient();
export function AnnotationPreviewProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={client}>
      <AnnotationProvider
        channelId="preview"
        userId="preview-user"
        canManage
        onReveal={() => undefined}
        onCompose={() => undefined}
      >
        {children}
      </AnnotationProvider>
    </QueryClientProvider>
  );
}
