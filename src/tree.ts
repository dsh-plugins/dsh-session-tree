/** 官方会话事件的无损 JSON 外壳，扩展字段随分支保存。 */
export interface SessionEvent {
  seq: number;
  time: number;
  type: string;
  data: Record<string, unknown>;
  surfaceOp?: 'append' | { op: 'replace'; startSeq: number; endSeq: number; [key: string]: unknown };
  sourceEventSeqs?: number[];
  [key: string]: unknown;
}

/** 官方版本 4 的存储头，未知元数据保持原样。 */
export interface SessionHeader {
  version: 4;
  id: string;
  createdAt: number;
  isSeeded: boolean;
  [key: string]: unknown;
}

/** 一个可选分支及其原始事件段；messageId 与官方消息身份一致。 */
export interface TreeNode {
  id: string;
  parentId: string | null;
  children: string[];
  selectedChildId: string | null;
  role: 'user' | 'assistant';
  messageId: string;
  message: Record<string, unknown>;
  status: 'pending' | 'claimed' | 'dispatched';
  events: SessionEvent[];
  /** 只有游标停在此节点时才导出，后代拥有各自的后续事件段。 */
  tailEvents?: SessionEvent[];
  /** 根分支保留创建时的前置事件，使全局设置变更不覆盖历史。 */
  rootPrefixEvents?: SessionEvent[];
  messageEventSeq: number | null;
}

/** 虚拟根保存首条可见消息之前的事件，游标可以停在任意祖先。 */
export interface TreeDocument {
  version: 1;
  sessionId: string;
  header: SessionHeader;
  revision: number;
  nodes: Record<string, TreeNode>;
  rootChildren: string[];
  rootSelectedChildId: string | null;
  activeNodeId: string | null;
  prefixEvents: SessionEvent[];
  rootTailEvents?: SessionEvent[];
  inheritedEventCount?: number;
}

/** 脱离输入对象，防止后续更新修改历史分支。 */
export function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 将未知 JSON 对象缩窄为可读取的记录。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 从虚拟根到指定节点的祖先路径，默认读取当前游标。 */
export function getActivePath(tree: TreeDocument, nodeId: string | null = tree.activeNodeId): TreeNode[] {
  const path: TreeNode[] = [];
  const visited = new Set<string>();
  while (nodeId !== null) {
    const node: TreeNode | undefined = Object.hasOwn(tree.nodes, nodeId) ? tree.nodes[nodeId] : undefined;
    if (!node || visited.has(nodeId)) {
      throw new Error(`树路径无效：${nodeId}`);
    }
    visited.add(nodeId);
    path.push(node);
    nodeId = node.parentId;
  }
  return path.reverse();
}

function rememberPath(tree: TreeDocument, nodeId: string | null): void {
  const path = getActivePath(tree, nodeId);
  for (const node of path) {
    if (node.parentId === null) {
      tree.rootSelectedChildId = node.id;
    } else {
      tree.nodes[node.parentId].selectedChildId = node.id;
    }
  }
}

/** 切换分支时恢复该分支上次选中的后代，显式关闭下行可停在中间节点。 */
export function selectNode(tree: TreeDocument, nodeId: string | null, options: { followSelected?: boolean } = {}): TreeDocument {
  getActivePath(tree, nodeId);
  const next = cloneValue(tree);
  rememberPath(next, nodeId);
  const seen = new Set<string>();
  if (options.followSelected !== false) {
    let child = nodeId === null ? next.rootSelectedChildId : next.nodes[nodeId].selectedChildId;
    while (child !== null) {
      if (seen.has(child) || !Object.hasOwn(next.nodes, child) || next.nodes[child].parentId !== nodeId) {
        throw new Error(`分支选择无效：${child}`);
      }
      seen.add(child);
      nodeId = child;
      child = next.nodes[child].selectedChildId;
    }
  }
  next.activeNodeId = nodeId;
  next.revision += 1;
  return next;
}

