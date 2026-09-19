import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  applyOption,
  boundaryRepairOptions,
  filterWallElementsByRole,
  hasDeterministicLead,
  nextOptions,
  rankTraversalOptions,
  startBranch,
  startOptions,
  validateTraversal,
  type OpeningElement,
  type TraversalBranch,
  type TraversalOption,
} from "./room-traversal";
import type { Point2, ProvisionalWallElement } from "./wall-elements";
import { buildProvisionalBoundaryElements } from "./wall-elements";
import { faceToTraversalBranch, selectRoomFaces, walkRoomBoundaryFaces } from "./boundary-faces";
import { effectiveRoomLayerDecisions, partitionBoundaryElementsByLayer, type RoomLayerDecisionDocument } from "./room-layer-filter";
import { evidenceHash, liveDecisionAdapter, replayDecisionAdapter, type DecisionAdapter, type DecisionRecord } from "./jev-boundary-decisions";
import { adjudicateRoom } from "./room-adjudication";

const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";
const MODEL = Bun.env.OPENROUTER_MODEL ?? "typesafe/jev-1.13";
const apiKey = Bun.env.OPENROUTER_API_KEY;

function usage(): never {
  console.error(`用法：
  bun run room-traverse <cad-ir.json> <jev-decisions.json> <wall-elements.json> <room-object.json>
    [--layer-decisions <room-layer-decisions.json>]
    [--replay <room-traversal.json>] [--output-dir <directory>]
    [--beam-width 3] [--max-steps 16] [--junction-tolerance 250] [--opening-reach 1200]`);
  process.exit(2);
}

function parsePositive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const args = Bun.argv.slice(2);
const jsonArgs = args.filter((value) => value.endsWith(".json"));
const valueAfter = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
if (jsonArgs.length < 4) usage();
if (!apiKey && !valueAfter("--replay")) {
  console.error("缺少 OPENROUTER_API_KEY，请配置 .env。");
  process.exit(1);
}

const cadPath = resolve(jsonArgs[0]!);
const decisionsPath = resolve(jsonArgs[1]!);
const wallElementsPath = resolve(jsonArgs[2]!);
const roomObjectPath = resolve(jsonArgs[3]!);
const beamWidth = Math.min(5, parsePositive(valueAfter("--beam-width"), 3));
const maxSteps = Math.min(48, parsePositive(valueAfter("--max-steps"), 16));
const junctionTolerance = parsePositive(valueAfter("--junction-tolerance"), 250);
const openingReach = parsePositive(valueAfter("--opening-reach"), 1200);
const outputDir = resolve(valueAfter("--output-dir") ?? "reports/traversal");
const layerDecisionsPath = valueAfter("--layer-decisions") ? resolve(valueAfter("--layer-decisions")!) : null;

const cad = JSON.parse(await readFile(cadPath, "utf8"));
const entityDecisions = JSON.parse(await readFile(decisionsPath, "utf8"));
const wallElementsDocument = JSON.parse(await readFile(wallElementsPath, "utf8"));
const roomObject = JSON.parse(await readFile(roomObjectPath, "utf8"));
const layerDecisionDocument = layerDecisionsPath
  ? JSON.parse(await readFile(layerDecisionsPath, "utf8")) as RoomLayerDecisionDocument
  : null;
