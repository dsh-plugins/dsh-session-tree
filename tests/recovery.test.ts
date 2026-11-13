import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseTransactionRecovery, RecoveryConflictError, type RecoverySnapshot } from '../src/recovery.js';

function snapshot(types: string[], inheritedEventCount = 0): RecoverySnapshot {
  return {
    header: { version: 4, id: 'example', createdAt: 0, isSeeded: inheritedEventCount > 0 },
    events: types.map((type, seq) => ({ seq, time: seq, type, data: {} })),
    inheritedEventCount,
  };
}

function conflict(reason: RecoveryConflictError['reason']): (error: unknown) => boolean {
  return (error) => error instanceof RecoveryConflictError && error.reason === reason;
}

test('互不为前缀的事务可按精确快照恢复对应侧', () => {
  const before = snapshot(['user/message', 'assistant/message']);
  const after = snapshot(['user/message', 'assistant/attempt']);
  assert.equal(chooseTransactionRecovery(before, after, before), 'before');
  assert.equal(chooseTransactionRecovery(before, after, after), 'after');
});

test('恢复允许唯一匹配侧追加生命周期或后续消息', () => {
  const before = snapshot(['user/message', 'assistant/message']);
  const after = snapshot(['user/message', 'assistant/attempt']);
  assert.equal(chooseTransactionRecovery(before, after, snapshot(['user/message', 'assistant/message', 'turn/end'])), 'before');
  assert.equal(chooseTransactionRecovery(before, after, snapshot(['user/message', 'assistant/attempt', 'session/end-seed'])), 'after');
});

test('截断后的短前缀不能覆盖精确匹配before的歧义', () => {
  const before = snapshot(['user/message', 'assistant/message']);
  const after = snapshot(['user/message']);
  assert.throws(() => chooseTransactionRecovery(before, after, before), conflict('ambiguous'));
  assert.throws(() => chooseTransactionRecovery(before, after, snapshot(['user/message', 'assistant/message', 'turn/end'])), conflict('ambiguous'));
  assert.equal(chooseTransactionRecovery(before, after, after), 'after');
});

test('写入完成记录能判定resume追加后同时匹配长短前缀的日志', () => {
  const after = snapshot(['user/message']);
  const before = snapshot(['user/message', 'session/end-seed']);
  const resumed = snapshot(['user/message', 'session/end-seed', 'turn/start']);
  assert.throws(() => chooseTransactionRecovery(before, after, resumed), conflict('ambiguous'));
  assert.equal(chooseTransactionRecovery(before, after, resumed, 'official-written'), 'after');
});

test('提交后日志是before的扩展时也必须识别两侧歧义', () => {
  const before = snapshot(['user/message']);
  const after = snapshot(['user/message', 'assistant/message']);
  assert.throws(() => chooseTransactionRecovery(before, after, after), conflict('ambiguous'));
  assert.equal(chooseTransactionRecovery(before, after, after, 'official-written'), 'after');
});

test('相同官方日志无法区分只改变树游标的事务提交状态', () => {
  const same = snapshot(['user/message']);
  assert.throws(() => chooseTransactionRecovery(same, same, same), conflict('ambiguous'));
  assert.equal(chooseTransactionRecovery(same, same, same, 'official-written'), 'after');
});

test('写入完成后遇到旧日志必须保留冲突而不能回滚', () => {
  const before = snapshot(['user/message', 'assistant/message']);
  const after = snapshot(['user/message', 'assistant/attempt']);
  assert.throws(() => chooseTransactionRecovery(before, after, before, 'official-written'), conflict('mismatch'));
});

test('JSON对象键顺序不影响快照比较，扩展字段参与判断', () => {
  const before = snapshot(['user/message']);
  const after = snapshot(['assistant/message']);
  const current: RecoverySnapshot = {
    inheritedEventCount: 0,
    events: [{ data: {}, type: 'user/message', time: 0, seq: 0 }],
    header: { isSeeded: false, createdAt: 0, id: 'example', version: 4 },
  };
  assert.equal(chooseTransactionRecovery(before, after, current), 'before');
  const changed = { ...current, header: { ...current.header, extension: 'changed' } };
  assert.throws(() => chooseTransactionRecovery(before, after, changed), conflict('mismatch'));
});

test('继承边界是快照身份的一部分，不能仅比较事件', () => {
  const before = snapshot(['user/message', 'session/end-seed'], 1);
  const after = { ...before, inheritedEventCount: 2 };
  assert.equal(chooseTransactionRecovery(before, after, before), 'before');
  assert.equal(chooseTransactionRecovery(before, after, after), 'after');
});

test('不同会话、越界继承数和无匹配日志均拒绝恢复', () => {
  const before = snapshot(['user/message']);
  const after = snapshot(['assistant/message']);
  const other = { ...before, header: { ...before.header, id: 'other' } };
  assert.throws(() => chooseTransactionRecovery(before, after, other), conflict('invalid'));
  assert.throws(() => chooseTransactionRecovery(before, { ...after, inheritedEventCount: 2 }, before), conflict('invalid'));
  assert.throws(() => chooseTransactionRecovery(before, after, snapshot(['turn/start'])), conflict('mismatch'));
});
