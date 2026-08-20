import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ItemGallery } from "@/components/ui/ItemGallery";
import { ThemeProvider } from "@/components/ui/theme";
import { TitleTooltip } from "@/components/ui/title-tooltip";
import "@/index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <ItemGallery />
      <TitleTooltip />
    </ThemeProvider>
  </StrictMode>
);
