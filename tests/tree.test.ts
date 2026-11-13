import assert from 'node:assert/strict';
import test from 'node:test';
import { importSession, editUserNode } from '../src/event-codec.js';
import { appendNode, cloneValue, getActivePath, hardRemove, parseTreeDocument, selectNode, softRewind, type SessionEvent, type SessionHeader } from '../src/tree.js';

const header: SessionHeader = { version: 4, id: 'example', createdAt: 0, isSeeded: false };
const message = (id: string, role: 'user' | 'assistant') => ({ id, role, content: [{ type: 'text', text: id }], source: { kind: role === 'user' ? 'user' : 'model' } });
function sample() {
  const events: SessionEvent[] = [
    { seq: 0, time: 0, type: 'user/message', data: message('u1', 'user'), surfaceOp: 'append' },
    { seq: 1, time: 1, type: 'assistant/message', data: { turn: 0, step: 0, message: message('a1', 'assistant'), stream: [] }, surfaceOp: 'append' },
    { seq: 2, time: 2, type: 'user/message', data: message('u2', 'user'), surfaceOp: 'append' },
  ];
  return importSession(header, events);
}

test('软撤回停在父节点，分支选择恢复记忆中的后代', () => {
  const original = sample();
  const path = getActivePath(original);
  const rewound = softRewind(original);
  assert.equal(rewound.activeNodeId, path[1].id);
  assert.equal(rewound.nodes[path[1].id].selectedChildId, path[2].id);
  assert.deepEqual(rewound.nodes, original.nodes);
  assert.equal(selectNode(rewound, path[0].id).activeNodeId, path[2].id);
  assert.equal(selectNode(rewound, path[0].id, { followSelected: false }).activeNodeId, path[0].id);
  assert.equal(softRewind(original, path[0].id).activeNodeId, null);
});

test('兄弟节点分别保存后代选择', () => {
  const tree = sample();
  const [user, assistant, child] = getActivePath(tree);
  const alternate = { ...cloneValue(assistant), id: 'alternate', children: [], selectedChildId: null, messageId: 'a2', message: message('a2', 'assistant') };
  appendNode(tree, alternate);
  assert.equal(selectNode(tree, assistant.id).activeNodeId, child.id);
  assert.equal(selectNode(tree, alternate.id).activeNodeId, alternate.id);
  assert.equal(selectNode(tree, user.id).activeNodeId, alternate.id);
});

test('硬撤回仅删除待发送叶节点并修复选中指针', () => {
  const tree = sample();
  const userId = getActivePath(tree)[0].id;
  const operation = editUserNode(tree, userId, message('edited', 'user'));
  const removed = hardRemove(operation.tree, operation.nodeId!);
  assert.deepEqual(removed.rootChildren, tree.rootChildren);
  assert.equal(removed.activeNodeId, null);
  assert.equal(removed.rootSelectedChildId, userId);
  assert.throws(() => hardRemove(tree, userId), /待发送/);
  const claimed = cloneValue(operation.tree);
  claimed.nodes[operation.nodeId!].status = 'claimed';
  assert.equal(hardRemove(claimed, operation.nodeId!).nodes[operation.nodeId!], undefined);
});

test('反序列化拒绝环、孤立节点、重复子节点及无效选择', () => {
  const tree = sample();
  assert.deepEqual(parseTreeDocument(JSON.parse(JSON.stringify(tree))), tree);
  const path = getActivePath(tree);
  const cycle = cloneValue(tree);
  cycle.nodes[path[2].id].children.push(path[0].id);
  assert.throws(() => parseTreeDocument(cycle));
  const orphan = cloneValue(tree);
  orphan.rootChildren = [];
  orphan.rootSelectedChildId = null;
  assert.throws(() => parseTreeDocument(orphan));
  const duplicate = cloneValue(tree);
  duplicate.rootChildren.push(path[0].id);
  assert.throws(() => parseTreeDocument(duplicate));
  const selection = cloneValue(tree);
  selection.nodes[path[0].id].selectedChildId = path[2].id;
  assert.throws(() => parseTreeDocument(selection));
  const cursor = cloneValue(tree);
  cursor.activeNodeId = 'missing';
  assert.throws(() => parseTreeDocument(cursor));
});
