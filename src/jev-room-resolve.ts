import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { cachedDecisionAdapter, evidenceHash, liveDecisionAdapter, replayDecisionAdapter, type DecisionRecord } from "./jev-boundary-decisions";
import { resolveRoomBoundary } from "./room-boundary-resolver";
import { entityDistance, type MeasuredEntity, type SpatialObject } from "./room-spatial-geometry";
import type { Point2 } from "./wall-elements";

const args = Bun.argv.slice(2);
const value = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const [cadPath, semanticPath, geometryPath] = args;
if (!cadPath || !semanticPath || !geometryPath || !value("--seed")) throw new Error("用法: bun run room-resolve <cad.json> <semantics.json> <source-geometry.json> --seed source:ID [--output-dir dir] [--replay report.json]");
const cadText = await readFile(resolve(cadPath), "utf8");
const cad = JSON.parse(cadText);
const semantics = JSON.parse(await readFile(resolve(semanticPath), "utf8"));
const geometry = JSON.parse(await readFile(resolve(geometryPath), "utf8"));
if (geometry.source_sha256 !== cad.source.sha256 || geometry.cad_sha256 !== createHash("sha256").update(cadText).digest("hex")) throw new Error("几何与 CAD 来源不匹配");
if (cad.source.units.name !== "millimeters") throw new Error("当前实验版本要求毫米单位；尚未实现其他单位转换");
const seedEntity = cad.entities.find((e: any) => e.id === value("--seed"));
if (!seedEntity?.anchor?.local) throw new Error("无有效 Room Seed");
const seed = { source_id: seedEntity.id as string, text: String(seedEntity.text ?? ""), point: seedEntity.anchor.local.slice(0, 2) as Point2 };
const numeric = (name: string, fallback: number) => { const n = Number(value(name) ?? fallback); if (!Number.isFinite(n) || n <= 0) throw new Error(`非法参数 ${name}`); return n; };
const policy = {
  initialRadius: numeric("--radius", 4000), maximumRadius: numeric("--maximum-radius", 6500),
  initialObjects: numeric("--objects", 48), maximumObjects: numeric("--maximum-objects", 96),
  batchSize: 8, maximumRequests: numeric("--requests", 32), maximumRounds: 2,
  gapReach: 2200, maximumGaps: 48, maximumSurfaces: numeric("--surfaces", 48),
  maximumHypothesisObjects: numeric("--hypothesis-objects", 220), maximumHypothesisSegments: numeric("--hypothesis-segments", 1200),
};
const entities = new Map<string, any>(cad.entities.map((e: any) => [e.id, e]));
const semanticById = new Map<string, any>(semantics.decisions.map((d: any) => [d.source_id, d]));
const objects: SpatialObject[] = geometry.entities.map((e: MeasuredEntity): SpatialObject => ({
  ...e, semantic_type: semanticById.get(e.source_id)?.semantic_type ?? "unknown",
  layer: entities.get(e.source_id)?.source?.layer ?? "", distance: entityDistance(e, seed.point),
})).filter((e: SpatialObject) => e.distance <= policy.maximumRadius)
  .sort((a: SpatialObject, b: SpatialObject) => a.distance - b.distance || a.source_id.localeCompare(b.source_id));
const annotations = cad.entities.filter((e: any) => e.text && e.anchor?.local && e.id !== seed.source_id)
  .map((e: any) => ({ source_id: e.id, text: e.text, point: e.anchor.local.slice(0, 2) as Point2 }))
  .filter((e: any) => Math.hypot(e.point[0] - seed.point[0], e.point[1] - seed.point[1]) <= policy.maximumRadius)
  .sort((a: any, b: any) => Math.hypot(a.point[0] - seed.point[0], a.point[1] - seed.point[1]) - Math.hypot(b.point[0] - seed.point[0], b.point[1] - seed.point[1])).slice(0, 40);
const model = Bun.env.OPENROUTER_MODEL ?? "typesafe/jev-1.13";
const problem = { model, seed, annotations, objects, policy };
const sourceFiles = ["jev-room-resolve.ts", "room-boundary-resolver.ts", "room-boundary-hypotheses.ts", "room-context-retrieval.ts", "room-repair-plans.ts", "room-surface-review.ts", "room-spatial-geometry.ts", "room-adjudication.ts", "jev-boundary-decisions.ts", "boundary-faces.ts", "wall-elements.ts", "room-traversal.ts"];
const manifest = {
  input_hashes: { cad: evidenceHash(cad), semantics: evidenceHash(semantics), geometry: evidenceHash(geometry) },
  source_hashes: Object.fromEntries(await Promise.all(sourceFiles.map(async (name) => [name, evidenceHash(await readFile(resolve(import.meta.dir, name), "utf8"))]))),
  problem_hash: evidenceHash(problem), policy, model,
};
const replayPath = value("--replay");
const replay = replayPath ? JSON.parse(await readFile(resolve(replayPath), "utf8")) : null;
if (replay && evidenceHash(replay.run_manifest) !== evidenceHash(manifest)) throw new Error("回放输入/代码/参数不一致");
if (!replay && !Bun.env.OPENROUTER_API_KEY) throw new Error("缺少 OPENROUTER_API_KEY");
const reusePath = value("--reuse-decisions");
if (replayPath && reusePath) throw new Error("严格回放和缓存复用不能同时指定");
const reuse = reusePath ? JSON.parse(await readFile(resolve(reusePath), "utf8")) : null;
let freshRequests = 0;
const live = liveDecisionAdapter({ endpoint: "https://openrouter.ai/api/alpha/decisions", apiKey: Bun.env.OPENROUTER_API_KEY! });
const fresh: typeof live = async (request) => { freshRequests++; return live(request); };
const transport = replay ? replayDecisionAdapter(replay.decision_records) : reuse ? cachedDecisionAdapter(reuse.decision_records, fresh) : fresh;
const dir = resolve(value("--output-dir") ?? "reports/room-v2/runs");
const output = resolve(dir, `${seed.source_id.replace(":", "-")}.json`);
if (replayPath && resolve(replayPath) === output) throw new Error("回放输出不能覆盖原报告");
if (reusePath && resolve(reusePath) === output) throw new Error("复用输出不能覆盖来源报告");
await mkdir(dir, { recursive: true });
const records: DecisionRecord[] = [];
const result = await resolveRoomBoundary(problem, async (request) => {
  await writeFile(`${output}.journal.json`, JSON.stringify({ run_manifest: manifest, decision_records: records, pending_request: request }));
  const record = await transport(request);
  records.push(record);
  await writeFile(`${output}.journal.json`, JSON.stringify({ run_manifest: manifest, decision_records: records, pending_request: null }));
  return record;
}, (message) => console.error(`${seed.text}: ${message}`));
await writeFile(output, JSON.stringify({ ...result, run_manifest: manifest, policy, replay_source: replayPath ?? null, reuse_source: reusePath ?? null, fresh_request_count: freshRequests }, null, 2));
console.log(JSON.stringify({ output, room: seed.text, outcome: result.outcome, reason: result.outcome_reason, requests: result.request_count, candidates: result.candidates.length, area: result.accepted_candidate?.gross_area }, null, 2));
