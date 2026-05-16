import { useState } from "react";
import type {
  ClarifySchema,
  ClarifyQuestion,
  ClarifyAnswers,
} from "../types";
import { OTHER_CHOICE_ID } from "../types";

export function ClarifyInlineBlock({
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
  const [optionText, setOptionText] = useState<Record<string, string>>({});
  const allowSkip = (schema.skip_policy || "allow") === "allow";
  const canContinue = schema.questions.every((q) => {
    const selected = answers[q.id] || [];
    if (selected.length === 0) return false;
    if (selected.includes(OTHER_CHOICE_ID)) {
      return !!(otherText[q.id] || "").trim();
    }
    for (const opt of q.options) {
      if (opt.requires_text && selected.includes(opt.id)) {
        const key = `${q.id}:${opt.id}`;
        if (!(optionText[key] || "").trim()) return false;
      }
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
      <div className="an-token-panel my-2 rounded-lg border border-gray-200 bg-[#F8F8F8] p-3">
        <span className="text-xs text-gray-400 flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-gray-300 animate-pulse" />
          The guide is using the clarification answer...
        </span>
      </div>
    );
  }

  if (status === "answered") {
    const displayReply =
      replyContent?.replace(/^@(?:Helper|Coordinator|channel bot)\s*Clarification answer[::]\s*/i, "").trim() ||
      "";
    return (
      <div className="an-token-panel my-2 rounded-lg border border-gray-200 bg-[#F8F8F8] overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="w-full px-3 py-2 text-left text-xs text-gray-500 hover:bg-gray-100 flex items-center gap-1.5"
        >
          <span
            className="inline-block transition-transform"
            style={{ transform: open ? "rotate(90deg)" : "none" }}
          >
            ▶
          </span>
          <span className="font-medium">Clarification</span>
          <span className="text-gray-400">{open ? "Collapse" : "Expand"}</span>
        </button>
        {open && (
          <div className="px-3 pb-3 text-xs text-gray-600 border-t border-gray-200 space-y-2 pt-2">
            <p className="text-gray-500">Clarified and guide reply received</p>
            {displayReply && (
              <div className="rounded border border-gray-200 bg-white p-2">
                <p className="text-gray-400 mb-1">Clarification answer</p>
                <pre className="whitespace-pre-wrap text-gray-700 font-sans text-xs">
                  {displayReply}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="an-token-panel my-2 rounded-lg border border-[#1264A3]/30 bg-[#F8F8F8] overflow-hidden p-3">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-gray-800">
          {schema.title || "Please confirm the following questions"}
        </h4>
      </div>
      <div className="space-y-2 max-h-[40vh] overflow-auto pr-1">
        {schema.questions.map((q, idx) => (
          <div
            key={q.id}
            className="rounded-lg border border-gray-200 bg-white p-3"
          >
            <p className="text-sm mb-2 text-gray-700 font-medium">
              {idx + 1}. {q.prompt}
            </p>
            <div className="space-y-1.5">
              {q.options.map((opt) => {
                const checked = (answers[q.id] || []).includes(opt.id);
                const optKey = `${q.id}:${opt.id}`;
                return (
                  <div key={opt.id} className="space-y-1">
                    <label className="flex items-center gap-2 text-sm cursor-pointer text-gray-700 hover:text-gray-900">
                      <input
                        type={q.allow_multiple ? "checkbox" : "radio"}
                        name={`${msgId}-${q.id}`}
                        checked={checked}
                        onChange={() => toggleOption(q, opt.id)}
                        className="accent-[#1264A3]"
                      />
                      <span>{opt.label}</span>
                    </label>
                    {opt.requires_text && checked && (
                      <input
                        type="text"
                        value={optionText[optKey] || ""}
                        onChange={(e) =>
                          setOptionText((prev) => ({
                            ...prev,
                            [optKey]: e.target.value,
                          }))
                        }
                        placeholder={opt.text_placeholder || "Enter a value"}
                        className="ml-6 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:border-[#1264A3]"
                      />
                    )}
                  </div>
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
                    <span>{q.other_label || "Other"}</span>
                  </label>
                  {(answers[q.id] || []).includes(OTHER_CHOICE_ID) && (
                    <input
                      type="text"
                      value={otherText[q.id] || ""}
                      onChange={(e) =>
                        setOtherText((prev) => ({
                          ...prev,
                          [q.id]: e.target.value,
                        }))
                      }
                      placeholder={q.other_placeholder || "Enter additional details"}
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
            Skip
          </button>
        )}
        <button
          type="button"
          disabled={!canContinue}
          onClick={() =>
            onContinue({
              selected: answers,
              other_text: otherText,
              option_text: optionText,
            })
          }
          className="px-4 py-1.5 rounded bg-[#007a5a] text-white font-medium disabled:opacity-40 text-sm hover:bg-[#006a4d]"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
