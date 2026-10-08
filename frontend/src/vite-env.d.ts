/// <reference types="vite-plugin-pwa/client" />

declare module "virtual:artifact-react-runtime" {
  const runtime: string;
  export default runtime;
}

// Asset-URL imports resolved by Vite at build time (e.g. the pdf.js worker).
declare module "*?url" {
  const src: string;
  export default src;
}
