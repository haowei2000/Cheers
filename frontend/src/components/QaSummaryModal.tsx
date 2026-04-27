import type { QaPair, ChannelBot } from "../types";
import { parseGuidePayload } from "../lib/guide";
import { stripThinkTags } from "../lib/think";
import { Modal } from "./Modal";

interface QaSummaryModalProps {
  open: boolean;
  onClose: () => void;
  pairs: QaPair[];
  selectedIds: Record<string, boolean>;
  onToggle: (pairId: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  channelBots: ChannelBot[];
  summaryPreview: string;
  summaryBusy: boolean;
  qaLlmReady: boolean;
  qaLlmHint: string;
  onGenerate: () => void;
  onDownload: () => void;
}

export function QaSummaryModal({
  open,
  onClose,
  pairs,
  selectedIds,
  onToggle,
  onSelectAll,
  onDeselectAll,
  channelBots,
  summaryPreview,
  summaryBusy,
  qaLlmReady,
  qaLlmHint,
  onGenerate,
  onDownload,
}: QaSummaryModalProps) {
  const selectedCount = pairs.filter((p) => selectedIds[p.question.msg_id]).length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="生成问答总结"
      maxWidth="max-w-2xl"
    >
      <div className="flex flex-col gap-3 max-h-[70vh]">
        {/* QA pair list */}
        <div className="flex-1 overflow-auto space-y-2 min-h-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-500">
              {selectedCount} / {pairs.length} 组已选
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onSelectAll}
                className="text-xs text-[#1264A3] hover:underline"
              >
                全选
              </button>
              <button
                type="button"
                onClick={onDeselectAll}
                className="text-xs text-gray-400 hover:underline"
              >
                取消全选
              </button>
            </div>
          </div>
          {pairs.map((pair) => {
            const checked = !!selectedIds[pair.question.msg_id];
            const qText = stripThinkTags(
              parseGuidePayload(pair.question.content).text ||
                pair.question.content,
            );
            const aText = stripThinkTags(
              parseGuidePayload(pair.answer.content).text || pair.answer.content,
            );
            const senderBot = channelBots.find(
              (b) => b.member_id === pair.answer.sender_id,
            );
            const botLabel =
              pair.answer.sender_name ||
              senderBot?.display_name ||
              senderBot?.username ||
              "Bot";
            return (
              <label
                key={pair.question.msg_id}
                className={`flex gap-3 p-3 rounded-xl border cursor-pointer transition-colors select-none ${checked ? "bg-blue-50 border-[#1264A3]/30" : "bg-gray-50 border-gray-200 hover:bg-gray-100"}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(pair.question.msg_id)}
                  className="mt-0.5 flex-shrink-0 accent-[#1264A3]"
                />
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="flex items-start gap-1.5">
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-medium flex-shrink-0">
                      问
                    </span>
                    <span className="text-[13px] text-gray-800 line-clamp-2">
                      {qText}
                    </span>
                  </div>
                  <div className="flex items-start gap-1.5">
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#2EB67D]/15 text-[#2EB67D] font-medium flex-shrink-0">
                      {pair.answer.sender_type === "bot" ? botLabel : "答"}
                    </span>
                    <span className="text-[13px] text-gray-500 line-clamp-2">
                      {aText || "(无回复)"}
                    </span>
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        {/* Summary result */}
        {summaryPreview && (
          <div className="border border-gray-200 rounded-xl bg-gray-50 p-3 max-h-48 overflow-auto">
            <div className="text-xs font-medium text-gray-500 mb-1.5">
              总结结果
            </div>
            <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
              {summaryPreview}
            </div>
          </div>
        )}

        {/* Modal footer */}
        <div className="flex items-center justify-between pt-3 border-t border-gray-100 gap-3">
          <div className="text-xs text-gray-400" title={qaLlmHint}>
            {qaLlmReady ? "✓ LLM 已就绪" : "⚠ LLM 未配置"}
          </div>
          <div className="flex gap-2">
            {summaryPreview && (
              <button
                type="button"
                onClick={onDownload}
                disabled={selectedCount === 0}
                className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-600 hover:border-gray-400 disabled:opacity-40 transition-colors"
              >
                导出 MD
              </button>
            )}
            <button
              type="button"
              onClick={onGenerate}
              disabled={selectedCount === 0 || summaryBusy || !qaLlmReady}
              className="px-4 py-1.5 rounded-lg bg-[#1264A3] text-white text-sm font-medium hover:bg-[#0d4f82] disabled:opacity-40 transition-colors"
            >
              {summaryBusy ? "生成中…" : "生成总结"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
