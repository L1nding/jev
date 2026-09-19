import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { buildRoomLayerProfiles, type RoomLayerChoice } from "./room-layer-filter";
import { buildProvisionalBoundaryElements, type Point2, type ProvisionalWallElement } from "./wall-elements";

type DecisionsResponse = {
  id?: string;
  model?: string;
  provider?: string;
  usage?: Record<string, unknown>;
  answers?: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
  error?: { message?: string };
};

const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";
const MODEL = Bun.env.OPENROUTER_MODEL ?? "typesafe/jev-1.13";
const apiKey = Bun.env.OPENROUTER_API_KEY;

function usage(): never {
  console.error(`用法：
  bun run src/jev-room-layers.ts <cad-ir.json> <jev-decisions.json> <wall-elements.json> <room-object.json>
    [--traversal <room-traversal.json>] [--reuse-decisions <room-layer-decisions.json>]
    [--output-dir reports/layers]`);
  process.exit(2);
}

const args = Bun.argv.slice(2);
const jsonArgs = args.filter((value) => value.endsWith(".json") && args[args.indexOf(value) - 1] !== "--traversal");
const valueAfter = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
if (jsonArgs.length < 4) usage();
const reuseDecisionsPath = valueAfter("--reuse-decisions") ? resolve(valueAfter("--reuse-decisions")!) : null;
if (!apiKey && !reuseDecisionsPath) throw new Error("缺少 OPENROUTER_API_KEY，请配置 .env。");

const [cadPath, decisionsPath, wallElementsPath, roomObjectPath] = jsonArgs.slice(0, 4).map((value) => resolve(value!));
const traversalPath = valueAfter("--traversal") ? resolve(valueAfter("--traversal")!) : null;
const outputDir = resolve(valueAfter("--output-dir") ?? "reports/layers");
const [cad, semanticDocument, wallDocument, roomDocument, traversal] = await Promise.all([
  readFile(cadPath!, "utf8").then(JSON.parse),
  readFile(decisionsPath!, "utf8").then(JSON.parse),
  readFile(wallElementsPath!, "utf8").then(JSON.parse),
  readFile(roomObjectPath!, "utf8").then(JSON.parse),
  traversalPath ? readFile(traversalPath, "utf8").then(JSON.parse) : Promise.resolve(null),
]);

const seed = wallDocument.room_seed.point as Point2;
const baseBoundaryElements = wallDocument.elements as ProvisionalWallElement[];
const radius = Math.max(
  Number(wallDocument.selection?.radius ?? 3000),
  ...baseBoundaryElements.flatMap((element) => [element.start, element.end])
    .map((point) => Math.hypot(point[0] - seed[0], point[1] - seed[1])),
);
const baseSourceIds = new Set(baseBoundaryElements.flatMap((element) => element.source_entities));
const supplementalBoundaryElements = buildProvisionalBoundaryElements(
  cad.entities,
  semanticDocument.decisions,
  seed,
  radius,
  ["wall", "window", "column"],
).filter((element) => !element.source_entities.some((sourceId) => baseSourceIds.has(sourceId)));
const boundaryElements = [...baseBoundaryElements, ...supplementalBoundaryElements];
const selectedFaceParentIds = (traversal?.accepted_attempt?.branch?.orderedEdges ?? [])
  .map((edge: any) => edge.parent_element_id)
  .filter(Boolean);
const profiles = buildRoomLayerProfiles({
  entities: cad.entities,
  semanticDecisions: semanticDocument.decisions,
  boundaryElements,
  roomRoles: roomDocument.object.roles ?? {},
  seed,
  radius,
  selectedFaceParentIds,
});

const nearbyAnnotations = cad.entities
  .filter((entity: any) => Boolean((entity.text ?? "").trim()) && entity.anchor?.local)
  .map((entity: any) => ({
    text: entity.text,
    distance: Math.hypot(Number(entity.anchor.local[0]) - seed[0], Number(entity.anchor.local[1]) - seed[1]),
  }))
  .filter((item: any) => item.distance <= 3000)
  .sort((a: any, b: any) => a.distance - b.distance)
  .slice(0, 20);
