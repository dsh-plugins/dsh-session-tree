import {
  appendNode, cloneValue, getActivePath, isRecord, nextNodeId, prepareOperationPrefix, selectNode,
  type SessionEvent, type SessionHeader, type TreeDocument, type TreeNode,
} from './tree.js';

/** 分支导出的官方内存格式，存储层负责物理格式编码。 */
export interface SessionSnapshot {
  header: SessionHeader;
  events: SessionEvent[];
  inheritedEventCount?: number;
}

/** 操作后的树及生成所需历史，宿主以 mountParentId 接入新输出。 */
export interface BranchOperation extends SessionSnapshot {
  tree: TreeDocument;
  mountParentId: string | null;
  nodeId?: string;
}

interface Segment {
  message: Record<string, unknown>;
  role: 'user' | 'assistant';
  messageEventSeq: number;
  events: SessionEvent[];
}

function validateHeader(header: SessionHeader): void {
  if (!isRecord(header) || header.version !== 4 || typeof header.id !== 'string' || header.id.length === 0
    || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0 || typeof header.isSeeded !== 'boolean') {
    throw new Error('仅支持有效的官方版本 4 会话头');
  }
}

/** 校验官方内存事件外壳和顺序，不改写扩展字段。 */
export function validateEvents(events: readonly SessionEvent[], startSeq = 0): void {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isRecord(event) || event.seq !== startSeq + index || !Number.isSafeInteger(event.time) || event.time < 0
      || typeof event.type !== 'string' || event.type.length === 0 || !Object.hasOwn(event, 'data')) {
      throw new Error(`会话事件外壳或连续序号无效：${startSeq + index}`);
    }
    if (event.sourceEventSeqs !== undefined && (!Array.isArray(event.sourceEventSeqs)
      || event.sourceEventSeqs.some((seq) => !Number.isSafeInteger(seq) || seq < 0 || seq >= event.seq))) {
      throw new Error(`事件来源序号无效：${event.seq}`);
    }
    // 压缩摘要的事件序号不代表当前上下文位置；完整替换范围由官方存储编解码器校验。
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append'
      && (!isRecord(event.surfaceOp) || event.surfaceOp.op !== 'replace'
        || !Number.isSafeInteger(event.surfaceOp.startSeq) || !Number.isSafeInteger(event.surfaceOp.endSeq)
        || event.surfaceOp.startSeq < 0 || event.surfaceOp.endSeq < 0
        || event.surfaceOp.startSeq >= event.seq || event.surfaceOp.endSeq >= event.seq)) {
      throw new Error(`表面替换范围无效：${event.seq}`);
    }
  }
}

function visibleMessage(event: SessionEvent): { message: Record<string, unknown>; role: 'user' | 'assistant' } | null {
  if (event.surfaceOp !== 'append' || !isRecord(event.data)) {
    return null;
  }
  const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : null;
  if (role === null) {
    return null;
  }
  const message = role === 'user' ? event.data : event.data.message;
  if (!isRecord(message) || message.role !== role || typeof message.id !== 'string' || message.id.length === 0
    || !Array.isArray(message.content) || !isRecord(message.source)) {
    throw new Error(`官方消息格式无效：${event.seq}`);
  }
  if (role === 'user' && message.source.kind !== 'user') {
    return null;
  }
  return { message, role };
}

function splitEvents(events: readonly SessionEvent[]): { prefix: SessionEvent[]; segments: Segment[]; tail: SessionEvent[] } {
  const boundaries: Array<{ index: number; eventIndex: number; message: Record<string, unknown>; role: 'user' | 'assistant' }> = [];
  let previousMessage = -1;
  let turnStart = -1;
  let stepStart = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type === 'turn/start') {
      turnStart = index;
    }
    if (event.type === 'step/start') {
      stepStart = index;
    }
    const visible = visibleMessage(event);
    if (visible !== null) {
      const lifecycleStart = visible.role === 'user' ? turnStart : stepStart;
      const start = lifecycleStart > previousMessage ? lifecycleStart : index;
      boundaries.push({ index: start, eventIndex: index, ...visible });
      previousMessage = index;
    }
  }
  return {
    prefix: cloneValue(events.slice(0, boundaries[0]?.index ?? 0)),
    tail: cloneValue(events.slice(boundaries.at(-1) === undefined ? 0 : boundaries.at(-1)!.eventIndex + 1)),
    segments: boundaries.map((boundary, index) => ({
      message: cloneValue(boundary.message),
      role: boundary.role,
      messageEventSeq: events[boundary.eventIndex].seq,
      events: cloneValue(events.slice(boundary.index, boundaries[index + 1]?.index ?? boundary.eventIndex + 1)),
    })),
  };
}

