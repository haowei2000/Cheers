import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";

const API = "/api";
const WS_BASE = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const DEV_USER_ID = "a0000000-0000-0000-0000-000000000001";
const API_DOCS_URL = "/docs";

type Channel = { channel_id: string; name: string; type: string; workspace_id?: string };
type Workspace = { workspace_id: string; name: string };
type Message = {
  msg_id: string;
  sender_id: string;
  sender_type: string;
  content: string;
  created_at?: string;
};
type QaPair = { question: Message; answer: Message };
type ContextData = Record<string, string>;

const LAYERS = ["ANCHOR", "DECISIONS", "FILES_INDEX", "RECENT"] as const;

const GUIDE_FORM_BLOCK = /```guide-form\n([\s\S]*?)```/;
const GUIDE_CLARIFY_BLOCK = /```guide-clarify\n([\s\S]*?)```/;

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

type ClarifyOption = { id: string; label: string };
type ClarifyQuestion = {
  id: string;
  prompt: string;
  allow_multiple?: boolean;
  options: ClarifyOption[];
  other_enabled?: boolean;
  other_label?: string;
  other_placeholder?: string;
};
type ClarifySchema = {
  title?: string;
  questions: ClarifyQuestion[];
  skip_policy?: "allow" | "forbid";
  reason?: string;
};
type ClarifyAnswers = {
  selected: Record<string, string[]>;
  other_text: Record<string, string>;
};
const OTHER_CHOICE_ID = "__other__";

function parseGuidePayload(content: string): { text: string; form?: GuideFormSchema; clarify?: ClarifySchema } {
  let text = content;
  let form: GuideFormSchema | undefined;
  let clarify: ClarifySchema | undefined;

  const formMatch = text.match(GUIDE_FORM_BLOCK);
  if (formMatch) {
    try {
      form = JSON.parse(formMatch[1].trim()) as GuideFormSchema;
      text = text.replace(formMatch[0], "");
    } catch {}
  }

  const clarifyMatch = text.match(GUIDE_CLARIFY_BLOCK);
  if (clarifyMatch) {
    try {
      const parsed = JSON.parse(clarifyMatch[1].trim()) as ClarifySchema;
      if (Array.isArray(parsed?.questions) && parsed.questions.length > 0) {
        clarify = parsed;
      }
      text = text.replace(clarifyMatch[0], "");
    } catch {}
  }

  return { text: text.trim(), form, clarify };
}


/** 将消息内容中的 [text](url) 转为可点击链接，仅允许 / 或 http(s) 的 url */
function renderMessageContent(content: string, keyPrefix = ""): (string | JSX.Element)[] {
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
        key={`${keyPrefix}link-${key++}`}
        href={safe ? rawUrl : "#"}
        target="_blank"
        rel="noreferrer"
        className="text-[#1264A3] underline"
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
function renderWithThinkFolding(content: string, keyPrefix = ""): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  THINK_BLOCK.lastIndex = 0;
  while ((match = THINK_BLOCK.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(...renderMessageContent(content.slice(lastIndex, match.index), `${keyPrefix}seg-${key}-`));
    }
    const thinkContent = match[1]?.trim() || "";
    parts.push(
      <ThinkFold key={`${keyPrefix}think-${key++}`} content={thinkContent} />
    );
    lastIndex = THINK_BLOCK.lastIndex;
  }
  if (lastIndex < content.length) {
    parts.push(...renderMessageContent(content.slice(lastIndex), `${keyPrefix}tail-${key}-`));
  }
  return parts.length > 0 ? parts : renderMessageContent(content, `${keyPrefix}full-`);
}

function ThinkFold({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 rounded border border-gray-200 bg-gray-50 overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-2 py-1 text-left text-gray-400 hover:bg-gray-100 flex items-center gap-1"
      >
        <span className="inline-block transition-transform" style={{ transform: open ? "rotate(90deg)" : "none" }}>▶</span>
        <span>{"<think> "}{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <pre className="p-2 text-xs text-gray-500 whitespace-pre-wrap border-t border-gray-100 max-h-48 overflow-auto">
          {content}
        </pre>
      )}
    </div>
  );
}

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** 将消息按逻辑问答块分组（含 clarify 轮次），每个块以用户问题开头 */
function buildLogicalQaBlocks(messages: Message[]): { question: Message; messages: Message[] }[] {
  const blocks: { question: Message; messages: Message[] }[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.sender_type !== "user" || isClarifyReplyUserMessage(m.content)) {
      i++;
      continue;
    }
    const blockMessages: Message[] = [m];
    let j = i + 1;
    while (j < messages.length) {
      const next = messages[j];
      if (next.sender_type === "user" && !isClarifyReplyUserMessage(next.content)) {
        break;
      }
      blockMessages.push(next);
      j++;
    }
    blocks.push({ question: m, messages: blockMessages });
    i = j;
  }
  return blocks;
}

function formatTs(ts?: string): string {
  return (ts || "").slice(0, 19);
}

function buildQaMarkdown(channelName: string, pairs: QaPair[]): string {
  const now = new Date();
  const rows: string[] = [];
  rows.push(`# 问答导出 - ${channelName}`);
  rows.push("");
  rows.push(`导出时间: ${now.toISOString()}`);
  rows.push(`问答数量: ${pairs.length}`);
  rows.push("");
  pairs.forEach((p, idx) => {
    const qText = stripThinkTags(parseGuidePayload(p.question.content).text || p.question.content);
    const aText = stripThinkTags(parseGuidePayload(p.answer.content).text || p.answer.content);
    rows.push(`## ${idx + 1}. 问答`);
    rows.push("");
    rows.push(`### 问题 (${formatTs(p.question.created_at) || "-"})`);
    rows.push("");
    rows.push(qText || "-");
    rows.push("");
    rows.push(`### 回答 (${formatTs(p.answer.created_at) || "-"})`);
    rows.push("");
    rows.push(aText || "-");
    rows.push("");
    rows.push("---");
    rows.push("");
  });
  return rows.join("\n");
}

function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function refreshChannels(setChannels: (c: Channel[]) => void) {
  fetch(`${API}/channels`)
    .then((r) => r.json())
    .then((d) => d.data && setChannels(d.data))
    .catch(console.error);
}

function refreshWorkspaces(setWorkspaces: (w: Workspace[]) => void) {
  fetch(`${API}/workspaces`)
    .then((r) => r.json())
    .then((d) => d.data && setWorkspaces(d.data))
    .catch(console.error);
}

/** 引导动态表单：根据 schema 渲染并提交，成功后回调 */
function GuideFormBlock({
  msgId: _msgId,
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
        const msg = "请选择工作空间并填写项目名称";
        setError(msg);
        toast.error(msg);
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
          const errMsg = d.detail || d.message || "创建失败";
          setError(errMsg);
          toast.error(errMsg);
        })
        .catch(() => {
          setError("请求失败");
          toast.error("请求失败");
        });
    }
  };

  if (submitted) {
    return <p className="text-sm text-green-600 mt-2">已提交并创建项目。</p>;
  }

  return (
    <div className="mt-2 p-3 bg-[#F8F8F8] rounded-lg border border-gray-200 text-sm">
      {form.fields.map((f) => (
        <div key={f.name} className="mb-3">
          <label className="block text-gray-700 text-xs font-medium mb-1">{f.label}</label>
          {f.type === "select" ? (
            <select
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              className="border border-gray-300 rounded px-2 py-1.5 w-full text-sm focus:outline-none focus:border-[#1264A3]"
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
              className="border border-gray-300 rounded px-2 py-1.5 w-full text-sm focus:outline-none focus:border-[#1264A3]"
            />
          )}
        </div>
      ))}
      {error && <p className="text-red-500 text-xs mb-2">{error}</p>}
      <button
        type="button"
        onClick={handleSubmit}
        className="px-4 py-1.5 bg-[#007a5a] text-white rounded font-medium text-sm hover:bg-[#006a4d]"
      >
        提交
      </button>
    </div>
  );
}

function isClarifyReplyUserMessage(content: string): boolean {
  const t = (content || "").trim();
  return t.startsWith("@引导 澄清回答：") || t.includes("用户选择跳过澄清");
}