const questions = Object.fromEntries(profiles.map((profile) => [profile.key, {
  type: "choice",
  instructions: `判断 state.layers[${profile.key}] 代表的 CAD 图层能否参与目标房间的边界构造。图层级判断只控制拓扑候选资格，不得改变任何实体已有的 wall/window/door/column 语义。目标是包含 Room Seed 的最小、直接房间围合，而不是附近任意闭合轮廓。`,
  criteria: {
    include: "该图层可能包含物理墙、柱、窗、门或明确建筑边界几何，可以进入主要平面图拓扑。",
    exclude: "该图层主要是家具、设备、注释、尺寸、柜台、填充、装饰/详图线、仅属于邻室的图形，不能参与房间 face 构造或 gap repair。",
    uncertain: "证据不足；不进入主要 face 拓扑，但可保留为受约束的 repair 证据。",
  },
}]));
let body: DecisionsResponse;
if (reuseDecisionsPath) {
  const reused = JSON.parse(await readFile(reuseDecisionsPath, "utf8"));
  const reusedByLayer = new Map(reused.decisions.map((decision: any) => [decision.layer, decision]));
  body = {
    id: reused.request_id,
    model: reused.model,
    provider: reused.provider,
    usage: reused.usage,
    answers: Object.fromEntries(profiles.map((profile) => {
      const decision: any = reusedByLayer.get(profile.layer);
      return [profile.key, { choice: decision?.choice, confidence: decision?.confidence, probabilities: decision?.probabilities }];
    })),
  };
} else {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(Bun.env.OPENROUTER_SITE_URL ? { "HTTP-Referer": Bun.env.OPENROUTER_SITE_URL } : {}),
      ...(Bun.env.OPENROUTER_APP_NAME ? { "X-OpenRouter-Title": Bun.env.OPENROUTER_APP_NAME } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      state: {
        room_seed: wallDocument.room_seed,
        room_name: wallDocument.room_seed.text,
        room_area_evidence: nearbyAnnotations.find((item: any) => /[0-9]+(?:\.[0-9]+)?\s*m(?:²|2)/i.test(item.text)) ?? null,
        nearby_annotations: nearbyAnnotations,
        search_radius: radius,
        layers: Object.fromEntries(profiles.map((profile) => [profile.key, profile])),
      },
      questions,
    }),
  });
  body = await response.json() as DecisionsResponse;
  if (!response.ok) throw new Error(`OpenRouter 请求失败 (${response.status}): ${body.error?.message ?? JSON.stringify(body)}`);
}

const profileByKey = new Map(profiles.map((profile) => [profile.key, profile]));
const decisions = Object.entries(body.answers ?? {}).map(([key, answer]) => ({
  layer: profileByKey.get(key)?.layer ?? key,
  choice: (["include", "uncertain", "exclude"].includes(String(answer.choice)) ? answer.choice : "uncertain") as RoomLayerChoice,
  confidence: answer.confidence ?? null,
  probabilities: answer.probabilities ?? {},
  request_id: body.id ?? null,
  model: body.model ?? MODEL,
}));
const result = {
  schema_version: "room-layer-decisions-v1",
  generated_at: new Date().toISOString(),
  input: {
    cad_ir_path: cadPath,
    jev_decisions_path: decisionsPath,
    wall_elements_path: wallElementsPath,
    room_object_path: roomObjectPath,
    traversal_path: traversalPath,
    reused_decisions_path: reuseDecisionsPath,
    cad_ir_sha256: createHash("sha256").update(await readFile(cadPath!)).digest("hex"),
  },
  room_seed: wallDocument.room_seed,
  search_radius: radius,
  model: body.model ?? MODEL,
  endpoint: OPENROUTER_URL,
  request_id: body.id ?? null,
  provider: body.provider ?? null,
  usage: body.usage ?? null,
  profiles,
  decisions,
  summary: {
    layer_count: profiles.length,
    answered_layer_count: decisions.length,
    choice_counts: decisions.reduce<Record<string, number>>((counts, decision) => {
      counts[decision.choice] = (counts[decision.choice] ?? 0) + 1;
      return counts;
    }, {}),
  },
};
await mkdir(outputDir, { recursive: true });
const stem = basename(cadPath!).replace(/\.cad-ir\.json$/, "");
const seedHandle = String(wallDocument.room_seed.source_id).replace(/^source:/, "");
const output = resolve(outputDir, `${stem}.${seedHandle}.room-layer-decisions.json`);
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, request_id: result.request_id, summary: result.summary, decisions }, null, 2));
