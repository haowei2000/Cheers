import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";

const API = "/api";

type TabId = "models" | "templates" | "bot" | "llm" | "perf" | "logs" | "health" | "user" | "workspace" | "image_api";

// ==================== AI Model Types ====================
type AIModel = {
  model_id: string;
  name: string;
  provider: string;
  model_name: string;
  base_url: string;
  api_key_masked?: string;
  description?: string;
  is_enabled: boolean;
  is_builtin: boolean;
  config?: Record<string, unknown>;
  created_at?: string;
};

// ==================== Prompt Template Types ====================
type PromptTemplate = {
  template_id: string;
  name: string;
  description?: string;
  system_prompt: string;
  user_template: string;
  variables: string[];
  is_builtin: boolean;
  created_at?: string;
};

// ==================== Bot Types ====================
type BotItem = {
  bot_id: string;
  username: string;
  display_name?: string;
  description?: string;
  avatar_url?: string;
  status: string;
  intro?: string;
  custom_system_prompt?: string;
  model_id: string;
  template_id: string;
  model_name?: string;
  template_name?: string;
  created_by?: string;
  created_at?: string;
};

// ==================== Other Types ====================
type Workspace = { workspace_id: string; name: string };
type Channel = { channel_id: string; name: string; type: string };
type TaskItem = { task_id: string; channel_id: string; bot_id?: string; bot_username?: string; latency_ms?: number; created_at?: string };
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

