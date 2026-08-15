import { defineRenderer } from "@haowei0520/cheers-workbench-sdk";

defineRenderer({
  activate(ctx) {
    const editor = document.createElement("textarea");
    editor.setAttribute("aria-label", "Shared Markdown notes");
    editor.spellcheck = true;
    document.querySelector("#root")?.append(editor);

    let rendered = "";
    ctx.file.onRender((file) => {
      rendered = file.content;
      if (document.activeElement !== editor) editor.value = file.content;
    });

    const save = () => {
      if (editor.value !== rendered) void ctx.file.save(editor.value);
    };
    editor.addEventListener("change", save);

    return () => editor.removeEventListener("change", save);
  },
});
