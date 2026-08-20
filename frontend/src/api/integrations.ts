import { apiJson } from "./client";

export interface IntegrationInstallation {
  installation_id: string;
  integration_id: string;
  workspace_id: string;
  display_name: string;
  external_account: string;
}

export interface IntegrationResource {
  external_id: string;
  kind: string;
  name: string;
  description?: string | null;
  private: boolean;
  url: string;
  detail: { default_branch?: string; clone_url?: string; repository_id?: number };
}

export function listIntegrationInstallations(id: string): Promise<IntegrationInstallation[]> {
  return apiJson(`/integrations/${id}/installations`);
}

export function listIntegrationResources(id: string, installationId: string): Promise<IntegrationResource[]> {
  return apiJson(`/integrations/${id}/installations/${installationId}/resources`);
}

export function bindChannelIntegration(channelId: string, input: {
  integration_id: string;
  installation_id: string;
  external_id: string;
}): Promise<unknown> {
  return apiJson(`/channels/${channelId}/integration`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function initializeChannelIntegration(channelId: string): Promise<unknown> {
  return apiJson(`/channels/${channelId}/integration/init`, { method: "POST" });
}
