import type { ComponentType } from "react";
import type { WorkbenchContext } from "./context";

export interface WorkbenchPanelContribution {
  id: string;
  profiles: string[];
  component: ComponentType<{ ctx: WorkbenchContext }>;
}

const contributions: WorkbenchPanelContribution[] = [];

export function registerWorkbenchPanel(contribution: WorkbenchPanelContribution): void {
  if (contributions.some((item) => item.id === contribution.id)) return;
  contributions.push(contribution);
}

export function workbenchPanelsFor(profile?: string): WorkbenchPanelContribution[] {
  if (!profile) return [];
  return contributions.filter((item) => item.profiles.includes(profile));
}
