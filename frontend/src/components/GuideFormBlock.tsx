import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import type { GuideFormSchema, Message } from "../types";

const API = "/api/v1";

/** 引导动态表单：根据 schema 渲染并提交，成功后回调 */
export function GuideFormBlock({
  msgId: _msgId,
  form,
  channelId,
  onReply,
  onChannelsRefresh,
  userToken,
}: {
  msgId: string;
  form: GuideFormSchema;
  channelId: string;
  onReply: (msg: Message) => void;
  onChannelsRefresh: () => void;
  userToken?: string;
}) {
  const authHeaders: Record<string, string> = userToken
    ? { Authorization: `Bearer ${userToken}` }
    : {};
  const [values, setValues] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<
    Record<string, { value: string; label: string }[]>
  >({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    form.fields.forEach((f) => {
      if (f.type === "select" && f.options_url) {
        fetch(`${API}${f.options_url}`, { headers: authHeaders })
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
        headers: { "Content-Type": "application/json", ...authHeaders },
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
          <label className="block text-gray-700 text-xs font-medium mb-1">
            {f.label}
          </label>
          {f.type === "select" ? (
            <select
              value={values[f.name] ?? ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [f.name]: e.target.value }))
              }
              className="border border-gray-300 rounded px-2 py-1.5 w-full text-sm focus:outline-none focus:border-[#1264A3]"
            >
              <option value="">请选择</option>
              {(options[f.name] ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={values[f.name] ?? ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [f.name]: e.target.value }))
              }
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
