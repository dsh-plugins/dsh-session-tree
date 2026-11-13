import assert from 'node:assert/strict';
import test from 'node:test';
import { editUserNode, exportSession, importSession, retryNode, syncSession } from '../src/event-codec.js';
import { cloneValue, getActivePath, parseTreeDocument, selectNode, softRewind, type SessionEvent, type SessionHeader } from '../src/tree.js';

const header: SessionHeader = { version: 4, id: 'example', createdAt: 0, isSeeded: false, extension: { keep: true } };
const user = (id: string) => ({ id, role: 'user', content: [{ type: 'text', text: id }], source: { kind: 'user' } });
const assistant = (id: string) => ({ id, role: 'assistant', content: [{ type: 'text', text: id }], source: { kind: 'model', provider: 'example', model: 'foo' } });
function log(): SessionEvent[] {
  const entries: Array<Omit<SessionEvent, 'seq' | 'time'>> = [
    { type: 'plugin:example/info', data: { unknown: ['retained'] }, ignorable: true, custom: 'keep' },
    { type: 'turn/start', data: { turn: 0 } },
    { type: 'user/message', data: user('u1'), surfaceOp: 'append' },
    { type: 'step/start', data: { turn: 0, step: 0 } },
    { type: 'request/header', data: { reason: 'initial', header: { config: { provider: 'example', model: 'foo' } } } },
    { type: 'user/message', data: { ...user('context'), source: { kind: 'skill' } }, surfaceOp: 'append' },
    { type: 'assistant/message', data: { turn: 0, step: 0, message: assistant('a1'), stream: [{ delta: 'opaque' }] }, surfaceOp: 'append' },
    { type: 'tool/call', data: { turn: 0, step: 0, callId: 'call', name: 'foo', arguments: '{"x":1}' } },
    { type: 'tool/result', data: { turn: 0, step: 0, message: { id: 'tool', role: 'tool', toolCallId: 'call', content: [], source: { kind: 'tool', callId: 'call' } } }, surfaceOp: 'append' },
    { type: 'step/end', data: { turn: 0, step: 0 } },
    { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
  ];
  return entries.map((entry, seq) => ({ ...entry, seq, time: seq + 10 }) as SessionEvent);
}

test('官方事件完整往返保留未知字段、注入消息、流与工具结果', () => {
  const events = log();
  const tree = importSession(header, events);
  assert.deepEqual(getActivePath(tree).map((node) => node.messageId), ['u1', 'a1']);
  assert.deepEqual(exportSession(tree), { header, events });
  assert.equal(tree.nodes[getActivePath(tree)[1].id].events[0].type, 'step/start');
  tree.header.extension = null;
  assert.deepEqual(header.extension, { keep: true });
});

test('重试保留旧助手分支并将新输出挂载为同父兄弟', () => {
  const events = log();
  const tree = importSession(header, events);
  const [parent, oldAssistant] = getActivePath(tree);
  const operation = retryNode(tree, oldAssistant.id);
  assert.equal(operation.events.at(-1)?.type, 'user/message');
  const replacement = cloneValue(events);
  replacement[6].data.message = assistant('a2');
  const synced = syncSession(operation.tree, header, replacement, { mountParentId: operation.mountParentId });
  assert.equal(synced.nodes[parent.id].children.length, 2);
  assert.equal(getActivePath(synced).at(-1)?.messageId, 'a2');
  assert.deepEqual(exportSession(selectNode(synced, oldAssistant.id)).events, events);
  assert.deepEqual(exportSession(synced).events, replacement);
});

test('编辑建立待发送兄弟并以新消息身份领取事件，不污染旧后代', () => {
  const events = log();
  const tree = importSession(header, events);
  const oldUser = getActivePath(tree)[0];
  const operation = editUserNode(tree, oldUser.id, user('u2'));
  assert.equal(operation.tree.nodes[operation.nodeId!].status, 'pending');
  assert.deepEqual(operation.events, events.slice(0, 1));
  const edited = cloneValue(events);
  edited[2].data = user('u2');
  edited[6].data.message = assistant('a2');
  const synced = syncSession(operation.tree, header, edited, { mountParentId: operation.mountParentId });
  assert.equal(synced.rootChildren.length, 2);
  assert.equal(getActivePath(synced)[0].id, operation.nodeId);
  assert.equal(synced.nodes[operation.nodeId!].status, 'dispatched');
  assert.deepEqual(exportSession(selectNode(synced, oldUser.id)).events, events);
  assert.deepEqual(exportSession(synced).events, edited);
});

test('实时同步把未完成事件段扩展为完整消息，不重复已有用户节点', () => {
  const events = log();
  const partial = importSession(header, events.slice(0, 6));
  const userId = partial.activeNodeId;
  const complete = syncSession(partial, header, events);
  assert.equal(complete.rootChildren.length, 1);
  assert.equal(getActivePath(complete)[0].id, userId);
  assert.deepEqual(exportSession(complete).events, events);
  const again = syncSession(complete, header, events);
  assert.deepEqual(again.nodes, complete.nodes);
});

test('分支导出重映射官方引用且保留不相关数字', () => {
  const events = log();
  events.push({ seq: 11, time: 30, type: 'developer/message', data: { turn: 0, step: 0, headerSeq: 4, message: { role: 'developer', id: 'dev', content: [], source: { kind: 'example' } }, unrelatedSeq: 4 }, surfaceOp: 'append' });
  events.push({ seq: 12, time: 31, type: 'user/message', data: { ...user('summary'), source: { kind: 'compaction' } }, sourceEventSeqs: [2], surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } });
  const tree = importSession(header, events);
  const path = getActivePath(tree);
  const all = [...(path[0].rootPrefixEvents ?? tree.prefixEvents), ...path.flatMap((node) => node.events), ...(path.at(-1)!.tailEvents ?? [])];
  for (const event of all) {
    event.seq += 20;
    if (event.sourceEventSeqs) {
      event.sourceEventSeqs = event.sourceEventSeqs.map((seq) => seq + 20);
    }
    if (typeof event.surfaceOp === 'object') {
      event.surfaceOp.startSeq += 20;
      event.surfaceOp.endSeq += 20;
    }
    if (event.type === 'developer/message') {
      event.data.headerSeq = Number(event.data.headerSeq) + 20;
    }
  }
  assert.deepEqual(exportSession(tree).events, events);
  tree.nodes[tree.activeNodeId!].tailEvents!.at(-1)!.sourceEventSeqs = [999];
  assert.throws(() => exportSession(tree), /当前路径之外/);
});

