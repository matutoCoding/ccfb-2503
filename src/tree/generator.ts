import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, hashString, type Rng } from '../core/rng';
import type { TreeSpecies } from '../core/types';

/** 单位化（成熟态树高=1）的树木模型，实例端按生长比例缩放 */
export interface TreeModel {
  speciesId: string;
  variant: number;
  /** 高模：近景 */
  lodHigh: { branch: THREE.BufferGeometry; foliage: THREE.BufferGeometry };
  /** 低模：中景，分枝/叶团更少、柱面段数更低 */
  lodLow: { branch: THREE.BufferGeometry; foliage: THREE.BufferGeometry };
  barkColor: number;
  /** 归一化后树冠单位半径（×当前树高即米） */
  unitCrownRadius: number;
}

interface BranchSeg {
  start: THREE.Vector3;
  end: THREE.Vector3;
  r0: number;
  r1: number;
  level: number;
}

interface Puff {
  pos: THREE.Vector3;
  scale: THREE.Vector3;
  flower: boolean;
  outer: boolean;
}

interface Skeleton {
  segments: BranchSeg[];
  puffs: Puff[];
  height: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _axis = new THREE.Vector3();

/**
 * 递归分枝骨架。所有随机量均来自注入的 Rng，
 * 相同 (species, seed) 产出逐顶点一致的模型。
 */
function buildSkeleton(sp: TreeSpecies, rng: Rng): Skeleton {
  const segments: BranchSeg[] = [];
  const puffs: Puff[] = [];
  const H = sp.matureHeight;
  const R = sp.crownWidth * 0.5;
  const depth = sp.branchDepth;
  const baseRadius = sp.trunkDbh * 0.005; // cm→m 半径估算

  const lean = new THREE.Vector3(rng.range(-0.06, 0.06), 1, rng.range(-0.06, 0.06)).normalize();

  const grow = (pos: THREE.Vector3, dir: THREE.Vector3, len: number, radius: number, level: number) => {
    const end = pos.clone().addScaledVector(dir, len);
    segments.push({
      start: pos.clone(),
      end,
      r0: radius,
      r1: radius * 0.62,
      level,
    });
    if (level === 0 || len < H * 0.02) {
      puffs.push({
        pos: end.clone(),
        scale: new THREE.Vector3(1, 1, 1),
        flower: !!sp.flowerColor && rng.next() < 0.4,
        outer: true,
      });
      return;
    }
    const childCount = level >= depth - 1 ? rng.int(2, 3) : rng.int(2, 2 + Math.round(sp.branchDensity));
    for (let i = 0; i < childCount; i++) {
      _axis.set(rng.range(-1, 1), rng.range(-0.4, 0.6), rng.range(-1, 1)).normalize();
      const angle = THREE.MathUtils.degToRad(sp.branchAngle * rng.range(0.7, 1.25));
      _q.setFromAxisAngle(_axis, angle);
      const childDir = dir.clone().applyQuaternion(_q).normalize();
      // 阔叶/圆冠型整体向光（向上）收拢，避免枝条平摊
      if (sp.form !== 'weeping') childDir.lerp(UP, 0.18 + rng.next() * 0.15).normalize();
      const childLen = len * rng.range(0.66, 0.78);
      grow(end, childDir, childLen, radius * rng.range(0.55, 0.68), level - 1);
    }
  };

  if (sp.form === 'conifer') {
    // 针叶树：主干通直 + 轮生枝
    const trunkSegs = depth + 3;
    let pos = new THREE.Vector3(0, 0, 0);
    let dir = lean.clone();
    const segLen = H / trunkSegs;
    for (let i = 0; i < trunkSegs; i++) {
      const next = pos.clone().addScaledVector(dir, segLen);
      segments.push({ start: pos.clone(), end: next, r0: baseRadius * (1 - i / (trunkSegs + 2)), r1: baseRadius * (1 - (i + 1) / (trunkSegs + 2)), level: depth });
      // 轮生枝（顶部 1/4 不再出枝）
      if (i >= 1 && i < trunkSegs - 1) {
        const whorl = Math.round(4 + sp.branchDensity * 2);
        const whorlLen = R * (1.1 - i / trunkSegs) * rng.range(0.85, 1.1);
        for (let w = 0; w < whorl; w++) {
          const a = (w / whorl) * Math.PI * 2 + rng.range(-0.2, 0.2);
          const branchDir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a))
            .lerp(UP, Math.cos(THREE.MathUtils.degToRad(sp.branchAngle)))
            .normalize();
          const tip = pos.clone().addScaledVector(branchDir, whorlLen);
          segments.push({ start: pos.clone(), end: tip, r0: baseRadius * 0.32, r1: baseRadius * 0.1, level: depth - 1 });
          // 枝上叶团：拉长椭球
          const blobs = 2 + Math.round(sp.crownFill);
          for (let b = 0; b < blobs; b++) {
            const k = (b + 1) / (blobs + 1);
            const bp = pos.clone().lerp(tip, k);
            puffs.push({
              pos: bp,
              scale: new THREE.Vector3(
                whorlLen / blobs * rng.range(0.9, 1.3),
                whorlLen / blobs * rng.range(0.55, 0.8),
                whorlLen / blobs * rng.range(0.9, 1.3),
              ),
              flower: false,
              outer: b === blobs - 1,
            });
          }
        }
      }
      pos = next;
      dir.lerp(UP, 0.2).normalize();
    }
    puffs.push({ pos: pos.clone(), scale: new THREE.Vector3(R * 0.28, H * 0.12, R * 0.28), flower: false, outer: true });
  } else {
    // 阔叶类：主干分段，侧枝递归
    const trunkSegs = depth + 2;
    let pos = new THREE.Vector3(0, 0, 0);
    let dir = lean.clone();
    const segLen = H / trunkSegs;
    for (let i = 0; i < trunkSegs; i++) {
      const next = pos.clone().addScaledVector(dir, segLen);
      segments.push({
        start: pos.clone(), end: next,
        r0: baseRadius * (1 - i / (trunkSegs + 2)),
        r1: baseRadius * (1 - (i + 1) / (trunkSegs + 2)),
        level: depth,
      });
      // 中下部开始出主枝
      if (i >= 1) {
        const scaffold = sp.form === 'round' ? 3 : 2;
        for (let s = 0; s < scaffold; s++) {
          const a = rng.range(0, Math.PI * 2);
          const fromVertical = THREE.MathUtils.degToRad(sp.branchAngle * rng.range(0.8, 1.2));
          const bdir = new THREE.Vector3(
            Math.sin(fromVertical) * Math.cos(a),
            Math.cos(fromVertical),
            Math.sin(fromVertical) * Math.sin(a),
          );
          const blen = R * rng.range(0.9, 1.25) * (1 - 0.35 * (i / trunkSegs));
          grow(next, bdir, blen, baseRadius * 0.4, depth - 1);
        }
      }
      pos = next;
      dir.lerp(UP, 0.25).normalize();
    }
    // 顶端
    grow(pos, dir.clone(), R * 0.5, baseRadius * 0.4, depth - 1);
  }

  // 垂柳：末梢下垂
  if (sp.form === 'weeping') {
    for (const seg of segments) {
      if (seg.level <= 1) {
        const drop = seg.start.clone().lerp(seg.end, 0.55);
        const droop = drop.clone().add(new THREE.Vector3(
          (seg.end.x - seg.start.x) * 0.25,
          -H * rng.range(0.05, 0.11),
          (seg.end.z - seg.start.z) * 0.25,
        ));
        seg.end.copy(droop);
      }
    }
  }

  // 叶团塑形：收敛到冠幅包络内，并做大小/椭球变化
  const MAX_PUFFS = 180;
  if (puffs.length > MAX_PUFFS) {
    // 确定性抽稀：用 RNG 洗牌后截断（同一骨架永远得到同一子集）
    for (let i = puffs.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [puffs[i], puffs[j]] = [puffs[j], puffs[i]];
    }
    puffs.length = MAX_PUFFS;
  }
  const crownCenterY = H * (sp.form === 'conifer' ? 0.55 : 0.68);
  let centroid = new THREE.Vector3();
  puffs.forEach((p) => centroid.add(p.pos));
  centroid.multiplyScalar(1 / puffs.length);
  let maxR = 1e-6;
  puffs.forEach((p) => {
    const d = Math.hypot(p.pos.x - centroid.x, p.pos.z - centroid.z);
    if (d > maxR) maxR = d;
  });
  const targetR = R * (sp.form === 'conifer' ? 1.05 : 0.95);
  const k = targetR / maxR;
  const basePuff = (R / 7) * sp.crownFill;
  puffs.forEach((p, idx) => {
    p.pos.x = centroid.x + (p.pos.x - centroid.x) * k;
    p.pos.z = centroid.z + (p.pos.z - centroid.z) * k;
    p.pos.y = crownCenterY + (p.pos.y - crownCenterY) * (sp.form === 'conifer' ? 1 : 0.92);
    if (p.scale.x === 1 && p.scale.y === 1) {
      const size = basePuff * rng.range(0.75, 1.25) * (p.outer ? 1 : 0.8);
      p.scale.set(size * rng.range(0.85, 1.2), size * rng.range(0.8, 1.1), size * rng.range(0.85, 1.2));
    }
    // 内部补点：增强密实度
    if (p.outer && sp.crownFill > 1 && idx % 3 === 0) {
      puffs.push({
        pos: p.pos.clone().lerp(centroid, 0.5).add(new THREE.Vector3(rng.range(-1, 1), rng.range(-0.5, 0.5), rng.range(-1, 1)).multiplyScalar(basePuff)),
        scale: p.scale.clone().multiplyScalar(rng.range(0.7, 0.95)),
        flower: false,
        outer: false,
      });
    }
  });

  return { segments, puffs, height: H };
}

