/**
 * 排印台排版引擎 —— 纯函数、确定性：同样的词条序列 + 阶段 + 参数，
 * 必然得到同样的版面。字根或阶段数据变化会使指纹变化，旧版面即过期。
 *
 * 核心规则：
 * - 每个字形按真实轮廓（含曲线弧顶）计算紧贴包围盒；
 * - 字距是包围盒之间的基础间隙，紧排（0~1）按投影轮廓把相邻字形
 *   向彼此推近：横排看水平投影（逐 y 带的左右墨界），竖排看垂直投影；
 * - 词条是不可拆分的块，宽高不够就断行（横排）/断列（竖排，从右往左成列）；
 * - 超过整行/整列容量的词条独占一行/列并附说明；
 * - 对齐支持 左/中/右/两端（竖排映射为 顶/中/底/两端），末行不拉伸，
 *   两端对齐只在词条之间分配余量，不动字形级紧排。
 */

import type { Lexeme, Radical } from '@/types';
import { pathBBox, flattenPath, type BBox } from './pathBBox';

export type TypesetDirection = 'horizontal' | 'vertical';
export type TypesetAlign = 'start' | 'center' | 'end' | 'justify';

export interface TypesetParams {
  direction: TypesetDirection;
  align: TypesetAlign;
  /** 字号：em 框边长（px），字形设计在 100×100 的 em 坐标里 */
  glyphSize: number;
  /** 字距：相邻字形包围盒之间的基础间隙（px） */
  letterSpacing: number;
  /** 紧排强度 0~1：按投影轮廓允许的最大贴近量的应用比例 */
  kerning: number;
  /** 行距/列距（px） */
  lineSpacing: number;
  frameWidth: number;
  frameHeight: number;
  padding: number;
}

export const DEFAULT_TYPESET_PARAMS: TypesetParams = {
  direction: 'horizontal',
  align: 'start',
  glyphSize: 40,
  letterSpacing: 8,
  kerning: 0.6,
  lineSpacing: 16,
  frameWidth: 720,
  frameHeight: 520,
  padding: 24,
};

export interface TypesetIssue {
  severity: 'error' | 'warning';
  kind:
    | 'empty-selection'
    | 'no-stage'
    | 'missing-lexeme'
    | 'missing-radical'
    | 'no-radicals'
    | 'missing-variant'
    | 'empty-glyph'
    | 'parse-error'
    | 'invalid-size'
    | 'no-valid-entries'
    | 'overflow';
  message: string;
}

export interface GlyphInput {
  radicalId: string;
  name: string;
  svgPath: string;
}

export interface EntryInput {
  lexemeId: string;
  pronunciation: string;
  meaning: string;
  glyphs: GlyphInput[];
}

// ---------------------------------------------------------------------------
// 字形度量：紧贴包围盒 + 投影轮廓（带缓存，按路径字符串索引，结果确定）
// ---------------------------------------------------------------------------

const EM = 100;
const PROFILE_BANDS = 50;

export interface GlyphMetrics {
  bbox: BBox;
  /** 水平投影：按 y 带记录墨的左右界（横排紧排用） */
  left: Float64Array;
  right: Float64Array;
  hasY: Uint8Array;
  /** 垂直投影：按 x 带记录墨的上下界（竖排紧排用） */
  top: Float64Array;
  bottom: Float64Array;
  hasX: Uint8Array;
}

const metricsCache = new Map<string, GlyphMetrics | null>();

export function getGlyphMetrics(svgPath: string): GlyphMetrics | null {
  if (metricsCache.has(svgPath)) return metricsCache.get(svgPath) ?? null;
  let metrics: GlyphMetrics | null = null;
  try {
    const bbox = pathBBox(svgPath);
    const pts = flattenPath(svgPath, 32);
    if (
      bbox &&
      pts.length > 0 &&
      Number.isFinite(bbox.minX) &&
      Number.isFinite(bbox.minY) &&
      Number.isFinite(bbox.maxX) &&
      Number.isFinite(bbox.maxY)
    ) {
      const left = new Float64Array(PROFILE_BANDS).fill(Infinity);
      const right = new Float64Array(PROFILE_BANDS).fill(-Infinity);
      const top = new Float64Array(PROFILE_BANDS).fill(Infinity);
      const bottom = new Float64Array(PROFILE_BANDS).fill(-Infinity);
      const hasY = new Uint8Array(PROFILE_BANDS);
      const hasX = new Uint8Array(PROFILE_BANDS);
      for (const p of pts) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        const yb = Math.max(0, Math.min(PROFILE_BANDS - 1, Math.floor((p.y / EM) * PROFILE_BANDS)));
        const xb = Math.max(0, Math.min(PROFILE_BANDS - 1, Math.floor((p.x / EM) * PROFILE_BANDS)));
        if (p.x < left[yb]) left[yb] = p.x;
        if (p.x > right[yb]) right[yb] = p.x;
        hasY[yb] = 1;
        if (p.y < top[xb]) top[xb] = p.y;
        if (p.y > bottom[xb]) bottom[xb] = p.y;
        hasX[xb] = 1;
      }
      metrics = { bbox, left, right, hasY, top, bottom, hasX };
    }
  } catch {
    metrics = null;
  }
  metricsCache.set(svgPath, metrics);
  return metrics;
}