const seed = wallElementsDocument.room_seed.point as Point2;
const stem = basename(cadPath).replace(/\.cad-ir\.json$/, "");
const seedHandle = String(wallElementsDocument.room_seed.source_id).replace(/^source:/, "");
const output = resolve(outputDir, `${stem}.${seedHandle}.room-traversal.json`);
const journalPath = resolve(outputDir, `${stem}.${seedHandle}.decision-journal.json`);
const sourceFiles = ["jev-room-traverse.ts", "room-traversal.ts", "wall-elements.ts", "boundary-faces.ts", "room-layer-filter.ts", "room-adjudication.ts", "jev-boundary-decisions.ts"];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, evidenceHash(await readFile(resolve(import.meta.dir, file), "utf8"))])));
const manifest = {
  schema_version: "room-run-manifest-v1",
  input_hashes: {
    cad: evidenceHash(cad), semantics: evidenceHash(entityDecisions), walls: evidenceHash(wallElementsDocument),
    room: evidenceHash(roomObject), layers: evidenceHash(layerDecisionDocument),
  },
  source_hashes: sourceHashes,
  preprocessing: { wall_schema: wallElementsDocument.schema_version ?? null, wall_selection: wallElementsDocument.selection ?? null, units: cad.source?.units ?? null },
  policy: { beamWidth, maxSteps, junctionTolerance, openingReach, model: MODEL },
};
const replayPath = valueAfter("--replay");
const replayReport = replayPath ? JSON.parse(await readFile(resolve(replayPath), "utf8")) : null;
if (replayReport && evidenceHash(replayReport.run_manifest) !== evidenceHash(manifest)) {
  throw new Error("回放输入、代码或参数不匹配；不会复用旧决策或调用网络。");
}
if (replayReport && !Array.isArray(replayReport.decision_records)) throw new Error("回放报告缺少原始决策记录。");
if (replayPath && (resolve(replayPath) === output || resolve(replayPath) === journalPath)) throw new Error("回放输出目录必须与原始记录不同。");
const transport = replayReport
  ? replayDecisionAdapter(replayReport.decision_records)
  : liveDecisionAdapter({ endpoint: OPENROUTER_URL, apiKey: apiKey! });
const decisionRecords: DecisionRecord[] = [];
await mkdir(outputDir, { recursive: true });
const requestDecision: DecisionAdapter = async (request) => {
  // Persist the pending request before sending; preserve completed exchanges on interruption.
  await writeFile(journalPath, JSON.stringify({ run_manifest: manifest, decision_records: decisionRecords, pending_request: request }, null, 2));
  const record = await transport(request);
  decisionRecords.push(record);
  await writeFile(journalPath, JSON.stringify({ run_manifest: manifest, decision_records: decisionRecords, pending_request: null }, null, 2));
  return record;
};
const baseWallElements = wallElementsDocument.elements as ProvisionalWallElement[];
const boundaryCoverageRadius = Math.max(
  Number(wallElementsDocument.selection?.radius ?? 3000),
  ...baseWallElements.flatMap((element) => [element.start, element.end])
    .map((point) => Math.hypot(point[0] - seed[0], point[1] - seed[1])),
);
const baseSourceIds = new Set(baseWallElements.flatMap((element) => element.source_entities));
const supplementalBoundaryElements = buildProvisionalBoundaryElements(
  cad.entities,
  entityDecisions.decisions,
  seed,
  boundaryCoverageRadius,
  ["wall", "window", "column"],
).filter((element) => !element.source_entities.some((sourceId) => baseSourceIds.has(sourceId)));
const allElements = [...baseWallElements, ...supplementalBoundaryElements];
const directRoomLayers = new Set(Object.entries(roomObject.object.roles ?? {})
  .filter(([, role]) => role === "boundary" || role === "opening")
  .map(([sourceId]) => cad.entities.find((entity: any) => entity.id === sourceId)?.source?.layer)
  .filter((layer): layer is string => Boolean(layer)));
const effectiveLayerDecisions = layerDecisionDocument
  ? effectiveRoomLayerDecisions(layerDecisionDocument.decisions, directRoomLayers)
  : [];
const layerPartition = layerDecisionDocument
  ? partitionBoundaryElementsByLayer(allElements, cad.entities, effectiveLayerDecisions)
  : {
      primary: allElements,
      repair: allElements,
      excluded: [],
      counts: { include: allElements.length, uncertain: 0, exclude: 0 },
    };
const primaryElements = layerPartition.primary;
const repairElements = layerPartition.repair;
const elements = filterWallElementsByRole(primaryElements, roomObject.object.roles ?? {}, "boundary");
const acceptedParentIds = new Set(elements.map((element) => element.parent_element_id ?? element.id));
const decisionById = new Map(entityDecisions.decisions.map((decision: any) => [decision.source_id, decision]));
const entityById = new Map(cad.entities.map((entity: any) => [entity.id, entity]));

