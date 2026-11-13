import * as React from 'react';
import { createPortal } from 'react-dom';
import { getSessionClient, SESSION_CLIENT_SERVICE, Scrollbar, type SessionClient, type SessionMessageProps, type SessionPromptPart } from '@dsh-plugin/dsh-loader/client';
import { TreeStore, errorText, type MessageDraft, type TreeNode, type TreeState } from './api.js';
import styleText from './style.css';

export const name = '@dsh-plugin/dsh-session-tree';
export const inject = ['dshLoaderUi', SESSION_CLIENT_SERVICE, 'slots', 'sessions', 'conversation', 'connection'];

interface ClientContext {
  get(name: string): unknown;
  effect(effect: () => (() => void)): unknown;
}

/** 将消息树交互注册到 loader 的会话扩展接口。 */
export function apply(ctx: ClientContext): void {
  const client = getSessionClient(ctx);
  if (!client) {
    throw new Error('会话树需要 loader 在官方 Chat 初始化前安装会话扩展，请检查插件加载顺序。');
  }
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = name;
    style.textContent = styleText;
    document.head.appendChild(style);
    return () => { style.remove(); };
  });
  const stores = new Map<string, TreeStore>();
  function storeFor(sessionId: string): TreeStore {
    let store = stores.get(sessionId);
    if (!store) {
      store = new TreeStore(sessionId, client!);
      stores.set(sessionId, store);
    }
    return store;
  }
  function useTree(sessionId: string): [TreeStore, TreeState] {
    const store = storeFor(sessionId);
    return [store, React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)];
  }
  function Message(props: SessionMessageProps): React.ReactElement {
    const [store, state] = useTree(props.sessionId);
    const node = Object.values(state.tree?.nodes ?? {}).find(item => item.messageId === props.messageId);
    const draft = node && state.edits[node.id];
    const editButton = React.useRef<HTMLButtonElement>(null);
    const restoreEditFocus = React.useRef(false);
    React.useLayoutEffect(() => {
      if (!draft && restoreEditFocus.current) {
        restoreEditFocus.current = false;
        editButton.current?.focus();
      }
    }, [draft]);
    const disabled = state.mutating || state.running || state.tree?.busy === true;
    return <div className={`dsh-tree-message${node && props.role === 'user' && !draft ? ' dsh-tree-message-user' : ''}`} data-tree-message-id={props.messageId}>
      {draft && node ? <InlineEditor client={client!} store={store} node={node} draft={draft}
        disabled={disabled} onClose={() => { restoreEditFocus.current = true; store.closeEdit(node.id); }} /> : props.original}
      {node && props.role === 'user' && !draft && <div className="dsh-tree-actions">
        <button type="button" ref={editButton} disabled={disabled} aria-label="编辑消息" title={disabled ? busyHint : '编辑并创建同级分支'} onClick={() => { store.beginEdit(node.id, props.content); }}><Icon kind="edit" /></button>
        <RecallButton store={store} state={state} node={node} />
        <Branches store={store} state={state} node={node} />
      </div>}
    </div>;
  }
  function AssistantActions({ sessionId, messageId }: { sessionId: string; messageId: string }): React.ReactNode {
    const [store, state] = useTree(sessionId);
    const node = Object.values(state.tree?.nodes ?? {}).find(item => item.messageId === messageId);
    if (!node) {
      return null;
    }
    const disabled = state.mutating || state.running || state.tree?.busy === true;
    return <span className="dsh-tree-actions dsh-tree-assistant-actions">
      <Branches store={store} state={state} node={node} />
      <button type="button" disabled={disabled} aria-label="重试回答" title={disabled ? busyHint : '保留当前回答并生成同级回答'}
        onClick={() => { run(store.mutate('retry', node.id)); }}><Icon kind="retry" /></button>
    </span>;
  }
  function Dock({ sessionId }: { sessionId: string }): React.ReactNode {
    const [store, state] = useTree(sessionId);
    const pending = Object.values(state.tree?.nodes ?? {}).filter(node => node.role === 'user' && (node.status === 'pending' || node.status === 'claimed'));
    return <div className="dsh-tree-dock">
      {state.tree?.activeNodeId === null && state.tree.rootChildren.length > 0 && <div className="dsh-tree-recovery">
        <span>历史分支已保留，可从消息树恢复。</span>
        <TreeLauncher store={store} state={state} label="恢复历史分支" />
      </div>}
      {pending.length > 0 && <div className="dsh-tree-pending" aria-label="待发消息">
        {pending.map(node => <div key={node.id} className="dsh-tree-pending-row">
          <span title={nodeText(node)}>待发送：{nodeText(node) || '附件消息'}</span>
          <RecallButton store={store} state={state} node={node} />
        </div>)}
      </div>}
      {state.error && <div className="dsh-tree-error" role="alert">
        <span>{state.error}</span><button type="button" onClick={() => { store.dismissError(); }} aria-label="关闭错误提示">×</button>
      </div>}
      {state.draft && <div className="dsh-tree-recovery" role="status">
        <span>已撤回消息，草稿与 {state.draft.attachments.length} 个附件等待恢复。</span>
        <button type="button" disabled={state.restoring} onClick={() => { void store.restoreDraft(); }}>{state.restoring ? '恢复中…' : '恢复到输入框'}</button>
      </div>}
    </div>;
  }
  function Header({ sessionId }: { sessionId: string }): React.ReactNode {
    const [store, state] = useTree(sessionId);
    return <span className="dsh-tree-header">
      <TreeLauncher store={store} state={state} />
    </span>;
  }
  const release = [
    client.registerMessageExtension({ id: name, Message, forkedTurnLabels: { label: '分支前的处理记录', duration: '分支前的处理记录，用时 ' } }),
    client.registerAssistantActions(name, AssistantActions),
    client.registerComposerDock(name, Dock),
    client.registerHeaderAction(name, Header),
  ];
  ctx.effect(() => () => {
    for (const off of release.reverse()) {
      off();
    }
    for (const store of stores.values()) {
      store.dispose();
    }
  });
}