// ---------------------------------------------------------------------------
// 紧排：相邻字形的投影轮廓允许的最大贴近量（em 单位）
// ---------------------------------------------------------------------------

/** 无投影重叠时允许包围盒互嵌的上限比例，防止字形互相穿过 */
const MAX_OVERLAP_RATIO = 0.75;

function pairApproachEm(a: GlyphMetrics, b: GlyphMetrics, direction: TypesetDirection, gapEm: number): number {
  const horizontal = direction === 'horizontal';
  const normalDelta = horizontal
    ? a.bbox.maxX + gapEm - b.bbox.minX
    : a.bbox.maxY + gapEm - b.bbox.minY;

  let tightDelta = -Infinity;
  if (horizontal) {
    for (let band = 0; band < PROFILE_BANDS; band++) {
      if (a.hasY[band] && b.hasY[band]) {
        const v = a.right[band] - b.left[band];
        if (v > tightDelta) tightDelta = v;
      }
    }
  } else {
    for (let band = 0; band < PROFILE_BANDS; band++) {
      if (a.hasX[band] && b.hasX[band]) {
        const v = a.bottom[band] - b.top[band];
        if (v > tightDelta) tightDelta = v;
      }
    }
  }

  const minDim = horizontal
    ? Math.min(a.bbox.maxX - a.bbox.minX, b.bbox.maxX - b.bbox.minX)
    : Math.min(a.bbox.maxY - a.bbox.minY, b.bbox.maxY - b.bbox.minY);
  const maxApproach = Math.max(0, gapEm) + MAX_OVERLAP_RATIO * Math.max(0, minDim);

  if (!Number.isFinite(tightDelta)) return maxApproach;
  return Math.max(0, Math.min(maxApproach, normalDelta - tightDelta));
}

// ---------------------------------------------------------------------------
// 词条内部排版（em 坐标，原点在词条墨迹主轴起点）
// ---------------------------------------------------------------------------

interface LaidGlyph {
  glyph: GlyphInput;
  metrics: GlyphMetrics;
  /** em 框主轴偏移（em 单位） */
  offset: number;
}

interface LaidEntry {
  entry: EntryInput;
  glyphs: LaidGlyph[];
  /** 词条墨迹主轴长度（em 单位） */
  lengthEm: number;
}

function layoutEntry(entry: EntryInput, params: TypesetParams, scale: number): LaidEntry | null {
  const metrics: GlyphMetrics[] = [];
  for (const g of entry.glyphs) {
    const m = getGlyphMetrics(g.svgPath);
    if (!m) return null;
    metrics.push(m);
  }
  if (metrics.length === 0) return null;

  const horizontal = params.direction === 'horizontal';
  const gapEm = params.letterSpacing / scale;
  const offsets: number[] = [
    horizontal ? -metrics[0].bbox.minX : -metrics[0].bbox.minY,
  ];
  for (let i = 1; i < metrics.length; i++) {
    const a = metrics[i - 1];
    const b = metrics[i];
    const normalDelta = horizontal
      ? a.bbox.maxX + gapEm - b.bbox.minX
      : a.bbox.maxY + gapEm - b.bbox.minY;
    const approach = pairApproachEm(a, b, params.direction, gapEm);
    offsets.push(offsets[i - 1] + normalDelta - params.kerning * approach);
  }

  // 归一化：词条墨迹主轴起点对齐到 0
  let minInk = Infinity;
  let maxInk = -Infinity;
  for (let i = 0; i < metrics.length; i++) {
    const lo = offsets[i] + (horizontal ? metrics[i].bbox.minX : metrics[i].bbox.minY);
    const hi = offsets[i] + (horizontal ? metrics[i].bbox.maxX : metrics[i].bbox.maxY);
    if (lo < minInk) minInk = lo;
    if (hi > maxInk) maxInk = hi;
  }
  const shift = -minInk;

  return {
    entry,
    glyphs: entry.glyphs.map((g, i) => ({ glyph: g, metrics: metrics[i], offset: offsets[i] + shift })),
    lengthEm: maxInk - minInk,
  };
}

