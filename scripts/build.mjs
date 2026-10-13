// Compiles src/tui.tsx to dist/tui.js.
//
// opencode only applies its Solid JSX transform to local files, not to files
// inside node_modules, so the published package must ship plain JS. The JSX is
// compiled for the "universal" renderer exposed by @opentui/solid; opencode
// rewrites the `@opentui/solid` and `solid-js` imports to its own runtime.
import { transformAsync } from "@babel/core"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const input = resolve(root, "src/tui.tsx")
const output = resolve(root, "dist/tui.js")

const source = await readFile(input, "utf8")
const result = await transformAsync(source, {
  filename: input,
  configFile: false,
  babelrc: false,
  presets: [
    ["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }],
    ["@babel/preset-typescript", { onlyRemoveTypeImports: false }],
  ],
})

if (!result?.code) throw new Error("Babel produced no output")
await mkdir(dirname(output), { recursive: true })
await writeFile(output, result.code + "\n")
console.log(`Built ${output}`)