/** 将目标生成边界之前的工具结果等日志保留在父游标，避免截断配对消息。 */
export function prepareOperationPrefix(tree: TreeDocument, node: TreeNode): void {
  if (node.messageEventSeq === null) {
    return;
  }
  const messageIndex = node.events.findIndex((event) => event.seq === node.messageEventSeq);
  if (messageIndex < 0) {
    throw new Error(`节点缺少消息事件：${node.id}`);
  }
  const boundaryType = node.role === 'user' ? 'turn/start' : 'step/start';
  const boundaryIndex = node.events.slice(0, messageIndex).findLastIndex((event) => event.type === boundaryType);
  const prefix = cloneValue(node.events.slice(0, boundaryIndex < 0 ? messageIndex : boundaryIndex));
  if (node.parentId === null) {
    tree.prefixEvents = cloneValue(node.rootPrefixEvents ?? tree.prefixEvents);
    if (prefix.length > 0 || tree.rootTailEvents !== undefined) {
      tree.rootTailEvents = prefix;
    }
  } else if (prefix.length > 0 || tree.nodes[node.parentId].tailEvents !== undefined) {
    tree.nodes[node.parentId].tailEvents = prefix;
  }
}

/** 软撤回只移动游标，保留原分支及祖先的后代选择记录。 */
export function softRewind(tree: TreeDocument, nodeId: string | null = tree.activeNodeId): TreeDocument {
  const path = getActivePath(tree, nodeId);
  const next = cloneValue(tree);
  const node = path.at(-1);
  if (node) {
    prepareOperationPrefix(next, node);
  }
  next.activeNodeId = node?.parentId ?? null;
  next.revision += 1;
  return next;
}

/** 硬撤回只删除未派发且没有后代的消息，宿主先完成队列撤销。 */
export function hardRemove(tree: TreeDocument, nodeId: string): TreeDocument {
  const node = getActivePath(tree, nodeId).at(-1)!;
  if (node.status === 'dispatched' || node.children.length !== 0) {
    throw new Error('仅允许硬撤回没有后代的待发送消息');
  }
  const next = cloneValue(tree);
  const parent = node.parentId === null ? null : next.nodes[node.parentId];
  const children = parent === null ? next.rootChildren : parent.children;
  children.splice(children.indexOf(nodeId), 1);
  if (parent === null && next.rootSelectedChildId === nodeId) {
    next.rootSelectedChildId = children.at(-1) ?? null;
  } else if (parent !== null && parent.selectedChildId === nodeId) {
    parent.selectedChildId = children.at(-1) ?? null;
  }
  if (next.activeNodeId === nodeId) {
    next.activeNodeId = node.parentId;
  }
  delete next.nodes[nodeId];
  next.revision += 1;
  return next;
}

/** 添加具备独立身份的节点并选中它，调用者负责提供完整事件段。 */
export function appendNode(tree: TreeDocument, node: TreeNode): void {
  if (Object.hasOwn(tree.nodes, node.id)) {
    throw new Error(`节点身份重复：${node.id}`);
  }
  if (node.parentId !== null && !Object.hasOwn(tree.nodes, node.parentId)) {
    throw new Error(`父节点不存在：${node.parentId}`);
  }
  tree.nodes[node.id] = node;
  if (node.parentId === null) {
    tree.rootChildren.push(node.id);
    tree.rootSelectedChildId = node.id;
  } else {
    tree.nodes[node.parentId].children.push(node.id);
    tree.nodes[node.parentId].selectedChildId = node.id;
  }
  if (tree.activeNodeId !== node.parentId) {
    rememberPath(tree, node.parentId);
  }
  tree.activeNodeId = node.id;
}

/** 为同一消息的不同事件快照生成局部唯一节点身份。 */
export function nextNodeId(tree: TreeDocument, messageId: string): string {
  const base = `message:${messageId}`;
  let id = base;
  let index = 2;
  while (Object.hasOwn(tree.nodes, id)) {
    id = `${base}:${index++}`;
  }
  return id;
}

