import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/ui/theme";
import { ContextActionsProvider } from "@/components/ui/context-actions";
import { Button } from "@/components/ui/button";
import { AnnotationPreviewProvider } from "./previewSupport";
import {
  AnnotationsLauncher,
  useAnnotationSurface,
} from "./AnnotationProvider";
import "@/index.css";
function Sources() {
  const surface = useAnnotationSurface();
  return (
    <main className="p-4 space-y-4 bg-canvas text-content-primary min-h-screen">
      <AnnotationsLauncher />
      <Button
        action="add"
        onClick={() =>
          surface?.open({
            target: {
              kind: "file",
              path: "docs/spec.md",
              anchor: { kind: "text", sourceText: "Timeout is 30 seconds." },
            },
            label: "Timeout specification",
          })
        }
      >
        Annotate file
      </Button>
      <Button
        action="add"
        onClick={() =>
          surface?.open({
            target: {
              kind: "event",
              msg_id: "preview-message",
              event_id: "preview-tool",
              tool_call_id: "preview-tool",
              snapshot: {
                phase: "tool_call",
                title: "Edit timeout config",
                status: "completed",
              },
            },
            label: "Edit timeout config",
          })
        }
      >
        Annotate event
      </Button>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <ContextActionsProvider>
      <AnnotationPreviewProvider>
        <Sources />
      </AnnotationPreviewProvider>
    </ContextActionsProvider>
  </ThemeProvider>,
);
