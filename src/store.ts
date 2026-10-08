import type { SummaryResult } from "./types";

/** 缓存：JSON 文件，存放在 Zotero 数据目录下 */
const FILE_NAME = "paperpilot-cache.json";
const MAX_ENTRIES = 500;

interface CacheEntry {
  key: string;
  title: string;
  result: SummaryResult;
  createdAt: number;
  model: string;
}

let cacheFile: string | null = null;
let memory: Record<string, CacheEntry> = {};
let loaded = false;

async function getCacheFile(): Promise<string> {
  if (cacheFile) return cacheFile;
  const dir = Zotero.DataDirectory ? Zotero.DataDirectory.dir : Zotero.getZoteroDirectory().path;
  const file: string = PathUtils.join(dir, FILE_NAME);
  cacheFile = file;
  return file;
}

async function load(): Promise<void> {
  if (loaded) return;
  const file = await getCacheFile();
  try {
    if (await IOUtils.exists(file)) {
      const text = await IOUtils.readUTF8(file);
      memory = JSON.parse(text || "{}");
    }
  } catch (e) {
    Zotero.debug("[PaperPilot] 缓存读取失败，使用空缓存: " + e);
    memory = {};
  }
  loaded = true;
}

async function persist(): Promise<void> {
  const file = await getCacheFile();
  try {
    // 超出上限时按时间淘汰
    const keys = Object.keys(memory);
    if (keys.length > MAX_ENTRIES) {
      keys
        .sort((a, b) => (memory[a].createdAt || 0) - (memory[b].createdAt || 0))
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach((k) => delete memory[k]);
    }
    await IOUtils.writeUTF8(file, JSON.stringify(memory));
  } catch (e) {
    Zotero.debug("[PaperPilot] 缓存写入失败: " + e);
  }
}

/** 缓存键：条目 key + 文件大小 + 修改时间（文件更新后自动失效） */
export async function makeKey(item: any): Promise<string> {
  try {
    const path = await item.getFilePathAsync();
    if (path) {
      const stat = await IOUtils.stat(path);
      return `v2:${item.key}:${stat.size}:${stat.lastModified}`;
    }
  } catch (e) {
    /* 非文件附件 */
  }
  return `${item.key}:v${item.version}`;
}

export async function getCache(key: string): Promise<SummaryResult | null> {
  await load();
  return memory[key]?.result || null;
}

export async function setCache(
  key: string,
  title: string,
  model: string,
  result: SummaryResult
): Promise<void> {
  await load();
  memory[key] = { key, title, result, createdAt: Date.now(), model };
  await persist();
}

export async function clearCache(): Promise<number> {
  await load();
  const n = Object.keys(memory).length;
  memory = {};
  await persist();
  return n;
}
