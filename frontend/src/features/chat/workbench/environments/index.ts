// Template barrel.
//
// Templates are NO LONGER compiled in — they are standalone manifest JSON files.
// They come in two flavors at runtime: GLOBAL (admin-installed server-level, fetched
// via templatesApi) and SESSION (temporarily uploaded into the workbench, this browser
// session only). An example manifest lives at `examples/research.json`.
//
// (If you ever want a template bundled by default, add `import "./<name>";` here
//  and have that folder call registerEnvironment — but the model is drop-to-install.)
export {};
