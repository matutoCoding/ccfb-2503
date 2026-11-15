import type { ProjectSettings, TreeRecord, TreeSpecies, SpacingIssue } from './types';

/**
 * 生长模型（相对成年规格的比例）：
 *   s(age) = s0 + (1 - s0) * (1 - exp(-k * age))
 * s0 = 出圃苗高 / 成年树高，k 由生长速度系数决定。
 * 所有计算都是纯函数，同一输入永远同一输出。
 */
export function growthScale(species: TreeSpecies, ageYears: number): number {
  const s0 = species.saplingHeight / species.matureHeight;
  const k = 0.11 * species.growthRate;
  const age = Math.max(0, ageYears);
  return s0 + (1 - s0) * (1 - Math.exp(-k * age));
}

export function treeAge(tree: TreeRecord, settings: ProjectSettings): number {
  return Math.max(0, settings.startYear + settings.yearOffset - (settings.startYear + tree.plantedYear));
}

/** 当前树高 m */
export function treeHeight(species: TreeSpecies, ageYears: number): number {
  return species.matureHeight * growthScale(species, ageYears);
}

/** 当前冠幅 m */
export function treeCrownWidth(species: TreeSpecies, ageYears: number): number {
  // 幼树树冠比例略小，随年龄趋近成年比例
  const s = growthScale(species, ageYears);
  return species.crownWidth * s * (0.75 + 0.25 * s);
}

/** 单棵树当前冠幅半径（用于间距检查），m */
export function crownRadius(species: TreeSpecies, ageYears: number, mature: boolean): number {
  if (mature) return species.crownWidth * 0.5;
  return treeCrownWidth(species, ageYears) * 0.5;
}

/**
 * 全场间距检查：树冠相交即冲突。
 * 空间哈希分桶，O(n)。
 */
export function checkSpacing(
  trees: TreeRecord[],
  speciesMap: Map<string, TreeSpecies>,
  settings: ProjectSettings,
): SpacingIssue[] {
  const issues: SpacingIssue[] = [];
  const cell = 4;
  const buckets = new Map<string, number[]>();
  const key = (cx: number, cz: number) => `${cx},${cz}`;

  const radii = trees.map((tr) => {
    const sp = speciesMap.get(tr.speciesId)!;
    const r = crownRadius(sp, treeAge(tr, settings), settings.spacingByMature);
    return r;
  });

  trees.forEach((tr, i) => {
    const cx = Math.floor(tr.x / cell);
    const cz = Math.floor(tr.z / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = buckets.get(key(cx + dx, cz + dz));
        if (!bucket) continue;
        for (const j of bucket) {
          const other = trees[j];
          const ddx = tr.x - other.x;
          const ddz = tr.z - other.z;
          const dist = Math.hypot(ddx, ddz);
          const required = radii[i] + radii[j];
          if (dist < required) {
            // 只记录每棵树最严重的一次冲突
            const existing = issues.find((it) => it.treeId === tr.id);
            if (!existing || required - dist > existing.required - existing.distance) {
              if (existing) {
                existing.otherId = other.id;
                existing.distance = dist;
                existing.required = required;
              } else {
                issues.push({ treeId: tr.id, otherId: other.id, distance: dist, required });
              }
            }
          }
        }
      }
    }
    const k = key(cx, cz);
    const arr = buckets.get(k);
    if (arr) arr.push(i);
    else buckets.set(k, [i]);
  });

  return issues;
}
