import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";

const API = "/api";

type TabId = "llm" | "perf" | "logs" | "bot" | "health" | "user" | "workspace";

type Workspace = { workspace_id: string; name: string };
type Channel = { channel_id: string; name: string; type: string };
type BotItem = {
  bot_id: string;
  username: string;
  display_name?: string;
  openclaw_endpoint: string;
  status: string;
  intro?: string;
  prompt_template?: string;
  created_at?: string;
};

type MCPBotSuggestion = {
  suggested_username: string;
  suggested_display_name: string;
  suggested_endpoint: string;
  suggested_intro: {
    description: string;
    capabilities: string[];
    mcp_config: Record<string, unknown>;
  };
  server_name: string;
  transport_type: string;
};
type PendingRequest = {
  request_id: string;
  username: string;
  display_name?: string;
  openclaw_endpoint: string;
  intro?: string;
  status: string;
  requested_at?: string;
};
type TaskItem = { task_id: string; channel_id: string; bot_username?: string; latency_ms?: number; created_at?: string };
type LogEntry = { ts: number; level: string; logger: string; message: string; formatted: string };
type LLMProvider = {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_key_set: boolean;
  temperature: number;
  max_tokens: number;
};
type LLMBindings = { guide_bot?: string; system_llm?: string; log_analyze?: string; qa_summarize?: string };
type ClarifySettings = {
  clarify_strict_mode: boolean;
  clarify_force_rule: boolean;
  clarify_threshold: number;
};

function refreshChannels(setChannels: (c: Channel[]) => void) {
  fetch(`${API}/channels`).then((r) => r.json()).then((d) => d.data && setChannels(d.data)).catch(console.error);
}

