/**
 * AKTools baseUrl 解析单元测试
 *
 * 覆盖三种部署形态下的取值：
 *   1. 未设置环境变量（本地开发 / GitHub Pages 未配置）→ 内置默认地址
 *   2. 直接设置为真实地址（.env.local / GitHub Pages secret）→ 该地址，且去掉结尾斜杠
 *   3. Docker：构建期内联占位符、运行期 entrypoint 替换；
 *      未传该变量时替换结果为空串 → 必须回落默认地址，而不是变成空 baseUrl（会退化成相对路径请求）
 *
 * 运行：node --test app/providers/aktools/__tests__/config.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEY = 'NEXT_PUBLIC_AKTOOLS_BASE_URL';

/**
 * 在指定环境变量取值下加载 aktools-config。
 * 该模块在导入时求值 AKTOOLS_BASE_URL，故用查询串制造独立的模块实例。
 */
const loadWithEnv = async (value, tag) => {
  const saved = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    return await import(`../aktools-config.js?case=${tag}`);
  } finally {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  }
};

describe('AKTOOLS_BASE_URL 解析', () => {
  it('未设置 → 使用内置默认地址', async () => {
    const mod = await loadWithEnv(undefined, 'unset');
    assert.equal(mod.AKTOOLS_BASE_URL, mod.AKTOOLS_DEFAULT_BASE_URL);
    assert.ok(mod.AKTOOLS_BASE_URL.startsWith('http'));
  });

  it('空串（Docker 未传值时的替换结果）→ 回落默认地址', async () => {
    const mod = await loadWithEnv('', 'empty');
    assert.equal(mod.AKTOOLS_BASE_URL, mod.AKTOOLS_DEFAULT_BASE_URL);
  });

  it('纯空白 → 回落默认地址', async () => {
    const mod = await loadWithEnv('   ', 'blank');
    assert.equal(mod.AKTOOLS_BASE_URL, mod.AKTOOLS_DEFAULT_BASE_URL);
  });

  it('自定义地址 → 采用该地址', async () => {
    const mod = await loadWithEnv('https://my-aktools.example.com/api/public', 'custom');
    assert.equal(mod.AKTOOLS_BASE_URL, 'https://my-aktools.example.com/api/public');
  });

  it('去掉结尾斜杠（避免拼出 //endpoint）', async () => {
    const mod = await loadWithEnv('https://my-aktools.example.com/api/public///', 'slash');
    assert.equal(mod.AKTOOLS_BASE_URL, 'https://my-aktools.example.com/api/public');
  });

  it('未替换的占位符原样保留（便于排查漏配 entrypoint）', async () => {
    const mod = await loadWithEnv('__NEXT_PUBLIC_AKTOOLS_BASE_URL__', 'placeholder');
    assert.equal(mod.AKTOOLS_BASE_URL, '__NEXT_PUBLIC_AKTOOLS_BASE_URL__');
  });

  it('metadata.baseUrl 与实际使用的 baseUrl 一致', async () => {
    const mod = await loadWithEnv('https://my-aktools.example.com/api/public', 'meta');
    assert.equal(mod.AKTOOLS_METADATA.baseUrl, mod.AKTOOLS_BASE_URL);
  });
});
