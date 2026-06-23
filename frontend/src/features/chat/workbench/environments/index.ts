// Workbench template barrel.
//
// Each template is a SELF-CONTAINED folder: environments/<name>/ holding its own
// board panels + an index.ts that calls registerEnvironment({ panels, seed }).
// Importing the folder runs that registration (side-effect).
//
// 👉 To add a template: drop in `environments/<name>/` (panels + index.ts) and add
//    ONE line below. WorkbenchDrawer and everything else stay untouched. Explicit
//    registration (vs glob auto-discovery) keeps "which templates are active" visible.
import "./research";
// import "./writing";   // ← future template, e.g.
