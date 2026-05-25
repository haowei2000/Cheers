/* HelpModal — onboarding help dialog. Canonical example of how to compose
 * a modal in this codebase: build on the shared <Modal> primitive (Headless
 * UI Dialog under the hood), and use semantic CSS variables for theming. */
import { Modal, ModalFooter } from "./Modal";

interface HelpModalProps {
  open: boolean;
  onClose: () => void;
  apiDocsUrl: string;
  userDocsUrl: string;
}

export function HelpModal({ open, onClose, apiDocsUrl, userDocsUrl }: HelpModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Help">
      <p className="text-sm mb-3" style={{ color: "var(--fg-2)" }}>
        In any channel, type <strong>@Coordinator</strong> with your question. The assistant will answer from the manual and show relevant entry points.
      </p>
      <p className="text-xs mb-2" style={{ color: "var(--fg-3)" }}>
        Example questions:
      </p>
      <ul
        className="text-sm space-y-1 list-disc list-inside mb-2"
        style={{ color: "var(--fg-2)" }}
      >
        <li>@Coordinator how to use this</li>
        <li>@Coordinator how to create a group</li>
        <li>@Coordinator how to join a group</li>
        <li>@Coordinator how to connect Agent Bridge</li>
        <li>@Coordinator entry points</li>
      </ul>
      <p className="text-xs mb-2" style={{ color: "var(--fg-3)" }}>
        Frontend entry points:
      </p>
      <ul
        className="text-sm space-y-1 list-disc list-inside mb-4"
        style={{ color: "var(--fg-2)" }}
      >
        <li>
          Bots, models, and templates: open <strong>Settings</strong>
        </li>
        <li>
          Upload files: use <strong>Upload</strong>
          (.txt/.md/.html/.docx/.xlsx/.pptx/.pdf/.png/.jpg, etc.)
        </li>
        <li>
          Channel context: select a channel, then click <strong>Channel context</strong>
        </li>
        <li>
          User docs: open{" "}
          <a
            href={userDocsUrl}
            className="underline"
            style={{ color: "var(--accent)" }}
          >
            /user-docs
          </a>
        </li>
        <li>
          API docs: open{" "}
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
        See user docs for full instructions.
      </p>
      <ModalFooter>
        <button type="button" onClick={onClose} className="an-btn an-btn-ghost">
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}
