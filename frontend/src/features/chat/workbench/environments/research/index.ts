import { registerEnvironment } from "../../environmentRegistry";
import type { TemplateManifest } from "../../manifest";

// A whole research scenario, as DATA — no per-board React. The table/kanban/markdown
// lenses render it; the bot reaches the same files via fs.*. This is the declarative
// form a third party (or a runtime-dropped .workbench/templates/*.json) would write.
const research: TemplateManifest = {
  id: "research",
  title: "科研",
  views: [
    {
      id: "journals",
      title: "目标期刊",
      file: "research/journals.json",
      lens: "table",
      config: {
        columns: [
          { key: "name", label: "期刊" },
          { key: "impact", label: "IF" },
          { key: "deadline", label: "截稿" },
          { key: "status", label: "状态", options: ["候选", "撰写中", "投稿中", "已投", "录用", "拒稿"] },
        ],
      },
    },
    { id: "progress", title: "进度看板", file: "research/progress.json", lens: "kanban" },
    {
      id: "reviews",
      title: "论文审阅",
      file: "research/reviews.json",
      lens: "table",
      config: {
        columns: [
          { key: "paper", label: "论文" },
          { key: "reviewer", label: "审稿人" },
          { key: "status", label: "状态", options: ["待审", "审阅中", "已审", "退回"] },
          { key: "notes", label: "备注" },
        ],
      },
    },
    { id: "prompt", title: "评审提示词", file: "prompts/review.md", lens: "markdown" },
  ],
  seed: {
    "research/journals.json": [
      { name: "Nature", impact: "50.5", deadline: "", status: "候选" },
      { name: "Science", impact: "44.7", deadline: "", status: "候选" },
    ],
    "research/progress.json": {
      columns: [
        { name: "待办", items: ["确定研究问题", "文献综述"] },
        { name: "进行中", items: [] },
        { name: "已完成", items: [] },
      ],
    },
    "research/reviews.json": [],
    "prompts/review.md":
      "You are a rigorous peer reviewer. For each paper, assess novelty, soundness, and clarity; list concrete strengths and weaknesses; finish with a recommendation (accept / minor / major / reject).",
  },
};

registerEnvironment(research);
