const SVG = "http://www.w3.org/2000/svg";
const filterProperty = "--glass-refraction-filter";
const channels = [
  { name: "red", weight: 1, matrix: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" },
  { name: "green", weight: 0, matrix: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" },
  { name: "blue", weight: -1, matrix: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" },
];

function svgElement(parent, name, attributes) {
  const element = parent.ownerDocument.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  parent.append(element);
  return element;
}

function makeMap(document, width, height, radii, edgeWidth) {
  const canvas = document.createElement("canvas");
  const ratio = Math.min(1, 512 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");

  const image = context.createImageData(canvas.width, canvas.height);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  for (let row = 0; row < canvas.height; row++) {
    const y = (row + 0.5) * height / canvas.height - halfHeight;
    for (let col = 0; col < canvas.width; col++) {
      const x = (col + 0.5) * width / canvas.width - halfWidth;
      const corner = (y >= 0 ? 2 : 0) + (x >= 0 ? 1 : 0);
      const radius = radii[corner];
      const dx = Math.abs(x) - (halfWidth - radius);
      const dy = Math.abs(y) - (halfHeight - radius);
      const curveX = Math.max(dx, 0);
      const curveY = Math.max(dy, 0);
      const curveLength = Math.hypot(curveX, curveY);
      const depth = radius - curveLength - Math.min(Math.max(dx, dy), 0);
      const bend = Math.max(0, 1 - Math.max(depth, 0) / edgeWidth) ** 2.6;
      const normalX = curveLength ? curveX / curveLength : Number(dx > dy);
      const normalY = curveLength ? curveY / curveLength : Number(dy >= dx);
      const pixel = (row * canvas.width + col) * 4;
      image.data[pixel] = 128 - Math.sign(x) * normalX * bend * 127;
      image.data[pixel + 1] = 128 - Math.sign(y) * normalY * bend * 127;
      image.data[pixel + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function makeFilter(document, id, width, height, map, strength, dispersion) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("glass-refraction-definitions");
  const defs = svgElement(svg, "defs", {});
  const filter = svgElement(defs, "filter", {
    id, x: 0, y: 0, width: "100%", height: "100%", "color-interpolation-filters": "sRGB",
  });
  svgElement(filter, "feImage", {
    href: map, x: 0, y: 0, width, height, preserveAspectRatio: "none", result: "rim",
  });
  const normalize = svgElement(filter, "feComponentTransfer", { in: "rim", result: "offset" });
  const channelRange = { type: "linear", slope: 255 / 254, intercept: -1 / 254 };
  svgElement(normalize, "feFuncR", channelRange);
  svgElement(normalize, "feFuncG", channelRange);
  const displace = { in: "SourceGraphic", in2: "offset", xChannelSelector: "R", yChannelSelector: "G" };
  if (dispersion === 0) {
    svgElement(filter, "feDisplacementMap", { ...displace, scale: 2 * strength });
    return svg;
  }

  for (const { name, weight, matrix } of channels) {
    svgElement(filter, "feDisplacementMap", {
      ...displace, scale: 2 * strength * (1 + weight * dispersion), result: `bend-${name}`,
    });
    svgElement(filter, "feColorMatrix", { in: `bend-${name}`, type: "matrix", values: matrix, result: name });
  }
  const sum = { operator: "arithmetic", k2: 1, k3: 1 };
  svgElement(filter, "feComposite", { ...sum, in: "red", in2: "green", result: "red-green" });
  svgElement(filter, "feComposite", { ...sum, in: "red-green", in2: "blue" });
  return svg;
}

export function attachGlassRefraction(surface, {
  edgeWidth = 23,
  strength = 27,
  dispersion = 0.12,
  onStatus = () => {},
} = {}) {
  if (!(edgeWidth > 0 && Number.isFinite(edgeWidth)) || !(strength >= 0 && Number.isFinite(strength))
    || !(dispersion >= 0 && dispersion <= 0.25)) {
    throw new RangeError("Expected a positive edge width, a nonnegative strength and dispersion from 0 to 0.25");
  }
  const document = surface.ownerDocument;
  const view = document.defaultView;
  const supported = /\b(?:Chrome|Chromium)\//.test(view.navigator.userAgent)
    && view.CSS?.supports("backdrop-filter", "url(#glass-refraction)")
    && typeof view.ResizeObserver === "function"
    && typeof view.Image.prototype.decode === "function";
  const preference = view.matchMedia("(prefers-reduced-transparency: reduce), (forced-colors: active)");
  const id = `glass-refraction-${view.crypto.getRandomValues(new Uint32Array(2)).join("-")}`;
  let requested = false;
  let disposed = false;
  let frame = 0;
  let revision = 0;
  let geometry = "";
  let status = "off";
  let svg;

  function publish(next) {
    if (next === status) return;
    status = next;
    onStatus(next);
  }

  function clear() {
    surface.removeAttribute("data-glass-refraction");
    surface.style.removeProperty(filterProperty);
    svg?.remove();
    svg = undefined;
  }

  async function render() {
    frame = 0;
    if (preference.matches) {
      revision++;
      geometry = "";
      clear();
      publish("preference");
      return;
    }
    const width = surface.offsetWidth;
    const height = surface.offsetHeight;
    if (!width || !height) {
      revision++;
      geometry = "";
      clear();
      publish("preparing");
      return;
    }
    const style = view.getComputedStyle(surface);
    const corners = [style.borderTopLeftRadius, style.borderTopRightRadius,
      style.borderBottomLeftRadius, style.borderBottomRightRadius];
    const key = [width, height, ...corners].join(":");
    if (key === geometry) return;
    geometry = key;
    const generation = ++revision;
    clear();
    if (corners.some(radius => !/^\d+(?:\.\d+)?px$/.test(radius))) {
      publish("geometry");
      return;
    }
    const [topLeft, topRight, bottomLeft, bottomRight] = corners.map(Number.parseFloat);
    // CSS shrinks all corners together when their sums exceed a side.
    const radiusScale = Math.min(1, width / (topLeft + topRight), width / (bottomLeft + bottomRight),
      height / (topLeft + bottomLeft), height / (topRight + bottomRight));
    const radii = [topLeft, topRight, bottomLeft, bottomRight].map(radius => radius * radiusScale);
    if (radii.some(radius => radius > Math.min(width, height) / 2 + 0.001)) {
      publish("geometry");
      return;
    }
    publish("preparing");
    if (generation !== revision) return;
    try {
      const rimWidth = Math.min(edgeWidth, width / 2, height / 2);
      const map = makeMap(document, width, height, radii, rimWidth);
      const texture = new view.Image();
      texture.src = map;
      await texture.decode();
      if (generation !== revision) return;
      svg = makeFilter(document, id, width, height, map, Math.min(strength, rimWidth * 1.2), dispersion);
      document.body.append(svg);
      surface.style.setProperty(filterProperty, `url("#${id}")`);
      surface.setAttribute("data-glass-refraction", "active");
    } catch {
      if (generation !== revision) return;
      geometry = "";
      clear();
      publish("error");
      return;
    }
    publish("active");
  }

  function refresh() {
    if (!requested || !supported || disposed) return;
    view.cancelAnimationFrame(frame);
    frame = view.requestAnimationFrame(render);
  }

  const observer = supported ? new view.ResizeObserver(refresh) : null;

  function stop() {
    requested = false;
    revision++;
    geometry = "";
    view.cancelAnimationFrame(frame);
    observer?.disconnect();
    preference.removeEventListener("change", refresh);
    clear();
    publish("off");
  }

  function setEnabled(enabled) {
    if (disposed || enabled === requested) return;
    if (!enabled) {
      stop();
      return;
    }
    requested = true;
    if (!supported) {
      publish("unsupported");
      return;
    }
    observer.observe(surface, { box: "border-box" });
    preference.addEventListener("change", refresh);
    refresh();
  }

  return {
    setEnabled,
    refresh,
    destroy() {
      if (disposed) return;
      disposed = true;
      stop();
    },
  };
}
