import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Entity = {
  id: string;
  source: { entity_type: string; layer: string; handle: string };
  anchor: { local: number[] | null };
  geometry: { local: Record<string, any> | null };
};

const [cadArg, jevArg, outputArg, objectArg, traversalArg] = Bun.argv.slice(2);
if (!cadArg || !jevArg || !outputArg) {
  console.error("用法：bun run scripts/generate-compare-visual.ts <cad-ir.json> <jev-decisions.json> <output.html> [jev-object.json] [room-traversal.json]");
  process.exit(2);
}

const cadPath = resolve(cadArg);
const jevPath = resolve(jevArg);
const outputPath = resolve(outputArg);
const cad = JSON.parse(await readFile(cadPath, "utf8"));
const jev = JSON.parse(await readFile(jevPath, "utf8"));
const semanticObject = objectArg ? JSON.parse(await readFile(resolve(objectArg), "utf8")) : null;
const traversal = traversalArg ? JSON.parse(await readFile(resolve(traversalArg), "utf8")) : null;

const round = (value: unknown) => Math.round(Number(value) * 10) / 10;
const layers = [...new Set<string>(cad.entities.map((entity: Entity) => entity.source.layer))].sort();
const layerIndex = new Map(layers.map((layer, index) => [layer, index]));
const layerCounts = new Array(layers.length).fill(0);
const entities: any[] = [];

for (const entity of cad.entities as Entity[]) {
  const geometry = entity.geometry.local ?? {};
  const type = entity.source.entity_type;
  const layer = layerIndex.get(entity.source.layer) ?? 0;
  layerCounts[layer] += 1;
  const base = [entity.source.handle, type, layer];
  if (geometry.kind === "line" && geometry.start && geometry.end) {
    entities.push([...base, "l", round(geometry.start[0]), round(geometry.start[1]), round(geometry.end[0]), round(geometry.end[1])]);
  } else if (geometry.kind === "polyline" && Array.isArray(geometry.vertices)) {
    entities.push([...base, "p", geometry.closed ? 1 : 0, geometry.vertices.flatMap((point: number[]) => [round(point[0]), round(point[1])])]);
  } else if (geometry.kind === "solid" && Array.isArray(geometry.vertices)) {
    // DXF SOLID stores the last two corners in crossing order. Reorder them so
    // the semantic overlay follows the actual perimeter instead of a point or bow-tie.
    const vertices = geometry.vertices.length === 4
      ? [geometry.vertices[0], geometry.vertices[1], geometry.vertices[3], geometry.vertices[2]]
      : geometry.vertices;
    entities.push([...base, "p", 1, vertices.flatMap((point: number[]) => [round(point[0]), round(point[1])])]);
  } else if ((geometry.kind === "circle" || geometry.kind === "arc") && geometry.center) {
    entities.push([...base, geometry.kind === "circle" ? "c" : "a", round(geometry.center[0]), round(geometry.center[1]), round(geometry.radius), round(geometry.start_angle ?? 0), round(geometry.end_angle ?? 360)]);
  } else if (geometry.kind === "block_reference" && entity.anchor.local) {
    entities.push([...base, "b", round(entity.anchor.local[0]), round(entity.anchor.local[1]), round(Math.abs(geometry.scale?.[0] ?? 1)), round(Math.abs(geometry.scale?.[1] ?? 1)), round(geometry.rotation ?? 0)]);
  } else if (entity.anchor.local) {
    entities.push([...base, "x", round(entity.anchor.local[0]), round(entity.anchor.local[1])]);
  }
}

const decisions = Object.fromEntries(
  jev.decisions.map((decision: any) => [
    String(decision.source_id).replace(/^source:/, ""),
    {
      type: decision.semantic_type,
      confidence: decision.confidence,
      probabilities: decision.probabilities,
      model: decision.model,
      request: decision.request_id,
    },
  ]),
);

const entityById = new Map<string, Entity>((cad.entities as Entity[]).map((entity) => [entity.id, entity]));
const objectRoles = semanticObject?.object?.roles
  ? Object.fromEntries(Object.entries(semanticObject.object.roles).map(([sourceId, role]) => [sourceId.replace(/^source:/, ""), role]))
  : null;
