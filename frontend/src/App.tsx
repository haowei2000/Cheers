import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

const API = "/api";
const WS_BASE = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const DEV_USER_ID = "a0000000-0000-0000-0000-000000000001";
const API_DOCS_URL = "/docs";

type Workspace = { workspace_id: string; name: string };
type Channel = { channel_id: string; name: string; type: string };
type Message = {
  msg_id: string;
  sender_id: string;
  sender_type: string;
  content: string;
  created_at?: string;
};
type ContextData = Record<string, string>;

const LAYERS = ["ANCHOR", "DECISIONS", "FILES_INDEX", "RECENT"] as const;

const GUIDE_FORM_BLOCK = /```guide-form\n([\s\S]*?)```/;

type GuideFormField = {
  name: string;
  type: string;
  label: string;
  placeholder?: string;
  options_url?: string;
  option_value?: string;
  option_label?: string;
};

type GuideFormSchema = { action: string; fields: GuideFormField[] };

function parseGuideForm(content: string): { text: string; form?: GuideFormSchema } {
  const match = content.match(GUIDE_FORM_BLOCK);
  if (!match) return { text: content.trim() };
  const text = content.slice(0, match.index).trim();
  try {
    const form = JSON.parse(match[1].trim()) as GuideFormSchema;
    return { text, form };
  } catch {
    return { text: content.trim() };
  }
}

/** 将消息内容中的 [text](url) 转为可点击链接，仅允许 / 或 http(s) 的 url */
function renderMessageContent(content: string): (string | JSX.Element)[] {
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  const out: (string | React.ReactElement)[] = [];
  let lastIndex = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push(content.slice(lastIndex, m.index));
    const rawUrl = m[2].trim();
    const safe = rawUrl.startsWith("/") || rawUrl.startsWith("http://") || rawUrl.startsWith("https://");
    out.push(
      <a
        key={key++}
        href={safe ? rawUrl : "#"}
        target="_blank"
        rel="noreferrer"
        className="text-blue-600 underline"
      >
        {m[1]}
      </a>
    );
    lastIndex = re.lastIndex;
  }
  out.push(content.slice(lastIndex));
  return out;
}

const THINK_BLOCK = /<think>([\s\S]*?)<\/think>/gi;

/** 将内容中的 <think>...</think> 替换为可折叠块，返回用于渲染的 React 节点数组 */
function renderWithThinkFolding(content: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  THINK_BLOCK.lastIndex = 0;
  while ((match = THINK_BLOCK.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(...renderMessageContent(content.slice(lastIndex, match.index)));
    }
    const thinkContent = match[1]?.trim() || "";
    parts.push(
      <ThinkFold key={key++} content={thinkContent} />
    );
    lastIndex = THINK_BLOCK.lastIndex;
  }
  if (lastIndex < content.length) {
    parts.push(...renderMessageContent(content.slice(lastIndex)));
  }
  return parts.length > 0 ? parts : renderMessageContent(content);
}

function ThinkFold({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 rounded border border-gray-200 bg-gray-50 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-2 py-1.5 text-left text-xs text-gray-500 hover:bg-gray-100 flex items-center gap-1"
      >
        <span className="inline-block transition-transform" style={{ transform: open ? "rotate(90deg)" : "none" }}>▶</span>
        <span>{"<think> "}{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <pre className="p-2 text-xs text-gray-600 whitespace-pre-wrap border-t border-gray-200 max-h-48 overflow-auto">
          {content}
        </pre>
      )}
    </div>
  );
}

function refreshChannels(setChannels: (c: Channel[]) => void) {
  fetch(`${API}/channels`)
    .then((r) => r.json())
    .then((d) => d.data && setChannels(d.data))
    .catch(console.error);
}

