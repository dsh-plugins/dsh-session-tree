import type { HostAPI, SessionChange, SessionExclusive, SessionsAPI, SessionSnapshot as HostSnapshot } from '@dsh-plugin/dsh-loader';
import { importSession, exportSession, syncSession, retryNode, editUserNode } from './event-codec.js';
import { appendNode, cloneValue, getActivePath, hardRemove, nextNodeId, selectNode, softRewind, type TreeDocument, type TreeNode } from './tree.js';
import { TreeError, treeView, type TreeMutation, type TreeView, type RecalledDraft } from './protocol.js';
import { chooseTransactionRecovery } from './recovery.js';
import { TreeFiles, digest, type OfficialSnapshot, type StoredTree, type CompletedOperation } from './storage.js';

/** API 返回的树状态与本次操作需要执行的客户端刷新。 */
export interface MutationResult {
  value: TreeView;
  draft?: RecalledDraft;
  refresh?: boolean;
}

interface Entry {
  stored: StoredTree;
  persisted: boolean;
}

type Action = 'select' | 'edit' | 'retry' | 'recall';

function snapshot(value: HostSnapshot): OfficialSnapshot {
  const typed = value as unknown as OfficialSnapshot;
  importSession(typed.header, typed.events);
  return typed;
}

function recalledDraft(node: TreeNode): RecalledDraft {
  const content = node.message.content as Record<string, unknown>[];
  return {
    text: content.filter(block => block.type === 'text').map(block => String(block.text ?? '')).join('\n'),
    attachments: cloneValue(content.filter(block => block.type === 'image' || block.type === 'file')),
  };
}

/** 树写入和官方事件订阅共享每会话队列，避免异步回调覆盖用户操作。 */
export class SessionTrees {
  private readonly entries = new Map<string, Entry>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, Error>();
  private readonly sessions: SessionsAPI;
  private readonly stop: () => void;
  private closed = false;

  constructor(loader: HostAPI, readonly files: TreeFiles, private readonly report: (message: string, error: unknown) => void) {
    this.sessions = loader.sessions;
    this.stop = this.sessions.watch(change => this.onChange(change));
  }

