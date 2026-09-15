import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AlertTriangle,
  ArrowLeftRight,
  ArrowUpDown,
  LayoutTemplate,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useWritingSystemStore } from '@/store/useWritingSystemStore';
import { GlyphRenderer } from '@/components/GlyphRenderer';
import {
  DEFAULT_TYPESET_PARAMS,
  DIRECTION_LABELS,
  alignLabels,
  buildEntries,
  layoutTypeset,
  lineNoun,
  typesetFingerprint,
  validateParams,
  type EntryInput,
  type TypesetAlign,
  type TypesetDirection,
  type TypesetIssue,
  type TypesetParams,
  type TypesetResult,
} from '@/utils/typesetting';

interface SheetSnapshot {
  fingerprint: string;
  stageId: string | null;
  stageName: string;
  params: TypesetParams;
  result: TypesetResult | null;
  issues: TypesetIssue[];
  entries: EntryInput[];
}

const ALIGN_ICONS: Record<TypesetAlign, React.ReactNode> = {
  start: <AlignLeft size={15} />,
  center: <AlignCenter size={15} />,
  end: <AlignRight size={15} />,
  justify: <AlignJustify size={15} />,
};

const SliderRow: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, step = 1, format, onChange }) => (
  <div className="flex items-center gap-3">
    <span className="w-14 shrink-0 font-kai text-sm text-ink-400">{label}</span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="flex-1 accent-vermilion-500"
    />
    <span className="w-14 text-right font-song text-xs text-ink-300">
      {format ? format(value) : value}
    </span>
  </div>
);

const ToggleChip: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children,
}) => (
  <button
    onClick={onClick}
    className={`px-3 py-1.5 rounded-lg font-kai text-xs transition-all border ${
      active
        ? 'bg-bronze-400/20 text-bronze-500 border-bronze-400/50'
        : 'bg-parchment-100/60 text-ink-300 border-parchment-300/50 hover:border-bronze-400/40'
    }`}
  >
    {children}
  </button>
);

