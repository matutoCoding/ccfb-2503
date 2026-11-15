import * as THREE from 'three';
import type { TreeSpecies } from '../core/types';
import { sampleSeason } from '../core/season';

/**
 * 全局风 uniform（所有植物材质共享）：
 * uTime 驱动正弦风摆，uWind 控制强度，由场景每帧更新。
 */
export interface WindUniforms {
  uTime: { value: number };
  uWind: { value: number };
}

export const windUniforms: WindUniforms = {
  uTime: { value: 0 },
  uWind: { value: 0.3 },
};

/** 每树种一套季节外观（同树种所有实例共享，切换季节只需更新这里） */
export interface SpeciesLook {
  leafColor: THREE.Color;
  flowerColor: THREE.Color;
  foliageDensity: number;
  flowerAmount: number;
}


export function createSpeciesLook(sp: TreeSpecies, seasonT: number): { uniforms: Record<string, THREE.IUniform>; look: SpeciesLook } {
  const s = sampleSeason(sp, seasonT);
  const look: SpeciesLook = {
    leafColor: new THREE.Color(s.leafColor),
    flowerColor: new THREE.Color(sp.flowerColor ?? 0xffffff),
    foliageDensity: sp.leafDensity * s.foliageDensity,
    flowerAmount: sp.flowerColor ? s.flowerAmount : 0,
  };
  const uniforms: Record<string, THREE.IUniform> = {
    uLeafColor: { value: look.leafColor },
    uFlowerColor: { value: look.flowerColor },
    uFoliageDensity: { value: look.foliageDensity },
    uFlowerAmount: { value: look.flowerAmount },
  };
  return { uniforms, look };
}

export function updateSpeciesLook(sp: TreeSpecies, look: SpeciesLook, uniforms: Record<string, THREE.IUniform>, seasonT: number): void {
  const s = sampleSeason(sp, seasonT);
  look.leafColor.set(s.leafColor);
  look.foliageDensity = sp.leafDensity * s.foliageDensity;
  look.flowerAmount = sp.flowerColor ? s.flowerAmount : 0;
  // 显式回写每一个 uniform，不依赖 Color 引用是否共享
  (uniforms.uLeafColor.value as THREE.Color).set(s.leafColor);
  uniforms.uFoliageDensity.value = look.foliageDensity;
  uniforms.uFlowerAmount.value = look.flowerAmount;
}

/* ---------------- 风：顶点着色器注入 ---------------- */

const WIND_GLSL = /* glsl */ `
uniform float uTime;
uniform float uWind;
uniform float uWindPhase;
attribute float aRand;

void treeWind(inout vec3 transformed, in vec3 pos) {
  float heightFactor = clamp(pos.y, 0.0, 1.0);
  float gust = sin(uTime * 1.4 + uWindPhase + pos.y * 1.8) * 0.6
             + sin(uTime * 3.1 + uWindPhase * 1.7) * 0.4;
  float amp = uWind * heightFactor * heightFactor;
  transformed.x += gust * amp * 0.028;
  transformed.z += cos(uTime * 1.1 + uWindPhase) * amp * 0.02;
  // 细枝/叶片额外抖动（aRand 缺省为 0）
  transformed += vec3(
    sin(uTime * 6.0 + pos.x * 20.0 + aRand * 6.2831),
    0.0,
    cos(uTime * 5.2 + pos.z * 20.0 + aRand * 6.2831)
  ) * amp * uWind * 0.006;
}
`;

function injectFoliage(material: THREE.MeshStandardMaterial, uniforms: Record<string, THREE.IUniform>): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms, uniforms);
    shader.uniforms.uWindPhase = { value: material.userData.windPhase ?? 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WIND_GLSL + /* glsl */ `
// aRand 已在 WIND_GLSL 中声明
attribute float aFlower;
varying float vFlower;
varying float vRand;
      `)
      .replace('#include <begin_vertex>', /* glsl */ `
#include <begin_vertex>
vFlower = aFlower;
vRand = aRand;
treeWind(transformed, position);
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `
#include <common>
uniform vec3 uLeafColor;
uniform vec3 uFlowerColor;
uniform float uFoliageDensity;
uniform float uFlowerAmount;
varying float vFlower;
varying float vRand;
      `)
      .replace('#include <color_fragment>', /* glsl */ `
#include <color_fragment>
// 落叶/疏叶：按每顶点随机值丢弃片元，冬季变成通透秃冠
if (vRand > uFoliageDensity) discard;
// 顶点灰度（0.78~1.0）做明暗扰动；叶色整体提亮补偿深色树种与色调映射压暗
float shade = 0.92 + 0.08 * vColor.r;
float fMask = vFlower * uFlowerAmount;
vec3 leaf = uLeafColor * shade;
diffuseColor.rgb = mix(leaf, uFlowerColor, fMask * 0.85);
      `);
  };
  material.customProgramCacheKey = () => 'foliage-wind-v1';
}

function injectBranch(material: THREE.MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms);
    shader.uniforms.uWindPhase = { value: material.userData.windPhase ?? 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WIND_GLSL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\ttreeWind(transformed, position);');
  };
  material.customProgramCacheKey = () => 'branch-wind-v1';
}

/** 树干材质（每树种一个，色调微差） */
export function createBranchMaterial(barkColor: number, windPhase: number): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: barkColor,
    roughness: 0.95,
    metalness: 0,
    envMapIntensity: 0.3,
  });
  mat.userData.windPhase = windPhase;
  injectBranch(mat);
  return mat;
}

/** 树冠材质（每树种一个，随季节更新 uniform） */
export function createFoliageMaterial(
  uniforms: Record<string, THREE.IUniform>,
  windPhase: number,
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    flatShading: true,
    envMapIntensity: 0.35, // 压低天空环境反射，避免深绿叶偏青蓝
  });
  mat.userData.windPhase = windPhase;
  injectFoliage(mat, uniforms);
  return mat;
}

/* ---------------- 公告板（远景 LOD2） ---------------- */

export interface BillboardSet {
  texture: THREE.Texture;
  material: THREE.SpriteMaterial;
}

/**
 * 圆柱公告板（只绕 Y 轴朝向相机），用于远景 LOD。
 * 透明纹理 + 简单风摆，不投影（阴影由高模代理，数量少成本可控）。
 */
export function createBillboardMaterial(texture: THREE.Texture, windPhase: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    alphaTest: 0.35,
    depthWrite: true,
    uniforms: {
      map: { value: texture },
      ...windUniforms,
      uWindPhase: { value: windPhase },
    },
    vertexShader: /* glsl */ `
uniform float uTime;
uniform float uWind;
uniform float uWindPhase;
attribute float aVariant;
varying vec2 vUv;
void main() {
  // 图集横向分块（BILLBOARD_VARIANTS 个变体）
  vUv = vec2(uv.x * (1.0 / 3.0) + aVariant, uv.y);
  vec3 center = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float h = instanceMatrix[1][1];
  vec3 worldUp = vec3(0.0, 1.0, 0.0);
  vec3 toCam = cameraPosition - center;
  toCam.y = 0.0;
  toCam = normalize(toCam);
  vec3 right = normalize(cross(worldUp, toCam));
  float gust = sin(uTime * 1.4 + uWindPhase) * uWind;
  vec3 pos = center + right * position.x * h
           + worldUp * position.y * h;
  pos.xz += right.xz * gust * 0.02 * h * position.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`,
    fragmentShader: /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
void main() {
  vec4 tex = texture2D(map, vUv);
  if (tex.a < 0.35) discard;
  gl_FragColor = tex;
  #include <colorspace_fragment>
}
`,
  });
}

