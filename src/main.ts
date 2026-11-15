import './ui/styles.css';
import { AppStore } from './core/store';
import { AppShell } from './ui/app-shell';
import { makeRng } from './core/rng';
import { generateTreeModel } from './tree/generator';
import { BUILTIN_SPECIES } from './core/species';
import { toast } from './ui/dom';
import { LibraryPage } from './pages/library-page';
import { SitePage } from './pages/site-page';
import { PreviewPage } from './pages/preview-page';
import { GrowthPage } from './pages/growth-page';
import { ReportPage } from './pages/report-page';
import type { Page } from './pages/page';

/** 启动自检：同种子两次生成的几何必须逐顶点一致 */
function determinismSelfTest(): void {
  const sp = BUILTIN_SPECIES[0];
  const a = generateTreeModel(sp, 1, 4);
  const b = generateTreeModel(sp, 1, 4);
  const pa = a.lodHigh.foliage.attributes.position.array;
  const pb = b.lodHigh.foliage.attributes.position.array;
  let ok = pa.length === pb.length;
  if (ok) {
    for (let i = 0; i < pa.length; i++) {
      if (Math.abs(pa[i] - pb[i]) > 1e-9) { ok = false; break; }
    }
  }
  // 不同应变体必须不同
  const c = generateTreeModel(sp, 2, 4);
  const diff = c.lodHigh.foliage.attributes.position.count !== a.lodHigh.foliage.attributes.position.count
    || c.lodHigh.foliage.attributes.position.array[7] !== pa[7];
  if (!ok || !diff) {
    toast('确定性自检失败：树木生成存在非随机源差异', 'error', 6000);
  }
  // RNG 基本性质
  const r1 = makeRng(42);
  const r2 = makeRng(42);
  if (r1.next() !== r2.next()) toast('RNG 自检失败', 'error', 6000);
}

determinismSelfTest();

const store = new AppStore();

const factory = (id: string): Page => {
  switch (id) {
    case 'library': return new LibraryPage();
    case 'site': return new SitePage();
    case 'preview': return new PreviewPage();
    case 'growth': return new GrowthPage();
    case 'report': return new ReportPage();
    default: return new LibraryPage();
  }
};

new AppShell(store, factory);

// 调试/自动化验证钩子（不影响业务逻辑）
declare global {
  interface Window { __app?: { store: AppStore } }
}
window.__app = { store };