function refreshChannels(setChannels: (c: Channel[]) => void, token?: string) {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  fetch(`${API}/channels`, { headers }).then((r) => r.json()).then((d) => d.data && setChannels(d.data)).catch(console.error);
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

  // 带认证头的 fetch 工具
  const token = currentUser?.user_id;
  const authFetch = (url: string, options: RequestInit = {}) =>
    fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers as Record<string, string> | undefined),
      },
    });

  const [activeTab, setActiveTab] = useState<TabId>("models");

  // ==================== Workspace & Channel States ====================
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

  // ==================== AI Model States ====================
  const [models, setModels] = useState<AIModel[]>([]);
  const [modelForm, setModelForm] = useState({
    name: "",
    provider: "ollama",
    model_name: "",
    base_url: "",
    api_key: "",
    description: "",
    is_enabled: true,
    supports_vision: false,
    extra_headers: "",   // JSON 字符串，如 {"x-my-header":"value"}
  });
  const [modelEditingId, setModelEditingId] = useState<string | null>(null);

  // ==================== Prompt Template States ====================
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [templateForm, setTemplateForm] = useState({
    name: "",
    description: "",
    system_prompt: "",
    user_template: "{{message}}",
    variables: ["message"],
  });
  const [templateEditingId, setTemplateEditingId] = useState<string | null>(null);

  // ==================== Bot States ====================
  const [botList, setBotList] = useState<BotItem[]>([]);
  const [botForm, setBotForm] = useState({
    username: "",
    display_name: "",
    description: "",
    model_id: "",
    template_id: "",
    custom_system_prompt: "",
    intro: "",
    status: "online",
  });
  const [botEditingId, setBotEditingId] = useState<string | null>(null);
  const [lastCreatedBotId, setLastCreatedBotId] = useState("");

  // ==================== Legacy States ====================
  const [taskList, setTaskList] = useState<TaskItem[]>([]);
  const [taskStats, setTaskStats] = useState<{ total_tasks: number; limit_days: number; per_bot: { username: string; display_name?: string; task_count: number; avg_latency_ms?: number }[] } | null>(null);
  const [llmProviders, setLlmProviders] = useState<LLMProvider[]>([]);
  const [_llmBindings, setLlmBindings] = useState<LLMBindings>({});
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_llmForm, _setLlmForm] = useState({ name: "", base_url: "", model: "", api_key: "", temperature: 0.7, max_tokens: 1000 });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_llmEditingId, _setLlmEditingId] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_llmSaveLoading, _setLlmSaveLoading] = useState(false);
  const [bindingGuideBot, setBindingGuideBot] = useState("");
  const [bindingSystemLlm, setBindingSystemLlm] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_bindingLogAnalyze, setBindingLogAnalyze] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_bindingQaSummarize, setBindingQaSummarize] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_bindingOrchestrator, setBindingOrchestrator] = useState("");
  const [orchestratorSettings, setOrchestratorSettings] = useState({ orchestrator_direct_answer: false, orchestrator_auto_takeover: false });
  const [clarifySettings, setClarifySettings] = useState<ClarifySettings>({
    clarify_strict_mode: false,
    clarify_force_rule: true,
    clarify_threshold: 0.6,
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_logLevel, _setLogLevel] = useState("");
  const [_logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logExcerpt, setLogExcerpt] = useState("");
  const [logQuestion, setLogQuestion] = useState("");
  const [logAnalysis, setLogAnalysis] = useState("");
  const [logLoading, setLogLoading] = useState(false);
  const [healthStatus, setHealthStatus] = useState<{ database: string; redis: string; guide_llm?: string } | null>(null);
  type UserItem = { user_id: string; username: string; display_name?: string; role: string; created_at?: string };
  const [userList, setUserList] = useState<UserItem[]>([]);
  // 图片 API 设置
  const [imgApiBaseUrl, setImgApiBaseUrl] = useState("");
  const [imgApiKey, setImgApiKey] = useState("");
  const [imgApiKeyMasked, setImgApiKeyMasked] = useState("");
  const [imgApiDefaultModel, setImgApiDefaultModel] = useState("qwen-image-edit-max");
  const [imgApiSaving, setImgApiSaving] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [workspaceUsers, setWorkspaceUsers] = useState<UserItem[]>([]);
  const [workspaceChannels, setWorkspaceChannels] = useState<Channel[]>([]);

  // ==================== Load Data ====================
  useEffect(() => {
    refreshChannels(setChannels, token);
    authFetch(`${API}/workspaces`).then((r) => r.json()).then((d) => d.data && setWorkspaces(d.data)).catch(console.error);
    loadModels();
    loadTemplates();
    loadBots();
  }, []);

  useEffect(() => {
    if (activeTab === "perf") {
      fetch(`${API}/tasks?limit=50`).then((r) => r.json()).then((d) => setTaskList(d.data || [])).catch(() => setTaskList([]));
      fetch(`${API}/tasks/stats?limit_days=7`).then((r) => r.json()).then((d) => d.data && setTaskStats(d.data)).catch(() => setTaskStats(null));
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "llm") {
      authFetch(`${API}/admin/settings/llm`)
        .then((r) => r.json())
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
        .catch(console.error);
      authFetch(`${API}/admin/settings/clarify`)
        .then((r) => r.json())
        .then((d) => {
          if (d.data) {
            setClarifySettings({
              clarify_strict_mode: !!d.data.clarify_strict_mode,
              clarify_force_rule: !!d.data.clarify_force_rule,
              clarify_threshold: d.data.clarify_threshold ?? 0.6,
            });
          }
        })
        .catch(console.error);
      authFetch(`${API}/admin/settings/orchestrator`)
        .then((r) => r.json())
        .then((d) => {
          if (d.data) {
            setOrchestratorSettings({
              orchestrator_direct_answer: !!d.data.orchestrator_direct_answer,
              orchestrator_auto_takeover: !!d.data.orchestrator_auto_takeover,
            });
          }
        })
        .catch(console.error);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "logs") {
      authFetch(`${API}/admin/logs?limit=200`).then((r) => r.json()).then((d) => { if (d.data) setLogEntries(d.data); }).catch(console.error);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "health") {
      fetch(`${API}/health`).then((r) => r.json()).then((d) => setHealthStatus(d.data)).catch(console.error);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "user") {
      authFetch(`${API}/admin/users`).then((r) => r.json()).then((d) => { if (d.data) setUserList(d.data); }).catch(console.error);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "image_api") {
      fetch(`${API}/images/settings`).then((r) => r.json()).then((d) => {
        if (d.data) {
          setImgApiBaseUrl(d.data.base_url || "");
          setImgApiKeyMasked(d.data.api_key_masked || "");
          setImgApiDefaultModel(d.data.default_model || "qwen-image-edit-max");
          setImgApiKey("");
        }
      }).catch(console.error);
    }
  }, [activeTab]);

  useEffect(() => {
    if (selectedWorkspaceId) {
      fetch(`${API}/workspaces/${selectedWorkspaceId}/users`).then((r) => r.json()).then((d) => { if (d.data) setWorkspaceUsers(d.data); }).catch(console.error);
      fetch(`${API}/workspaces/${selectedWorkspaceId}/channels`).then((r) => r.json()).then((d) => { if (d.data) setWorkspaceChannels(d.data); }).catch(console.error);
    } else {
      setWorkspaceUsers([]);
      setWorkspaceChannels([]);
    }
  }, [selectedWorkspaceId]);

  // ==================== Model API Functions ====================
  const loadModels = () => {
    authFetch(`${API}/admin/models?include_disabled=true`)
      .then((r) => r.json())
      .then((d) => { if (d.data) setModels(d.data); })
      .catch(console.error);
  };

  const createModel = () => {
    if (!modelForm.name.trim() || !modelForm.model_name.trim() || !modelForm.base_url.trim()) {
      toast.error("请填写必填项");
      return;
    }
    let extraHeaders: Record<string, string> | undefined;
    if (modelForm.extra_headers.trim()) {
      try { extraHeaders = JSON.parse(modelForm.extra_headers); }
      catch { toast.error("额外 Headers 格式错误，须为合法 JSON 对象"); return; }
    }
    const config: Record<string, unknown> = extraHeaders ? { extra_headers: extraHeaders } : {};
    if (modelForm.supports_vision) config.supports_vision = true;
    const { extra_headers: _eh, supports_vision: _sv, ...rest } = modelForm;
    authFetch(`${API}/admin/models`, {
      method: "POST",
      body: JSON.stringify({ ...rest, config }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("模型创建成功");
          loadModels();
          setModelForm({ name: "", provider: "ollama", model_name: "", base_url: "", api_key: "", description: "", is_enabled: true, supports_vision: false, extra_headers: "" });
        } else {
          toast.error(d.message || d.detail || "创建失败");
        }
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const updateModel = (id: string) => {
    let extraHeaders: Record<string, string> | null = null;
    if (modelForm.extra_headers.trim()) {
      try { extraHeaders = JSON.parse(modelForm.extra_headers); }
      catch { toast.error("额外 Headers 格式错误，须为合法 JSON 对象"); return; }
    }
    const config: Record<string, unknown> = extraHeaders !== null ? { extra_headers: extraHeaders } : {};
    if (modelForm.supports_vision) config.supports_vision = true;
    authFetch(`${API}/admin/models/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: modelForm.name,
        provider: modelForm.provider,
        model_name: modelForm.model_name,
        base_url: modelForm.base_url,
        api_key: modelForm.api_key || undefined,
        description: modelForm.description,
        is_enabled: modelForm.is_enabled,
        config,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("已更新");
          loadModels();
          setModelEditingId(null);
          setModelForm({ name: "", provider: "ollama", model_name: "", base_url: "", api_key: "", description: "", is_enabled: true, supports_vision: false, extra_headers: "" });
        } else {
          toast.error(d.message || d.detail || "更新失败");
        }
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const deleteModel = (id: string) => {
    if (!confirm("确定删除此模型？")) return;
    authFetch(`${API}/admin/models/${id}`, { method: "DELETE" })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("已删除");
          loadModels();
        } else {
          toast.error(d.message || d.detail || "删除失败");
        }
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const startEditModel = (m: AIModel) => {
    setModelEditingId(m.model_id);
    const eh = m.config?.extra_headers;
    setModelForm({
      name: m.name,
      provider: m.provider,
      model_name: m.model_name,
      base_url: m.base_url,
      api_key: "",
      description: m.description || "",
      is_enabled: m.is_enabled,
      supports_vision: !!m.config?.supports_vision,
      extra_headers: eh && typeof eh === "object" ? JSON.stringify(eh) : "",
    });
  };

  // ==================== Template API Functions ====================
  const loadTemplates = () => {
    authFetch(`${API}/admin/templates`)
      .then((r) => r.json())
      .then((d) => { if (d.data) setTemplates(d.data); })
      .catch(console.error);
  };

  const createTemplate = () => {
    if (!templateForm.name.trim() || !templateForm.system_prompt.trim()) {
      toast.error("请填写必填项");
      return;
    }
    authFetch(`${API}/admin/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(templateForm),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("模板创建成功");
          loadTemplates();
          setTemplateForm({ name: "", description: "", system_prompt: "", user_template: "{{message}}", variables: ["message"] });
        } else {
          toast.error(d.message || d.detail || "创建失败");
        }
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const updateTemplate = (id: string) => {
    authFetch(`${API}/admin/templates/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: templateForm.name,
        description: templateForm.description,
        system_prompt: templateForm.system_prompt,
        user_template: templateForm.user_template,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("已更新");
          loadTemplates();
          setTemplateEditingId(null);
          setTemplateForm({ name: "", description: "", system_prompt: "", user_template: "{{message}}", variables: ["message"] });
        } else {
          toast.error(d.message || d.detail || "更新失败");
        }
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const deleteTemplate = (id: string) => {
    if (!confirm("确定删除此模板？")) return;
    authFetch(`${API}/admin/templates/${id}`, { method: "DELETE" })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("已删除");
          loadTemplates();
        } else {
          toast.error(d.message || d.detail || "删除失败");
        }
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const startEditTemplate = (t: PromptTemplate) => {
    setTemplateEditingId(t.template_id);
    setTemplateForm({
      name: t.name,
      description: t.description || "",
      system_prompt: t.system_prompt,
      user_template: t.user_template,
      variables: t.variables || ["message"],
    });
  };

  // ==================== Bot API Functions ====================
  const loadBots = () => {
    authFetch(`${API}/bots`)
      .then((r) => r.json())
      .then((d) => { if (d.data) setBotList(d.data); })
      .catch(console.error);
  };

  const createBot = () => {
    if (!botForm.username.trim() || !botForm.model_id || !botForm.template_id) {
      toast.error("请填写必填项：用户名、模型、模板");
      return;
    }
    authFetch(`${API}/bots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botForm),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("Bot 创建成功");
          setLastCreatedBotId(d.data?.bot_id ?? "");
          loadBots();
          setBotForm({
            username: "",
            display_name: "",
            description: "",
            model_id: "",
            template_id: "",
            custom_system_prompt: "",
            intro: "",
            status: "online",
          });
        } else {
          toast.error(d.message || d.detail || "创建失败");
        }
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const updateBot = (id: string) => {
    authFetch(`${API}/bots/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botForm),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("已更新");
          loadBots();
          setBotEditingId(null);
          setBotForm({
            username: "",
            display_name: "",
            description: "",
            model_id: "",
            template_id: "",
            custom_system_prompt: "",
            intro: "",
            status: "online",
          });
        } else {
          toast.error(d.message || d.detail || "更新失败");
        }
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const deleteBot = (id: string) => {
    if (!confirm("确定删除此 Bot？")) return;
    authFetch(`${API}/bots/${id}`, { method: "DELETE" })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("已删除");
          loadBots();
        } else {
          toast.error(d.message || d.detail || "删除失败");
        }
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const startEditBot = (b: BotItem) => {
    setBotEditingId(b.bot_id);
    setBotForm({
      username: b.username,
      display_name: b.display_name || "",
      description: b.description || "",
      model_id: b.model_id,
      template_id: b.template_id,
      custom_system_prompt: b.custom_system_prompt || "",
      intro: b.intro || "",
      status: b.status,
    });
  };

  // ==================== Workspace & Channel Functions ====================
  const createWorkspace = () => {
    if (!workspaceName.trim()) return;
    authFetch(`${API}/workspaces`, { method: "POST", body: JSON.stringify({ name: workspaceName.trim() }) })
      .then((r) => r.json())
      .then((d) => { if (d.status === "success") { toast.success("已创建"); setWorkspaceName(""); authFetch(`${API}/workspaces`).then((r) => r.json()).then((d) => d.data && setWorkspaces(d.data)).catch(console.error); } else toast.error(d.message || "创建失败"); })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const createChannel = () => {
    if (!createWs || !createName.trim()) return;
    authFetch(`${API}/channels`, { method: "POST", body: JSON.stringify({ workspace_id: createWs, name: createName.trim() }) })
      .then((r) => r.json())
      .then((d) => { if (d.status === "success") { toast.success("项目已创建"); setCreateName(""); refreshChannels(setChannels, token); } else toast.error(d.message || "创建失败"); })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const refreshAddChOptions = (channelId: string) => {
    if (!channelId) { setAddChOptions([]); return; }
    setAddChLoading(true);
    Promise.all([authFetch(`${API}/bots`).then((r) => r.json()), authFetch(`${API}/admin/users`).then((r) => r.json())])
      .then(([botsRes, usersRes]) => {
        const bots: BotItem[] = botsRes.data || [];
        const users: UserItem[] = usersRes.data || [];
        fetch(`${API}/channels/${channelId}/members`).then((r) => r.json()).then((membersRes) => {
          const existing = new Set((membersRes.data || []).map((m: MemberOption & { member_id?: string }) => m.member_id || m.id));
          const options: MemberOption[] = [
            ...bots.filter((b) => !existing.has(b.bot_id)).map((b) => ({ id: b.bot_id, type: "bot" as const, label: `@${b.username}${b.display_name ? ` (${b.display_name})` : ""}` })),
            ...users.filter((u) => !existing.has(u.user_id)).map((u) => ({ id: u.user_id, type: "user" as const, label: `${u.display_name || u.username} (@${u.username})` })),
          ];
          setAddChOptions(options);
          setAddChLoading(false);
        }).catch(() => setAddChLoading(false));
      })
      .catch(() => setAddChLoading(false));
  };

  const addMembersToChannel = () => {
    if (!addCh || addSelectedIds.size === 0) return;
    setAddingMembers(true);
    const promises = Array.from(addSelectedIds).map((id) => {
      const opt = addChOptions.find((o) => o.id === id);
      return fetch(`${API}/channels/${addCh}/members`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ member_id: id, member_type: opt?.type || "bot" }) }).then((r) => r.json());
    });
    Promise.all(promises).then(() => { toast.success("已添加"); setAddSelectedIds(new Set()); setAddingMembers(false); refreshAddChOptions(addCh); }).catch(() => setAddingMembers(false));
  };

  const refreshRmChMembers = (channelId: string) => {
    if (!channelId) { setRmChMembers([]); return; }
    setRmChLoading(true);
    fetch(`${API}/channels/${channelId}/members`).then((r) => r.json()).then((d) => {
      const list = (d.data || []).map((m: MemberOption & { username?: string; display_name?: string; member_type?: string }) => ({ ...m, label: m.label || `${m.display_name || m.username} (@${m.username}) [${m.member_type || m.type}]` }));
      setRmChMembers(list);
      setRmChLoading(false);
    }).catch(() => setRmChLoading(false));
  };

  const removeMembersFromChannel = () => {
    if (!rmCh || rmSelectedIds.size === 0) return;
    setRemovingMembers(true);
    const promises = Array.from(rmSelectedIds).map((id) => fetch(`${API}/channels/${rmCh}/members/${id}`, { method: "DELETE" }).then((r) => r.json()));
    Promise.all(promises).then(() => { toast.success("已移除"); setRmSelectedIds(new Set()); setRemovingMembers(false); refreshRmChMembers(rmCh); }).catch(() => setRemovingMembers(false));
  };

  const addBotToChannel = () => {
    if (!addCh || !lastCreatedBotId) return;
    fetch(`${API}/channels/${addCh}/members`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ member_id: lastCreatedBotId, member_type: "bot" }) })
      .then((r) => r.json())
      .then((d) => { if (d.status === "success") { toast.success("Bot 已加入项目"); setLastCreatedBotId(""); } else toast.error(d.message || "加入失败"); })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  // ==================== Legacy Functions ====================
  const runLogAnalysis = () => {
    if (!logExcerpt.trim() && !logQuestion.trim()) return;
    setLogLoading(true);
    authFetch(`${API}/admin/logs/analyze`, { method: "POST", body: JSON.stringify({ excerpt: logExcerpt.trim(), question: logQuestion.trim() }) })
      .then((r) => r.json())
      .then((d) => { setLogAnalysis(d.data?.result || d.data?.analysis || ""); setLogLoading(false); })
      .catch(() => setLogLoading(false));
  };



  const saveLlmBinding = (scope: string, providerId: string) => {
    authFetch(`${API}/admin/settings/llm/bind`, { method: "POST", body: JSON.stringify({ scope, provider_id: providerId }) })
      .then((r) => r.json())
      .then((d) => { if (d.status === "success") toast.success("绑定已更新"); else toast.error(d.message || "绑定失败"); })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const saveOrchestratorSettings = () => {
    authFetch(`${API}/admin/settings/orchestrator`, { method: "POST", body: JSON.stringify(orchestratorSettings) })
      .then((r) => r.json())
      .then((d) => { if (d.status === "success") toast.success("设置已保存"); else toast.error(d.message || "保存失败"); })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const saveClarifySettings = () => {
    authFetch(`${API}/admin/settings/clarify`, { method: "POST", body: JSON.stringify(clarifySettings) })
      .then((r) => r.json())
      .then((d) => { if (d.status === "success") toast.success("设置已保存"); else toast.error(d.message || "保存失败"); })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  // ==================== Render ====================

  // 权限检查：未登录则显示提示
  if (!currentUser) {
    return (
      <div className="min-h-screen bg-[#F8F8F8] flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl mb-4">🔒</div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">请先登录</h2>
          <p className="text-gray-500 mb-6">您需要登录后才能访问此页面。</p>
          <Link to="/" className="px-4 py-2 bg-[#4A154B] text-white rounded-lg hover:bg-[#611f69] text-sm font-medium">
            返回聊天
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F8F8]">
      <header className="border-b border-gray-200 bg-white sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#4A154B] to-[#611f69] flex items-center justify-center text-white font-bold">A</div>
            <h1 className="text-lg font-semibold text-gray-800">AgentNexus 管理</h1>
          </div>
          <Link to="/docs" className="text-sm text-[#1264A3] hover:underline mr-4">Docs</Link>
          <Link to="/" className="text-sm text-[#1264A3] hover:underline">返回聊天</Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        <div className="flex gap-6">
          {/* Sidebar */}
          <aside className="w-48 flex-shrink-0">
            <nav className="space-y-1">
              <button onClick={() => setActiveTab("models")} className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${activeTab === "models" ? "bg-[#4A154B] text-white" : "text-gray-700 hover:bg-gray-100"}`}>AI 模型</button>
              <button onClick={() => setActiveTab("templates")} className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${activeTab === "templates" ? "bg-[#4A154B] text-white" : "text-gray-700 hover:bg-gray-100"}`}>提示词模板</button>
              <button onClick={() => setActiveTab("bot")} className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${activeTab === "bot" ? "bg-[#4A154B] text-white" : "text-gray-700 hover:bg-gray-100"}`}>Bot 管理</button>
              <button onClick={() => setActiveTab("workspace")} className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${activeTab === "workspace" ? "bg-[#4A154B] text-white" : "text-gray-700 hover:bg-gray-100"}`}>工作区与项目</button>
              {userRole === "system_admin" && (
                <>
                  <button onClick={() => setActiveTab("llm")} className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${activeTab === "llm" ? "bg-[#4A154B] text-white" : "text-gray-700 hover:bg-gray-100"}`}>LLM 设置</button>
                  <button onClick={() => setActiveTab("image_api")} className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${activeTab === "image_api" ? "bg-[#4A154B] text-white" : "text-gray-700 hover:bg-gray-100"}`}>图片 API</button>
                  <button onClick={() => setActiveTab("perf")} className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${activeTab === "perf" ? "bg-[#4A154B] text-white" : "text-gray-700 hover:bg-gray-100"}`}>性能监控</button>
                  <button onClick={() => setActiveTab("logs")} className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${activeTab === "logs" ? "bg-[#4A154B] text-white" : "text-gray-700 hover:bg-gray-100"}`}>日志查看</button>
                  <button onClick={() => setActiveTab("health")} className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${activeTab === "health" ? "bg-[#4A154B] text-white" : "text-gray-700 hover:bg-gray-100"}`}>健康检查</button>
                  <button onClick={() => setActiveTab("user")} className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${activeTab === "user" ? "bg-[#4A154B] text-white" : "text-gray-700 hover:bg-gray-100"}`}>用户管理</button>
                </>
              )}
            </nav>
          </aside>

          {/* Content */}
          <div className="flex-1 space-y-6">
            {/* ==================== AI Models Tab ==================== */}
            {activeTab === "models" && (
              <>
                <section className="bg-white rounded-xl border border-gray-200 p-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-4">AI 模型管理</h3>
                  <div className="space-y-4">
                    {/* Model List */}
                    <div className="space-y-2">
                      {models.map((m) => (
                        <div key={m.model_id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{m.name}</span>
                              {!m.is_enabled && <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded">已禁用</span>}
                            </div>
                            <div className="text-xs text-gray-500 mt-1">
                              {m.provider} / {m.model_name} | {m.base_url}
                              {m.api_key_masked && ` | Key: ${m.api_key_masked}`}
                              {!!m.config?.extra_headers && <span className="ml-1 text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">+headers</span>}
                            </div>
                            {m.description && <div className="text-xs text-gray-400 mt-1">{m.description}</div>}
                          </div>
                          <div className="flex gap-2">
                            <button onClick={() => startEditModel(m)} className="px-3 py-1 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50">编辑</button>
                            <button onClick={() => deleteModel(m.model_id)} className="px-3 py-1 text-xs bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100">删除</button>
                          </div>
                        </div>
                      ))}
                      {models.length === 0 && <div className="text-sm text-gray-400 py-4 text-center">暂无模型</div>}
                    </div>

                    {/* Create/Edit Form */}
                    <div className="border-t border-gray-200 pt-4">
                      <h4 className="text-sm font-medium text-gray-700 mb-3">{modelEditingId ? "编辑模型" : "创建模型"}</h4>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">显示名称 *</label>
                          <input type="text" value={modelForm.name} onChange={(e) => setModelForm({ ...modelForm, name: e.target.value })} placeholder="如：GPT-4o" className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm" />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">提供商 *</label>
                          <select value={modelForm.provider} onChange={(e) => setModelForm({ ...modelForm, provider: e.target.value })} className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm">
                            <option value="ollama">Ollama</option>
                            <option value="openai">OpenAI</option>
                            <option value="anthropic">Anthropic</option>
                            <option value="azure">Azure OpenAI</option>
                            <option value="other">其他</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">模型名称 *</label>
                          <input type="text" value={modelForm.model_name} onChange={(e) => setModelForm({ ...modelForm, model_name: e.target.value })} placeholder="如：gpt-4o" className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm" />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Base URL *</label>
                          <input type="text" value={modelForm.base_url} onChange={(e) => setModelForm({ ...modelForm, base_url: e.target.value })} placeholder="如：http://localhost:11434/v1" className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm" />
                        </div>
                        <div className="col-span-2">
                          <label className="block text-xs text-gray-500 mb-1">API Key</label>
                          <input type="password" value={modelForm.api_key} onChange={(e) => setModelForm({ ...modelForm, api_key: e.target.value })} placeholder="可选，本地模型可留空" className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm" />
                        </div>
                        <div className="col-span-2">
                          <label className="block text-xs text-gray-500 mb-1">描述</label>
                          <input type="text" value={modelForm.description} onChange={(e) => setModelForm({ ...modelForm, description: e.target.value })} placeholder="模型描述" className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm" />
                        </div>
                        <div className="col-span-2">
                          <label className="block text-xs text-gray-500 mb-1">额外请求 Headers <span className="text-gray-400">（JSON 对象，可选）</span></label>
                          <textarea
                            value={modelForm.extra_headers}
                            onChange={(e) => setModelForm({ ...modelForm, extra_headers: e.target.value })}
                            placeholder={'{"x-openclaw-agent-id": "main"}'}
                            rows={2}
                            className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm font-mono resize-none"
                          />
                          <p className="text-xs text-gray-400 mt-0.5">每次调用 LLM 时附加到请求头，用于需要自定义鉴权头的 endpoint</p>
                        </div>
                        <div className="col-span-2 flex items-center gap-4">
                          <div className="flex items-center gap-2">
                            <input type="checkbox" id="is_enabled" checked={modelForm.is_enabled} onChange={(e) => setModelForm({ ...modelForm, is_enabled: e.target.checked })} className="rounded" />
                            <label htmlFor="is_enabled" className="text-xs text-gray-500">启用此模型</label>
                          </div>
                          <div className="flex items-center gap-2">
                            <input type="checkbox" id="supports_vision" checked={modelForm.supports_vision} onChange={(e) => setModelForm({ ...modelForm, supports_vision: e.target.checked })} className="rounded" />
                            <label htmlFor="supports_vision" className="text-xs text-gray-500">支持图片识别（Vision）</label>
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2 mt-3">
                        {modelEditingId ? (
                          <>
                            <button onClick={() => updateModel(modelEditingId)} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm">保存</button>
                            <button onClick={() => { setModelEditingId(null); setModelForm({ name: "", provider: "ollama", model_name: "", base_url: "", api_key: "", description: "", is_enabled: true, supports_vision: false, extra_headers: "" }); }} className="px-4 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-sm">取消</button>
                          </>
                        ) : (
                          <button onClick={createModel} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm">创建模型</button>
                        )}
                      </div>
                    </div>
                  </div>
                </section>
              </>
            )}

            {/* ==================== Prompt Templates Tab ==================== */}
            {activeTab === "templates" && (
              <>
                <section className="bg-white rounded-xl border border-gray-200 p-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-4">提示词模板管理</h3>
                  <div className="space-y-4">
                    {/* Template List */}
                    <div className="space-y-2">
                      {templates.map((t) => (
                        <div key={t.template_id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{t.name}</span>
                            </div>
                            {t.description && <div className="text-xs text-gray-500 mt-1">{t.description}</div>}
                            <div className="text-xs text-gray-400 mt-1">变量: {t.variables?.join(", ") || "message"}</div>
                          </div>
                          <div className="flex gap-2">
                            <button onClick={() => startEditTemplate(t)} className="px-3 py-1 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50">编辑</button>
                            <button onClick={() => deleteTemplate(t.template_id)} className="px-3 py-1 text-xs bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100">删除</button>
                          </div>
                        </div>
                      ))}
                      {templates.length === 0 && <div className="text-sm text-gray-400 py-4 text-center">暂无模板</div>}
                    </div>

                    {/* Create/Edit Form */}
                    <div className="border-t border-gray-200 pt-4">
                      <h4 className="text-sm font-medium text-gray-700 mb-3">{templateEditingId ? "编辑模板" : "创建模板"}</h4>
                      <div className="space-y-3">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">模板名称 *</label>
                          <input type="text" value={templateForm.name} onChange={(e) => setTemplateForm({ ...templateForm, name: e.target.value })} placeholder="如：代码审查" className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm" />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">描述</label>
                          <input type="text" value={templateForm.description} onChange={(e) => setTemplateForm({ ...templateForm, description: e.target.value })} placeholder="模板用途描述" className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm" />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">系统提示词 (System Prompt) *</label>
                          <textarea value={templateForm.system_prompt} onChange={(e) => setTemplateForm({ ...templateForm, system_prompt: e.target.value })} placeholder="你是一个专业的助手..." className="border border-gray-300 rounded-lg px-3 py-2 w-full h-24 text-sm" />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">用户消息模板 (User Template) *</label>
                          <textarea value={templateForm.user_template} onChange={(e) => setTemplateForm({ ...templateForm, user_template: e.target.value })} placeholder="{{message}}" className="border border-gray-300 rounded-lg px-3 py-2 w-full h-20 text-sm" />
                          <p className="text-xs text-gray-400 mt-1">使用 {"{{message}}"} 作为用户消息的占位符</p>
                        </div>
                      </div>
                      <div className="flex gap-2 mt-3">
                        {templateEditingId ? (
                          <>
                            <button onClick={() => updateTemplate(templateEditingId)} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm">保存</button>
                            <button onClick={() => { setTemplateEditingId(null); setTemplateForm({ name: "", description: "", system_prompt: "", user_template: "{{message}}", variables: ["message"] }); }} className="px-4 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-sm">取消</button>
                          </>
                        ) : (
                          <button onClick={createTemplate} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm">创建模板</button>
                        )}
                      </div>
                    </div>
                  </div>
                </section>
              </>
            )}

            {/* ==================== Bot Management Tab ==================== */}
            {activeTab === "bot" && (
              <>
                {/* Bot List */}
                <section className="bg-white rounded-xl border border-gray-200 p-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-4">Bot 列表</h3>
                  <div className="space-y-2">
                    {botList.map((b) => (
                      <div key={b.bot_id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">@{b.username}</span>
                            {b.display_name && <span className="text-xs text-gray-500">({b.display_name})</span>}
                            <span className={`text-xs px-2 py-0.5 rounded ${b.status === "online" ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-600"}`}>{b.status}</span>
                            {b.created_by === currentUser?.user_id && (
                              <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-600">我的</span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            模型: {b.model_name || "未知"} | 模板: {b.template_name || "未知"}
                          </div>
                          {b.description && <div className="text-xs text-gray-400 mt-1">{b.description}</div>}
                        </div>
                        {(b.created_by === currentUser?.user_id || userRole === "system_admin" || userRole === "space_admin") && (
                          <div className="flex gap-2">
                            <button onClick={() => startEditBot(b)} className="px-3 py-1 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50">编辑</button>
                            <button onClick={() => deleteBot(b.bot_id)} className="px-3 py-1 text-xs bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100">删除</button>
                          </div>
                        )}
                      </div>
                    ))}
                    {botList.length === 0 && <div className="text-sm text-gray-400 py-4 text-center">暂无 Bot</div>}
                  </div>
                </section>

                {/* Create/Edit Bot Form */}
                <section className="bg-white rounded-xl border border-gray-200 p-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-4">{botEditingId ? "编辑 Bot" : "创建 Bot"}</h3>
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">用户名 (@名字) *</label>
                        <input type="text" value={botForm.username} onChange={(e) => setBotForm({ ...botForm, username: e.target.value })} placeholder="如：代码助手" className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm" disabled={!!botEditingId} />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">显示名称</label>
                        <input type="text" value={botForm.display_name} onChange={(e) => setBotForm({ ...botForm, display_name: e.target.value })} placeholder="如：智能代码助手" className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm" />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs text-gray-500 mb-1">描述</label>
                      <input type="text" value={botForm.description} onChange={(e) => setBotForm({ ...botForm, description: e.target.value })} placeholder="Bot 的功能描述" className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm" />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">选择 AI 模型 *</label>
                        <select value={botForm.model_id} onChange={(e) => setBotForm({ ...botForm, model_id: e.target.value })} className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm">
                          <option value="">选择模型...</option>
                          {models.filter(m => m.is_enabled).map((m) => (
                            <option key={m.model_id} value={m.model_id}>{m.name}</option>
                          ))}
                        </select>
                        {models.filter(m => m.is_enabled).length === 0 && (
                          <p className="text-xs text-red-500 mt-1">请先创建一个 AI 模型</p>
                        )}
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">选择提示词模板 *</label>
                        <select value={botForm.template_id} onChange={(e) => setBotForm({ ...botForm, template_id: e.target.value })} className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm">
                          <option value="">选择模板...</option>
                          {templates.map((t) => (
                            <option key={t.template_id} value={t.template_id}>{t.name}</option>
                          ))}
                        </select>
                        {templates.length === 0 && (
                          <p className="text-xs text-red-500 mt-1">请先创建一个提示词模板</p>
                        )}
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs text-gray-500 mb-1">自定义系统提示词（可选，会覆盖模板的 system_prompt）</label>
                      <textarea value={botForm.custom_system_prompt} onChange={(e) => setBotForm({ ...botForm, custom_system_prompt: e.target.value })} placeholder="留空则使用模板默认的系统提示词" className="border border-gray-300 rounded-lg px-3 py-2 w-full h-20 text-sm" />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">状态</label>
                        <select value={botForm.status} onChange={(e) => setBotForm({ ...botForm, status: e.target.value })} className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm">
                          <option value="online">在线</option>
                          <option value="offline">离线</option>
                          <option value="busy">忙碌</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">自我介绍 (JSON)</label>
                        <input type="text" value={botForm.intro} onChange={(e) => setBotForm({ ...botForm, intro: e.target.value })} placeholder='{"capabilities":["能力1"],"description":"描述"}' className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm" />
                      </div>
                    </div>

                    <div className="flex gap-2">
                      {botEditingId ? (
                        <>
                          <button onClick={() => updateBot(botEditingId)} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm">保存</button>
                          <button onClick={() => { setBotEditingId(null); setBotForm({ username: "", display_name: "", description: "", model_id: "", template_id: "", custom_system_prompt: "", intro: "", status: "online" }); }} className="px-4 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-sm">取消</button>
                        </>
                      ) : (
                        <button onClick={createBot} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm">创建 Bot</button>
                      )}
                    </div>
                  </div>

                  {/* Quick Add to Channel */}
                  {lastCreatedBotId && !botEditingId && (
                    <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg">
                      <p className="text-sm text-green-700 mb-2">Bot 创建成功！是否添加到项目？</p>
                      <div className="flex gap-2">
                        <select value={addCh} onChange={(e) => setAddCh(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
                          <option value="">选择项目...</option>
                          {channels.map((c) => <option key={c.channel_id} value={c.channel_id}># {c.name}</option>)}
                        </select>
                        <button onClick={addBotToChannel} className="px-4 py-1.5 bg-[#1264A3] text-white rounded-lg text-sm">添加到项目</button>
                        <button onClick={() => setLastCreatedBotId("")} className="px-4 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-sm">跳过</button>
                      </div>
                    </div>
                  )}
                </section>
              </>
            )}

            {/* ==================== Workspace Tab ==================== */}
            {activeTab === "workspace" && (
              <>
                <section className="bg-white rounded-xl border border-gray-200 p-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-4">工作区</h3>
                  <div className="flex gap-2 mb-4">
                    <input type="text" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="新工作区名称" className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm" />
                    <button onClick={createWorkspace} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm">创建工作区</button>
                  </div>
                  <div className="space-y-1">
                    {workspaces.map((w) => (
                      <div key={w.workspace_id} className="flex items-center justify-between p-2 bg-gray-50 rounded text-sm">
                        <span>{w.name}</span>
                        <span className="text-xs text-gray-400">{w.workspace_id}</span>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="bg-white rounded-xl border border-gray-200 p-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-4">项目（频道）</h3>
                  <div className="flex gap-2 mb-4">
                    <select value={createWs} onChange={(e) => setCreateWs(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm">
                      <option value="">选择工作区...</option>
                      {workspaces.map((w) => <option key={w.workspace_id} value={w.workspace_id}>{w.name}</option>)}
                    </select>
                    <input type="text" value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="新项目名称" className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm" />
                    <button onClick={createChannel} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm">创建项目</button>
                  </div>
                  <div className="space-y-1">
                    {channels.map((c) => (
                      <div key={c.channel_id} className="flex items-center justify-between p-2 bg-gray-50 rounded text-sm">
                        <span>#{c.name}</span>
                        <span className="text-xs text-gray-400">{c.type}</span>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="bg-white rounded-xl border border-gray-200 p-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-4">成员管理</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">添加到项目</label>
                      <select value={addCh} onChange={(e) => { setAddCh(e.target.value); refreshAddChOptions(e.target.value); }} className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm mb-2">
                        <option value="">选择项目...</option>
                        {channels.map((c) => <option key={c.channel_id} value={c.channel_id}># {c.name}</option>)}
                      </select>
                      {addChLoading && <div className="text-xs text-gray-400 mb-2">加载中...</div>}
                      {!addChLoading && addChOptions.length > 0 && (
                        <div className="space-y-1 max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-2 mb-2">
                          {addChOptions.map((opt) => (
                            <label key={opt.id} className="flex items-center gap-2 text-sm">
                              <input type="checkbox" checked={addSelectedIds.has(opt.id)} onChange={(e) => {
                                const next = new Set(addSelectedIds);
                                if (e.target.checked) next.add(opt.id); else next.delete(opt.id);
                                setAddSelectedIds(next);
                              }} />
                              <span>{opt.label}</span>
                            </label>
                          ))}
                        </div>
                      )}
                      <button onClick={addMembersToChannel} disabled={addingMembers || addSelectedIds.size === 0} className="px-4 py-1.5 bg-[#1264A3] text-white rounded-lg text-sm disabled:opacity-50">添加选中成员</button>
                    </div>

                    <div>
                      <label className="block text-xs text-gray-500 mb-1">从项目移除</label>
                      <select value={rmCh} onChange={(e) => { setRmCh(e.target.value); refreshRmChMembers(e.target.value); }} className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm mb-2">
                        <option value="">选择项目...</option>
                        {channels.map((c) => <option key={c.channel_id} value={c.channel_id}># {c.name}</option>)}
                      </select>
                      {rmChLoading && <div className="text-xs text-gray-400 mb-2">加载中...</div>}
                      {!rmChLoading && rmChMembers.length > 0 && (
                        <div className="space-y-1 max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-2 mb-2">
                          {rmChMembers.map((m) => (
                            <label key={m.id} className="flex items-center gap-2 text-sm">
                              <input type="checkbox" checked={rmSelectedIds.has(m.id)} onChange={(e) => {
                                const next = new Set(rmSelectedIds);
                                if (e.target.checked) next.add(m.id); else next.delete(m.id);
                                setRmSelectedIds(next);
                              }} />
                              <span>{m.label}</span>
                            </label>
                          ))}
                        </div>
                      )}
                      <button onClick={removeMembersFromChannel} disabled={removingMembers || rmSelectedIds.size === 0} className="px-4 py-1.5 bg-red-600 text-white rounded-lg text-sm disabled:opacity-50">移除选中成员</button>
                    </div>
                  </div>
                </section>

                <section className="bg-white rounded-xl border border-gray-200 p-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-4">工作区用户</h3>
                  <select value={selectedWorkspaceId} onChange={(e) => setSelectedWorkspaceId(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm mb-3">
                    <option value="">选择工作区...</option>
                    {workspaces.map((w) => <option key={w.workspace_id} value={w.workspace_id}>{w.name}</option>)}
                  </select>
                  {selectedWorkspaceId && (
                    <div className="space-y-3">
                      <div>
                        <h4 className="text-xs font-medium text-gray-500 mb-2">项目</h4>
                        <div className="space-y-1">
                          {workspaceChannels.map((c) => (
                            <div key={c.channel_id} className="flex items-center justify-between p-2 bg-gray-50 rounded text-sm">
                              <span>#{c.name}</span>
                              <span className="text-xs text-gray-400">{c.type}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <h4 className="text-xs font-medium text-gray-500 mb-2">成员</h4>
                        <div className="space-y-1">
                          {workspaceUsers.map((u) => (
                            <div key={u.user_id} className="flex items-center justify-between p-2 bg-gray-50 rounded text-sm">
                              <span>{u.display_name || u.username} (@{u.username})</span>
                              <span className="text-xs text-gray-400">{u.role}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </section>
              </>
            )}

            {/* ==================== Legacy LLM Settings Tab ==================== */}
            {activeTab === "llm" && userRole === "system_admin" && (
              <>
                <section className="bg-white rounded-xl border border-gray-200 p-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-4">功能绑定（遗留）</h3>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">引导 Bot LLM</label>
                      <select value={bindingGuideBot} onChange={(e) => { setBindingGuideBot(e.target.value); saveLlmBinding("guide_bot", e.target.value); }} className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm">
                        <option value="">不绑定</option>
                        {llmProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">系统 LLM</label>
                      <select value={bindingSystemLlm} onChange={(e) => { setBindingSystemLlm(e.target.value); saveLlmBinding("system_llm", e.target.value); }} className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm">
                        <option value="">不绑定</option>
                        {llmProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>
                  </div>
                </section>

                <section className="bg-white rounded-xl border border-gray-200 p-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-4">澄清设置</h3>
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <input type="checkbox" id="clarify_strict" checked={clarifySettings.clarify_strict_mode} onChange={(e) => setClarifySettings({ ...clarifySettings, clarify_strict_mode: e.target.checked })} />
                      <label htmlFor="clarify_strict" className="text-sm">严格模式</label>
                    </div>
                    <div className="flex items-center gap-2">
                      <input type="checkbox" id="clarify_force" checked={clarifySettings.clarify_force_rule} onChange={(e) => setClarifySettings({ ...clarifySettings, clarify_force_rule: e.target.checked })} />
                      <label htmlFor="clarify_force" className="text-sm">强制规则兜底</label>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">阈值</label>
                      <input type="number" step={0.1} min={0} max={1} value={clarifySettings.clarify_threshold} onChange={(e) => setClarifySettings({ ...clarifySettings, clarify_threshold: parseFloat(e.target.value) })} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <button onClick={saveClarifySettings} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm">保存澄清设置</button>
                  </div>
                </section>

                <section className="bg-white rounded-xl border border-gray-200 p-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-4">Orchestrator 设置</h3>
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <input type="checkbox" id="orch_direct" checked={orchestratorSettings.orchestrator_direct_answer} onChange={(e) => setOrchestratorSettings({ ...orchestratorSettings, orchestrator_direct_answer: e.target.checked })} />
                      <label htmlFor="orch_direct" className="text-sm">直接回答</label>
                    </div>
                    <div className="flex items-center gap-2">
                      <input type="checkbox" id="orch_takeover" checked={orchestratorSettings.orchestrator_auto_takeover} onChange={(e) => setOrchestratorSettings({ ...orchestratorSettings, orchestrator_auto_takeover: e.target.checked })} />
                      <label htmlFor="orch_takeover" className="text-sm">自动接管</label>
                    </div>
                    <button onClick={saveOrchestratorSettings} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm">保存 Orchestrator 设置</button>
                  </div>
                </section>
              </>
            )}

            {/* ==================== Performance Tab ==================== */}
            {activeTab === "perf" && userRole === "system_admin" && (
              <>
                <section className="bg-white rounded-xl border border-gray-200 p-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-4">任务统计</h3>
                  {taskStats && (
                    <div className="space-y-3">
                      <div className="text-sm">近 {taskStats.limit_days} 天共 {taskStats.total_tasks} 条任务</div>
                      <div className="space-y-1">
                        {taskStats.per_bot.map((b) => (
                          <div key={b.username} className="flex justify-between p-2 bg-gray-50 rounded text-sm">
                            <span>@{b.username}</span>
                            <span className="text-gray-500">{b.task_count} 条 {b.avg_latency_ms ? `(平均 ${b.avg_latency_ms.toFixed(0)}ms)` : ""}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
                <section className="bg-white rounded-xl border border-gray-200 p-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-4">最近任务</h3>
                  <div className="space-y-1 max-h-96 overflow-y-auto">
                    {taskList.map((t) => (
                      <div key={t.task_id} className="flex justify-between p-2 bg-gray-50 rounded text-sm">
                        <span>{t.bot_username || t.bot_id}</span>
                        <span className="text-gray-400">{t.latency_ms}ms</span>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            )}

            {/* ==================== Logs Tab ==================== */}
            {activeTab === "logs" && userRole === "system_admin" && (
              <>
                <section className="bg-white rounded-xl border border-gray-200 p-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-4">日志分析</h3>
                  <textarea value={logExcerpt} onChange={(e) => setLogExcerpt(e.target.value)} placeholder="粘贴日志片段..." className="border border-gray-300 rounded-lg px-3 py-2 w-full h-24 text-sm mb-2" />
                  <input type="text" value={logQuestion} onChange={(e) => setLogQuestion(e.target.value)} placeholder="你想问什么？" className="border border-gray-300 rounded-lg px-3 py-1.5 w-full text-sm mb-2" />
                  <button onClick={runLogAnalysis} disabled={logLoading} className="px-4 py-1.5 bg-[#4A154B] text-white rounded-lg text-sm disabled:opacity-50">{logLoading ? "分析中..." : "分析"}</button>
                  {logAnalysis && <div className="mt-3 p-3 bg-gray-50 rounded text-sm whitespace-pre-wrap">{logAnalysis}</div>}
                </section>
              </>
            )}

            {/* ==================== Health Tab ==================== */}
            {activeTab === "health" && userRole === "system_admin" && (
              <section className="bg-white rounded-xl border border-gray-200 p-5">
                <h3 className="text-sm font-semibold text-gray-800 mb-4">健康检查</h3>
                {healthStatus && (
                  <div className="space-y-2">
                    <div className="flex justify-between p-2 bg-gray-50 rounded text-sm">
                      <span>数据库</span>
                      <span className={healthStatus.database === "ok" ? "text-green-600" : "text-red-600"}>{healthStatus.database}</span>
                    </div>
                    <div className="flex justify-between p-2 bg-gray-50 rounded text-sm">
                      <span>Redis</span>
                      <span className={healthStatus.redis === "ok" ? "text-green-600" : "text-red-600"}>{healthStatus.redis}</span>
                    </div>
                    {healthStatus.guide_llm && (
                      <div className="flex justify-between p-2 bg-gray-50 rounded text-sm">
                        <span>引导 LLM</span>
                        <span className={healthStatus.guide_llm === "ok" ? "text-green-600" : "text-yellow-600"}>{healthStatus.guide_llm}</span>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* ==================== User Tab ==================== */}
            {activeTab === "user" && userRole === "system_admin" && (
              <section className="bg-white rounded-xl border border-gray-200 p-5">
                <h3 className="text-sm font-semibold text-gray-800 mb-4">用户列表</h3>
                <div className="space-y-1">
                  {userList.map((u) => (
                    <div key={u.user_id} className="flex justify-between p-2 bg-gray-50 rounded text-sm">
                      <span>{u.display_name || u.username} (@{u.username})</span>
                      <span className="text-gray-400">{u.role}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ==================== 图片 API 设置 Tab ==================== */}
            {activeTab === "image_api" && userRole === "system_admin" && (
              <section className="bg-white rounded-xl border border-gray-200 p-5">
                <h3 className="text-sm font-semibold text-gray-800 mb-4">图片 API 设置（文生图 / 图生图）</h3>
                <p className="text-xs text-gray-400 mb-4">配置 DashScope 图片生成 API。设置后可在聊天中使用「AI 图片」功能（文生图 + 图生图）。</p>
                <div className="space-y-4 max-w-md">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Base URL</label>
                    <input type="text" value={imgApiBaseUrl} onChange={(e) => setImgApiBaseUrl(e.target.value)}
                      placeholder="https://dashscope.aliyuncs.com"
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-gray-400" />
                    <p className="text-xs text-gray-400 mt-1">留空则使用环境变量 IMAGE_GEN_BASE_URL 的值</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
                    <input type="password" value={imgApiKey} onChange={(e) => setImgApiKey(e.target.value)}
                      placeholder={imgApiKeyMasked || "sk-xxxxxxxx"}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-gray-400" />
                    <p className="text-xs text-gray-400 mt-1">
                      {imgApiKeyMasked ? `当前已配置: ${imgApiKeyMasked}` : "留空则使用环境变量 IMAGE_GEN_API_KEY 的值"}
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">默认模型</label>
                    <select value={imgApiDefaultModel} onChange={(e) => setImgApiDefaultModel(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-gray-400 bg-white">
                      <optgroup label="文生图">
                        <option value="qwen-image-2.0-pro">qwen-image-2.0-pro</option>
                        <option value="qwen-image-2.0">qwen-image-2.0</option>
                        <option value="qwen-image-max">qwen-image-max</option>
                        <option value="z-image-turbo">z-image-turbo</option>
                      </optgroup>
                      <optgroup label="图生图">
                        <option value="qwen-image-edit-max">qwen-image-edit-max</option>
                        <option value="qwen-image-edit-plus">qwen-image-edit-plus</option>
                      </optgroup>
                    </select>
                  </div>
                  <button
                    type="button"
                    disabled={imgApiSaving}
                    onClick={async () => {
                      setImgApiSaving(true);
                      try {
                        const payload: Record<string, string> = { default_model: imgApiDefaultModel };
                        if (imgApiBaseUrl.trim()) payload.base_url = imgApiBaseUrl.trim();
                        if (imgApiKey.trim()) payload.api_key = imgApiKey.trim();
                        const res = await fetch(`${API}/images/settings`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(payload),
                        });
                        const d = await res.json();
                        if (d.data) {
                          setImgApiKeyMasked(d.data.api_key_masked || "");
                          setImgApiKey("");
                          toast.success("图片 API 设置已保存");
                        }
                      } catch { toast.error("保存失败"); } finally { setImgApiSaving(false); }
                    }}
                    className="px-4 py-2 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3b1040] transition disabled:opacity-50"
                  >
                    {imgApiSaving ? "保存中..." : "保存设置"}
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