export const TypesettingPage: React.FC = () => {
  const lexemes = useWritingSystemStore((s) => s.lexemes);
  const radicals = useWritingSystemStore((s) => s.radicals);
  const stages = useWritingSystemStore((s) => s.stages);
  const globalStageId = useWritingSystemStore((s) => s.selectedStageId);

  const sortedStages = useMemo(() => [...stages].sort((a, b) => a.order - b.order), [stages]);

  const [stageId, setStageId] = useState<string | null>(
    () => globalStageId || sortedStages[sortedStages.length - 1]?.id || null
  );
  const [sequence, setSequence] = useState<string[]>(() => lexemes.slice(0, 4).map((l) => l.id));
  const [direction, setDirection] = useState<TypesetDirection>('horizontal');
  const [align, setAlign] = useState<TypesetAlign>('start');
  const [glyphSize, setGlyphSize] = useState(DEFAULT_TYPESET_PARAMS.glyphSize);
  const [letterSpacing, setLetterSpacing] = useState(DEFAULT_TYPESET_PARAMS.letterSpacing);
  const [kerningPct, setKerningPct] = useState(Math.round(DEFAULT_TYPESET_PARAMS.kerning * 100));
  const [lineSpacing, setLineSpacing] = useState(DEFAULT_TYPESET_PARAMS.lineSpacing);
  const [sizeInputs, setSizeInputs] = useState({
    w: String(DEFAULT_TYPESET_PARAMS.frameWidth),
    h: String(DEFAULT_TYPESET_PARAMS.frameHeight),
  });
  const [showBBox, setShowBBox] = useState(true);
  const [showGuides, setShowGuides] = useState(true);
  const [snapshot, setSnapshot] = useState<SheetSnapshot | null>(null);

  const stageName = useMemo(
    () => sortedStages.find((s) => s.id === stageId)?.name ?? '未命名阶段',
    [sortedStages, stageId]
  );

  const params: TypesetParams = useMemo(
    () => ({
      direction,
      align,
      glyphSize,
      letterSpacing,
      kerning: kerningPct / 100,
      lineSpacing,
      frameWidth: parseFloat(sizeInputs.w),
      frameHeight: parseFloat(sizeInputs.h),
      padding: DEFAULT_TYPESET_PARAMS.padding,
    }),
    [direction, align, glyphSize, letterSpacing, kerningPct, lineSpacing, sizeInputs]
  );

  // 当前输入的实时解析：词条 → 字形 + 校验 + 指纹（确定性来源）
  const current = useMemo(() => {
    const { entries, issues } = buildEntries(sequence, lexemes, radicals, stageId, stageName);
    const paramIssues = validateParams(params);
    const fp = typesetFingerprint(entries, params, stageId);
    return { entries, issues: [...paramIssues, ...issues], fp };
  }, [sequence, lexemes, radicals, stageId, stageName, params]);

  const doLayout = useCallback(() => {
    const issues: TypesetIssue[] = [];
    if (sequence.length === 0) {
      issues.push({
        severity: 'error',
        kind: 'empty-selection',
        message: '排版内容为空：请先从词条库选择词条',
      });
    }
    issues.push(...current.issues);

    let result: TypesetResult | null = null;
    let layoutIssues: TypesetIssue[] = [];
    const hasInvalidSize = issues.some((i) => i.kind === 'invalid-size');
    if (!hasInvalidSize && current.entries.length > 0) {
      const out = layoutTypeset(current.entries, params);
      result = out.result;
      layoutIssues = out.issues;
    } else if (!hasInvalidSize && sequence.length > 0 && current.entries.length === 0) {
      issues.push({
        severity: 'error',
        kind: 'no-valid-entries',
        message: '所选词条均无法排版，请根据上方提示修正',
      });
    }

    setSnapshot({
      fingerprint: current.fp,
      stageId,
      stageName,
      params: { ...params },
      result,
      issues: [...issues, ...layoutIssues],
      entries: current.entries,
    });
  }, [current, params, sequence.length, stageId, stageName]);

  // 首次进入自动排一版，之后输入变化只会使旧版面过期，需手动重排
  useEffect(() => {
    doLayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isStale = snapshot !== null && snapshot.fingerprint !== current.fp;

  // 词条在当前阶段的可用性（ picker 提示用）
  const invalidLexemeIds = useMemo(() => {
    const set = new Set<string>();
    if (!stageId) return set;
    for (const l of lexemes) {
      if (l.radicalIds.length === 0) {
        set.add(l.id);
        continue;
      }
      for (const rid of l.radicalIds) {
        const rad = radicals.find((r) => r.id === rid);
        const v = rad?.variants.find((vv) => vv.stageId === stageId);
        if (!rad || !v || !v.svgPath.trim()) {
          set.add(l.id);
          break;
        }
      }
    }
    return set;
  }, [lexemes, radicals, stageId]);

  const lexemeLabel = useCallback(
    (id: string) => {
      const l = lexemes.find((x) => x.id === id);
      return l ? `${l.pronunciation} · ${l.meaning.split('；')[0]}` : '已删除的词条';
    },
    [lexemes]
  );

  // 版面可视范围：纸面 ∪ 所有字形（溢出部分也完整可见）
  const sheet = useMemo(() => {
    if (!snapshot?.result) return null;
    const p = snapshot.params;
    let minX = 0;
    let minY = 0;
    let maxX = p.frameWidth;
    let maxY = p.frameHeight;
    for (const line of snapshot.result.lines) {
      for (const e of line.entries) {
        for (const g of e.glyphs) {
          minX = Math.min(minX, g.x);
          minY = Math.min(minY, g.y);
          maxX = Math.max(maxX, g.x + p.glyphSize);
          maxY = Math.max(maxY, g.y + p.glyphSize);
        }
      }
    }
    const margin = 16;
    return {
      minX: minX - margin,
      minY: minY - margin,
      w: maxX - minX + margin * 2,
      h: maxY - minY + margin * 2,
    };
  }, [snapshot]);

  const displayIssues = useMemo(() => {
    const live = validateParams(params);
    const base = snapshot ? snapshot.issues : current.issues;
    const seen = new Set(base.map((i) => i.message));
    const extra = live.filter((i) => !seen.has(i.message));
    return [...extra, ...base];
  }, [snapshot, current.issues, params]);

  return (
    <div className="container mx-auto px-6 py-8">
      <div className="mb-6 animate-fade-up">
        <h2 className="text-3xl font-kai text-ink-500 font-bold tracking-wider flex items-center gap-3 mb-2">
          <LayoutTemplate className="text-vermilion-500" size={28} />
          排印台
        </h2>
        <p className="text-ink-300 font-song text-sm">
          选择词条与阶段，按真实轮廓（含曲线弧顶）紧贴排版 · 横排自左而右，竖排自右而左成列 ·
          同样的输入与参数永远得到同样的版面
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-6 items-start">
        {/* ---------------- 左：控制台 ---------------- */}
        <div className="space-y-5">
          {/* 阶段 */}
          <section className="bg-parchment-50 rounded-2xl p-5 shadow-scroll border border-parchment-300/40 animate-fade-up">
            <h3 className="font-kai text-base text-ink-500 font-bold mb-3 flex items-center gap-2">
              <span className="w-1 h-4 rounded bg-vermilion-500" />
              历史阶段
            </h3>
            {sortedStages.length === 0 ? (
              <p className="font-song text-xs text-ink-300">暂无阶段，请先在时间线中创建</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {sortedStages.map((st) => (
                  <button
                    key={st.id}
                    onClick={() => setStageId(st.id)}
                    className={`px-3 py-1.5 rounded-lg font-kai text-sm transition-all border ${
                      stageId === st.id
                        ? 'bg-vermilion-500 text-parchment-50 border-vermilion-600 shadow-seal'
                        : 'bg-parchment-100/70 text-ink-400 border-parchment-300/50 hover:border-vermilion-500/40'
                    }`}
                  >
                    {st.name}
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* 词条序列 */}
          <section className="bg-parchment-50 rounded-2xl p-5 shadow-scroll border border-parchment-300/40 animate-fade-up">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-kai text-base text-ink-500 font-bold flex items-center gap-2">
                <span className="w-1 h-4 rounded bg-vermilion-500" />
                排版序列
                <span className="text-xs text-ink-300 font-song font-normal">
                  {sequence.length} 条
                </span>
              </h3>
              {sequence.length > 0 && (
                <button
                  onClick={() => setSequence([])}
                  className="flex items-center gap-1 text-xs font-kai text-ink-300 hover:text-vermilion-500 transition-colors"
                >
                  <Trash2 size={12} />
                  清空
                </button>
              )}
            </div>
            {sequence.length === 0 ? (
              <p className="font-song text-xs text-ink-200 border border-dashed border-parchment-300/60 rounded-lg px-3 py-2.5">
                尚未选择词条 —— 从下方词条库点击加入
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {sequence.map((id, idx) => (
                  <span
                    key={`${id}-${idx}`}
                    className="inline-flex items-center gap-1 pl-1.5 pr-1 py-1 rounded-lg bg-parchment-100/80 border border-parchment-300/50 text-xs font-song text-ink-500"
                  >
                    <span className="w-4 h-4 rounded bg-bronze-400/20 text-bronze-500 font-kai text-[10px] flex items-center justify-center">
                      {idx + 1}
                    </span>
                    {lexemeLabel(id)}
                    <button
                      onClick={() => setSequence((seq) => seq.filter((_, i) => i !== idx))}
                      className="w-4 h-4 rounded hover:bg-vermilion-500/15 text-ink-300 hover:text-vermilion-500 flex items-center justify-center transition-colors"
                      title="移出序列"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="mt-3 max-h-56 overflow-y-auto rounded-xl border border-parchment-300/40 divide-y divide-parchment-200/60 bg-parchment-100/40">
              {lexemes.length === 0 && (
                <p className="px-3 py-4 text-center font-song text-xs text-ink-200">
                  词条库为空，请先到「字根组合」造词
                </p>
              )}
              {lexemes.map((l) => {
                const invalid = invalidLexemeIds.has(l.id);
                const firstRad = radicals.find((r) => r.id === l.radicalIds[0]);
                return (
                  <button
                    key={l.id}
                    onClick={() => setSequence((seq) => [...seq, l.id])}
                    className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-parchment-50 transition-colors text-left group"
                    title={invalid ? '该词条在当前阶段缺少字形，排版时将被跳过' : '加入排版序列'}
                  >
                    <span className="shrink-0 w-7 h-7 rounded bg-parchment-50 border border-parchment-300/40 flex items-center justify-center overflow-hidden">
                      {firstRad ? (
                        <GlyphRenderer radical={firstRad} stageId={stageId} size={22} strokeWidth={3} />
                      ) : (
                        <span className="text-[10px] text-ink-200">空</span>
                      )}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="font-kai text-sm text-vermilion-500 font-bold mr-2">
                        {l.pronunciation}
                      </span>
                      <span className="font-song text-xs text-ink-400 truncate">
                        {l.meaning.split('；')[0]}
                      </span>
                    </span>
                    {invalid && <AlertTriangle size={13} className="shrink-0 text-vermilion-400" />}
                    <Plus
                      size={14}
                      className="shrink-0 text-ink-200 group-hover:text-bronze-500 transition-colors"
                    />
                  </button>
                );
              })}
            </div>
          </section>

          {/* 参数 */}
          <section className="bg-parchment-50 rounded-2xl p-5 shadow-scroll border border-parchment-300/40 animate-fade-up space-y-4">
            <h3 className="font-kai text-base text-ink-500 font-bold flex items-center gap-2">
              <span className="w-1 h-4 rounded bg-vermilion-500" />
              排版参数
            </h3>

            <div className="flex gap-2">
              {(['horizontal', 'vertical'] as TypesetDirection[]).map((d) => (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl font-kai text-sm transition-all border ${
                    direction === d
                      ? 'bg-ink-500 text-parchment-50 border-ink-600 shadow-md'
                      : 'bg-parchment-100/70 text-ink-400 border-parchment-300/50 hover:border-ink-400/40'
                  }`}
                >
                  {d === 'horizontal' ? <ArrowLeftRight size={15} /> : <ArrowUpDown size={15} />}
                  {DIRECTION_LABELS[d]}
                  {d === 'vertical' && <span className="text-[10px] opacity-70">自右而左</span>}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-4 gap-1.5">
              {(['start', 'center', 'end', 'justify'] as TypesetAlign[]).map((a) => (
                <button
                  key={a}
                  onClick={() => setAlign(a)}
                  className={`flex flex-col items-center gap-0.5 px-1 py-1.5 rounded-lg font-kai text-[11px] transition-all border ${
                    align === a
                      ? 'bg-ink-500 text-parchment-50 border-ink-600'
                      : 'bg-parchment-100/70 text-ink-400 border-parchment-300/50 hover:border-ink-400/40'
                  }`}
                >
                  {ALIGN_ICONS[a]}
                  {alignLabels(direction)[a]}
                </button>
              ))}
            </div>

            <div className="space-y-2.5">
              <SliderRow label="字号" value={glyphSize} min={16} max={96} onChange={setGlyphSize} format={(v) => `${v}px`} />
              <SliderRow label="字距" value={letterSpacing} min={0} max={40} onChange={setLetterSpacing} format={(v) => `${v}px`} />
              <SliderRow label="紧排" value={kerningPct} min={0} max={100} onChange={setKerningPct} format={(v) => `${v}%`} />
              <SliderRow label={direction === 'horizontal' ? '行距' : '列距'} value={lineSpacing} min={0} max={60} onChange={setLineSpacing} format={(v) => `${v}px`} />
            </div>

            <div className="flex items-center gap-3">
              <span className="w-14 shrink-0 font-kai text-sm text-ink-400">纸面</span>
              {(['w', 'h'] as const).map((key) => {
                const raw = sizeInputs[key];
                const val = parseFloat(raw);
                const bad = !(Number.isFinite(val) && val > 0);
                return (
                  <label key={key} className="flex items-center gap-1.5 flex-1">
                    <span className="font-song text-xs text-ink-300">{key === 'w' ? '宽' : '高'}</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={raw}
                      onChange={(e) => setSizeInputs((s) => ({ ...s, [key]: e.target.value }))}
                      className={`w-full px-2 py-1.5 rounded-lg bg-white border font-song text-sm text-ink-500 focus:outline-none focus:ring-2 ${
                        bad
                          ? 'border-vermilion-500/60 focus:ring-vermilion-500/20'
                          : 'border-parchment-300 focus:ring-bronze-400/20'
                      }`}
                    />
                  </label>
                );
              })}
            </div>

            <div className="flex flex-wrap gap-2">
              <ToggleChip active={showBBox} onClick={() => setShowBBox((v) => !v)}>
                紧贴包围盒
              </ToggleChip>
              <ToggleChip active={showGuides} onClick={() => setShowGuides((v) => !v)}>
                辅助线
              </ToggleChip>
            </div>

            <button
              onClick={doLayout}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-vermilion-500 hover:bg-vermilion-600 text-parchment-50 rounded-xl shadow-seal font-kai text-base transition-all hover:scale-[1.02] active:scale-95 border-2 border-vermilion-600/30"
            >
              <LayoutTemplate size={18} />
              排版
            </button>
          </section>

          {/* 问题提示 */}
          {displayIssues.length > 0 && (
            <section className="bg-parchment-50 rounded-2xl p-5 shadow-scroll border border-vermilion-500/30 animate-fade-up">
              <h3 className="font-kai text-base text-ink-500 font-bold mb-3 flex items-center gap-2">
                <AlertTriangle size={16} className="text-vermilion-500" />
                问题提示
              </h3>
              <ul className="space-y-1.5">
                {displayIssues.map((issue, i) => (
                  <li
                    key={i}
                    className={`flex items-start gap-2 font-song text-xs leading-relaxed rounded-lg px-2.5 py-2 ${
                      issue.severity === 'error'
                        ? 'bg-vermilion-500/10 text-vermilion-600'
                        : 'bg-bronze-400/10 text-bronze-500'
                    }`}
                  >
                    <span className="mt-0.5 shrink-0">{issue.severity === 'error' ? '✕' : '⚠'}</span>
                    {issue.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* ---------------- 右：版面 ---------------- */}
        <div className="space-y-4 min-w-0">
          {/* 状态栏 */}
          <section className="bg-parchment-50 rounded-2xl px-5 py-4 shadow-scroll border border-parchment-300/40 animate-fade-up">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <span className="font-kai text-sm text-ink-500 font-bold">版面状态</span>
              {snapshot ? (
                <>
                  <span className="font-song text-xs text-ink-300">
                    阶段 <span className="text-ink-500 font-kai">{snapshot.stageName}</span>
                  </span>
                  <span className="font-song text-xs text-ink-300">
                    方向 <span className="text-ink-500 font-kai">{DIRECTION_LABELS[snapshot.params.direction]}</span>
                  </span>
                  {snapshot.result && (
                    <span className="font-song text-xs text-ink-300">
                      {snapshot.result.stats.entries} 词条 · {snapshot.result.stats.glyphs} 字形 ·{' '}
                      {snapshot.result.stats.lines} {lineNoun(snapshot.params.direction)}
                    </span>
                  )}
                  <span className="font-song text-[10px] text-ink-200">指纹 #{snapshot.fingerprint}</span>
                  {isStale ? (
                    <span className="flex items-center gap-2 ml-auto">
                      <span className="px-2.5 py-1 rounded-lg bg-vermilion-500/10 text-vermilion-600 font-kai text-xs border border-vermilion-500/30">
                        字根或阶段已变更 · 旧版面已过期
                      </span>
                      <button
                        onClick={doLayout}
                        className="flex items-center gap-1 px-3 py-1 rounded-lg bg-vermilion-500 hover:bg-vermilion-600 text-parchment-50 font-kai text-xs transition-all shadow-seal"
                      >
                        <RefreshCw size={12} />
                        重新排版
                      </button>
                    </span>
                  ) : (
                    <span className="ml-auto px-2.5 py-1 rounded-lg bg-bronze-400/15 text-bronze-500 font-kai text-xs border border-bronze-400/30">
                      与当前输入一致
                    </span>
                  )}
                </>
              ) : (
                <span className="font-song text-xs text-ink-300">尚未排版</span>
              )}
            </div>
          </section>

          {/* 纸面 */}
          <section className="bg-parchment-50 rounded-2xl p-4 shadow-scroll border border-parchment-300/40 animate-fade-up">
            {!snapshot || !sheet || !snapshot.result ? (
              <div className="h-72 flex flex-col items-center justify-center text-center">
                <div className="text-5xl mb-3 opacity-25">🖨️</div>
                <p className="font-kai text-lg text-ink-300 mb-1">
                  {!snapshot ? '选择词条与阶段，点击「排版」生成版面' : '无法生成版面'}
                </p>
                <p className="font-song text-xs text-ink-200">
                  {!snapshot
                    ? '同样的输入与参数，永远得到同样的版面'
                    : '请根据左侧「问题提示」修正后重新排版'}
                </p>
              </div>
            ) : (
              <div className="overflow-auto max-h-[70vh] rounded-lg">
                <svg
                  viewBox={`${sheet.minX} ${sheet.minY} ${sheet.w} ${sheet.h}`}
                  width={sheet.w}
                  height={sheet.h}
                  className="max-w-none block"
                >
                  {/* 纸面 */}
                  <rect
                    x={0}
                    y={0}
                    width={snapshot.params.frameWidth}
                    height={snapshot.params.frameHeight}
                    fill="#FBF4E4"
                    stroke="#C4A25F"
                    strokeWidth={1.5}
                    rx={4}
                  />
                  {/* 边距辅助线 */}
                  {showGuides && (
                    <rect
                      x={snapshot.params.padding}
                      y={snapshot.params.padding}
                      width={Math.max(0, snapshot.params.frameWidth - snapshot.params.padding * 2)}
                      height={Math.max(0, snapshot.params.frameHeight - snapshot.params.padding * 2)}
                      fill="none"
                      stroke="#5D7A6F"
                      strokeWidth={0.8}
                      strokeDasharray="5 4"
                      opacity={0.45}
                    />
                  )}
                  {/* 行/列带 */}
                  {showGuides &&
                    snapshot.result.lines.map((line) =>
                      snapshot.params.direction === 'horizontal' ? (
                        <rect
                          key={line.index}
                          x={snapshot.params.padding}
                          y={line.cross}
                          width={snapshot.result!.capacity}
                          height={snapshot.params.glyphSize}
                          fill="none"
                          stroke="#5D7A6F"
                          strokeWidth={0.6}
                          strokeDasharray="2 3"
                          opacity={0.4}
                        />
                      ) : (
                        <rect
                          key={line.index}
                          x={line.cross}
                          y={snapshot.params.padding}
                          width={snapshot.params.glyphSize}
                          height={snapshot.result!.capacity}
                          fill="none"
                          stroke="#5D7A6F"
                          strokeWidth={0.6}
                          strokeDasharray="2 3"
                          opacity={0.4}
                        />
                      )
                    )}
                  {/* 溢出边界 */}
                  {snapshot.result.crossOverflow > 0 &&
                    (snapshot.params.direction === 'horizontal' ? (
                      <line
                        x1={0}
                        x2={snapshot.params.frameWidth}
                        y1={snapshot.params.frameHeight}
                        y2={snapshot.params.frameHeight}
                        stroke="#B23A29"
                        strokeWidth={1.5}
                        strokeDasharray="6 4"
                      />
                    ) : (
                      <line
                        x1={0}
                        x2={0}
                        y1={0}
                        y2={snapshot.params.frameHeight}
                        stroke="#B23A29"
                        strokeWidth={1.5}
                        strokeDasharray="6 4"
                      />
                    ))}

                  {/* 词条与字形 */}
                  {snapshot.result.entries.map((entry, ei) => {
                    const p = snapshot.params;
                    const scale = p.glyphSize / 100;
                    const line = snapshot.result!.lines[entry.lineIndex];
                    const first = entry.glyphs[0];
                    const badgeX =
                      p.direction === 'horizontal' ? first.x - 11 : line.cross + p.glyphSize / 2;
                    const badgeY =
                      p.direction === 'horizontal' ? line.cross + p.glyphSize / 2 : first.y - 11;
                    return (
                      <g key={`${entry.lexemeId}-${ei}`}>
                        {entry.glyphs.map((g, gi) => (
                          <g key={gi} transform={`translate(${g.x} ${g.y}) scale(${scale})`}>
                            {g.svgPath.split(/(?=M)/).map((seg, si) =>
                              seg.trim() ? (
                                <path
                                  key={si}
                                  d={seg}
                                  fill="none"
                                  stroke="#3E2723"
                                  strokeWidth={2.5}
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              ) : null
                            )}
                            {showBBox && (
                              <rect
                                x={g.bbox.minX}
                                y={g.bbox.minY}
                                width={Math.max(0.01, g.bbox.maxX - g.bbox.minX)}
                                height={Math.max(0.01, g.bbox.maxY - g.bbox.minY)}
                                fill="rgba(178,58,41,0.05)"
                                stroke="#B23A29"
                                strokeWidth={0.8}
                                strokeDasharray="3 2"
                              />
                            )}
                          </g>
                        ))}
                        {/* 词条序号章 */}
                        <g transform={`translate(${badgeX} ${badgeY})`}>
                          <circle
                            r={9}
                            fill={entry.overlong ? '#B23A29' : '#5D7A6F'}
                            opacity={0.92}
                          />
                          <text
                            textAnchor="middle"
                            dy="0.35em"
                            fontSize={10}
                            fill="#FBF4E4"
                            fontFamily="KaiTi"
                          >
                            {ei + 1}
                          </text>
                        </g>
                      </g>
                    );
                  })}

                  {snapshot.result.entries.length === 0 && (
                    <text
                      x={snapshot.params.frameWidth / 2}
                      y={snapshot.params.frameHeight / 2}
                      textAnchor="middle"
                      fontSize={14}
                      fill="#9E8B75"
                      fontFamily="KaiTi"
                    >
                      没有可排版的词条
                    </text>
                  )}
                </svg>
              </div>
            )}
          </section>

          {/* 图例与说明 */}
          {snapshot?.result && snapshot.result.entries.length > 0 && (
            <section className="bg-parchment-50 rounded-2xl p-5 shadow-scroll border border-parchment-300/40 animate-fade-up">
              <h3 className="font-kai text-base text-ink-500 font-bold mb-3 flex items-center gap-2">
                <span className="w-1 h-4 rounded bg-bronze-400" />
                版面说明
              </h3>
              {snapshot.result.notes.length > 0 && (
                <ul className="mb-3 space-y-1.5">
                  {snapshot.result.notes.map((n, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 font-song text-xs text-vermilion-600 bg-vermilion-500/10 rounded-lg px-2.5 py-2"
                    >
                      <span className="mt-0.5">⚠</span>
                      {n}
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5">
                {snapshot.result.entries.map((e, i) => (
                  <div key={`${e.lexemeId}-${i}`} className="flex items-center gap-2.5 font-song text-xs">
                    <span
                      className={`h-4 min-w-[16px] px-1 rounded-full text-[10px] font-kai flex items-center justify-center text-parchment-50 ${
                        e.overlong ? 'bg-vermilion-500' : 'bg-bronze-400'
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span className="font-kai text-vermilion-500 font-bold">{e.pronunciation}</span>
                    <span className="text-ink-400 truncate flex-1">{e.meaning.split('；')[0]}</span>
                    <span className="text-ink-200 shrink-0">
                      第 {e.lineIndex + 1} {lineNoun(snapshot.params.direction)}
                      {e.overlong && ' · 超长独占'}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};
