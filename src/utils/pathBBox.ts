/**
 * SVG 路径解析与几何测量工具。
 *
 * 为排印台提供两个核心能力：
 * 1. pathBBox —— 按真实轮廓计算紧贴包围盒，三次/二次贝塞尔曲线的
 *    弧顶（导数极值点）也计入，而不是只看控制点。
 * 2. flattenPath —— 把路径采样成折线点集（曲线弧顶精确点也会并入），
 *    供排版引擎构建水平/垂直投影轮廓做紧排。
 *
 * 全部为纯函数，同样输入必然得到同样输出。
 */

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Pt {
  x: number;
  y: number;
}

type Seg =
  | { cmd: 'M' | 'L'; to: Pt }
  | { cmd: 'C'; c1: Pt; c2: Pt; to: Pt }
  | { cmd: 'Q'; c: Pt; to: Pt }
  | { cmd: 'Z' };

const TOKEN_RE = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

/** 把路径字符串解析为绝对坐标的段序列。遇到非法数据会抛错，由调用方兜底。 */
export function parsePath(d: string): Seg[] {
  if (!d || !d.trim()) return [];

  const tokens: (string | number)[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(d)) !== null) {
    const t = m[0];
    if (/^[a-zA-Z]$/.test(t)) tokens.push(t);
    else {
      const v = parseFloat(t);
      if (!Number.isFinite(v)) throw new Error('路径包含非法数值');
      tokens.push(v);
    }
  }

  const segs: Seg[] = [];
  let i = 0;
  let cur: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  let prevCubicCtrl: Pt | null = null;
  let prevQuadCtrl: Pt | null = null;
  let prevCmd = '';

  const hasNum = () => i < tokens.length && typeof tokens[i] === 'number';
  const num = (): number => {
    if (!hasNum()) throw new Error('路径数据不完整');
    return tokens[i++] as number;
  };

  while (i < tokens.length) {
    let cmd = tokens[i];
    if (typeof cmd === 'string') {
      i++;
    } else {
      // 省略命令字：按上一条命令重复（M/m 之后按 L/l 处理）
      if (prevCmd === 'M') cmd = 'L';
      else if (prevCmd === 'm') cmd = 'l';
      else if (prevCmd) cmd = prevCmd;
      else throw new Error('路径缺少命令字');
    }
    if (typeof cmd !== 'string') throw new Error('路径命令解析失败');

    const rel = cmd >= 'a' && cmd <= 'z';
    const C = cmd.toUpperCase();
    const px = () => num() + (rel ? cur.x : 0);
    const py = () => num() + (rel ? cur.y : 0);

    switch (C) {
      case 'M': {
        cur = { x: px(), y: py() };
        start = { ...cur };
        segs.push({ cmd: 'M', to: { ...cur } });
        break;
      }
      case 'L': {
        cur = { x: px(), y: py() };
        segs.push({ cmd: 'L', to: { ...cur } });
        break;
      }
      case 'H': {
        cur = { x: px(), y: cur.y };
        segs.push({ cmd: 'L', to: { ...cur } });
        break;
      }
      case 'V': {
        cur = { x: cur.x, y: py() };
        segs.push({ cmd: 'L', to: { ...cur } });
        break;
      }
      case 'C': {
        const c1 = { x: px(), y: py() };
        const c2 = { x: px(), y: py() };
        cur = { x: px(), y: py() };
        segs.push({ cmd: 'C', c1, c2, to: { ...cur } });
        prevCubicCtrl = c2;
        break;
      }
      case 'S': {
        const c1 =
          prevCmd === 'C' || prevCmd === 'S'
            ? { x: 2 * cur.x - (prevCubicCtrl?.x ?? cur.x), y: 2 * cur.y - (prevCubicCtrl?.y ?? cur.y) }
            : { ...cur };
        const c2 = { x: px(), y: py() };
        cur = { x: px(), y: py() };
        segs.push({ cmd: 'C', c1, c2, to: { ...cur } });
        prevCubicCtrl = c2;
        break;
      }
      case 'Q': {
        const c = { x: px(), y: py() };
        cur = { x: px(), y: py() };
        segs.push({ cmd: 'Q', c, to: { ...cur } });
        prevQuadCtrl = c;
        break;
      }
      case 'T': {
        const c =
          prevCmd === 'Q' || prevCmd === 'T'
            ? { x: 2 * cur.x - (prevQuadCtrl?.x ?? cur.x), y: 2 * cur.y - (prevQuadCtrl?.y ?? cur.y) }
            : { ...cur };
        cur = { x: px(), y: py() };
        segs.push({ cmd: 'Q', c, to: { ...cur } });
        prevQuadCtrl = c;
        break;
      }
      case 'A': {
        // 编辑器不会产生圆弧；为健壮起见按直线到终点近似（rx ry rot large sweep x y）
        num(); num(); num(); num(); num();
        cur = { x: px(), y: py() };
        segs.push({ cmd: 'L', to: { ...cur } });
        break;
      }
      case 'Z': {
        segs.push({ cmd: 'Z' });
        cur = { ...start };
        break;
      }
      default:
        throw new Error(`不支持的路径命令：${cmd}`);
    }

    if (C !== 'C' && C !== 'S') prevCubicCtrl = null;
    if (C !== 'Q' && C !== 'T') prevQuadCtrl = null;
    prevCmd = typeof cmd === 'string' ? cmd : prevCmd;
  }

  return segs;
}

const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

const quadAt = (p0: number, p1: number, p2: number, t: number): number => {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
};