// ---------------------------------------------------------------------------
// 整版排版
// ---------------------------------------------------------------------------

export interface PlacedGlyph {
  radicalId: string;
  name: string;
  svgPath: string;
  /** em 框原点（版面 px 坐标） */
  x: number;
  y: number;
  bbox: BBox;
}

export interface PlacedEntry {
  lexemeId: string;
  pronunciation: string;
  meaning: string;
  glyphs: PlacedGlyph[];
  overlong: boolean;
  overflowPx: number;
  lineIndex: number;
  /** 词条墨迹主轴起点（版面 px） */
  mainStart: number;
  mainLen: number;
}

export interface LayoutLine {
  index: number;
  /** 行/列 em 带的交叉轴起点（版面 px；竖排为列左缘，列从右往左排） */
  cross: number;
  contentLen: number;
  startOffset: number;
  entryGap: number;
  justified: boolean;
  overlong: boolean;
  entries: PlacedEntry[];
}

export interface TypesetResult {
  direction: TypesetDirection;
  lines: LayoutLine[];
  entries: PlacedEntry[];
  capacity: number;
  contentCross: number;
  crossOverflow: number;
  notes: string[];
  stats: { entries: number; glyphs: number; lines: number };
}

export function layoutTypeset(
  entries: EntryInput[],
  params: TypesetParams
): { result: TypesetResult | null; issues: TypesetIssue[] } {
  const issues: TypesetIssue[] = [];
  const horizontal = params.direction === 'horizontal';
  const scale = params.glyphSize / EM;
  const frameMain = horizontal ? params.frameWidth : params.frameHeight;
  const frameCross = horizontal ? params.frameHeight : params.frameWidth;
  const capacity = frameMain - params.padding * 2;

  if (!(capacity > 0) || !Number.isFinite(capacity)) {
    issues.push({
      severity: 'error',
      kind: 'invalid-size',
      message: '纸面尺寸过小：除去边距后放不下任何内容，请增大纸面宽高或减小边距',
    });
    return { result: null, issues };
  }
  if (!(scale > 0) || !Number.isFinite(scale)) {
    issues.push({ severity: 'error', kind: 'invalid-size', message: '字号必须为正数' });
    return { result: null, issues };
  }

  const laid = entries
    .map((e) => layoutEntry(e, params, scale))
    .filter((le): le is LaidEntry => le !== null);

  /** 词条之间的间隙：随字号与字距走，保证确定性 */
  const entryGap = params.glyphSize * 0.5 + params.letterSpacing;

  // 断行/断列：贪心装行，超长词条独占一行/列
  interface LineBuf {
    laid: LaidEntry[];
    contentLen: number;
    overlong: boolean;
    overflowPx: number;
  }
  const lineBufs: LineBuf[] = [];
  let cur: LaidEntry[] = [];
  let curLen = 0;
  const flush = () => {
    if (cur.length > 0) {
      lineBufs.push({ laid: cur, contentLen: curLen, overlong: false, overflowPx: 0 });
      cur = [];
      curLen = 0;
    }
  };
  for (const le of laid) {
    const len = le.lengthEm * scale;
    if (len > capacity) {
      flush();
      lineBufs.push({ laid: [le], contentLen: len, overlong: true, overflowPx: len - capacity });
      continue;
    }
    const needed = cur.length > 0 ? curLen + entryGap + len : len;
    if (cur.length > 0 && needed > capacity + 1e-6) {
      flush();
      cur = [le];
      curLen = len;
    } else {
      cur.push(le);
      curLen = needed;
    }
  }
  flush();

  const notes: string[] = [];
  const allPlaced: PlacedEntry[] = [];

  const lines: LayoutLine[] = lineBufs.map((lb, li) => {
    const isLast = li === lineBufs.length - 1;
    let startOffset = 0;
    let gap = entryGap;
    let justified = false;

    if (params.align === 'justify' && !isLast && lb.laid.length > 1 && !lb.overlong) {
      // 两端对齐：余量只加在词条之间，字形级紧排保持不变；末行不拉伸
      gap = entryGap + (capacity - lb.contentLen) / (lb.laid.length - 1);
      justified = true;
    } else if (!lb.overlong) {
      if (params.align === 'center') startOffset = Math.max(0, (capacity - lb.contentLen) / 2);
      else if (params.align === 'end') startOffset = Math.max(0, capacity - lb.contentLen);
    }

    const cross = horizontal
      ? params.padding + li * (params.glyphSize + params.lineSpacing)
      : params.frameWidth - params.padding - params.glyphSize - li * (params.glyphSize + params.lineSpacing);

    let cursor = params.padding + startOffset;
    const placedEntries: PlacedEntry[] = lb.laid.map((le) => {
      const mainStart = cursor;
      const glyphs: PlacedGlyph[] = le.glyphs.map((lg) => {
        const mainPx = mainStart + lg.offset * scale;
        return {
          radicalId: lg.glyph.radicalId,
          name: lg.glyph.name,
          svgPath: lg.glyph.svgPath,
          x: horizontal ? mainPx : cross,
          y: horizontal ? cross : mainPx,
          bbox: lg.metrics.bbox,
        };
      });
      const mainLen = le.lengthEm * scale;
      cursor += mainLen + gap;
      const placed: PlacedEntry = {
        lexemeId: le.entry.lexemeId,
        pronunciation: le.entry.pronunciation,
        meaning: le.entry.meaning,
        glyphs,
        overlong: lb.overlong,
        overflowPx: lb.overlong ? lb.overflowPx : 0,
        lineIndex: li,
        mainStart,
        mainLen,
      };
      allPlaced.push(placed);
      return placed;
    });

    if (lb.overlong) {
      const first = lb.laid[0].entry;
      notes.push(
        `词条「${first.meaning}」（${first.pronunciation}）超过${horizontal ? '行宽' : '列高'}，` +
          `已独占一${horizontal ? '行' : '列'}，超出 ${Math.ceil(lb.overflowPx)}px`
      );
    }

    return {
      index: li,
      cross,
      contentLen: lb.contentLen,
      startOffset,
      entryGap: gap,
      justified,
      overlong: lb.overlong,
      entries: placedEntries,
    };
  });

  const lineCount = lines.length;
  const contentCross =
    lineCount > 0
      ? params.padding * 2 + lineCount * params.glyphSize + (lineCount - 1) * params.lineSpacing
      : 0;
  const crossOverflow = Math.max(0, contentCross - frameCross);
  if (crossOverflow > 0) {
    issues.push({
      severity: 'warning',
      kind: 'overflow',
      message: `内容超出纸面${horizontal ? '高度' : '宽度'} ${Math.ceil(crossOverflow)}px，可增大纸面或减小字号/行距`,
    });
  }

  return {
    result: {
      direction: params.direction,
      lines,
      entries: allPlaced,
      capacity,
      contentCross,
      crossOverflow,
      notes,
      stats: {
        entries: allPlaced.length,
        glyphs: allPlaced.reduce((n, e) => n + e.glyphs.length, 0),
        lines: lineCount,
      },
    },
    issues,
  };
}

