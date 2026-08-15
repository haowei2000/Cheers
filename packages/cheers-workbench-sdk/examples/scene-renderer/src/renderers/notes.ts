import { defineRenderer } from "@haowei0520/cheers-workbench-sdk";

defineRenderer({
  activate(ctx) {
    const editor = document.createElement("textarea");
    document.querySelector("#root")?.append(editor);
    ctx.file.onRender((file) => { editor.value = file.content; });
    const save = () => void ctx.file.save(editor.value);
    editor.addEventListener("change", save);
    return () => editor.removeEventListener("change", save);
  },
});
