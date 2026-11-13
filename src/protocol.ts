import type { TreeDocument, TreeNode } from './tree.js';

/** 客户端只接收树关联与消息，原始事件留在宿主。 */
export interface TreeView {
  sessionId: string;
  revision: number;
  busy: boolean;
  activeNodeId: string | null;
  rootChildren: string[];
  rootSelectedChildId: string | null;
  nodes: Record<string, Pick<TreeNode, 'id' | 'parentId' | 'children' | 'selectedChildId' | 'role' | 'messageId' | 'status' | 'message'>>;
}

/** 已有附件只允许按原消息的内容下标引用。 */
export type EditPart = { type: 'text'; text: string } | { type: 'retained'; index: number } | Record<string, unknown>;

/** 一次幂等树修改的请求参数。 */
export interface TreeMutation {
  expectedRevision: number;
  operationId: string;
  nodeId: string;
  content?: EditPart[];
}

/** 撤回成功后回填所属会话的完整草稿。 */
export interface RecalledDraft {
  text: string;
  attachments: Record<string, unknown>[];
}

/** 树操作失败保留可供界面处理的稳定错误码。 */
export class TreeError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = 'TreeError';
  }
}

export function treeView(tree: TreeDocument, busy: boolean): TreeView {
  return {
    sessionId: tree.sessionId,
    revision: tree.revision,
    busy,
    activeNodeId: tree.activeNodeId,
    rootChildren: tree.rootChildren,
    rootSelectedChildId: tree.rootSelectedChildId,
    nodes: Object.fromEntries(Object.values(tree.nodes).map(node => [node.id, {
      id: node.id, parentId: node.parentId, children: node.children,
      selectedChildId: node.selectedChildId, role: node.role, messageId: node.messageId,
      status: node.status, message: node.message,
    }])),
  };
}

export function parseMutation(value: unknown): TreeMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TreeError('invalid-request', '请求必须是对象。', 400);
  }
  const input = value as Record<string, unknown>;
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0
    || typeof input.operationId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.operationId)
    || typeof input.nodeId !== 'string' || input.nodeId.length === 0 || input.nodeId.length > 256) {
    throw new TreeError('invalid-request', '操作编号、节点或修订号无效。', 400);
  }
  if (input.content !== undefined && (!Array.isArray(input.content)
    || input.content.some(part => !part || typeof part !== 'object' || Array.isArray(part) || typeof part.type !== 'string'))) {
    throw new TreeError('invalid-content', '消息内容必须是内容块数组。', 400);
  }
  return {
    expectedRevision: Number(input.expectedRevision), operationId: input.operationId,
    nodeId: input.nodeId, ...(input.content === undefined ? {} : { content: input.content as EditPart[] }),
  };
}
