/**
 * 确定性随机数工具 —— 全项目树木生成只允许使用这里的 RNG，
 * 禁止使用 Math.random()，保证「同一个种子生成的树一模一样」。
 */

/** 32 位整数哈希（Thomas Wang 变体），输出无符号整数 */
export function hashInt32(x: number): number {
  x = x | 0;
  x = (x ^ 61) ^ (x >>> 16);
  x = Math.imul(x, 9);
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return x >>> 0;
}

/** 字符串 → 32 位哈希 */
export function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG，返回 [0,1) 浮点 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  next: () => number;
  /** [min, max) */
  range: (min: number, max: number) => number;
  /** 整数 [min, max] */
  int: (min: number, max: number) => number;
  /** 正态-ish（两次均匀分布平均），范围约 [-1,1] */
  gauss: () => number;
  pick: <T>(arr: readonly T[]) => T;
}

export function makeRng(seed: number, salt = 0): Rng {
  const next = mulberry32(hashInt32(seed ^ hashInt32(salt + 1)));
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    gauss: () => next() * 0.5 + next() * 0.5 - 0.5,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}
