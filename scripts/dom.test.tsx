/* eslint-disable */
// DOM 级冒烟测试：在 jsdom 中真实渲染 App，验证排印台的横排/竖排/断行/对齐/错误提示。
// 运行：esbuild 打包后 node 执行（见 package.json 或 README）。
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/#/typesetting',
  pretendToBeVisual: true,
});

const g = globalThis as any;
for (const key of [
  'window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'SVGElement',
  'Element', 'Node', 'getComputedStyle', 'CustomEvent', 'MouseEvent', 'Event',
  'HTMLInputElement', 'DocumentFragment',
]) {
  g[key] = (dom.window as any)[key];
}
g.requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
g.cancelAnimationFrame = (id: any) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;

let failures = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}`, extra !== undefined ? String(extra).slice(0, 300) : '');
  }
};

const text = () => document.body.textContent || '';
const findButton = (label: string, exact = false) =>
  Array.from(document.querySelectorAll('button')).find((b) => {
    const t = (b.textContent || '').replace(/\s+/g, '');
    return exact ? t === label : t.includes(label);
  });

const main = async () => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const { default: App } = await import('../src/App');

  const container = document.getElementById('root')!;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(App));
  });

  // --- 初始自动排版（横排） ---
  check('页面标题 排印台', text().includes('排印台'));
  check('初始自动排版完成（状态栏显示词条数）', /\d+ 词条 · \d+ 字形 · \d+ 行/.test(text()), text().slice(0, 400));
  const svgPaths1 = document.querySelectorAll('svg path').length;
  check('横排 SVG 渲染出字形笔画', svgPaths1 > 10, `paths=${svgPaths1}`);
  const bboxRects = document.querySelectorAll('svg rect[stroke-dasharray="3 2"]').length;
  check('紧贴包围盒已绘制', bboxRects > 0, `bbox=${bboxRects}`);
  check('状态与当前输入一致', text().includes('与当前输入一致'));

  // --- 确定性：再点一次排版，版面指纹不变 ---
  const fp1 = (text().match(/指纹 #(\S+)/) || [])[1];
  await act(async () => {
    findButton('排版', true)!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  const fp2 = (text().match(/指纹 #(\S+)/) || [])[1];
  check('同输入同参数指纹一致', !!fp1 && fp1 === fp2, `${fp1} vs ${fp2}`);

  // --- 竖排：从右往左成列 ---
  await act(async () => {
    findButton('竖排')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  check('改参数后旧版面过期', text().includes('旧版面已过期'));
  await act(async () => {
    findButton('排版', true)!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  check('竖排版面生成（状态栏列为单位）', /\d+ 列/.test(text()));
  check('竖排不再过期', text().includes('与当前输入一致'));

  // --- 两端对齐 + 断行：窄纸面强制断列 ---
  const wInput = Array.from(document.querySelectorAll('input[inputmode="numeric"]'))[0] as HTMLInputElement;
  const hInput = Array.from(document.querySelectorAll('input[inputmode="numeric"]'))[1] as HTMLInputElement;
  check('纸面宽高输入存在', !!wInput && !!hInput);
  const setInput = (input: HTMLInputElement, v: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, v);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  await act(async () => {
    setInput(hInput, '200'); // 竖排列高收窄 → 断列
  });
  await act(async () => {
    findButton('两端对齐')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    findButton('排版', true)!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  check('窄列高 + 两端对齐排版不崩', /\d+ 列/.test(text()));

  // --- 非法尺寸提示 ---
  await act(async () => {
    setInput(wInput, 'abc');
  });
  await act(async () => {
    findButton('排版', true)!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  check('非法纸面尺寸有提示且不崩', text().includes('纸面宽高必须为正数'));
  await act(async () => {
    setInput(wInput, '720');
  });

  // --- 空文本提示 ---
  await act(async () => {
    findButton('清空')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    findButton('排版', true)!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  check('空序列提示 排版内容为空', text().includes('排版内容为空'));

  // --- 重新加入词条并排版恢复 ---
  await act(async () => {
    const addBtns = Array.from(document.querySelectorAll('button')).filter((b) =>
      b.title?.includes('加入排版序列') || b.getAttribute('title') === '加入排版序列'
    );
    // 词条行按钮：title 为「加入排版序列」
    addBtns.slice(0, 2).forEach((b) =>
      b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );
  });
  await act(async () => {
    findButton('排版', true)!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  check('重新选词后恢复排版', /\d+ 词条 · \d+ 字形/.test(text()), text().slice(0, 300));

  // --- 切换阶段 → 过期提示 ---
  const stageBtn = Array.from(document.querySelectorAll('button')).find((b) =>
    (b.textContent || '').includes('甲骨遗文')
  );
  check('阶段按钮存在', !!stageBtn);
  await act(async () => {
    stageBtn!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  check('切换阶段后旧版面过期', text().includes('旧版面已过期'));
  await act(async () => {
    findButton('重新排版')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  check('重新排版后恢复一致', text().includes('与当前输入一致'));

  // --- 其他页面照常可用（jsdom 的 hashchange 为异步任务，需在 act 内等待） ---
  const navTo = async (hash: string) => {
    await act(async () => {
      dom.window.location.hash = hash;
      await new Promise((r) => setTimeout(r, 20));
    });
  };
  await navTo('#/glyphs');
  check('字形网格页可用', text().includes('字形库'));
  await navTo('#/timeline');
  check('演化时间线页可用', text().includes('穿越'));
  await navTo('#/editor/radical');
  check('字根编辑页可用', text().includes('阶段变体管理'));
  await navTo('#/composer');
  check('字根组合页可用', text().includes('组合槽位'));
  await navTo('#/lexicon');
  check('词条库页可用', text().includes('造新词'));
  await navTo('#/typesetting');
  check('返回排印台', text().includes('排版序列'));

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error('DOM test crashed:', e);
  process.exit(1);
});