const busyHint = '请先手动停止生成，或等待当前生成完成';

function Icon({ kind }: { kind: 'edit' | 'retry' | 'recall' | 'tree' | 'previous' | 'next' }): React.ReactElement {
  const paths = {
    previous: 'M13 5 7 11l6 6',
    next: 'm9 5 6 6-6 6',
    edit: 'M12 4 16 8 M3 13 2 18 7 17 18 6 14 2 3 13Z',
    retry: 'M17 7a7 7 0 1 0 0 7 M17 2v5h-5',
    recall: 'M8 4 3 9l5 5 M3 9h9a5 5 0 0 1 0 10',
    tree: 'M5 3v14 M5 7h10 M5 15h10 M15 5v4 M15 13v4',
  };
  return <svg width="16" height="16" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}

function run(operation: Promise<unknown>): void {
  // TreeStore 已将操作错误发布到当前会话的可见提示中。
  void operation.catch(() => undefined);
}

function TreeLauncher({ store, state, label }: { store: TreeStore; state: TreeState; label?: string }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  return <>
    <button type="button" ref={trigger} onClick={() => { setOpen(true); }} aria-haspopup="dialog" aria-label={label ?? '消息树'} title={label ?? '消息树'}>
      {label ?? <Icon kind="tree" />}
    </button>
    {open && createPortal(<TreeDialog store={store} state={state} onClose={() => { setOpen(false); trigger.current?.focus(); }} />, document.body)}
  </>;
}

function RecallButton({ store, state, node }: { store: TreeStore; state: TreeState; node: TreeNode }): React.ReactElement {
  const pending = node.status === 'pending' || node.status === 'claimed';
  const disabled = state.mutating || state.restoring || (!pending && (state.running || state.tree?.busy === true));
  return <button type="button" disabled={disabled} aria-label={pending ? '撤回待发消息' : '撤回消息'} title={disabled ? busyHint : pending ? '阻止这条待发消息发送，并恢复到输入框' : '将当前分支回退到父节点，保留原消息'}
    onClick={() => { run(store.mutate('recall', node.id)); }}><Icon kind="recall" /></button>;
}

