import { pathBBox, flattenPath, parsePath } from '../src/utils/pathBBox';
import {
  getGlyphMetrics,
  layoutTypeset,
  buildEntries,
  validateParams,
  typesetFingerprint,
  DEFAULT_TYPESET_PARAMS,
} from '../src/utils/typesetting';
import { MOCK_RADICALS, MOCK_LEXEMES, MOCK_STAGES } from '../src/utils/mockData';

let failures = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
};

// --- pathBBox: line-only ---
const bb1 = pathBBox('M10 10 L90 20 L40 80 Z');
check('line bbox', bb1 && bb1.minX === 10 && bb1.minY === 10 && bb1.maxX === 90 && bb1.maxY === 80, bb1);

// --- pathBBox: cubic arc top counts ---
// cubic from (0,0) to (0,0) with control points y=-40 → arc top ≈ -30 at t=0.5
const bb2 = pathBBox('M0 0 C0 -40 100 -40 100 0');
check('cubic arc top in bbox', bb2 && Math.abs(bb2.minY - -30) < 1e-9 && bb2.maxY === 0, bb2);

// --- quad extrema ---
const bb3 = pathBBox('M0 0 Q50 -80 100 0');
check('quad arc top', bb3 && Math.abs(bb3.minY - -40) < 1e-9, bb3);

// --- relative commands & H/V & S/T ---
const bb4 = pathBBox('m10 10 l20 0 l0 20 l-20 0 z');
check('relative bbox', bb4 && bb4.minX === 10 && bb4.minY === 10 && bb4.maxX === 30 && bb4.maxY === 30, bb4);
const bb5 = pathBBox('M10 10 H50 V40 H10 Z');
check('H/V bbox', bb5 && bb5.maxX === 50 && bb5.maxY === 40, bb5);
const bb6 = pathBBox('M0 0 S50 -50 100 0');
check('S shorthand parses', bb6 !== null && bb6.minY < 0, bb6);
const bb7 = pathBBox('M0 0 Q25 -50 50 0 T100 0');
check('T shorthand parses', bb7 !== null && Math.abs(bb7.minY - -25) < 1e-9, bb7);

// --- empty / garbage ---
check('empty path → null bbox', pathBBox('') === null);
check('blank path → null bbox', pathBBox('   ') === null);
check('garbage throws→caught by metrics', getGlyphMetrics('M10') === null);
check('empty metrics null', getGlyphMetrics('') === null);

// --- flatten determinism ---
const f1 = flattenPath('M0 0 C10 20 30 40 50 60', 16);
const f2 = flattenPath('M0 0 C10 20 30 40 50 60', 16);
check('flatten deterministic', JSON.stringify(f1) === JSON.stringify(f2));
check('flatten has points', f1.length > 10);

// --- mock data: all radicals parse, bbox tight vs em box ---
let allOk = true;
for (const r of MOCK_RADICALS) {
  for (const v of r.variants) {
    const m = getGlyphMetrics(v.svgPath);
    if (!m) { allOk = false; console.log('  metrics failed:', r.id, v.stageId); }
  }
}
check('all mock radical variants measurable', allOk);

// curve-heavy glyph （火 stage-4) bbox must exceed control-point-only bbox? just sanity: bbox within 0..100
const fireMetrics = getGlyphMetrics(MOCK_RADICALS.find(r => r.id === 'rad-fire')!.variants[3].svgPath)!;
check('fire bbox sane', fireMetrics.bbox.minX >= 0 && fireMetrics.bbox.maxX <= 100 && fireMetrics.bbox.minY >= 0, fireMetrics.bbox);

// --- buildEntries ---
const stage4 = MOCK_STAGES[3];
const seq = MOCK_LEXEMES.map(l => l.id);
const built = buildEntries(seq, MOCK_LEXEMES, MOCK_RADICALS, stage4.id, stage4.name);
check('buildEntries all mock lexemes ok', built.entries.length === MOCK_LEXEMES.length && built.issues.length === 0, built.issues);

