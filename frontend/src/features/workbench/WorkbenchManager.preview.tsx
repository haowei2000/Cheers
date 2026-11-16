import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { strToU8, zipSync } from "fflate";
import { ThemeProvider } from "@/components/ui/theme";
import { WorkbenchManager } from "./WorkbenchManager";
import "@/index.css";

// A native command fixture: no installed packages or machine files are changed.
async function main() {
  const bytes = zipSync({ "manifest.json": strToU8(JSON.stringify({ schemaVersion: 1, id: "preview-notes", version: "1.0.0", title: "Preview Notes", contributes: {} })) });
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const contentBase64 = btoa(String.fromCharCode(...bytes));
  const preview = { removeCalls: 0, failUninstall: true, removed: false };
  Object.assign(window, { isTauri: true, workbenchPreview: preview });
  localStorage.setItem("cheers.workbench.disabled-personal-extensions", '["preview-notes"]');
  mockIPC(async command => {
    if (command === "extensions_list") return preview.removed ? [] : [{ id: "preview-notes", sha256, contentBase64 }];
    if (command === "extensions_remove") {
      ++preview.removeCalls;
      await new Promise(resolve => setTimeout(resolve, 300));
      if (preview.failUninstall) throw new Error("The package could not be removed. Try again.");
      preview.removed = true;
      return;
    }
    throw new Error(`Unsupported preview command: ${command}`);
  });
  createRoot(document.getElementById("root")!).render(<ThemeProvider><main className="min-h-screen bg-canvas p-4 text-content-primary"><WorkbenchManager /></main></ThemeProvider>);
}
void main();
