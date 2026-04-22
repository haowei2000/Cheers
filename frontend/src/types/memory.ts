export const LAYERS = [
  "ANCHOR",
  "PROGRESS",
  "DECISIONS",
  "FILES_INDEX",
  "RECENT",
  "MEMBERS",
  "TODO",
] as const;

export type MemoryLayer = (typeof LAYERS)[number];

export type MemoryEntryItem = {
  entry_id: string;
  channel_id: string;
  layer: string;
  title: string | null;
  content: string;
  sort_order: number;
  created_by: string | null;
  creator_type: string | null;
  created_at: string | null;
  updated_at: string | null;
};