function ClarifyInlineBlock({
  msgId,
  schema,
  status,
  replyContent,
  onContinue,
  onSkip,
}: {
  msgId: string;
  schema: ClarifySchema;
  status: "form" | "waiting" | "answered";
  replyContent?: string;
  onContinue: (answers: ClarifyAnswers) => void;
  onSkip: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const allowSkip = (schema.skip_policy || "allow") === "allow";
  const canContinue = schema.questions.every((q) => {
    const selected = answers[q.id] || [];
    if (selected.length === 0) return false;
    if (selected.includes(OTHER_CHOICE_ID)) {
      return !!(otherText[q.id] || "").trim();
    }
    return true;
  });

  const toggleOption = (q: ClarifyQuestion, optionId: string) => {
    setAnswers((prev) => {
      const current = prev[q.id] || [];
      if (q.allow_multiple) {
        const next = current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId];
        return { ...prev, [q.id]: next };
      }
      return { ...prev, [q.id]: [optionId] };
    });
  };

  const toggleOther = (q: ClarifyQuestion) => toggleOption(q, OTHER_CHOICE_ID);

  if (status === "waiting") {
    return (
      <div className="my-2 rounded-lg border border-gray-200 bg-[#F8F8F8] p-3">
        <span className="text-xs text-gray-400 flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-gray-300 animate-pulse" />
          引导正在根据澄清回答…
        </span>
      </div>
    );
  }

  if (status === "answered") {
    const displayReply = replyContent?.replace(/^@引导\s*澄清回答[：:]\s*/i, "").trim() || "";
    return (
      <div className="my-2 rounded-lg border border-gray-200 bg-[#F8F8F8] overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="w-full px-3 py-2 text-left text-xs text-gray-500 hover:bg-gray-100 flex items-center gap-1.5"
        >
          <span className="inline-block transition-transform" style={{ transform: open ? "rotate(90deg)" : "none" }}>▶</span>
          <span className="font-medium">澄清</span>
          <span className="text-gray-400">{open ? "收起" : "展开"}</span>
        </button>
        {open && (
          <div className="px-3 pb-3 text-xs text-gray-600 border-t border-gray-200 space-y-2 pt-2">
            <p className="text-gray-500">已澄清并已收到引导回复</p>
            {displayReply && (
              <div className="rounded border border-gray-200 bg-white p-2">
                <p className="text-gray-400 mb-1">澄清回答</p>
                <pre className="whitespace-pre-wrap text-gray-700 font-sans text-xs">{displayReply}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg border border-[#1264A3]/30 bg-[#F8F8F8] overflow-hidden p-3">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-gray-800">{schema.title || "请先确认以下问题"}</h4>
      </div>
      <div className="space-y-2 max-h-[40vh] overflow-auto pr-1">
        {schema.questions.map((q, idx) => (
          <div key={q.id} className="rounded-lg border border-gray-200 bg-white p-3">
            <p className="text-sm mb-2 text-gray-700 font-medium">{idx + 1}. {q.prompt}</p>
            <div className="space-y-1.5">
              {q.options.map((opt) => {
                const checked = (answers[q.id] || []).includes(opt.id);
                return (
                  <label key={opt.id} className="flex items-center gap-2 text-sm cursor-pointer text-gray-700 hover:text-gray-900">
                    <input
                      type={q.allow_multiple ? "checkbox" : "radio"}
                      name={`${msgId}-${q.id}`}
                      checked={checked}
                      onChange={() => toggleOption(q, opt.id)}
                      className="accent-[#1264A3]"
                    />
                    <span>{opt.label}</span>
                  </label>
                );
              })}
              {q.other_enabled && (
                <div className="pt-1">
                  <label className="flex items-center gap-2 text-sm cursor-pointer text-gray-700 hover:text-gray-900">
                    <input
                      type={q.allow_multiple ? "checkbox" : "radio"}
                      name={`${msgId}-${q.id}`}
                      checked={(answers[q.id] || []).includes(OTHER_CHOICE_ID)}
                      onChange={() => toggleOther(q)}
                      className="accent-[#1264A3]"
                    />
                    <span>{q.other_label || "其他"}</span>
                  </label>
                  {(answers[q.id] || []).includes(OTHER_CHOICE_ID) && (
                    <input
                      type="text"
                      value={otherText[q.id] || ""}
                      onChange={(e) => setOtherText((prev) => ({ ...prev, [q.id]: e.target.value }))}
                      placeholder={q.other_placeholder || "请输入其他补充"}
                      className="mt-1.5 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:border-[#1264A3]"
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {allowSkip && (
          <button
            type="button"
            onClick={onSkip}
            className="px-4 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 text-sm font-medium"
          >
            跳过
          </button>
        )}
        <button
          type="button"
          disabled={!canContinue}
          onClick={() => onContinue({ selected: answers, other_text: otherText })}
          className="px-4 py-1.5 rounded bg-[#007a5a] text-white font-medium disabled:opacity-40 text-sm hover:bg-[#006a4d]"
        >
          继续
        </button>
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="p-2 rounded bg-amber-50 border-l-2 border-amber-400 text-sm text-gray-600 animate-pulse">
      正在思考...
    </div>
  );
}

export default function App() {
  // 用户认证状态
  type CurrentUser = { user_id: string; username: string; display_name: string; role: string } | null;

  // 从 localStorage 恢复登录状态
  const getStoredUser = (): CurrentUser => {
    try {
      const stored = localStorage.getItem("currentUser");
      if (!stored) return null;
      const data = JSON.parse(stored);
      // 检查是否在1小时内
      if (data.loginTime && Date.now() - data.loginTime < 3600000) {
        return data.user;
      }
    } catch {}
    return null;
  };

  const [currentUser, setCurrentUser] = useState<CurrentUser>(getStoredUser);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [registerMode, setRegisterMode] = useState(false);

  // 当前用户ID（用于API调用）
  const currentUserId = currentUser?.user_id || DEV_USER_ID;

  // 初始化时检查登录状态
  useEffect(() => {
    if (!currentUser) {
      setLoginModalOpen(true);
    }
  }, []);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextData, setContextData] = useState<ContextData>({});
  const [pendingFileIds, setPendingFileIds] = useState<string[]>([]);
  const [pendingFileNames, setPendingFileNames] = useState<string[]>([]);
  const [selectedQaIds, setSelectedQaIds] = useState<Record<string, boolean>>({});
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryPreview, setSummaryPreview] = useState("");
  const [qaLlmReady, setQaLlmReady] = useState(false);
  const [qaLlmHint, setQaLlmHint] = useState("正在检查 LLM 配置...");
  const [pendingClarifyReplyMsgId, setPendingClarifyReplyMsgId] = useState<string | null>(null);

  type ChannelBot = { member_id: string; username: string; avatar_url?: string; display_name?: string };
  type ChannelUser = { member_id: string; username: string; avatar_url?: string; display_name?: string };
  type BotItem = { bot_id: string; username: string; display_name?: string; intro?: string; avatar_url?: string };
  const [channelBots, setChannelBots] = useState<ChannelBot[]>([]);
  const [channelUsers, setChannelUsers] = useState<ChannelUser[]>([]);
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionDropdownPlacement, setMentionDropdownPlacement] = useState<"top" | "bottom">("bottom");
  const [addBotOpen, setAddBotOpen] = useState(false);
  const [createWsOpen, setCreateWsOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [allBots, setAllBots] = useState<BotItem[]>([]);
  const [selectedBotIds, setSelectedBotIds] = useState<Set<string>>(new Set());
  const [addingBots, setAddingBots] = useState(false);
  const [manageMembersOpen, setManageMembersOpen] = useState(false);
  type MemberOption = { id: string; type: "bot" | "user"; label: string };
  const [memberAddOptions, setMemberAddOptions] = useState<MemberOption[]>([]);
  const [memberAddSelected, setMemberAddSelected] = useState<Set<string>>(new Set());
  const [memberRemoveSelected, setMemberRemoveSelected] = useState<Set<string>>(new Set());
  const [addingMembersModal, setAddingMembersModal] = useState(false);
  const [removingMembersModal, setRemovingMembersModal] = useState(false);
  const [_expandedOlderIds, _setExpandedOlderIds] = useState<Set<string>>(new Set());
  const [, setHasMore] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const [waitingForBotReply, setWaitingForBotReply] = useState(false);
  const [processingBots, setProcessingBots] = useState<Record<string, string>>({});

  // 登录/注册处理函数
  const handleLogin = async (username: string, password: string) => {
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "登录失败");
      const user = { user_id: data.user_id, username: data.username, display_name: data.display_name || data.username, role: data.role };
      setCurrentUser(user);
      // 保存到 localStorage（1小时有效）
      localStorage.setItem("currentUser", JSON.stringify({ user, loginTime: Date.now() }));
      setLoginModalOpen(false);
    } catch (e: any) {
      setLoginError(e.message);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleRegister = async (username: string, password: string, displayName: string) => {
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${API}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, display_name: displayName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "注册失败");
      const user = { user_id: data.user_id, username: data.username, display_name: data.display_name || data.username, role: data.role };
      setCurrentUser(user);
      localStorage.setItem("currentUser", JSON.stringify({ user, loginTime: Date.now() }));
      setLoginModalOpen(false);
    } catch (e: any) {
      setLoginError(e.message);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    setCurrentUser(null);
    localStorage.removeItem("currentUser");
    setLoginModalOpen(true);
  };

  // 创建工作空间
  const handleCreateWorkspace = () => {
    if (!newWorkspaceName.trim()) {
      toast.error("请填写工作空间名称");
      return;
    }
    fetch(`${API}/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newWorkspaceName.trim() }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("工作空间创建成功");
          setNewWorkspaceName("");
          setCreateWsOpen(false);
          refreshWorkspaces(setWorkspaces);
          setSelectedWorkspaceId(d.data.workspace_id);
        } else {
          toast.error(d.detail || "创建失败");
        }
      })
      .catch(() => toast.error("创建失败"));
  };

  // 创建频道（项目）
  const handleCreateChannel = () => {
    if (!newChannelName.trim()) {
      toast.error("请填写频道名称");
      return;
    }
    if (!selectedWorkspaceId) {
      toast.error("请先选择工作空间");
      return;
    }
    fetch(`${API}/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: selectedWorkspaceId,
        name: newChannelName.trim(),
        type: "public",
        purpose: "",
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("频道创建成功");
          setNewChannelName("");
          setCreateChannelOpen(false);
          refreshChannels(setChannels);
          setSelectedId(d.data.channel_id);
        } else {
          toast.error(d.detail || "创建失败");
        }
      })
      .catch(() => toast.error("创建失败"));
  };

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
    // 加载工作空间列表
    fetch(`${API}/workspaces`)
      .then((r) => r.json())
      .then((d) => d.data && setWorkspaces(d.data))
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      setChannelBots([]);
      setSelectedQaIds({});
      setSummaryPreview("");
      setWaitingForBotReply(false);
      setProcessingBots({});
      return;
    }
    setLoading(true);
    fetch(`${API}/channels/${selectedId}/members?with_username=1`)
      .then((r) => r.json())
      .then((d) => {
        if (d.data) {
          const bots: ChannelBot[] = d.data
            .filter((m: { member_type: string; username?: string }) => m.member_type === "bot" && m.username)
            .map((m: { member_id: string; username: string; avatar_url?: string; display_name?: string }) => ({ member_id: m.member_id, username: m.username, avatar_url: m.avatar_url, display_name: m.display_name }));
          setChannelBots(bots);
          const users: ChannelUser[] = d.data
            .filter((m: { member_type: string; username?: string }) => m.member_type === "user" && m.username)
            .map((m: { member_id: string; username: string; avatar_url?: string; display_name?: string }) => ({ member_id: m.member_id, username: m.username, avatar_url: m.avatar_url, display_name: m.display_name }));
          setChannelUsers(users);
        } else { setChannelBots([]); setChannelUsers([]); }
      })
      .catch(() => {
        setChannelBots([]);
      });
    fetch(`${API}/channels/${selectedId}/messages`)
      .then((r) => r.json())
      .then((d) => {
        const data = d.data || [];
        setMessages(data);
        setHasMore(data.length >= 30);
      })
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
      setSelectedBotIds(new Set());
    }
  }, [addBotOpen]);

  useEffect(() => {
    if (!manageMembersOpen || !selectedId) return;
    setMemberAddSelected(new Set());
    setMemberRemoveSelected(new Set());
    const wsId = selectedChannel?.workspace_id;
    Promise.all([
      fetch(`${API}/channels/${selectedId}/members?with_username=1`).then((r) => r.json()),
      fetch(`${API}/bots`).then((r) => r.json()),
      wsId ? fetch(`${API}/workspaces/${wsId}/members`).then((r) => r.json()) : Promise.resolve({ data: [] }),
    ]).then(([membersRes, botsRes, usersRes]) => {
      const inChannel = new Set<string>((membersRes.data || []).map((m: { member_id: string }) => m.member_id));
      const opts: MemberOption[] = [];
      for (const b of (botsRes.data || [])) {
        if (!inChannel.has(b.bot_id)) opts.push({ id: b.bot_id, type: "bot", label: `[Bot] @${b.username}${b.display_name ? " · " + b.display_name : ""}` });
      }
      for (const u of (usersRes.data || [])) {
        if (!inChannel.has(u.user_id)) opts.push({ id: u.user_id, type: "user", label: `[用户] @${u.username}${u.display_name ? " · " + u.display_name : ""}` });
      }
      setMemberAddOptions(opts);
    }).catch(() => setMemberAddOptions([]));
  }, [manageMembersOpen, selectedId]);

  useEffect(() => {
    if (showMentionDropdown && selectedId) {
      fetch(`${API}/bots`).then((r) => r.json()).then((d) => setAllBots(d.data || [])).catch(() => setAllBots([]));
      fetch(`${API}/channels/${selectedId}/members?with_username=1`)
        .then((r) => r.json())
        .then((d) => {
          if (!d.data) return;
          setChannelBots(
            d.data
              .filter((m: { member_type: string; username?: string }) => m.member_type === "bot" && m.username)
              .map((m: { member_id: string; username: string; avatar_url?: string; display_name?: string }) => ({ member_id: m.member_id, username: m.username, avatar_url: m.avatar_url, display_name: m.display_name }))
          );
          setChannelUsers(
            d.data
              .filter((m: { member_type: string; username?: string }) => m.member_type === "user" && m.username)
              .map((m: { member_id: string; username: string; avatar_url?: string; display_name?: string }) => ({ member_id: m.member_id, username: m.username, avatar_url: m.avatar_url, display_name: m.display_name }))
          );
        })
        .catch(console.error);
    }
  }, [showMentionDropdown, selectedId]);

  useEffect(() => {
    if (pendingClarifyReplyMsgId && messages.length > 0 && messages[messages.length - 1].sender_type === "bot") {
      setPendingClarifyReplyMsgId(null);
    }
  }, [pendingClarifyReplyMsgId, messages]);

  useEffect(() => {
    setPendingClarifyReplyMsgId(null);
  }, [selectedId]);

  const addBotToChannel = (botId: string): Promise<void> => {
    if (!selectedId) return Promise.resolve();
    return fetch(`${API}/channels/${selectedId}/members`, {
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
                  .map((m: { member_id: string; username: string; avatar_url?: string; display_name?: string }) => ({ member_id: m.member_id, username: m.username, avatar_url: m.avatar_url, display_name: m.display_name }));
                setChannelBots(bots);
                const users: ChannelUser[] = res.data
                  .filter((m: { member_type: string; username?: string }) => m.member_type === "user" && m.username)
                  .map((m: { member_id: string; username: string; avatar_url?: string; display_name?: string }) => ({ member_id: m.member_id, username: m.username, avatar_url: m.avatar_url, display_name: m.display_name }));
                setChannelUsers(users);
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

  useEffect(() => {
    if (pendingClarifyReplyMsgId && messages.length > 0 && messages[messages.length - 1].sender_type === "bot") {
      setPendingClarifyReplyMsgId(null);
    }
  }, [pendingClarifyReplyMsgId, messages]);

  useEffect(() => {
    setPendingClarifyReplyMsgId(null);
  }, [selectedId]);

  const sendUserMessage = async (content: string) => {
    if (!selectedId || !content.trim()) return;
    const body = {
      content: content.trim(),
      sender_id: currentUserId,
      sender_type: "user",
      file_ids: [] as string[],
    };
    const res = await fetch(`${API}/channels/${selectedId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    setMessages((prev) => {
      let next = prev;
      if (d.data && !prev.some((m) => m.msg_id === d.data.msg_id)) {
        next = [...next, d.data];
      }
      const botMsgs: Message[] = d.bot_messages || [];
      for (const bm of botMsgs) {
        if (bm && bm.msg_id && !next.some((m) => m.msg_id === bm.msg_id)) {
          next = [...next, bm];
        }
      }
      return next;
    });
  };

  const send = () => {
    if (!selectedId || !input.trim()) return;
    const body = {
      content: input.trim(),
      sender_id: currentUserId,
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
          let next = prev;
          if (d.data && !prev.some((m) => m.msg_id === d.data.msg_id)) {
            next = [...next, d.data];
          }
          const botMsgs: Message[] = d.bot_messages || [];
          for (const bm of botMsgs) {
            if (bm && bm.msg_id && !next.some((m) => m.msg_id === bm.msg_id)) {
              next = [...next, bm];
            }
          }
          return next;
        });
        setInput("");
        setPendingFileIds([]);
        setPendingFileNames([]);
      })
      .catch(console.error);
  };

  const handleClarifyContinue = (msgId: string, schema: ClarifySchema, answers: ClarifyAnswers) => {
    const lines = ["@引导 澄清回答："];
    for (const q of schema.questions) {
      const picked = new Set(answers.selected[q.id] || []);
      const labels = q.options.filter((o) => picked.has(o.id)).map((o) => o.label);
      if (picked.has(OTHER_CHOICE_ID)) {
        const other = (answers.other_text[q.id] || "").trim();
        if (other) labels.push(`其他：${other}`);
      }
      lines.push(`- ${q.prompt}：${labels.length > 0 ? labels.join("、") : "未选择"}`);
    }
    setPendingClarifyReplyMsgId(msgId);
    sendUserMessage(lines.join("\n")).catch(() => {
      setPendingClarifyReplyMsgId(null);
      toast.error("提交失败，请重试");
    });
  };

  const handleClarifySkip = (msgId: string) => {
    setPendingClarifyReplyMsgId(msgId);
    sendUserMessage("@引导 用户选择跳过澄清，请在当前信息下继续回答。").catch(() => {
      setPendingClarifyReplyMsgId(null);
      toast.error("提交失败，请重试");
    });
  };

  const uploadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedId) return;
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    const allowed = [".txt", ".md", ".docx", ".pdf", ".xlsx", ".png", ".jpg", ".jpeg", ".webp"];
    if (!allowed.includes(ext)) {
      toast.error("支持格式: " + allowed.join(", "));
      return;
    }
    fetch(
      `${API}/files/upload?channel_id=${encodeURIComponent(selectedId)}&uploader_id=${encodeURIComponent(currentUserId)}&filename=${encodeURIComponent(file.name)}`,
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

  const selectedChannel = channels.find((c) => c.channel_id === selectedId) || null;
  const blocks = buildLogicalQaBlocks(messages);
  const blockPairsForExport: QaPair[] = blocks.map((b) => {
    const lastBot = [...b.messages].reverse().find((m) => m.sender_type === "bot");
    const answer: Message = lastBot || {
      msg_id: `${b.question.msg_id}-no-reply`,
      sender_id: "",
      sender_type: "bot",
      content: "(无回复)",
      created_at: b.question.created_at,
    };
    return { question: b.question, answer };
  });
  const selectedPairs = blockPairsForExport.filter((p) => selectedQaIds[p.question.msg_id]);

  // 便于按问题 msg_id 定位对应回答和跳过回答气泡
  const qaPairByQuestionId = new Map(blockPairsForExport.map((p) => [p.question.msg_id, p]));
  const qaAnswerIds = new Set(blockPairsForExport.map((p) => p.answer.msg_id));

  // 按“问题卡片”折叠/展开回答：key 为 question.msg_id
  const [expandedQuestionIds, setExpandedQuestionIds] = useState<Record<string, boolean>>({});

  const toggleQa = (msgId: string) => {
    setSelectedQaIds((prev) => ({ ...prev, [msgId]: !prev[msgId] }));
  };

  const clearQaSelection = () => setSelectedQaIds({});

  const exportMdFilename = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ch = (selectedChannel?.name || "channel").replace(/\s+/g, "_");
    return `qa-export-${ch}-${stamp}.md`;
  };

  const downloadQaMarkdown = () => {
    if (selectedPairs.length === 0) {
      toast.error("请先勾选至少一组问答");
      return;
    }
    const md = buildQaMarkdown(selectedChannel?.name || "频道", selectedPairs);
    downloadText(exportMdFilename(), md);
  };

  const summaryMdFilename = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ch = (selectedChannel?.name || "channel").replace(/\s+/g, "_");
    return `qa-summary-${ch}-${stamp}.md`;
  };

  const refreshQaLlmStatus = async () => {
    try {
      const llmRes = await fetch(`${API}/admin/settings/llm`);
      const llmData = await llmRes.json();
      if (!llmRes.ok) {
        setQaLlmReady(false);
        setQaLlmHint("无法读取 LLM 配置，请稍后重试。");
        return false;
      }
      const bindings = llmData?.data?.bindings || {};
      const providers = llmData?.data?.providers || [];
      const pickedId = bindings.qa_summarize || bindings.system_llm;
      const picked = providers.find((p: { id: string; base_url?: string }) => p.id === pickedId);
      if (!picked || !String(picked.base_url || "").trim()) {
        setQaLlmReady(false);
        setQaLlmHint("未配置问答总结 LLM，请到「管理」页绑定问答总结或系统 LLM。");
        return false;
      }
      setQaLlmReady(true);
      setQaLlmHint("LLM 已配置，可生成总结。");
      return true;
    } catch {
      setQaLlmReady(false);
      setQaLlmHint("检查 LLM 配置失败，请稍后重试。");
      return false;
    }
  };

  // 每次进入频道或问答列表变化时：默认展开最新 5 条问答（按问题卡片），其余问答折叠
  useEffect(() => {
    if (!selectedId || blockPairsForExport.length === 0) {
      setExpandedQuestionIds({});
      return;
    }
    const latest = blockPairsForExport.slice(-5);
    const next: Record<string, boolean> = {};
    latest.forEach((p) => {
      next[p.question.msg_id] = true;
    });
    setExpandedQuestionIds(next);
  }, [selectedId, blockPairsForExport.length]);

  // 进入频道或收到新消息时，聊天区域滚动到最新消息
  useEffect(() => {
    if (!messagesContainerRef.current) return;
    messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
  }, [selectedId, messages.length]);

  const generateQaSummary = async () => {
    if (selectedPairs.length === 0) {
      toast.error("请先勾选至少一组问答");
      return;
    }
    setSummaryBusy(true);
    try {
      const ok = await refreshQaLlmStatus();
      if (!ok) {
        toast.error("请先在管理页配置并绑定可用 LLM（问答总结或系统 LLM）。");
        return;
      }

      const pairs = selectedPairs.map((p) => ({
        question: stripThinkTags(parseGuidePayload(p.question.content).text || p.question.content),
        answer: stripThinkTags(parseGuidePayload(p.answer.content).text || p.answer.content),
        question_time: formatTs(p.question.created_at),
        answer_time: formatTs(p.answer.created_at),
      }));
      const res = await fetch(`${API}/admin/qa/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_name: selectedChannel?.name || "频道",
          pairs,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.detail || data?.message || `总结失败 (${res.status})`);
      }
      const md = data?.data?.summary_markdown || "";
      if (!md.trim()) {
        throw new Error("未获得总结结果");
      }
      setSummaryPreview(md);
    } catch (e) {
      toast.error((e as Error).message || "生成总结失败");
    } finally {
      setSummaryBusy(false);
    }
  };

  useEffect(() => {
    if (!selectedId) return;
    refreshQaLlmStatus();
  }, [selectedId]);

  const downloadSummaryMarkdown = () => {
    if (!summaryPreview.trim()) {
      toast.error("请先生成总结");
      return;
    }
    downloadText(summaryMdFilename(), summaryPreview);
  };

  return (
    <>
      {loginModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setLoginModalOpen(false)}>
          <div className="bg-white rounded-xl p-8 w-96 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-center mb-6">
              <div className="w-12 h-12 rounded-lg bg-[#4A154B] flex items-center justify-center mx-auto mb-3">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" className="w-7 h-7">
                  <path d="M4.5 6.375a4.125 4.125 0 118.25 0 4.125 4.125 0 01-8.25 0zM14.25 8.625a3.375 3.375 0 116.75 0 3.375 3.375 0 01-6.75 0zM1.5 19.125a7.125 7.125 0 0114.25 0v.003l-.001.119a.75.75 0 01-.363.63 13.067 13.067 0 01-6.761 1.873c-2.472 0-4.786-.684-6.76-1.873a.75.75 0 01-.364-.63l-.001-.122zM17.25 19.128l-.001.144a2.25 2.25 0 01-.233.96 10.088 10.088 0 005.06-1.01.75.75 0 00.42-.643 4.875 4.875 0 00-6.957-4.611 8.586 8.586 0 011.71 5.157v.003z" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-gray-900">{registerMode ? "创建账号" : "登录到智枢"}</h2>
              <p className="text-gray-500 text-sm mt-1">{registerMode ? "填写信息以创建新账号" : "欢迎回来！"}</p>
            </div>
            {loginError && <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 p-3 rounded-lg">{loginError}</div>}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const username = fd.get("username") as string;
                const password = fd.get("password") as string;
                if (registerMode) {
                  const displayName = fd.get("display_name") as string;
                  handleRegister(username, password, displayName);
                } else {
                  handleLogin(username, password);
                }
              }}
            >
              {registerMode && (
                <input name="display_name" placeholder="显示名称" required className="w-full mb-3 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]" />
              )}
              <input name="username" placeholder="用户名" required className="w-full mb-3 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]" />
              <input name="password" type="password" placeholder="密码" required className="w-full mb-4 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]" />
              <button type="submit" disabled={loginLoading} className="w-full bg-[#4A154B] text-white py-2.5 rounded-lg font-semibold hover:bg-[#3d1040] disabled:opacity-50 text-sm">
                {loginLoading ? "处理中..." : registerMode ? "注册" : "登录"}
              </button>
            </form>
            <div className="mt-4 text-center text-sm text-gray-500">
              {registerMode ? (
                <>
                  已有账号？{" "}
                  <button onClick={() => setRegisterMode(false)} className="text-[#1264A3] font-medium hover:underline">登录</button>
                </>
              ) : (
                <>
                  没有账号？{" "}
                  <button onClick={() => setRegisterMode(true)} className="text-[#1264A3] font-medium hover:underline">注册</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

    <div className="flex h-screen bg-white">
      {/* Slack-style dark purple sidebar */}
      <aside className="w-64 bg-[#3F0E40] flex flex-col flex-shrink-0">
        {/* Workspace header */}
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-white font-bold text-lg truncate">智枢协作</span>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-white/60 flex-shrink-0">
              <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="flex-shrink-0">
            {currentUser ? (
              <button
                onClick={handleLogout}
                className="w-7 h-7 rounded-full bg-[#D0B3D3] text-[#3F0E40] text-xs font-bold flex items-center justify-center hover:bg-white transition-colors"
                title={`${currentUser.display_name} · 退出`}
              >
                {currentUser.display_name.slice(0, 1).toUpperCase()}
              </button>
            ) : (
              <button onClick={() => setLoginModalOpen(true)} className="text-xs text-white/70 hover:text-white px-2 py-1">登录</button>
            )}
          </div>
        </div>

        {/* User status bar */}
        {currentUser && (
          <div className="px-4 py-2 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
            <span className="text-[#C9BDD0] text-sm truncate">{currentUser.display_name}</span>
          </div>
        )}

        {/* Workspace selector */}
        <div className="px-3 py-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[#C9BDD0] text-xs font-semibold uppercase tracking-wider">工作空间</span>
            <div className="flex items-center gap-1">
              {selectedWorkspaceId && (
                <button
                  type="button"
                  onClick={() => {
                    if (confirm("确定删除该工作空间？删除后其下的频道也将被删除。")) {
                      fetch(`${API}/workspaces/${selectedWorkspaceId}`, { method: "DELETE" })
                        .then((r) => r.json())
                        .then((d) => {
                          if (d.status === "success") {
                            toast.success("工作空间已删除");
                            setSelectedWorkspaceId("");
                            refreshWorkspaces(setWorkspaces);
                            refreshChannels(setChannels);
                          } else {
                            toast.error(d.detail || "删除失败");
                          }
                        })
                        .catch(() => toast.error("请求失败"));
                    }
                  }}
                  className="text-white/60 hover:text-red-400 text-xs p-1 rounded hover:bg-white/10"
                  title="删除工作空间"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clipRule="evenodd" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                onClick={() => setCreateWsOpen(true)}
                className="text-white/60 hover:text-white text-xs p-1 rounded hover:bg-white/10"
                title="创建工作空间"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
                </svg>
              </button>
            </div>
          </div>
          <select
            value={selectedWorkspaceId}
            onChange={(e) => setSelectedWorkspaceId(e.target.value)}
            className="w-full bg-white/10 text-white text-sm rounded px-2 py-1.5 border border-white/20 focus:outline-none focus:border-white/40"
          >
            <option value="" className="text-gray-900">全部工作空间</option>
            {workspaces.map((w) => (
              <option key={w.workspace_id} value={w.workspace_id} className="text-gray-900">
                {w.name}
              </option>
            ))}
          </select>
        </div>

        {/* Channels section */}
        <div className="px-3 pt-3 pb-1 flex items-center justify-between">
          <span className="text-[#C9BDD0] text-xs font-semibold uppercase tracking-wider">频道</span>
          <button
            type="button"
            onClick={() => {
              if (!selectedWorkspaceId) {
                toast.error("请先选择工作空间");
                return;
              }
              setCreateChannelOpen(true);
            }}
            className="text-white/60 hover:text-white text-xs p-1 rounded hover:bg-white/10"
            title="创建频道"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
            </svg>
          </button>
        </div>
        <ul className="overflow-auto flex-1 px-2">
          {channels
            .filter((c) => !selectedWorkspaceId || c.workspace_id === selectedWorkspaceId)
            .map((c) => (
              <li key={c.channel_id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.channel_id)}
                  className={`w-full text-left px-2 py-1 rounded text-sm flex items-center gap-1.5 transition-colors ${
                    selectedId === c.channel_id
                      ? "bg-[#1264A3] text-white font-medium"
                      : "text-[#C9BDD0] hover:bg-white/10 hover:text-white"
                  }`}
                >
                  <span className="text-current opacity-70">#</span>
                  <span className="truncate">{c.name}</span>
                </button>
              </li>
            ))}
        </ul>

        {/* Bottom nav */}
        <div className="px-2 py-2 border-t border-white/10 space-y-0.5">
          <Link
            to="/admin"
            className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[#C9BDD0] hover:bg-white/10 hover:text-white text-sm transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" />
            </svg>
            <span>管理</span>
          </Link>
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[#C9BDD0] hover:bg-white/10 hover:text-white text-sm transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
            </svg>
            <span>帮助</span>
          </button>
        </div>
      </aside>

      {helpOpen && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/40"
          onClick={() => setHelpOpen(false)}
          aria-modal="true"
          role="dialog"
        >
          <div
            className="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 p-6 text-left max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-gray-900">使用帮助</h2>
              <button type="button" onClick={() => setHelpOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl leading-none" aria-label="关闭">
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
              <li>API 文档：管理页内「打开 API 文档」或 <a href={API_DOCS_URL} target="_blank" rel="noreferrer" className="text-[#1264A3] underline">/docs</a></li>
            </ul>
            <p className="text-gray-500 text-xs">完整说明见项目文档。</p>
            <div className="mt-5 flex justify-end">
              <button type="button" onClick={() => setHelpOpen(false)} className="px-4 py-2 bg-[#F8F8F8] text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium">
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 创建工作空间 Modal */}
      {createWsOpen && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/40"
          onClick={() => setCreateWsOpen(false)}
          aria-modal="true"
          role="dialog"
        >
          <div
            className="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 p-6 text-left"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-gray-900">创建工作空间</h2>
              <button
                type="button"
                onClick={() => setCreateWsOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">名称</label>
                <input
                  type="text"
                  value={newWorkspaceName}
                  onChange={(e) => setNewWorkspaceName(e.target.value)}
                  placeholder="输入工作空间名称"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
                  onKeyDown={(e) => e.key === "Enter" && handleCreateWorkspace()}
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCreateWsOpen(false)}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleCreateWorkspace}
                  className="px-4 py-2 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]"
                >
                  创建
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 创建频道 Modal */}
      {createChannelOpen && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/40"
          onClick={() => setCreateChannelOpen(false)}
          aria-modal="true"
          role="dialog"
        >
          <div
            className="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 p-6 text-left"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-gray-900">创建频道</h2>
              <button
                type="button"
                onClick={() => setCreateChannelOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">工作空间</label>
                <select
                  value={selectedWorkspaceId}
                  onChange={(e) => setSelectedWorkspaceId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
                >
                  <option value="">选择工作空间</option>
                  {workspaces.map((w) => (
                    <option key={w.workspace_id} value={w.workspace_id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">频道名称</label>
                <input
                  type="text"
                  value={newChannelName}
                  onChange={(e) => setNewChannelName(e.target.value)}
                  placeholder="输入频道名称"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
                  onKeyDown={(e) => e.key === "Enter" && handleCreateChannel()}
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCreateChannelOpen(false)}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleCreateChannel}
                  className="px-4 py-2 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]"
                >
                  创建
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {addBotOpen && selectedId && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40" onClick={() => setAddBotOpen(false)} aria-modal="true" role="dialog">
          <div className="bg-white rounded-xl shadow-2xl max-w-xl w-full mx-4 p-6 text-left max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-gray-900">管理频道 Bot</h2>
              <button type="button" onClick={() => setAddBotOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl" aria-label="关闭">×</button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">已加入的 Bot</h3>
                {channelBots.length === 0 ? (
                  <p className="text-sm text-gray-400">暂无</p>
                ) : (
                  <ul className="space-y-1">
                    {channelBots.map((b) => (
                      <li key={b.member_id} className="flex items-center justify-between py-2 px-3 bg-[#F8F8F8] rounded-lg text-sm">
                        <span className="font-medium text-gray-800">@{b.username}</span>
                        <button type="button" onClick={() => removeBotFromChannel(b.member_id)} className="text-red-500 text-xs hover:text-red-700">移除</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">可添加的 Bot</h3>
                {(() => {
                  const inChannelIds = new Set(channelBots.map((c) => c.member_id));
                  const available = allBots.filter((b) => !inChannelIds.has(b.bot_id));
                  if (available.length === 0) return <p className="text-sm text-gray-400">暂无或已全部加入</p>;
                  return (
                    <ul className="space-y-1">
                      {available.map((b) => {
                        const checked = selectedBotIds.has(b.bot_id);
                        return (
                          <li
                            key={b.bot_id}
                            className={`flex items-start gap-2 py-2 px-3 rounded-lg text-sm cursor-pointer transition-colors select-none ${checked ? "bg-blue-50 border border-[#1264A3]/30" : "bg-[#F8F8F8] hover:bg-gray-100"}`}
                            onClick={() => setSelectedBotIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(b.bot_id)) next.delete(b.bot_id); else next.add(b.bot_id);
                              return next;
                            })}
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5 accent-[#1264A3] shrink-0"
                              checked={checked}
                              onChange={() => {}}
                              onClick={(e) => e.stopPropagation()}
                            />
                            <div className="flex flex-col min-w-0">
                              <span className="font-medium text-gray-800">@{b.username}</span>
                              {introSummary(b.intro) && <span className="text-xs text-gray-500 truncate" title={b.intro}>{introSummary(b.intro)}</span>}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  );
                })()}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setAddBotOpen(false)} className="px-4 py-2 bg-[#F8F8F8] text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium">关闭</button>
              {selectedBotIds.size > 0 && (
                <button
                  type="button"
                  disabled={addingBots}
                  onClick={async () => {
                    setAddingBots(true);
                    try {
                      await Promise.all([...selectedBotIds].map((id) => addBotToChannel(id)));
                      setSelectedBotIds(new Set());
                    } finally {
                      setAddingBots(false);
                    }
                  }}
                  className="px-4 py-2 bg-[#1264A3] text-white rounded-lg hover:bg-[#0f5a94] text-sm font-medium disabled:opacity-60"
                >
                  {addingBots ? "添加中…" : `添加选中 (${selectedBotIds.size})`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {contextOpen && selectedId && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40" onClick={() => setContextOpen(false)} aria-modal="true" role="dialog">
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full mx-4 p-6 text-left max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-gray-900">频道上下文</h2>
              <button type="button" onClick={() => setContextOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl" aria-label="关闭">
                ×
              </button>
            </div>
            {LAYERS.map((layer) => (
              <div key={layer} className="mb-4">
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{layer}</label>
                <textarea
                  value={contextData[layer.toLowerCase()] ?? ""}
                  onChange={(e) => setContextData((prev) => ({ ...prev, [layer.toLowerCase()]: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg p-2.5 text-sm h-24 focus:outline-none focus:border-[#1264A3]"
                />
                <button
                  type="button"
                  onClick={() => saveContextLayer(layer, contextData[layer.toLowerCase()] ?? "")}
                  className="mt-1.5 px-3 py-1 bg-[#F8F8F8] text-gray-700 rounded-lg text-xs font-medium hover:bg-gray-200"
                >
                  保存
                </button>
              </div>
            ))}
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={() => setContextOpen(false)} className="px-4 py-2 bg-[#F8F8F8] text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium">
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {manageMembersOpen && selectedId && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40" onClick={() => setManageMembersOpen(false)} aria-modal="true" role="dialog">
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full mx-4 p-6 text-left max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-lg font-bold text-gray-900">管理成员 — #{selectedChannel?.name}</h2>
              <button type="button" onClick={() => setManageMembersOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl" aria-label="关闭">×</button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              {/* 添加成员 */}
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">添加成员</h3>
                {memberAddOptions.length === 0 ? (
                  <p className="text-sm text-gray-400">暂无可添加的成员</p>
                ) : (
                  <ul className="space-y-1 max-h-64 overflow-auto">
                    {memberAddOptions.map((opt) => {
                      const checked = memberAddSelected.has(opt.id);
                      return (
                        <li
                          key={opt.id}
                          className={`flex items-center gap-2 py-2 px-3 rounded-lg text-sm cursor-pointer select-none ${checked ? "bg-[#1264A3]/10 border border-[#1264A3]/30" : "bg-[#F8F8F8] hover:bg-gray-100"}`}
                          onClick={() => setMemberAddSelected((prev) => {
                            const next = new Set(prev);
                            next.has(opt.id) ? next.delete(opt.id) : next.add(opt.id);
                            return next;
                          })}
                        >
                          <input type="checkbox" readOnly checked={checked} className="flex-shrink-0" />
                          <span className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${opt.type === "bot" ? "bg-green-100 text-green-700" : "bg-blue-50 text-blue-700"}`}>{opt.type === "bot" ? "Bot" : "用户"}</span>
                          <span className="truncate text-gray-800">{opt.label.replace(/^\[Bot\] |^\[用户\] /, "")}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {memberAddSelected.size > 0 && (
                  <button
                    type="button"
                    disabled={addingMembersModal}
                    onClick={async () => {
                      setAddingMembersModal(true);
                      try {
                        const items = memberAddOptions.filter((o) => memberAddSelected.has(o.id));
                        await Promise.all(items.map((item) =>
                          fetch(`${API}/channels/${selectedId}/members`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ member_id: item.id, member_type: item.type }) }).then((r) => r.json())
                        ));
                        toast.success(`已添加 ${items.length} 个成员`);
                        // 刷新成员列表
                        const res = await fetch(`${API}/channels/${selectedId}/members?with_username=1`).then((r) => r.json());
                        const inChannel = new Set<string>((res.data || []).map((m: { member_id: string }) => m.member_id));
                        setMemberAddOptions((prev) => prev.filter((o) => !inChannel.has(o.id)));
                        setMemberAddSelected(new Set());
                        setChannelBots((res.data || []).filter((m: { member_type: string; username?: string }) => m.member_type === "bot" && m.username).map((m: { member_id: string; username: string; avatar_url?: string; display_name?: string }) => ({ member_id: m.member_id, username: m.username, avatar_url: m.avatar_url, display_name: m.display_name })));
                        setChannelUsers((res.data || []).filter((m: { member_type: string; username?: string }) => m.member_type === "user" && m.username).map((m: { member_id: string; username: string; avatar_url?: string; display_name?: string }) => ({ member_id: m.member_id, username: m.username, avatar_url: m.avatar_url, display_name: m.display_name })));
                      } catch {
                        toast.error("添加失败");
                      } finally {
                        setAddingMembersModal(false);
                      }
                    }}
                    className="mt-3 px-4 py-1.5 bg-[#1264A3] text-white rounded-lg text-sm font-medium hover:bg-[#0d5296] disabled:opacity-50"
                  >
                    {addingMembersModal ? "添加中…" : `添加选中 (${memberAddSelected.size})`}
                  </button>
                )}
              </div>

              {/* 移除成员 */}
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">当前成员</h3>
                {channelBots.length === 0 && channelUsers.length === 0 ? (
                  <p className="text-sm text-gray-400">该频道暂无成员</p>
                ) : (
                  <ul className="space-y-1 max-h-64 overflow-auto">
                    {[
                      ...channelBots.map((b) => ({ id: b.member_id, type: "bot" as const, label: `@${b.username}${b.display_name ? " · " + b.display_name : ""}` })),
                      ...channelUsers.map((u) => ({ id: u.member_id, type: "user" as const, label: `@${u.username}${u.display_name ? " · " + u.display_name : ""}` })),
                    ].map((m) => {
                      const checked = memberRemoveSelected.has(m.id);
                      return (
                        <li
                          key={m.id}
                          className={`flex items-center gap-2 py-2 px-3 rounded-lg text-sm cursor-pointer select-none ${checked ? "bg-red-50 border border-red-200" : "bg-[#F8F8F8] hover:bg-gray-100"}`}
                          onClick={() => setMemberRemoveSelected((prev) => {
                            const next = new Set(prev);
                            next.has(m.id) ? next.delete(m.id) : next.add(m.id);
                            return next;
                          })}
                        >
                          <input type="checkbox" readOnly checked={checked} className="flex-shrink-0" />
                          <span className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${m.type === "bot" ? "bg-green-100 text-green-700" : "bg-blue-50 text-blue-700"}`}>{m.type === "bot" ? "Bot" : "用户"}</span>
                          <span className="truncate text-gray-800">{m.label}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {memberRemoveSelected.size > 0 && (
                  <button
                    type="button"
                    disabled={removingMembersModal}
                    onClick={async () => {
                      setRemovingMembersModal(true);
                      try {
                        await Promise.all([...memberRemoveSelected].map((id) =>
                          fetch(`${API}/channels/${selectedId}/members/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => r.json())
                        ));
                        toast.success(`已移除 ${memberRemoveSelected.size} 个成员`);
                        const removed = new Set(memberRemoveSelected);
                        setChannelBots((prev) => prev.filter((b) => !removed.has(b.member_id)));
                        setChannelUsers((prev) => prev.filter((u) => !removed.has(u.member_id)));
                        // 将移除的成员放回可添加列表（重新拉取补全 label）
                        const wsId = selectedChannel?.workspace_id;
                        const [botsRes, usersRes] = await Promise.all([
                          fetch(`${API}/bots`).then((r) => r.json()),
                          wsId ? fetch(`${API}/workspaces/${wsId}/members`).then((r) => r.json()) : Promise.resolve({ data: [] }),
                        ]);
                        const stillInChannel = new Set<string>([
                          ...channelBots.filter((b) => !removed.has(b.member_id)).map((b) => b.member_id),
                          ...channelUsers.filter((u) => !removed.has(u.member_id)).map((u) => u.member_id),
                        ]);
                        const opts: MemberOption[] = [];
                        for (const b of (botsRes.data || [])) if (!stillInChannel.has(b.bot_id)) opts.push({ id: b.bot_id, type: "bot", label: `[Bot] @${b.username}${b.display_name ? " · " + b.display_name : ""}` });
                        for (const u of (usersRes.data || [])) if (!stillInChannel.has(u.user_id)) opts.push({ id: u.user_id, type: "user", label: `[用户] @${u.username}${u.display_name ? " · " + u.display_name : ""}` });
                        setMemberAddOptions(opts);
                        setMemberRemoveSelected(new Set());
                      } catch {
                        toast.error("移除失败");
                      } finally {
                        setRemovingMembersModal(false);
                      }
                    }}
                    className="mt-3 px-4 py-1.5 bg-red-50 text-red-700 border border-red-200 rounded-lg text-sm font-medium hover:bg-red-100 disabled:opacity-50"
                  >
                    {removingMembersModal ? "移除中…" : `移除选中 (${memberRemoveSelected.size})`}
                  </button>
                )}
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button type="button" onClick={() => setManageMembersOpen(false)} className="px-4 py-2 bg-[#F8F8F8] text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium">关闭</button>
            </div>
          </div>
        </div>
      )}

      <main className="flex-1 flex flex-col min-w-0 bg-white">
        {selectedId ? (
          <>
            <div className="px-4 pt-3 pb-2 border-b bg-white flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-500">已识别问答 {blockPairsForExport.length} 组，已勾选 {selectedPairs.length} 组</span>
              <button
                type="button"
                onClick={downloadQaMarkdown}
                disabled={selectedPairs.length === 0}
                className="px-2.5 py-1 text-xs rounded-md border border-gray-300 text-gray-600 disabled:text-gray-300 disabled:border-gray-200 hover:bg-white transition-colors"
              >
                导出 MD
              </button>
              <button
                type="button"
                onClick={generateQaSummary}
                disabled={selectedPairs.length === 0 || summaryBusy || !qaLlmReady}
                title={qaLlmHint}
                className="px-2.5 py-1 text-xs rounded-md bg-[#1264A3] text-white disabled:bg-gray-300 hover:bg-[#0d5296] transition-colors"
              >
                {summaryBusy ? "总结中..." : "LLM 总结"}
              </button>
              <button
                type="button"
                onClick={downloadSummaryMarkdown}
                disabled={!summaryPreview.trim()}
                className="px-2.5 py-1 text-xs rounded-md border border-gray-300 text-gray-600 disabled:text-gray-300 disabled:border-gray-200 hover:bg-white transition-colors"
              >
                下载总结
              </button>
              <button
                type="button"
                onClick={clearQaSelection}
                className="px-2.5 py-1 text-xs rounded-md border border-gray-300 text-gray-600 hover:bg-white transition-colors"
              >
                清空勾选
              </button>
              {!qaLlmReady && (
                <span className="text-xs text-amber-600">{qaLlmHint}</span>
              )}
              <button
                type="button"
                onClick={() => setManageMembersOpen(true)}
                className="ml-auto px-2.5 py-1 text-xs rounded-md border border-[#1264A3] text-[#1264A3] hover:bg-[#1264A3]/10 transition-colors flex items-center gap-1"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM1.49 15.326a.78.78 0 0 1-.358-.442 3 3 0 0 1 4.308-3.516 6.484 6.484 0 0 0-1.905 3.959c-.023.222-.014.442.025.654a4.97 4.97 0 0 1-2.07-.655ZM16.44 15.98a4.97 4.97 0 0 0 2.07-.654.78.78 0 0 0 .357-.442 3 3 0 0 0-4.308-3.517 6.484 6.484 0 0 1 1.907 3.96 2.32 2.32 0 0 1-.026.654ZM18 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM5.304 16.19a.844.844 0 0 1-.277-.71 5 5 0 0 1 9.947 0 .843.843 0 0 1-.277.71A6.975 6.975 0 0 1 10 18a6.974 6.974 0 0 1-4.696-1.81Z" />
                </svg>
                管理成员
              </button>
            </div>

            {summaryPreview && (
              <div className="flex-shrink-0 px-4 pt-2 pb-2 border-b border-gray-100 bg-gray-50">
                <div className="text-xs font-medium text-gray-500 mb-1">总结预览</div>
                <div className="w-full border border-gray-200 rounded-lg p-2.5 bg-white text-sm whitespace-pre-wrap max-h-60 overflow-auto">
                  {summaryPreview}
                </div>
              </div>
            )}
            <div ref={messagesContainerRef} className="flex-1 overflow-auto p-4 space-y-2">
              {loading ? (
                <div className="flex items-center justify-center h-full text-gray-400 text-sm">加载中...</div>
              ) : (
                <div className="py-4">
                  {messages.map((m, idx) => {
                    const prevMsg = messages[idx - 1];
                    const isClarifyReplyBubble =
                      m.sender_type === "user" &&
                      prevMsg?.sender_type === "bot" &&
                      !!parseGuidePayload(prevMsg.content).clarify &&
                      isClarifyReplyUserMessage(m.content);
                    if (isClarifyReplyBubble) {
                      return <div key={m.msg_id} className="sr-only" aria-hidden="true" />;
                    }

                    // 回答消息在对应的问题卡片中渲染，这里跳过
                    if (qaAnswerIds.has(m.msg_id)) {
                      return null;
                    }

                    // 问题卡片：用户消息且被识别为问答中的“问题”
                    if (m.sender_type === "user" && qaPairByQuestionId.has(m.msg_id)) {
                      const pair = qaPairByQuestionId.get(m.msg_id)!;
                      const questionExpanded = !!expandedQuestionIds[m.msg_id];
                      const questionSummaryText =
                        stripThinkTags(parseGuidePayload(m.content).text || m.content) || "（无内容）";

                      // 查找回答消息及其澄清状态
                      const answer = pair.answer;
                      const answerIdx = messages.findIndex((mm) => mm.msg_id === answer.msg_id);
                      const answerNext = answerIdx >= 0 ? messages[answerIdx + 1] : undefined;
                      const { text: answerText, form: answerForm, clarify: answerClarify } = parseGuidePayload(answer.content);
                      const answerClarifyAnswered =
                        answerNext &&
                        (answerNext.sender_type === "bot" ||
                          (answerNext.sender_type === "user" && isClarifyReplyUserMessage(answerNext.content)));
                      const answerClarifyWaiting = pendingClarifyReplyMsgId === answer.msg_id;
                      const answerClarifyStatus: "form" | "waiting" | "answered" | null =
                        answerClarify && answer.sender_type === "bot"
                          ? answerClarifyWaiting
                            ? "waiting"
                            : answerClarifyAnswered
                              ? "answered"
                              : "form"
                          : null;
                      const answerReplyContent =
                        answerClarifyStatus === "answered" &&
                        answerNext?.sender_type === "user" &&
                        isClarifyReplyUserMessage(answerNext.content)
                          ? answerNext.content
                          : undefined;
                      const answerSenderBot =
                        answer.sender_type === "bot" ? channelBots.find((b) => b.member_id === answer.sender_id) : undefined;
                      const answerBotLabel = answerSenderBot?.display_name || answerSenderBot?.username || "Bot";
                      const answerBotInitials = answerBotLabel.slice(0, 2).toUpperCase();

                      return (
                        <div key={m.msg_id} className="p-2 rounded bg-white border border-gray-200">
                          <button
                            type="button"
                            className="w-full flex items-center gap-2 text-xs text-gray-700 hover:bg-gray-50 rounded px-1 py-0.5"
                            onClick={() =>
                              setExpandedQuestionIds((prev) => ({ ...prev, [m.msg_id]: !prev[m.msg_id] }))
                            }
                          >
                            <span
                              className="inline-block text-gray-400 transition-transform"
                              style={{ transform: questionExpanded ? "rotate(90deg)" : "none" }}
                              aria-hidden="true"
                            >
                              ▶
                            </span>
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-200 text-gray-700 text-xs">
                              用户
                            </span>
                            <span className="text-gray-400">{m.created_at?.slice(0, 19) || ""}</span>
                            <span className="ml-2 text-gray-800 text-xs" title={questionSummaryText}>
                              {questionSummaryText}
                            </span>
                            {qaPairByQuestionId.has(m.msg_id) && (
                              <label className="ml-auto inline-flex items-center">
                                <input
                                  type="checkbox"
                                  checked={!!selectedQaIds[m.msg_id]}
                                  onChange={() => toggleQa(m.msg_id)}
                                />
                              </label>
                            )}
                          </button>

                          {questionExpanded && (
                            <div className="mt-2 pl-6">
                              <div
                                className={`p-2 rounded ${
                                  answer.sender_type === "bot"
                                    ? "bg-green-50 border-l-2 border-green-400"
                                    : "bg-white"
                                }`}
                              >
                                <span className="text-xs text-gray-500 flex items-center gap-2">
                                  {answer.sender_type === "bot" ? (
                                    <span className="inline-flex items-center gap-1.5">
                                      {answerSenderBot?.avatar_url ? (
                                        <img
                                          src={answerSenderBot.avatar_url}
                                          alt={answerBotLabel}
                                          className="w-5 h-5 rounded-full object-cover flex-shrink-0"
                                        />
                                      ) : (
                                        <span
                                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-400 text-white text-xs font-bold flex-shrink-0"
                                          aria-hidden="true"
                                        >
                                          {answerBotInitials.slice(0, 1)}
                                        </span>
                                      )}
                                      <span
                                        className="inline-flex items-center px-1.5 py-0.5 rounded bg-green-200 text-green-800 text-xs font-medium"
                                        aria-label="Bot"
                                      >
                                        {answerBotLabel}
                                      </span>
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-200 text-gray-700 text-xs">
                                      {answer.sender_type === "user" ? "用户" : "系统"}
                                    </span>
                                  )}
                                  <span>{answer.created_at?.slice(0, 19) || ""}</span>
                                </span>
                                <div className="mt-1 whitespace-pre-wrap">
                                  {renderWithThinkFolding(answerText || answer.content, `${answer.msg_id}-`)}
                                </div>
                                {answerForm && selectedId && answer.sender_type === "bot" && (
                                  <GuideFormBlock
                                    msgId={answer.msg_id}
                                    form={answerForm}
                                    channelId={selectedId}
                                    onReply={(newMsg) => setMessages((prev) => [...prev, newMsg])}
                                    onChannelsRefresh={() => refreshChannels(setChannels)}
                                  />
                                )}
                                {answerClarifyStatus !== null && selectedId && (
                                  <ClarifyInlineBlock
                                    msgId={answer.msg_id}
                                    schema={answerClarify!}
                                    status={answerClarifyStatus}
                                    replyContent={answerReplyContent}
                                    onContinue={(answers) =>
                                      handleClarifyContinue(answer.msg_id, answerClarify!, answers)
                                    }
                                    onSkip={() => handleClarifySkip(answer.msg_id)}
                                  />
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    }

                    // 非问答相关消息按原样渲染
                    const { text, form, clarify } = parseGuidePayload(m.content);
                    const nextMsg = messages[idx + 1];
                    const clarifyAnswered =
                      nextMsg &&
                      (nextMsg.sender_type === "bot" ||
                        (nextMsg.sender_type === "user" && isClarifyReplyUserMessage(nextMsg.content)));
                    const clarifyWaiting = pendingClarifyReplyMsgId === m.msg_id;
                    const clarifyStatus: "form" | "waiting" | "answered" | null =
                      clarify && m.sender_type === "bot"
                        ? clarifyWaiting
                          ? "waiting"
                          : clarifyAnswered
                            ? "answered"
                            : "form"
                        : null;
                    const replyContent =
                      clarifyStatus === "answered" &&
                      nextMsg?.sender_type === "user" &&
                      isClarifyReplyUserMessage(nextMsg.content)
                        ? nextMsg.content
                        : undefined;
                    const senderBot =
                      m.sender_type === "bot" ? channelBots.find((b) => b.member_id === m.sender_id) : undefined;
                    const botLabel = senderBot?.display_name || senderBot?.username || "Bot";
                    const botInitials = botLabel.slice(0, 2).toUpperCase();
                    return (
                      <div
                        key={m.msg_id}
                        className={`p-2 rounded ${
                          m.sender_type === "bot" ? "bg-green-50 border-l-2 border-green-400" : "bg-white"
                        }`}
                      >
                        <span className="text-xs text-gray-500 flex items-center gap-2">
                          {m.sender_type === "bot" ? (
                            <span className="inline-flex items-center gap-1.5">
                              {senderBot?.avatar_url ? (
                                <img
                                  src={senderBot.avatar_url}
                                  alt={botLabel}
                                  className="w-5 h-5 rounded-full object-cover flex-shrink-0"
                                />
                              ) : (
                                <span
                                  className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-400 text-white text-xs font-bold flex-shrink-0"
                                  aria-hidden="true"
                                >
                                  {botInitials.slice(0, 1)}
                                </span>
                              )}
                              <span
                                className="inline-flex items-center px-1.5 py-0.5 rounded bg-green-200 text-green-800 text-xs font-medium"
                                aria-label="Bot"
                              >
                                {botLabel}
                              </span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-200 text-gray-700 text-xs">
                              {m.sender_type === "user" ? "用户" : "系统"}
                            </span>
                          )}
                          {m.created_at?.slice(0, 19) || ""}
                        </span>
                        <div className="mt-1 whitespace-pre-wrap">
                          {renderWithThinkFolding(text, `${m.msg_id}-`)}
                        </div>
                        {form && selectedId && m.sender_type === "bot" && (
                          <GuideFormBlock
                            msgId={m.msg_id}
                            form={form}
                            channelId={selectedId}
                            onReply={(newMsg) => setMessages((prev) => [...prev, newMsg])}
                            onChannelsRefresh={() => refreshChannels(setChannels)}
                          />
                        )}
                        {clarifyStatus !== null && selectedId && (
                          <ClarifyInlineBlock
                            msgId={m.msg_id}
                            schema={clarify!}
                            status={clarifyStatus}
                            replyContent={replyContent}
                            onContinue={(answers) => handleClarifyContinue(m.msg_id, clarify!, answers)}
                            onSkip={() => handleClarifySkip(m.msg_id)}
                          />
                        )}
                      </div>
                    );
                  })}
                  {waitingForBotReply && <ThinkingIndicator />}
                  {Object.entries(processingBots).map(([botId, username]) => (
                    <div key={botId} className="px-4 py-2 flex items-center gap-2 text-sm text-gray-500 animate-pulse">
                      <div className="w-6 h-6 rounded bg-[#2EB67D]/20 flex items-center justify-center text-[#2EB67D] text-xs font-bold">@{username.slice(0,1)}</div>
                      <span>@{username} 正在处理...</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Slack-style input area */}
            <div className="flex-shrink-0 px-4 pb-4 pt-2">
              {pendingFileNames.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {pendingFileNames.map((name, i) => (
                    <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#F8F8F8] border border-gray-200 rounded text-xs text-gray-600">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-gray-400">
                        <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h4.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12A1.5 1.5 0 0 1 13 5.622V12.5A1.5 1.5 0 0 1 11.5 14h-7A1.5 1.5 0 0 1 3 12.5v-9Z" />
                      </svg>
                      {name}
                    </span>
                  ))}
                </div>
              )}
              <div className="relative">
              <div className="border border-gray-300 rounded-lg overflow-hidden focus-within:border-gray-400 focus-within:shadow-sm transition-all">
                <div>
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => {
                      const v = e.target.value;
                      const pos = e.target.selectionStart ?? v.length;
                      setInput(v);
                      const lastAt = v.lastIndexOf("@", pos - 1);
                      if (lastAt !== -1) {
                        const after = v.slice(lastAt + 1, pos);
                        if (!after.includes(" ") && !after.includes("\n")) {
                          // 根据当前输入框在视口中的位置，动态决定下拉在上方还是下方展示
                          const rect = e.target.getBoundingClientRect();
                          const spaceBelow = window.innerHeight - rect.bottom;
                          const spaceAbove = rect.top;
                          // 预留约 180px 作为下拉所需空间，不够则优先放到上方
                          if (spaceBelow < 180 && spaceAbove > spaceBelow) {
                            setMentionDropdownPlacement("top");
                          } else {
                            setMentionDropdownPlacement("bottom");
                          }
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
                      if (e.key === "Enter" && e.ctrlKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder={`向 #${selectedChannel?.name || "频道"} 发送消息，输入 @ 选择 Bot…`}
                    className="w-full px-3 pt-2.5 pb-2 min-h-[44px] max-h-48 resize-none outline-none text-sm text-gray-900 placeholder-gray-400"
                    rows={1}
                  />
                </div>
                {/* Input toolbar */}
                <div className="flex items-center justify-between px-2 py-1.5 border-t border-gray-200">
                  <div className="flex items-center gap-1">
                    <label
                      className="w-8 h-8 flex items-center justify-center rounded cursor-pointer text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                      title="上传文件"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                        <path fillRule="evenodd" d="M15.621 4.379a3 3 0 0 0-4.242 0l-7 7a3 3 0 0 0 4.241 4.243h.001l.497-.5a.75.75 0 0 1 1.064 1.057l-.498.501-.002.002a4.5 4.5 0 0 1-6.364-6.364l7-7a4.5 4.5 0 0 1 6.368 6.36l-3.455 3.553A2.625 2.625 0 1 1 9.52 9.52l3.45-3.451a.75.75 0 1 1 1.061 1.06l-3.45 3.451a1.125 1.125 0 0 0 1.587 1.595l3.454-3.553a3 3 0 0 0 0-4.242Z" clipRule="evenodd" />
                      </svg>
                      <input
                        type="file"
                        accept=".txt,.md,.docx,.pdf,.xlsx,.png,.jpg,.jpeg,.webp"
                        className="hidden"
                        onChange={uploadFile}
                      />
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 hidden sm:inline">Ctrl+Enter 发送</span>
                    <button
                      type="button"
                      onClick={send}
                      className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                        input.trim()
                          ? "bg-[#007a5a] text-white hover:bg-[#006a4d]"
                          : "bg-gray-100 text-gray-400 cursor-not-allowed"
                      }`}
                      disabled={!input.trim()}
                    >
                      发送
                    </button>
                  </div>
                </div>
              </div>
              {showMentionDropdown && (() => {
                const allItems = [
                  ...channelBots.map((b) => ({ ...b, kind: "bot" as const })),
                  ...channelUsers.map((u) => ({ ...u, kind: "user" as const })),
                ];
                const matched = allItems.filter((item) =>
                  item.username.toLowerCase().includes(mentionFilter.toLowerCase()) ||
                  (item.display_name ?? "").toLowerCase().includes(mentionFilter.toLowerCase())
                );
                if (matched.length === 0) return null;
                const placementClass = mentionDropdownPlacement === "top" ? "bottom-full mb-1" : "top-full mt-1";
                return (
                  <ul className={`absolute left-0 right-0 ${placementClass} bg-white border border-gray-200 rounded-lg shadow-lg z-20 max-h-48 overflow-auto`} role="listbox">
                    {matched.map((item) => (
                      <li
                        key={item.member_id}
                        role="option"
                        className="px-3 py-2 hover:bg-[#F8F8F8] cursor-pointer text-sm flex items-center gap-2"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          const el = inputRef.current;
                          if (!el) return;
                          const v = el.value;
                          const pos = el.selectionStart ?? v.length;
                          const lastAt = v.lastIndexOf("@", pos - 1);
                          const newVal = v.slice(0, lastAt) + "@" + item.username + " " + v.slice(pos);
                          setInput(newVal);
                          setShowMentionDropdown(false);
                          setTimeout(() => {
                            el.focus();
                            el.setSelectionRange(lastAt + item.username.length + 2, lastAt + item.username.length + 2);
                          }, 0);
                        }}
                      >
                        <div className={`w-6 h-6 rounded flex items-center justify-center text-white text-xs font-bold flex-shrink-0 ${item.kind === "bot" ? "bg-[#2EB67D]" : "bg-[#1264A3]"}`}>
                          {item.username.slice(0, 1).toUpperCase()}
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="font-medium text-gray-800">@{item.username}</span>
                          {item.display_name && <span className="text-xs text-gray-400 truncate">{item.display_name}</span>}
                        </div>
                        <span className={`ml-auto text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${item.kind === "bot" ? "bg-green-50 text-green-700" : "bg-blue-50 text-blue-700"}`}>
                          {item.kind === "bot" ? "Bot" : "用户"}
                        </span>
                      </li>
                    ))}
                  </ul>
                );
              })()}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="w-16 h-16 rounded-2xl bg-[#3F0E40]/10 flex items-center justify-center mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-[#3F0E40]/40">
                <path fillRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0 1 12 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 0 1-3.476.383.39.39 0 0 0-.297.17l-2.755 4.133a.75.75 0 0 1-1.248 0l-2.755-4.133a.39.39 0 0 0-.297-.17 48.9 48.9 0 0 1-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97Z" clipRule="evenodd" />
              </svg>
            </div>
            <p className="text-gray-500 text-base font-medium">请从左侧选择频道</p>
            <p className="text-gray-400 text-sm mt-1">选择一个频道开始对话</p>
          </div>
        )}
      </main>
    </div>
    </>
  );
}
