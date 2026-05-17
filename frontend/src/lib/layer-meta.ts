import type { ReactNode } from "react";
import { createElement } from "react";
import { AppIcon, type AppIconName } from "../components/icons/AppIcon";

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

const ico = (name: AppIconName): ReactNode =>
  createElement(AppIcon, { className: "w-full h-full", name });

export const LAYER_META: Record<string, LayerMeta> = {
  ANCHOR: {
    label: "Project anchor",
    desc: "Core goals, constraints, and background",
    color: "blue",
    icon: ico("note"),
    entryBased: true,
  },
  PROGRESS: {
    label: "Project progress",
    desc: "Current progress, completed work, and next steps",
    color: "teal",
    icon: ico("trending"),
    entryBased: true,
  },
  DECISIONS: {
    label: "Decision log",
    desc: "Important decisions and rationale",
    color: "purple",
    icon: ico("task"),
    entryBased: true,
  },
  FILES_INDEX: {
    label: "Reference index",
    desc: "Uploaded files and references",
    color: "amber",
    icon: ico("archive"),
    readonly: true,
  },
  HISTORY: {
    label: "Conversation history",
    desc: "Current page details and sealed page summaries",
    color: "green",
    icon: ico("clock"),
    readonly: true,
  },
  MEMBERS: {
    label: "Channel members",
    desc: "Users and bot capabilities",
    color: "gray",
    icon: ico("users"),
    readonly: true,
  },
  TODO: {
    label: "Todo items",
    desc: "Channel task list",
    color: "rose",
    icon: ico("checkCircle"),
    readonly: true,
  },
};