const objectSourceIds: string[] = semanticObject?.object?.source_entities ?? [];
const objectBoundsValues = objectSourceIds
  .flatMap((sourceId) => entityById.get(sourceId)?.bbox.local ?? [])
  .map(Number)
  .filter(Number.isFinite);
const objectBounds = objectBoundsValues.length >= 4
  ? (() => {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const sourceId of objectSourceIds) {
        const bbox = entityById.get(sourceId)?.bbox.local;
        if (!bbox) continue;
        xs.push(Number(bbox[0]), Number(bbox[2]));
        ys.push(Number(bbox[1]), Number(bbox[3]));
      }
      const pad = 500;
      return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
    })()
  : null;
const objectPayload = semanticObject ? {
  id: semanticObject.object.id,
  type: semanticObject.object.semantic_type,
  seed: String(semanticObject.object.seed_source_id ?? "").replace(/^source:/, ""),
  label: semanticObject.query.seed_text ?? null,
  roles: objectRoles,
  bounds: objectBounds,
  summary: semanticObject.summary,
  validation: semanticObject.object.geometry_validation,
} : null;

const traversalAttempts = traversal
  ? [...(traversal.completed_attempts ?? []), ...(traversal.terminated_attempts ?? [])]
      .sort((a: any, b: any) => Number(b.branch.cumulativeProbability) - Number(a.branch.cumulativeProbability))
      .slice(0, 5)
      .map((attempt: any) => ({
        id: attempt.branch.id,
        probability: Number(attempt.branch.cumulativeProbability),
        termination: attempt.branch.termination ?? (attempt.branch.closed ? "closed" : "active"),
        validation: attempt.validation,
        edges: attempt.branch.orderedEdges.map((edge: any) => edge.kind === "wall"
          ? { kind: "wall", id: edge.element_id, from: edge.entry.map(round), to: edge.exit.map(round) }
          : { kind: edge.kind, id: edge.opening_element_id ?? null, from: edge.from.map(round), to: edge.to.map(round) }),
      }))
  : [];
const traversalPayload = traversal ? {
  outcome: traversal.outcome,
  summary: traversal.summary,
  areaEvidence: traversal.room_area_evidence,
  seed: traversal.room_seed,
  attempts: traversalAttempts,
} : null;

const payload = JSON.stringify({
  bounds: [0, 0, round(cad.selection.bounds.max[0] - cad.selection.bounds.min[0]), round(cad.selection.bounds.max[1] - cad.selection.bounds.min[1])],
  entities,
  layers,
  layerCounts,
  decisions,
  object: objectPayload,
  traversal: traversalPayload,
  meta: {
    region: cad.selection.region_id,
    rawCount: cad.entities.length,
    decisionCount: jev.summary.decision_count,
    model: jev.decisions[0]?.model ?? jev.model,
  },
});

