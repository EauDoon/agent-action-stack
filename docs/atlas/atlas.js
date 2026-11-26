/* The semantic reference is also the local data source for the interactive view. */
const select = (id) => document.getElementById(id);
const nodes = [...select("stages").children].map((article) => ({
  id: article.dataset.node,
  name: article.querySelector("h3").textContent,
  role: article.querySelector("p").textContent,
  evidence: article.querySelector(".evidence").textContent,
  source: article.querySelector("a").href,
  sourceLabel: article.querySelector("a").textContent,
  position: article.dataset.position.split(",").map(Number),
}));
const routes = [...select("routes").children].map((element) => ({
  id: element.dataset.route,
  name: element.querySelector("dt").textContent,
  description: element.querySelector("dd").textContent,
  steps: element.dataset.steps.split(" "),
}));
const nodeById = new Map(nodes.map((node) => [node.id, node]));
const trace = select("trace");
const inspect = select("inspect");
const canvas = document.querySelector("canvas");
const ctx = canvas.getContext("2d");
const edges = new Map();
for (const route of routes) {
  trace.add(new Option(route.name, route.id));
  for (let i = 1; i < route.steps.length; i++) {
    const from = route.steps[i - 1], to = route.steps[i];
    edges.set(from + "/" + to, { from, to });
  }
}
for (const node of nodes) inspect.add(new Option(node.name, node.id));

const startAngle = { yaw: -0.1, pitch: 0.15 };
let camera = { ...startAngle };
let points = [];
let route;
let selected;
let downloadUrl;

function project([x, y, z]) {
  const u = x * Math.cos(camera.yaw) + z * Math.sin(camera.yaw);
  const depth = z * Math.cos(camera.yaw) - x * Math.sin(camera.yaw);
  const v = y * Math.cos(camera.pitch) - depth * Math.sin(camera.pitch);
  const w = depth * Math.cos(camera.pitch) + y * Math.sin(camera.pitch);
  const perspective = 8 / (8 - w);
  return { x: u * perspective, y: -v * perspective, depth: w };
}

function line(a, b, color, weight) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = weight;
  ctx.stroke();
}

