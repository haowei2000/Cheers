import { registerEnvironment } from "../../environmentRegistry";
import type { FsClient } from "../../fsClient";
import { ResourceError } from "../../../hooks/useChatRealtime";
import { journalsPanel, type Journal } from "./JournalsPanel";
import { progressPanel, type Board } from "./ProgressPanel";
import { reviewPanel, type Review } from "./ReviewPanel";

const SEED_JOURNALS: Journal[] = [
  { name: "Nature", impact: "50.5", deadline: "", status: "候选" },
  { name: "Science", impact: "44.7", deadline: "", status: "候选" },
];
const SEED_BOARD: Board = {
  columns: [
    { name: "待办", items: ["确定研究问题", "文献综述"] },
    { name: "进行中", items: [] },
    { name: "已完成", items: [] },
  ],
};
const SEED_REVIEWS: Review[] = [];

// Create a file only if it doesn't exist yet (if_version=0). Re-running the seed
// therefore never clobbers data a user/bot already wrote — it just fills the gaps.
async function ensure(fs: FsClient, path: string, value: unknown): Promise<void> {
  try {
    await fs.write(path, JSON.stringify(value, null, 2), 0);
  } catch (e) {
    if (e instanceof ResourceError && e.code === "VERSION_CONFLICT") return; // exists, keep it
    throw e;
  }
}

// A research channel = these three boards over conventional files in memory_files.
// Pure files; the bot reaches the same paths via fs.* — no separate store, no backend.
registerEnvironment({
  id: "research",
  title: "科研",
  panels: [journalsPanel, progressPanel, reviewPanel],
  seed: async (fs) => {
    await ensure(fs, "research/journals.json", SEED_JOURNALS);
    await ensure(fs, "research/progress.json", SEED_BOARD);
    await ensure(fs, "research/reviews.json", SEED_REVIEWS);
  },
});
