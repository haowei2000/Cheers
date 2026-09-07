import { createContext, useContext, type ReactNode } from "react";

const ContentActionContext = createContext(false);

/** Management pages keep collection-level actions beside their heading rather
 * than stretching them across a wide content column. Other surfaces retain
 * their existing toolbar allocation. */
export function ContentActionScope({ children }: { children: ReactNode }) {
  return <ContentActionContext.Provider value={true}>{children}</ContentActionContext.Provider>;
}
export function useNearbyContentActions() {
  return useContext(ContentActionContext);
}
