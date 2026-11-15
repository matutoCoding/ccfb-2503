import type { ProjectData, ProjectSettings } from './types';
import { BUILTIN_SPECIES } from './species';

const AUTOSAVE_KEY = 'nursery-preview:project:auto';
const SLOTS_KEY = 'nursery-preview:slots';
const VERSION = 1 as const;

export const DEFAULT_SETTINGS: ProjectSettings = {
  name: '未命名方案',
  siteSize: 100,
  startYear: 2026,
  yearOffset: 0,
  seasonT: 0.55,
  hour: 10,
  wind: 0.3,
  quality: 'medium',
  spacingByMature: false,
  shadow: true,
};

export function defaultProject(): ProjectData {
  return {
    version: VERSION,
    settings: { ...DEFAULT_SETTINGS },
    trees: [],
    zones: [],
    customSpecies: [],
    snapshots: [],
  };
}

/** localStorage 容量保护：截图可能较大，超限自动丢弃最旧的 */
function safeSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function saveProject(data: ProjectData): boolean {
  return safeSet(AUTOSAVE_KEY, JSON.stringify(data));
}

export function loadProject(): ProjectData {
  const raw = localStorage.getItem(AUTOSAVE_KEY);
  if (!raw) return defaultProject();
  try {
    const parsed = JSON.parse(raw) as ProjectData;
    return migrate(parsed);
  } catch {
    return defaultProject();
  }
}

function migrate(data: ProjectData): ProjectData {
  // 合并默认值，防止旧存档缺字段
  const base = defaultProject();
  return {
    version: VERSION,
    settings: { ...base.settings, ...data.settings },
    trees: data.trees ?? [],
    zones: data.zones ?? [],
    customSpecies: data.customSpecies ?? [],
    snapshots: data.snapshots ?? [],
  };
}

/* ---------------- 命名存档槽 ---------------- */

interface SlotMeta { id: string; name: string; updated: string }

export function listSlots(): SlotMeta[] {
  try {
    return JSON.parse(localStorage.getItem(SLOTS_KEY) ?? '[]') as SlotMeta[];
  } catch {
    return [];
  }
}

export function saveToSlot(data: ProjectData, slotId: string, name: string): void {
  const meta = listSlots().filter((s) => s.id !== slotId);
  meta.unshift({ id: slotId, name, updated: new Date().toISOString() });
  localStorage.setItem(SLOTS_KEY, JSON.stringify(meta.slice(0, 20)));
  safeSet(`nursery-preview:slot:${slotId}`, JSON.stringify(data));
}

export function loadFromSlot(slotId: string): ProjectData | null {
  const raw = localStorage.getItem(`nursery-preview:slot:${slotId}`);
  if (!raw) return null;
  try {
    return migrate(JSON.parse(raw) as ProjectData);
  } catch {
    return null;
  }
}

export function deleteSlot(slotId: string): void {
  localStorage.setItem(SLOTS_KEY, JSON.stringify(listSlots().filter((s) => s.id !== slotId)));
  localStorage.removeItem(`nursery-preview:slot:${slotId}`);
}

/* ---------------- 文件导入导出 ---------------- */

export function exportProjectFile(data: ProjectData): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${data.settings.name || '苗木方案'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importProjectFile(file: File): Promise<ProjectData> {
  return file.text().then((text) => migrate(JSON.parse(text) as ProjectData));
}

/** 导出全部树种（含内置）的参数 JSON，供跨项目复用 */
export function exportSpeciesLibrary(custom: ProjectData['customSpecies']): void {
  const blob = new Blob([JSON.stringify({ builtin: BUILTIN_SPECIES, custom }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '苗木树种库.json';
  a.click();
  URL.revokeObjectURL(url);
}
