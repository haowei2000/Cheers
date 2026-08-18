// Labels for the fixed 128px `iconText` slot. Budget: at most two words and
// eight characters, so nothing truncates. Enforced in control-geometry.test.tsx.
export const slotActionLabels = {
  accept: "Accept",
  activate: "Activate",
  add: "Add",
  approve: "Approve",
  cancel: "Cancel",
  back: "Back",
  check: "Check",
  changePassword: "Password",
  choose: "Choose",
  clear: "Clear",
  close: "Close",
  connect: "Connect",
  continue: "Continue",
  copy: "Copy",
  create: "Create",
  decline: "Decline",
  delete: "Delete",
  disconnect: "Unlink",
  diffStaged: "Staged",
  diffWorking: "Working",
  discard: "Discard",
  disable: "Turn off",
  dismiss: "Dismiss",
  done: "Done",
  edit: "Edit",
  enable: "Turn on",
  generate: "Generate",
  install: "Install",
  installHere: "This Mac",
  invite: "Invite",
  issue: "Issue",
  join: "Join",
  leave: "Leave",
  link: "Link",
  lookup: "Look up",
  manage: "Manage",
  more: "More",
  mention: "Mention",
  modes: "Modes",
  mute: "Mute",
  open: "Open",
  openPr: "Open PR",
  pin: "Pin",
  preview: "Preview",
  refresh: "Refresh",
  reject: "Reject",
  reload: "Reload",
  remove: "Remove",
  replace: "Replace",
  reset: "Reset",
  resolve: "Resolve",
  restart: "Restart",
  retry: "Retry",
  rotate: "Rotate",
  request: "Request",
  review: "Review",
  revoke: "Revoke",
  save: "Save",
  search: "Search",
  send: "Send",
  setup: "Set up",
  signIn: "Sign in",
  signOut: "Sign out",
  start: "Start",
  stop: "Stop",
  suspend: "Suspend",
  switch: "Switch",
  test: "Test",
  transcribe: "Convert",
  unlink: "Unlink",
  unmute: "Unmute",
  uninstall: "Remove",
  unblock: "Unblock",
  upload: "Upload",
  unpin: "Unpin",
  download: "Download",
  collapse: "Collapse",
  expand: "Expand",
  forgotPassword: "Recovery",
  forward: "Forward",
  manageTwoFactor: "2FA",
  update: "Update",
  upgrade: "Upgrade",
  verify: "Verify",
  watch: "Watch",
} as const;

// Actions that only ever render on `controlWidth="fill"` buttons, where the
// slot budget does not apply. Keep this list short: it exists for copy that
// genuinely cannot be abbreviated — provider sign-in wording is prescribed by
// Apple's and Google's branding terms, and "Upgrade all" has to keep its
// scope visible because it acts on every agent at once.
export const fillActionLabels = {
  continueWithApple: "Continue with Apple",
  continueWithGoogle: "Continue with Google",
  upgradeAll: "Upgrade all",
} as const;

export const actionLabels = { ...slotActionLabels, ...fillActionLabels } as const;

export type SlotActionKey = keyof typeof slotActionLabels;
export type FillActionKey = keyof typeof fillActionLabels;
export type ActionKey = SlotActionKey | FillActionKey;

export function isFillActionKey(action: ActionKey): action is FillActionKey {
  return action in fillActionLabels;
}

export function actionLabel(action: ActionKey): string {
  return actionLabels[action];
}