function draw() {
  if (!ctx || !route) return;
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const projected = nodes.map((node) => ({ ...project(node.position), node }));
  const extentX = Math.max(...projected.map((p) => Math.abs(p.x)));
  const extentY = Math.max(...projected.map((p) => Math.abs(p.y)));
  const scale = Math.min(width / 6.5, height / 3.95,
    (width / 2 - 16) / extentX, (height / 2 - 28) / extentY);
  const onCanvas = (p) => ({ ...p, x: width / 2 + p.x * scale, y: height / 2 + p.y * scale });
  const at = (position) => onCanvas(project(position));
  for (let i = -4; i <= 4; i++) {
    line(at([i, -1.6, -3]), at([i, -1.6, 3]), "#284047", 0.65);
    line(at([-4, -1.6, i]), at([4, -1.6, i]), "#284047", 0.65);
  }
  points = projected.map(onCanvas).sort((a, b) => a.depth - b.depth);
  const pointById = new Map(points.map((point) => [point.node.id, point]));
  for (const { from, to } of edges.values()) {
    const a = pointById.get(from), b = pointById.get(to);
    const i = route.steps.indexOf(from);
    const active = i >= 0 && route.steps[i + 1] === to;
    const color = active ? "#a4f3ce" : "#819ca3";
    ctx.setLineDash(active ? [] : [4, 5]);
    line(a, b, color, active ? 2.6 : 1.4);
    ctx.setLineDash([]);
    const theta = Math.atan2(b.y - a.y, b.x - a.x);
    const tip = { x: a.x + (b.x - a.x) * .65, y: a.y + (b.y - a.y) * .65 };
    for (const offset of [-.55, .55]) {
      line(tip, { x: tip.x - 7 * Math.cos(theta + offset), y: tip.y - 7 * Math.sin(theta + offset) }, color, 1.6);
    }
  }
  for (const point of points) {
    const { x, y, depth, node } = point;
    const radius = 6 + (depth + 3) / 2.5;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    const onTrace = route.steps.includes(node.id);
    ctx.fillStyle = node === selected ? "#f3cb83" : onTrace ? "#a4f3ce" : "#102127";
    ctx.fill();
    if (!onTrace && node !== selected) {
      ctx.strokeStyle = "#a5bcc2";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (node === selected) {
      ctx.beginPath();
      ctx.arc(x, y, radius + 5, 0, 2 * Math.PI);
      ctx.strokeStyle = "#f3cb83";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  drawLabels(width, height);
}

function drawLabels(width, height) {
  const fontSize = width < 450 ? 12 : 14;
  const row = fontSize + 6;
  ctx.font = "600 " + fontSize + "px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Reserve every marker first so a label cannot hide a nearby stage.
  const occupied = points.map(({ x, y }) => ({ x, y, halfWidth: 13, halfHeight: 13 }));
  const labels = [];
  for (const { x, y, node } of points) {
    const halfWidth = ctx.measureText(node.name).width / 2 + 4;
    const clampX = (value) => Math.max(halfWidth + 2, Math.min(width - halfWidth - 2, value));
    const columns = [x, x - halfWidth, x + halfWidth, 0, width].map(clampX);
    // Try adjacent rows first. Edge-on views also need room to either side.
    let centerX, centerY, best = Infinity;
    for (let offset = 15 + row / 2; offset < height && offset ** 2 <= best; offset += row) {
      for (const candidate of [y - offset, y + offset]) {
        if (candidate < row / 2 || candidate > height - row / 2) continue;
        for (const column of columns) {
          const distance = (column - x) ** 2 + offset ** 2;
          if (distance >= best) continue;
          if (occupied.some((box) => Math.abs(column - box.x) < halfWidth + box.halfWidth
            && Math.abs(candidate - box.y) < row / 2 + box.halfHeight)) continue;
          best = distance;
          centerX = column;
          centerY = candidate;
        }
      }
    }
    if (centerY === undefined) {
      centerX = clampX(x);
      centerY = Math.max(row / 2, Math.min(height - row / 2, y - row));
    }
    occupied.push({ x: centerX, y: centerY, halfWidth, halfHeight: row / 2 });
    labels.push({ x: centerX, y: centerY, name: node.name });
    if (Math.abs(y - centerY) > 20 + row / 2 || Math.abs(x - centerX) > halfWidth / 2) {
      const direction = Math.sign(centerY - y);
      line({ x, y: y + direction * 12 }, { x: centerX, y: centerY - direction * row / 2 }, "#819ca3", 1);
    }
  }
  ctx.strokeStyle = "#102127";
  ctx.lineWidth = 5;
  ctx.fillStyle = "#f0f6f0";
  for (const { x, y, name } of labels) {
    ctx.strokeText(name, x, y);
    ctx.fillText(name, x, y);
  }
}

function render(routeId, nodeId, updateUrl = true) {
  route = routes.find((item) => item.id === routeId) || routes[0];
  selected = nodeById.get(nodeId) || nodeById.get(route.steps[0]);
  trace.value = route.id;
  inspect.value = selected.id;
  select("stage-name").textContent = selected.name;
  select("stage-role").textContent = selected.role;
  select("stage-evidence").textContent = selected.evidence;
  select("stage-source").href = selected.source;
  select("stage-source").textContent = selected.sourceLabel;
  select("path-description").textContent = route.description;
  const path = select("path");
  const focusedId = path.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  path.replaceChildren();
  const sequence = route.steps.map((id) => nodeById.get(id));
  for (const node of sequence) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = node.name;
    button.dataset.id = node.id;
    if (node === selected) button.setAttribute("aria-current", "step");
    button.addEventListener("click", () => render(route.id, node.id));
    item.append(button);
    path.append(item);
    if (focusedId === node.id) button.focus({ preventScroll: true });
  }
  const result = { data: { route: {
    id: route.id,
    nodes: sequence.map(({ id, name, evidence, source }) => ({ id, name, evidence, source })),
    edges: sequence.slice(1).map((node, i) => ({ from: sequence[i].id, to: node.id })),
  } } };
  const json = JSON.stringify(result, null, 2) + "\n";
  select("query-result").textContent = json;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  select("download").href = downloadUrl;
  if (updateUrl) {
    // Hash navigation also works on file: URLs without a server.
    const fragment = new URLSearchParams({ trace: route.id, stage: selected.id }).toString();
    if (location.hash.slice(1) !== fragment) location.hash = fragment;
  }
  draw();
}

function readLocation() {
  const params = new URLSearchParams(location.hash.slice(1));
  render(params.get("trace"), params.get("stage"), false);
}
function rotate(dx, dy) {
  camera.yaw += dx;
  camera.pitch = Math.max(-0.85, Math.min(0.85, camera.pitch + dy));
  draw();
}
function reset() {
  camera = { ...startAngle };
  draw();
}
trace.addEventListener("change", () => render(trace.value));
inspect.addEventListener("change", () => render(route.id, inspect.value));
select("reset").addEventListener("click", reset);
canvas.addEventListener("keydown", (event) => {
  const delta = { ArrowLeft: [-.14, 0], ArrowRight: [.14, 0], ArrowUp: [0, .12], ArrowDown: [0, -.12] };
  if (event.key === "Home") reset();
  else if (Object.hasOwn(delta, event.key)) rotate(...delta[event.key]);
  else return;
  event.preventDefault();
});
let drag;
canvas.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary || event.button !== 0) return;
  drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (event.pointerId !== drag?.id) return;
  if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5) drag.moved = true;
  if (drag.moved) rotate((event.clientX - drag.x) * .009, (event.clientY - drag.y) * .006);
  drag.x = event.clientX;
  drag.y = event.clientY;
});
canvas.addEventListener("pointerup", (event) => {
  if (event.pointerId !== drag?.id) return;
  if (!drag.moved) {
    const rect = canvas.getBoundingClientRect();
    const nearest = points.toReversed().find((p) => Math.hypot(event.clientX - rect.left - p.x, event.clientY - rect.top - p.y) <= 18);
    if (nearest) render(route.id, nearest.node.id);
  }
  drag = null;
});
canvas.addEventListener("lostpointercapture", () => { drag = null; });
window.addEventListener("hashchange", readLocation);
document.querySelector(".interactive").hidden = false;
if (!ctx) document.querySelector(".plot").hidden = true;
window.addEventListener("resize", draw);
readLocation();
