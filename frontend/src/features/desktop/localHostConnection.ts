import { createHost, listConnectorHosts, redeemHostPairing, revokeConnectorHost, type AgentType } from "@/api/bots";
import { invokeDesktop } from "@/lib/desktop";
import type { DetectedAgent } from "./AgentPicker";

export interface PreparedHost {
  botId: string;
  hostId: string;
  name: string;
  configPath: string;
}

/** Finish preflight before creating credentials; return the saved host for retries. */
export async function prepareLocalHost(botId: string, agentType: AgentType, workspacePath: string | null): Promise<PreparedHost> {
  const agents = await invokeDesktop<DetectedAgent[]>("detect_agents");
  const agent = agents.find((item) => item.key === agentType);
  if (!agent) throw new Error("Choose an available agent on this Mac");
  if (!agent.installed) {
    if (!agent.installable) throw new Error(`Install ${agent.label} before connecting this bot`);
    await invokeDesktop("install_agent", { key: agentType });
  }
  const pairing = await createHost(botId, agentType, "Cheers Desktop");
  try {
    const redeemed = await redeemHostPairing(pairing.pairing_code, "Cheers Desktop");
    const name = `${redeemed.account_id}-${pairing.host_id}`;
    const configPath = await invokeDesktop<string>("connector_write_onboarded", {
      accountId: redeemed.account_id,
      configToml: redeemed.config_toml,
      token: redeemed.credential,
      tokenFile: redeemed.credential_file,
      workspacePath,
      instanceName: name,
    });
    return { botId, hostId: pairing.host_id, name, configPath };
  } catch (error) {
    // This host never became usable. Revoke the allocated credential before a
    // fresh attempt; do not leave an invisible active host behind.
    await revokeConnectorHost(botId, pairing.host_id);
    throw error;
  }
}

export async function startLocalHost(host: PreparedHost): Promise<"active" | "standby"> {
  const instances = await invokeDesktop<{ name: string; running: boolean }[]>("connector_list");
  if (!instances.some((item) => item.name === host.name && item.running)) {
    await invokeDesktop("connector_start", { name: host.name, configPath: host.configPath });
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const hosts = await listConnectorHosts(host.botId);
    const connected = hosts.find((item) => item.host_id === host.hostId && item.online);
    if (connected && connected.status !== "pending") return connected.status;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("The host is saved but has not connected yet. Retry to check it again, or inspect it in Hosts.");
}
