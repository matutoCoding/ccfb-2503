import * as THREE from 'three';
import type { SeasonSample, TreeSpecies } from './types';

/**
 * 季节模型：phase t ∈ [0,1) 表示一年中的位置（0 = 1月1日）。
 * 关键节点：
 *   0.12  深冬
 *   0.22  萌芽 / 樱花季
 *   0.35  仲春
 *   0.55  盛夏
 *   0.78  初秋
 *   0.90  深秋落叶
 */

interface Key { t: number; v: number; }

function sampleKeys(keys: Key[], t: number): number {
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const k = (t - a.t) / (b.t - a.t);
      return a.v + (b.v - a.v) * k;
    }
  }
  return keys[keys.length - 1].v;
}

/** 落叶树叶量关键帧 */
const DECIDUOUS_DENSITY: Key[] = [
  { t: 0.0, v: 0.1 },
  { t: 0.14, v: 0.1 },
  { t: 0.28, v: 1.0 },
  { t: 0.8, v: 1.0 },
  { t: 0.94, v: 0.1 },
  { t: 1.0, v: 0.1 },
];

const C_SPRING = new THREE.Color();
const C_SUMMER = new THREE.Color();
const C_AUTUMN = new THREE.Color();
const C_OUT = new THREE.Color();

/**
 * 采样某树种在年相 t 下的外观。
 * 落叶树：春绿 → 夏深绿 → 秋色 → 冬季秃枝（保留少量枯叶）。
 * 常绿树：只在春/夏两色间轻微变化。
 */
export function sampleSeason(species: TreeSpecies, t: number): SeasonSample {
  C_SPRING.set(species.colorSpring);
  C_SUMMER.set(species.colorSummer);
  C_AUTUMN.set(species.colorAutumn);

  if (species.evergreen) {
    // 常绿树：早春偏嫩，之后稳定夏色
    const k = Math.min(1, Math.max(0, (t - 0.1) / 0.25));
    C_OUT.copy(C_SPRING).lerp(C_SUMMER, k);
  } else {
    if (t < 0.16) {
      C_OUT.copy(C_AUTUMN).multiplyScalar(0.7);
    } else if (t < 0.3) {
      C_OUT.copy(C_AUTUMN).lerp(C_SPRING, (t - 0.16) / 0.14);
    } else if (t < 0.42) {
      C_OUT.copy(C_SPRING).lerp(C_SUMMER, (t - 0.3) / 0.12);
    } else if (t < 0.72) {
      C_OUT.copy(C_SUMMER);
    } else if (t < 0.88) {
      C_OUT.copy(C_SUMMER).lerp(C_AUTUMN, (t - 0.72) / 0.16);
    } else {
      C_OUT.copy(C_AUTUMN);
    }
  }

  const foliageDensity = species.evergreen ? 1 : sampleKeys(DECIDUOUS_DENSITY, t);

  let flowerAmount = 0;
  if (species.flowerPhase) {
    const [a, b] = species.flowerPhase;
    if (t >= a && t <= b) {
      const ramp = Math.min((b - a) * 0.3, 0.04);
      flowerAmount = Math.min(1, (t - a) / ramp, (b - t) / ramp);
      flowerAmount = Math.max(0, flowerAmount);
    }
  }

  // 深色树种（雪松/水杉等）天然明度低，统一把叶色向亮处拉，保证背光面不死黑
  const hsl = { h: 0, s: 0, l: 0 };
  C_OUT.getHSL(hsl);
  C_OUT.setHSL(hsl.h, Math.min(0.75, hsl.s * 0.95), Math.max(hsl.l, 0.32));

  return {
    leafColor: C_OUT.getHex(),
    foliageDensity,
    flowerAmount,
  };
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 月、日（1 基）→ 年相 */
export function monthDayToT(month: number, day: number): number {
  let acc = 0;
  for (let m = 0; m < month - 1; m++) acc += MONTH_DAYS[m];
  return (acc + day - 1) / 365;
}

/** 年相 → 月、日 */
export function tToMonthDay(t: number): { month: number; day: number } {
  const day = Math.min(365, Math.floor(t * 365) + 1);
  let acc = 0;
  for (let m = 0; m < 12; m++) {
    if (acc + MONTH_DAYS[m] >= day) return { month: m + 1, day: day - acc };
    acc += MONTH_DAYS[m];
  }
  return { month: 12, day: 31 };
}

export const SEASON_LABELS: { label: string; t: number }[] = [
  { label: '春分萌芽', t: monthDayToT(3, 20) },
  { label: '盛夏浓荫', t: monthDayToT(7, 15) },
  { label: '秋色叶期', t: monthDayToT(10, 25) },
  { label: '冬季秃枝', t: monthDayToT(1, 20) },
];