function addSegment(tree: TreeDocument, parentId: string | null, segment: Segment): TreeNode {
  const messageId = segment.message.id as string;
  const node: TreeNode = {
    id: nextNodeId(tree, messageId), parentId, children: [], selectedChildId: null,
    role: segment.role, messageId, message: cloneValue(segment.message), status: 'dispatched',
    events: cloneValue(segment.events), messageEventSeq: segment.messageEventSeq,
    ...(parentId === null ? { rootPrefixEvents: cloneValue(tree.prefixEvents) } : {}),
  };
  appendNode(tree, node);
  return node;
}

/** 导入完整官方事件日志，注入上下文、工具结果和未知事件留在原事件段。 */
export function importSession(header: SessionHeader, events: readonly SessionEvent[]): TreeDocument {
  validateHeader(header);
  validateEvents(events);
  const split = splitEvents(events);
  const tree: TreeDocument = {
    version: 1, sessionId: header.id, header: cloneValue(header), revision: 0,
    nodes: {}, rootChildren: [], rootSelectedChildId: null, activeNodeId: null, prefixEvents: split.prefix,
  };
  if (header.isSeeded) {
    tree.inheritedEventCount = events.findLast((event) => event.type === 'session/end-seed' && isRecord(event.data) && event.data.inherited === true)?.seq ?? events.length;
  }
  for (const segment of split.segments) {
    addSegment(tree, tree.activeNodeId, segment);
  }
  if (tree.activeNodeId === null) {
    tree.rootTailEvents = split.tail;
  } else {
    tree.nodes[tree.activeNodeId].tailEvents = split.tail;
  }
  return tree;
}

function remapEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const mapping = new Map<number, number>();
  const result: SessionEvent[] = [];
  for (const original of events) {
    const event = cloneValue(original);
    const resolve = (seq: number): number => {
      const mapped = mapping.get(seq);
      if (mapped === undefined) {
        throw new Error(`事件 ${original.seq} 引用了当前路径之外的序号 ${seq}`);
      }
      return mapped;
    };
    if (event.sourceEventSeqs !== undefined) {
      event.sourceEventSeqs = event.sourceEventSeqs.map(resolve);
    }
    if (isRecord(event.surfaceOp)) {
      event.surfaceOp = { ...event.surfaceOp, startSeq: resolve(event.surfaceOp.startSeq), endSeq: resolve(event.surfaceOp.endSeq) };
    }
    if (event.type === 'developer/message' && isRecord(event.data) && typeof event.data.headerSeq === 'number') {
      event.data.headerSeq = resolve(event.data.headerSeq);
    }
    if (mapping.has(original.seq)) {
      throw new Error(`同一路径存在重复事件序号：${original.seq}`);
    }
    event.seq = result.length;
    mapping.set(original.seq, event.seq);
    result.push(event);
  }
  return result;
}

/** 导出指定游标的线性日志，只在该路径内解释事件序号。 */
export function exportSession(tree: TreeDocument, nodeId: string | null = tree.activeNodeId): SessionSnapshot {
  const path = getActivePath(tree, nodeId);
  const events = remapEvents([
    ...(path[0]?.rootPrefixEvents ?? tree.prefixEvents),
    ...path.flatMap((node) => node.events),
    ...(nodeId === null ? tree.rootTailEvents ?? [] : tree.nodes[nodeId].tailEvents ?? []),
  ]);
  const result: SessionSnapshot = { header: cloneValue(tree.header), events };
  if (tree.header.isSeeded) {
    const marker = events.findLast((event) => event.type === 'session/end-seed' && isRecord(event.data) && event.data.inherited === true);
    result.inheritedEventCount = Math.min(tree.inheritedEventCount ?? marker?.seq ?? events.length, events.length);
  }
  return result;
}

function equalValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equalValue(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equalValue(left[key], right[key]));
  }
  return false;
}

function isPrefix(prefix: readonly SessionEvent[], events: readonly SessionEvent[]): boolean {
  return prefix.length <= events.length && prefix.every((event, index) => equalValue(event, events[index]));
}