test('继承标记恢复精确前缀，未知事件保持独立序号', () => {
  const events = log();
  events.push({ seq: events.length, time: 40, type: 'session/end-seed', data: { inherited: true } });
  const seeded = { ...header, isSeeded: true };
  assert.equal(exportSession(importSession(seeded, events)).inheritedEventCount, events.length - 1);
  const tree = importSession(seeded, events);
  const parentId = getActivePath(tree)[0].id;
  assert.equal(exportSession(tree, parentId).inheritedEventCount, exportSession(tree, parentId).events.length);
});

test('逐事件同步保存临时尾段并在消息产生后归入分支', () => {
  const events = log();
  let tree = importSession(header, []);
  for (let count = 1; count <= events.length; count += 1) {
    tree = syncSession(tree, header, events.slice(0, count));
    assert.deepEqual(exportSession(tree).events, events.slice(0, count));
    assert.deepEqual(parseTreeDocument(tree), tree);
  }
  assert.deepEqual(getActivePath(tree).map((node) => node.messageId), ['u1', 'a1']);
  assert.equal(Object.keys(tree.nodes).length, 2);
});

test('已有兄弟时逐事件重试不修改父事件或重复用户节点', () => {
  const events = log();
  const original = importSession(header, events);
  const [parent, previous] = getActivePath(original);
  const operation = retryNode(original, previous.id);
  const replacement = cloneValue(events);
  replacement[6].data.message = assistant('retry');
  let tree = operation.tree;
  for (let count = operation.events.length + 1; count <= replacement.length; count += 1) {
    tree = syncSession(tree, header, replacement.slice(0, count), { mountParentId: parent.id });
    assert.deepEqual(exportSession(tree).events, replacement.slice(0, count));
  }
  assert.equal(tree.rootChildren.length, 1);
  assert.equal(tree.nodes[parent.id].children.length, 2);
  assert.deepEqual(exportSession(selectNode(tree, previous.id)).events, events);
});

