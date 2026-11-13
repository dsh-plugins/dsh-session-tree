import { isRecord, type SessionEvent, type SessionHeader } from './tree.js';

/** 恢复比较使用完整头、事件前缀和继承边界，避免仅按日志长度判断。 */
export interface RecoverySnapshot {
  readonly header: SessionHeader;
  readonly events: readonly SessionEvent[];
  readonly inheritedEventCount: number;
}

/** official-written 必须在官方替换成功后持久化，写入前只能记录 prepared。 */
export type RecoveryStage = 'prepared' | 'official-written';

/** 调用者据此保留事务文件，等待检查冲突，禁止自动覆盖任一侧。 */
export class RecoveryConflictError extends Error {
  constructor(readonly reason: 'invalid' | 'ambiguous' | 'mismatch', message: string) {
    super(message);
    this.name = 'RecoveryConflictError';
  }
}

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equalJson(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
      && keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]));
  }
  return false;
}

function matchesPrefix(base: RecoverySnapshot, current: RecoverySnapshot): boolean {
  return equalJson(base.header, current.header)
    && base.inheritedEventCount === current.inheritedEventCount
    && base.events.length <= current.events.length
    && base.events.every((event, index) => equalJson(event, current.events[index]));
}

/**
 * 只在日志和持久化阶段能够唯一确定提交侧时恢复。
 * 两侧同时匹配时，精确匹配也无法证明是否发生过截断和重新追加，必须保留冲突。
 */
export function chooseTransactionRecovery(
  before: RecoverySnapshot,
  after: RecoverySnapshot,
  current: RecoverySnapshot,
  stage: RecoveryStage = 'prepared',
): 'before' | 'after' {
  if (stage !== 'prepared' && stage !== 'official-written') {
    throw new RecoveryConflictError('invalid', '事务写入阶段无效');
  }
  for (const snapshot of [before, after, current]) {
    if (!isRecord(snapshot) || !isRecord(snapshot.header) || typeof snapshot.header.id !== 'string'
      || !Array.isArray(snapshot.events) || !Number.isSafeInteger(snapshot.inheritedEventCount)
      || snapshot.inheritedEventCount < 0 || snapshot.inheritedEventCount > snapshot.events.length) {
      throw new RecoveryConflictError('invalid', '事务恢复快照或继承边界无效');
    }
  }
  if (before.header.id !== after.header.id || before.header.id !== current.header.id) {
    throw new RecoveryConflictError('invalid', '事务恢复快照属于不同会话');
  }
  const beforeMatches = matchesPrefix(before, current);
  const afterMatches = matchesPrefix(after, current);
  if (stage === 'official-written') {
    if (afterMatches) {
      return 'after';
    }
    throw new RecoveryConflictError('mismatch', '官方写入已确认，但当前日志与提交后快照不一致');
  }
  if (beforeMatches && afterMatches) {
    throw new RecoveryConflictError('ambiguous', '当前日志同时匹配事务前后两侧，缺少官方写入完成记录');
  }
  if (beforeMatches) {
    return 'before';
  }
  if (afterMatches) {
    return 'after';
  }
  throw new RecoveryConflictError('mismatch', '当前日志与事务前后快照均不一致');
}
