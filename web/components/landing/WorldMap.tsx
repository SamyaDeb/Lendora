"use client";

import { useEffect, useRef } from "react";

type Pt = [number, number];

const LON0 = -20, LON1 = 160, LAT0 = 66;

function P(a: number[]): Pt[] {
  const o: Pt[] = [];
  for (let i = 0; i < a.length; i += 2) o.push([a[i], a[i + 1]]);
  return o;
}

const LAND = [
  [-9.5,37,-9,43.5,-1.5,43.5,-4.5,48.5,2,51,5,53,8.5,54.5,10,57,14,54,20,54.5,24,57,26,60,30,60,40,58,44,47,38,45,30,46,28,44,28,41,24,40,22,37,19,40,19,43,14,45.5,12,44.5,15,41,18,40,16,38,12,41.5,9,44.3,3,43,0,39,-5,36.2],
  [5,58.5,5.5,62,10,64,14,67.5,20,69.8,28,71,31,70,30,66,26,65,21.5,65,17.5,62,19,59.5,16,56.5,12.5,56,11,59,8,58],
  [30,60,30,70,44,68.5,60,69,68,68.5,73,72,87,75,105,77,113,73.5,130,71,150,71,170,69.5,180,66,165,60,160,58,156,51,143,59,138,54,140,50,135,43,131,43,130,48,120,53,110,50,105,50,97,50,88,50,80,52,65,54,55,50,48,47,44,47,40,58],
  [44,47,48,47,55,50,65,54,80,52,88,50,97,50,105,50,110,50,120,53,130,48,131,43,129,40,122,40,121,37,119,35,122,31,122,29.5,120,26,117,23.5,113,22,108,21.5,106.5,19,109,15,109,12,105,9,103,10.5,100,13,100,8,103,5,104,1.5,101.5,2.5,100.5,6,98.5,8,98.5,13,97.5,16.5,94.5,16,94,19,92,21,90.5,22.5,87,21.5,84,19,80,15.5,80,10,77.5,8,76,10,73,17,72.8,21,70,21,68,23.5,66.5,25.5,61.5,25,57,25.5,56.5,27,54,26.5,50.5,29.5,48,30,48.5,28,50,26,51.5,24.5,54,24,56,26,56.5,24,59.5,22.5,57.5,19,52,16,45,13,43,13,42.5,16,39,21.5,35,28,34.5,29.5,34,31.5,35.5,33.5,36,36.5,32,36.2,28,36.7,26.5,38.5,27,40,28,41,28,44,30,46,38,45],
  [-17,21,-17,14.7,-14.5,10,-12,7.5,-8,4.5,-4,5,0,5.7,4,6.3,8.5,4.5,9.5,3.5,9.5,0,11.5,-4,13,-9,14,-20,35,-20,40,-15,40.5,-10,39.5,-5,41,-1.5,43,3,46,8,51,11.8,48,11,43.2,11.5,43,12.7,38.5,17.5,37,21,35.5,24,33,28,32.5,30,29,31,25,32,20,32,15,32.2,11,33.3,10,37,8,36.8,3,36.8,-1.5,35.2,-5.5,35.8,-9.5,32,-10,29,-13,27.5,-16.5,24],
  [-5.5,50,1.5,51,1.7,53,-0.5,54.5,-2,57.5,-3.5,58.6,-5.5,58,-6,56,-4.8,54.7,-3,53.5,-4.5,52],
  [-10,52,-6,52,-6,55,-8,55,-10,53.5],
  [-22,64,-18,63.4,-14,64.5,-14.5,66,-19,66.5,-22.5,65.5],
  [130.5,33.5,132,34.5,135,35.5,137,37,139.5,38.5,140,41,141.5,41,142,39,141,36,140.5,35,137,34.5,135,33.5,133,33.7],
  [140,42,141.5,45.5,145,44,143.5,42],
  [124.5,39.5,129.5,40,129.5,36,129,35,126.5,34.5,125.5,37],
  [119.5,18,122.5,18.5,122,14,124,12.5,125.5,9.5,126.5,7,125.5,5.7,123.5,7,122,7,122.5,10,121,12.5,120,15.5],
  [95.5,5.5,98,4,104,-1,106,-3,105.5,-5.8,102,-4,98,0.5,95.5,3],
  [105.5,-6.5,108,-6.2,114.5,-7.5,114.5,-8.5,108,-8,105.5,-7],
  [109,1.5,111,2,114,4.5,117,7,119,5,118,1,116.5,-3.5,114,-4,110.5,-3,109,-1],
  [119.5,-3,121,1,125,1.5,123,-1,122,-4.5,120.5,-5.5],
  [131,-1,138,-1.5,145,-4,150,-10,147,-10,141,-9,138,-8,134,-4],
  [48.5,-12,50.4,-15,49.5,-17,47,-15.5,44.3,-16.5,44,-13],
  [80,9.5,82,7,80.5,6,79.8,8],
  [12.5,38,15.5,38.2,15,36.7],
  [120,22,121.8,25,122,24,120.8,22],
  [142,46,143.5,52,143,54,142,50],
].map(P);

