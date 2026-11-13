import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { SessionHostError, type CordisContext, type HostAPI } from '@dsh-plugin/dsh-loader';
import { parseMutation, TreeError } from './protocol.js';
import { TreeFiles } from './storage.js';
import { SessionTrees } from './session-trees.js';

export const name = '@dsh-plugin/dsh-session-tree';
export const inject = ['dshLoader', 'sessions', 'agents', 'sessionController', 'sessionPersistence', 'llm', 'connection', 'attachments'];

/** 插件存储位于独立数据目录；请求上限包含图片的 base64 编码。 */
export interface Config {
  dataDirectory?: string;
  maxRequestBytes?: number;
}

interface Connection {
  authorizeIndex(request: IncomingMessage, response: ServerResponse): boolean;
}
interface Attachments {
  readImage(reference: Record<string, unknown>, signal?: AbortSignal): Promise<{ data: Uint8Array }>;
  readFileStream(reference: Record<string, unknown>, signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage, maximum: number): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    throw new TreeError('content-type', '请使用 JSON 请求。', 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) {
      throw new TreeError('request-too-large', '消息内容超过插件配置的请求大小上限。', 413);
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new TreeError('invalid-json', `请求不是有效 JSON：${error instanceof Error ? error.message : String(error)}`, 400);
  }
}

/** 以官方鉴权保护树操作，插件只接受会话身份和节点身份。 */
export async function apply(ctx: CordisContext, config: Config = {}): Promise<void> {
  const loader = ctx.get('dshLoader') as HostAPI;
  const maximum = config.maxRequestBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new Error('maxRequestBytes 必须是正整数。');
  }
  const configuredHome = process.env.DSH_HOME?.trim();
  const home = configuredHome ? resolve(configuredHome.startsWith('~') ? join(homedir(), configuredHome.slice(1)) : configuredHome) : join(homedir(), '.dsh');
  const files = new TreeFiles(config.dataDirectory ?? join(home, 'data', 'dsh-session-tree', 'sessions'));
  await loader.sessions.ready;
  const report = (message: string, error: unknown) => {
    if (ctx.logger?.error) {
      ctx.logger.error(message, error);
    } else {
      console.error(`[dsh-session-tree] ${message}`, error);
    }
  };
  const trees = new SessionTrees(loader, files, report);
  const connection = ctx.get('connection') as Connection;
  const attachments = ctx.get('attachments') as Attachments;
  const requests = new Set<Promise<void>>();
  const aborts = new Set<AbortController>();
  const off = loader.web.register('/_dsh/session-tree', (request: IncomingMessage, response: ServerResponse) => {
    const task = (async () => {
      if (!connection.authorizeIndex(request, response)) {
        return;
      }
      const origin = request.headers.origin;
      if (request.headers['sec-fetch-site'] === 'cross-site' || (origin && new URL(origin).host !== request.headers.host)) {
        throw new TreeError('forbidden', '拒绝跨站会话修改。', 403);
      }
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const match = /^\/_dsh\/session-tree\/([^/]+)(?:\/(select|edit|retry|recall)|\/draft\/([A-Za-z0-9_-]{8,128})\/(\d+))?$/.exec(path);
      if (!match) {
        throw new TreeError('not-found', '会话树接口不存在。', 404);
      }
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(match[1]);
      } catch {
        throw new TreeError('invalid-session', '会话 ID 编码无效。', 400);
      }
      if (sessionId.length === 0 || sessionId.length > 512 || /[\\/\u0000]/.test(sessionId)) {
        throw new TreeError('invalid-session', '会话 ID 无效。', 400);
      }
      if (match[3]) {
        if (request.method !== 'GET') {
          throw new TreeError('method-not-allowed', '附件下载只接受 GET。', 405);
        }
        const block = await trees.draftAttachment(sessionId, match[3], Number(match[4]));
        const reference = block.attachment as Record<string, unknown>;
        const controller = new AbortController();
        aborts.add(controller);
        const cancel = () => { controller.abort(); };
        response.once('close', cancel);
        try {
          response.setHeader('content-type', block.type === 'image' ? String(reference.mediaType) : 'application/octet-stream');
          response.setHeader('cache-control', 'no-store');
          response.setHeader('x-content-type-options', 'nosniff');
          response.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(String(reference.name ?? 'image.png'))}`);
          if (block.type === 'image') {
            const result = await attachments.readImage(reference, controller.signal);
            response.end(Buffer.from(result.data));
          } else {
            for await (const chunk of attachments.readFileStream(reference, controller.signal)) {
              if (!response.write(chunk)) {
                await once(response, 'drain', { signal: controller.signal });
              }
            }
            response.end();
          }
        } finally {
          response.removeListener('close', cancel);
          aborts.delete(controller);
        }
        return;
      }
      if (!match[2] && request.method === 'GET') {
        json(response, 200, { ok: true, value: await trees.read(sessionId) });
        return;
      }
      if (!match[2] || request.method !== 'POST') {
        throw new TreeError('method-not-allowed', '修改会话树需要使用 POST。', 405);
      }
      const action = match[2] as 'select' | 'edit' | 'retry' | 'recall';
      const input = parseMutation(await body(request, maximum));
      const result = await trees.mutate(sessionId, action, input);
      json(response, 200, { ok: true, ...result });
    })().catch(error => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        report('会话树响应在传输期间失败。', error);
        return;
      }
      const expected = error instanceof TreeError || error instanceof SessionHostError;
      const status = error instanceof TreeError ? error.status : error instanceof SessionHostError ? 409 : 500;
      if (!expected) {
        report('会话树接口执行失败。', error);
      }
      json(response, status, {
        ok: false,
        error: { code: expected ? error.code : 'internal-error', message: error instanceof Error ? error.message : String(error) },
      });
    });
    requests.add(task);
    void task.finally(() => { requests.delete(task); });
    return task;
  });
  ctx.effect(() => () => {
    off();
    for (const controller of aborts) {
      controller.abort();
    }
    return Promise.all([...requests]).then(() => trees.dispose());
  });
}