const _cylCache = new Map<number, THREE.CylinderGeometry>();
function cylinder(radial: number): THREE.CylinderGeometry {
  let g = _cylCache.get(radial);
  if (!g) {
    g = new THREE.CylinderGeometry(1, 1, 1, radial, 1);
    _cylCache.set(radial, g);
  }
  return g;
}

function buildBranchGeometry(sk: Skeleton, radial: number, levelCut: number, normalize: THREE.Matrix4): THREE.BufferGeometry {
  const geoms: THREE.BufferGeometry[] = [];
  for (const seg of sk.segments) {
    if (seg.level < levelCut) continue;
    const len = seg.start.distanceTo(seg.end);
    if (len < 1e-5) continue;
    const g = cylinder(radial).clone();
    _dir.subVectors(seg.end, seg.start).normalize();
    _pos.copy(seg.start).add(seg.end).multiplyScalar(0.5);
    _q.setFromUnitVectors(UP, _dir);
    _m.compose(_pos, _q, new THREE.Vector3(seg.r1, len, seg.r0));
    g.applyMatrix4(_m);
    geoms.push(g);
  }
  const merged = mergeGeometries(geoms, false)!;
  merged.applyMatrix4(normalize);
  geoms.forEach((g) => g.dispose());
  // 风着色器需要 aRand；枝干无逐顶点随机，统一填 0
  merged.setAttribute('aRand', new THREE.BufferAttribute(new Float32Array(merged.attributes.position.count).fill(0), 1));
  return merged;
}

