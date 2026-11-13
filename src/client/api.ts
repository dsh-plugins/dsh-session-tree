import type { SessionClient, SessionDraftAttachment, SessionPromptPart, SessionRestoredAttachment } from '@dsh-plugin/dsh-loader/client';
import type { TreeView } from '../protocol.js';
export type { TreeView } from '../protocol.js';
export type TreeNode = TreeView['nodes'][string];

/** 原位编辑内容由会话持有，切换分支和组件重挂载后仍可继续编辑。 */
export interface MessageDraft {
  text: string;
  retained: readonly number[];
  attachments: readonly SessionDraftAttachment[];
  source: readonly Record<string, unknown>[];
  sending: boolean;
  error?: string;
}

/** 硬撤回返回的完整草稿，在恢复成功前保留在客户端。 */
export interface RecalledDraft {
  text: string;
  attachments: readonly SessionRestoredAttachment[];
}

interface TreeResponse {
  ok: true;
  value: TreeView;
  draft?: RecalledDraft;
  refresh?: boolean;
}
interface TreeFailure {
  ok: false;
  error: { code: string; message: string };
}

/** 同一会话共享一次轮询、操作状态和待恢复草稿。 */
export interface TreeState {
  tree?: TreeView;
  running: boolean;
  mutating: boolean;
  error?: string;
  draft?: RecalledDraft;
  restoring: boolean;
  edits: Readonly<Record<string, MessageDraft>>;
}

/** 挂载期间订阅官方 busy 状态，并仅在页面可见时刷新树数据。 */
export class TreeStore {
  private state: TreeState = { running: false, mutating: false, restoring: false, edits: {} };
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | undefined;
  private stopSession: (() => void) | undefined;
  private generation = 0;
  private closed = false;
  private readonly pendingOperations = new Map<string, string>();

  constructor(readonly sessionId: string, private readonly client: SessionClient) {}

  getSnapshot = (): TreeState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      const session = this.client.session(this.sessionId);
      const update = () => { this.update({ running: session.getSnapshot().running }); };
      this.stopSession = session.subscribe(update);
      update();
      document.addEventListener('visibilitychange', this.onVisibility);
      void this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  };

  private update(patch: Partial<TreeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }

  private onVisibility = (): void => {
    this.abort?.abort();
    clearTimeout(this.timer);
    if (!document.hidden) {
      void this.refresh();
    }
  };

  private async request(action?: string, body?: unknown, signal?: AbortSignal): Promise<TreeResponse> {
    const endpoint = `/_dsh/session-tree/${encodeURIComponent(this.sessionId)}${action ? `/${action}` : ''}`;
    const response = await fetch(endpoint, {
      method: action ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      ...(action ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const result = await response.json() as TreeResponse | TreeFailure;
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    if (!response.ok || result.value.sessionId !== this.sessionId) {
      throw new Error(`会话树请求失败（${response.status}）。`);
    }
    return result;
  }

  private async refresh(): Promise<void> {
    if (this.closed || document.hidden || this.listeners.size === 0 || this.state.mutating) {
      return;
    }
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const generation = this.generation;
    try {
      const result = await this.request(undefined, undefined, abort.signal);
      if (!abort.signal.aborted && generation === this.generation) {
        this.update({ tree: result.value });
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.update({ error: errorText(error) });
      }
    } finally {
      if (this.abort === abort) {
        this.abort = undefined;
        if (!this.closed && this.listeners.size > 0 && !document.hidden) {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => { void this.refresh(); }, 1500);
        }
      }
    }
  }

  async mutate(action: 'select' | 'edit' | 'retry' | 'recall', nodeId: string, content?: readonly SessionPromptPart[]): Promise<void> {
    const tree = this.state.tree;
    if (!tree || this.state.mutating || this.state.restoring) {
      const error = new Error('会话树正在更新，请稍后重试。');
      this.update({ error: error.message });
      throw error;
    }
    const status = tree.nodes[nodeId]?.status;
    const pendingRecall = action === 'recall' && (status === 'pending' || status === 'claimed');
    if ((tree.busy || this.state.running) && !pendingRecall) {
      const error = new Error('请先手动停止生成，或等待当前生成完成。');
      this.update({ error: error.message });
      throw error;
    }
    const operationKey = JSON.stringify([action, nodeId, content ?? null]);
    const operationId = this.pendingOperations.get(operationKey) ?? crypto.randomUUID();
    this.pendingOperations.set(operationKey, operationId);
    this.generation += 1;
    this.abort?.abort();
    clearTimeout(this.timer);
    this.update({ mutating: true, error: undefined });
    try {
      const result = await this.request(action, {
        expectedRevision: tree.revision,
        operationId,
        nodeId,
        ...(content ? { content } : {}),
      });
      this.pendingOperations.delete(operationKey);
      const previousDraft = this.state.draft;
      const draft = result.draft && previousDraft ? {
        text: [previousDraft.text, result.draft.text].filter(Boolean).join('\n\n'),
        attachments: [...previousDraft.attachments, ...result.draft.attachments],
      } : result.draft;
      this.update({ tree: result.value, ...(draft ? { draft } : {}) });
      if (result.draft) {
        await this.restoreDraft();
      }
      if (result.refresh) {
        await this.client.refreshHistory(this.sessionId);
      }
    } catch (error) {
      this.update({ error: errorText(error) });
      throw error;
    } finally {
      this.update({ mutating: false });
      void this.refresh();
    }
  }

  async restoreDraft(): Promise<void> {
    const draft = this.state.draft;
    if (!draft || this.state.restoring) {
      return;
    }
    this.update({ restoring: true });
    try {
      await this.client.restoreDraft(this.sessionId, draft);
      this.update({ draft: undefined, error: undefined });
    } catch (error) {
      this.update({ error: errorText(error) });
    } finally {
      this.update({ restoring: false });
    }
  }

  beginEdit(nodeId: string, content: readonly Record<string, unknown>[]): void {
    if (this.state.edits[nodeId]) {
      return;
    }
    this.update({ edits: { ...this.state.edits, [nodeId]: {
      text: content.filter(block => block.type === 'text').map(block => String(block.text ?? '')).join('\n'),
      retained: content.flatMap((block, index) => block.type === 'text' ? [] : [index]),
      attachments: [],
      source: content,
      sending: false,
    } } });
  }

  updateEdit(nodeId: string, patch: Partial<MessageDraft>): void {
    const previous = this.state.edits[nodeId];
    if (previous) {
      this.update({ edits: { ...this.state.edits, [nodeId]: { ...previous, ...patch } } });
    }
  }

  closeEdit(nodeId: string): void {
    const previous = this.state.edits[nodeId];
    if (!previous) {
      return;
    }
    for (const attachment of previous.attachments) {
      this.client.releaseAttachment(attachment.id);
    }
    const edits = { ...this.state.edits };
    delete edits[nodeId];
    this.update({ edits });
  }

  dismissError(): void {
    this.update({ error: undefined });
  }

  private stop(): void {
    this.abort?.abort();
    clearTimeout(this.timer);
    this.stopSession?.();
    this.stopSession = undefined;
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  dispose(): void {
    this.closed = true;
    this.stop();
    for (const draft of Object.values(this.state.edits)) {
      for (const attachment of draft.attachments) {
        this.client.releaseAttachment(attachment.id);
      }
    }
    this.listeners.clear();
  }
}

/** 显示业务错误并保留调用失败的上下文。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
