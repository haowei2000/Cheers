import { useCallback, useEffect, useState } from "react";
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
  };
}
