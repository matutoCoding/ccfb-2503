/** 全局共享类型定义 */

export type TreeForm = 'broad' | 'conifer' | 'round' | 'weeping';
export type TreeCategory = '落叶乔木' | '常绿乔木' | '针叶树' | '花乔' | '灌木';
export type ZoneType = 'lawn' | 'road' | 'water' | 'paving';
export type QualityLevel = 'low' | 'medium' | 'high';

/** 树种参数（程序化生成 + 苗圃信息） */
export interface TreeSpecies {
  id: string;
  name: string;
  latin: string;
  category: TreeCategory;
  form: TreeForm;
  /** 成年树高 m */
  matureHeight: number;
  /** 成年冠幅 m */
  crownWidth: number;
  /** 胸径（成年估算）cm */
  trunkDbh: number;
  /** 出圃苗高 m */
  saplingHeight: number;
  /** 分枝递归深度 */
  branchDepth: number;
  /** 分枝密度 0.6~1.4 */
  branchDensity: number;
  /** 主分枝倾角（度） */
  branchAngle: number;
  /** 树冠叶团密度 0.5~1.5 */
  crownFill: number;
  /** 叶片密度 0~1 */
  leafDensity: number;
  evergreen: boolean;
  /** 花颜色（hex），无花为 null */
  flowerColor: number | null;
  /** 花期 [起始 phase, 结束 phase]，phase = 日序/365 */
  flowerPhase: [number, number] | null;
  /** 三季叶色 */
  colorSpring: number;
  colorSummer: number;
  colorAutumn: number;
  /** 生长速度系数 0.5(慢) ~ 1.6(快) */
  growthRate: number;
  /** 单价（元/株） */
  cost: number;
  /** 是否用户自定义 */
  custom?: boolean;
}

/** 场地中一棵已种植的树 */
export interface TreeRecord {
  id: number;
  speciesId: string;
  /** 主种子：决定变体、形态变异 */
  seed: number;
  x: number;
  z: number;
  /** 绕 Y 旋转（弧度） */
  rotation: number;
  /** 种植年份（相对项目起始年） */
  plantedYear: number;
}

export interface Vec2 {
  x: number;
  z: number;
}

export interface Zone {
  id: number;
  type: ZoneType;
  name: string;
  points: Vec2[];
}

export interface ProjectSettings {
  /** 项目名称 */
  name: string;
  /** 场地边长 m（正方形） */
  siteSize: number;
  /** 起始年份 */
  startYear: number;
  /** 当前模拟年份（相对起始年的年数） */
  yearOffset: number;
  /** 年相 0~1（0=1月1日） */
  seasonT: number;
  /** 时刻 0~24 小时 */
  hour: number;
  /** 风力 0~1 */
  wind: number;
  quality: QualityLevel;
  /** 间距检查是否按成年冠幅 */
  spacingByMature: boolean;
  /** 阴影开关 */
  shadow: boolean;
}

export interface ProjectData {
  version: 1;
  settings: ProjectSettings;
  trees: TreeRecord[];
  zones: Zone[];
  customSpecies: TreeSpecies[];
  /** 汇报截图（dataURL） */
  snapshots: { id: number; name: string; dataUrl: string; date: string }[];
}

/** 树种在某个年相下的外观采样结果 */
export interface SeasonSample {
  leafColor: number;
  /** 叶量 0.08~1（冬季落叶树接近秃枝） */
  foliageDensity: number;
  /** 开花程度 0~1 */
  flowerAmount: number;
}

/** 间距检查结果 */
export interface SpacingIssue {
  treeId: number;
  /** 与之冲突的树 id（取最近的一棵） */
  otherId: number;
  distance: number;
  required: number;
}
