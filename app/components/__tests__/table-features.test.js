/**
 * TanStack Table v9 特性化 API 的回归守卫。
 *
 * v9 把行/列方法按「特性」拆分发，`row.getVisibleCells` 属于 columnVisibilityFeature。
 * 只写 `tableFeatures({})` 时该方法根本不存在，运行时报
 *   TypeError: row.getVisibleCells is not a function
 * 而这个错误构建期发现不了（只有真正渲染出表格行才会触发），所以在测试里锁死。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { columnVisibilityFeature, tableFeatures, useTable } from '@tanstack/react-table';

const COMPONENTS_DIR = resolve(import.meta.dirname, '..');

const walkComponents = (dir) => {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      files.push(...walkComponents(full));
    } else if (entry.endsWith('.jsx')) {
      files.push(full);
    }
  }
  return files;
};

/** 用真实的 useTable 跑一次 SSR，返回该 features 下行方法的类型 */
const probeRowApis = (features) => {
  let seen = null;
  function Probe() {
    const table = useTable({
      data: [{ a: 1 }],
      columns: [{ accessorKey: 'a', header: 'A', cell: (c) => c.getValue() }],
      features
    });
    const row = table.getRowModel().rows[0];
    seen = { visible: typeof row.getVisibleCells, all: typeof row.getAllCells };
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  return seen;
};

describe('TanStack Table v9 · features 与 row API', () => {
  it('空 features 下 getVisibleCells 不存在（这就是线上那个报错的成因）', () => {
    const { visible, all } = probeRowApis(tableFeatures({}));
    assert.equal(visible, 'undefined');
    // 核心特性总是注册，所以 getAllCells 永远可用
    assert.equal(all, 'function');
  });

  it('注册 columnVisibilityFeature 后 getVisibleCells 可用', () => {
    const { visible } = probeRowApis(tableFeatures({ columnVisibilityFeature }));
    assert.equal(visible, 'function');
  });

  it('凡是调用 row.getVisibleCells 的组件都必须注册 columnVisibilityFeature', () => {
    const offenders = walkComponents(COMPONENTS_DIR)
      .filter((file) => readFileSync(file, 'utf8').includes('getVisibleCells'))
      .filter((file) => !readFileSync(file, 'utf8').includes('columnVisibilityFeature'))
      .map((file) => relative(COMPONENTS_DIR, file));

    assert.deepEqual(
      offenders,
      [],
      `以下组件使用了 row.getVisibleCells 但未注册 columnVisibilityFeature：${offenders.join(', ')}`
    );
  });
});
