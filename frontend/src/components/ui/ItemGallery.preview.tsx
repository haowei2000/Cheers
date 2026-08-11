import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ItemGallery } from "@/components/ui/ItemGallery";
import "@/index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ItemGallery />
  </StrictMode>
);