function Branches({ store, state, node }: { store: TreeStore; state: TreeState; node: TreeNode }): React.ReactNode {
  const tree = state.tree;
  const childrenIds = node.parentId === null ? tree?.rootChildren ?? [] : tree?.nodes[node.parentId]?.children ?? [];
  const index = childrenIds.indexOf(node.id);
  if (childrenIds.length < 2 || index < 0) {
    return null;
  }
  const disabled = state.mutating || state.running || state.tree?.busy === true;
  const select = (next: number) => {
    const id = childrenIds[next];
    if (id) {
      run(store.mutate('select', id));
    }
  };
  return <nav className="dsh-tree-branches" aria-label={node.role === 'user' ? '用户消息版本' : '回答版本'}>
    <button type="button" aria-label="上一个分支" disabled={disabled || index <= 0} title={disabled ? busyHint : '上一个分支'} onClick={() => { select(index - 1); }}><Icon kind="previous" /></button>
    <span aria-live="polite">{index + 1} / {childrenIds.length}</span>
    <button type="button" aria-label="下一个分支" disabled={disabled || index >= childrenIds.length - 1} title={disabled ? busyHint : '下一个分支'} onClick={() => { select(index + 1); }}><Icon kind="next" /></button>
  </nav>;
}

function InlineEditor({ client, store, node, draft, disabled, onClose }: {
  client: SessionClient; store: TreeStore; node: TreeNode; draft: MessageDraft; disabled: boolean; onClose(): void;
}): React.ReactElement {
  const { text, retained, attachments, source, sending, error } = draft;
  const setError = (value: string | undefined) => { store.updateEdit(node.id, { error: value }); };
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  const picker = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    textarea.current?.focus();
  }, []);
  React.useLayoutEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = 'auto';
      textarea.current.style.height = `${textarea.current.scrollHeight}px`;
    }
  }, [text]);
  function add(files: readonly File[]): void {
    if (disabled || sending) {
      return;
    }
    try {
      const added = client.createAttachments(store.sessionId, files);
      store.updateEdit(node.id, { attachments: [...attachments, ...added] });
      setError(undefined);
    } catch (cause) {
      setError(errorText(cause));
    }
  }
  function remove(id: string): void {
    client.releaseAttachment(id);
    store.updateEdit(node.id, { attachments: attachments.filter(item => item.id !== id) });
  }
  async function send(): Promise<void> {
    if (disabled || sending || (!text.trim() && retained.length === 0 && attachments.length === 0)) {
      return;
    }
    store.updateEdit(node.id, { sending: true, error: undefined });
    try {
      const added = await client.serializeAttachments(attachments.map(item => item.id));
      const parts: SessionPromptPart[] = [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...retained.map(index => ({ type: 'retained' as const, index })),
        ...added,
      ];
      await store.mutate('edit', node.id, parts);
      store.closeEdit(node.id);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      store.updateEdit(node.id, { sending: false });
    }
  }
  const locked = disabled || sending;
  return <div className="dsh-tree-editor" role="group" aria-label="编辑消息" onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      if (!sending) {
        onClose();
      }
    }
  }}>
    <Scrollbar className="dsh-tree-editor-scroll">
      <textarea ref={textarea} value={text} rows={3} disabled={locked} aria-label="消息内容" placeholder="编辑消息内容"
        onChange={event => { store.updateEdit(node.id, { text: event.target.value }); }}
        onPaste={event => {
          if (event.clipboardData.files.length > 0) {
            event.preventDefault();
            add(Array.from(event.clipboardData.files));
          }
        }}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
          }
        }} />
      <div className="dsh-tree-attachments">
        {retained.map(index => {
          const ordinal = source.slice(0, index + 1).filter(block => block.type !== 'text').length;
          const label = `原附件 ${ordinal}：${attachmentName(source[index]!)}`;
          return <span className="dsh-tree-attachment" key={`retained:${index}`}>
            <span title={label}>{label}</span>
            <button type="button" disabled={locked} aria-label={`移除${label}`} onClick={() => { store.updateEdit(node.id, { retained: retained.filter(item => item !== index) }); }}>×</button>
          </span>;
        })}
        {attachments.map(attachment => <span className="dsh-tree-attachment" key={attachment.id}>
          {attachment.previewUrl && <img src={attachment.previewUrl} alt="" />}
          <span>{attachment.file.name}</span>
          <button type="button" disabled={locked} aria-label={`移除${attachment.file.name}`} onClick={() => { remove(attachment.id); }}>×</button>
        </span>)}
      </div>
    </Scrollbar>
    {error && <div className="dsh-tree-error" role="alert">{error}</div>}
    <div className="dsh-tree-editor-controls">
      <input type="file" hidden multiple ref={picker} disabled={locked} onChange={event => {
        add(Array.from(event.target.files ?? []));
        event.target.value = '';
      }} />
      <button type="button" disabled={locked} onClick={() => { picker.current?.click(); }}>添加附件</button>
      <span className="dsh-tree-editor-hint">{disabled ? busyHint : '发送后保留原分支并立即生成'}</span>
      <button type="button" disabled={sending} onClick={onClose}>取消</button>
      <button type="button" className="dsh-tree-primary" disabled={locked || (!text.trim() && retained.length === 0 && attachments.length === 0)} onClick={() => { void send(); }}>{sending ? '发送中…' : '发送'}</button>
    </div>
  </div>;
}