const html = `<div id="cad-jev-compare">
  <style>
    #cad-jev-compare { color: var(--foreground); display:grid; gap:12px; }
    #cad-jev-compare .topline { display:flex; gap:12px; justify-content:space-between; align-items:end; flex-wrap:wrap; }
    #cad-jev-compare .title-block { display:grid; gap:2px; }
    #cad-jev-compare .metrics { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
    #cad-jev-compare .workspace { display:grid; grid-template-columns:minmax(0,1fr) 260px; gap:12px; align-items:start; }
    #cad-jev-compare .canvas-wrap { position:relative; min-height:560px; height:68vh; max-height:760px; border:1px solid var(--border); background:var(--background); overflow:hidden; }
    #cad-jev-compare canvas { width:100%; height:100%; display:block; touch-action:none; }
    #cad-jev-compare .detail { display:grid; gap:10px; }
    #cad-jev-compare .detail dl { display:grid; grid-template-columns:auto 1fr; gap:6px 10px; margin:0; }
    #cad-jev-compare .detail dd { margin:0; overflow-wrap:anywhere; }
    #cad-jev-compare .legend { display:flex; gap:8px 12px; flex-wrap:wrap; }
    #cad-jev-compare .legend span { display:inline-flex; gap:5px; align-items:center; }
    #cad-jev-compare .swatch { width:10px; height:10px; border-radius:50%; background:var(--swatch); }
    #cad-jev-compare .canvas-hint { position:absolute; left:10px; bottom:8px; color:var(--muted-foreground); pointer-events:none; }
    #cad-jev-compare .empty { color:var(--muted-foreground); }
    #cad-jev-compare [hidden] { display:none !important; }
    @media (max-width:760px) {
      #cad-jev-compare .workspace { grid-template-columns:1fr; }
      #cad-jev-compare .canvas-wrap { min-height:430px; height:58vh; }
      #cad-jev-compare .metrics { grid-template-columns:1fr; }
    }
  </style>

  <div class="topline">
    <div class="title-block">
      <h2>CAD 原图与 Jev 识别对比</h2>
      <span class="text-muted text-small" id="cad-meta"></span>
    </div>
    <div class="nav nav-pills" role="tablist" aria-label="显示模式">
      <button class="nav-link" type="button" data-mode="raw" aria-selected="false">原图</button>
      <button class="nav-link" type="button" data-mode="jev" aria-selected="false">Jev</button>
      <button class="nav-link active" type="button" data-mode="overlay" aria-selected="true">叠加</button>
      ${objectPayload ? '<button class="nav-link" type="button" data-mode="room" aria-selected="false">房间候选</button>' : ''}
      ${traversalPayload ? '<button class="nav-link" type="button" data-mode="traversal" aria-selected="false">有序遍历</button>' : ''}
    </div>
  </div>

  <div class="metrics">
    <div class="card viz-stat"><span class="text-muted">原始图元</span><span class="viz-stat-value tabular-nums" id="raw-count"></span></div>
    <div class="card viz-stat"><span class="text-muted">Jev 已识别</span><span class="viz-stat-value tabular-nums" id="jev-count"></span></div>
    <div class="card viz-stat"><span class="text-muted">当前可见</span><span class="viz-stat-value tabular-nums" id="visible-count"></span></div>
  </div>

  <div class="viz-controls">
    <label class="form-label">图层
      <select class="form-select" id="layer-select"></select>
    </label>
    <label class="form-label">图元
      <select class="form-select" id="type-select">
        <option value="all">全部</option><option value="linear">线段/多段线</option><option value="blocks">块引用</option><option value="annotations">文字/标注</option><option value="other">其他</option>
      </select>
    </label>
    <label class="form-label">最低置信度 <span class="tabular-nums" id="confidence-label">0%</span>
      <input class="form-range" id="confidence" type="range" min="0" max="100" value="0" step="1">
    </label>
    <button class="btn" type="button" id="reset-view">重置视图</button>
    ${traversalPayload ? `<label class="form-label">遍历路径
      <select class="form-select" id="attempt-select">${traversalAttempts.map((attempt: any, index: number) => `<option value="${index}">路径 ${index + 1} · ${(attempt.probability * 100).toFixed(2)}% · ${attempt.termination}</option>`).join("")}</select>
    </label>` : ''}
  </div>

  <div class="legend" aria-label="Jev 语义颜色">
    <span><i class="swatch" style="--swatch:var(--viz-series-1)"></i>墙</span>
    <span><i class="swatch" style="--swatch:var(--viz-series-2)"></i>门</span>
    <span><i class="swatch" style="--swatch:var(--viz-series-3)"></i>窗</span>
    <span><i class="swatch" style="--swatch:var(--viz-series-4)"></i>柱</span>
    <span><i class="swatch" style="--swatch:var(--viz-series-5)"></i>家具/楼梯</span>
    <span><i class="swatch" style="--swatch:var(--viz-series-6)"></i>标注/未知</span>
  </div>
  ${objectPayload ? `<div class="legend" aria-label="房间候选角色">
    <span><i class="swatch" style="--swatch:var(--viz-series-1)"></i>房间边界</span>
    <span><i class="swatch" style="--swatch:var(--viz-series-2)"></i>门窗洞口</span>
    <span><i class="swatch" style="--swatch:var(--viz-series-3)"></i>内部对象</span>
    <span><i class="swatch" style="--swatch:var(--red)"></i>开放端点</span>
    <span class="text-muted">${objectPayload.label ?? objectPayload.id} · ${objectPayload.validation?.closed_boundary ? '边界闭合' : '边界未闭合'}</span>
  </div>` : ''}
  ${traversalPayload ? `<div class="legend" aria-label="有序遍历图例">
    <span><i class="swatch" style="--swatch:var(--viz-series-1)"></i>墙边顺序</span>
    <span><i class="swatch" style="--swatch:var(--viz-series-2)"></i>虚拟连接</span>
    <span><i class="swatch" style="--swatch:var(--green)"></i>起点</span>
    <span><i class="swatch" style="--swatch:var(--red)"></i>终止点</span>
    <span class="text-muted">${traversalPayload.areaEvidence?.text ?? '无面积证据'} · ${traversalPayload.outcome}</span>
  </div>` : ''}

  <div class="workspace">
    <div class="canvas-wrap">
      <canvas id="cad-canvas" aria-label="CAD 原始图元与 Jev 识别结果画布"></canvas>
      <span class="canvas-hint text-small">滚轮缩放 · 拖动平移 · 点击图元查看详情</span>
    </div>
    <aside class="card detail" aria-live="polite">
      <h3>图元详情</h3>
      <div id="detail-empty" class="empty">点击任意可见图元。</div>
      <dl id="detail-data" hidden>
        <dt>Handle</dt><dd><code id="detail-handle"></code></dd>
        <dt>原始类型</dt><dd id="detail-type"></dd>
        <dt>图层</dt><dd id="detail-layer"></dd>
        <dt>Jev 类型</dt><dd id="detail-semantic"></dd>
        <dt>房间角色</dt><dd id="detail-room-role"></dd>
        <dt>置信度</dt><dd id="detail-confidence" class="tabular-nums"></dd>
        <dt>概率</dt><dd id="detail-probabilities"></dd>
        <dt>模型</dt><dd><code id="detail-model"></code></dd>
      </dl>
    </aside>
  </div>

  <script>
  (() => {
    const root = document.getElementById('cad-jev-compare');
    const DATA = ${payload};
    const canvas = root.querySelector('#cad-canvas');
    const ctx = canvas.getContext('2d');
    const layerSelect = root.querySelector('#layer-select');
    const typeSelect = root.querySelector('#type-select');
    const confidence = root.querySelector('#confidence');
    const confidenceLabel = root.querySelector('#confidence-label');
    const visibleCount = root.querySelector('#visible-count');
    const attemptSelect = root.querySelector('#attempt-select');
    const saved = window.openai?.widgetState?.privateContent || {};
    const allowedModes = ['raw','jev','overlay',...(DATA.object?['room']:[]),...(DATA.traversal?['traversal']:[])];
    const state = { mode: allowedModes.includes(saved.mode) ? saved.mode : (DATA.traversal ? 'traversal' : DATA.object ? 'room' : 'overlay'), layer: saved.layer || 'all', type: saved.type || 'all', confidence: saved.confidence || 0, attempt:Number(saved.attempt||0), scale:1, x:0, y:0, dragging:false, last:null };
    const semanticColors = { wall:'--viz-series-1', door:'--viz-series-2', window:'--viz-series-3', column:'--viz-series-4', stair:'--viz-series-5', furniture:'--viz-series-5', annotation:'--viz-series-6', unknown:'--viz-series-6' };
    const roomColors = { boundary:'--viz-series-1', opening:'--viz-series-2', interior:'--viz-series-3' };
    const colorProbe = document.createElement('span');
    colorProbe.setAttribute('aria-hidden','true');
    colorProbe.style.cssText='position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
    root.append(colorProbe);
    // Canvas does not accept theme expressions such as light-dark(...).
    // Resolve the custom property through a real CSS color declaration first.
    const css = name => { colorProbe.style.color='var('+name+')'; return getComputedStyle(colorProbe).color; };
    const rawColor = () => css('--muted-foreground');
    const decisionColor = type => css(semanticColors[type] || '--viz-series-6');
    const roomColor = role => css(roomColors[role] || '--viz-series-6');
    const isAnnotation = type => ['TEXT','MTEXT','DIMENSION','ATTRIB','ATTDEF'].includes(type);
    const category = entity => ['LINE','LWPOLYLINE'].includes(entity[1]) ? 'linear' : entity[1] === 'INSERT' ? 'blocks' : isAnnotation(entity[1]) ? 'annotations' : 'other';
    const decision = entity => DATA.decisions[entity[0]];
    const passes = entity => {
      if (state.layer !== 'all' && String(entity[2]) !== state.layer) return false;
      if (state.type !== 'all' && category(entity) !== state.type) return false;
      const d = decision(entity);
      if (state.mode === 'jev' && !d) return false;
      if (state.mode === 'room' && !DATA.object?.roles?.[entity[0]]) return true;
      if (d && Number(d.confidence || 0) * 100 < state.confidence) return state.mode === 'raw';
      return true;
    };
    DATA.layers.forEach((layer, index) => { const option=document.createElement('option'); option.value=String(index); option.textContent=layer+' ('+DATA.layerCounts[index].toLocaleString()+')'; layerSelect.append(option); });
    layerSelect.insertAdjacentHTML('afterbegin','<option value="all">全部图层</option>');
    layerSelect.value=state.layer; typeSelect.value=state.type; confidence.value=String(state.confidence); confidenceLabel.textContent=state.confidence+'%';
    if(attemptSelect){state.attempt=Math.min(state.attempt,Math.max(0,DATA.traversal.attempts.length-1));attemptSelect.value=String(state.attempt);}
    root.querySelector('#cad-meta').textContent=DATA.meta.region+' · '+DATA.meta.model;
    root.querySelector('#raw-count').textContent=DATA.meta.rawCount.toLocaleString(); root.querySelector('#jev-count').textContent=DATA.meta.decisionCount.toLocaleString();
    root.querySelectorAll('[data-mode]').forEach(button => { const active=button.dataset.mode===state.mode; button.classList.toggle('active',active); button.setAttribute('aria-selected',String(active)); });

    let width=0,height=0,dpr=1;
    const traversalBounds=()=>{const attempt=DATA.traversal?.attempts?.[state.attempt];if(!attempt)return null;const points=attempt.edges.flatMap(edge=>[edge.from,edge.to]);if(DATA.traversal?.seed?.point)points.push(DATA.traversal.seed.point);const xs=points.map(point=>point[0]),ys=points.map(point=>point[1]),pad=500;return[Math.min(...xs)-pad,Math.min(...ys)-pad,Math.max(...xs)+pad,Math.max(...ys)+pad];};
    const fit = () => { const b=state.mode==='traversal'?(traversalBounds()||DATA.bounds):state.mode==='room'&&DATA.object?.bounds?DATA.object.bounds:DATA.bounds; const pad=24; state.scale=Math.min((width-pad*2)/(b[2]-b[0]),(height-pad*2)/(b[3]-b[1])); state.x=pad-b[0]*state.scale+((width-pad*2)-(b[2]-b[0])*state.scale)/2; state.y=pad-b[1]*state.scale+((height-pad*2)-(b[3]-b[1])*state.scale)/2; };
    const screen = (x,y) => [state.x+x*state.scale, height-(state.y+y*state.scale)];
    const drawEntity = (entity, color, alpha, lineWidth) => {
      const kind=entity[3]; ctx.strokeStyle=color; ctx.fillStyle=color; ctx.globalAlpha=alpha; ctx.lineWidth=lineWidth; ctx.beginPath();
      if(kind==='l'){const a=screen(entity[4],entity[5]),b=screen(entity[6],entity[7]);ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();}
      else if(kind==='p'){const pts=entity[5];if(pts.length>=2){const a=screen(pts[0],pts[1]);ctx.moveTo(...a);for(let i=2;i<pts.length;i+=2)ctx.lineTo(...screen(pts[i],pts[i+1]));if(entity[4])ctx.closePath();ctx.stroke();}}
      else if(kind==='c'||kind==='a'){const c=screen(entity[4],entity[5]);ctx.arc(c[0],c[1],Math.max(1,entity[6]*state.scale),-entity[8]*Math.PI/180,-entity[7]*Math.PI/180);ctx.stroke();}
      else if(kind==='b'){const p=screen(entity[4],entity[5]), worldW=entity[6]>20?entity[6]:500, worldH=entity[7]>20?entity[7]:500, w=Math.max(7,worldW*state.scale),h=Math.max(7,worldH*state.scale),r=entity[8]*Math.PI/180;ctx.save();ctx.translate(p[0],p[1]);ctx.rotate(-r);ctx.rect(-w/2,-h/2,w,h);ctx.moveTo(-w/2,0);ctx.lineTo(w/2,0);ctx.moveTo(0,-h/2);ctx.lineTo(0,h/2);ctx.stroke();ctx.restore();}
      else {const p=screen(entity[4],entity[5]),r=Math.max(4,lineWidth+2);ctx.moveTo(p[0]-r,p[1]);ctx.lineTo(p[0]+r,p[1]);ctx.moveTo(p[0],p[1]-r);ctx.lineTo(p[0],p[1]+r);ctx.stroke();}
      ctx.globalAlpha=1;
    };
    const draw = () => {
      ctx.clearRect(0,0,width,height); let count=0;
      for(const entity of DATA.entities){if(!passes(entity))continue;const d=decision(entity),role=DATA.object?.roles?.[entity[0]];if(state.mode==='traversal'){drawEntity(entity,rawColor(),0.07,Math.max(.3,Math.min(.7,state.scale*.45)));}else if(state.mode==='room'){drawEntity(entity,rawColor(),role?0.16:0.08,Math.max(.35,Math.min(.8,state.scale*.5)));if(role)drawEntity(entity,roomColor(role),role==='interior'?0.72:0.98,role==='boundary'?4:3);}else{if(state.mode!=='jev')drawEntity(entity,rawColor(),state.mode==='overlay'&&d?0.22:0.52,Math.max(.45,Math.min(1.2,state.scale*.8)));if(d&&state.mode!=='raw'&&Number(d.confidence||0)*100>=state.confidence)drawEntity(entity,decisionColor(d.type),0.96,3);}count++;}
      if(state.mode==='room'&&DATA.object?.validation?.open_endpoints){ctx.strokeStyle=css('--red');ctx.lineWidth=2;ctx.globalAlpha=1;for(const point of DATA.object.validation.open_endpoints){const p=screen(point[0],point[1]),r=6;ctx.beginPath();ctx.moveTo(p[0]-r,p[1]-r);ctx.lineTo(p[0]+r,p[1]+r);ctx.moveTo(p[0]+r,p[1]-r);ctx.lineTo(p[0]-r,p[1]+r);ctx.stroke();}}
      if(state.mode==='traversal'&&DATA.traversal?.attempts?.[state.attempt]){const attempt=DATA.traversal.attempts[state.attempt];attempt.edges.forEach((edge,index)=>{const a=screen(edge.from[0],edge.from[1]),b=screen(edge.to[0],edge.to[1]),virtual=edge.kind!=='wall';ctx.strokeStyle=virtual?css('--viz-series-2'):css('--viz-series-1');ctx.fillStyle=ctx.strokeStyle;ctx.globalAlpha=1;ctx.lineWidth=virtual?3:5;ctx.setLineDash(virtual?[8,5]:[]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();ctx.setLineDash([]);const mx=(a[0]+b[0])/2,my=(a[1]+b[1])/2;ctx.fillStyle=css('--foreground');ctx.font='500 12px system-ui';ctx.fillText(String(index+1),mx+4,my-4);});const first=attempt.edges[0],last=attempt.edges.at(-1);if(first){const p=screen(first.from[0],first.from[1]);ctx.fillStyle=css('--green');ctx.beginPath();ctx.arc(p[0],p[1],6,0,Math.PI*2);ctx.fill();}if(last){const p=screen(last.to[0],last.to[1]),r=7;ctx.strokeStyle=css('--red');ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(p[0]-r,p[1]-r);ctx.lineTo(p[0]+r,p[1]+r);ctx.moveTo(p[0]+r,p[1]-r);ctx.lineTo(p[0]-r,p[1]+r);ctx.stroke();}if(DATA.traversal.seed?.point){const p=screen(DATA.traversal.seed.point[0],DATA.traversal.seed.point[1]);ctx.strokeStyle=css('--purple');ctx.lineWidth=2;ctx.beginPath();ctx.arc(p[0],p[1],8,0,Math.PI*2);ctx.stroke();}}
      visibleCount.textContent=count.toLocaleString();
    };
    const resize = () => { const rect=canvas.getBoundingClientRect();width=rect.width;height=rect.height;dpr=devicePixelRatio||1;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);fit();draw(); };
    new ResizeObserver(resize).observe(canvas.parentElement);
    const persist=()=>window.openai?.setWidgetState?.({privateContent:{mode:state.mode,layer:state.layer,type:state.type,confidence:state.confidence,attempt:state.attempt},modelContent:{view:state.mode,selectedLayer:state.layer==='all'?'all':DATA.layers[Number(state.layer)],minimumConfidence:state.confidence,traversalAttempt:state.attempt}}).catch(()=>{});
    root.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>{state.mode=button.dataset.mode;root.querySelectorAll('[data-mode]').forEach(b=>{const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});fit();draw();persist();}));
    layerSelect.addEventListener('change',()=>{state.layer=layerSelect.value;draw();persist();}); typeSelect.addEventListener('change',()=>{state.type=typeSelect.value;draw();persist();}); confidence.addEventListener('input',()=>{state.confidence=Number(confidence.value);confidenceLabel.textContent=state.confidence+'%';draw();persist();}); root.querySelector('#reset-view').addEventListener('click',()=>{fit();draw();});
    attemptSelect?.addEventListener('change',()=>{state.attempt=Number(attemptSelect.value);if(state.mode!=='traversal'){state.mode='traversal';root.querySelectorAll('[data-mode]').forEach(b=>{const active=b.dataset.mode==='traversal';b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});}fit();draw();persist();});
    canvas.addEventListener('wheel',event=>{event.preventDefault();const rect=canvas.getBoundingClientRect(),mx=event.clientX-rect.left,my=event.clientY-rect.top;const factor=Math.exp(-event.deltaY*.001);state.x=mx-(mx-state.x)*factor;state.y=(height-my)-((height-my)-state.y)*factor;state.scale*=factor;draw();},{passive:false});
    canvas.addEventListener('pointerdown',event=>{state.dragging=true;state.last=[event.clientX,event.clientY];canvas.setPointerCapture(event.pointerId);}); canvas.addEventListener('pointermove',event=>{if(!state.dragging)return;state.x+=event.clientX-state.last[0];state.y-=event.clientY-state.last[1];state.last=[event.clientX,event.clientY];draw();}); canvas.addEventListener('pointerup',()=>state.dragging=false);
    const entityDistance=(e,sx,sy)=>{if(e[3]==='l'){const a=screen(e[4],e[5]),b=screen(e[6],e[7]),vx=b[0]-a[0],vy=b[1]-a[1],t=Math.max(0,Math.min(1,((sx-a[0])*vx+(sy-a[1])*vy)/(vx*vx+vy*vy||1)));return Math.hypot(sx-(a[0]+t*vx),sy-(a[1]+t*vy));}const p=e[3]==='p'?screen(e[5][0],e[5][1]):screen(e[4],e[5]);return Math.hypot(sx-p[0],sy-p[1]);};
    canvas.addEventListener('click',event=>{if(state.last&&Math.hypot(event.clientX-state.last[0],event.clientY-state.last[1])>4)return;const rect=canvas.getBoundingClientRect(),sx=event.clientX-rect.left,sy=event.clientY-rect.top;let best=null,bestD=12;for(const entity of DATA.entities){if(!passes(entity))continue;const d=entityDistance(entity,sx,sy);if(d<bestD){best=entity;bestD=d;}}if(!best)return;const d=decision(best);root.querySelector('#detail-empty').hidden=true;root.querySelector('#detail-data').hidden=false;root.querySelector('#detail-handle').textContent=best[0];root.querySelector('#detail-type').textContent=best[1];root.querySelector('#detail-layer').textContent=DATA.layers[best[2]];root.querySelector('#detail-semantic').textContent=d?.type||'未识别';root.querySelector('#detail-room-role').textContent=DATA.object?.roles?.[best[0]]||'—';root.querySelector('#detail-confidence').textContent=d?Math.round(d.confidence*100)+'%':'—';root.querySelector('#detail-probabilities').textContent=d?Object.entries(d.probabilities).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>k+' '+Math.round(v*100)+'%').join(' · '):'—';root.querySelector('#detail-model').textContent=d?.model||'—';});
  })();
  </script>
</div>
`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, html, "utf8");
console.log(JSON.stringify({ output: outputPath, bytes: Buffer.byteLength(html), entities: entities.length, decisions: Object.keys(decisions).length }, null, 2));