// missing variant: use stage-1 but strip one radical's variant
const radicalsMissing = MOCK_RADICALS.map(r => r.id === 'rad-sun' ? { ...r, variants: r.variants.filter(v => v.stageId !== 'stage-1') } : r);
const builtMissing = buildEntries(seq, MOCK_LEXEMES, radicalsMissing, 'stage-1', '甲骨遗文');
check('missing variant reported', builtMissing.issues.some(i => i.kind === 'missing-variant'));
check('entries with missing variant skipped', builtMissing.entries.length < MOCK_LEXEMES.length);

// empty glyph
const radicalsEmpty = MOCK_RADICALS.map(r => r.id === 'rad-moon' ? { ...r, variants: r.variants.map(v => v.stageId === 'stage-4' ? { ...v, svgPath: '   ' } : v) } : r);
const builtEmpty = buildEntries(seq, MOCK_LEXEMES, radicalsEmpty, 'stage-4', '墨韵楷书');
check('empty glyph reported', builtEmpty.issues.some(i => i.kind === 'empty-glyph'));

// no stage
const builtNoStage = buildEntries(seq, MOCK_LEXEMES, MOCK_RADICALS, null, '');
check('no stage reported', builtNoStage.issues.some(i => i.kind === 'no-stage') && builtNoStage.entries.length === 0);

// --- validateParams ---
check('valid params pass', validateParams(DEFAULT_TYPESET_PARAMS).length === 0);
check('invalid frame flagged', validateParams({ ...DEFAULT_TYPESET_PARAMS, frameWidth: -5 }).some(i => i.kind === 'invalid-size'));
check('NaN glyphSize flagged', validateParams({ ...DEFAULT_TYPESET_PARAMS, glyphSize: NaN }).some(i => i.kind === 'invalid-size'));
check('kerning range flagged', validateParams({ ...DEFAULT_TYPESET_PARAMS, kerning: 1.5 }).some(i => i.kind === 'invalid-size'));

// --- layout: horizontal determinism ---
const p: typeof DEFAULT_TYPESET_PARAMS = { ...DEFAULT_TYPESET_PARAMS, direction: 'horizontal', align: 'start' };
const lay1 = layoutTypeset(built.entries, p);
const lay2 = layoutTypeset(built.entries, p);
check('layout deterministic', JSON.stringify(lay1) === JSON.stringify(lay2));
check('layout produced lines', lay1.result !== null && lay1.result.lines.length > 0, lay1.result?.stats);

// --- kerning: kerning=1 must not increase entry length vs kerning=0 ---
const layK0 = layoutTypeset(built.entries, { ...p, kerning: 0 });
const layK1 = layoutTypeset(built.entries, { ...p, kerning: 1 });
const len0 = layK0.result!.entries.map(e => e.mainLen);
const len1 = layK1.result!.entries.map(e => e.mainLen);
check('kerning tightens or keeps', len1.every((v, i) => v <= len0[i] + 1e-9), { len0, len1 });
check('kerning actually tightens something', len1.some((v, i) => v < len0[i] - 1e-9));

// --- line breaking: narrow frame forces more lines ---
const layNarrow = layoutTypeset(built.entries, { ...p, frameWidth: 300 });
check('narrow frame → more lines', layNarrow.result!.lines.length > lay1.result!.lines.length,
  { wide: lay1.result!.lines.length, narrow: layNarrow.result!.lines.length });

// --- overlong entry: single lexeme longer than capacity gets own line + note ---
const bigParams = { ...p, frameWidth: 100, padding: 20, glyphSize: 60 };
const layOver = layoutTypeset(built.entries.slice(0, 2), bigParams);
check('overlong entry own line + note', layOver.result!.lines.some(l => l.overlong) && layOver.result!.notes.length > 0,
  layOver.result!.notes);

