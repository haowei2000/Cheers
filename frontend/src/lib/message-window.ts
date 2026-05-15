import type { Message } from "../types";

export const MAX_LOADED_MESSAGES = 800;
export const VIRTUAL_MESSAGE_ESTIMATED_HEIGHT = 118;

const VIRTUAL_MESSAGE_MIN_ROWS = 120;
const VIRTUAL_MESSAGE_OVERSCAN_ROWS = 12;

export type PendingStreamDelta = {
  delta: string;
  chunks: number;
};

export type VirtualMessageWindow = {
  enabled: boolean;
  startIndex: number;
  endIndex: number;
  paddingTop: number;
  paddingBottom: number;
};

export function trimToRecentMessages(messages: Message[]): Message[] {
  if (messages.length <= MAX_LOADED_MESSAGES) return messages;
  return messages.slice(-MAX_LOADED_MESSAGES);
}

export function getVirtualMessageWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
): VirtualMessageWindow {
  if (rowCount <= VIRTUAL_MESSAGE_MIN_ROWS) {
    return {
      enabled: false,
      startIndex: 0,
      endIndex: rowCount,
      paddingTop: 0,
      paddingBottom: 0,
    };
  }

  const visibleRows = Math.max(
    1,
    Math.ceil(Math.max(viewportHeight, VIRTUAL_MESSAGE_ESTIMATED_HEIGHT) / VIRTUAL_MESSAGE_ESTIMATED_HEIGHT),
  );
  const windowRows = visibleRows + VIRTUAL_MESSAGE_OVERSCAN_ROWS * 2;
  const maxStartIndex = Math.max(0, rowCount - windowRows);
  const startIndex = Math.min(
    maxStartIndex,
    Math.max(
      0,
      Math.floor(Math.max(0, scrollTop) / VIRTUAL_MESSAGE_ESTIMATED_HEIGHT) - VIRTUAL_MESSAGE_OVERSCAN_ROWS,
    ),
  );
  const endIndex = Math.min(rowCount, startIndex + windowRows);

  return {
    enabled: true,
    startIndex,
    endIndex,
    paddingTop: startIndex * VIRTUAL_MESSAGE_ESTIMATED_HEIGHT,
    paddingBottom: Math.max(0, rowCount - endIndex) * VIRTUAL_MESSAGE_ESTIMATED_HEIGHT,
  };
}
