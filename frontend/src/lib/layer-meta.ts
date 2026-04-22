export type LayerMeta = {
  label: string;
  desc: string;
  color: string;
  icon: string;
  readonly?: boolean;
  entryBased?: boolean;
};

export const LAYER_META: Record<string, LayerMeta> = {
  ANCHOR: {
    label: "项目锚点",
    desc: "核心目标、约束、背景",
    color: "blue",
    icon: "⚓",
    entryBased: true,
  },
  PROGRESS: {
    label: "项目进度",
    desc: "当前进度、已完成、下一步",
    color: "teal",
    icon: "📈",
    entryBased: true,
  },
  DECISIONS: {
    label: "决策记录",
    desc: "重要决策及原因",
    color: "purple",
    icon: "📋",
    entryBased: true,
  },
  FILES_INDEX: {
    label: "资料索引",
    desc: "上传的文件与参考资料",
    color: "amber",
    icon: "🗂️",
    readonly: true,
  },
  RECENT: {
    label: "近期动态",
    desc: "最新进展、待办、结论",
    color: "green",
    icon: "🕐",
    readonly: true,
  },
  MEMBERS: {
    label: "频道成员",
    desc: "用户与 Bot 能力一览",
    color: "gray",
    icon: "👥",
    readonly: true,
  },
  TODO: {
    label: "待办事项",
    desc: "频道任务清单",
    color: "rose",
    icon: "✅",
    readonly: true,
  },
};
