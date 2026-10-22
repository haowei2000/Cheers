/** Minimal controlled hook lifecycle for async controller tests in Vitest's Node environment. */
type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
let active: HookHarness | null = null;
const changed = (before: readonly unknown[] | undefined, after: readonly unknown[] | undefined) =>
  !before || !after || before.length !== after.length || before.some((value, index) => !Object.is(value, after[index]));
class HookHarness {
  slots: Slot[] = [];
  cursor = 0;
  effects: Array<() => void> = [];
  render<T>(render: () => T): T {
    this.cursor = 0;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Hook mocks need the currently executing test render.
    active = this;
    let result: T;
    try { result = render(); } finally { active = null; }
    const effects = this.effects.splice(0);
    for (const effect of effects) effect();
    return result;
  }
  unmount() { for (const slot of this.slots) slot.cleanup?.(); }
}
export const createHookHarness = () => new HookHarness();
function next() {
  if (!active) throw new Error("Render hooks through the controlled harness");
  const harness = active;
  const index = harness.cursor++;
  return { harness, index, slot: harness.slots[index] };
}
export function useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void] {
  const { harness, index, slot } = next();
  if (!slot) harness.slots[index] = { value: typeof initial === "function" ? (initial as () => T)() : initial };
  return [harness.slots[index].value as T, (value) => {
    const previous = harness.slots[index].value as T;
    harness.slots[index].value = typeof value === "function" ? (value as (previous: T) => T)(previous) : value;
  }];
}
export function useRef<T>(initial: T): { current: T } {
  const { harness, index, slot } = next();
  if (!slot) harness.slots[index] = { value: { current: initial } };
  return harness.slots[index].value as { current: T };
}
export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
  const { harness, index, slot } = next();
  if (!slot || changed(slot.deps, deps)) {
    const updated: Slot = { deps, cleanup: slot?.cleanup };
    harness.slots[index] = updated;
    harness.effects.push(() => { updated.cleanup?.(); updated.cleanup = effect() || undefined; });
  }
}
export function useCallback<T>(callback: T, deps: readonly unknown[]): T {
  const { harness, index, slot } = next();
  if (!slot || changed(slot.deps, deps)) harness.slots[index] = { value: callback, deps };
  return harness.slots[index].value as T;
}
export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T {
  const { harness, index, slot } = next();
  if (!slot || changed(slot.deps, deps)) harness.slots[index] = { value: factory(), deps };
  return harness.slots[index].value as T;
}
