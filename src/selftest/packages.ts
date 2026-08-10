// 自检域：包管理（pkg 命令族）（O5 拆分）。
import { verdict, boundary } from './runner.js';
import type { TestContext } from './runner.js';
import { listPackages, formatPackageList, searchPackages } from '../pkg.js';

export async function runPackages(ctx: TestContext): Promise<void> {
  const { wc, client, term } = ctx;
  // ─── 包管理（Packages，TASK13）：pkg 命令族统一 lifo + npm 两通道 ───
  const pkgCtx = { wc, client };
  const pkgList = await listPackages(pkgCtx);
  const pkgText = formatPackageList(pkgList).join('\n');
  const pkgTinbase = pkgList.find((p) => p.name === 'tinbase');
  verdict(
    term,
    'Packages',
    'list merged',
    pkgText.startsWith('Packages') && pkgText.includes('SOURCE') && pkgText.includes('VERSION'),
    `${pkgList.length} packages (${pkgList.filter((p) => p.source === 'lifo').length} lifo, ` +
      `${pkgList.filter((p) => p.source === 'npm').length} npm)${pkgTinbase ? ` tinbase@${pkgTinbase.version}` : ''}`
  );

  // search：pkg search git 命中 lifo-pkg-git。网络项 —— 失败按已知边界 SKIP。
  try {
    const outcome = await searchPackages(pkgCtx, 'git');
    const hit = outcome.entries.find((s) => s.name === 'git' && s.source === 'lifo');
    if (hit) {
      verdict(term, 'Packages', 'search lifo-git', true, `lifo-pkg-git ${hit.version}`);
    } else if (outcome.entries.length === 0) {
      boundary(term, 'Packages', 'search lifo-git', 'no results (registry/network unavailable)');
    } else {
      verdict(term, 'Packages', 'search lifo-git', false, 'lifo-pkg-git not in results');
    }
  } catch (e) {
    boundary(term, 'Packages', 'search lifo-git', `network boundary: ${String(e).slice(0, 60)}`);
  }
}
