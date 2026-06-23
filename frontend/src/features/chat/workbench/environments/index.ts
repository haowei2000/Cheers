// Template barrel.
//
// Templates are NO LONGER compiled in — they are standalone manifest JSON files
// installed at runtime by dropping them into the workbench (which writes them to
// `.workbench/templates/` in the channel; see loadWorkspaceTemplates). An example
// plugin lives at `examples/research.json`.
//
// (If you ever want a template bundled by default, add `import "./<name>";` here
//  and have that folder call registerEnvironment — but the model is drop-to-install.)
export {};