const layerChoiceByName = new Map(effectiveLayerDecisions.map((decision) => [decision.layer, decision.choice]));
const openings: OpeningElement[] = Object.entries(roomObject.object.roles ?? {})
  .filter(([, role]) => role === "opening")
  .map(([sourceId]): OpeningElement | null => {
    const entity: any = entityById.get(sourceId);
    const semantic = String((decisionById.get(sourceId) as any)?.semantic_type ?? "opening");
    const anchor = entity?.anchor?.local;
    if (!anchor) return null;
    const geometry = entity?.geometry?.local;
    const rawPath = geometry?.kind === "line"
      ? [geometry.start, geometry.end]
      : geometry?.kind === "polyline" ? geometry.vertices : undefined;
    return {
      id: `opening:${entity.source.handle}`,
      source_entity_id: sourceId,
      semantic_type: semantic === "door" || semantic === "window" ? semantic : "opening",
      anchor: [Number(anchor[0]), Number(anchor[1])] as Point2,
      ...(rawPath ? { path: rawPath.map((point: number[]) => [Number(point[0]), Number(point[1])] as Point2) } : {}),
      boundary_kind: "opening",
    };
  })
  .filter((opening): opening is OpeningElement => opening !== null)
  .filter((opening) => {
    if (!layerDecisionDocument) return true;
    const layer = (entityById.get(opening.source_entity_id) as any)?.source?.layer;
    return layerChoiceByName.get(layer) !== "exclude";
  });

const annotations = cad.entities
  .filter((entity: any) => Boolean((entity.text ?? "").trim()) && entity.anchor?.local)
  .map((entity: any) => ({
    source_id: entity.id,
    text: entity.text,
    point: [Number(entity.anchor.local[0]), Number(entity.anchor.local[1])] as Point2,
    distance: Math.hypot(Number(entity.anchor.local[0]) - seed[0], Number(entity.anchor.local[1]) - seed[1]),
  }))
  .filter((item: any) => item.distance <= 3000)
  .sort((a: any, b: any) => a.distance - b.distance)
  .slice(0, 20);
const areaEvidence = annotations
  .map((annotation: any) => {
    const match = String(annotation.text).match(/([0-9]+(?:\.[0-9]+)?)\s*m(?:²|2)/i);
    return match ? { source_id: annotation.source_id, text: annotation.text, square_metres: Number(match[1]), distance: annotation.distance } : null;
  })
  .filter((value: any) => value && Number.isFinite(value.square_metres))
  .sort((a: any, b: any) => a.distance - b.distance)[0] ?? null;
const targetArea = areaEvidence ? areaEvidence.square_metres * 1_000_000 : null;
const minimumRoomArea = targetArea ? targetArea * 0.25 : 1_000_000;
const maximumRoomArea = targetArea ? targetArea * 4 : 200_000_000;
const roomScaleHint = targetArea ? Math.sqrt(targetArea) : null;

async function decide(instructions: string, state: Record<string, unknown>, options: TraversalOption[]) {
  const optionByKey = new Map<string, TraversalOption>();
  const criteria: Record<string, string> = {};
  options.forEach((option, index) => {
    const key = `o${index}`;
    optionByKey.set(key, option);
    criteria[key] = option.description;
  });
  const exchange = await requestDecision({
    model: MODEL,
    state,
    questions: { decision: { type: "choice", instructions, criteria } },
  });
  const body = exchange.response ?? {};
  const answer = exchange.status === "ok" ? body.answers?.decision ?? {} : {};
  const probabilities = Object.entries(answer.probabilities ?? {})
    .map(([key, probability]) => ({ key, option: optionByKey.get(key), probability: Number(probability) }))
    .filter((item): item is { key: string; option: TraversalOption; probability: number } => Boolean(item.option) && Number.isFinite(item.probability))
    .sort((a, b) => b.probability - a.probability);
  if (probabilities.length === 0 && answer.choice && optionByKey.has(answer.choice)) {
    probabilities.push({ key: answer.choice, option: optionByKey.get(answer.choice)!, probability: Number(answer.confidence ?? 1) });
  }
  return {
    decision_status: exchange.status,
    request_hash: exchange.request_hash,
    request_id: body.id ?? null,
    model: body.model ?? MODEL,
    provider: body.provider ?? null,
    usage: body.usage ?? null,
    selected_key: answer.choice ?? null,
    confidence: answer.confidence ?? null,
    probabilities,
    options: Object.fromEntries([...optionByKey.entries()].map(([key, option]) => [key, { id: option.id, description: option.description }])),
  };
}

