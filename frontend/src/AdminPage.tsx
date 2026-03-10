import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";

const API = "/api";

type TabId = "llm" | "perf" | "logs" | "bot" | "health";

type Workspace = { workspace_id: string; name: string };
type Channel = { channel_id: string; name: string; type: string };
type PendingRequest = {
  request_id: string;
  username: string;
  display_name?: string;
  openclaw_endpoint: string;
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
  const [activeTab, setActiveTab] = useState<TabId>("llm");

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [createWs, setCreateWs] = useState("");
  const [createName, setCreateName] = useState("");
  const [addCh, setAddCh] = useState("");
  const [addMemberId, setAddMemberId] = useState("");
  const [addMemberType, setAddMemberType] = useState<"user" | "bot">("user");
  const [rmCh, setRmCh] = useState("");
  const [rmMemberId, setRmMemberId] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");

  const [botId, setBotId] = useState("");
  const [botUsername, setBotUsername] = useState("");
  const [botDisplayName, setBotDisplayName] = useState("");
  const [botEndpoint, setBotEndpoint] = useState("");
  const [botStatus, setBotStatus] = useState("online");
  const [botWizardStep, setBotWizardStep] = useState<0 | 1 | 2>(0);
  const [botWizardType, setBotWizardType] = useState<"guide" | "http" | "mock">("guide");
  const [lastCreatedBotId, setLastCreatedBotId] = useState("");
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);

  const [taskList, setTaskList] = useState<TaskItem[]>([]);

  const [llmProviders, setLlmProviders] = useState<LLMProvider[]>([]);
  const [llmBindings, setLlmBindings] = useState<LLMBindings>({});
  const [llmForm, setLlmForm] = useState({ name: "", base_url: "", model: "", api_key: "", temperature: 0.7, max_tokens: 1000 });
  const [llmEditingId, setLlmEditingId] = useState<string | null>(null);
  const [llmSaveLoading, setLlmSaveLoading] = useState(false);
  const [bindingGuideBot, setBindingGuideBot] = useState("");
  const [bindingSystemLlm, setBindingSystemLlm] = useState("");
  const [bindingLogAnalyze, setBindingLogAnalyze] = useState("");
  const [bindingQaSummarize, setBindingQaSummarize] = useState("");
  const [clarifySettings, setClarifySettings] = useState<ClarifySettings>({
    clarify_strict_mode: false,
    clarify_force_rule: true,
    clarify_threshold: 0.6,
  });

  const [logLevel, setLogLevel] = useState("");
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logExcerpt, setLogExcerpt] = useState("");
  const [logQuestion, setLogQuestion] = useState("");
  const [logAnalysis, setLogAnalysis] = useState("");
  const [logLoading, setLogLoading] = useState(false);

  const [healthStatus, setHealthStatus] = useState<{ database: string; redis: string; guide_llm?: string } | null>(null);

  useEffect(() => {
    refreshChannels(setChannels);
    fetch(`${API}/workspaces`).then((r) => r.json()).then((d) => d.data && setWorkspaces(d.data)).catch(console.error);
    fetch(`${API}/bots/registration-requests?status=pending`).then((r) => r.json()).then((d) => setPendingRequests(d.data || [])).catch(() => setPendingRequests([]));
    fetch(`${API}/tasks?limit=50`).then((r) => r.json()).then((d) => setTaskList(d.data || [])).catch(() => setTaskList([]));
  }, []);

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

  const loadPendingRequests = () => {
    fetch(`${API}/bots/registration-requests?status=pending`)
      .then((r) => r.json())
      .then((d) => setPendingRequests(d.data || []))
      .catch(() => setPendingRequests([]));
  };

  useEffect(() => {
    if (activeTab === "bot") loadPendingRequests();
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

  const loadLlmSettings = () => {
    fetch(`${API}/admin/settings/llm`).then((r) => r.json()).then((d) => {
      if (d.data) {
        setLlmProviders(d.data.providers || []);
        setLlmBindings(d.data.bindings || {});
        setBindingGuideBot(d.data.bindings?.guide_bot ?? "");
        setBindingSystemLlm(d.data.bindings?.system_llm ?? "");
        setBindingLogAnalyze(d.data.bindings?.log_analyze ?? "");
        setBindingQaSummarize(d.data.bindings?.qa_summarize ?? "");
      }
    }).catch(console.error);
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

  const addMember = () => {
    if (!addCh || !addMemberId.trim()) { toast.error("请选择项目并填写成员 ID"); return; }
    fetch(`${API}/channels/${addCh}/members`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ member_id: addMemberId.trim(), member_type: addMemberType }) })
      .then((r) => r.json())
      .then((d) => { if (d.status === "success") toast.success("添加成功"); else toast.error(d.message || d.detail || "添加失败"); })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const removeMember = () => {
    if (!rmCh || !rmMemberId.trim()) { toast.error("请选择项目并填写成员 ID"); return; }
    fetch(`${API}/channels/${rmCh}/members/${encodeURIComponent(rmMemberId.trim())}`, { method: "DELETE" })
      .then((r) => r.json())
      .then((d) => { if (d.status === "success") toast.success("移除成功"); else toast.error(d.message || d.detail || "移除失败"); })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

  const createBot = () => {
    if (!botUsername.trim() || !botEndpoint.trim()) { toast.error("请填写 @ 名字和 OpenClaw 地址"); return; }
    const body: Record<string, string> = { username: botUsername.trim(), openclaw_endpoint: botEndpoint.trim(), status: botStatus };
    if (botId.trim()) body.bot_id = botId.trim();
    if (botDisplayName.trim()) body.display_name = botDisplayName.trim();
    fetch(`${API}/bots`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") { toast.success("Bot 创建成功"); setLastCreatedBotId(d.data?.bot_id ?? ""); if (botWizardStep === 1) setBotWizardStep(2); setBotId(""); setBotUsername(""); setBotDisplayName(""); setBotEndpoint(""); setBotStatus("online"); }
        else toast.error(d.message || d.detail || "创建失败");
      })
      .catch((e) => toast.error("请求失败: " + String(e)));
  };

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

  const tabs: { id: TabId; label: string }[] = [
    { id: "llm", label: "LLM 参数" },
    { id: "perf", label: "性能监控" },
    { id: "logs", label: "日志与排查" },
    { id: "bot", label: "Bot 与频道" },
    { id: "health", label: "系统状态" },
  ];

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-800">管理后台</h1>
        <Link to="/" className="text-sm text-blue-600 hover:underline">返回首页</Link>
      </header>
      <div className="flex border-b bg-white px-4 gap-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2 text-sm font-medium rounded-t ${activeTab === t.id ? "bg-gray-100 text-blue-700 border-b-2 border-blue-600 -mb-px" : "text-gray-600 hover:bg-gray-50"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <main className="flex-1 p-4 overflow-auto">
        {activeTab === "llm" && (
          <div className="max-w-3xl space-y-6">
            <h2 className="text-base font-medium text-gray-800">LLM 参数</h2>
            <p className="text-sm text-gray-500">一层：设定 LLM（增删改、列表）；二层：为各功能从下拉中选择使用的 LLM。</p>

            <section className="bg-white p-4 rounded border">
              <h3 className="text-sm font-medium text-gray-700 mb-2">一层 · LLM 设定</h3>
              <div className="overflow-x-auto mb-3">
                <table className="w-full text-sm border border-gray-200">
                  <thead><tr className="bg-gray-50"><th className="border px-2 py-1 text-left">名称</th><th className="border px-2 py-1 text-left">Base URL</th><th className="border px-2 py-1 text-left">Model</th><th className="border px-2 py-1 text-left">操作</th></tr></thead>
                  <tbody>
                    {llmProviders.length === 0 ? <tr><td colSpan={4} className="border px-2 py-2 text-gray-500">暂无，请先添加</td></tr> : llmProviders.map((p) => (
                      <tr key={p.id}><td className="border px-2 py-1">{p.name}</td><td className="border px-2 py-1 truncate max-w-[200px]" title={p.base_url}>{p.base_url}</td><td className="border px-2 py-1">{p.model}</td><td className="border px-2 py-1"><button type="button" onClick={() => { setLlmEditingId(p.id); setLlmForm({ name: p.name, base_url: p.base_url, model: p.model, api_key: "", temperature: p.temperature, max_tokens: p.max_tokens }); }} className="mr-1 text-blue-600 text-xs">编辑</button><button type="button" onClick={() => deleteLlmProvider(p.id)} className="text-red-600 text-xs">删除</button></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <form className="grid gap-2 text-sm max-w-lg" onSubmit={(e) => e.preventDefault()}>
                <label className="flex items-center gap-2"><span className="w-24">名称</span><input type="text" value={llmForm.name} onChange={(e) => setLlmForm((f) => ({ ...f, name: e.target.value }))} placeholder="如：Ollama 本地" className="border rounded px-2 py-1 flex-1" /></label>
                <label className="flex items-center gap-2"><span className="w-24">Base URL</span><input type="text" value={llmForm.base_url} onChange={(e) => setLlmForm((f) => ({ ...f, base_url: e.target.value }))} placeholder="http://localhost:11434/v1" className="border rounded px-2 py-1 flex-1" /></label>
                <label className="flex items-center gap-2"><span className="w-24">Model</span><input type="text" value={llmForm.model} onChange={(e) => setLlmForm((f) => ({ ...f, model: e.target.value }))} placeholder="llama3" className="border rounded px-2 py-1 flex-1" /></label>
                <label className="flex items-center gap-2"><span className="w-24">API Key</span><input type="password" value={llmForm.api_key} onChange={(e) => setLlmForm((f) => ({ ...f, api_key: e.target.value }))} placeholder={llmEditingId ? "留空不修改" : "选填"} className="border rounded px-2 py-1 flex-1" autoComplete="off" /></label>
                <label className="flex items-center gap-2"><span className="w-24">Temperature</span><input type="number" step={0.1} value={llmForm.temperature} onChange={(e) => setLlmForm((f) => ({ ...f, temperature: Number(e.target.value) }))} className="border rounded px-2 py-1 w-20" /></label>
                <label className="flex items-center gap-2"><span className="w-24">Max Tokens</span><input type="number" value={llmForm.max_tokens} onChange={(e) => setLlmForm((f) => ({ ...f, max_tokens: Number(e.target.value) }))} className="border rounded px-2 py-1 w-20" /></label>
                <div className="flex gap-2 items-center">
                  <button type="button" onClick={() => saveLlmProvider(!!llmEditingId)} disabled={llmSaveLoading} className="px-3 py-1 bg-blue-600 text-white rounded text-sm disabled:opacity-60 disabled:cursor-not-allowed">{llmSaveLoading ? "提交中…" : (llmEditingId ? "保存修改" : "新增")}</button>
                  {llmEditingId && <button type="button" onClick={() => { setLlmEditingId(null); setLlmForm({ name: "", base_url: "", model: "", api_key: "", temperature: 0.7, max_tokens: 1000 }); }} disabled={llmSaveLoading} className="px-3 py-1 bg-gray-200 rounded text-sm">取消</button>}
                </div>
              </form>
            </section>

            <section className="bg-white p-4 rounded border">
              <h3 className="text-sm font-medium text-gray-700 mb-2">二层 · 功能绑定</h3>
              <p className="text-xs text-gray-500 mb-2">为以下功能选择要使用的 LLM（从上方已添加的设定中选择）。</p>
              <div className="space-y-2 text-sm">
                <label className="flex items-center gap-2">
                  <span className="w-32">引导 Bot</span>
                  <select value={bindingGuideBot} onChange={(e) => setBindingGuideBot(e.target.value)} className="border rounded px-2 py-1 flex-1 max-w-xs">
                    <option value="">— 不绑定 —</option>
                    {llmProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <span className="w-32">系统 LLM</span>
                  <select value={bindingSystemLlm} onChange={(e) => setBindingSystemLlm(e.target.value)} className="border rounded px-2 py-1 flex-1 max-w-xs">
                    <option value="">— 不绑定 —</option>
                    {llmProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <span className="text-gray-500 text-xs">RECENT 压缩等</span>
                </label>
                <label className="flex items-center gap-2">
                  <span className="w-32">日志分析</span>
                  <select value={bindingLogAnalyze} onChange={(e) => setBindingLogAnalyze(e.target.value)} className="border rounded px-2 py-1 flex-1 max-w-xs">
                    <option value="">— 不绑定 —</option>
                    {llmProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <span className="text-gray-500 text-xs">未选时使用系统 LLM</span>
                </label>
                <label className="flex items-center gap-2">
                  <span className="w-32">问答总结</span>
                  <select value={bindingQaSummarize} onChange={(e) => setBindingQaSummarize(e.target.value)} className="border rounded px-2 py-1 flex-1 max-w-xs">
                    <option value="">— 不绑定 —</option>
                    {llmProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <span className="text-gray-500 text-xs">未选时使用系统 LLM</span>
                </label>
                <button type="button" onClick={saveLlmBindings} className="px-3 py-1 bg-blue-600 text-white rounded text-sm">保存绑定</button>
              </div>
            </section>

            <section className="bg-white p-4 rounded border">
              <h3 className="text-sm font-medium text-gray-700 mb-2">澄清策略</h3>
              <p className="text-xs text-gray-500 mb-2">用于控制引导 Bot 在问题不清晰时是否弹出澄清窗口。</p>
              <div className="space-y-2 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={clarifySettings.clarify_strict_mode}
                    onChange={(e) =>
                      setClarifySettings((prev) => ({ ...prev, clarify_strict_mode: e.target.checked }))
                    }
                  />
                  <span>严格模式（更倾向先澄清再回答）</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={clarifySettings.clarify_force_rule}
                    onChange={(e) =>
                      setClarifySettings((prev) => ({ ...prev, clarify_force_rule: e.target.checked }))
                    }
                  />
                  <span>允许规则强制澄清（命中规则时直接弹窗）</span>
                </label>
                <label className="flex items-center gap-2">
                  <span className="w-40">LLM 澄清阈值（0~1）</span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={clarifySettings.clarify_threshold}
                    onChange={(e) =>
                      setClarifySettings((prev) => ({
                        ...prev,
                        clarify_threshold: Number(e.target.value),
                      }))
                    }
                    className="border rounded px-2 py-1 w-24"
                  />
                </label>
                <button type="button" onClick={saveClarifySettings} className="px-3 py-1 bg-blue-600 text-white rounded text-sm">
                  保存澄清策略
                </button>
              </div>
            </section>
          </div>
        )}

        {activeTab === "perf" && (
          <div>
            <h2 className="text-base font-medium text-gray-800 mb-2">性能监控</h2>
            <p className="text-sm text-gray-500 mb-2">最近 Agent 任务执行记录。</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border border-gray-200 bg-white">
                <thead><tr className="bg-gray-50"><th className="border px-2 py-1 text-left">Bot</th><th className="border px-2 py-1 text-left">频道</th><th className="border px-2 py-1 text-left">耗时(ms)</th><th className="border px-2 py-1 text-left">时间</th></tr></thead>
                <tbody>
                  {(taskList.length === 0) ? <tr><td colSpan={4} className="border px-2 py-2 text-gray-500">暂无记录</td></tr> : taskList.slice(0, 50).map((t) => (
                    <tr key={t.task_id}><td className="border px-2 py-1">{t.bot_username ?? t.task_id.slice(0, 8)}</td><td className="border px-2 py-1">{t.channel_id?.slice(0, 8)}…</td><td className="border px-2 py-1">{t.latency_ms ?? "—"}</td><td className="border px-2 py-1">{t.created_at?.slice(0, 19) ?? ""}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === "logs" && (
          <div className="space-y-4">
            <h2 className="text-base font-medium text-gray-800">日志与排查</h2>
            <p className="text-sm text-gray-500">日志格式面向 LLM 设计，便于「请 LLM 分析」给出可能原因与排查步骤。</p>
            <div className="flex gap-2 items-center">
              <select value={logLevel} onChange={(e) => setLogLevel(e.target.value)} className="border rounded px-2 py-1 text-sm">
                <option value="">全部</option>
                <option value="DEBUG">DEBUG</option>
                <option value="INFO">INFO</option>
                <option value="WARNING">WARNING</option>
                <option value="ERROR">ERROR</option>
              </select>
              <button type="button" onClick={loadLogs} className="px-3 py-1 bg-gray-200 text-gray-700 rounded text-sm">刷新日志</button>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">日志摘要（可编辑后发给 LLM）</label>
                <textarea value={logExcerpt} onChange={(e) => setLogExcerpt(e.target.value)} className="w-full border rounded p-2 font-mono text-xs h-64" placeholder="点击「刷新日志」加载" />
                <label className="block text-sm font-medium text-gray-700 mt-2 mb-1">补充问题（可选）</label>
                <input type="text" value={logQuestion} onChange={(e) => setLogQuestion(e.target.value)} placeholder="例如：为什么连接被拒绝？" className="w-full border rounded px-2 py-1 text-sm" />
                <button type="button" onClick={analyzeLogs} disabled={logLoading} className="mt-2 px-4 py-2 bg-blue-600 text-white rounded text-sm disabled:opacity-50">请 LLM 分析</button>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">LLM 分析结果</label>
                <div className="w-full border rounded p-2 bg-gray-50 text-sm whitespace-pre-wrap min-h-64">{logLoading ? "分析中…" : (logAnalysis || "—")}</div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "bot" && (
          <div className="max-w-2xl space-y-6">
            <h2 className="text-base font-medium text-gray-800">Bot 与频道</h2>
            <section>
              <h3 className="text-sm font-medium text-gray-700 mb-2">创建工作空间</h3>
              <div className="flex gap-2"><input type="text" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="空间名称" className="border rounded px-2 py-1" /><button type="button" onClick={createWorkspace} className="px-3 py-1 bg-blue-600 text-white rounded text-sm">创建</button></div>
            </section>
            <section>
              <h3 className="text-sm font-medium text-gray-700 mb-2">创建项目</h3>
              <div className="flex flex-wrap gap-2">
                <select value={createWs} onChange={(e) => setCreateWs(e.target.value)} className="border rounded px-2 py-1 text-sm"><option value="">选择工作空间</option>{workspaces.map((w) => <option key={w.workspace_id} value={w.workspace_id}>{w.name}</option>)}</select>
                <input type="text" value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="项目名称" className="border rounded px-2 py-1 text-sm" />
                <button type="button" onClick={createChannel} className="px-3 py-1 bg-blue-600 text-white rounded text-sm">创建</button>
              </div>
            </section>
            <section>
              <h3 className="text-sm font-medium text-gray-700 mb-2">添加成员</h3>
              <div className="flex flex-wrap gap-2">
                <select value={addCh} onChange={(e) => setAddCh(e.target.value)} className="border rounded px-2 py-1 text-sm"><option value="">选择项目</option>{channels.map((c) => <option key={c.channel_id} value={c.channel_id}># {c.name}</option>)}</select>
                <input type="text" value={addMemberId} onChange={(e) => setAddMemberId(e.target.value)} placeholder="成员 ID" className="border rounded px-2 py-1 text-sm w-40" />
                <select value={addMemberType} onChange={(e) => setAddMemberType(e.target.value as "user" | "bot")} className="border rounded px-2 py-1 text-sm"><option value="user">用户</option><option value="bot">Bot</option></select>
                <button type="button" onClick={addMember} className="px-3 py-1 bg-blue-600 text-white rounded text-sm">添加</button>
              </div>
            </section>
            <section>
              <h3 className="text-sm font-medium text-gray-700 mb-2">移除成员</h3>
              <div className="flex flex-wrap gap-2">
                <select value={rmCh} onChange={(e) => setRmCh(e.target.value)} className="border rounded px-2 py-1 text-sm"><option value="">选择项目</option>{channels.map((c) => <option key={c.channel_id} value={c.channel_id}># {c.name}</option>)}</select>
                <input type="text" value={rmMemberId} onChange={(e) => setRmMemberId(e.target.value)} placeholder="成员 ID" className="border rounded px-2 py-1 text-sm w-40" />
                <button type="button" onClick={removeMember} className="px-3 py-1 bg-red-100 text-red-700 rounded text-sm">移除</button>
              </div>
            </section>
            <section>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Bot 添加向导</h3>
              {botWizardStep === 0 && (
                <div className="flex gap-2">
                  <button type="button" onClick={() => { setBotWizardType("guide"); setBotEndpoint("guide://"); setBotWizardStep(1); }} className="px-3 py-2 border rounded text-sm">引导 Bot</button>
                  <button type="button" onClick={() => { setBotWizardType("http"); setBotEndpoint("https://"); setBotWizardStep(1); }} className="px-3 py-2 border rounded text-sm">真实 OpenClaw</button>
                  <button type="button" onClick={() => { setBotWizardType("mock"); setBotEndpoint("mock://"); setBotWizardStep(1); }} className="px-3 py-2 border rounded text-sm">Mock</button>
                </div>
              )}
              {botWizardStep === 1 && (
                <div className="space-y-2 text-sm">
                  <div><label className="block text-gray-700">@ 用名字</label><input type="text" value={botUsername} onChange={(e) => setBotUsername(e.target.value)} placeholder="如：小助" className="border rounded px-2 py-1 w-full" /></div>
                  <div><label className="block text-gray-700">显示名称</label><input type="text" value={botDisplayName} onChange={(e) => setBotDisplayName(e.target.value)} className="border rounded px-2 py-1 w-full" /></div>
                  <div><label className="block text-gray-700">openclaw_endpoint</label><input type="text" value={botEndpoint} onChange={(e) => setBotEndpoint(e.target.value)} className="border rounded px-2 py-1 w-full" /></div>
                  <div className="flex gap-2"><button type="button" onClick={createBot} className="px-3 py-1 bg-blue-600 text-white rounded text-sm">创建</button><button type="button" onClick={() => setBotWizardStep(0)} className="px-3 py-1 bg-gray-200 rounded text-sm">上一步</button></div>
                </div>
              )}
              {botWizardStep === 2 && (
                <div className="space-y-2 text-sm">
                  <p className="text-green-600">Bot 已创建，请加入项目。</p>
                  <div className="flex gap-2">
                    <select value={addCh} onChange={(e) => setAddCh(e.target.value)} className="border rounded px-2 py-1"><option value="">选择项目</option>{channels.map((c) => <option key={c.channel_id} value={c.channel_id}># {c.name}</option>)}</select>
                    <button type="button" onClick={addBotToChannel} className="px-3 py-1 bg-blue-600 text-white rounded text-sm">将 Bot 加入所选项目</button>
                  </div>
                  <button type="button" onClick={() => { setBotWizardStep(0); setLastCreatedBotId(""); }} className="text-gray-500 text-xs">完成</button>
                </div>
              )}
            </section>
            <section>
              <h3 className="text-sm font-medium text-gray-700 mb-2">创建 Bot（高级）</h3>
              <table className="w-full text-sm"><tbody>
                <tr><td className="py-1 pr-2 w-32">bot_id（可选）</td><td><input type="text" value={botId} onChange={(e) => setBotId(e.target.value)} className="border rounded px-2 py-1 w-full" /></td></tr>
                <tr><td className="py-1 pr-2">username</td><td><input type="text" value={botUsername} onChange={(e) => setBotUsername(e.target.value)} className="border rounded px-2 py-1 w-full" /></td></tr>
                <tr><td className="py-1 pr-2">display_name</td><td><input type="text" value={botDisplayName} onChange={(e) => setBotDisplayName(e.target.value)} className="border rounded px-2 py-1 w-full" /></td></tr>
                <tr><td className="py-1 pr-2">openclaw_endpoint</td><td><input type="text" value={botEndpoint} onChange={(e) => setBotEndpoint(e.target.value)} className="border rounded px-2 py-1 w-full" /></td></tr>
                <tr><td className="py-1 pr-2">status</td><td><select value={botStatus} onChange={(e) => setBotStatus(e.target.value)} className="border rounded px-2 py-1"><option value="online">online</option><option value="offline">offline</option></select></td></tr>
              </tbody></table>
              <button type="button" onClick={createBot} className="mt-2 px-3 py-1 bg-blue-600 text-white rounded text-sm">创建</button>
            </section>
            <section>
              <h3 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                待审核 Bot 申请
                <button type="button" onClick={loadPendingRequests} className="text-xs text-blue-600 hover:underline">刷新</button>
              </h3>
              {pendingRequests.length === 0 ? <p className="text-sm text-gray-500">暂无</p> : (
                <table className="w-full text-sm border border-gray-200"><thead><tr className="bg-gray-50"><th className="border px-2 py-1 text-left">username</th><th className="border px-2 py-1 text-left">endpoint</th><th className="border px-2 py-1 text-left">操作</th></tr></thead><tbody>
                  {pendingRequests.map((r) => (
                    <tr key={r.request_id}><td className="border px-2 py-1">{r.username}</td><td className="border px-2 py-1 break-all">{r.openclaw_endpoint}</td><td className="border px-2 py-1"><button type="button" onClick={() => approveRequest(r.request_id)} className="mr-1 px-2 py-0.5 bg-green-600 text-white rounded text-xs">通过</button><button type="button" onClick={() => rejectRequest(r.request_id)} className="px-2 py-0.5 bg-red-100 text-red-700 rounded text-xs">拒绝</button></td></tr>
                  ))}</tbody></table>
              )}
            </section>
            <p className="text-sm"><a href="/docs" target="_blank" rel="noreferrer" className="text-blue-600 underline">打开 API 文档</a></p>
          </div>
        )}

        {activeTab === "health" && (
          <div>
            <h2 className="text-base font-medium text-gray-800 mb-2">系统状态</h2>
            {healthStatus ? (
              <ul className="space-y-1 text-sm">
                <li>数据库: <span className={healthStatus.database === "ok" ? "text-green-600" : "text-red-600"}>{healthStatus.database}</span></li>
                <li>Redis: <span className={healthStatus.redis === "ok" ? "text-green-600" : "text-red-600"}>{healthStatus.redis}</span></li>
                <li>引导 LLM: <span className={
                  healthStatus.guide_llm === "ok" ? "text-green-600" :
                  healthStatus.guide_llm === "degraded (503)" ? "text-amber-600" : "text-red-600"
                }>{healthStatus.guide_llm ?? "—"}</span></li>
              </ul>
            ) : (
              <p className="text-gray-500">加载中…</p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