/** 引导动态表单：根据 schema 渲染并提交，成功后回调 */
function GuideFormBlock({
  msgId,
  form,
  channelId,
  onReply,
  onChannelsRefresh,
}: {
  msgId: string;
  form: GuideFormSchema;
  channelId: string;
  onReply: (msg: Message) => void;
  onChannelsRefresh: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<Record<string, { value: string; label: string }[]>>({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    form.fields.forEach((f) => {
      if (f.type === "select" && f.options_url) {
        fetch(`${API}${f.options_url}`)
          .then((r) => r.json())
          .then((d) => {
            if (d.data && Array.isArray(d.data)) {
              const val = f.option_value || "value";
              const lab = f.option_label || "label";
              setOptions((prev) => ({
                ...prev,
                [f.name]: d.data.map((o: Record<string, string>) => ({
                  value: o[val],
                  label: o[lab] ?? o[val],
                })),
              }));
            }
          })
          .catch(() => {});
      }
    });
  }, [form.fields]);

  const handleSubmit = () => {
    if (form.action === "create_channel") {
      const workspace_id = values.workspace_id;
      const name = values.name?.trim();
      if (!workspace_id || !name) {
        setError("请选择工作空间并填写项目名称");
        return;
      }
      setError(null);
      fetch(`${API}/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id, name, type: "public" }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.status === "success") {
            setSubmitted(true);
            const chName = d.data?.name ?? name;
            return fetch(`${API}/channels/${channelId}/guide-reply`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: `项目「${chName}」已创建。你可以在左侧列表中看到新项目。`,
              }),
            })
              .then((res) => res.json())
              .then((res) => {
                if (res.data) onReply(res.data);
                onChannelsRefresh();
              });
          }
          setError(d.detail || d.message || "创建失败");
        })
        .catch(() => setError("请求失败"));
    }
  };

  if (submitted) {
    return <p className="text-sm text-green-600 mt-2">已提交并创建项目。</p>;
  }

  return (
    <div className="mt-2 p-2 bg-gray-50 rounded border border-gray-200 text-sm">
      {form.fields.map((f) => (
        <div key={f.name} className="mb-2">
          <label className="block text-gray-700 mb-0.5">{f.label}</label>
          {f.type === "select" ? (
            <select
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              className="border rounded px-2 py-1 w-full"
            >
              <option value="">请选择</option>
              {(options[f.name] ?? []).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              placeholder={f.placeholder}
              className="border rounded px-2 py-1 w-full"
            />
          )}
        </div>
      ))}
      {error && <p className="text-red-600 text-xs mb-1">{error}</p>}
      <button
        type="button"
        onClick={handleSubmit}
        className="px-3 py-1 bg-blue-600 text-white rounded text-sm"
      >
        提交
      </button>
    </div>
  );
}

export default function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextData, setContextData] = useState<ContextData>({});
  const [pendingFileIds, setPendingFileIds] = useState<string[]>([]);
  const [pendingFileNames, setPendingFileNames] = useState<string[]>([]);

  type ChannelBot = { member_id: string; username: string };
  type BotItem = { bot_id: string; username: string; display_name?: string; intro?: string };
  const [channelBots, setChannelBots] = useState<ChannelBot[]>([]);
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [addBotOpen, setAddBotOpen] = useState(false);
  const [allBots, setAllBots] = useState<BotItem[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function introSummary(intro: string | undefined): string {
    if (!intro) return "";
    try {
      const o = JSON.parse(intro);
      if (o.description) return o.description;
      if (Array.isArray(o.capabilities)) return o.capabilities.join(", ");
      return intro.slice(0, 50) + (intro.length > 50 ? "…" : "");
    } catch {
      return intro.slice(0, 50) + (intro.length > 50 ? "…" : "");
    }
  }

  useEffect(() => {
    refreshChannels(setChannels);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      setChannelBots([]);
      return;
    }
    setLoading(true);
    fetch(`${API}/channels/${selectedId}/members?with_username=1`)
      .then((r) => r.json())
      .then((d) => {
        if (d.data) {
          const bots: ChannelBot[] = d.data
            .filter((m: { member_type: string; username?: string }) => m.member_type === "bot" && m.username)
            .map((m: { member_id: string; username: string }) => ({ member_id: m.member_id, username: m.username }));
          setChannelBots(bots);
        } else setChannelBots([]);
      })
      .catch(() => setChannelBots([]));
    fetch(`${API}/channels/${selectedId}/messages`)
      .then((r) => r.json())
      .then((d) => (d.data ? setMessages(d.data) : setMessages([])))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const ws = new WebSocket(`${WS_BASE}/ws/channels/${selectedId}`);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "message" && msg.data) {
          setMessages((prev) => {
            const id = msg.data.msg_id;
            if (id && prev.some((m) => m.msg_id === id)) return prev;
            return [...prev, msg.data];
          });
        }
      } catch {}
    };
    return () => ws.close();
  }, [selectedId]);

  useEffect(() => {
    if (contextOpen && selectedId) {
      fetch(`${API}/channels/${selectedId}/context`)
        .then((r) => r.json())
        .then((d) => d.data && setContextData(d.data))
        .catch(console.error);
    }
  }, [contextOpen, selectedId]);

  useEffect(() => {
    if (addBotOpen) {
      fetch(`${API}/bots`).then((r) => r.json()).then((d) => setAllBots(d.data || [])).catch(() => setAllBots([]));
    }
  }, [addBotOpen]);

  const addBotToChannel = (botId: string) => {
    if (!selectedId) return;
    fetch(`${API}/channels/${selectedId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: botId, member_type: "bot" }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          fetch(`${API}/channels/${selectedId}/members?with_username=1`)
            .then((res) => res.json())
            .then((res) => {
              if (res.data) {
                const bots: ChannelBot[] = res.data
                  .filter((m: { member_type: string; username?: string }) => m.member_type === "bot" && m.username)
                  .map((m: { member_id: string; username: string }) => ({ member_id: m.member_id, username: m.username }));
                setChannelBots(bots);
              }
            });
        }
      })
      .catch(console.error);
  };

  const removeBotFromChannel = (memberId: string) => {
    if (!selectedId) return;
    fetch(`${API}/channels/${selectedId}/members/${encodeURIComponent(memberId)}`, { method: "DELETE" })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          setChannelBots((prev) => prev.filter((b) => b.member_id !== memberId));
        }
      })
      .catch(console.error);
  };

  const send = () => {
    if (!selectedId || !input.trim()) return;
    const body = {
      content: input.trim(),
      sender_id: DEV_USER_ID,
      sender_type: "user",
      file_ids: pendingFileIds,
    };
    fetch(`${API}/channels/${selectedId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((d) => {
        setMessages((prev) => {
          if (!d.data) return prev;
          if (prev.some((m) => m.msg_id === d.data.msg_id)) return prev;
          return [...prev, d.data];
        });
        setInput("");
        setPendingFileIds([]);
        setPendingFileNames([]);
      })
      .catch(console.error);
  };

  const uploadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedId) return;
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    const allowed = [".txt", ".md", ".docx", ".pdf", ".xlsx", ".png", ".jpg", ".jpeg", ".webp"];
    if (!allowed.includes(ext)) {
      alert("支持格式: " + allowed.join(", "));
      return;
    }
    fetch(
      `${API}/files/upload?channel_id=${encodeURIComponent(selectedId)}&uploader_id=${encodeURIComponent(DEV_USER_ID)}&filename=${encodeURIComponent(file.name)}`,
      { method: "POST", body: file }
    )
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.file_id) {
          setPendingFileIds((prev) => [...prev, d.data.file_id]);
          setPendingFileNames((prev) => [...prev, file.name]);
        }
      })
      .catch(console.error);
    e.target.value = "";
  };

  const saveContextLayer = (layer: string, content: string) => {
    if (!selectedId) return;
    fetch(`${API}/channels/${selectedId}/context`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layer, content }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") setContextData((prev) => ({ ...prev, [layer.toLowerCase()]: content }));
      })
      .catch(console.error);
  };

  return (
    <div className="flex h-screen bg-gray-100">
      <aside className="w-64 bg-white border-r flex flex-col">
        <div className="p-3 border-b text-sm text-gray-600">当前用户: dev</div>
        <div className="p-2 font-medium text-gray-700">频道</div>
        <ul className="overflow-auto flex-1">
          {channels.map((c) => (
            <li key={c.channel_id}>
              <button
                type="button"
                onClick={() => setSelectedId(c.channel_id)}
                className={`w-full text-left px-3 py-2 rounded mx-1 ${
                  selectedId === c.channel_id ? "bg-blue-100 text-blue-800" : "hover:bg-gray-100"
                }`}
              >
                # {c.name}
              </button>
            </li>
          ))}
        </ul>
        <div className="p-2 border-t space-y-0.5">
          <Link
            to="/admin"
            className="block w-full text-left px-3 py-2 rounded mx-1 text-gray-600 hover:bg-gray-100 text-sm"
          >
            管理
          </Link>
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="w-full text-left px-3 py-2 rounded mx-1 text-gray-600 hover:bg-gray-100 text-sm flex items-center gap-1.5"
          >
            <span aria-hidden>?</span>
            <span>帮助</span>
          </button>
        </div>
      </aside>

      {helpOpen && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/30"
          onClick={() => setHelpOpen(false)}
          aria-modal="true"
          role="dialog"
        >
          <div
            className="bg-white rounded-lg shadow-lg max-w-md w-full mx-4 p-5 text-left max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-lg font-semibold text-gray-800">使用帮助</h2>
              <button type="button" onClick={() => setHelpOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none" aria-label="关闭">
                ×
              </button>
            </div>
            <p className="text-gray-700 text-sm mb-3">
              在任意频道输入 <strong>@引导</strong> 并输入你的问题，引导 Bot 会根据说明书自动回复，并显示相关入口。
            </p>
            <p className="text-gray-600 text-xs mb-2">例如可以问：</p>
            <ul className="text-sm text-gray-700 space-y-1 list-disc list-inside mb-2">
              <li>@引导 怎么用</li>
              <li>@引导 怎么创建项目</li>
              <li>@引导 怎么加入项目</li>
              <li>@引导 怎么接入 OpenClaw</li>
              <li>@引导 入口</li>
            </ul>
            <p className="text-gray-600 text-xs mb-2">前端入口：</p>
            <ul className="text-sm text-gray-700 space-y-1 list-disc list-inside mb-4">
              <li>创建项目、Bot、性能监控、日志排查：左侧 <strong>管理</strong> 进入管理页面</li>
              <li>上传文件：频道内输入框旁 <strong>上传</strong>（.txt/.md/.docx/.pdf/.xlsx/.png/.jpg 等）</li>
              <li>频道上下文：选中频道后点击 <strong>频道上下文</strong></li>
              <li>API 文档：管理页内「打开 API 文档」或 <a href={API_DOCS_URL} target="_blank" rel="noreferrer" className="text-blue-600 underline">/docs</a></li>
            </ul>
            <p className="text-gray-500 text-xs">完整说明见项目文档。</p>
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={() => setHelpOpen(false)} className="px-3 py-1.5 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm">
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {addBotOpen && selectedId && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/30" onClick={() => setAddBotOpen(false)} aria-modal="true" role="dialog">
          <div className="bg-white rounded-lg shadow-lg max-w-xl w-full mx-4 p-5 text-left max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-lg font-semibold text-gray-800">管理频道 Bot</h2>
              <button type="button" onClick={() => setAddBotOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none" aria-label="关闭">×</button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-2">已加入的 Bot</h3>
                {channelBots.length === 0 ? (
                  <p className="text-sm text-gray-500">暂无</p>
                ) : (
                  <ul className="space-y-1">
                    {channelBots.map((b) => (
                      <li key={b.member_id} className="flex items-center justify-between py-1.5 px-2 bg-gray-50 rounded text-sm">
                        <span>@{b.username}</span>
                        <button type="button" onClick={() => removeBotFromChannel(b.member_id)} className="text-red-600 text-xs">移除</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-2">可添加的 Bot</h3>
                {(() => {
                  const inChannelIds = new Set(channelBots.map((c) => c.member_id));
                  const available = allBots.filter((b) => !inChannelIds.has(b.bot_id));
                  if (available.length === 0) return <p className="text-sm text-gray-500">暂无或已全部加入</p>;
                  return (
                    <ul className="space-y-1">
                      {available.map((b) => (
                        <li key={b.bot_id} className="flex flex-col py-1.5 px-2 bg-gray-50 rounded text-sm gap-0.5">
                          <div className="flex items-center justify-between">
                            <span className="font-medium">@{b.username}</span>
                            <button type="button" onClick={() => addBotToChannel(b.bot_id)} className="text-blue-600 text-xs">加入频道</button>
                          </div>
                          {introSummary(b.intro) && <span className="text-xs text-gray-500 truncate" title={b.intro}>{introSummary(b.intro)}</span>}
                        </li>
                      ))}
                    </ul>
                  );
                })()}
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={() => setAddBotOpen(false)} className="px-3 py-1.5 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm">关闭</button>
            </div>
          </div>
        </div>
      )}

      {contextOpen && selectedId && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/30" onClick={() => setContextOpen(false)} aria-modal="true" role="dialog">
          <div className="bg-white rounded-lg shadow-lg max-w-2xl w-full mx-4 p-5 text-left max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-lg font-semibold text-gray-800">频道上下文</h2>
              <button type="button" onClick={() => setContextOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none" aria-label="关闭">
                ×
              </button>
            </div>
            {LAYERS.map((layer) => (
              <div key={layer} className="mb-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">{layer}</label>
                <textarea
                  value={contextData[layer.toLowerCase()] ?? ""}
                  onChange={(e) => setContextData((prev) => ({ ...prev, [layer.toLowerCase()]: e.target.value }))}
                  className="w-full border rounded p-2 text-sm h-24"
                />
                <button
                  type="button"
                  onClick={() => saveContextLayer(layer, contextData[layer.toLowerCase()] ?? "")}
                  className="mt-1 px-2 py-1 bg-gray-200 text-gray-700 rounded text-xs"
                >
                  保存
                </button>
              </div>
            ))}
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={() => setContextOpen(false)} className="px-3 py-1.5 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm">
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="flex-1 flex flex-col min-w-0">
        {selectedId ? (
          <>
            <div className="flex-1 overflow-auto p-4 space-y-2">
              {loading ? (
                <div className="text-gray-500">加载中...</div>
              ) : (
                messages.map((m) => {
                  const { text, form } = parseGuideForm(m.content);
                  return (
                    <div key={m.msg_id} className={`p-2 rounded ${m.sender_type === "bot" ? "bg-green-50 border-l-2 border-green-400" : "bg-white"}`}>
                      <span className="text-xs text-gray-500 flex items-center gap-2">
                        {m.sender_type === "bot" ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-green-200 text-green-800 text-xs font-medium" aria-label="Bot">Bot</span>
                        ) : (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-200 text-gray-700 text-xs">用户</span>
                        )}
                        {m.created_at?.slice(0, 19) || ""}
                      </span>
                      <div className="mt-1 whitespace-pre-wrap">{renderWithThinkFolding(text)}</div>
                      {form && selectedId && m.sender_type === "bot" && (
                        <GuideFormBlock
                          msgId={m.msg_id}
                          form={form}
                          channelId={selectedId}
                          onReply={(newMsg) => setMessages((prev) => [...prev, newMsg])}
                          onChannelsRefresh={() => refreshChannels(setChannels)}
                        />
                      )}
                    </div>
                  );
                })
              )}
            </div>
            <div className="p-2 border-t bg-white flex flex-col gap-2">
              {pendingFileNames.length > 0 && (
                <p className="text-xs text-gray-500">已附: {pendingFileNames.join(", ")}</p>
              )}
              <div className="flex gap-2 items-center">
                <label className="px-3 py-2 border rounded cursor-pointer text-gray-600 hover:bg-gray-50 inline-flex items-center" title="上传">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.49-8.49a4 4 0 0 1 5.66 5.66l-8.49 8.49a2 2 0 0 1-2.83-2.83l8.49-8.49"/></svg>
                  <input
                    type="file"
                    accept=".txt,.md,.docx,.pdf,.xlsx,.png,.jpg,.jpeg,.webp"
                    className="hidden"
                    onChange={uploadFile}
                  />
                </label>
                <div className="flex-1 relative">
                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => {
                      const v = e.target.value;
                      const pos = e.target.selectionStart ?? v.length;
                      setInput(v);
                      const lastAt = v.lastIndexOf("@", pos - 1);
                      if (lastAt !== -1) {
                        const after = v.slice(lastAt + 1, pos);
                        if (!after.includes(" ") && !after.includes("\n")) {
                          setShowMentionDropdown(true);
                          setMentionFilter(after);
                          return;
                        }
                      }
                      setShowMentionDropdown(false);
                    }}
                    onKeyDown={(e) => {
                      if (showMentionDropdown && e.key === "Escape") {
                        setShowMentionDropdown(false);
                        return;
                      }
                      if (e.key === "Enter" && !e.shiftKey) send();
                    }}
                    placeholder="输入消息，输入 @ 选择 Bot…"
                    className="w-full border rounded px-3 py-2"
                  />
                  {showMentionDropdown && (() => {
                    const matched = channelBots.filter((b) =>
                      b.username.toLowerCase().includes(mentionFilter.toLowerCase())
                    );
                    return matched.length > 0 && (
                    <ul
                      className="absolute left-0 right-0 top-full mt-1 bg-white border rounded shadow-lg z-20 max-h-40 overflow-auto"
                      role="listbox"
                    >
                      {matched.map((b) => (
                          <li
                            key={b.member_id}
                            role="option"
                            className="px-3 py-2 hover:bg-gray-100 cursor-pointer text-sm"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              const el = inputRef.current;
                              if (!el) return;
                              const v = el.value;
                              const pos = el.selectionStart ?? v.length;
                              const lastAt = v.lastIndexOf("@", pos - 1);
                              const newVal = v.slice(0, lastAt) + "@" + b.username + " " + v.slice(pos);
                              setInput(newVal);
                              setShowMentionDropdown(false);
                              setTimeout(() => {
                                el.focus();
                                el.setSelectionRange(lastAt + b.username.length + 2, lastAt + b.username.length + 2);
                              }, 0);
                            }}
                          >
                            @{b.username}
                          </li>
                        ))}
                    </ul>
                    );
                  })()}
                </div>
                <button type="button" onClick={send} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
                  发送
                </button>
              </div>
            </div>
            <div className="px-2 pb-2 flex gap-3">
              <button
                type="button"
                onClick={() => setAddBotOpen(true)}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                添加 Bot
              </button>
              <button
                type="button"
                onClick={() => setContextOpen(true)}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                频道上下文
              </button>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            请从左侧选择频道
          </div>
        )}
      </main>
    </div>
  );
}
