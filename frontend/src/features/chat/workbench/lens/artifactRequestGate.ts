import type { InteractionResult, ResourceInteraction } from "../interaction";

export interface ArtifactRequestState {
  pending?: ResourceInteraction;
  busy: boolean;
  result?: InteractionResult;
}

/** Sandbox messages propose requests. Only a trusted host click sends one. */
export function createArtifactRequestGate(
  dispatch: (event: ResourceInteraction) => Promise<InteractionResult>,
  publish: (state: ArtifactRequestState) => void,
) {
  let state: ArtifactRequestState = { busy: false };
  let disposed = false;
  const update = (next: ArtifactRequestState) => {
    state = next;
    if (!disposed) publish(state);
  };
  return {
    activate() { disposed = false; },
    propose(event: ResourceInteraction) {
      if (disposed || state.pending || state.busy) return;
      // Copy input so subsequent sandbox messages cannot replace approved data.
      update({ busy: false, pending: structuredClone(event) });
    },
    async confirm(trusted: boolean) {
      if (!trusted || disposed || state.busy || !state.pending) return;
      const event = state.pending;
      update({ ...state, busy: true, result: undefined });
      let result: InteractionResult;
      try { result = await dispatch(event); }
      catch (error) { result = { ok: false, error: error instanceof Error ? error.message : "Request failed. Try again." }; }
      if (disposed) return;
      // Retain the same invocation id for retry; success consumes the proposal.
      update({ pending: result.ok ? undefined : event, busy: false, result });
    },
    cancel() { if (!state.busy && !disposed) update({ busy: false }); },
    dispose() { disposed = true; },
  };
}
