// Entry point used when the plugin is loaded from a local directory by opencode 2.x,
// which looks for `<dir>/tui.*`. Published packages use the `./tui` export instead.
export { default } from "./src/tui.tsx"