  private async ordered<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new TreeError('disposed', '会话树插件已经卸载。', 503);
    }
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(sessionId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.queues.get(sessionId) === tail) {
        this.queues.delete(sessionId);
      }
    }
  }

  private onChange(change: SessionChange): void {
    if (this.closed || change.type === 'error') {
      if (change.type === 'error') {
        this.report(`会话 ${change.sessionId} 的宿主操作失败。`, change.error);
      }
      return;
    }
    void this.ordered(change.sessionId, async () => {
      const current = snapshot(await this.sessions.read(change.sessionId));
      const entry = await this.load(change.sessionId, current);
      await this.synchronize(entry, current, true);
    }).catch(error => {
      this.errors.set(change.sessionId, error instanceof Error ? error : new Error(String(error)));
      this.report(`会话 ${change.sessionId} 的树同步失败。`, error);
    });
  }

  private async load(id: string, current: OfficialSnapshot): Promise<Entry> {
    let entry = this.entries.get(id);
    if (entry) {
      return entry;
    }
    const transaction = await this.files.transaction(id);
    if (transaction) {
      const side = chooseTransactionRecovery(transaction.before, transaction.after, current, transaction.stage);
      await this.files.save(side === 'after' ? transaction.next : transaction.previous);
      await this.files.complete(id);
    }
    const stored = await this.files.read(id);
    entry = {
      stored: stored ?? { version: 1, tree: importSession(current.header, current.events), officialDigest: digest(current), operations: [] },
      persisted: stored !== undefined,
    };
    this.entries.set(id, entry);
    return entry;
  }

  private pending(tree: TreeDocument, operations: CompletedOperation[]): TreeDocument {
    const pending = this.sessions.status(tree.sessionId).pending;
    const next = cloneValue(tree);
    let changed = false;
    const path = getActivePath(next);
    const parentId = path.findLast(node => node.status === 'dispatched')?.id ?? null;
    for (const item of pending) {
      if ((item.message.source as { kind?: string } | undefined)?.kind !== 'user') {
        continue;
      }
      const state = item.state === 'queued' ? 'pending' : 'claimed';
      const existing = Object.values(next.nodes).find(node => node.messageId === item.id);
      if (existing) {
        if (existing.status !== state) {
          existing.status = state;
          changed = true;
        }
        continue;
      }
      const cursor = next.activeNodeId;
      const id = nextNodeId(next, item.id);
      appendNode(next, {
        id, parentId, children: [], selectedChildId: null, role: 'user', messageId: item.id,
        message: cloneValue(item.message), status: state, events: [], messageEventSeq: null,
        ...(parentId === null ? { rootPrefixEvents: cloneValue(next.prefixEvents) } : {}),
      });
      next.activeNodeId = cursor;
      changed = true;
    }
    const actual = new Set(pending.map(item => item.id));
    const unsent = new Set(operations.flatMap(item => !item.cancelled && !item.submitted && item.submission?.kind === 'message' ? [item.submission.message.id] : []));
    const dispatched = new Set(Object.values(next.nodes).filter(node => node.messageEventSeq !== null && !actual.has(node.messageId)).map(node => node.messageId));
    for (const node of Object.values(next.nodes)) {
      if (node.messageEventSeq !== null && !actual.has(node.messageId) && node.status !== 'dispatched') {
        node.status = 'dispatched';
        changed = true;
      } else if (node.messageEventSeq === null && node.children.length === 0
        && (dispatched.has(node.messageId) || (!actual.has(node.messageId) && !unsent.has(node.messageId)))) {
        const updated = hardRemove(next, node.id);
        Object.assign(next, updated);
        changed = true;
      }
    }
    if (changed) {
      next.revision = tree.revision + 1;
    }
    return changed ? next : tree;
  }

  private async synchronize(entry: Entry, current: OfficialSnapshot, persist: boolean): Promise<void> {
    const previous = entry.stored;
    let tree = previous.tree;
    const currentDigest = digest(current);
    if (currentDigest !== previous.officialDigest) {
      tree = syncSession(tree, current.header, current.events);
    }
    tree = this.pending(tree, previous.operations);
    const changed = currentDigest !== previous.officialDigest || tree !== previous.tree;
    if (!changed) {
      return;
    }
    const next: StoredTree = { ...previous, tree, officialDigest: currentDigest };
    if (persist && (entry.persisted || Object.keys(tree.nodes).length > 0)) {
      if (!entry.persisted) {
        await this.files.preserveOriginal(tree.sessionId, current);
      }
      await this.files.save(next);
      entry.persisted = true;
    }
    entry.stored = next;
    this.errors.delete(tree.sessionId);
  }

  async read(sessionId: string): Promise<TreeView> {
    return this.ordered(sessionId, async () => {
      const current = snapshot(await this.sessions.read(sessionId));
      const entry = await this.load(sessionId, current);
      await this.synchronize(entry, current, entry.persisted);
      const error = this.errors.get(sessionId);
      if (error) {
        throw new TreeError('sync-failed', `会话树同步未完成：${error.message}`, 503);
      }
      return treeView(entry.stored.tree, this.sessions.status(sessionId).busy);
    });
  }

  private result(entry: Entry, operation?: CompletedOperation): MutationResult {
    const id = entry.stored.tree.sessionId;
    let draft: RecalledDraft | undefined;
    if (operation?.draft) {
      draft = {
        text: operation.draft.text,
        attachments: operation.draft.attachments.map((block, index) => {
          const ref = block.attachment as Record<string, unknown>;
          return {
            name: typeof ref.name === 'string' ? ref.name : 'image.png',
            mediaType: block.type === 'image' ? ref.mediaType : 'application/octet-stream',
            url: `/_dsh/session-tree/${encodeURIComponent(id)}/draft/${encodeURIComponent(operation.id)}/${index}`,
          };
        }),
      };
    }
    return { value: treeView(entry.stored.tree, this.sessions.status(id).busy), ...(draft ? { draft } : {}), ...(operation?.refresh ? { refresh: true } : {}) };
  }

  async mutate(id: string, action: Action, input: TreeMutation): Promise<MutationResult> {
    return this.ordered(id, async () => {
      const current = snapshot(await this.sessions.read(id));
      const entry = await this.load(id, current);
      await this.synchronize(entry, current, true);
      const fingerprint = digest({ action, nodeId: input.nodeId, content: input.content });
      const completed = entry.stored.operations.find(item => item.id === input.operationId);
      if (completed) {
        if (completed.fingerprint !== fingerprint) {
          throw new TreeError('operation-conflict', '同一操作编号不能用于不同修改。');
        }
        if (completed.submission && !completed.submitted) {
          await this.sessions.runExclusive(id, session => this.submit(entry, completed, session));
        }
        return this.result(entry, completed);
      }
      if (entry.stored.tree.revision !== input.expectedRevision) {
        throw new TreeError('revision-conflict', '会话树已更新，请刷新后重试。');
      }
      const node = entry.stored.tree.nodes[input.nodeId];
      if (!node) {
        throw new TreeError('node-not-found', '消息节点已不存在。', 404);
      }
      if (action === 'recall' && node.role !== 'user') {
        throw new TreeError('invalid-node', '只有用户消息可以撤回。', 400);
      }
      if (action === 'recall' && node.status !== 'dispatched') {
        return this.recallPending(entry, node, input, fingerprint);
      }
      return this.sessions.runExclusive(id, async session => {
        const before = snapshot(await session.read());
        if (digest(before) !== digest(current)) {
          throw new TreeError('revision-conflict', '会话在操作开始前发生变化，请刷新后重试。');
        }
        let nextTree: TreeDocument;
        let after: OfficialSnapshot;
        let message: Record<string, unknown> | undefined;
        if (action === 'select') {
          nextTree = selectNode(entry.stored.tree, input.nodeId);
          after = this.export(nextTree);
        } else if (action === 'recall') {
          nextTree = softRewind(entry.stored.tree, input.nodeId);
          after = this.export(nextTree);
        } else if (action === 'retry') {
          const result = retryNode(entry.stored.tree, input.nodeId);
          nextTree = result.tree;
          after = { header: result.header, events: result.events, inheritedEventCount: result.inheritedEventCount ?? 0 };
        } else {
          if (!input.content || input.content.length === 0 || node.role !== 'user') {
            throw new TreeError('invalid-content', '请输入用户消息内容或添加附件。', 400);
          }
          message = await session.admitEdit(node.message, input.content);
          const result = editUserNode(entry.stored.tree, input.nodeId, message);
          nextTree = result.tree;
          after = { header: result.header, events: result.events, inheritedEventCount: result.inheritedEventCount ?? 0 };
        }
        const operation: CompletedOperation = {
          id: input.operationId, action, fingerprint, revision: nextTree.revision, refresh: true, targetNodeId: nextTree.activeNodeId,
          ...(message ? { submission: { kind: 'message' as const, message }, submitted: false }
            : action === 'retry' ? { submission: { kind: 'retry' as const }, submitted: false } : {}),
        };
        const next: StoredTree = {
          version: 1, tree: nextTree, officialDigest: digest(after), operations: [...entry.stored.operations, operation],
        };
        await this.commit(entry, session, before, after, next);
        await this.submit(entry, operation, session);
        return this.result(entry, operation);
      });
    });
  }

  private async submit(entry: Entry, operation: CompletedOperation, session: SessionExclusive): Promise<void> {
    if (operation.cancelled) {
      throw new TreeError('operation-cancelled', '这次生成操作已撤回。');
    }
    if (!operation.submission || operation.submitted) {
      return;
    }
    if (operation.targetNodeId !== entry.stored.tree.activeNodeId) {
      throw new TreeError('operation-branch-changed', '当前分支已改变，请切回该操作的消息分支后重试。');
    }
    if (operation.submission.kind === 'message') {
      await session.sendMessage(operation.submission.message);
    } else {
      await session.retry(operation.id);
    }
    const next = cloneValue(entry.stored);
    next.operations.find(item => item.id === operation.id)!.submitted = true;
    await this.files.save(next);
    entry.stored = next;
  }

  private export(tree: TreeDocument): OfficialSnapshot {
    const value = exportSession(tree);
    return { ...value, inheritedEventCount: value.inheritedEventCount ?? 0 };
  }

  private async commit(entry: Entry, session: SessionExclusive, before: OfficialSnapshot, after: OfficialSnapshot, next: StoredTree): Promise<void> {
    const id = before.header.id;
    if (!entry.persisted) {
      await this.files.preserveOriginal(id, before);
    }
    const transaction = { version: 1 as const, sessionId: id, stage: 'prepared' as const, before, after, previous: entry.stored, next };
    await this.files.prepare(transaction);
    try {
      await session.replace(after);
      const actual = snapshot(await session.read());
      const cursor = next.tree.activeNodeId;
      next.tree = syncSession(next.tree, actual.header, actual.events);
      if (cursor !== null && next.tree.nodes[cursor]?.status !== 'dispatched') {
        next.tree.activeNodeId = cursor;
      }
      next.officialDigest = digest(actual);
      await this.files.prepare({ ...transaction, after: actual, next, stage: 'official-written' });
      await this.files.save(next);
      await this.files.complete(id);
    } catch (error) {
      this.entries.delete(id);
      this.errors.set(id, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    entry.stored = next;
    entry.persisted = true;
    this.errors.delete(id);
  }

  private async recallPending(entry: Entry, node: TreeNode, input: TreeMutation, fingerprint: string): Promise<MutationResult> {
    const id = entry.stored.tree.sessionId;
    if (node.children.length > 0) {
      throw new TreeError('pending-has-children', '这条消息已有后续分支，请刷新状态后操作。');
    }
    const pending = this.sessions.status(id).pending.some(item => item.id === node.messageId);
    if (pending) {
      await this.sessions.recallPending(id, [node.messageId]);
    } else if (node.messageEventSeq !== null) {
      throw new TreeError('message-dispatched', '消息已发送，请刷新后使用软撤回。');
    }
    const current = snapshot(await this.sessions.read(id));
    const synchronized = syncSession(entry.stored.tree, current.header, current.events);
    const tree = hardRemove(synchronized, node.id);
    const operation: CompletedOperation = {
      id: input.operationId, action: 'recall', fingerprint, revision: tree.revision, draft: recalledDraft(node),
    };
    const operations = entry.stored.operations.map(item => item.submission?.kind === 'message' && item.submission.message.id === node.messageId
      ? { ...item, cancelled: true } : item);
    const next: StoredTree = { version: 1, tree, officialDigest: digest(current), operations: [...operations, operation] };
    if (!entry.persisted) {
      await this.files.preserveOriginal(id, current);
    }
    await this.files.save(next);
    entry.stored = next;
    entry.persisted = true;
    return this.result(entry, operation);
  }

  async draftAttachment(sessionId: string, operationId: string, index: number): Promise<Record<string, unknown>> {
    return this.ordered(sessionId, async () => {
      const stored = this.entries.get(sessionId)?.stored ?? await this.files.read(sessionId);
      const block = stored?.operations.find(operation => operation.id === operationId)?.draft?.attachments[index];
      if (!block || !Number.isSafeInteger(index) || index < 0) {
        throw new TreeError('attachment-not-found', '撤回的附件不存在。', 404);
      }
      return cloneValue(block);
    });
  }

  async dispose(): Promise<void> {
    this.stop();
    this.closed = true;
    await Promise.all([...this.queues.values()]);
  }
}