function diverseChoices<T extends { option: TraversalOption; probability: number }>(choices: T[], limit: number): T[] {
  const selected: T[] = [];
  const add = (choice: T | undefined) => {
    if (choice && !selected.includes(choice)) selected.push(choice);
  };
  add(choices[0]);
  add(choices.find((choice) => choice.option.kind === "wall" && choice.option.same_parent === false && choice.option.side_consistent !== false));
  add(choices.find((choice) => choice.option.kind === "opening" && choice.option.side_consistent !== false));
  add(choices.find((choice) => choice.option.kind === "close"));
  for (const choice of choices) {
    if (selected.length >= limit) break;
    add(choice);
  }
  return selected.slice(0, limit);
}

function maneuverId(option: TraversalOption): string {
  if (option.kind === "close") return "maneuver:close_cycle";
  if (option.kind === "opening") return "maneuver:cross_opening";
  if (option.kind === "uncertain") return "maneuver:uncertain";
  const turn = Number(option.turn_degrees ?? 0);
  if (turn > 25) return "maneuver:turn_left";
  if (turn < -25) return "maneuver:turn_right";
  return "maneuver:continue_straight";
}

function maneuverOptions(options: TraversalOption[]): TraversalOption[] {
  const descriptions: Record<string, string> = {
    "maneuver:continue_straight": "沿当前方向继续，包括同一父墙的下一段或几何上近似直行的墙段。",
    "maneuver:turn_left": "在当前路口左转进入另一墙对象，使遍历继续包围 Room Seed。",
    "maneuver:turn_right": "在当前路口右转进入另一墙对象，使遍历继续包围 Room Seed。",
    "maneuver:cross_opening": "通过门窗 Opening Element 的 Virtual Boundary Edge 继续。",
    "maneuver:close_cycle": "当前路径已经形成包含 Room Seed 且面积合理的闭环。",
    "maneuver:uncertain": "现有证据不足以判断路口动作。",
  };
  const ids = [...new Set(options.map(maneuverId))];
  return ids.map((id) => ({
    id,
    kind: id === "maneuver:close_cycle" ? "close" : id === "maneuver:cross_opening" ? "opening" : "uncertain",
    description: descriptions[id]!,
    distance: 0,
  }));
}

function reweightByManeuver<T extends { option: TraversalOption; probability: number }>(
  choices: T[],
  maneuvers: Array<{ option: TraversalOption; probability: number }>,
): T[] {
  const weights = new Map(maneuvers.map((choice) => [choice.option.id, choice.probability]));
  const weighted = choices.map((choice) => ({
    ...choice,
    probability: choice.probability * (weights.get(maneuverId(choice.option)) ?? 0.001),
  }));
  const total = weighted.reduce((sum, choice) => sum + choice.probability, 0) || 1;
  return weighted.map((choice) => ({ ...choice, probability: choice.probability / total })).sort((a, b) => b.probability - a.probability);
}

const traces: Array<Record<string, unknown>> = [];
const faceSnapTolerance = Math.min(junctionTolerance, 50);
const faceWalk = walkRoomBoundaryFaces(primaryElements, openings, seed, {
  snapTolerance: faceSnapTolerance,
  maximumGap: openingReach,
  targetArea,
});
const walkedFaces = faceWalk.faces;
const roomFaces = selectRoomFaces(walkedFaces, targetArea, minimumRoomArea, maximumRoomArea).slice(0, 5);
const faceBranches = roomFaces.map((face, index) => faceToTraversalBranch(face, acceptedParentIds, Math.max(0.01, 1 - index * 0.1)));
traces.push({
  stage: "face_walk",
  snap_tolerance: faceSnapTolerance,
  graph_face_count: walkedFaces.length,
  seed_face_count: walkedFaces.filter((face) => face.contains_seed).length,
  valid_room_face_count: roomFaces.length,
  selected_face_ids: roomFaces.map((face) => face.id),
  virtual_edge_candidate_count: faceWalk.virtual_edges.length,
  fallback_to_beam: faceBranches.length === 0,
});

