#!/usr/bin/env node
/** 从 npm 官方注册表保存本包 latest 元数据，同版本重复运行不会产生差异。 */
import { readFileSync, writeFileSync } from 'node:fs';

const registry = (process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

async function readMetadata(path) {
  const response = await fetch(`${registry}/${path}`, {
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`读取 ${pkg.name} 的 npm 元数据失败：HTTP ${response.status} (${path})`);
  }
  return response.json();
}

const tags = await readMetadata(`-/package/${pkg.name}/dist-tags`);
if (typeof tags.latest !== 'string' || !tags.latest) {
  throw new Error(`${pkg.name} 缺少 latest 标签`);
}
const encodedName = pkg.name.replace('/', '%2f');
const [version, metadata] = await Promise.all([
  readMetadata(`${encodedName}/${encodeURIComponent(tags.latest)}`),
  readMetadata(encodedName),
]);
if (version.name !== pkg.name || version.version !== tags.latest
  || typeof version.dist?.tarball !== 'string' || typeof version.dist?.integrity !== 'string'
  || typeof metadata.time?.[tags.latest] !== 'string') {
  throw new Error(`${pkg.name}@${tags.latest} 的版本、发布时间或分发信息缺失`);
}
const dump = {
  name: pkg.name,
  latest: tags.latest,
  publishedAt: metadata.time[tags.latest],
  dist: {
    tarball: version.dist.tarball,
    integrity: version.dist.integrity,
    unpackedSize: version.dist.unpackedSize ?? null,
  },
};
writeFileSync(new URL('../npm-latest.json', import.meta.url), `${JSON.stringify(dump, null, 2)}\n`);
console.log(`已更新 npm-latest.json：${pkg.name}@${tags.latest}`);
