import type { Capability } from "@/api/bots";

/**
 * Cheers-facing vocabulary for the permission-grant matrix.
 *
 * The backend's grant rows are keyed by raw ACP-derived event classes
 * (`workspace_write`, `set_config_option`, `prompt`, …— see
 * server/src/domain/acp_events.rs REGISTRY). Those ids are precise but mean
 * nothing to a channel owner. This maps each (capability, event_class) to what
 * the grant actually lets a person DO in Cheers ("Remote file write", "Message
 * the bot"). Unknown classes fall back to the raw id so a registry addition
 * never renders as a blank — it just shows unlabeled until added here.
 */

export interface GrantLabel {
  /** Short human name shown in lists/dropdowns. */
  label: string;
  /** One-line explanation shown as help text / tooltip. */
  desc: string;
}

/** Human name for each capability axis (raw id stays in tooltips). */
export const CAPABILITY_LABEL: Record<Capability, GrantLabel> = {
  initiate: { label: "Do", desc: "Actions a person may take on the bot" },
  see: { label: "View", desc: "Bot activity a person may see" },
  respond: { label: "Answer", desc: "Bot requests a person may answer" },
};

/** Labels keyed by event_class (capability-independent unless overridden below). */
const EVENT_LABEL: Record<string, GrantLabel> = {
  // ── INITIATE: user→bot actions ──────────────────────────────────────────────
  prompt: {
    label: "Message the bot",
    desc: "Send messages that trigger the bot to run",
  },
  cancel: {
    label: "Cancel a running task",
    desc: "Stop the bot's in-progress turn",
  },
  set_mode: {
    label: "Switch approval mode",
    desc: "Change how the agent asks for permission (its ACP session mode)",
  },
  set_config_option: {
    label: "Change agent settings",
    desc: "Set the agent's advertised options (model, reasoning level, …)",
  },
  session_create: {
    label: "Create extra sessions",
    desc: "Open an additional bot session in a channel",
  },
  session_close: {
    label: "Close sessions",
    desc: "Close or terminate a bot session",
  },
  workspace_write: {
    label: "Remote file write",
    desc: "Write files onto the bot's machine via the workspace browser",
  },
  // ── SEE: agent→user streams ─────────────────────────────────────────────────
  output: {
    label: "Bot replies",
    desc: "The bot's streamed reply text",
  },
  thought: {
    label: "Thinking",
    desc: "The agent's reasoning stream",
  },
  tool_call: {
    label: "Tool activity",
    desc: "Tool calls the agent runs (commands, edits, fetches)",
  },
  plan: {
    label: "Plans",
    desc: "The agent's plan updates",
  },
  available_commands: {
    label: "Command list",
    desc: "Slash-commands the agent advertises",
  },
  current_mode: {
    label: "Mode changes",
    desc: "Notices that the agent's approval mode changed",
  },
  config_option: {
    label: "Setting changes",
    desc: "Notices that an agent setting changed",
  },
  usage: {
    label: "Usage stats",
    desc: "Token / usage updates from the agent",
  },
  permission_request: {
    label: "Approval requests",
    desc: "Permission cards the agent raises for risky actions",
  },
};

/** Capability-specific overrides where the same event class reads differently. */
const CAP_EVENT_LABEL: Partial<Record<Capability, Record<string, GrantLabel>>> = {
  respond: {
    permission_request: {
      label: "Answer approval requests",
      desc: "Approve or deny the agent's permission cards",
    },
  },
};

/** Resolve the Cheers-facing label for a grant row; falls back to the raw id. */
export function grantLabel(capability: Capability, eventClass: string): GrantLabel {
  return (
    CAP_EVENT_LABEL[capability]?.[eventClass] ??
    EVENT_LABEL[eventClass] ?? { label: eventClass, desc: "" }
  );
}
