import type { ComponentType } from "react";
import type { ChannelProfile } from "@/api/channelProfiles";

export interface ChannelExtensionContext {
  channelId: string;
  profile: ChannelProfile;
}

export interface ChannelHeaderContribution {
  id: string;
  profiles: string[];
  component: ComponentType<ChannelExtensionContext>;
}

const headerContributions: ChannelHeaderContribution[] = [];

export function registerChannelHeader(contribution: ChannelHeaderContribution): void {
  if (!headerContributions.some((candidate) => candidate.id === contribution.id)) {
    headerContributions.push(contribution);
  }
}

export function channelHeadersFor(profile: string): ChannelHeaderContribution[] {
  return headerContributions.filter((contribution) => contribution.profiles.includes(profile));
}
