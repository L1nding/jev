import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  buildPickSegments,
  defaultsFromRoomObject,
  type AnnotatorDefaults,
  type PickSegment,
} from "./lib/reference-boundary-segments";

const usage = `用法：
  bun run scripts/generate-reference-boundary-annotator.ts <cad-ir.json> --output <annotator.html>
    [--room-object <room-object.json>]
    [--wall-segments <segmented-wall-elements.json>]
    [--window-id <analysis-window-id>]
    [--radius <focus-radius-mm>]
    [--cad-segments]   使用 CAD 图元分段而非墙元分段`;

const args = Bun.argv.slice(2);
const cadIndex = args.findIndex((value) => value.endsWith(".cad-ir.json"));
if (cadIndex < 0) {
  console.error(usage);
  process.exit(2);
}

const cadPath = resolve(args[cadIndex]!);
const outputIndex = args.indexOf("--output");
const outputPath = resolve(outputIndex >= 0 ? args[outputIndex + 1]! : "reports/annotate/reference-boundary.html");
const roomObjectPath = args.includes("--room-object") ? resolve(args[args.indexOf("--room-object") + 1]!) : null;
const wallSegmentsPath = args.includes("--wall-segments") ? resolve(args[args.indexOf("--wall-segments") + 1]!) : null;
const windowId = args.includes("--window-id") ? args[args.indexOf("--window-id") + 1] : undefined;
const preferWallSegments = !args.includes("--cad-segments");
const radiusOverride = args.includes("--radius") ? Number(args[args.indexOf("--radius") + 1]) : null;

const cad = JSON.parse(await readFile(cadPath, "utf8"));
const roomObject = roomObjectPath ? JSON.parse(await readFile(roomObjectPath, "utf8")) : null;
const wallElements = wallSegmentsPath ? JSON.parse(await readFile(wallSegmentsPath, "utf8")) : null;

let defaults: AnnotatorDefaults;
if (roomObject) {
  defaults = defaultsFromRoomObject(cadPath, cad, roomObject, windowId);
} else {
  const bounds = cad.selection?.bounds;
  const min = bounds?.min ?? [0, 0];
  const max = bounds?.max ?? [10000, 10000];
  defaults = {
    drawing_region_id: String(cad.selection?.region_id ?? "unknown-region"),
    analysis_window_id: windowId,
    room_seed: { source_id: "", text: "", point: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2] },
    cad_ir_path: cadPath,
    focus_bounds: [min[0], min[1], max[0], max[1]],
  };
}

if (radiusOverride && Number.isFinite(radiusOverride) && defaults.room_seed.point) {
  const [x, y] = defaults.room_seed.point;
  defaults = {
    ...defaults,
    focus_bounds: [x - radiusOverride, y - radiusOverride, x + radiusOverride, y + radiusOverride],
  };
}

const segments = buildPickSegments({
  cad,
  wallElements: wallElements ?? undefined,
  focus: defaults.focus_bounds,
  preferWallSegments,
});

