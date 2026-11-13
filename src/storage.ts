import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseTreeDocument, type TreeDocument, type SessionEvent, type SessionHeader } from './tree.js';
import { TreeError, type RecalledDraft } from './protocol.js';

/** 官方日志与树提交共同保存的可重放快照。 */
export interface OfficialSnapshot {
  header: SessionHeader;
  events: SessionEvent[];
  inheritedEventCount: number;
}

/** 幂等操作记录只保存结果身份，不复制整棵树。 */
export interface CompletedOperation {
  id: string;
  action: string;
  fingerprint: string;
  revision: number;
  draft?: RecalledDraft;
  refresh?: boolean;
  submission?: { kind: 'message'; message: Record<string, unknown> } | { kind: 'retry' };
  submitted?: boolean;
  cancelled?: boolean;
  targetNodeId?: string | null;
}

/** 独立树文件同时记录最后一次与官方日志一致的摘要。 */
export interface StoredTree {
  version: 1;
  tree: TreeDocument;
  officialDigest: string;
  operations: CompletedOperation[];
}

/** 恢复时用精确摘要判断官方日志停在提交的哪一侧。 */
export interface TreeTransaction {
  version: 1;
  sessionId: string;
  stage: 'prepared' | 'official-written';
  before: OfficialSnapshot;
  after: OfficialSnapshot;
  previous: StoredTree;
  next: StoredTree;
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** 对 JSON 数据生成稳定摘要，字段顺序不改变会话身份。 */
export function digest(value: unknown): string {
  const stable = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      return item.map(stable);
    }
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)]));
    }
    return item;
  };
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

async function readJson(path: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (missing(error)) {
      return undefined;
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`树存储文件不是有效 JSON：${path}`, { cause: error });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseStored(value: unknown, sessionId: string): StoredTree {
  if (!record(value) || value.version !== 1 || typeof value.officialDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.officialDigest) || !Array.isArray(value.operations)) {
    throw new TreeError('corrupt-tree', '树存储文件的格式或摘要无效。', 500);
  }
  const tree = parseTreeDocument(value.tree);
  if (tree.sessionId !== sessionId) {
    throw new TreeError('session-mismatch', '树存储文件的会话身份不匹配。', 500);
  }
  for (const operation of value.operations) {
    if (!record(operation) || typeof operation.id !== 'string' || typeof operation.action !== 'string'
      || typeof operation.fingerprint !== 'string' || !Number.isSafeInteger(operation.revision)) {
      throw new TreeError('corrupt-tree', '树存储文件的操作记录无效。', 500);
    }
  }
  return { version: 1, tree, officialDigest: value.officialDigest, operations: value.operations as CompletedOperation[] };
}

function parseSnapshot(value: unknown, sessionId: string): OfficialSnapshot {
  if (!record(value) || !record(value.header) || value.header.id !== sessionId
    || !Array.isArray(value.events) || !Number.isSafeInteger(value.inheritedEventCount)) {
    throw new TreeError('corrupt-transaction', '树事务中的官方会话快照无效。', 500);
  }
  return value as unknown as OfficialSnapshot;
}

/** 每个会话拥有独立文件；调用方按会话串行提交与恢复。 */
export class TreeFiles {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(sessionId: string, suffix: string): string {
    if (sessionId.length === 0 || sessionId.length > 512) {
      throw new TreeError('invalid-session', '会话 ID 无效。', 400);
    }
    return join(this.root, `${createHash('sha256').update(sessionId).digest('hex')}${suffix}`);
  }

  private async atomic(path: string, value: unknown): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(cleanup => {
        throw new AggregateError([error, cleanup], `无法提交或清理树文件：${path}`);
      });
      throw error;
    }
  }

  async read(sessionId: string): Promise<StoredTree | undefined> {
    const value = await readJson(this.path(sessionId, '.json'));
    return value === undefined ? undefined : parseStored(value, sessionId);
  }

  async save(value: StoredTree): Promise<void> {
    parseStored(value, value.tree.sessionId);
    await this.atomic(this.path(value.tree.sessionId, '.json'), value);
  }

  async preserveOriginal(sessionId: string, snapshot: OfficialSnapshot): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const path = this.path(sessionId, '.original.json');
    let file;
    try {
      file = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        parseSnapshot(await readJson(path), sessionId);
        return;
      }
      throw error;
    }
    try {
      await file.writeFile(`${JSON.stringify(snapshot)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async prepare(transaction: TreeTransaction): Promise<void> {
    await this.atomic(this.path(transaction.sessionId, '.transaction.json'), transaction);
  }

  async transaction(sessionId: string): Promise<TreeTransaction | undefined> {
    const value = await readJson(this.path(sessionId, '.transaction.json'));
    if (value === undefined) {
      return undefined;
    }
    if (!record(value) || value.version !== 1 || value.sessionId !== sessionId
      || (value.stage !== 'prepared' && value.stage !== 'official-written')) {
      throw new TreeError('corrupt-transaction', '树事务文件的身份或版本无效。', 500);
    }
    return {
      version: 1, sessionId, stage: value.stage,
      before: parseSnapshot(value.before, sessionId), after: parseSnapshot(value.after, sessionId),
      previous: parseStored(value.previous, sessionId), next: parseStored(value.next, sessionId),
    };
  }

  async complete(sessionId: string): Promise<void> {
    const path = this.path(sessionId, '.transaction.json');
    try {
      await unlink(path);
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
    }
  }
}
