import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { splitWallElementsAtJunctions, type WallElement } from "./wall-elements";

const args = Bun.argv.slice(2);
const inputArg = args.find((value) => value.endsWith(".grouped-wall-elements.json"));
const valueAfter = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
if (!inputArg) {
  console.error("用法：bun run segment-walls <grouped-wall-elements.json> [--tolerance 250] [--minimum-length 50]");
  process.exit(2);
}

const input = resolve(inputArg);
const tolerance = Number(valueAfter("--tolerance") ?? 250);
const minimumLength = Number(valueAfter("--minimum-length") ?? 50);
const outputDir = resolve(valueAfter("--output-dir") ?? "reports/wall-elements");
const document = JSON.parse(await readFile(input, "utf8"));
const elements = splitWallElementsAtJunctions(document.elements as WallElement[], tolerance, minimumLength);
const result = {
  ...document,
  schema_version: "wall-elements-v3",
  generated_at: new Date().toISOString(),
  segmentation: { method: "junction-and-endpoint-projection", tolerance, minimum_length: minimumLength },
  summary: { ...document.summary, grouped_wall_element_count: document.elements.length, boundary_segment_count: elements.length },
  elements,
};

await mkdir(outputDir, { recursive: true });
const stem = basename(input).replace(/\.grouped-wall-elements\.json$/, "");
const output = resolve(outputDir, `${stem}.segmented-wall-elements.json`);
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, grouped_wall_element_count: document.elements.length, boundary_segment_count: elements.length }, null, 2));