let branches: TraversalBranch[] = [];
if (faceBranches.length === 0) {
  const starts = startOptions(elements, seed, 8);
  const startDecision = await decide(
    "选择最适合开始顺序遍历的墙元素和方向。目标是沿包含 Room Seed 的最小、直接房间围合持续前进；避免选择家具轮廓、重复平行墙面或明显属于相邻房间的方向。",
    { room_seed: wallElementsDocument.room_seed, nearby_annotations: annotations, candidates: starts.map((option) => ({ id: option.id, description: option.description })) },
    [...starts, { id: "uncertain", kind: "uncertain", description: "现有起点候选不足以可靠开始遍历。", distance: Number.POSITIVE_INFINITY }],
  );
  traces.push({ stage: "start", ...startDecision });
  branches = startDecision.probabilities
    .filter((choice) => choice.option.kind === "wall")
    .slice(0, beamWidth)
    .map((choice, index) => startBranch(choice.option, choice.probability, index, seed))
    .filter((branch): branch is TraversalBranch => branch !== null);
}
const completed: TraversalBranch[] = [...faceBranches];
const terminated: TraversalBranch[] = [];

for (let step = 1; step <= maxSteps && branches.length > 0; step += 1) {
  const expanded: TraversalBranch[] = [];
  for (const branch of branches) {
    const allowedElements = repairElements.filter((element) => elements.includes(element)
      || branch.repairParentElementIds.includes(element.parent_element_id ?? element.id));
    const traversalPolicy = {
      junctionTolerance,
      openingReach,
      limit: 12,
      roomSeed: seed,
      minimumRoomArea,
      maximumRoomArea,
    };
    let options = nextOptions(branch, allowedElements, openings, traversalPolicy);
    const repairMode = !options.some((option) => option.kind !== "uncertain");
    if (repairMode) {
      options = boundaryRepairOptions(branch, elements, repairElements, openings, traversalPolicy);
    }
    const localRanking = rankTraversalOptions(branch, options, {
      acceptedParentIds,
      roomSeed: seed,
      targetArea,
      maximumRoomArea,
    });
    const uncertainOption = localRanking.accepted.find((item) => item.option.kind === "uncertain")?.option;
    const topRanked = localRanking.accepted.filter((item) => item.option.kind !== "uncertain").slice(0, 4);
    options = [...topRanked.map((item) => item.option), ...(uncertainOption ? [uncertainOption] : [])];
    traces.push({
      stage: "local_ranking",
      step,
      branch_id: branch.id,
      accepted: localRanking.accepted.map((item) => ({ option_id: item.option.id, score: item.score, reasons: item.reasons })),
      rejected: localRanking.rejected.map((item) => ({ option_id: item.option.id, reasons: item.reasons })),
    });
    const deterministicChoice = hasDeterministicLead(localRanking.accepted) ? topRanked[0] : null;
    const maneuvers = maneuverOptions(options);
    const isJunction = options.some((option) => option.kind === "wall" && option.same_parent === true)
      && options.some((option) => option.kind === "wall" && option.same_parent === false && Math.abs(Number(option.turn_degrees ?? 0)) >= 25);
    const maneuverDecision = !deterministicChoice && isJunction
      ? await decide(
          `先判断当前墙路口的房间级行进动作。目标是沿包含 Room Seed 的最小围合前进，并与已有有向边保持同一室内侧。不要因为同一父墙的直行段距离为 0 就自动直行；应根据 Room Seed、面积证据、附近房间文字和当前路径决定直行、左转、右转、跨开口或闭环。目标面积约 ${areaEvidence?.square_metres ?? "未知"}㎡，等面积正方形边长约 ${roomScaleHint ? `${(roomScaleHint/1000).toFixed(2)}m` : "未知"}。`,
          {
            room_seed: wallElementsDocument.room_seed,
            room_area_evidence: areaEvidence,
            room_scale_hint_mm: roomScaleHint,
            nearby_annotations: annotations,
            traversal: {
              branch_id: branch.id,
              interior_side: branch.interiorSide,
              start_entry: branch.startEntry,
              current_exit: branch.currentExit,
              ordered_edges: branch.orderedEdges,
            },
            available_maneuvers: maneuvers.map((option) => ({ id: option.id, description: option.description })),
          },
          maneuvers,
        )
      : null;
    if (maneuverDecision) traces.push({ stage: "maneuver", step, branch_id: branch.id, ...maneuverDecision });
    const decision = deterministicChoice
      ? {
          request_id: null,
          model: "deterministic-local-ranking",
          provider: "local",
          usage: null,
          selected_key: "local_top",
          confidence: 1,
          probabilities: [{ key: "local_top", option: deterministicChoice.option, probability: 1 }],
          options: { local_top: { id: deterministicChoice.option.id, description: deterministicChoice.option.description } },
        }
      : await decide(
          repairMode
            ? `执行 Boundary Repair Decision。已接受的边界成员在当前端点无法继续；候选是附近此前未被房间对象接受的墙、窗、柱或其他边界对象。窗、柱和闭合轮廓已被压缩为对象级 transition，不要把对象内部绘图线当成多次行进。只有当候选能延续包含 Room Seed、面积约 ${areaEvidence?.square_metres ?? "未知"}㎡ 的同一房间围合时才批准该父对象；否则选择 uncertain。批准后会记录为 repair，不会改写物理语义类型。`
            : `选择下一条边以继续围绕同一个 Room Seed 构造单一有序边界。保持当前行进方向的一致性，不跳到平行重复线或相邻房间。候选坐标已经换算为相对 Room Seed 的米制坐标。目标面积约 ${areaEvidence?.square_metres ?? "未知"}㎡，典型线性尺度约 ${roomScaleHint ? `${(roomScaleHint/1000).toFixed(2)}m` : "未知"}。只有路径已经回到起点并形成合理围合时才选择 close_cycle；门窗可以作为 Virtual Boundary Edge。`,
          {
            room_seed: wallElementsDocument.room_seed,
            nearby_annotations: annotations,
            room_area_evidence: areaEvidence,
            traversal: {
              branch_id: branch.id,
              start_entry: branch.startEntry,
              current_exit: branch.currentExit,
              visited_element_ids: branch.visitedElementIds,
              ordered_edges: branch.orderedEdges,
            },
            candidates: topRanked.map((item) => ({ id: item.option.id, description: item.option.description, local_score: item.score, local_reasons: item.reasons })),
          },
          options,
        );
    const weightedProbabilities = maneuverDecision
      ? reweightByManeuver(decision.probabilities, maneuverDecision.probabilities)
      : decision.probabilities;
    traces.push({ stage: repairMode ? "boundary_repair" : "next", step, branch_id: branch.id, ...decision, weighted_probabilities: weightedProbabilities.map((choice) => ({ key: choice.key, option_id: choice.option.id, probability: choice.probability })) });
    const choices = diverseChoices(weightedProbabilities, Math.min(3, beamWidth));
    if (choices.length === 0) {
      terminated.push({ ...branch, termination: "no_answer" });
      continue;
    }
    choices.forEach((choice, index) => {
      const next = applyOption(branch, choice.option, choice.probability, `${step}-${index}`);
      if (next.closed) completed.push(next);
      else if (next.termination) terminated.push(next);
      else expanded.push(next);
    });
  }
  const unique = new Map<string, TraversalBranch>();
  for (const branch of expanded.sort((a, b) => b.cumulativeProbability - a.cumulativeProbability)) {
    const fingerprint = `${branch.currentExit.join(",")}|${branch.visitedElementIds.join("|")}|${branch.visitedObjectIds.join("|")}`;
    if (!unique.has(fingerprint)) unique.set(fingerprint, branch);
  }
  const ranked = [...unique.values()];
  const perStart = new Map<string, number>();
  branches = [];
  for (const branch of ranked) {
    const root = branch.id.split(".")[0]!;
    const count = perStart.get(root) ?? 0;
    if (count >= 2) continue;
    branches.push(branch);
    perStart.set(root, count + 1);
    if (branches.length >= beamWidth) break;
  }
  console.error(`Jev traversal step ${step}/${maxSteps}: active=${branches.length}, closed=${completed.length}`);
}