/** 读取持久化树时校验引用、单父关系和选中路径，拒绝损坏的文档。 */
export function parseTreeDocument(value: unknown): TreeDocument {
  if (!isRecord(value) || value.version !== 1 || typeof value.sessionId !== 'string'
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !isRecord(value.header) || value.header.version !== 4 || value.header.id !== value.sessionId
    || !Number.isSafeInteger(value.header.createdAt) || (value.header.createdAt as number) < 0
    || typeof value.header.isSeeded !== 'boolean' || !isRecord(value.nodes)
    || !Array.isArray(value.rootChildren) || !Array.isArray(value.prefixEvents)
    || (value.rootTailEvents !== undefined && !Array.isArray(value.rootTailEvents))
    || (value.inheritedEventCount !== undefined && (!Number.isSafeInteger(value.inheritedEventCount) || (value.inheritedEventCount as number) < 0))) {
    throw new Error('树文档头或版本无效');
  }
  const tree = value as unknown as TreeDocument;
  const validateSegment = (events: SessionEvent[], firstSeq: number): void => {
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!isRecord(event) || event.seq !== firstSeq + index || !Number.isSafeInteger(event.time) || event.time < 0
        || typeof event.type !== 'string' || event.type.length === 0 || !Object.hasOwn(event, 'data')) {
        throw new Error(`树事件段格式无效：${firstSeq + index}`);
      }
    }
  };
  validateSegment(tree.prefixEvents, 0);
  validateSegment(tree.rootTailEvents ?? [], tree.prefixEvents.length);
  const seen = new Set<string>();
  const stack: Array<{ id: unknown; parent: string | null }> = tree.rootChildren.map((id) => ({ id, parent: null }));
  const validSelection = (selection: unknown, children: string[]): boolean => selection === null
    || typeof selection === 'string' && children.includes(selection);
  if (!validSelection(tree.rootSelectedChildId, tree.rootChildren)) {
    throw new Error('根节点选中分支无效');
  }
  while (stack.length > 0) {
    const { id, parent } = stack.pop()!;
    if (typeof id !== 'string' || seen.has(id) || !Object.hasOwn(tree.nodes, id)) {
      throw new Error(`节点重复或不存在：${String(id)}`);
    }
    const node = tree.nodes[id];
    if (!isRecord(node) || node.id !== id || node.parentId !== parent
      || !Array.isArray(node.children) || !Array.isArray(node.events)
      || (node.tailEvents !== undefined && !Array.isArray(node.tailEvents))
      || (node.rootPrefixEvents !== undefined && (!Array.isArray(node.rootPrefixEvents) || parent !== null))
      || (node.role !== 'user' && node.role !== 'assistant')
      || !['pending', 'claimed', 'dispatched'].includes(node.status)
      || typeof node.messageId !== 'string' || !isRecord(node.message)
      || node.message.id !== node.messageId || node.message.role !== node.role
      || !validSelection(node.selectedChildId, node.children)
      || (node.messageEventSeq !== null && (!Number.isSafeInteger(node.messageEventSeq) || node.messageEventSeq < 0))) {
      throw new Error(`节点格式无效：${id}`);
    }
    if (node.rootPrefixEvents !== undefined) {
      validateSegment(node.rootPrefixEvents, 0);
    }
    const parentEvents = parent === null ? node.rootPrefixEvents ?? tree.prefixEvents : tree.nodes[parent].events;
    const startSeq = (parentEvents.at(-1)?.seq ?? -1) + 1;
    validateSegment(node.events, startSeq);
    validateSegment(node.tailEvents ?? [], startSeq + node.events.length);
    if (node.messageEventSeq === null) {
      if (node.events.length !== 0 || node.status === 'dispatched') {
        throw new Error(`缺少已发送消息的事件关联：${id}`);
      }
    } else {
      const event = node.events.find((entry) => entry.seq === node.messageEventSeq);
      const message = event?.type === 'user/message' ? event.data : isRecord(event?.data) ? event.data.message : null;
      if (!event || event.type !== `${node.role}/message` || event.surfaceOp !== 'append'
        || !isRecord(message) || message.id !== node.messageId) {
        throw new Error(`节点消息事件关联无效：${id}`);
      }
    }
    seen.add(id);
    for (const child of node.children) {
      stack.push({ id: child, parent: id });
    }
  }
  if (seen.size !== Object.keys(tree.nodes).length
    || (tree.activeNodeId !== null && (typeof tree.activeNodeId !== 'string' || !seen.has(tree.activeNodeId)))) {
    throw new Error('树包含孤立节点或无效游标');
  }
  return cloneValue(tree);
}