/** 三次贝塞尔在 (0,1) 内的导数零点（弧顶/极值点对应的参数 t） */
const cubicExtremaT = (p0: number, p1: number, p2: number, p3: number): number[] => {
  // d/dt = a t^2 + b t + c
  const a = 3 * (-p0 + 3 * p1 - 3 * p2 + p3);
  const b = 6 * (p0 - 2 * p1 + p2);
  const c = 3 * (p1 - p0);
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      roots.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
    }
  }
  return roots.filter((t) => t > 1e-9 && t < 1 - 1e-9);
};

/** 二次贝塞尔在 (0,1) 内的导数零点 */
const quadExtremaT = (p0: number, p1: number, p2: number): number[] => {
  const denom = p0 - 2 * p1 + p2;
  if (Math.abs(denom) < 1e-12) return [];
  const t = (p0 - p1) / denom;
  return t > 1e-9 && t < 1 - 1e-9 ? [t] : [];
};

const emptyBBox = (): BBox => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

const grow = (bb: BBox, x: number, y: number) => {
  if (x < bb.minX) bb.minX = x;
  if (y < bb.minY) bb.minY = y;
  if (x > bb.maxX) bb.maxX = x;
  if (y > bb.maxY) bb.maxY = y;
};

/**
 * 紧贴包围盒：端点 + 曲线弧顶（导数极值点）都计入。
 * 路径为空或无法解析时返回 null。
 */
export function pathBBox(d: string): BBox | null {
  const segs = parsePath(d);
  if (segs.length === 0) return null;

  const bb = emptyBBox();
  let cur: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  let has = false;

  for (const seg of segs) {
    switch (seg.cmd) {
      case 'M':
        cur = seg.to;
        start = { ...cur };
        grow(bb, cur.x, cur.y);
        has = true;
        break;
      case 'L':
        cur = seg.to;
        grow(bb, cur.x, cur.y);
        break;
      case 'C': {
        grow(bb, seg.to.x, seg.to.y);
        for (const t of cubicExtremaT(cur.x, seg.c1.x, seg.c2.x, seg.to.x)) {
          grow(bb, cubicAt(cur.x, seg.c1.x, seg.c2.x, seg.to.x, t), cubicAt(cur.y, seg.c1.y, seg.c2.y, seg.to.y, t));
        }
        for (const t of cubicExtremaT(cur.y, seg.c1.y, seg.c2.y, seg.to.y)) {
          grow(bb, cubicAt(cur.x, seg.c1.x, seg.c2.x, seg.to.x, t), cubicAt(cur.y, seg.c1.y, seg.c2.y, seg.to.y, t));
        }
        cur = seg.to;
        break;
      }
      case 'Q': {
        grow(bb, seg.to.x, seg.to.y);
        for (const t of quadExtremaT(cur.x, seg.c.x, seg.to.x)) {
          grow(bb, quadAt(cur.x, seg.c.x, seg.to.x, t), quadAt(cur.y, seg.c.y, seg.to.y, t));
        }
        for (const t of quadExtremaT(cur.y, seg.c.y, seg.to.y)) {
          grow(bb, quadAt(cur.x, seg.c.x, seg.to.x, t), quadAt(cur.y, seg.c.y, seg.to.y, t));
        }
        cur = seg.to;
        break;
      }
      case 'Z':
        cur = { ...start };
        break;
    }
  }

  if (!has || !Number.isFinite(bb.minX)) return null;
  return bb;
}

/**
 * 把路径扁平化为点集：直线取端点，曲线均匀采样 samplesPerCurve 段，
 * 并额外并入曲线弧顶的精确点，保证投影轮廓在弧顶处不失真。
 */
export function flattenPath(d: string, samplesPerCurve: number = 32): Pt[] {
  const segs = parsePath(d);
  const pts: Pt[] = [];
  let cur: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  const n = Math.max(4, Math.floor(samplesPerCurve));

  for (const seg of segs) {
    switch (seg.cmd) {
      case 'M':
        cur = seg.to;
        start = { ...cur };
        pts.push({ ...cur });
        break;
      case 'L':
        cur = seg.to;
        pts.push({ ...cur });
        break;
      case 'C': {
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          pts.push({
            x: cubicAt(cur.x, seg.c1.x, seg.c2.x, seg.to.x, t),
            y: cubicAt(cur.y, seg.c1.y, seg.c2.y, seg.to.y, t),
          });
        }
        const ts = new Set<number>([
          ...cubicExtremaT(cur.x, seg.c1.x, seg.c2.x, seg.to.x),
          ...cubicExtremaT(cur.y, seg.c1.y, seg.c2.y, seg.to.y),
        ]);
        for (const t of ts) {
          pts.push({
            x: cubicAt(cur.x, seg.c1.x, seg.c2.x, seg.to.x, t),
            y: cubicAt(cur.y, seg.c1.y, seg.c2.y, seg.to.y, t),
          });
        }
        cur = seg.to;
        break;
      }
      case 'Q': {
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          pts.push({ x: quadAt(cur.x, seg.c.x, seg.to.x, t), y: quadAt(cur.y, seg.c.y, seg.to.y, t) });
        }
        const ts = new Set<number>([
          ...quadExtremaT(cur.x, seg.c.x, seg.to.x),
          ...quadExtremaT(cur.y, seg.c.y, seg.to.y),
        ]);
        for (const t of ts) {
          pts.push({ x: quadAt(cur.x, seg.c.x, seg.to.x, t), y: quadAt(cur.y, seg.c.y, seg.to.y, t) });
        }
        cur = seg.to;
        break;
      }
      case 'Z':
        cur = { ...start };
        pts.push({ ...cur });
        break;
    }
  }

  return pts;
}
