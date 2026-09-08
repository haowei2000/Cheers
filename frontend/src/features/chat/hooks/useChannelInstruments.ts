import type { SpawnKind } from "../workbench/laneSnap";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import type { ComposerPrefill } from "../MessageComposer";

export function resolveBooleanUpdate(
  current: boolean,
  next: SetStateAction<boolean>,
): boolean {
  return typeof next === "function" ? next(current) : next;
}

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
    localStorage.setItem(
      "cheers.viewboard.minimal",
      viewBoardMinimal ? "1" : "0",
    );
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
  const [composePrefill, setComposePrefill] = useState<ComposerPrefill | null>(
    null,
  );
  const [filesFocus, setFilesFocus] = useState<string>();
  const [laneElement, setLaneElement] = useState<HTMLElement | null>(null);
  const getLaneBounds = useCallback(
    () => laneElement?.getBoundingClientRect() ?? null,
    [laneElement],
  );

  useEffect(() => {
    if (!laneElement || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      window.dispatchEvent(new Event("resize")),
    );
    observer.observe(laneElement);
    return () => observer.disconnect();
  }, [laneElement]);

  // Explicit open requests also activate an already-mounted background tab.
  const [panelRequest, setPanelRequest] = useState<{
    id: SpawnKind;
    nonce: number;
  } | null>(null);
  const activate = useCallback(
    (id: SpawnKind) =>
      setPanelRequest((previous) => ({
        id,
        nonce: (previous?.nonce ?? 0) + 1,
      })),
    [],
  );
  const workbenchOpenRef = useRef(workbenchOpen);
  const viewBoardOpenRef = useRef(viewBoardOpen);
  const workspaceOpenRef = useRef(workspaceOpen);
  const filesOpenRef = useRef(filesOpen);
  workbenchOpenRef.current = workbenchOpen;
  viewBoardOpenRef.current = viewBoardOpen;
  workspaceOpenRef.current = workspaceOpen;
  filesOpenRef.current = filesOpen;
  const openWorkbench = useCallback(
    (next: SetStateAction<boolean>) => {
      const resolved = resolveBooleanUpdate(workbenchOpenRef.current, next);
      workbenchOpenRef.current = resolved;
      setWorkbenchOpen(resolved);
      if (resolved) activate("workbench");
    },
    [activate],
  );
  const openViewBoard = useCallback(
    (next: SetStateAction<boolean>) => {
      const resolved = resolveBooleanUpdate(viewBoardOpenRef.current, next);
      viewBoardOpenRef.current = resolved;
      setViewBoardOpen(resolved);
      if (resolved) activate("viewboard");
    },
    [activate],
  );
  const openWorkspace = useCallback(
    (next: SetStateAction<boolean>) => {
      const resolved = resolveBooleanUpdate(workspaceOpenRef.current, next);
      workspaceOpenRef.current = resolved;
      setWorkspaceOpen(resolved);
      if (resolved) activate("workspace");
    },
    [activate],
  );
  const openFiles = useCallback(
    (next: SetStateAction<boolean>) => {
      const resolved = resolveBooleanUpdate(filesOpenRef.current, next);
      filesOpenRef.current = resolved;
      setFilesOpen(resolved);
      if (resolved) activate("files");
    },
    [activate],
  );

  return {
    panelRequest,
    wbOpen: workbenchOpen,
    setWbOpen: openWorkbench,
    vbOpen: viewBoardOpen,
    setVbOpen: openViewBoard,
    vbMinimal: viewBoardMinimal,
    setVbMinimal: setViewBoardMinimal,
    boardTick,
    setBoardTick,
    workspaceTick,
    setWorkspaceTick,
    workspaceSignal,
    setWorkspaceSignal,
    filesOpen,
    setFilesOpen: openFiles,
    settingsOpen,
    setSettingsOpen,
    wsOpen: workspaceOpen,
    setWsOpen: openWorkspace,
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