// ---------------------------------------------------------------------------
// 输入构建与校验
// ---------------------------------------------------------------------------

export function buildEntries(
  lexemeIds: string[],
  lexemes: Lexeme[],
  radicals: Radical[],
  stageId: string | null,
  stageName: string
): { entries: EntryInput[]; issues: TypesetIssue[] } {
  const issues: TypesetIssue[] = [];
  const entries: EntryInput[] = [];

  if (!stageId) {
    issues.push({ severity: 'error', kind: 'no-stage', message: '未选择历史阶段，无法确定字形变体' });
    return { entries, issues };
  }

  lexemeIds.forEach((id, seqIdx) => {
    const lx = lexemes.find((l) => l.id === id);
    if (!lx) {
      issues.push({ severity: 'error', kind: 'missing-lexeme', message: `第 ${seqIdx + 1} 个词条已不存在，已跳过` });
      return;
    }
    if (lx.radicalIds.length === 0) {
      issues.push({ severity: 'error', kind: 'no-radicals', message: `词条「${lx.meaning}」不含字根，已跳过` });
      return;
    }
    const glyphs: GlyphInput[] = [];
    let bad = false;
    for (const rid of lx.radicalIds) {
      const rad = radicals.find((r) => r.id === rid);
      if (!rad) {
        issues.push({ severity: 'error', kind: 'missing-radical', message: `词条「${lx.meaning}」引用了已删除的字根，已跳过` });
        bad = true;
        break;
      }
      const variant = rad.variants.find((v) => v.stageId === stageId);
      if (!variant) {
        issues.push({
          severity: 'error',
          kind: 'missing-variant',
          message: `字根「${rad.name}」缺少「${stageName}」阶段的变体（词条：${lx.meaning}），已跳过该词条`,
        });
        bad = true;
        break;
      }
      if (!variant.svgPath || !variant.svgPath.trim()) {
        issues.push({
          severity: 'error',
          kind: 'empty-glyph',
          message: `字根「${rad.name}」在「${stageName}」阶段的字形为空（词条：${lx.meaning}），已跳过该词条`,
        });
        bad = true;
        break;
      }
      if (!getGlyphMetrics(variant.svgPath)) {
        issues.push({
          severity: 'error',
          kind: 'parse-error',
          message: `字根「${rad.name}」在「${stageName}」阶段的字形数据无法解析（词条：${lx.meaning}），已跳过该词条`,
        });
        bad = true;
        break;
      }
      glyphs.push({ radicalId: rad.id, name: rad.name, svgPath: variant.svgPath });
    }
    if (!bad) {
      entries.push({ lexemeId: lx.id, pronunciation: lx.pronunciation, meaning: lx.meaning, glyphs });
    }
  });

  return { entries, issues };
}