/** 将完整实时日志接入指定祖先；已有兄弟和后代保持可访问。 */
export function syncSession(
  tree: TreeDocument,
  header: SessionHeader,
  events: readonly SessionEvent[],
  options: { mountParentId?: string | null } = {},
): TreeDocument {
  validateHeader(header);
  validateEvents(events);
  if (header.id !== tree.sessionId) {
    throw new Error('同步会话身份与树不一致');
  }
  const next = cloneValue(tree);
  next.header = cloneValue(header);
  if (header.isSeeded) {
    next.inheritedEventCount = events.findLast((event) => event.type === 'session/end-seed' && isRecord(event.data) && event.data.inherited === true)?.seq
      ?? Math.min(tree.inheritedEventCount ?? events.length, events.length);
  } else {
    delete next.inheritedEventCount;
  }
  let parentId: string | null = null;
  let split: ReturnType<typeof splitEvents>;
  if (options.mountParentId !== undefined) {
    parentId = options.mountParentId;
    const prefix = exportSession(tree, parentId).events;
    if (!isPrefix(prefix, events)) {
      throw new Error('同步日志与挂载祖先的事件前缀不一致');
    }
    const oldTail = parentId === null ? next.rootTailEvents ?? [] : next.nodes[parentId].tailEvents ?? [];
    split = splitEvents([...cloneValue(oldTail), ...events.slice(prefix.length)]);
    if (split.segments.length > 0) {
      if (parentId === null) {
        next.prefixEvents.push(...split.prefix);
        next.rootTailEvents = [];
      } else {
        split.segments[0].events.unshift(...split.prefix);
        next.nodes[parentId].tailEvents = [];
      }
    }
  } else {
    split = splitEvents(events);
    next.prefixEvents = split.prefix;
    next.rootTailEvents = [];
  }
  for (const [segmentIndex, segment] of split.segments.entries()) {
    const children: string[] = parentId === null ? next.rootChildren : next.nodes[parentId].children;
    const last = segmentIndex === split.segments.length - 1;
    const candidates = children.map((id) => next.nodes[id]).filter((node) => node.messageId === segment.message.id);
    let match = candidates.find((node) => node.events.length === 0 && node.messageEventSeq === null
      && (node.status === 'pending' || node.status === 'claimed'))
      ?? candidates.find((node) => (parentId !== null || equalValue(node.rootPrefixEvents ?? tree.prefixEvents, next.prefixEvents))
        && (equalValue(node.events, segment.events)
          || last && isPrefix(segment.events, node.events) && isPrefix(node.events.slice(segment.events.length), split.tail)
          || isPrefix(node.events, segment.events)));
    if (match) {
      if (match.events.length > segment.events.length) {
        split.tail = split.tail.slice(match.events.length - segment.events.length);
      } else if (match.messageEventSeq !== null) {
        const extra = segment.events.slice(match.events.length);
        const following = split.segments[segmentIndex + 1];
        if (following) {
          following.events.unshift(...extra);
        } else {
          split.tail.unshift(...extra);
        }
      } else {
        match.events = cloneValue(segment.events);
        if (parentId === null) {
          match.rootPrefixEvents = cloneValue(next.prefixEvents);
        }
      }
      match.tailEvents = [];
      match.message = cloneValue(segment.message);
      match.messageEventSeq = segment.messageEventSeq;
      match.status = 'dispatched';
    } else {
      match = addSegment(next, parentId, segment);
    }
    if (parentId === null) {
      next.rootSelectedChildId = match.id;
    } else {
      next.nodes[parentId].selectedChildId = match.id;
    }
    parentId = match.id;
  }
  if (parentId === null) {
    next.rootTailEvents = cloneValue(split.tail);
  } else {
    next.nodes[parentId].tailEvents = cloneValue(split.tail);
  }
  next.activeNodeId = parentId;
  next.revision += 1;
  return next;
}

/** 重试截取助手节点之前的历史，新输出由宿主生成并挂到同一父节点。 */
export function retryNode(tree: TreeDocument, nodeId: string): BranchOperation {
  const node = getActivePath(tree, nodeId).at(-1)!;
  if (node.role !== 'assistant') {
    throw new Error('只能重试助手消息');
  }
  const next = selectNode(tree, node.parentId, { followSelected: false });
  prepareOperationPrefix(next, node);
  return { tree: next, mountParentId: node.parentId, ...exportSession(next) };
}

/** 编辑建立新的待发送兄弟，官方消息身份必须由宿主重新创建。 */
export function editUserNode(tree: TreeDocument, nodeId: string, message: Record<string, unknown>): BranchOperation {
  const node = getActivePath(tree, nodeId).at(-1)!;
  if (node.role !== 'user' || message.role !== 'user' || typeof message.id !== 'string' || message.id.length === 0
    || message.id === node.messageId || !Array.isArray(message.content) || !isRecord(message.source) || message.source.kind !== 'user'
    || Object.values(tree.nodes).some((existing) => existing.messageId === message.id)) {
    throw new Error('编辑需要具备新身份的官方用户消息');
  }
  const next = cloneValue(tree);
  prepareOperationPrefix(next, node);
  const id = nextNodeId(next, message.id);
  appendNode(next, {
    id, parentId: node.parentId, children: [], selectedChildId: null,
    role: 'user', messageId: message.id, message: cloneValue(message), status: 'pending',
    events: [], messageEventSeq: null,
    ...(node.parentId === null ? { rootPrefixEvents: cloneValue(next.prefixEvents) } : {}),
  });
  next.revision += 1;
  return { tree: next, mountParentId: node.parentId, nodeId: id, ...exportSession(next, node.parentId) };
}
