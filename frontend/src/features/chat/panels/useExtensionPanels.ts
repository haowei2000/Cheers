import { useEffect, useState } from "react";
import { listExtensions } from "@/features/chat/workbench/extensions/api";
import { registerExtensionPanels } from "./extensionPanels";

// Registration is global and idempotent, so this runs once per session however many
// components call it. The returned revision exists only to re-render callers once the
// contributions land — `panelsFor` reads the module registry directly.
let loaded = false;

/** Load installed packages' declarative panels into the registry.
 *
 * Called from the channel view rather than from the ViewBoard drawer, because the
 * toolbar's Panels picker lists contributed boards too — and a board nobody can find
 * until they first open the drawer it lives behind is not discoverable, which was the
 * whole point of listing it. */
export function useExtensionPanels(): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (loaded) return;
    loaded = true;
    listExtensions()
      .then((extensions) => {
        registerExtensionPanels(extensions);
        setRevision((current) => current + 1);
      })
      .catch(() => {
        // A gateway that cannot list extensions just means no contributed panels.
        loaded = false;
      });
  }, []);

  return revision;
}