// --- justify: non-last lines reach capacity, last line not stretched ---
const layJ = layoutTypeset(built.entries, { ...p, align: 'justify', frameWidth: 300 });
const jLines = layJ.result!.lines;
const nonLast = jLines.slice(0, -1).filter(l => l.entries.length > 1 && !l.overlong);
const reachCap = nonLast.every(l => {
  const last = l.entries[l.entries.length - 1];
  // 两端对齐后，行末词条的墨迹右缘应恰好顶到 纸面宽-边距
  return Math.abs(last.mainStart + last.mainLen - (300 - 24)) < 1e-6 && l.justified;
});
check('justify marks non-last multi-entry lines justified', nonLast.length > 0 && reachCap);
const lastLine = jLines[jLines.length - 1];
check('last line not stretched', !lastLine.justified);
// justify preserves intra-entry kerning: entry lengths identical to start-aligned
const layS = layoutTypeset(built.entries, { ...p, align: 'start', frameWidth: 300 });
const je = layJ.result!.entries.map(e => e.mainLen);
const se = layS.result!.entries.map(e => e.mainLen);
check('justify preserves kerning (entry lens equal)', JSON.stringify(je) === JSON.stringify(se));

// --- vertical: columns right to left ---
const pv = { ...p, direction: 'vertical' as const, frameWidth: 400, frameHeight: 300 };
const layV = layoutTypeset(built.entries, pv);
check('vertical layout lines exist', layV.result!.lines.length >= 1);
const cols = layV.result!.lines;
let rtl = true;
for (let i = 1; i < cols.length; i++) if (cols[i].cross >= cols[i - 1].cross) rtl = false;
check('vertical columns go right-to-left', rtl, cols.map(c => c.cross));
// glyphs within column: y increases
const col0Glyphs = cols[0].entries.flatMap(e => e.glyphs);
let down = true;
for (let i = 1; i < col0Glyphs.length; i++) if (col0Glyphs[i].y < col0Glyphs[i - 1].y) down = false;
check('vertical glyphs flow top-to-bottom', down);

// --- vertical kerning uses vertical projection ---
const layV0 = layoutTypeset(built.entries, { ...pv, kerning: 0 });
const layV1 = layoutTypeset(built.entries, { ...pv, kerning: 1 });
const v0 = layV0.result!.entries.map(e => e.mainLen);
const v1 = layV1.result!.entries.map(e => e.mainLen);
check('vertical kerning tightens', v1.every((v, i) => v <= v0[i] + 1e-9) && v1.some((v, i) => v < v0[i] - 1e-9));

// --- fingerprint: same input same hash; stage/radical change → change ---
const fp1 = typesetFingerprint(built.entries, p, stage4.id);
const fp2 = typesetFingerprint(built.entries, p, stage4.id);
check('fingerprint stable', fp1 === fp2);
const fp3 = typesetFingerprint(built.entries, p, 'stage-3');
check('fingerprint changes with stage', fp1 !== fp3);
const builtAlt = buildEntries(seq, MOCK_LEXEMES, radicalsEmpty, 'stage-4', 'x');
const fp4 = typesetFingerprint(builtAlt.entries, p, stage4.id);
check('fingerprint changes with radical data', fp1 !== fp4);
const fp5 = typesetFingerprint(built.entries, { ...p, letterSpacing: 9 }, stage4.id);
check('fingerprint changes with params', fp1 !== fp5);

// --- invalid size does not crash layout ---
const layBad = layoutTypeset(built.entries, { ...p, frameWidth: 10, padding: 20 });
check('too-small frame → null result + issue, no crash', layBad.result === null && layBad.issues.some(i => i.kind === 'invalid-size'));

// --- empty entries ---
const layEmpty = layoutTypeset([], p);
check('empty entries → empty lines, no crash', layEmpty.result !== null && layEmpty.result.lines.length === 0);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