const payload = {
  schema: "reference-boundary-annotator-v1",
  defaults,
  focus_bounds: defaults.focus_bounds,
  segments,
  meta: {
    cad_ir: cadPath,
    room_object: roomObjectPath,
    wall_segments: wallSegmentsPath,
    segment_count: segments.length,
    segment_origin: preferWallSegments && wallElements ? "wall" : "cad",
  },
};

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reference Room Boundary 标注</title>
  <style>
    :root {
      --bg: #0f1419;
      --panel: #1a2332;
      --border: #2d3a4f;
      --text: #e7ecf3;
      --muted: #93a4bd;
      --accent: #3b82f6;
      --boundary: #22c55e;
      --virtual: #f97316;
      --obstacle: #a855f7;
      --seed: #eab308;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
    }
    header h1 { margin: 0; font-size: 18px; font-weight: 600; }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
      gap: 12px;
      padding: 12px;
      align-items: start;
    }
    @media (max-width: 960px) {
      .layout { grid-template-columns: 1fr; }
    }
    .canvas-wrap {
      position: relative;
      min-height: 520px;
      height: calc(100vh - 120px);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      background: #06090d;
    }
    canvas { width: 100%; height: 100%; display: block; touch-action: none; cursor: crosshair; }
    .hint {
      position: absolute;
      left: 10px;
      bottom: 8px;
      color: var(--muted);
      font-size: 12px;
      pointer-events: none;
    }
    aside {
      display: grid;
      gap: 10px;
      max-height: calc(100vh - 96px);
      overflow: auto;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .card h2 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
    input, select, textarea, button {
      font: inherit;
      color: var(--text);
      background: #0b1018;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 8px;
    }
    textarea { min-height: 120px; font-family: ui-monospace, monospace; font-size: 11px; }
    button { cursor: pointer; background: #152033; }
    button.primary { background: var(--accent); border-color: #2563eb; color: #fff; }
    button.active { outline: 2px solid var(--accent); }
    .toolbar { display: flex; flex-wrap: wrap; gap: 6px; }
    .mode-bar { display: flex; flex-wrap: wrap; gap: 6px; }
    .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; max-height: 220px; overflow: auto; }
    .list li {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 12px;
      display: grid;
      gap: 4px;
    }
    .list li.selected { border-color: var(--accent); }
    .list .row { display: flex; gap: 6px; flex-wrap: wrap; }
    .list button { padding: 2px 6px; font-size: 11px; }
    .metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 12px; }
    .metrics span { color: var(--muted); }
    code { font-family: ui-monospace, monospace; font-size: 11px; }
    .legend { display: flex; flex-wrap: wrap; gap: 8px 12px; font-size: 12px; color: var(--muted); }
    .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 4px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Reference Room Boundary 标注</h1>
      <div id="meta" style="color:var(--muted);font-size:12px"></div>
    </div>
    <div class="toolbar">
      <button type="button" id="btn-import">导入 JSON</button>
      <button type="button" id="btn-export" class="primary">导出 fixture</button>
      <button type="button" id="btn-copy">复制 JSON</button>
      <input id="file-import" type="file" accept="application/json,.json" hidden>
    </div>
  </header>
  <div class="layout">
    <div class="canvas-wrap">
      <canvas id="canvas"></canvas>
      <div class="hint">滚轮缩放 · 拖动平移 · 点击线段加入标注 · Shift+点击设 Seed/面积</div>
    </div>
    <aside>
      <div class="card">
        <h2>模式</h2>
        <div class="mode-bar">
          <button type="button" data-mode="boundary" class="active">边界段</button>
          <button type="button" data-mode="virtual">虚拟边</button>
          <button type="button" data-mode="obstacle">障碍</button>
        </div>
        <div class="legend" style="margin-top:8px">
          <span><i class="dot" style="background:var(--boundary)"></i>有序边界</span>
          <span><i class="dot" style="background:var(--virtual)"></i>虚拟边</span>
          <span><i class="dot" style="background:var(--obstacle)"></i>障碍</span>
          <span><i class="dot" style="background:var(--seed)"></i>Seed</span>
        </div>
      </div>
      <div class="card">
        <h2>房间元数据</h2>
        <label>Region ID<input id="region-id"></label>
        <label>Window ID<input id="window-id"></label>
        <label>Seed source_id<input id="seed-id"></label>
        <label>Seed 文字<input id="seed-text"></label>
        <label>面积 source_id<input id="area-id"></label>
        <label>面积文字<input id="area-text"></label>
        <label>审核人<input id="reviewer"></label>
        <label>备注<textarea id="review-notes" rows="2"></textarea></label>
      </div>
      <div class="card metrics">
        <div><span>边界段</span><strong id="m-boundary">0</strong></div>
        <div><span>虚拟边</span><strong id="m-virtual">0</strong></div>
        <div><span>闭合</span><strong id="m-closed">—</strong></div>
        <div><span>估算面积 m²</span><strong id="m-area">—</strong></div>
      </div>
      <div class="card">
        <h2>有序边界 / 虚拟边</h2>
        <ul class="list" id="boundary-list"></ul>
        <div class="toolbar">
          <button type="button" id="btn-undo">撤销</button>
          <button type="button" id="btn-clear">清空边界</button>
        </div>
      </div>
      <div class="card">
        <h2>障碍</h2>
        <ul class="list" id="obstacle-list"></ul>
      </div>
      <div class="card">
        <h2>导出预览</h2>
        <textarea id="export-preview" readonly></textarea>
      </div>
    </aside>
  </div>
  <script>
  (() => {
    const DATA = ${JSON.stringify(payload)};
    const SNAP = 80;
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const state = {
      mode: 'boundary',
      scale: 1,
      x: 0,
      y: 0,
      dragging: false,
      moved: false,
      last: null,
      selectedIndex: -1,
      virtualPending: null,
      ordered: [],
      obstacles: [],
    };

    const els = {
      meta: document.getElementById('meta'),
      regionId: document.getElementById('region-id'),
      windowId: document.getElementById('window-id'),
      seedId: document.getElementById('seed-id'),
      seedText: document.getElementById('seed-text'),
      areaId: document.getElementById('area-id'),
      areaText: document.getElementById('area-text'),
      reviewer: document.getElementById('reviewer'),
      reviewNotes: document.getElementById('review-notes'),
      boundaryList: document.getElementById('boundary-list'),
      obstacleList: document.getElementById('obstacle-list'),
      exportPreview: document.getElementById('export-preview'),
      mBoundary: document.getElementById('m-boundary'),
      mVirtual: document.getElementById('m-virtual'),
      mClosed: document.getElementById('m-closed'),
      mArea: document.getElementById('m-area'),
    };

    const defaults = DATA.defaults;
    els.meta.textContent = DATA.meta.segment_count + ' 可拾取段 · ' + DATA.meta.segment_origin + ' · ' + (defaults.room_seed.text || defaults.drawing_region_id);
    els.regionId.value = defaults.drawing_region_id || '';
    els.windowId.value = defaults.analysis_window_id || '';
    els.seedId.value = defaults.room_seed.source_id || '';
    els.seedText.value = defaults.room_seed.text || '';
    els.areaId.value = defaults.area_evidence?.source_id || '';
    els.areaText.value = defaults.area_evidence?.text || '';

    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const near = (a, b, tol = SNAP) => dist(a, b) <= tol;

    const segmentEndpoints = (segment) => [segment.start, segment.end];

    const orientSegment = (segment, connectTo) => {
      if (!connectTo) return { ...segment, direction: 'forward' };
      const start = [...segment.start];
      const end = [...segment.end];
      if (near(end, connectTo)) return { ...segment, start, end, direction: 'forward' };
      if (near(start, connectTo)) return { ...segment, start: end, end: start, direction: 'reverse' };
      return { ...segment, direction: 'forward' };
    };

    const boundaryItems = () => state.ordered.filter((item) => item.kind === 'boundary_surface' || item.kind === 'virtual_boundary_edge');

    const lastBoundaryPoint = () => {
      const items = boundaryItems();
      if (!items.length) return null;
      const last = items.at(-1);
      if (last.kind === 'virtual_boundary_edge') return last.to;
      return last.end;
    };

    const polygonForArea = () => {
      const points = [];
      for (const item of boundaryItems()) {
        if (item.kind === 'boundary_surface') {
          if (!points.length) points.push(item.start);
          points.push(item.end);
        } else {
          if (!points.length) points.push(item.from);
          points.push(item.to);
        }
      }
      return points;
    };

    const shoelaceArea = (points) => {
      if (points.length < 3) return null;
      let sum = 0;
      for (let i = 0; i < points.length; i += 1) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        sum += a[0] * b[1] - b[0] * a[1];
      }
      return Math.abs(sum) / 2 / 1_000_000;
    };

    const updateMetrics = () => {
      const boundaries = state.ordered.filter((item) => item.kind === 'boundary_surface');
      const virtuals = state.ordered.filter((item) => item.kind === 'virtual_boundary_edge');
      els.mBoundary.textContent = String(boundaries.length);
      els.mVirtual.textContent = String(virtuals.length);
      const poly = polygonForArea();
      const area = shoelaceArea(poly);
      els.mArea.textContent = area == null ? '—' : area.toFixed(2);
      if (poly.length >= 3) {
        const closed = near(poly[0], poly.at(-1), SNAP * 1.5);
        els.mClosed.textContent = closed ? '是' : '否';
      } else {
        els.mClosed.textContent = '—';
      }
      els.exportPreview.value = JSON.stringify(buildFixture(), null, 2);
    };

    const renderLists = () => {
      els.boundaryList.innerHTML = '';
      state.ordered.forEach((item, index) => {
        const li = document.createElement('li');
        if (index === state.selectedIndex) li.classList.add('selected');
        const title = item.kind === 'virtual_boundary_edge'
          ? '虚拟边 #' + (item.order + 1)
          : '边界 #' + (item.order + 1) + ' · ' + item.handle;
        li.innerHTML = '<strong>' + title + '</strong><code>' + (item.source_id || '') + '</code>';
        const row = document.createElement('div');
        row.className = 'row';
        if (item.kind === 'boundary_surface') {
          const flip = document.createElement('button');
          flip.type = 'button';
          flip.textContent = '反向';
          flip.addEventListener('click', () => {
            const tmp = item.start;
            item.start = item.end;
            item.end = tmp;
            item.direction = item.direction === 'forward' ? 'reverse' : 'forward';
            draw();
            updateMetrics();
            renderLists();
          });
          row.append(flip);
        }
        const up = document.createElement('button');
        up.type = 'button';
        up.textContent = '↑';
        up.addEventListener('click', () => {
          if (index === 0) return;
          const tmp = state.ordered[index - 1];
          state.ordered[index - 1] = state.ordered[index];
          state.ordered[index] = tmp;
          renumber();
          renderLists();
          draw();
          updateMetrics();
        });
        const down = document.createElement('button');
        down.type = 'button';
        down.textContent = '↓';
        down.addEventListener('click', () => {
          if (index >= state.ordered.length - 1) return;
          const tmp = state.ordered[index + 1];
          state.ordered[index + 1] = state.ordered[index];
          state.ordered[index] = tmp;
          renumber();
          renderLists();
          draw();
          updateMetrics();
        });
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = '删';
        del.addEventListener('click', () => {
          state.ordered.splice(index, 1);
          renumber();
          renderLists();
          draw();
          updateMetrics();
        });
        row.append(up, down, del);
        li.append(row);
        li.addEventListener('click', () => { state.selectedIndex = index; renderLists(); draw(); });
        els.boundaryList.append(li);
      });

      els.obstacleList.innerHTML = '';
      state.obstacles.forEach((item, index) => {
        const li = document.createElement('li');
        li.innerHTML = '<code>' + item.source_id + '</code> · ' + item.handle;
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = '删';
        del.addEventListener('click', () => {
          state.obstacles.splice(index, 1);
          renderLists();
          draw();
          updateMetrics();
        });
        li.append(del);
        els.obstacleList.append(li);
      });
    };

    const renumber = () => {
      state.ordered.forEach((item, index) => { item.order = index; });
    };

    const addBoundarySegment = (segment) => {
      const connectTo = lastBoundaryPoint();
      const oriented = orientSegment(segment, connectTo);
      state.ordered.push({
        order: state.ordered.length,
        kind: 'boundary_surface',
        source_id: oriented.source_id,
        handle: oriented.handle,
        segment_index: oriented.segment_index,
        wall_element_id: oriented.wall_element_id || null,
        start: [...oriented.start],
        end: [...oriented.end],
        direction: oriented.direction,
        pick_id: oriented.id,
      });
      renumber();
    };

    const addVirtualEdge = (from, to, openingSourceId) => {
      state.ordered.push({
        order: state.ordered.length,
        kind: 'virtual_boundary_edge',
        from: [...from],
        to: [...to],
        opening_source_id: openingSourceId || null,
      });
      renumber();
    };

    const addObstacle = (segment) => {
      if (state.obstacles.some((item) => item.source_id === segment.source_id)) return;
      state.obstacles.push({
        source_id: segment.source_id,
        handle: segment.handle,
        role: 'interior_obstacle',
      });
    };

    const buildFixture = () => ({
      schema_version: 'reference-room-boundary-v1',
      drawing_region_id: els.regionId.value.trim(),
      analysis_window_id: els.windowId.value.trim() || null,
      room_seed: {
        source_id: els.seedId.value.trim(),
        text: els.seedText.value.trim(),
        point: defaults.room_seed.point,
      },
      area_evidence: els.areaId.value.trim() ? {
        source_id: els.areaId.value.trim(),
        text: els.areaText.value.trim(),
        point: defaults.area_evidence?.point || null,
      } : null,
      ordered_boundary: state.ordered.map((item) => item.kind === 'virtual_boundary_edge' ? {
        order: item.order,
        kind: item.kind,
        from: item.from,
        to: item.to,
        opening_source_id: item.opening_source_id,
      } : {
        order: item.order,
        kind: item.kind,
        source_id: item.source_id,
        handle: item.handle,
        segment_index: item.segment_index,
        wall_element_id: item.wall_element_id,
        start: item.start,
        end: item.end,
        direction: item.direction,
        pick_id: item.pick_id,
      }),
      obstacles: state.obstacles,
      provenance: {
        cad_ir_path: defaults.cad_ir_path,
        annotator: DATA.schema,
        segment_origin: DATA.meta.segment_origin,
      },
      review: {
        reviewer: els.reviewer.value.trim() || null,
        reviewed_at: new Date().toISOString().slice(0, 10),
        notes: els.reviewNotes.value.trim() || null,
      },
    });

    const loadFixture = (fixture) => {
      if (fixture.drawing_region_id) els.regionId.value = fixture.drawing_region_id;
      if (fixture.analysis_window_id) els.windowId.value = fixture.analysis_window_id;
      if (fixture.room_seed) {
        els.seedId.value = fixture.room_seed.source_id || '';
        els.seedText.value = fixture.room_seed.text || '';
        if (fixture.room_seed.point) defaults.room_seed.point = fixture.room_seed.point;
      }
      if (fixture.area_evidence) {
        els.areaId.value = fixture.area_evidence.source_id || '';
        els.areaText.value = fixture.area_evidence.text || '';
        defaults.area_evidence = fixture.area_evidence;
      }
      state.ordered = (fixture.ordered_boundary || []).map((item) => ({ ...item }));
      state.obstacles = (fixture.obstacles || []).map((item) => ({ ...item }));
      if (fixture.review) {
        els.reviewer.value = fixture.review.reviewer || '';
        els.reviewNotes.value = fixture.review.notes || '';
      }
      renumber();
      renderLists();
      updateMetrics();
      draw();
    };

    let width = 0;
    let height = 0;
    let dpr = 1;

    const fit = () => {
      const b = DATA.focus_bounds;
      const pad = 24;
      state.scale = Math.min((width - pad * 2) / (b[2] - b[0] || 1), (height - pad * 2) / (b[3] - b[1] || 1));
      state.x = pad - b[0] * state.scale + ((width - pad * 2) - (b[2] - b[0]) * state.scale) / 2;
      state.y = pad - b[1] * state.scale + ((height - pad * 2) - (b[3] - b[1]) * state.scale) / 2;
    };

    const screen = (x, y) => [state.x + x * state.scale, height - (state.y + y * state.scale)];

    const drawSegment = (start, end, color, widthPx, alpha = 1, dash = []) => {
      const a = screen(start[0], start[1]);
      const b = screen(end[0], end[1]);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = widthPx;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      ctx.restore();
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      for (const segment of DATA.segments) {
        drawSegment(segment.start, segment.end, '#334155', Math.max(0.6, Math.min(1.2, state.scale * 0.35)), 0.55);
      }
      for (const item of state.obstacles) {
        const matches = DATA.segments.filter((segment) => segment.source_id === item.source_id);
        for (const segment of matches) {
          drawSegment(segment.start, segment.end, '#a855f7', 4, 0.95);
        }
      }
      state.ordered.forEach((item, index) => {
        if (item.kind === 'virtual_boundary_edge') {
          drawSegment(item.from, item.to, '#f97316', 4, 1, [8, 5]);
        } else {
          const color = index === state.selectedIndex ? '#86efac' : '#22c55e';
          drawSegment(item.start, item.end, color, index === state.selectedIndex ? 5 : 4, 1);
          const mid = screen((item.start[0] + item.end[0]) / 2, (item.start[1] + item.end[1]) / 2);
          ctx.fillStyle = '#e7ecf3';
          ctx.font = '600 11px system-ui';
          ctx.fillText(String(index + 1), mid[0] + 4, mid[1] - 4);
        }
      });
      if (state.virtualPending) {
        const p = screen(state.virtualPending[0], state.virtualPending[1]);
        ctx.fillStyle = '#f97316';
        ctx.beginPath();
        ctx.arc(p[0], p[1], 5, 0, Math.PI * 2);
        ctx.fill();
      }
      const seedScreen = screen(defaults.room_seed.point[0], defaults.room_seed.point[1]);
      ctx.strokeStyle = '#eab308';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(seedScreen[0], seedScreen[1], 8, 0, Math.PI * 2);
      ctx.stroke();
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fit();
      draw();
    };

    new ResizeObserver(resize).observe(canvas.parentElement);

    const pickSegment = (sx, sy) => {
      let best = null;
      let bestD = 12;
      for (const segment of DATA.segments) {
        const a = screen(segment.start[0], segment.start[1]);
        const b = screen(segment.end[0], segment.end[1]);
        const vx = b[0] - a[0];
        const vy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((sx - a[0]) * vx + (sy - a[1]) * vy) / (vx * vx + vy * vy || 1)));
        const d = Math.hypot(sx - (a[0] + t * vx), sy - (a[1] + t * vy));
        if (d < bestD) {
          best = segment;
          bestD = d;
        }
      }
      return best;
    };

    const snapPoint = (sx, sy) => {
      const segment = pickSegment(sx, sy);
      if (!segment) return null;
      const a = screen(segment.start[0], segment.start[1]);
      const b = screen(segment.end[0], segment.end[1]);
      const candidates = [
        { world: segment.start, d: Math.hypot(sx - a[0], sy - a[1]) },
        { world: segment.end, d: Math.hypot(sx - b[0], sy - b[1]) },
      ].sort((x, y) => x.d - y.d);
      return candidates[0]?.world ?? null;
    };

    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * 0.001);
      state.x = mx - (mx - state.x) * factor;
      state.y = (height - my) - ((height - my) - state.y) * factor;
      state.scale *= factor;
      draw();
    }, { passive: false });

    canvas.addEventListener('pointerdown', (event) => {
      state.dragging = true;
      state.moved = false;
      state.last = [event.clientX, event.clientY];
      canvas.setPointerCapture(event.pointerId);
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!state.dragging) return;
      const dx = event.clientX - state.last[0];
      const dy = event.clientY - state.last[1];
      if (Math.hypot(dx, dy) > 3) state.moved = true;
      state.x += dx;
      state.y -= dy;
      state.last = [event.clientX, event.clientY];
      draw();
    });

    canvas.addEventListener('pointerup', (event) => {
      if (state.moved) {
        state.dragging = false;
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const segment = pickSegment(sx, sy);

      if (event.shiftKey && segment) {
        els.seedId.value = segment.source_id;
        if (segment.entity_type === 'TEXT' || segment.layer.includes('LEVEL')) {
          els.seedText.value = segment.handle;
        }
        defaults.room_seed.point = [
          (segment.start[0] + segment.end[0]) / 2,
          (segment.start[1] + segment.end[1]) / 2,
        ];
        updateMetrics();
        draw();
        state.dragging = false;
        return;
      }

      if (state.mode === 'obstacle' && segment) {
        addObstacle(segment);
        renderLists();
        updateMetrics();
        draw();
        state.dragging = false;
        return;
      }

      if (state.mode === 'virtual') {
        const snapped = snapPoint(sx, sy);
        if (!snapped) {
          state.dragging = false;
          return;
        }
        if (!state.virtualPending) {
          state.virtualPending = snapped;
        } else {
          addVirtualEdge(state.virtualPending, snapped, segment?.source_id ?? null);
          state.virtualPending = null;
          renderLists();
          updateMetrics();
          draw();
        }
        state.dragging = false;
        return;
      }

      if (segment) {
        addBoundarySegment(segment);
        renderLists();
        updateMetrics();
        draw();
      }
      state.dragging = false;
    });

    document.querySelectorAll('[data-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        state.mode = button.dataset.mode;
        state.virtualPending = null;
        document.querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === button));
        draw();
      });
    });

    document.getElementById('btn-undo').addEventListener('click', () => {
      state.ordered.pop();
      renumber();
      renderLists();
      updateMetrics();
      draw();
    });

    document.getElementById('btn-clear').addEventListener('click', () => {
      state.ordered = [];
      state.virtualPending = null;
      renderLists();
      updateMetrics();
      draw();
    });

    ['region-id', 'window-id', 'seed-id', 'seed-text', 'area-id', 'area-text', 'reviewer', 'review-notes'].forEach((id) => {
      document.getElementById(id).addEventListener('input', updateMetrics);
    });

    document.getElementById('btn-export').addEventListener('click', () => {
      const fixture = buildFixture();
      const blob = new Blob([JSON.stringify(fixture, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const slug = (els.seedText.value || 'room').replace(/\\s+/g, '-');
      anchor.href = url;
      anchor.download = slug + '.reference-room-boundary.json';
      anchor.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById('btn-copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(JSON.stringify(buildFixture(), null, 2));
    });

    const importInput = document.getElementById('file-import');
    document.getElementById('btn-import').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      loadFixture(JSON.parse(await file.text()));
      importInput.value = '';
    });

    renderLists();
    updateMetrics();
    resize();
  })();
  </script>
</body>
</html>`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, html, "utf8");
console.log(JSON.stringify({
  output: outputPath,
  bytes: Buffer.byteLength(html),
  segments: segments.length,
  defaults,
}, null, 2));
