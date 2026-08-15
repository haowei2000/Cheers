import { useCallback, useEffect, useRef, useState } from "react";
import { LANE_TARGET, type SpawnKind } from "../workbench/laneSnap";
import type { ComposerPrefill } from "../MessageComposer";

export function useChannelInstruments() {
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [viewBoardOpen, setViewBoardOpen] = useState(
    () => localStorage.getItem("cheers.viewboard.open") === "1",
  );
  const [viewBoardMinimal, setViewBoardMinimal] = useState(
    () => localStorage.getItem("cheers.viewboard.minimal") === "1",
  );
  useEffect(() => {
    localStorage.setItem("cheers.viewboard.open", viewBoardOpen ? "1" : "0");
  }, [viewBoardOpen]);
  useEffect(() => {
    localStorage.setItem("cheers.viewboard.minimal", viewBoardMinimal ? "1" : "0");
  }, [viewBoardMinimal]);

  const [boardTick, setBoardTick] = useState<Record<string, number>>({});
  const [workspaceTick, setWorkspaceTick] = useState<
    { seq: number; botId: string | null } | undefined
  >();
  const [workspaceSignal, setWorkspaceSignal] = useState<{
    botId: string;
    root: string;
    paths: string[];
    seq: number;
  } | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceInitial, setWorkspaceInitial] = useState<{
    botId?: string;
    path?: string;
    line?: number;
  }>({});
  const [composePrefill, setComposePrefill] = useState<ComposerPrefill | null>(null);
  const [filesFocus, setFilesFocus] = useState<string>();
  const [laneElement, setLaneElement] = useState<HTMLElement | null>(null);
  const getLaneBounds = useCallback(
    () => laneElement?.getBoundingClientRect() ?? null,
    [laneElement],
  );
  const [laneWidth, setLaneWidth] = useState(() => {
    const stored = Number(localStorage.getItem("cheers.lane.width"));
    return Number.isFinite(stored) && stored > 0 ? stored : 520;
  });
  const laneWidthRef = useRef(laneWidth);
  laneWidthRef.current = laneWidth;
  const commitLaneWidth = useCallback(() => {
    try {
      localStorage.setItem("cheers.lane.width", String(laneWidthRef.current));
    } catch {
      // Private mode keeps the current in-memory width.
    }
  }, []);
  const ensureLaneFor = useCallback(
    (kind: SpawnKind) => {
      const target = LANE_TARGET[kind];
      const rowWidth =
        laneElement?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
      const minChatWidth = rowWidth < 1100 ? 320 : 384;
      const maxLaneWidth = Math.max(280, rowWidth - minChatWidth);
      const next = Math.min(Math.max(target, laneWidthRef.current), maxLaneWidth);
      if (next <= laneWidthRef.current) return;
      setLaneWidth(next);
      laneWidthRef.current = next;
      try {
        localStorage.setItem("cheers.lane.width", String(next));
      } catch {
        // Private mode keeps the current in-memory width.
      }
    },
    [laneElement],
  );
  const openInstrument = useCallback(
    (kind: SpawnKind, mode: "open" | "toggle", currentlyOpen: boolean) => {
      const willOpen = mode === "open" || !currentlyOpen;
      if (willOpen) ensureLaneFor(kind);
      return willOpen;
    },
    [ensureLaneFor],
  );

  useEffect(() => {
    if (!laneElement || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => window.dispatchEvent(new Event("resize")));
    observer.observe(laneElement);
    return () => observer.disconnect();
  }, [laneElement]);

  return {
    wbOpen: workbenchOpen,
    setWbOpen: setWorkbenchOpen,
    vbOpen: viewBoardOpen,
    setVbOpen: setViewBoardOpen,
    vbMinimal: viewBoardMinimal,
    setVbMinimal: setViewBoardMinimal,
    boardTick,
    setBoardTick,
    workspaceTick,
    setWorkspaceTick,
    workspaceSignal,
    setWorkspaceSignal,
    filesOpen,
    setFilesOpen,
    settingsOpen,
    setSettingsOpen,
    wsOpen: workspaceOpen,
    setWsOpen: setWorkspaceOpen,
    wsInit: workspaceInitial,
    setWsInit: setWorkspaceInitial,
    composePrefill,
    setComposePrefill,
    filesFocus,
    setFilesFocus,
    laneEl: laneElement,
    setLaneEl: setLaneElement,
    getLaneBounds,
    laneWidth,
    setLaneWidth,
    commitLaneWidth,
    openInstrument,
  };
}
