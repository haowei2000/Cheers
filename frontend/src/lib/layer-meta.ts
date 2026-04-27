import type { ReactNode } from "react";
import { createElement } from "react";
import {
  ArchiveBoxIcon,
  ArrowTrendingUpIcon,
  BookmarkIcon,
  CheckCircleIcon,
  ClipboardDocumentListIcon,
  ClockIcon,
  UsersIcon,
} from "@heroicons/react/24/solid";

export type LayerMeta = {
  label: string;
  desc: string;
  color: string;
  /** Renderable icon node. Consumers wrap in a sized container, e.g.
   *  `<span className="w-5 h-5 inline-flex">{meta.icon}</span>`. The icon
   *  itself takes the full width/height of its wrapper. */
  icon: ReactNode;
  readonly?: boolean;
  entryBased?: boolean;
};

const ico = (Icon: typeof BookmarkIcon): ReactNode =>
  createElement(Icon, { className: "w-full h-full" });

export const LAYER_META: Record<string, LayerMeta> = {
  ANCHOR: {
    label: "项目锚点",
    desc: "核心目标、约束、背景",
    color: "blue",
    icon: ico(BookmarkIcon),
    entryBased: true,
  },
  PROGRESS: {
    label: "项目进度",
    desc: "当前进度、已完成、下一步",
    color: "teal",
    icon: ico(ArrowTrendingUpIcon),
    entryBased: true,
  },
  DECISIONS: {
    label: "决策记录",
    desc: "重要决策及原因",
    color: "purple",
    icon: ico(ClipboardDocumentListIcon),
    entryBased: true,
  },
  FILES_INDEX: {
    label: "资料索引",
    desc: "上传的文件与参考资料",
    color: "amber",
    icon: ico(ArchiveBoxIcon),
    readonly: true,
  },
  RECENT: {
    label: "近期动态",
    desc: "最新进展、待办、结论",
    color: "green",
    icon: ico(ClockIcon),
    readonly: true,
  },
  MEMBERS: {
    label: "频道成员",
    desc: "用户与 Bot 能力一览",
    color: "gray",
    icon: ico(UsersIcon),
    readonly: true,
  },
  TODO: {
    label: "待办事项",
    desc: "频道任务清单",
    color: "rose",
    icon: ico(CheckCircleIcon),
    readonly: true,
  },
};
