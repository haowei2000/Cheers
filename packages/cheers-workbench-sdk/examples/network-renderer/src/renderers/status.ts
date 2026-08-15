import { defineRenderer } from "@haowei0520/cheers-workbench-sdk";

defineRenderer({
  activate(ctx) {
    const output = document.createElement("pre");
    document.querySelector("#root")?.append(output);
    ctx.file.onRender(async () => {
      const response = await fetch("https://example.com/status.json");
      output.textContent = await response.text();
    });
    return () => output.remove();
  },
});