function attachmentName(block: Record<string, unknown>): string {
  const attachment = (block.attachment ?? block.file ?? block.image) as Record<string, unknown> | undefined;
  return String(attachment?.name ?? block.name ?? (block.type === 'image' ? '图片附件' : block.type === 'file' ? '文件附件' : '原始消息内容'));
}

function nodeText(node: TreeNode): string {
  const content = node.message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.filter((block): block is { type: string; text: string } => typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
}

function TreeDialog({ store, state, onClose }: { store: TreeStore; state: TreeState; onClose(): void }): React.ReactElement {
  const dialog = React.useRef<HTMLDivElement>(null);
  const title = React.useId();
  React.useEffect(() => {
    dialog.current?.focus();
  }, []);
  const tree = state.tree;
  const rows: { node: TreeNode; depth: number }[] = [];
  if (tree) {
    const stack = tree.rootChildren.slice().reverse().map(id => ({ id, depth: 0 }));
    while (stack.length > 0) {
      const item = stack.pop()!;
      const node = tree.nodes[item.id];
      if (node) {
        rows.push({ node, depth: item.depth });
        stack.push(...node.children.slice().reverse().map(id => ({ id, depth: item.depth + 1 })));
      }
    }
  }
  const locked = state.mutating || state.running || tree?.busy === true;
  return <div className="dsh-tree-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) { onClose(); } }}>
    <div className="dsh-tree-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={title}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
        if (event.key === 'Tab') {
          const targets = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? []);
          const first = targets[0];
          const last = targets[targets.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}>
      <header><h2 id={title}>消息树</h2><button type="button" onClick={onClose} aria-label="关闭消息树">×</button></header>
      {locked && <p className="dsh-tree-busy">{busyHint}；待发消息仍可撤回。</p>}
      <Scrollbar className="dsh-tree-dialog-scroll">
        {!tree && <p>正在读取消息树…</p>}
        {tree && rows.length === 0 && <p>当前会话还没有消息。</p>}
        <div role="list" className="dsh-tree-list">
          {rows.map(({ node, depth }) => <div role="listitem" key={node.id} className={`dsh-tree-row${node.id === tree?.activeNodeId ? ' is-active' : ''}`} style={{ paddingInlineStart: Math.min(depth, 16) * 16 + 8 }}>
            <button type="button" className="dsh-tree-node" disabled={locked || node.status === 'pending' || node.status === 'claimed'} aria-current={node.id === tree?.activeNodeId ? 'true' : undefined}
              onClick={() => { run(store.mutate('select', node.id)); }} title={nodeText(node)}>
              <span className="dsh-tree-role">{node.role === 'user' ? '用户' : node.role === 'assistant' ? '助手' : node.role}</span>
              <span className="dsh-tree-preview">{nodeText(node) || '附件或工具消息'}</span>
            </button>
            {node.role === 'user' && <RecallButton store={store} state={state} node={node} />}
          </div>)}
        </div>
      </Scrollbar>
      <footer>{state.error && <span className="dsh-tree-error" role="alert">{state.error}</span>}<button type="button" onClick={onClose}>关闭</button></footer>
    </div>
  </div>;
}