test('多步重试和软撤回保留上一步工具结果，编辑保留上一轮结束', () => {
  const events = log().slice(0, 10);
  events.push(
    { seq: 10, time: 30, type: 'step/start', data: { turn: 0, step: 1 } },
    { seq: 11, time: 31, type: 'assistant/message', surfaceOp: 'append', data: { turn: 0, step: 1, message: assistant('a2'), stream: [] } },
    { seq: 12, time: 32, type: 'step/end', data: { turn: 0, step: 1 } },
    { seq: 13, time: 33, type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
    { seq: 14, time: 34, type: 'turn/start', data: { turn: 1 } },
    { seq: 15, time: 35, type: 'user/message', surfaceOp: 'append', data: user('u2') },
  );
  let tree = importSession(header, []);
  for (let count = 1; count <= events.length; count += 1) {
    tree = syncSession(tree, header, events.slice(0, count));
  }
  const path = getActivePath(tree);
  assert.equal(path.length, 4);
  assert.deepEqual(retryNode(tree, path[2].id).events, events.slice(0, 10));
  const rewound = softRewind(tree, path[2].id);
  assert.deepEqual(exportSession(rewound).events, events.slice(0, 10));
  assert.deepEqual(parseTreeDocument(rewound), rewound);
  assert.deepEqual(editUserNode(tree, path[3].id, user('edited')).events, events.slice(0, 14));
  assert.deepEqual(exportSession(selectNode(rewound, path[2].id)).events, events);
});

test('根前缀变化按根分支保存，旧日志仍可导出', () => {
  const events = log();
  const original = importSession(header, events);
  const oldRoot = original.rootChildren[0];
  const changed = cloneValue(events);
  changed[0].data = { unknown: ['changed'] };
  const next = syncSession(original, header, changed);
  assert.deepEqual(exportSession(next).events, changed);
  assert.deepEqual(exportSession(selectNode(next, oldRoot)).events, events);
});

test('截断后普通同步创建新用户兄弟并保留原后代', () => {
  const events = log();
  const original = importSession(header, events);
  const oldRoot = original.rootChildren[0];
  let tree = softRewind(original, oldRoot);
  const prefix = exportSession(tree).events;
  tree = syncSession(tree, header, prefix);
  const replacement = cloneValue(events);
  replacement[2].data = user('new-user');
  replacement[6].data.message = assistant('new-answer');
  for (let count = prefix.length + 1; count <= replacement.length; count += 1) {
    tree = syncSession(tree, header, replacement.slice(0, count));
    assert.deepEqual(exportSession(tree).events, replacement.slice(0, count));
    assert.deepEqual(parseTreeDocument(tree), tree);
  }
  assert.equal(tree.rootChildren.length, 2);
  assert.equal(getActivePath(tree)[0].messageId, 'new-user');
  assert.deepEqual(exportSession(selectNode(tree, oldRoot)).events, events);
});

test('编辑根消息的pending身份在截断事件回调后仍可领取', () => {
  const events = log();
  const original = importSession(header, events);
  const operation = editUserNode(original, original.rootChildren[0], user('edited-root'));
  let tree = syncSession(operation.tree, header, operation.events);
  const replacement = cloneValue(events);
  replacement[2].data = user('edited-root');
  replacement[6].data.message = assistant('edited-answer');
  for (let count = operation.events.length + 1; count <= replacement.length; count += 1) {
    tree = syncSession(tree, header, replacement.slice(0, count));
  }
  assert.equal(tree.rootChildren.length, 2);
  assert.equal(getActivePath(tree)[0].id, operation.nodeId);
  assert.deepEqual(parseTreeDocument(tree), tree);
});

test('pending和claimed根消息在领取前新增请求事件后保持节点身份', () => {
  for (const status of ['pending', 'claimed'] as const) {
    const events = log();
    const original = importSession(header, events);
    const oldRoot = original.rootChildren[0];
    const operation = editUserNode(original, oldRoot, user('queued-root'));
    let tree = operation.tree;
    tree.nodes[operation.nodeId!].status = status;
    const replacement = cloneValue(events);
    replacement[2].data = user('queued-root');
    replacement[6].data.message = assistant('queued-answer');
    replacement.unshift({ seq: 0, time: 0, type: 'request/model', data: { model: 'foo' } });
    replacement.forEach((event, seq) => { event.seq = seq; });
    for (let count = 1; count <= replacement.length; count += 1) {
      tree = syncSession(tree, header, replacement.slice(0, count));
      assert.deepEqual(parseTreeDocument(tree), tree);
      assert.deepEqual(exportSession(tree).events, replacement.slice(0, count));
    }
    assert.equal(tree.rootChildren.length, 2);
    assert.equal(getActivePath(tree)[0].id, operation.nodeId);
    assert.equal(tree.nodes[operation.nodeId!].status, 'dispatched');
    assert.deepEqual(tree.nodes[operation.nodeId!].rootPrefixEvents, replacement.slice(0, 2));
    assert.deepEqual(exportSession(selectNode(tree, oldRoot)).events, events);
  }
});

test('不同分支相同seq的来源与替换范围只解析所选路径', () => {
  const events = log();
  events.push({ seq: 11, time: 30, type: 'user/message', data: { ...user('summary-old'), source: { kind: 'compaction' } }, surfaceOp: { op: 'replace', startSeq: 6, endSeq: 8 }, sourceEventSeqs: [6, 8] });
  const original = importSession(header, events);
  const [parent, oldAssistant] = getActivePath(original);
  const operation = retryNode(original, oldAssistant.id);
  const replacement = cloneValue(events);
  replacement[6].data.message = assistant('other-answer');
  replacement[8].data.message = { ...(replacement[8].data.message as Record<string, unknown>), id: 'other-tool' };
  replacement[11].data = { ...user('summary-new'), source: { kind: 'compaction' } };
  let tree = operation.tree;
  for (let count = operation.events.length + 1; count <= replacement.length; count += 1) {
    tree = syncSession(tree, header, replacement.slice(0, count));
  }
  assert.equal(tree.nodes[parent.id].children.length, 2);
  assert.deepEqual(exportSession(tree).events, replacement);
  assert.deepEqual(exportSession(selectNode(tree, oldAssistant.id)).events, events);
});

test('损坏序号、引用和不匹配的挂载前缀被拒绝', () => {
  const events = log();
  const broken = cloneValue(events);
  broken[3].seq += 1;
  assert.throws(() => importSession(header, broken), /序号/);
  const future = cloneValue(events);
  future[2].sourceEventSeqs = [3];
  assert.throws(() => importSession(header, future), /来源/);
  const tree = importSession(header, events);
  const parent = getActivePath(tree)[0];
  const replacement = cloneValue(events);
  replacement[2].data = user('other');
  assert.throws(() => syncSession(tree, header, replacement, { mountParentId: parent.id }), /前缀/);
});
