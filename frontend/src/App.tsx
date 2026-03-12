import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";

const API = "/api";
const WS_BASE = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const DEV_USER_ID = "a0000000-0000-0000-0000-000000000001";
const API_DOCS_URL = "/docs";

type Channel = { channel_id: string; name: string; type: string };
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

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function buildQaPairs(messages: Message[]): QaPair[] {
  const pairs: QaPair[] = [];
  for (let i = 0; i < messages.length; i++) {
    const q = messages[i];
    if (q.sender_type !== "user") continue;
    for (let j = i + 1; j < messages.length; j++) {
      const a = messages[j];
      if (a.sender_type === "bot") {
        pairs.push({ question: q, answer: a });
        break;
      }
      if (a.sender_type === "user") {
        break;
      }
    }
  }
  return pairs;
}

/** 问题摘要，用于折叠展示（截断过长文本） */
function questionSummary(m: Message, maxLen = 60): string {
  const { text } = parseGuidePayload(m.content);
  const raw = (text || m.content || "").trim();
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (stripped.length <= maxLen) return stripped || "（无内容）";
  return stripped.slice(0, maxLen) + "…";
}

/** 任意消息的折叠预览（Bot 消息用 "Bot: " 前缀） */
function blockPreview(m: Message, maxLen = 60): string {
  const { text } = parseGuidePayload(m.content);
  const raw = (text || m.content || "").trim();
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const content = stripped || "（无内容）";
  const prefix = m.sender_type === "bot" ? "Bot: " : "";
  const display = prefix + content;
  if (display.length <= maxLen) return display;
  return display.slice(0, maxLen) + "…";
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
      <div className="my-1 rounded border border-gray-200 bg-gray-50 overflow-hidden p-2">
        <span className="text-xs text-gray-500">引导正在根据澄清回答…</span>
      </div>
    );
  }

  if (status === "answered") {
    const displayReply = replyContent?.replace(/^@引导\s*澄清回答[：:]\s*/i, "").trim() || "";
    return (
      <div className="my-1 rounded border border-gray-200 bg-gray-50 overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="w-full px-2 py-1.5 text-left text-xs text-gray-500 hover:bg-gray-100 flex items-center gap-1"
        >
          <span className="inline-block transition-transform" style={{ transform: open ? "rotate(90deg)" : "none" }}>▶</span>
          <span>澄清</span>
          <span>{open ? "收起" : "展开"}</span>
        </button>
        {open && (
          <div className="p-2 text-xs text-gray-600 border-t border-gray-200 space-y-2">
            <p>已澄清并已收到引导回复</p>
            {displayReply && (
              <div className="rounded border border-gray-200 bg-gray-100 p-2">
                <p className="text-gray-500 mb-1">澄清回答</p>
                <pre className="whitespace-pre-wrap text-gray-700 font-sans text-xs">{displayReply}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="my-1 rounded border border-gray-200 bg-gray-50 overflow-hidden p-3">
      <div className="mb-2">
        <h4 className="text-sm font-medium text-gray-800">{schema.title || "请先确认以下问题"}</h4>
      </div>
      <div className="space-y-2 max-h-[40vh] overflow-auto pr-1">
        {schema.questions.map((q, idx) => (
          <div key={q.id} className="rounded border border-gray-200 bg-white p-2">
            <p className="text-sm mb-1.5 text-gray-700">{idx + 1}. {q.prompt}</p>
            <div className="space-y-1">
              {q.options.map((opt) => {
                const checked = (answers[q.id] || []).includes(opt.id);
                return (
                  <label key={opt.id} className="flex items-center gap-2 text-sm cursor-pointer text-gray-700">
                    <input
                      type={q.allow_multiple ? "checkbox" : "radio"}
                      name={`${msgId}-${q.id}`}
                      checked={checked}
                      onChange={() => toggleOption(q, opt.id)}
                    />
                    <span>{opt.label}</span>
                  </label>
                );
              })}
              {q.other_enabled && (
                <div className="pt-1">
                  <label className="flex items-center gap-2 text-sm cursor-pointer text-gray-700">
                    <input
                      type={q.allow_multiple ? "checkbox" : "radio"}
                      name={`${msgId}-${q.id}`}
                      checked={(answers[q.id] || []).includes(OTHER_CHOICE_ID)}
                      onChange={() => toggleOther(q)}
                    />
                    <span>{q.other_label || "其他"}</span>
                  </label>
                  {(answers[q.id] || []).includes(OTHER_CHOICE_ID) && (
                    <input
                      type="text"
                      value={otherText[q.id] || ""}
                      onChange={(e) => setOtherText((prev) => ({ ...prev, [q.id]: e.target.value }))}
                      placeholder={q.other_placeholder || "请输入其他补充"}
                      className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-800"
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
            className="px-3 py-1.5 rounded border border-gray-400 text-gray-700 hover:bg-gray-100 text-sm"
          >
            Skip
          </button>
        )}
        <button
          type="button"
          disabled={!canContinue}
          onClick={() => onContinue({ selected: answers, other_text: otherText })}
          className="px-3 py-1.5 rounded bg-amber-500 text-black font-medium disabled:opacity-50 text-sm"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

/** 单条消息气泡，供完整展示与折叠块复用 */
function MessageBubble({
  m,
  prevMsg,
  nextMsg,
  blockQuestionIds,
  selectedQaIds,
  toggleQa,
  selectedId,
  setMessages,
  setChannels,
  refreshChannels,
  handleClarifyContinue,
  handleClarifySkip,
  pendingClarifyReplyMsgId,
}: {
  m: Message;
  prevMsg?: Message;
  nextMsg?: Message;
  blockQuestionIds: Set<string>;
  selectedQaIds: Record<string, boolean>;
  toggleQa: (msgId: string) => void;
  selectedId: string | null;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setChannels: React.Dispatch<React.SetStateAction<Channel[]>>;
  refreshChannels: (setChannels: (c: Channel[]) => void) => void;
  handleClarifyContinue: (msgId: string, schema: ClarifySchema, answers: ClarifyAnswers) => void;
  handleClarifySkip: (msgId: string) => void;
  pendingClarifyReplyMsgId: string | null;
}) {
  const isClarifyReplyBubble =
    m.sender_type === "user" &&
    prevMsg?.sender_type === "bot" &&
    !!parseGuidePayload(prevMsg.content).clarify &&
    isClarifyReplyUserMessage(m.content);
  if (isClarifyReplyBubble) {
    return <div key={m.msg_id} className="sr-only" aria-hidden="true" />;
  }
  const { text, form, clarify } = parseGuidePayload(m.content);
  const clarifyAnswered =
    nextMsg &&
    (nextMsg.sender_type === "bot" || (nextMsg.sender_type === "user" && isClarifyReplyUserMessage(nextMsg.content)));
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
  return (
    <div key={m.msg_id} className={`p-2 rounded ${m.sender_type === "bot" ? "bg-green-50 border-l-2 border-green-400" : "bg-white"}`}>
      <span className="text-xs text-gray-500 flex items-center gap-2 w-full">
        {m.sender_type === "bot" ? (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-green-200 text-green-800 text-xs font-medium" aria-label="Bot">Bot</span>
        ) : (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-200 text-gray-700 text-xs">用户</span>
        )}
        {m.created_at?.slice(0, 19) || ""}
        {m.sender_type === "user" && blockQuestionIds.has(m.msg_id) && (
          <label className="ml-auto flex-shrink-0 inline-flex items-center gap-1 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={!!selectedQaIds[m.msg_id]}
              onChange={() => toggleQa(m.msg_id)}
            />
            勾选
          </label>
        )}
      </span>
      <div className="mt-1 whitespace-pre-wrap">{renderWithThinkFolding(text, `${m.msg_id}-`)}</div>
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
  type BotItem = { bot_id: string; username: string; display_name?: string; intro?: string; avatar_url?: string };
  const [channelBots, setChannelBots] = useState<ChannelBot[]>([]);
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [addBotOpen, setAddBotOpen] = useState(false);
  const [allBots, setAllBots] = useState<BotItem[]>([]);
  const [expandedOlderIds, setExpandedOlderIds] = useState<Set<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

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
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);

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
        } else setChannelBots([]);
      })
      .catch(() => {
        setChannelBots([]);
        setChannelUsers([]);
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
    }
  }, [addBotOpen]);

  useEffect(() => {
    if (showMentionDropdown && selectedId) {
      fetch(`${API}/bots`).then((r) => r.json()).then((d) => setAllBots(d.data || [])).catch(() => setAllBots([]));
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

  const addBotToChannel = (botId: string): Promise<boolean> => {
    if (!selectedId) return Promise.resolve(false);
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
      if (!d.data) return prev;
      if (prev.some((m) => m.msg_id === d.data.msg_id)) return prev;
      return [...prev, d.data];
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

  const loadMoreMessages = () => {
    if (!selectedId || loadingMore || !hasMore || messages.length === 0) return;
    const oldestId = messages[0]?.msg_id;
    if (!oldestId) return;
    setLoadingMore(true);
    fetch(`${API}/channels/${selectedId}/messages?limit=20&before_msg_id=${encodeURIComponent(oldestId)}`)
      .then((r) => r.json())
      .then((d) => {
        const data = d.data || [];
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.msg_id));
          const newMsgs = data.filter((m: Message) => !existingIds.has(m.msg_id));
          return [...newMsgs, ...prev];
        });
        setHasMore(data.length >= 20);
      })
      .catch(console.error)
      .finally(() => setLoadingMore(false));
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
  const blockQuestionIds = new Set(blocks.map((b) => b.question.msg_id));
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

  const RECENT_COUNT = 5;
  const recentBlocks = blocks.slice(-RECENT_COUNT);
  const olderBlocks = blocks.slice(0, -RECENT_COUNT);
  const blockMsgIds = new Set(blocks.flatMap((b) => b.messages.map((m) => m.msg_id)));
  const preambleMessages = messages.filter((m) => !blockMsgIds.has(m.msg_id));

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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setLoginModalOpen(false)}>
          <div className="bg-white rounded-lg p-6 w-80 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-semibold mb-4">{registerMode ? "注册" : "登录"}</h2>
            {loginError && <div className="mb-3 text-sm text-red-500 bg-red-50 p-2 rounded">{loginError}</div>}
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
                <input name="display_name" placeholder="显示名称" required className="w-full mb-3 px-3 py-2 border rounded" />
              )}
              <input name="username" placeholder="用户名" required className="w-full mb-3 px-3 py-2 border rounded" />
              <input name="password" type="password" placeholder="密码" required className="w-full mb-4 px-3 py-2 border rounded" />
              <button type="submit" disabled={loginLoading} className="w-full bg-blue-500 text-white py-2 rounded hover:bg-blue-600 disabled:opacity-50">
                {loginLoading ? "处理中..." : registerMode ? "注册" : "登录"}
              </button>
            </form>
            <div className="mt-4 text-center text-sm">
              {registerMode ? (
                <>
                  已有账号？{" "}
                  <button onClick={() => setRegisterMode(false)} className="text-blue-500 hover:underline">登录</button>
                </>
              ) : (
                <>
                  没有账号？{" "}
                  <button onClick={() => setRegisterMode(true)} className="text-blue-500 hover:underline">注册</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

    <div className="flex h-screen bg-gray-100">
      <aside className="w-64 bg-white border-r flex flex-col">
        <div className="p-3 border-b text-sm text-gray-600 flex items-center justify-between">
          <span>
            {currentUser ? (
              <span className="font-medium">{currentUser.display_name}</span>
            ) : (
              "未登录"
            )}
          </span>
          {currentUser ? (
            <button onClick={handleLogout} className="text-xs text-red-500 hover:text-red-700">退出</button>
          ) : (
            <button onClick={() => setLoginModalOpen(true)} className="text-xs text-blue-500 hover:text-blue-700">登录</button>
          )}
        </div>
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
            <div className="px-4 pt-3 pb-2 border-b bg-white flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-500">已识别问答 {blockPairsForExport.length} 组，已勾选 {selectedPairs.length} 组</span>
              <button
                type="button"
                onClick={downloadQaMarkdown}
                disabled={selectedPairs.length === 0}
                className="px-2 py-1 text-xs rounded border border-gray-300 disabled:text-gray-400 disabled:border-gray-200 hover:bg-gray-50"
              >
                导出为 MD
              </button>
              <button
                type="button"
                onClick={generateQaSummary}
                disabled={selectedPairs.length === 0 || summaryBusy || !qaLlmReady}
                title={qaLlmHint}
                className="px-2 py-1 text-xs rounded bg-blue-600 text-white disabled:bg-gray-300"
              >
                {summaryBusy ? "总结中..." : "LLM 总结"}
              </button>
              <button
                type="button"
                onClick={downloadSummaryMarkdown}
                disabled={!summaryPreview.trim()}
                className="px-2 py-1 text-xs rounded border border-gray-300 disabled:text-gray-400 disabled:border-gray-200 hover:bg-gray-50"
              >
                下载总结 MD
              </button>
              <button
                type="button"
                onClick={clearQaSelection}
                className="px-2 py-1 text-xs rounded border border-gray-300 hover:bg-gray-50"
              >
                清空勾选
              </button>
              {!qaLlmReady && (
                <span className="text-xs text-amber-700">
                  {qaLlmHint}
                </span>
              )}
            </div>
            {summaryPreview && (
              <div className="px-4 pt-2 pb-2 border-b bg-gray-50">
                <div className="text-xs text-gray-500 mb-1">总结预览</div>
                <div className="w-full border rounded p-2 bg-white text-sm whitespace-pre-wrap max-h-60 overflow-auto">
                  {summaryPreview}
                </div>
              </div>
            )}
            <div ref={messagesContainerRef} className="flex-1 overflow-auto p-4 space-y-2">
              {loading ? (
                <div className="text-gray-500">加载中...</div>
              ) : (
                <>
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
                    const { text, form, clarify } = parseGuidePayload(m.content);
                    const nextMsg = messages[idx + 1];
                    const clarifyAnswered =
                      nextMsg &&
                      (nextMsg.sender_type === "bot" || (nextMsg.sender_type === "user" && isClarifyReplyUserMessage(nextMsg.content)));
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
                    return (
                      <div key={m.msg_id} className={`p-2 rounded ${m.sender_type === "bot" ? "bg-green-50 border-l-2 border-green-400" : "bg-white"}`}>
                        <span className="text-xs text-gray-500 flex items-center gap-2">
                          {m.sender_type === "bot" ? (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-green-200 text-green-800 text-xs font-medium" aria-label="Bot">Bot</span>
                          ) : (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-200 text-gray-700 text-xs">用户</span>
                          )}
                          {m.created_at?.slice(0, 19) || ""}
                          {m.sender_type === "user" && qaPairByQuestionId.has(m.msg_id) && (
                            <label className="ml-2 inline-flex items-center gap-1 text-xs text-gray-600">
                              <input
                                type="checkbox"
                                checked={!!selectedQaIds[m.msg_id]}
                                onChange={() => toggleQa(m.msg_id)}
                              />
                              勾选问答
                            </label>
                          )}
                        </span>
                        <div className="mt-1 whitespace-pre-wrap">{renderWithThinkFolding(text, `${m.msg_id}-`)}</div>
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
                    <div key={botId} className="p-2 rounded bg-amber-50 border-l-2 border-amber-400 text-sm text-gray-600 animate-pulse">
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-200 text-amber-800 text-xs font-medium mr-2">@{username}</span>
                      正在处理...
                    </div>
                  ))}
                  </>
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
                    placeholder="输入消息，输入 @ 选择 Bot…（Ctrl+Enter 发送，Enter 换行）"
                    className="w-full border rounded px-3 py-2 min-h-[44px] max-h-48 resize-y"
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
    </>
  );
}