export default function AdminPage() {
  // 从 localStorage 获取当前用户角色
  const getCurrentUser = () => {
    try {
      const stored = localStorage.getItem("currentUser");
      if (!stored) return null;
      return JSON.parse(stored).user;
    } catch { return null; }
  };
  const currentUser = getCurrentUser();
  const userRole = currentUser?.role || "";

  const [activeTab, setActiveTab] = useState<TabId>(() => (userRole === "system_admin" ? "llm" : "bot"));

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [createWs, setCreateWs] = useState("");
  const [createName, setCreateName] = useState("");
  const [addCh, setAddCh] = useState("");
  const [rmCh, setRmCh] = useState("");
  type MemberOption = { id: string; type: "bot" | "user"; label: string };
  const [addChOptions, setAddChOptions] = useState<MemberOption[]>([]);
  const [addChLoading, setAddChLoading] = useState(false);
  const [addSelectedIds, setAddSelectedIds] = useState<Set<string>>(new Set());
  const [addingMembers, setAddingMembers] = useState(false);
  const [rmChMembers, setRmChMembers] = useState<MemberOption[]>([]);
  const [rmChLoading, setRmChLoading] = useState(false);
  const [rmSelectedIds, setRmSelectedIds] = useState<Set<string>>(new Set());
  const [removingMembers, setRemovingMembers] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");

  const [botId, setBotId] = useState("");
  const [botUsername, setBotUsername] = useState("");
  const [botDisplayName, setBotDisplayName] = useState("");
  const [botEndpoint, setBotEndpoint] = useState("");
  const [botStatus, setBotStatus] = useState("online");
  const [botIntro, setBotIntro] = useState("");
  const [botPromptTemplate, setBotPromptTemplate] = useState("");
  const [botWizardStep, setBotWizardStep] = useState<0 | 1 | 2>(0);
  const [_botWizardType, setBotWizardType] = useState<"guide" | "http" | "mock" | "mcp">("guide");
  const [lastCreatedBotId, setLastCreatedBotId] = useState("");
  const [botList, setBotList] = useState<BotItem[]>([]);
  const [botEditingId, setBotEditingId] = useState<string | null>(null);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);

  // MCP 导入相关状态
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [mcpConfigJson, setMcpConfigJson] = useState("");
  const [mcpSuggestions, setMcpSuggestions] = useState<MCPBotSuggestion[]>([]);
  const [mcpPreviewLoading, setMcpPreviewLoading] = useState(false);
  const [mcpSelectedIndex, setMcpSelectedIndex] = useState<number | null>(null);

  const [taskList, setTaskList] = useState<TaskItem[]>([]);
  const [taskStats, setTaskStats] = useState<{ total_tasks: number; limit_days: number; per_bot: { username: string; display_name?: string; task_count: number; avg_latency_ms?: number }[] } | null>(null);

  const [llmProviders, setLlmProviders] = useState<LLMProvider[]>([]);
  const [_llmBindings, setLlmBindings] = useState<LLMBindings>({});
  const [llmForm, setLlmForm] = useState({ name: "", base_url: "", model: "", api_key: "", temperature: 0.7, max_tokens: 1000 });
  const [llmEditingId, setLlmEditingId] = useState<string | null>(null);
  const [llmSaveLoading, setLlmSaveLoading] = useState(false);
  const [bindingGuideBot, setBindingGuideBot] = useState("");
  const [bindingSystemLlm, setBindingSystemLlm] = useState("");
  const [bindingLogAnalyze, setBindingLogAnalyze] = useState("");
  const [bindingQaSummarize, setBindingQaSummarize] = useState("");
  const [bindingOrchestrator, setBindingOrchestrator] = useState("");
  const [orchestratorSettings, setOrchestratorSettings] = useState({ orchestrator_direct_answer: false, orchestrator_auto_takeover: false });
  const [clarifySettings, setClarifySettings] = useState<ClarifySettings>({
    clarify_strict_mode: false,
    clarify_force_rule: true,
    clarify_threshold: 0.6,
  });

  const [logLevel, setLogLevel] = useState("");
  const [_logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logExcerpt, setLogExcerpt] = useState("");
  const [logQuestion, setLogQuestion] = useState("");
  const [logAnalysis, setLogAnalysis] = useState("");
  const [logLoading, setLogLoading] = useState(false);

  const [healthStatus, setHealthStatus] = useState<{ database: string; redis: string; guide_llm?: string } | null>(null);

  // 用户管理
  type UserItem = { user_id: string; username: string; display_name?: string; role: string; created_at?: string };
  const [userList, setUserList] = useState<UserItem[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [workspaceUsers, setWorkspaceUsers] = useState<UserItem[]>([]);
  const [workspaceChannels, setWorkspaceChannels] = useState<Channel[]>([]);

  useEffect(() => {
    refreshChannels(setChannels);
    fetch(`${API}/workspaces`).then((r) => r.json()).then((d) => d.data && setWorkspaces(d.data)).catch(console.error);
    fetch(`${API}/bots/registration-requests?status=pending`).then((r) => r.json()).then((d) => setPendingRequests(d.data || [])).catch(() => setPendingRequests([]));
    fetch(`${API}/tasks?limit=50`).then((r) => r.json()).then((d) => setTaskList(d.data || [])).catch(() => setTaskList([]));
    fetch(`${API}/tasks/stats?limit_days=7`).then((r) => r.json()).then((d) => d.data && setTaskStats(d.data)).catch(() => setTaskStats(null));
  }, []);

  useEffect(() => {
    if (activeTab === "perf") {
      fetch(`${API}/tasks?limit=50`).then((r) => r.json()).then((d) => setTaskList(d.data || [])).catch(() => setTaskList([]));
      fetch(`${API}/tasks/stats?limit_days=7`).then((r) => r.json()).then((d) => d.data && setTaskStats(d.data)).catch(() => setTaskStats(null));
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "llm") {
      const url = `${API}/admin/settings/llm`;
      console.log("[AdminPage] fetch LLM settings:", url);
      fetch(url)
        .then((r) => {
          console.log("[AdminPage] fetch LLM settings response:", r.status, r.url);
          return r.json();
        })
        .then((d) => {
          if (d.data) {
            setLlmProviders(d.data.providers || []);
            setLlmBindings(d.data.bindings || {});
            setBindingGuideBot(d.data.bindings?.guide_bot ?? "");
            setBindingSystemLlm(d.data.bindings?.system_llm ?? "");
            setBindingLogAnalyze(d.data.bindings?.log_analyze ?? "");
            setBindingQaSummarize(d.data.bindings?.qa_summarize ?? "");
            setBindingOrchestrator(d.data.bindings?.orchestrator ?? "");
          }
        })
        .catch((e) => {
          console.error("[AdminPage] fetch LLM settings error:", e);
        });
      fetch(`${API}/admin/settings/clarify`)
        .then((r) => r.json())
        .then((d) => {
          if (d.data) {
            setClarifySettings({
              clarify_strict_mode: !!d.data.clarify_strict_mode,
              clarify_force_rule: !!d.data.clarify_force_rule,
              clarify_threshold: Number(d.data.clarify_threshold ?? 0.6),
            });
          }
        })
        .catch((e) => console.error("[AdminPage] fetch clarify settings error:", e));
      fetch(`${API}/admin/settings/orchestrator`)
        .then((r) => r.json())
        .then((d) => {
          if (d.data) {
            setOrchestratorSettings({
              orchestrator_direct_answer: !!d.data.orchestrator_direct_answer,
              orchestrator_auto_takeover: !!d.data.orchestrator_auto_takeover,
            });
          }
        })
        .catch((e) => console.error("[AdminPage] fetch orchestrator settings error:", e));
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "logs") loadLogs();
  }, [activeTab, logLevel]);

  useEffect(() => {
    if (activeTab === "health") {
      fetch(`${API}/admin/health`).then((r) => r.json()).then((d) => d.data && setHealthStatus(d.data)).catch(() => setHealthStatus(null));
    }
  }, [activeTab]);

  // 用户管理
  useEffect(() => {
    if (activeTab === "user" || activeTab === "workspace") {
      fetch(`${API}/auth/users`).then((r) => r.json()).then((d) => setUserList(d || [])).catch(() => setUserList([]));
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "workspace" && selectedWorkspaceId) {
      fetch(`${API}/workspaces/${selectedWorkspaceId}/members`).then((r) => r.json()).then((d) => setWorkspaceUsers(d.data || [])).catch(() => setWorkspaceUsers([]));
      fetch(`${API}/channels/by-workspace/${selectedWorkspaceId}`).then((r) => r.json()).then((d) => setWorkspaceChannels(d.data || [])).catch(() => setWorkspaceChannels([]));
    }
  }, [activeTab, selectedWorkspaceId]);

  useEffect(() => {
    setAddSelectedIds(new Set());
    if (!addCh) { setAddChOptions([]); return; }
    setAddChLoading(true);
    Promise.all([
      fetch(`${API}/channels/${addCh}/members?with_username=1`).then((r) => r.json()),
      fetch(`${API}/bots`).then((r) => r.json()),
      fetch(`${API}/auth/users`).then((r) => r.json()),
    ]).then(([membersRes, botsRes, usersRes]) => {
      const inChannel = new Set<string>((membersRes.data || []).map((m: { member_id: string }) => m.member_id));
      const opts: { id: string; type: "bot" | "user"; label: string }[] = [];
      for (const b of (botsRes.data || [])) {
        if (!inChannel.has(b.bot_id)) opts.push({ id: b.bot_id, type: "bot", label: `[Bot] @${b.username}${b.display_name ? " · " + b.display_name : ""}` });
      }
      for (const u of (usersRes || [])) {
        if (!inChannel.has(u.user_id)) opts.push({ id: u.user_id, type: "user", label: `[用户] @${u.username}${u.display_name ? " · " + u.display_name : ""}` });
      }
      setAddChOptions(opts);
    }).catch(() => setAddChOptions([])).finally(() => setAddChLoading(false));
  }, [addCh]);

  useEffect(() => {
    setRmSelectedIds(new Set());
    if (!rmCh) { setRmChMembers([]); return; }
    setRmChLoading(true);
    Promise.all([
      fetch(`${API}/channels/${rmCh}/members?with_username=1`).then((r) => r.json()),
      fetch(`${API}/auth/users`).then((r) => r.json()),
    ]).then(([membersRes, usersRes]) => {
      const userMap = new Map<string, string>((usersRes || []).map((u: { user_id: string; username: string; display_name?: string }) => [u.user_id, `@${u.username}${u.display_name ? " · " + u.display_name : ""}`]));
      const opts: { id: string; type: "bot" | "user"; label: string }[] = (membersRes.data || []).map((m: { member_id: string; member_type: string; username?: string; display_name?: string }) => {
        const label = m.member_type === "bot"
          ? `[Bot] @${m.username || m.member_id}${m.display_name ? " · " + m.display_name : ""}`
          : `[用户] ${userMap.get(m.member_id) || m.member_id}`;
        return { id: m.member_id, type: m.member_type as "bot" | "user", label };
      });
      setRmChMembers(opts);
    }).catch(() => setRmChMembers([])).finally(() => setRmChLoading(false));
  }, [rmCh]);

  const updateUserRole = (userId: string, role: string) => {
    fetch(`${API}/auth/users/${userId}/role`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) })
      .then((r) => r.json()).then((d) => { if (d.user_id) { setUserList((list) => list.map((u) => u.user_id === userId ? d : u)); toast.success("更新成功"); } else toast.error(d.detail || "更新失败"); }).catch(() => toast.error("请求失败"));
  };

  const loadPendingRequests = () => {
    fetch(`${API}/bots/registration-requests?status=pending`)
      .then((r) => r.json())
      .then((d) => setPendingRequests(d.data || []))
      .catch(() => setPendingRequests([]));
  };

  const loadBots = () => {
    fetch(`${API}/bots`)
      .then((r) => r.json())
      .then((d) => setBotList(d.data || []))
      .catch(() => setBotList([]));
  };

  useEffect(() => {
    if (activeTab === "bot") {
      loadPendingRequests();
      loadBots();
    }
  }, [activeTab]);

  const loadLogs = () => {
    const q = logLevel ? `?level=${encodeURIComponent(logLevel)}&limit=200` : "?limit=200";
    fetch(`${API}/admin/logs${q}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.entries) setLogEntries(d.data.entries);
        if (d.data?.formatted_excerpt) setLogExcerpt(d.data.formatted_excerpt);
      })
      .catch(console.error);
  };


  const saveOrchestratorSettings = () => {
    fetch(`${API}/admin/settings/orchestrator`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orchestratorSettings),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success" && d.data) {
          setOrchestratorSettings({
            orchestrator_direct_answer: !!d.data.orchestrator_direct_answer,
            orchestrator_auto_takeover: !!d.data.orchestrator_auto_takeover,
          });
          toast.success("Orchestrator 配置已保存");
        } else toast.error(d.detail || "保存失败");
      })
      .catch(() => toast.error("请求失败"));
  };

  const saveClarifySettings = () => {
    fetch(`${API}/admin/settings/clarify`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clarifySettings),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success" && d.data) {
          setClarifySettings({
            clarify_strict_mode: !!d.data.clarify_strict_mode,
            clarify_force_rule: !!d.data.clarify_force_rule,
            clarify_threshold: Number(d.data.clarify_threshold ?? 0.6),
          });
          toast.success("澄清策略已保存");
        } else {
          toast.error(d.detail || d.message || "保存失败");
        }
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const saveLlmProvider = (isEdit: boolean) => {
    const { name, base_url, model, api_key, temperature, max_tokens } = llmForm;
    if (!name.trim() || !base_url.trim() || !model.trim()) { toast.error("请填写名称、Base URL、Model"); return; }
    setLlmSaveLoading(true);
    const url = isEdit && llmEditingId ? `${API}/admin/settings/llm/providers/${llmEditingId}` : `${API}/admin/settings/llm/providers`;
    const method = isEdit ? "PUT" : "POST";
    console.log("[AdminPage] saveLlmProvider:", { method, url, name: name.trim(), base_url: base_url.trim(), model: model.trim() });
    fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), base_url: base_url.trim(), model: model.trim(), api_key: api_key.trim(), temperature, max_tokens }),
    })
      .then(async (r) => {
        const text = await r.text();
        console.log("[AdminPage] saveLlmProvider response:", { status: r.status, statusText: r.statusText, url: r.url, bodyPreview: text.slice(0, 300) });
        if (!r.ok) {
          fetch(`${API}/debug/client-error`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ method, url: r.url || url, status: r.status, statusText: r.statusText, detail: text.slice(0, 500) }),
          }).catch(() => {});
        }
        let d: { status?: string; data?: { providers?: LLMProvider[] }; detail?: string | unknown };
        try {
          d = text ? JSON.parse(text) : {};
        } catch {
          throw new Error(r.ok ? "响应格式错误" : `请求失败 (${r.status}): ${text.slice(0, 200)}`);
        }
        if (!r.ok) {
          const msg = typeof d.detail === "string" ? d.detail : Array.isArray(d.detail) ? JSON.stringify(d.detail) : `请求失败 (${r.status})`;
          throw new Error(msg);
        }
        return d;
      })
      .then((d) => {
        if (d.status === "success") {
          toast.success(isEdit ? "已更新" : "已添加");
          setLlmProviders(d.data?.providers || []);
          setLlmForm({ name: "", base_url: "", model: "", api_key: "", temperature: 0.7, max_tokens: 1000 });
          setLlmEditingId(null);
        } else toast.error(String(d.detail || "失败"));
      })
      .catch((e) => {
        console.error("[AdminPage] saveLlmProvider error:", e);
        const errMsg = e?.message || String(e);
        toast.error("请求失败: " + errMsg);
        fetch(`${API}/debug/client-error`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "POST", url, status: errMsg, detail: errMsg }),
        }).catch(() => {});
      })
      .finally(() => setLlmSaveLoading(false));
  };

  const deleteLlmProvider = (id: string) => {
    if (!confirm("确定删除该 LLM 设定？使用该设定的功能将变为未绑定。")) return;
    fetch(`${API}/admin/settings/llm/providers/${id}`, { method: "DELETE" })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") { toast.success("已删除"); setLlmProviders(d.data.providers || []); setBindingGuideBot(d.data.bindings?.guide_bot ?? ""); setBindingSystemLlm(d.data.bindings?.system_llm ?? ""); setBindingLogAnalyze(d.data.bindings?.log_analyze ?? ""); setBindingQaSummarize(d.data.bindings?.qa_summarize ?? ""); setLlmEditingId(null); }
        else toast.error(d.detail || "删除失败");
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const saveLlmBindings = () => {
    fetch(`${API}/admin/settings/llm/bindings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        guide_bot: bindingGuideBot || null,
        system_llm: bindingSystemLlm || null,
        log_analyze: bindingLogAnalyze || null,
        qa_summarize: bindingQaSummarize || null,
        orchestrator: bindingOrchestrator || null,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") { toast.success("功能绑定已保存"); setLlmBindings(d.data.bindings || {}); }
        else toast.error(d.detail || "保存失败");
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const analyzeLogs = () => {
    setLogLoading(true);
    setLogAnalysis("");
    fetch(`${API}/admin/logs/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ log_excerpt: logExcerpt || undefined, question: logQuestion }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.analysis) setLogAnalysis(d.data.analysis);
        else setLogAnalysis(d.detail || "无分析结果");
      })
      .catch((e) => setLogAnalysis("请求失败: " + String(e)))
      .finally(() => setLogLoading(false));
  };

  const createWorkspace = () => {
    if (!workspaceName.trim()) { toast.error("请填写空间名称"); return; }
    fetch(`${API}/workspaces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: workspaceName.trim() }) })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") { toast.success("工作空间创建成功"); setWorkspaceName(""); fetch(`${API}/workspaces`).then((r) => r.json()).then((x) => x.data && setWorkspaces(x.data)); }
        else toast.error(d.message || d.detail || "创建失败");
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const createChannel = () => {
    if (!createWs || !createName.trim()) { toast.error("请选择工作空间并填写项目名称"); return; }
    fetch(`${API}/channels`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace_id: createWs, name: createName.trim(), type: "public", purpose: "" }) })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") { toast.success("创建成功"); setCreateName(""); refreshChannels(setChannels); }
        else toast.error(d.message || "创建失败");
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const addMember = async () => {
    if (!addCh || addSelectedIds.size === 0) { toast.error("请选择项目和成员"); return; }
    setAddingMembers(true);
    try {
      const items = addChOptions.filter((o) => addSelectedIds.has(o.id));
      await Promise.all(items.map((item) =>
        fetch(`${API}/channels/${addCh}/members`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ member_id: item.id, member_type: item.type }) })
          .then((r) => r.json())
      ));
      toast.success(`已添加 ${items.length} 个成员`);
      setAddSelectedIds(new Set());
      // 刷新两个列表
      const membersRes = await fetch(`${API}/channels/${addCh}/members?with_username=1`).then((r) => r.json());
      const inChannel = new Set<string>((membersRes.data || []).map((m: { member_id: string }) => m.member_id));
      setAddChOptions((prev) => prev.filter((o) => !inChannel.has(o.id)));
      if (rmCh === addCh) {
        const [updatedMembers, usersRes] = await Promise.all([
          fetch(`${API}/channels/${rmCh}/members?with_username=1`).then((r) => r.json()),
          fetch(`${API}/auth/users`).then((r) => r.json()),
        ]);
        const userMap = new Map<string, string>((usersRes || []).map((u: { user_id: string; username: string; display_name?: string }) => [u.user_id, `@${u.username}${u.display_name ? " · " + u.display_name : ""}`]));
        setRmChMembers((updatedMembers.data || []).map((m: { member_id: string; member_type: string; username?: string; display_name?: string }) => ({
          id: m.member_id,
          type: m.member_type as "bot" | "user",
          label: m.member_type === "bot" ? `[Bot] @${m.username || m.member_id}${m.display_name ? " · " + m.display_name : ""}` : `[用户] ${userMap.get(m.member_id) || m.member_id}`,
        })));
      }
    } catch (e) { toast.error("请求失败: " + String(e)); }
    finally { setAddingMembers(false); }
  };

  const removeMember = async () => {
    if (!rmCh || rmSelectedIds.size === 0) { toast.error("请选择项目和成员"); return; }
    setRemovingMembers(true);
    try {
      await Promise.all([...rmSelectedIds].map((id) =>
        fetch(`${API}/channels/${rmCh}/members/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => r.json())
      ));
      toast.success(`已移除 ${rmSelectedIds.size} 个成员`);
      setRmChMembers((prev) => prev.filter((m) => !rmSelectedIds.has(m.id)));
      setRmSelectedIds(new Set());
      if (addCh === rmCh) {
        // 刷新可添加列表
        const membersRes = await fetch(`${API}/channels/${addCh}/members?with_username=1`).then((r) => r.json());
        const inChannel = new Set<string>((membersRes.data || []).map((m: { member_id: string }) => m.member_id));
        const [botsRes, usersRes] = await Promise.all([fetch(`${API}/bots`).then((r) => r.json()), fetch(`${API}/auth/users`).then((r) => r.json())]);
        const opts: { id: string; type: "bot" | "user"; label: string }[] = [];
        for (const b of (botsRes.data || [])) if (!inChannel.has(b.bot_id)) opts.push({ id: b.bot_id, type: "bot", label: `[Bot] @${b.username}${b.display_name ? " · " + b.display_name : ""}` });
        for (const u of (usersRes || [])) if (!inChannel.has(u.user_id)) opts.push({ id: u.user_id, type: "user", label: `[用户] @${u.username}${u.display_name ? " · " + u.display_name : ""}` });
        setAddChOptions(opts);
      }
    } catch (e) { toast.error("请求失败: " + String(e)); }
    finally { setRemovingMembers(false); }
  };

  const createBot = () => {
    if (!botUsername.trim() || !botEndpoint.trim()) { toast.error("请填写 @ 名字和 OpenClaw 地址"); return; }
    const body: Record<string, string> = { username: botUsername.trim(), openclaw_endpoint: botEndpoint.trim(), status: botStatus };
    if (botId.trim()) body.bot_id = botId.trim();
    if (botDisplayName.trim()) body.display_name = botDisplayName.trim();
    if (botIntro.trim()) body.intro = botIntro.trim();
    if (botPromptTemplate.trim()) body.prompt_template = botPromptTemplate.trim();
    fetch(`${API}/bots`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") { toast.success("Bot 创建成功"); setLastCreatedBotId(d.data?.bot_id ?? ""); if (botWizardStep === 1) setBotWizardStep(2); setBotId(""); setBotUsername(""); setBotDisplayName(""); setBotEndpoint(""); setBotStatus("online"); setBotIntro(""); setBotPromptTemplate(""); loadBots(); }
        else toast.error(d.message || d.detail || "创建失败");
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const updateBot = (id: string) => {
    const body: Record<string, string> = {
      username: botUsername.trim(),
      display_name: botDisplayName.trim(),
      openclaw_endpoint: botEndpoint.trim(),
      status: botStatus,
      intro: botIntro.trim(),
      prompt_template: botPromptTemplate.trim(),
    };
    fetch(`${API}/bots/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") { toast.success("已更新"); setBotEditingId(null); loadBots(); setBotUsername(""); setBotDisplayName(""); setBotEndpoint(""); setBotStatus("online"); setBotIntro(""); setBotPromptTemplate(""); }
        else toast.error(d.detail || "更新失败");
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const deleteBot = (id: string) => {
    if (!confirm("确定删除该 Bot？")) return;
    fetch(`${API}/bots/${id}`, { method: "DELETE" })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") { toast.success("已删除"); setBotEditingId(null); loadBots(); }
        else toast.error(d.detail || "删除失败");
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  function introSummary(intro: string | undefined): string {
    if (!intro) return "—";
    try {
      const o = JSON.parse(intro);
      if (o.description) return o.description;
      if (Array.isArray(o.capabilities)) return o.capabilities.join(", ");
      return intro.slice(0, 40) + (intro.length > 40 ? "…" : "");
    } catch {
      return intro.slice(0, 40) + (intro.length > 40 ? "…" : "");
    }
  }

  const addBotToChannel = () => {
    if (!lastCreatedBotId || !addCh) { toast.error("请选择要加入的项目"); return; }
    fetch(`${API}/channels/${addCh}/members`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ member_id: lastCreatedBotId, member_type: "bot" }) })
      .then((r) => r.json())
      .then((d) => { if (d.status === "success") { toast.success("已将 Bot 加入项目"); setLastCreatedBotId(""); setBotWizardStep(0); setAddCh(""); } else toast.error(d.message || d.detail || "添加失败"); })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const approveRequest = (id: string) => {
    fetch(`${API}/bots/registration-requests/${id}/approve`, { method: "POST" })
      .then((r) => r.json())
      .then((d) => { if (d.status === "success") { toast.success(d.message || "已通过"); setPendingRequests((p) => p.filter((r) => r.request_id !== id)); } else toast.error(d.detail || "操作失败"); })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const rejectRequest = (id: string) => {
    fetch(`${API}/bots/registration-requests/${id}/reject`, { method: "POST" })
      .then((r) => r.json())
      .then((d) => { if (d.status === "success") { toast.success("已拒绝"); setPendingRequests((p) => p.filter((r) => r.request_id !== id)); } else toast.error(d.detail || "操作失败"); })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const allTabs: { id: TabId; label: string; roles?: string[] }[] = [
    { id: "llm", label: "LLM 参数", roles: ["system_admin"] },
    { id: "perf", label: "性能监控", roles: ["system_admin"] },
    { id: "logs", label: "日志与排查", roles: ["system_admin"] },
    { id: "bot", label: "Bot 与频道" },
    { id: "health", label: "系统状态" },
    { id: "user", label: "用户管理", roles: ["system_admin"] },
    { id: "workspace", label: "工作空间" },
  ];
  const tabs = allTabs.filter((t) => !t.roles || t.roles.includes(userRole));

  return (
    <div className="h-screen bg-[#F8F8F8] flex flex-col overflow-hidden">
      {/* Slack-style header */}
      <header className="flex-shrink-0 bg-[#3F0E40] px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="text-[#C9BDD0] hover:text-white flex items-center gap-1.5 text-sm transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clipRule="evenodd" />
            </svg>
            返回
          </Link>
          <span className="text-white/30">|</span>
          <h1 className="text-white font-semibold text-base">管理后台</h1>
        </div>
        {currentUser && (
          <div className="flex items-center gap-2">
            <span className="text-[#C9BDD0] text-sm">{currentUser.display_name}</span>
            <div className="w-7 h-7 rounded-full bg-[#D0B3D3] text-[#3F0E40] text-xs font-bold flex items-center justify-center">
              {currentUser.display_name.slice(0, 1).toUpperCase()}
            </div>
          </div>
        )}
      </header>
      {/* Tab navigation */}
      <div className="flex-shrink-0 flex border-b border-gray-200 bg-white px-4 gap-0.5 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
              activeTab === t.id
                ? "text-[#1264A3] border-b-2 border-[#1264A3] -mb-px"
                : "text-gray-500 hover:text-gray-800 hover:bg-gray-50"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <main className="flex-1 min-h-0 p-5 overflow-y-auto">
        {activeTab === "llm" && (
          <div className="max-w-3xl space-y-5">
            <div>
              <h2 className="text-base font-semibold text-gray-900">LLM 参数</h2>
              <p className="text-sm text-gray-500 mt-0.5">一层：设定 LLM（增删改、列表）；二层：为各功能从下拉中选择使用的 LLM。</p>
            </div>

            <section className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">LLM 设定</h3>
              <div className="overflow-x-auto mb-4">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">名称</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Base URL</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Model</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {llmProviders.length === 0 ? (
                      <tr><td colSpan={4} className="px-3 py-3 text-gray-400 text-sm">暂无，请先添加</td></tr>
                    ) : llmProviders.map((p) => (
                      <tr key={p.id} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="px-3 py-2">{p.name}</td>
                        <td className="px-3 py-2 truncate max-w-[200px] text-gray-500" title={p.base_url}>{p.base_url}</td>
                        <td className="px-3 py-2 text-gray-600">{p.model}</td>
                        <td className="px-3 py-2">
                          <button type="button" onClick={() => { setLlmEditingId(p.id); setLlmForm({ name: p.name, base_url: p.base_url, model: p.model, api_key: "", temperature: p.temperature, max_tokens: p.max_tokens }); }} className="mr-2 text-[#1264A3] text-xs font-medium hover:underline">编辑</button>
                          <button type="button" onClick={() => deleteLlmProvider(p.id)} className="text-red-500 text-xs font-medium hover:underline">删除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <form className="grid gap-3 text-sm max-w-lg" onSubmit={(e) => e.preventDefault()}>
                <label className="flex items-center gap-3"><span className="w-24 text-gray-600 text-xs">名称</span><input type="text" value={llmForm.name} onChange={(e) => setLlmForm((f) => ({ ...f, name: e.target.value }))} placeholder="如：Ollama 本地" className="border border-gray-300 rounded-lg px-3 py-1.5 flex-1 text-sm focus:outline-none focus:border-[#1264A3]" /></label>
                <label className="flex items-center gap-3"><span className="w-24 text-gray-600 text-xs">Base URL</span><input type="text" value={llmForm.base_url} onChange={(e) => setLlmForm((f) => ({ ...f, base_url: e.target.value }))} placeholder="http://localhost:11434/v1" className="border border-gray-300 rounded-lg px-3 py-1.5 flex-1 text-sm focus:outline-none focus:border-[#1264A3]" /></label>
                <label className="flex items-center gap-3"><span className="w-24 text-gray-600 text-xs">Model</span><input type="text" value={llmForm.model} onChange={(e) => setLlmForm((f) => ({ ...f, model: e.target.value }))} placeholder="llama3" className="border border-gray-300 rounded-lg px-3 py-1.5 flex-1 text-sm focus:outline-none focus:border-[#1264A3]" /></label>
                <label className="flex items-center gap-3"><span className="w-24 text-gray-600 text-xs">API Key</span><input type="password" value={llmForm.api_key} onChange={(e) => setLlmForm((f) => ({ ...f, api_key: e.target.value }))} placeholder={llmEditingId ? "留空不修改" : "选填"} className="border border-gray-300 rounded-lg px-3 py-1.5 flex-1 text-sm focus:outline-none focus:border-[#1264A3]" autoComplete="off" /></label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-3"><span className="w-24 text-gray-600 text-xs">Temperature</span><input type="number" step={0.1} value={llmForm.temperature} onChange={(e) => setLlmForm((f) => ({ ...f, temperature: Number(e.target.value) }))} className="border border-gray-300 rounded-lg px-3 py-1.5 w-20 text-sm focus:outline-none focus:border-[#1264A3]" /></label>
                  <label className="flex items-center gap-3"><span className="w-24 text-gray-600 text-xs">Max Tokens</span><input type="number" value={llmForm.max_tokens} onChange={(e) => setLlmForm((f) => ({ ...f, max_tokens: Number(e.target.value) }))} className="border border-gray-300 rounded-lg px-3 py-1.5 w-24 text-sm focus:outline-none focus:border-[#1264A3]" /></label>
                </div>
                <div className="flex gap-2 items-center pt-1">
                  <button type="button" onClick={() => saveLlmProvider(!!llmEditingId)} disabled={llmSaveLoading} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm font-medium disabled:opacity-60 hover:bg-[#3d1040]">{llmSaveLoading ? "提交中…" : (llmEditingId ? "保存修改" : "新增")}</button>
                  {llmEditingId && <button type="button" onClick={() => { setLlmEditingId(null); setLlmForm({ name: "", base_url: "", model: "", api_key: "", temperature: 0.7, max_tokens: 1000 }); }} disabled={llmSaveLoading} className="px-4 py-1.5 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200">取消</button>}
                </div>
              </form>
            </section>

            <section className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-800 mb-1">功能绑定</h3>
              <p className="text-xs text-gray-500 mb-3">为以下功能选择要使用的 LLM（从上方已添加的设定中选择）。</p>
              <div className="space-y-3 text-sm">
                {[
                  { label: "引导 Bot", value: bindingGuideBot, onChange: setBindingGuideBot, hint: "" },
                  { label: "系统 LLM", value: bindingSystemLlm, onChange: setBindingSystemLlm, hint: "RECENT 压缩等" },
                  { label: "日志分析", value: bindingLogAnalyze, onChange: setBindingLogAnalyze, hint: "未选时使用系统 LLM" },
                  { label: "问答总结", value: bindingQaSummarize, onChange: setBindingQaSummarize, hint: "未选时使用系统 LLM" },
                  { label: "Orchestrator", value: bindingOrchestrator, onChange: setBindingOrchestrator, hint: "直接回答时使用，未选时用系统 LLM" },
                ].map(({ label, value, onChange, hint }) => (
                  <label key={label} className="flex items-center gap-3">
                    <span className="w-28 text-gray-600 text-xs flex-shrink-0">{label}</span>
                    <select value={value} onChange={(e) => onChange(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1.5 flex-1 max-w-xs text-sm focus:outline-none focus:border-[#1264A3]">
                      <option value="">— 不绑定 —</option>
                      {llmProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    {hint && <span className="text-gray-400 text-xs">{hint}</span>}
                  </label>
                ))}
                <button type="button" onClick={saveLlmBindings} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]">保存绑定</button>
              </div>
            </section>

            <section className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-800 mb-1">澄清策略</h3>
              <p className="text-xs text-gray-500 mb-3">用于控制引导 Bot 在问题不清晰时是否弹出澄清窗口。</p>
              <div className="space-y-3 text-sm">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={clarifySettings.clarify_strict_mode} onChange={(e) => setClarifySettings((prev) => ({ ...prev, clarify_strict_mode: e.target.checked }))} className="accent-[#4A154B]" />
                  <span className="text-gray-700">严格模式（更倾向先澄清再回答）</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={clarifySettings.clarify_force_rule} onChange={(e) => setClarifySettings((prev) => ({ ...prev, clarify_force_rule: e.target.checked }))} className="accent-[#4A154B]" />
                  <span className="text-gray-700">允许规则强制澄清（命中规则时直接弹窗）</span>
                </label>
                <label className="flex items-center gap-3">
                  <span className="text-gray-600 text-xs w-36">LLM 澄清阈值（0~1）</span>
                  <input type="number" min={0} max={1} step={0.05} value={clarifySettings.clarify_threshold} onChange={(e) => setClarifySettings((prev) => ({ ...prev, clarify_threshold: Number(e.target.value) }))} className="border border-gray-300 rounded-lg px-3 py-1.5 w-24 text-sm focus:outline-none focus:border-[#1264A3]" />
                </label>
                <button type="button" onClick={saveClarifySettings} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]">保存澄清策略</button>
              </div>
            </section>

            <section className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-800 mb-1">Orchestrator 配置</h3>
              <p className="text-xs text-gray-500 mb-3">Orchestrator 为系统内置 Bot，负责回答业务问题。需先将其加入频道。</p>
              <div className="space-y-3 text-sm">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={orchestratorSettings.orchestrator_direct_answer} onChange={(e) => setOrchestratorSettings((prev) => ({ ...prev, orchestrator_direct_answer: e.target.checked }))} className="accent-[#4A154B]" />
                  <span className="text-gray-700">直接回答未 @ 的问题（未 @ 任何人时由 Orchestrator 回答）</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={orchestratorSettings.orchestrator_auto_takeover} onChange={(e) => setOrchestratorSettings((prev) => ({ ...prev, orchestrator_auto_takeover: e.target.checked }))} className="accent-[#4A154B]" />
                  <span className="text-gray-700">自动接手（Orchestrator 建议 @部门bot 后，被建议 Bot 自动回答）</span>
                </label>
                <button type="button" onClick={saveOrchestratorSettings} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]">保存 Orchestrator 配置</button>
              </div>
            </section>
          </div>
        )}

        {activeTab === "perf" && (
          <div className="max-w-4xl space-y-5">
            <h2 className="text-base font-semibold text-gray-900">性能监控</h2>
            {taskStats && (
              <div className="bg-white rounded-xl border border-gray-200 p-5">
                <h3 className="text-sm font-semibold text-gray-800 mb-3">资源监控（最近 {taskStats.limit_days} 天）</h3>
                <p className="text-sm text-gray-500 mb-3">总任务数：<span className="font-semibold text-gray-800">{taskStats.total_tasks}</span></p>
                <div className="flex flex-wrap gap-3">
                  {taskStats.per_bot.map((b) => (
                    <div key={b.username} className="px-4 py-3 bg-[#F8F8F8] rounded-lg border border-gray-200 text-sm">
                      <div className="font-semibold text-gray-800">@{b.username}</div>
                      <div className="text-gray-500 text-xs mt-0.5">任务数 {b.task_count}{b.avg_latency_ms != null ? ` · 平均 ${Math.round(b.avg_latency_ms)}ms` : ""}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100">
                <p className="text-sm font-medium text-gray-700">最近 Agent 任务执行记录</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Bot</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">频道</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">耗时(ms)</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {taskList.length === 0 ? (
                      <tr><td colSpan={4} className="px-4 py-4 text-gray-400 text-sm">暂无记录</td></tr>
                    ) : taskList.slice(0, 50).map((t) => (
                      <tr key={t.task_id} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="px-4 py-2">{t.bot_username ?? t.task_id.slice(0, 8)}</td>
                        <td className="px-4 py-2 text-gray-500">{t.channel_id?.slice(0, 8)}…</td>
                        <td className="px-4 py-2 text-gray-600">{t.latency_ms ?? "—"}</td>
                        <td className="px-4 py-2 text-gray-500">{t.created_at?.slice(0, 19) ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === "logs" && (
          <div className="max-w-5xl space-y-5">
            <div>
              <h2 className="text-base font-semibold text-gray-900">日志与排查</h2>
              <p className="text-sm text-gray-500 mt-0.5">日志格式面向 LLM 设计，便于「请 LLM 分析」给出可能原因与排查步骤。</p>
            </div>
            <div className="flex gap-2 items-center">
              <select value={logLevel} onChange={(e) => setLogLevel(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#1264A3]">
                <option value="">全部级别</option>
                <option value="DEBUG">DEBUG</option>
                <option value="INFO">INFO</option>
                <option value="WARNING">WARNING</option>
                <option value="ERROR">ERROR</option>
              </select>
              <button type="button" onClick={loadLogs} className="px-4 py-1.5 bg-white border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50">刷新日志</button>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">日志摘要（可编辑后发给 LLM）</label>
                  <textarea value={logExcerpt} onChange={(e) => setLogExcerpt(e.target.value)} className="w-full border border-gray-300 rounded-lg p-2.5 font-mono text-xs h-64 focus:outline-none focus:border-[#1264A3]" placeholder="点击「刷新日志」加载" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">补充问题（可选）</label>
                  <input type="text" value={logQuestion} onChange={(e) => setLogQuestion(e.target.value)} placeholder="例如：为什么连接被拒绝？" className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#1264A3]" />
                </div>
                <button type="button" onClick={analyzeLogs} disabled={logLoading} className="px-4 py-2 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040] disabled:opacity-50">
                  {logLoading ? "分析中…" : "请 LLM 分析"}
                </button>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">LLM 分析结果</label>
                <div className="w-full border border-gray-200 rounded-lg p-3 bg-[#F8F8F8] text-sm whitespace-pre-wrap min-h-64 text-gray-700">
                  {logLoading ? <span className="text-gray-400">分析中…</span> : (logAnalysis || <span className="text-gray-400">—</span>)}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "bot" && (
          <div className="max-w-3xl space-y-5">
            <h2 className="text-base font-semibold text-gray-900">Bot 与频道</h2>

            {/* Bot list */}
            <section className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-800">已注册 Bot 列表</h3>
                <button type="button" onClick={loadBots} className="text-xs text-[#1264A3] font-medium hover:underline">刷新</button>
              </div>
              {botList.length === 0 ? (
                <p className="text-sm text-gray-400">暂无</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">@ 名字</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">显示名</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">endpoint</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">状态</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">能力/描述</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {botList.map((b) => (
                        <tr key={b.bot_id} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="px-3 py-2 font-medium">{b.username}</td>
                          <td className="px-3 py-2 text-gray-600">{b.display_name || "—"}</td>
                          <td className="px-3 py-2 break-all max-w-[120px] text-gray-500 text-xs" title={b.openclaw_endpoint}>{b.openclaw_endpoint}</td>
                          <td className="px-3 py-2">
                            <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${b.status === "online" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>{b.status}</span>
                          </td>
                          <td className="px-3 py-2 max-w-[150px] truncate text-gray-500" title={b.intro || ""}>{introSummary(b.intro)}</td>
                          <td className="px-3 py-2">
                            <button type="button" onClick={() => { setBotEditingId(b.bot_id); setBotUsername(b.username); setBotDisplayName(b.display_name || ""); setBotEndpoint(b.openclaw_endpoint); setBotStatus(b.status); setBotIntro(b.intro || ""); setBotPromptTemplate(b.prompt_template || ""); }} className="mr-2 text-[#1264A3] text-xs font-medium hover:underline">编辑</button>
                            <button type="button" onClick={() => deleteBot(b.bot_id)} className="text-red-500 text-xs font-medium hover:underline">删除</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {botEditingId && (
                <div className="mt-4 p-4 bg-[#F8F8F8] rounded-xl border border-gray-200 text-sm space-y-3">
                  <h4 className="font-semibold text-gray-800">编辑 Bot</h4>
                  <div><label className="block text-xs text-gray-500 mb-1">@ 名字</label><input type="text" value={botUsername} onChange={(e) => setBotUsername(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 w-full focus:outline-none focus:border-[#1264A3]" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">显示名称</label><input type="text" value={botDisplayName} onChange={(e) => setBotDisplayName(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 w-full focus:outline-none focus:border-[#1264A3]" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">openclaw_endpoint</label><input type="text" value={botEndpoint} onChange={(e) => setBotEndpoint(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 w-full focus:outline-none focus:border-[#1264A3]" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">自我介绍 (JSON)</label><textarea value={botIntro} onChange={(e) => setBotIntro(e.target.value)} placeholder='{"capabilities":["能力1"],"description":"描述"}' className="border border-gray-300 rounded-lg px-3 py-2 w-full h-20 focus:outline-none focus:border-[#1264A3] text-sm" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">提示词模板（可选）</label><textarea value={botPromptTemplate} onChange={(e) => setBotPromptTemplate(e.target.value)} placeholder="你是一个专业的助手。用户问题：{{}} 请用中文回答。" className="border border-gray-300 rounded-lg px-3 py-2 w-full h-20 focus:outline-none focus:border-[#1264A3] text-sm" /><p className="text-xs text-gray-400 mt-1">使用 {"{{}}"} 作为用户消息的占位符</p></div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => updateBot(botEditingId)} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]">保存</button>
                    <button type="button" onClick={() => { setBotEditingId(null); setBotUsername(""); setBotDisplayName(""); setBotEndpoint(""); setBotStatus("online"); setBotIntro(""); setBotPromptTemplate(""); }} className="px-4 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-300">取消</button>
                  </div>
                </div>
              )}
            </section>

            {/* Quick actions */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <section className="bg-white rounded-xl border border-gray-200 p-4">
                <h3 className="text-sm font-semibold text-gray-800 mb-3">创建工作空间</h3>
                <div className="flex gap-2">
                  <input type="text" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="空间名称" className="border border-gray-300 rounded-lg px-3 py-1.5 flex-1 text-sm focus:outline-none focus:border-[#1264A3]" />
                  <button type="button" onClick={createWorkspace} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]">创建</button>
                </div>
              </section>
              <section className="bg-white rounded-xl border border-gray-200 p-4">
                <h3 className="text-sm font-semibold text-gray-800 mb-3">创建项目</h3>
                <div className="flex flex-wrap gap-2">
                  <select value={createWs} onChange={(e) => setCreateWs(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm flex-1 focus:outline-none focus:border-[#1264A3]"><option value="">选择工作空间</option>{workspaces.map((w) => <option key={w.workspace_id} value={w.workspace_id}>{w.name}</option>)}</select>
                  <input type="text" value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="项目名称" className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm flex-1 focus:outline-none focus:border-[#1264A3]" />
                  <button type="button" onClick={createChannel} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]">创建</button>
                </div>
              </section>
              <section className="bg-white rounded-xl border border-gray-200 p-4">
                <h3 className="text-sm font-semibold text-gray-800 mb-3">添加成员</h3>
                <div className="flex flex-col gap-2">
                  <select value={addCh} onChange={(e) => setAddCh(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-[#1264A3]"><option value="">选择项目</option>{channels.map((c) => <option key={c.channel_id} value={c.channel_id}># {c.name}</option>)}</select>
                  {addCh && (
                    <>
                      {addChLoading ? (
                        <p className="text-xs text-gray-400">加载中…</p>
                      ) : addChOptions.length === 0 ? (
                        <p className="text-xs text-gray-400">暂无可添加的成员</p>
                      ) : (
                        <ul className="max-h-40 overflow-y-auto space-y-1 border border-gray-100 rounded-lg p-1">
                          {addChOptions.map((o) => {
                            const checked = addSelectedIds.has(o.id);
                            return (
                              <li
                                key={o.id}
                                className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm select-none transition-colors ${checked ? "bg-blue-50 border border-[#1264A3]/30" : "hover:bg-gray-50"}`}
                                onClick={() => setAddSelectedIds((prev) => { const n = new Set(prev); if (n.has(o.id)) n.delete(o.id); else n.add(o.id); return n; })}
                              >
                                <input type="checkbox" className="accent-[#1264A3] shrink-0" checked={checked} onChange={() => {}} onClick={(e) => e.stopPropagation()} />
                                <span className="truncate text-gray-700">{o.label}</span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      <button type="button" onClick={addMember} disabled={addingMembers || addSelectedIds.size === 0} className="px-4 py-1.5 bg-[#1264A3] text-white rounded-lg text-sm font-medium hover:bg-[#0d5296] disabled:opacity-50 self-end">
                        {addingMembers ? "添加中…" : `添加选中${addSelectedIds.size > 0 ? ` (${addSelectedIds.size})` : ""}`}
                      </button>
                    </>
                  )}
                </div>
              </section>
              <section className="bg-white rounded-xl border border-gray-200 p-4">
                <h3 className="text-sm font-semibold text-gray-800 mb-3">移除成员</h3>
                <div className="flex flex-col gap-2">
                  <select value={rmCh} onChange={(e) => setRmCh(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-[#1264A3]"><option value="">选择项目</option>{channels.map((c) => <option key={c.channel_id} value={c.channel_id}># {c.name}</option>)}</select>
                  {rmCh && (
                    <>
                      {rmChLoading ? (
                        <p className="text-xs text-gray-400">加载中…</p>
                      ) : rmChMembers.length === 0 ? (
                        <p className="text-xs text-gray-400">该频道暂无成员</p>
                      ) : (
                        <ul className="max-h-40 overflow-y-auto space-y-1 border border-gray-100 rounded-lg p-1">
                          {rmChMembers.map((o) => {
                            const checked = rmSelectedIds.has(o.id);
                            return (
                              <li
                                key={o.id}
                                className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm select-none transition-colors ${checked ? "bg-red-50 border border-red-300/50" : "hover:bg-gray-50"}`}
                                onClick={() => setRmSelectedIds((prev) => { const n = new Set(prev); if (n.has(o.id)) n.delete(o.id); else n.add(o.id); return n; })}
                              >
                                <input type="checkbox" className="accent-red-500 shrink-0" checked={checked} onChange={() => {}} onClick={(e) => e.stopPropagation()} />
                                <span className="truncate text-gray-700">{o.label}</span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      <button type="button" onClick={removeMember} disabled={removingMembers || rmSelectedIds.size === 0} className="px-4 py-1.5 bg-red-50 text-red-700 border border-red-200 rounded-lg text-sm font-medium hover:bg-red-100 disabled:opacity-50 self-end">
                        {removingMembers ? "移除中…" : `移除选中${rmSelectedIds.size > 0 ? ` (${rmSelectedIds.size})` : ""}`}
                      </button>
                    </>
                  )}
                </div>
              </section>
            </div>

            {/* Bot wizard */}
            <section className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">Bot 添加向导</h3>
              {botWizardStep === 0 && (
                <div className="flex gap-2 flex-wrap">
                  <button type="button" onClick={() => { setBotWizardType("guide"); setBotEndpoint("guide://"); setBotWizardStep(1); }} className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 text-gray-700">引导 Bot</button>
                  <button type="button" onClick={() => { setBotWizardType("http"); setBotEndpoint("https://"); setBotWizardStep(1); }} className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 text-gray-700">真实 OpenClaw</button>
                  <button type="button" onClick={() => { setBotWizardType("mock"); setBotEndpoint("mock://"); setBotWizardStep(1); }} className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 text-gray-700">Mock</button>
                  <button type="button" onClick={() => setMcpModalOpen(true)} className="px-4 py-2 border border-purple-300 bg-purple-50 rounded-lg text-sm font-medium text-purple-700 hover:bg-purple-100">从 MCP 导入</button>
                </div>
              )}
              {botWizardStep === 1 && (
                <div className="space-y-3 text-sm max-w-lg">
                  {_botWizardType === "mcp" && (
                    <div className="p-3 bg-purple-50 border border-purple-200 rounded-lg text-xs text-purple-700">
                      已从 MCP 配置导入，请检查并修改后创建
                    </div>
                  )}
                  <div><label className="block text-xs text-gray-500 mb-1">@ 用名字</label><input type="text" value={botUsername} onChange={(e) => setBotUsername(e.target.value)} placeholder="如：mybot" className="border border-gray-300 rounded-lg px-3 py-1.5 w-full focus:outline-none focus:border-[#1264A3]" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">显示名称</label><input type="text" value={botDisplayName} onChange={(e) => setBotDisplayName(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 w-full focus:outline-none focus:border-[#1264A3]" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">openclaw_endpoint</label><input type="text" value={botEndpoint} onChange={(e) => setBotEndpoint(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 w-full focus:outline-none focus:border-[#1264A3]" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">自我介绍 (JSON，含 capabilities 或 description)</label><textarea value={botIntro} onChange={(e) => setBotIntro(e.target.value)} placeholder='{"capabilities":["能力1","能力2"],"description":"简短描述"}' className="border border-gray-300 rounded-lg px-3 py-2 w-full h-20 focus:outline-none focus:border-[#1264A3]" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">提示词模板（可选）</label><textarea value={botPromptTemplate} onChange={(e) => setBotPromptTemplate(e.target.value)} placeholder="你是一个专业的助手。用户问题：{{}} 请用中文回答。" className="border border-gray-300 rounded-lg px-3 py-2 w-full h-20 focus:outline-none focus:border-[#1264A3]" /><p className="text-xs text-gray-400 mt-1">使用 {"{{}}"} 作为用户消息的占位符</p></div>
                  <div className="flex gap-2">
                    <button type="button" onClick={createBot} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]">创建</button>
                    <button type="button" onClick={() => setBotWizardStep(0)} className="px-4 py-1.5 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200">上一步</button>
                  </div>
                </div>
              )}
              {botWizardStep === 2 && (
                <div className="space-y-3 text-sm">
                  <p className="text-[#007a5a] font-medium">Bot 已创建，请加入项目。</p>
                  <div className="flex gap-2">
                    <select value={addCh} onChange={(e) => setAddCh(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:border-[#1264A3]"><option value="">选择项目</option>{channels.map((c) => <option key={c.channel_id} value={c.channel_id}># {c.name}</option>)}</select>
                    <button type="button" onClick={addBotToChannel} className="px-4 py-1.5 bg-[#1264A3] text-white rounded-lg text-sm font-medium hover:bg-[#0d5296]">将 Bot 加入所选项目</button>
                  </div>
                  <button type="button" onClick={() => { setBotWizardStep(0); setLastCreatedBotId(""); }} className="text-gray-400 text-xs hover:text-gray-600">完成</button>
                </div>
              )}
            </section>

            {/* Advanced create bot */}
            <section className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">创建 Bot（高级）</h3>
              <div className="mb-3">
                <button type="button" onClick={() => setMcpModalOpen(true)} className="px-4 py-2 border border-purple-300 bg-purple-50 rounded-lg text-sm font-medium text-purple-700 hover:bg-purple-100">
                  从 MCP 配置导入
                </button>
                <span className="text-xs text-gray-400 ml-2">支持 Claude Desktop 的 mcpServers 配置</span>
              </div>
              <div className="grid grid-cols-1 gap-2 text-sm max-w-lg">
                {[
                  { label: "bot_id（可选）", value: botId, setter: setBotId, type: "text" },
                  { label: "username", value: botUsername, setter: setBotUsername, type: "text" },
                  { label: "display_name", value: botDisplayName, setter: setBotDisplayName, type: "text" },
                  { label: "openclaw_endpoint", value: botEndpoint, setter: setBotEndpoint, type: "text" },
                ].map(({ label, value, setter, type }) => (
                  <label key={label} className="flex items-center gap-3">
                    <span className="w-36 text-xs text-gray-500 flex-shrink-0">{label}</span>
                    <input type={type} value={value} onChange={(e) => setter(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 flex-1 focus:outline-none focus:border-[#1264A3]" />
                  </label>
                ))}
                <label className="flex items-center gap-3">
                  <span className="w-36 text-xs text-gray-500 flex-shrink-0">status</span>
                  <select value={botStatus} onChange={(e) => setBotStatus(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1.5 flex-1 focus:outline-none focus:border-[#1264A3]"><option value="online">online</option><option value="offline">offline</option></select>
                </label>
                <div className="flex gap-3">
                  <span className="w-36 text-xs text-gray-500 flex-shrink-0 pt-1.5">intro (JSON)</span>
                  <textarea value={botIntro} onChange={(e) => setBotIntro(e.target.value)} placeholder='{"capabilities":["能力1"],"description":"描述"}' className="border border-gray-300 rounded-lg px-3 py-2 flex-1 h-16 focus:outline-none focus:border-[#1264A3] text-sm" />
                </div>
                <div className="flex gap-3">
                  <span className="w-36 text-xs text-gray-500 flex-shrink-0 pt-1.5">提示词模板</span>
                  <div className="flex-1">
                    <textarea value={botPromptTemplate} onChange={(e) => setBotPromptTemplate(e.target.value)} placeholder="你是一个专业的助手。用户问题：{{}} 请用中文回答。" className="border border-gray-300 rounded-lg px-3 py-2 w-full h-16 focus:outline-none focus:border-[#1264A3] text-sm" />
                    <p className="text-xs text-gray-400 mt-1">使用 {"{{}}"} 作为用户消息的占位符</p>
                  </div>
                </div>
              </div>
              <button type="button" onClick={createBot} className="mt-3 px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]">创建</button>
            </section>

            {/* Pending requests */}
            <section className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-800">待审核 Bot 申请</h3>
                <button type="button" onClick={loadPendingRequests} className="text-xs text-[#1264A3] font-medium hover:underline">刷新</button>
              </div>
              {pendingRequests.length === 0 ? <p className="text-sm text-gray-400">暂无</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">username</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">endpoint</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">自我介绍</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingRequests.map((r) => (
                        <tr key={r.request_id} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="px-3 py-2 font-medium">{r.username}</td>
                          <td className="px-3 py-2 break-all text-gray-500 text-xs">{r.openclaw_endpoint}</td>
                          <td className="px-3 py-2 max-w-[150px] truncate text-gray-500" title={r.intro || ""}>{introSummary(r.intro)}</td>
                          <td className="px-3 py-2">
                            <button type="button" onClick={() => approveRequest(r.request_id)} className="mr-2 px-2.5 py-0.5 bg-green-100 text-green-700 rounded text-xs font-medium hover:bg-green-200">通过</button>
                            <button type="button" onClick={() => rejectRequest(r.request_id)} className="px-2.5 py-0.5 bg-red-50 text-red-600 rounded text-xs font-medium hover:bg-red-100">拒绝</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <p className="text-sm"><a href="/docs" target="_blank" rel="noreferrer" className="text-[#1264A3] hover:underline font-medium">打开 API 文档</a></p>

            {/* MCP 导入模态框 */}
            {mcpModalOpen && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col">
                  <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
                    <h3 className="text-base font-semibold text-gray-900">从 MCP 配置导入 Bot</h3>
                    <button onClick={() => { setMcpModalOpen(false); setMcpConfigJson(""); setMcpSuggestions([]); setMcpSelectedIndex(null); }} className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600">✕</button>
                  </div>
                  <div className="p-5 overflow-y-auto flex-1">
                    <div className="mb-4">
                      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">MCP 配置文件内容 (JSON)</label>
                      <textarea
                        value={mcpConfigJson}
                        onChange={(e) => setMcpConfigJson(e.target.value)}
                        placeholder={`示例：\n{\n  "mcpServers": {\n    "fetch": {\n      "command": "uvx",\n      "args": ["mcp-server-fetch"],\n      "description": "Fetch web content"\n    }\n  }\n}`}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-xs h-40 focus:outline-none focus:border-[#1264A3]"
                      />
                      <p className="text-xs text-gray-400 mt-1">支持 Claude Desktop 的 mcpServers 配置格式</p>
                    </div>
                    <button
                      onClick={async () => {
                        if (!mcpConfigJson.trim()) { toast.error("请输入 MCP 配置"); return; }
                        setMcpPreviewLoading(true);
                        try {
                          const res = await fetch(`${API}/mcp/preview`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ config_json: mcpConfigJson }),
                          });
                          const d = await res.json();
                          if (d.status === "success" && d.data?.suggestions) {
                            setMcpSuggestions(d.data.suggestions);
                            if (d.data.suggestions.length === 0) toast.error("未找到有效的 MCP Server 配置");
                            else toast.success(`找到 ${d.data.suggestions.length} 个可导入的配置`);
                          } else {
                            toast.error(d.detail || "解析失败");
                          }
                        } catch (e) {
                          toast.error("请求失败: " + String(e));
                        } finally {
                          setMcpPreviewLoading(false);
                        }
                      }}
                      disabled={mcpPreviewLoading}
                      className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-purple-700"
                    >
                      {mcpPreviewLoading ? "解析中…" : "预览配置"}
                    </button>

                    {mcpSuggestions.length > 0 && (
                      <div className="mt-4">
                        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">找到的服务器配置</h4>
                        <div className="space-y-2">
                          {mcpSuggestions.map((s, idx) => (
                            <div
                              key={idx}
                              onClick={() => setMcpSelectedIndex(idx)}
                              className={`p-3 border rounded-lg cursor-pointer transition-colors ${mcpSelectedIndex === idx ? "border-purple-500 bg-purple-50" : "border-gray-200 hover:border-purple-300 hover:bg-gray-50"}`}
                            >
                              <div className="flex items-center justify-between">
                                <span className="font-semibold text-sm text-gray-800">{s.server_name}</span>
                                <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded font-medium">{s.transport_type}</span>
                              </div>
                              <div className="text-xs text-gray-500 mt-1">
                                @{s.suggested_username} → {s.suggested_endpoint}
                              </div>
                              <div className="text-xs text-gray-600 mt-1">{s.suggested_intro.description}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="px-5 py-4 border-t border-gray-200 flex justify-end gap-2">
                    <button onClick={() => { setMcpModalOpen(false); setMcpConfigJson(""); setMcpSuggestions([]); setMcpSelectedIndex(null); }} className="px-4 py-2 text-gray-600 text-sm font-medium hover:bg-gray-50 rounded-lg">取消</button>
                    <button
                      onClick={() => {
                        if (mcpSelectedIndex === null) { toast.error("请选择要导入的服务器"); return; }
                        const s = mcpSuggestions[mcpSelectedIndex];
                        setBotUsername(s.suggested_username);
                        setBotDisplayName(s.suggested_display_name);
                        setBotEndpoint(s.suggested_endpoint);
                        setBotIntro(JSON.stringify(s.suggested_intro, null, 2));
                        setBotWizardType("mcp");
                        setMcpModalOpen(false);
                        setMcpSuggestions([]);
                        setMcpSelectedIndex(null);
                        setBotWizardStep(1);
                        toast.success("配置已填充，请检查并创建 Bot");
                      }}
                      disabled={mcpSelectedIndex === null}
                      className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-purple-700"
                    >
                      导入选中配置
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "health" && (
          <div className="max-w-md space-y-5">
            <h2 className="text-base font-semibold text-gray-900">系统状态</h2>
            {healthStatus ? (
              <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
                {[
                  { label: "数据库", value: healthStatus.database, good: healthStatus.database === "ok" },
                  { label: "Redis", value: healthStatus.redis, good: healthStatus.redis === "ok" },
                  { label: "引导 LLM", value: healthStatus.guide_llm ?? "—", good: healthStatus.guide_llm === "ok", warn: healthStatus.guide_llm === "degraded (503)" },
                ].map(({ label, value, good, warn }) => (
                  <div key={label} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                    <span className="text-sm font-medium text-gray-700">{label}</span>
                    <span className={`text-sm font-semibold px-2.5 py-0.5 rounded-full ${
                      good ? "bg-green-100 text-green-700" : warn ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"
                    }`}>{value}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 p-5">
                <p className="text-gray-400 text-sm">加载中…</p>
              </div>
            )}
          </div>
        )}

        {activeTab === "user" && (
          <div className="max-w-4xl space-y-5">
            <h2 className="text-base font-semibold text-gray-900">用户管理</h2>

            {/* 新建用户表单 */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">新建用户</h3>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  const username = fd.get("username") as string;
                  const password = fd.get("password") as string;
                  const display_name = fd.get("display_name") as string;
                  if (!username || !password) return;
                  fetch(`${API}/auth/register`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ username, password, display_name }),
                  })
                    .then((r) => r.json())
                    .then((d) => {
                      if (d.user_id) {
                        toast.success("创建成功");
                        setUserList((list) => [...list, d]);
                        (e.target as HTMLFormElement).reset();
                      } else {
                        toast.error(d.detail || "创建失败");
                      }
                    })
                    .catch(() => toast.error("请求失败"));
                }}
                className="flex flex-wrap gap-3 items-end"
              >
                <div>
                  <label className="text-xs font-medium text-gray-500 block mb-1">用户名</label>
                  <input name="username" required className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#1264A3]" />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500 block mb-1">显示名</label>
                  <input name="display_name" className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#1264A3]" />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500 block mb-1">密码</label>
                  <input name="password" type="password" required className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#1264A3]" />
                </div>
                <button type="submit" className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]">新建用户</button>
              </form>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">用户名</th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">显示名</th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">角色</th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">创建时间</th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {userList.map((u) => (
                    <tr key={u.user_id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-2.5 font-medium">{u.username}</td>
                      <td className="px-4 py-2.5 text-gray-600">{u.display_name || "—"}</td>
                      <td className="px-4 py-2.5">
                        <select value={u.role} onChange={(e) => updateUserRole(u.user_id, e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:border-[#1264A3]">
                          <option value="system_admin">系统管理员</option>
                          <option value="space_admin">空间管理员</option>
                          <option value="channel_admin">频道管理员</option>
                          <option value="member">成员</option>
                          <option value="guest">访客</option>
                        </select>
                      </td>
                      <td className="px-4 py-2.5 text-gray-500">{u.created_at ? new Date(u.created_at).toLocaleDateString() : "—"}</td>
                      <td className="px-4 py-2.5">
                        <button onClick={() => { fetch(`${API}/auth/users/reset-password/${u.user_id}`, { method: "POST" }).then((r) => r.json()).then((d) => { if (d.status === "success") { toast.success("密码已重置为 123456"); } else { toast.error(d.detail || "重置失败"); } }).catch(() => toast.error("请求失败")); }} className="text-[#1264A3] text-xs font-medium hover:underline mr-3">重置密码</button>
                        <button onClick={() => { if (confirm("确定删除该用户？")) { fetch(`${API}/auth/users/${u.user_id}`, { method: "DELETE" }).then(() => setUserList((list) => list.filter((x) => x.user_id !== u.user_id))); }}} className="text-red-500 text-xs font-medium hover:underline">删除</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {userList.length === 0 && <p className="text-gray-400 px-4 py-4 text-sm">暂无用户</p>}
            </div>
          </div>
        )}

        {activeTab === "workspace" && (
          <div className="max-w-4xl space-y-5">
            <h2 className="text-base font-semibold text-gray-900">工作空间管理</h2>

            {/* 我的工作空间列表 - 点击选择 */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">我的工作空间</h3>
              <div className="flex flex-wrap gap-2 mb-4">
                {workspaces.map((ws) => (
                  <button
                    key={ws.workspace_id}
                    onClick={() => setSelectedWorkspaceId(ws.workspace_id)}
                    className={`px-4 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                      selectedWorkspaceId === ws.workspace_id
                        ? "bg-[#4A154B] text-white border-[#4A154B]"
                        : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                    }`}
                  >
                    {ws.name}
                  </button>
                ))}
              </div>

              {(userRole === "system_admin" || userRole === "space_admin") && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const fd = new FormData(e.currentTarget);
                    const name = fd.get("wsname") as string;
                    if (!name) return;
                    fetch(`${API}/workspaces`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name }),
                    })
                      .then((r) => r.json())
                      .then((d) => {
                        if (d.status === "success") {
                          toast.success("创建成功");
                          setWorkspaces((ws) => [...ws, d.data]);
                          setSelectedWorkspaceId(d.data.workspace_id);
                          (e.target as HTMLFormElement).reset();
                        } else {
                          toast.error(d.detail || "创建失败");
                        }
                      })
                      .catch(() => toast.error("请求失败"));
                  }}
                  className="flex gap-2"
                >
                  <input name="wsname" placeholder="新工作空间名称" required className="border border-gray-300 rounded-lg px-3 py-1.5 flex-1 text-sm focus:outline-none focus:border-[#1264A3]" />
                  <button type="submit" className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]">新增空间</button>
                </form>
              )}
            </div>

            {/* 选中的工作空间详情 */}
            {selectedWorkspaceId && (
              <div className="grid grid-cols-2 gap-4">
                {/* 成员管理 */}
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <h3 className="text-sm font-semibold text-gray-800 mb-3">成员管理</h3>
                  {(userRole === "system_admin" || userRole === "space_admin") && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const fd = new FormData(e.currentTarget);
                        const username = fd.get("username") as string;
                        if (!username) return;
                        const user = userList.find((u) => u.username === username);
                        if (!user) { toast.error("用户不存在"); return; }
                        if (workspaceChannels.length > 0) {
                          fetch(`${API}/channels/${workspaceChannels[0].channel_id}/members`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ member_id: user.user_id, member_type: "user" }),
                          })
                            .then((r) => r.json())
                            .then((d) => {
                              if (d.status === "success") { toast.success("添加成功"); setWorkspaceUsers((list) => [...list, user]); }
                              else toast.error(d.detail || "添加失败");
                            })
                            .catch(() => toast.error("请求失败"));
                        } else { toast.error("请先创建频道"); }
                        (e.target as HTMLFormElement).reset();
                      }}
                      className="flex gap-2 mb-3"
                    >
                      <input name="username" placeholder="用户名" required className="border border-gray-300 rounded-lg px-3 py-1.5 flex-1 text-sm focus:outline-none focus:border-[#1264A3]" />
                      <button type="submit" className="px-3 py-1.5 bg-[#007a5a] text-white rounded-lg text-sm font-medium hover:bg-[#006a4d]">添加</button>
                    </form>
                  )}
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left py-1.5 text-gray-500 font-semibold uppercase tracking-wide">用户名</th>
                        <th className="text-left py-1.5 text-gray-500 font-semibold uppercase tracking-wide">显示名</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workspaceUsers.map((u) => (
                        <tr key={u.user_id} className="border-b border-gray-50">
                          <td className="py-1.5 font-medium text-gray-800">{u.username}</td>
                          <td className="py-1.5 text-gray-500">{u.display_name || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {workspaceUsers.length === 0 && <p className="text-gray-400 text-xs mt-2">暂无成员</p>}
                </div>

                {/* 频道管理 */}
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <h3 className="text-sm font-semibold text-gray-800 mb-3">频道管理</h3>
                  {(userRole === "system_admin" || userRole === "space_admin" || userRole === "channel_admin") && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const fd = new FormData(e.currentTarget);
                        const name = fd.get("channelname") as string;
                        if (!name) return;
                        fetch(`${API}/channels`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ workspace_id: selectedWorkspaceId, name, type: "public" }),
                        })
                          .then((r) => r.json())
                          .then((d) => {
                            if (d.status === "success") { toast.success("创建成功"); setWorkspaceChannels((list) => [...list, d.data]); }
                            else toast.error(d.detail || "创建失败");
                          })
                          .catch(() => toast.error("请求失败"));
                        (e.target as HTMLFormElement).reset();
                      }}
                      className="flex gap-2 mb-3"
                    >
                      <input name="channelname" placeholder="新频道名称" required className="border border-gray-300 rounded-lg px-3 py-1.5 flex-1 text-sm focus:outline-none focus:border-[#1264A3]" />
                      <button type="submit" className="px-3 py-1.5 bg-[#007a5a] text-white rounded-lg text-sm font-medium hover:bg-[#006a4d]">新增</button>
                    </form>
                  )}
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left py-1.5 text-gray-500 font-semibold uppercase tracking-wide">频道名</th>
                        <th className="text-left py-1.5 text-gray-500 font-semibold uppercase tracking-wide">类型</th>
                        {(userRole === "system_admin" || userRole === "space_admin" || userRole === "channel_admin") && <th className="text-left py-1.5"></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {workspaceChannels.map((ch) => (
                        <tr key={ch.channel_id} className="border-b border-gray-50">
                          <td className="py-1.5 font-medium text-gray-800">{ch.name}</td>
                          <td className="py-1.5 text-gray-500">{ch.type}</td>
                          {(userRole === "system_admin" || userRole === "space_admin" || userRole === "channel_admin") && (
                            <td className="py-1.5">
                              <button
                                onClick={() => {
                                  if (confirm("确定删除该频道？")) {
                                    fetch(`${API}/channels/${ch.channel_id}`, { method: "DELETE" })
                                      .then((r) => r.json())
                                      .then((d) => {
                                        if (d.status === "success") { toast.success("删除成功"); setWorkspaceChannels((list) => list.filter((c) => c.channel_id !== ch.channel_id)); }
                                        else toast.error(d.detail || "删除失败");
                                      })
                                      .catch(() => toast.error("请求失败"));
                                  }
                                }}
                                className="text-red-500 hover:underline font-medium"
                              >
                                删除
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {workspaceChannels.length === 0 && <p className="text-gray-400 text-xs mt-2">暂无频道</p>}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