export function validateParams(p: TypesetParams): TypesetIssue[] {
  const issues: TypesetIssue[] = [];
  const positive = (v: number) => Number.isFinite(v) && v > 0;
  const nonNegative = (v: number) => Number.isFinite(v) && v >= 0;

  if (!positive(p.frameWidth) || !positive(p.frameHeight)) {
    issues.push({ severity: 'error', kind: 'invalid-size', message: '纸面宽高必须为正数' });
  }
  if (!positive(p.glyphSize)) {
    issues.push({ severity: 'error', kind: 'invalid-size', message: '字号必须为正数' });
  }
  if (!nonNegative(p.letterSpacing)) {
    issues.push({ severity: 'error', kind: 'invalid-size', message: '字距不能为负数' });
  }
  if (!nonNegative(p.lineSpacing)) {
    issues.push({ severity: 'error', kind: 'invalid-size', message: '行距不能为负数' });
  }
  if (!(Number.isFinite(p.kerning) && p.kerning >= 0 && p.kerning <= 1)) {
    issues.push({ severity: 'error', kind: 'invalid-size', message: '紧排强度需在 0% 到 100% 之间' });
  }
  if (!nonNegative(p.padding)) {
    issues.push({ severity: 'error', kind: 'invalid-size', message: '边距不能为负数' });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 指纹：同输入同参数 → 同指纹；字根（轮廓）或阶段一变 → 指纹变 → 旧版面过期
// ---------------------------------------------------------------------------

export function typesetFingerprint(entries: EntryInput[], params: TypesetParams, stageId: string | null): string {
  const payload = JSON.stringify({
    s: stageId ?? '',
    d: params.direction,
    a: params.align,
    gs: params.glyphSize,
    ls: params.letterSpacing,
    k: params.kerning,
    ln: params.lineSpacing,
    w: params.frameWidth,
    h: params.frameHeight,
    pad: params.padding,
    e: entries.map((e) => [e.lexemeId, e.glyphs.map((g) => `${g.radicalId}:${g.svgPath}`)]),
  });
  // FNV-1a 32bit
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

export const DIRECTION_LABELS: Record<TypesetDirection, string> = {
  horizontal: '横排',
  vertical: '竖排',
};

export const alignLabels = (direction: TypesetDirection): Record<TypesetAlign, string> =>
  direction === 'horizontal'
    ? { start: '左对齐', center: '居中', end: '右对齐', justify: '两端对齐' }
    : { start: '顶对齐', center: '居中', end: '底对齐', justify: '两端对齐' };

export const lineNoun = (direction: TypesetDirection): string => (direction === 'horizontal' ? '行' : '列');
