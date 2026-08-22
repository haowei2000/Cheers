import { defineRenderer } from "@haowei0520/cheers-workbench-sdk";

let assignedSource = "";

defineRenderer<{ label: string; sourceText: string }>({
  toContext(target) {
    return target;
  },
  activate(ctx) {
    const output = document.createElement("pre");
    document.querySelector("#root")?.append(output);
    ctx.file.onRender(async (file) => {
      assignedSource = file.content;
      const response = await fetch("https://example.com/status.json");
      output.textContent = await response.text();
    });
    const pick = (event: MouseEvent) => ctx.context.pick(event, {
      label: "Status response",
      sourceText: assignedSource,
    });
    output.addEventListener("contextmenu", pick);
    return () => {
      output.removeEventListener("contextmenu", pick);
      output.remove();
    };
  },
});