terminated.push(...branches.map((branch) => ({ ...branch, termination: "max_steps" })));
const attempts = completed
  .map((branch) => ({ branch, validation: validateTraversal(branch, seed) }))
  .sort((a, b) => {
    const validA = Number(a.validation.closed && a.validation.contains_seed);
    const validB = Number(b.validation.closed && b.validation.contains_seed);
    return validB - validA || b.branch.cumulativeProbability - a.branch.cumulativeProbability;
  });

const validAttempts = attempts
  .filter((attempt) => attempt.validation.closed && attempt.validation.contains_seed && attempt.validation.area >= minimumRoomArea && attempt.validation.area <= maximumRoomArea)
  .slice(0, 5);
const adjudication = await adjudicateRoom({
  model: MODEL, seed: wallElementsDocument.room_seed, annotations, areaEvidence,
  branches: validAttempts.map((attempt) => attempt.branch), minimumArea: minimumRoomArea, maximumArea: maximumRoomArea,
}, requestDecision);
const acceptedAttemptId = adjudication.accepted_attempt_id;
const finalDecision = { stage: "final", ...adjudication };
traces.push(finalDecision);
const failedDecision = decisionRecords.find((record) => record.status !== "ok");
const failureReason = adjudication.reason === "no_valid_candidates" && failedDecision ? failedDecision.status : adjudication.reason;

