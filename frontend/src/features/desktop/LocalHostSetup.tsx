import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createChannelBotSession, setPrimaryChannelBotSession } from "@/api/sessionControl";
import { bustBotControls } from "@/features/chat/sessionControlsCache";
import { addRecentWorkspace } from "@/lib/recentWorkspaces";
import { createDm } from "@/api/channels";
import type { AgentType } from "@/api/bots";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { pickFolder } from "@/lib/desktop";
import { messageOf } from "@/lib/notify";
import { useChatStore } from "@/stores/chatStore";
import type { BotItem } from "@/types";
import { AgentPicker } from "./AgentPicker";
import { prepareLocalHost, startLocalHost, type PreparedHost } from "./localHostConnection";

/** Shared first-run flow for Bot creation and Fleet → Hosts. */
export function LocalHostSetup({ bots, initialBotId, initialAgent = "codex", onDone }: {
  bots: BotItem[];
  initialBotId?: string;
  initialAgent?: AgentType;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const botFieldId = useId();
  const [botId, setBotId] = useState(initialBotId ?? bots[0]?.bot_id ?? "");
  const [agent, setAgent] = useState(initialAgent);
  const [project, setProject] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedHost | null>(null);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(false);
  const [active, setActive] = useState(false);
  const [chatSession, setChatSession] = useState<{ channelId: string; sessionId: string } | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bot = bots.find((item) => item.bot_id === botId);

  useEffect(() => {
    if (!botId && bots[0]) setBotId(bots[0].bot_id);
  }, [botId, bots]);

  async function chooseProject() {
    try {
      const selected = await pickFolder();
      if (selected) {
        setProject(selected);
        setError(null);
      }
    } catch (cause) { setError(messageOf(cause)); }
  }

  async function connect() {
    if (!bot || busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(prepared ? "Starting the saved host…" : "Checking the agent and saving your host…");
      const host = prepared ?? await prepareLocalHost(bot.bot_id, agent, project);
      setPrepared(host);
      setStatus("Starting the host and checking its connection…");
      const hostStatus = await startLocalHost(host);
      setOnline(true);
      setActive(hostStatus === "active");
      if (project) addRecentWorkspace(project, bot.bot_id);
      setStatus(hostStatus === "active"
        ? "Host connected. Open chat to sign in to the agent if requested."
        : "Host connected as standby. Another host currently runs this bot. Activate this Mac in Hosts before using its project.");
    } catch (cause) { setStatus(""); setError(messageOf(cause)); }
    finally { setBusy(false); }
  }

  async function openChat() {
    if (!bot || busy) return;
    setBusy(true);
    setError(null);
    try {
      const dm = await createDm({ target_bot_id: bot.bot_id });
      const target = chatSession ?? {
        channelId: dm.channel_id,
        sessionId: (await createChannelBotSession(dm.channel_id, bot.bot_id, project ? { cwd: project } : undefined)).session_id,
      };
      setChatSession(target);
      await setPrimaryChannelBotSession(target.channelId, bot.bot_id, target.sessionId);
      bustBotControls(target.channelId, bot.bot_id);
      useChatStore.getState().upsertChannel({ ...dm, peer_name: bot.display_name || bot.username });
      useChatStore.getState().selectChannel(dm.channel_id);
      onDone();
      navigate("/chat");
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }

  return <div className="space-y-4">
    <Field label="Bot" htmlFor={botFieldId} hint="Choose your agent and project. Cheers will connect this Mac to your bot.">
      <Select id={botFieldId} value={botId} onChange={(event) => setBotId(event.target.value)} disabled={busy || !!prepared}>
        {!bots.length && <option value="">Create a bot first</option>}
        {bots.map((item) => <option key={item.bot_id} value={item.bot_id}>{item.display_name || item.username}</option>)}
      </Select>
    </Field>
    {!bots.length && <Button action="create" variant="secondary" onClick={() => { onDone(); navigate("/fleet/bots"); }} aria-label="Create a bot in Fleet" />}
    {!prepared && <fieldset disabled={busy}><Field label="Agent"><AgentPicker allowCustom={false} value={agent} onPick={(key) => { if (!busy) setAgent(key); }} /></Field></fieldset>}
    {prepared && <p className="text-body-secondary">Agent: {agent}</p>}
    <Field label="Project folder" hint="The selected folder becomes the default working directory and the scope of file access. You can also start with a new empty workspace.">
      <div className="flex min-w-0 items-center gap-2">
        <p className="min-w-0 flex-1 break-all font-code text-regular text-content-secondary">{project ?? "New empty workspace"}</p>
        <Button action="choose" variant="secondary" disabled={busy || !!prepared} onClick={() => void chooseProject()} aria-label="Choose project folder" />
      </div>
    </Field>
    {status && <p className="text-body-secondary" role="status">{status}</p>}
    {error && <p className="text-body-error" role="alert">{error}</p>}
    <div className="flex justify-end gap-2">
      {online
        ? <Button action="open" onClick={() => { if (active) void openChat(); else { onDone(); navigate("/fleet/hosts"); } }} loading={busy} aria-label={active ? "Open chat with this bot" : "Manage standby host"} />
        : <Button action={prepared ? "retry" : "setup"} onClick={() => void connect()} loading={busy} disabled={!bot || busy} aria-label="Connect bot and project on this Mac" />}
    </div>
  </div>;
}
