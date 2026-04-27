/* Modal — base dialog component built on Headless UI's <Dialog>.
 *
 * Provides for free (replaces ~30 lines of bespoke handling per modal):
 *   - Focus trap + initial focus management
 *   - Escape-to-close + click-outside-to-close
 *   - Scroll lock on the underlying body
 *   - Proper ARIA roles + labelling via <DialogTitle>
 *   - Enter/leave transitions
 *
 * Every new modal in this codebase should compose against this primitive
 * instead of hand-rolling overlay + escape-handler + focus-trap logic.
 *
 * Usage:
 *   <Modal open={isOpen} onClose={() => setOpen(false)} title="标题">
 *     <p>body…</p>
 *     <ModalFooter>
 *       <button …>取消</button>
 *       <button …>确认</button>
 *     </ModalFooter>
 *   </Modal>
 */
import { Fragment, type ReactNode } from "react";
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  Transition,
  TransitionChild,
} from "@headlessui/react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { cn } from "../lib/cn";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Optional title shown in the header row; if omitted, no header renders. */
  title?: ReactNode;
  /** Optional description shown under the title. */
  description?: ReactNode;
  /** Tailwind max-width utility. Defaults to a comfortable reading width. */
  maxWidth?: string;
  /** Hide the built-in close (×) button, e.g. when the dialog enforces its
   *  own dismissal flow. */
  hideCloseButton?: boolean;
  /** Extra classes appended to the dialog panel. */
  panelClassName?: string;
  children: ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  maxWidth = "max-w-md",
  hideCloseButton = false,
  panelClassName,
  children,
}: ModalProps) {
  return (
    <Transition show={open} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
        {/* Backdrop */}
        <TransitionChild
          as={Fragment}
          enter="ease-out duration-150"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-100"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-[1px]"
            aria-hidden="true"
          />
        </TransitionChild>

        {/* Panel container */}
        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <TransitionChild
              as={Fragment}
              enter="ease-out duration-150"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-100"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel
                className={cn(
                  "w-full rounded-xl shadow-xl border",
                  maxWidth,
                  panelClassName,
                )}
                style={{
                  background: "var(--bg-1)",
                  borderColor: "var(--border)",
                  color: "var(--fg-1)",
                }}
              >
                {(title || !hideCloseButton) && (
                  <div
                    className="flex items-start gap-3 px-5 py-4 border-b"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <div className="flex-1 min-w-0">
                      {title && (
                        <DialogTitle
                          className="text-base font-semibold leading-snug"
                          style={{ color: "var(--fg-1)" }}
                        >
                          {title}
                        </DialogTitle>
                      )}
                      {description && (
                        <div
                          className="mt-1 text-xs leading-relaxed"
                          style={{ color: "var(--fg-3)" }}
                        >
                          {description}
                        </div>
                      )}
                    </div>
                    {!hideCloseButton && (
                      <button
                        type="button"
                        onClick={onClose}
                        className="flex-shrink-0 rounded-md p-1 hover:bg-[var(--surface-soft)] transition-colors"
                        style={{ color: "var(--fg-3)" }}
                        aria-label="关闭"
                      >
                        <XMarkIcon className="w-5 h-5" />
                      </button>
                    )}
                  </div>
                )}
                <div className="px-5 py-4">{children}</div>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}

/** Right-aligned action row meant for placement at the bottom of a Modal body. */
export function ModalFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mt-5 flex items-center justify-end gap-2 pt-3 border-t",
        className,
      )}
      style={{ borderColor: "var(--border)" }}
    >
      {children}
    </div>
  );
}