const _sphereHigh = new THREE.IcosahedronGeometry(1, 0); // 20 面/叶团
const _sphereLow = new THREE.IcosahedronGeometry(1, 0);  // 20 面/叶团

function buildFoliageGeometry(
  sk: Skeleton,
  rng: Rng,
  puffStep: number,
  normalize: THREE.Matrix4,
): THREE.BufferGeometry {
  const baseSphere = _sphereHigh;
  const geoms: THREE.BufferGeometry[] = [];
  const puffList = sk.puffs.filter((_, i) => i % puffStep === 0);
  for (const puff of puffList) {
    const g = baseSphere.clone();
    _m.compose(puff.pos, new THREE.Quaternion(), puff.scale);
    g.applyMatrix4(_m);
    const vcount = g.attributes.position.count;
    const gray = new Float32Array(vcount * 3);
    const flower = new Float32Array(vcount);
    const rand = new Float32Array(vcount);
    const baseShade = rng.range(0.78, 1.0);
    for (let i = 0; i < vcount; i++) {
      const shade = Math.min(1, baseShade * rng.range(0.92, 1.08));
      gray[i * 3] = shade;
      gray[i * 3 + 1] = shade;
      gray[i * 3 + 2] = shade;
      flower[i] = puff.flower ? 1 : 0;
      rand[i] = rng.next();
    }
    g.setAttribute('color', new THREE.BufferAttribute(gray, 3));
    g.setAttribute('aFlower', new THREE.BufferAttribute(flower, 1));
    g.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
    geoms.push(g);
  }
  const merged = mergeGeometries(geoms, false)!;
  merged.applyMatrix4(normalize);
  geoms.forEach((g) => g.dispose());
  return merged;
}

