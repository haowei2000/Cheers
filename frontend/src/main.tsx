import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "react-hot-toast";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import AdminPage from "./AdminPage";
import DocsPage from "./DocsPage";
import BulletinPage from "./BulletinPage";
import "./styles/design-tokens.css";
import "./styles/composer.css";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Toaster position="top-center" />
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/bulletin" element={<BulletinPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