const result = {
  schema_version: "room-boundary-traversal-v1",
  generated_at: new Date().toISOString(),
  model: MODEL,
  endpoint: OPENROUTER_URL,
  run_manifest: manifest,
  decision_records: decisionRecords,
  replay_source: replayPath ? resolve(replayPath) : null,
  input: { cad_ir_path: cadPath, jev_decisions_path: decisionsPath, wall_elements_path: wallElementsPath, room_object_path: roomObjectPath, layer_decisions_path: layerDecisionsPath },
  policy: { beam_width: beamWidth, max_steps: maxSteps, junction_tolerance: junctionTolerance, opening_reach: openingReach, minimum_room_area: minimumRoomArea, maximum_room_area: maximumRoomArea },
  room_seed: wallElementsDocument.room_seed,
  room_area_evidence: areaEvidence,
  summary: {
    wall_element_count: elements.length,
    unfiltered_wall_element_count: allElements.length,
    primary_layer_filtered_element_count: primaryElements.length,
    repair_layer_filtered_element_count: repairElements.length,
    excluded_layer_element_count: layerPartition.excluded.length,
    supplemental_boundary_element_count: supplementalBoundaryElements.length,
    boundary_coverage_radius: boundaryCoverageRadius,
    opening_element_count: openings.length,
    completed_attempt_count: attempts.length,
    valid_attempt_count: validAttempts.length,
    terminated_attempt_count: terminated.length,
    accepted_attempt_id: acceptedAttemptId,
    face_walk_graph_face_count: walkedFaces.length,
    face_walk_seed_face_count: walkedFaces.filter((face) => face.contains_seed).length,
    face_walk_valid_room_face_count: roomFaces.length,
    traversal_strategy: faceBranches.length > 0 ? "face_walk" : "beam_fallback",
  },
  outcome: failureReason !== adjudication.reason ? "uncertain" : adjudication.outcome,
  outcome_reason: failureReason,
  accepted_attempt: acceptedAttemptId ? attempts.find((attempt) => attempt.branch.id === acceptedAttemptId) ?? null : null,
  completed_attempts: attempts,
  terminated_attempts: terminated.map((branch) => ({ branch, validation: validateTraversal(branch, seed) })),
  final_decision: finalDecision,
  layer_filtering: layerDecisionDocument ? {
    raw_decisions: layerDecisionDocument.decisions,
    effective_decisions: effectiveLayerDecisions,
    protected_layers: [...directRoomLayers].sort(),
    element_counts: layerPartition.counts,
  } : null,
  traces,
};

await mkdir(outputDir, { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, outcome: result.outcome, reason: result.outcome_reason, summary: result.summary }, null, 2));
