import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ItemGallery } from "@/components/ui/ItemGallery";
import { ThemeProvider } from "@/components/ui/theme";
import "@/index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <ItemGallery />
    </ThemeProvider>
  </StrictMode>
);
