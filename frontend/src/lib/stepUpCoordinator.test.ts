import { describe, expect, it } from "vitest";
import {
  cancelStepUp,
  completeStepUp,
  hasPendingStepUp,
  pendingStepUpActionClass,
  requestStepUp,
  StepUpCancelledError,
} from "./stepUpCoordinator";

describe("StepUpCoordinator", () => {
  it("shares one confirmation across concurrent requests", async () => {
    const first = requestStepUp("bot_token_issue");
    const second = requestStepUp("host_activation");
    expect(hasPendingStepUp()).toBe(true);
    expect(pendingStepUpActionClass()).toBe("multiple_sensitive_actions");
    completeStepUp();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(hasPendingStepUp()).toBe(false);
  });

  it("rejects every waiting request when the user cancels", async () => {
    const first = requestStepUp();
    const second = requestStepUp();
    cancelStepUp();
    await expect(first).rejects.toBeInstanceOf(StepUpCancelledError);
    await expect(second).rejects.toBeInstanceOf(StepUpCancelledError);
  });
});
