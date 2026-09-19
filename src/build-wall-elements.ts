import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { buildProvisionalWallElements } from "./wall-elements";

const args = Bun.argv.slice(2);
const jsonArgs = args.filter((value) => value.endsWith(".json"));
const valueAfter = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
if (jsonArgs.length < 3) {
  console.error("用法：bun run wall-elements <cad-ir.json> <jev-decisions.json> <room-object.json> [--radius 3000] [--output-dir reports/wall-elements]");
  process.exit(2);
}

const cadPath = resolve(jsonArgs[0]!);
const decisionsPath = resolve(jsonArgs[1]!);
const roomPath = resolve(jsonArgs[2]!);
const radius = Number(valueAfter("--radius") ?? 3000);
const outputDir = resolve(valueAfter("--output-dir") ?? "reports/wall-elements");
const cad = JSON.parse(await readFile(cadPath, "utf8"));
const decisions = JSON.parse(await readFile(decisionsPath, "utf8"));
const room = JSON.parse(await readFile(roomPath, "utf8"));
const seedId = room.object.seed_source_id;
const seedEntity = cad.entities.find((entity: any) => entity.id === seedId);
const seed = seedEntity?.anchor?.local;
if (!seed || !Number.isFinite(Number(seed[0])) || !Number.isFinite(Number(seed[1]))) {
  console.error(`Room Seed 缺少有效坐标：${seedId}`);
  process.exit(2);
}

const elements = buildProvisionalWallElements(cad.entities, decisions.decisions, [Number(seed[0]), Number(seed[1])], radius);
const result = {
  schema_version: "wall-elements-v1",
  generated_at: new Date().toISOString(),
  input: {
    cad_ir_path: cadPath,
    jev_decisions_path: decisionsPath,
    room_object_path: roomPath,
    region_id: cad.selection.region_id,
    window_id: decisions.selection?.window_id ?? null,
  },
  room_seed: { source_id: seedId, text: seedEntity.text ?? null, point: [Number(seed[0]), Number(seed[1])] },
  selection: { radius, semantic_type: "wall" },
  summary: { wall_element_count: elements.length, source_entity_count: new Set(elements.flatMap((element) => element.source_entities)).size },
  elements,
};

await mkdir(outputDir, { recursive: true });
const stem = basename(cadPath).replace(/\.cad-ir\.json$/, "");
const output = resolve(outputDir, `${stem}.${seedEntity.source.handle}.wall-elements.json`);
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, ...result.summary }, null, 2));