/**
 * 生成一个变体的完整模型（确定性）。
 * 变体几何由「树种种子（树种 id 哈希）+ 变体序号」决定，
 * 场地中每棵树再通过实例级旋转/抖动产生差异，而同变体共享几何。
 */
export function generateTreeModel(sp: TreeSpecies, variant: number, variantCount: number): TreeModel {
  const rng = makeRng(variantSeed(sp), variant);
  const sk = buildSkeleton(sp, rng);

  // 归一化：成熟态树高 → 1，基部对齐 y=0
  const bbox = new THREE.Box3().makeEmpty();
  for (const seg of sk.segments) bbox.expandByPoint(seg.start).expandByPoint(seg.end);
  for (const p of sk.puffs) bbox.expandByPoint(p.pos);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const norm = new THREE.Matrix4().makeScale(1 / size.y, 1 / size.y, 1 / size.y);
  const lift = new THREE.Matrix4().makeTranslation(0, -bbox.min.y / size.y, 0);
  const normalize = new THREE.Matrix4().multiplyMatrices(lift, norm);

  const highBranch = buildBranchGeometry(sk, 4, 1, normalize);
  const highFoliage = buildFoliageGeometry(sk, rng, 1, normalize);
  const lowBranch = buildBranchGeometry(sk, 3, 2, normalize);
  const lowFoliage = buildFoliageGeometry(sk, rng, 3, normalize);

  let maxR = 0;
  for (const p of sk.puffs) {
    const v = p.pos.clone().applyMatrix4(normalize);
    maxR = Math.max(maxR, Math.hypot(v.x, v.z));
  }

  return {
    speciesId: sp.id,
    variant,
    lodHigh: { branch: highBranch, foliage: highFoliage },
    lodLow: { branch: lowBranch, foliage: lowFoliage },
    barkColor: 0x6b5240 + (variant * 0x050403) % 0x101010,
    unitCrownRadius: maxR,
  };
}

/** 每树种共享几何的变体数量（同种每棵树通过实例旋转+微抖动进一步区分） */
export const VARIANT_COUNT = 3;

/** 树种 → 规范种子（树种 id 决定，全生命周期稳定） */
export function variantSeed(sp: TreeSpecies): number {
  // 拼接版本盐值，保证模型算法迭代后旧项目不会悄悄变形
  return hashString(`treegen-v1:${sp.id}`);
}