const WATER = [
  [28,41.5,28,43.5,29.5,45.5,33,45.2,35,45,37.5,44.5,41.5,42,41.5,41.2,36,41.7,32,41.5],
  [47,45,50,46.5,53,45.5,53,41,54,37,50,37,49,40,47.5,43],
].map(P);

const PINS = [
  { lon: 25.3, lat: 54.7 },   // Vilnius
  { lon: 55.3, lat: 25.2 },   // Dubai
  { lon: 101.7, lat: 3.1 },   // Kuala Lumpur
  { lon: 103.8, lat: 1.35 },  // Singapore
  { lon: 3.4, lat: 6.5 },     // Lagos
];
const ARCS = [[0, 2], [4, 1], [1, 3], [0, 1]];

function inPoly(x: number, y: number, p: Pt[]) {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function isLand(lon: number, lat: number) {
  if (!LAND.some((p) => inPoly(lon, lat, p))) return false;
  return !WATER.some((p) => inPoly(lon, lat, p));
}

function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const r = 5.5, cy = y - 12;
  ctx.beginPath();
  ctx.arc(x, cy, r, 0.75 * Math.PI, 0.25 * Math.PI, false);
  ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fillStyle = "#9a94e6"; ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, cy, 2.2, 0, 2 * Math.PI);
  ctx.fillStyle = "#2b2650"; ctx.fill();
}

export default function WorldMap() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;

    const draw = () => {
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const s = w / (LON1 - LON0), cell = 5.2;
      const X = (lon: number) => (lon - LON0) * s;
      const Y = (lat: number) => (LAT0 - lat) * s;

      ctx.fillStyle = "rgba(190,184,232,0.34)";
      for (let y = cell / 2; y < h; y += cell) {
        for (let x = cell / 2; x < w; x += cell) {
          if (isLand(LON0 + x / s, LAT0 - y / s)) { ctx.beginPath(); ctx.arc(x, y, 1.5, 0, 6.2832); ctx.fill(); }
        }
      }

      const pts = PINS.map((p) => ({ x: X(p.lon), y: Y(p.lat) }));
      ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 1;
      const arc = (a: { x: number; y: number }, b: { x: number; y: number }) => {
        const mx = (a.x + b.x) / 2, my = Math.min(a.y, b.y) - Math.hypot(a.x - b.x, a.y - b.y) * 0.32;
        ctx.beginPath(); ctx.moveTo(a.x, a.y - 12); ctx.quadraticCurveTo(mx, my, b.x, b.y - 12); ctx.stroke();
      };
      ARCS.forEach(([a, b]) => arc(pts[a], pts[b]));
      arc(pts[2], { x: w + 24, y: pts[2].y - 40 });
      [4, 1, 0, 2, 3].forEach((i) => drawPin(ctx, pts[i].x, pts[i].y));
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv.parentElement!);
    return () => ro.disconnect();
  }, []);

  return (
    <canvas
      ref={ref}
      id="map-canvas"
      role="img"
      aria-label="Dotted world map with pins in Lithuania, Malaysia and Singapore, and arcs connecting them"
    />
  );
}
