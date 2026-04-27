import { useState } from "react";
import toast from "react-hot-toast";
import { XMarkIcon } from "@heroicons/react/24/solid";
import type { Message } from "../types";
import { Modal } from "./Modal";

const API = "/api/v1";

type ImagePreview = { file_id: string; preview_url: string };

interface ImageGenModalProps {
  open: boolean;
  onClose: () => void;
  channelId: string | null;
  senderId: string;
  messages: Message[];
  onMessageSent: (msg: Message) => void;
  initialSourceFileId?: string;
  initialTab?: "gen" | "edit";
}

export function ImageGenModal({
  open,
  onClose,
  channelId,
  senderId,
  messages,
  onMessageSent,
  initialSourceFileId = "",
  initialTab = "gen",
}: ImageGenModalProps) {
  const [imageGenTab, setImageGenTab] = useState<"gen" | "edit">(initialTab);
  const [imageGenPrompt, setImageGenPrompt] = useState("");
  const [imageGenModel, setImageGenModel] = useState("qwen-image-2.0-pro");
  const [imageGenSize, setImageGenSize] = useState("1024*1024");
  const [imageGenLoading, setImageGenLoading] = useState(false);
  const [imageGenPreview, setImageGenPreview] = useState<ImagePreview | null>(null);

  const [imageEditModel, setImageEditModel] = useState("qwen-image-edit-max");
  const [imageEditSourceFileId, setImageEditSourceFileId] = useState(initialSourceFileId);
  const [imageEditPrompt, setImageEditPrompt] = useState("");
  const [imageEditSize, setImageEditSize] = useState("1024*1024");
  const [imageEditLoading, setImageEditLoading] = useState(false);
  const [imageEditPreview, setImageEditPreview] = useState<ImagePreview | null>(null);


  const postMessage = async (content: string, fileId: string) => {
    if (!channelId) return;
    try {
      const res = await fetch(`${API}/channels/${channelId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          sender_id: senderId,
          sender_type: "user",
          file_ids: [fileId],
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.detail || "发送失败");
        return;
      }
      if (d.data) onMessageSent(d.data);
      onClose();
    } catch {
      toast.error("发送失败");
    }
  };

  const handleGenerate = async () => {
    if (!channelId || !imageGenPrompt.trim()) return;
    setImageGenLoading(true);
    setImageGenPreview(null);
    try {
      const res = await fetch(`${API}/images/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_id: channelId,
          sender_id: senderId,
          prompt: imageGenPrompt.trim(),
          model: imageGenModel,
          size: imageGenSize,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.detail || "图片生成失败");
        return;
      }
      setImageGenPreview({
        file_id: data.data.file_id,
        preview_url: data.data.preview_url,
      });
    } catch (err) {
      toast.error("图片生成出错");
      console.error(err);
    } finally {
      setImageGenLoading(false);
    }
  };

  const handleEdit = async () => {
    if (!channelId || !imageEditSourceFileId || !imageEditPrompt.trim()) return;
    setImageEditLoading(true);
    setImageEditPreview(null);
    try {
      const res = await fetch(`${API}/images/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_id: channelId,
          sender_id: senderId,
          source_file_id: imageEditSourceFileId,
          prompt: imageEditPrompt.trim(),
          model: imageEditModel,
          size: imageEditSize,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.detail || "图片编辑失败");
        return;
      }
      setImageEditPreview({
        file_id: data.data.file_id,
        preview_url: data.data.preview_url,
      });
    } catch (err) {
      toast.error("图片编辑出错");
      console.error(err);
    } finally {
      setImageEditLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="AI 图片"
      maxWidth="max-w-lg"
    >
      <div className="-mx-5 -my-4">
        {/* Tab 切换 */}
        <div className="flex border-b border-gray-100">
          <button
            type="button"
            onClick={() => setImageGenTab("gen")}
            className={`flex-1 py-2.5 text-[13px] font-medium text-center transition-colors ${imageGenTab === "gen" ? "text-[#1264A3] border-b-2 border-[#1264A3]" : "text-gray-500 hover:text-gray-700"}`}
          >
            文生图
          </button>
          <button
            type="button"
            onClick={() => setImageGenTab("edit")}
            className={`flex-1 py-2.5 text-[13px] font-medium text-center transition-colors ${imageGenTab === "edit" ? "text-[#1264A3] border-b-2 border-[#1264A3]" : "text-gray-500 hover:text-gray-700"}`}
          >
            图生图
          </button>
        </div>

        {/* ─── 文生图 Tab ─── */}
        {imageGenTab === "gen" && (
          <>
            <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
              <div>
                <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                  描述词
                </label>
                <textarea
                  value={imageGenPrompt}
                  onChange={(e) => setImageGenPrompt(e.target.value)}
                  placeholder="描述你想要生成的图片，例如：一只在星空下奔跑的白色猫咪"
                  className="w-full px-3 py-2 border border-gray-200 rounded-xl text-[14px] resize-none outline-none focus:border-gray-400 min-h-[80px]"
                  rows={3}
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                    模型
                  </label>
                  <select
                    value={imageGenModel}
                    onChange={(e) => setImageGenModel(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-xl text-[13px] outline-none focus:border-gray-400 bg-white"
                  >
                    <option value="qwen-image-2.0-pro">qwen-image-2.0-pro (推荐)</option>
                    <option value="qwen-image-2.0-pro-2026-03-03">qwen-image-2.0-pro-2026-03-03</option>
                    <option value="qwen-image-2.0">qwen-image-2.0</option>
                    <option value="qwen-image-2.0-2026-03-03">qwen-image-2.0-2026-03-03</option>
                    <option value="qwen-image-max">qwen-image-max</option>
                    <option value="qwen-image-max-2025-12-30">qwen-image-max-2025-12-30</option>
                    <option value="qwen-image-plus-2026-01-09">qwen-image-plus-2026-01-09</option>
                    <option value="z-image-turbo">z-image-turbo (快速)</option>
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                    尺寸
                  </label>
                  <select
                    value={imageGenSize}
                    onChange={(e) => setImageGenSize(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-xl text-[13px] outline-none focus:border-gray-400 bg-white"
                  >
                    <option value="1024*1024">1024 x 1024</option>
                    <option value="720*1280">720 x 1280 (竖版)</option>
                    <option value="1280*720">1280 x 720 (横版)</option>
                    <option value="768*1024">768 x 1024</option>
                    <option value="1024*768">1024 x 768</option>
                  </select>
                </div>
              </div>
            </div>
            {imageGenPreview && (
              <div className="px-5 py-3 border-t border-gray-100">
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <img
                    src={`${API}/files/${imageGenPreview.file_id}/preview`}
                    alt="AI generated"
                    className="w-full max-h-[300px] object-contain bg-gray-50"
                  />
                </div>
              </div>
            )}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100 bg-gray-50">
              {imageGenPreview && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setImageEditSourceFileId(imageGenPreview.file_id);
                      setImageGenTab("edit");
                      setImageEditPreview(null);
                      setImageEditPrompt("");
                    }}
                    className="px-4 py-1.5 rounded-xl text-[13px] font-semibold bg-gray-600 text-white hover:bg-gray-700 shadow-sm transition-all"
                  >
                    用此图编辑
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      postMessage(
                        `[AI 生成图片] ${imageGenPrompt}`,
                        imageGenPreview.file_id,
                      )
                    }
                    className="px-4 py-1.5 rounded-xl text-[13px] font-semibold bg-[#007a5a] text-white hover:bg-[#006a4d] shadow-sm transition-all"
                  >
                    发送到频道
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={!imageGenPrompt.trim() || imageGenLoading}
                onClick={handleGenerate}
                className={`px-4 py-1.5 rounded-xl text-[13px] font-semibold transition-all ${imageGenPrompt.trim() && !imageGenLoading ? "bg-[#1264A3] text-white hover:bg-[#0e5a96] shadow-sm" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}
              >
                {imageGenLoading
                  ? "生成中..."
                  : imageGenPreview
                    ? "重新生成"
                    : "生成"}
              </button>
            </div>
          </>
        )}

        {/* ─── 图生图 Tab ─── */}
        {imageGenTab === "edit" && (
          <>
            <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
              <div>
                <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                  源图片
                </label>
                {imageEditSourceFileId ? (
                  <div className="relative border border-gray-200 rounded-xl overflow-hidden bg-gray-50">
                    <img
                      src={`${API}/files/${imageEditSourceFileId}/preview`}
                      alt="source"
                      className="w-full max-h-[200px] object-contain"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setImageEditSourceFileId("");
                        setImageEditPreview(null);
                      }}
                      className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/50 text-white flex items-center justify-center text-xs hover:bg-black/70"
                    >
                      <XMarkIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="border-2 border-dashed border-gray-200 rounded-xl p-4 text-center text-gray-400 text-[13px] space-y-3">
                    {(() => {
                      const imageFiles = messages.flatMap((m) =>
                        (m.files || []).filter((f) =>
                          (f.content_type || "").startsWith("image/"),
                        ),
                      );
                      if (imageFiles.length > 0) {
                        return (
                          <div>
                            <p className="text-gray-500 mb-2">
                              从聊天中选择图片：
                            </p>
                            <div className="flex flex-wrap gap-2 justify-center">
                              {imageFiles.slice(-8).map((f) => (
                                <div
                                  key={f.file_id}
                                  className="w-16 h-16 rounded-lg border-2 border-gray-200 overflow-hidden cursor-pointer hover:border-blue-400 transition-colors"
                                  onClick={() => {
                                    setImageEditSourceFileId(f.file_id);
                                    setImageEditPreview(null);
                                  }}
                                >
                                  <img
                                    src={`${API}/files/${f.file_id}/preview`}
                                    alt={f.original_filename || "image"}
                                    className="w-full h-full object-cover"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      }
                      return (
                        <p>当前频道暂无图片，请先上传或生成一张图片</p>
                      );
                    })()}
                    <p className="text-[11px] text-gray-300">
                      也可在聊天中点击图片放大后选择「编辑此图」
                    </p>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                  编辑描述
                </label>
                <textarea
                  value={imageEditPrompt}
                  onChange={(e) => setImageEditPrompt(e.target.value)}
                  placeholder="描述你想要如何编辑这张图片，例如：将背景改为夕阳海滩"
                  className="w-full px-3 py-2 border border-gray-200 rounded-xl text-[14px] resize-none outline-none focus:border-gray-400 min-h-[80px]"
                  rows={3}
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                    模型
                  </label>
                  <select
                    value={imageEditModel}
                    onChange={(e) => setImageEditModel(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-xl text-[13px] outline-none focus:border-gray-400 bg-white"
                  >
                    <option value="qwen-image-edit-max">qwen-image-edit-max (推荐)</option>
                    <option value="qwen-image-edit-plus">qwen-image-edit-plus</option>
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                    尺寸
                  </label>
                  <select
                    value={imageEditSize}
                    onChange={(e) => setImageEditSize(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-xl text-[13px] outline-none focus:border-gray-400 bg-white"
                  >
                    <option value="1024*1024">1024 x 1024</option>
                    <option value="720*1280">720 x 1280 (竖版)</option>
                    <option value="1280*720">1280 x 720 (横版)</option>
                    <option value="768*1024">768 x 1024</option>
                    <option value="1024*768">1024 x 768</option>
                  </select>
                </div>
              </div>
            </div>
            {imageEditPreview && (
              <div className="px-5 py-3 border-t border-gray-100">
                <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                  编辑结果
                </label>
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <img
                    src={`${API}/files/${imageEditPreview.file_id}/preview`}
                    alt="edited"
                    className="w-full max-h-[300px] object-contain bg-gray-50"
                  />
                </div>
              </div>
            )}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100 bg-gray-50">
              {imageEditPreview && (
                <button
                  type="button"
                  onClick={() =>
                    postMessage(
                      `[AI 编辑图片] ${imageEditPrompt}`,
                      imageEditPreview.file_id,
                    )
                  }
                  className="px-4 py-1.5 rounded-xl text-[13px] font-semibold bg-[#007a5a] text-white hover:bg-[#006a4d] shadow-sm transition-all"
                >
                  发送到频道
                </button>
              )}
              <button
                type="button"
                disabled={
                  !imageEditSourceFileId ||
                  !imageEditPrompt.trim() ||
                  imageEditLoading
                }
                onClick={handleEdit}
                className={`px-4 py-1.5 rounded-xl text-[13px] font-semibold transition-all ${imageEditSourceFileId && imageEditPrompt.trim() && !imageEditLoading ? "bg-[#1264A3] text-white hover:bg-[#0e5a96] shadow-sm" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}
              >
                {imageEditLoading
                  ? "编辑中..."
                  : imageEditPreview
                    ? "重新编辑"
                    : "开始编辑"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
