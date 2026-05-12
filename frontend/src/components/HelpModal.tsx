/* HelpModal — onboarding help dialog. Canonical example of how to compose
 * a modal in this codebase: build on the shared <Modal> primitive (Headless
 * UI Dialog under the hood), and use semantic CSS variables for theming. */
import { Modal, ModalFooter } from "./Modal";

interface HelpModalProps {
  open: boolean;
  onClose: () => void;
  apiDocsUrl: string;
}

export function HelpModal({ open, onClose, apiDocsUrl }: HelpModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="使用帮助">
      <p className="text-sm mb-3" style={{ color: "var(--fg-2)" }}>
        在任意频道输入 <strong>@Coordinator</strong> 并输入你的问题，协作助手会根据说明书自动回复，并显示相关入口。
      </p>
      <p className="text-xs mb-2" style={{ color: "var(--fg-3)" }}>
        例如可以问：
      </p>
      <ul
        className="text-sm space-y-1 list-disc list-inside mb-2"
        style={{ color: "var(--fg-2)" }}
      >
        <li>@Coordinator 怎么用</li>
        <li>@Coordinator 怎么创建项目</li>
        <li>@Coordinator 怎么加入项目</li>
        <li>@Coordinator 怎么接入 Agent Bridge</li>
        <li>@Coordinator 入口</li>
      </ul>
      <p className="text-xs mb-2" style={{ color: "var(--fg-3)" }}>
        前端入口：
      </p>
      <ul
        className="text-sm space-y-1 list-disc list-inside mb-4"
        style={{ color: "var(--fg-2)" }}
      >
        <li>
          Bot、模型与模板：左下角齿轮进入 <strong>设置</strong>
        </li>
        <li>
          上传文件：频道内输入框旁 <strong>上传</strong>
          （.txt/.md/.docx/.pdf/.xlsx/.png/.jpg 等）
        </li>
        <li>
          频道上下文：选中频道后点击 <strong>频道上下文</strong>
        </li>
        <li>
          API 文档：打开{" "}
          <a
            href={apiDocsUrl}
            target="_blank"
            rel="noreferrer"
            className="underline"
            style={{ color: "var(--accent)" }}
          >
            /docs
          </a>
        </li>
      </ul>
      <p className="text-xs" style={{ color: "var(--fg-3)" }}>
        完整说明见项目文档。
      </p>
      <ModalFooter>
        <button type="button" onClick={onClose} className="an-btn an-btn-ghost">
          关闭
        </button>
      </ModalFooter>
    </Modal>
  );
}
