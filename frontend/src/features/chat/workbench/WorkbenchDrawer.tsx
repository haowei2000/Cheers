import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { makeFsClient, type SendResourceReq } from "./fsClient";
import { getPanels, type PanelContext } from "./panelRegistry";
import "./panels/FilePanel"; // side-effect: registers the built-in File panel

interface Props {
  open: boolean;
  onClose: () => void;
  channelId: string;
  sendResourceReq: SendResourceReq;
}

// Right-side slide-over: one workbench per channel. Hosts the registered ViewPanels
// (the plugin seam) as tabs; each panel reads/writes the channel workspace via the
// resource client over the already-authed chat socket.
export function WorkbenchDrawer({
  open,
  onClose,
  channelId,
  sendResourceReq,
}: Props) {
  const panels = getPanels();
  const [active, setActive] = useState(panels[0]?.id ?? "");
  const ctx: PanelContext = useMemo(
    () => ({ channelId, fs: makeFsClient(sendResourceReq, channelId) }),
    [channelId, sendResourceReq]
  );
  const activePanel = panels.find((p) => p.id === active) ?? panels[0];

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-40"
          onClick={onClose}
          aria-hidden
        />
      )}
      <aside
        className={`fixed top-0 right-0 h-full w-[480px] max-w-[90vw] bg-zinc-900 border-l border-zinc-800 z-50 flex flex-col transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2 px-3 h-12 border-b border-zinc-800 flex-shrink-0">
          <span className="text-sm font-semibold text-zinc-100">Workbench</span>
          <div className="flex items-center gap-1 ml-2">
            {panels.map((p) => (
              <button
                key={p.id}
                onClick={() => setActive(p.id)}
                className={`px-2 py-0.5 rounded text-xs ${
                  activePanel?.id === p.id
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {p.title}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <button onClick={onClose} title="Close">
            <X className="w-4 h-4 text-zinc-500 hover:text-zinc-200" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          {open && activePanel?.render(ctx)}
        </div>
      </aside>
    </>
  );
}
