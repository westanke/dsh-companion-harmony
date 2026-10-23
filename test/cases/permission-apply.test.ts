/**
 * PermissionApply 纯函数用例 —— 新建会话时「是否该应用权限档」的判定。
 *
 * 核心断言：
 * 1. null / undefined / 空串 / 全空白 → 不应用
 * 2. 非空白 → 应用
 * 3. normalizePermissionId：null/空白 → ''，否则 trim 后原值
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBlankPermission, shouldApplyPermission, normalizePermissionId,
} from '../../entry/src/main/ets/core/PermissionApply';

describe('PermissionApply', () => {

  describe('isBlankPermission', () => {
    it('null → true', () => {
      assert.equal(isBlankPermission(null), true);
    });

    it('undefined → true', () => {
      assert.equal(isBlankPermission(undefined), true);
    });

    it('空串 → true', () => {
      assert.equal(isBlankPermission(''), true);
    });

    it('全空格 → true', () => {
      assert.equal(isBlankPermission('   '), true);
    });

    it('制表符/换行 → true', () => {
      assert.equal(isBlankPermission('\t\n '), true);
    });

    it('非空白 → false', () => {
      assert.equal(isBlankPermission('full'), false);
      assert.equal(isBlankPermission('  ask  '), false);
    });
  });

  describe('shouldApplyPermission', () => {
    it('null → false', () => {
      assert.equal(shouldApplyPermission(null), false);
    });

    it('undefined → false', () => {
      assert.equal(shouldApplyPermission(undefined), false);
    });

    it('空串 → false', () => {
      assert.equal(shouldApplyPermission(''), false);
    });

    it('全空白 → false', () => {
      assert.equal(shouldApplyPermission('   '), false);
    });

    it('有效档位 id → true', () => {
      assert.equal(shouldApplyPermission('full'), true);
      assert.equal(shouldApplyPermission('ask'), true);
    });

    it('前后空白的有效值 → true（trim 后非空）', () => {
      assert.equal(shouldApplyPermission('  full  '), true);
    });
  });

  describe('normalizePermissionId', () => {
    it('null → 空串', () => {
      assert.equal(normalizePermissionId(null), '');
    });

    it('undefined → 空串', () => {
      assert.equal(normalizePermissionId(undefined), '');
    });

    it('空串 → 空串', () => {
      assert.equal(normalizePermissionId(''), '');
    });

    it('全空白 → 空串', () => {
      assert.equal(normalizePermissionId('   '), '');
    });

    it('有效值返回原值（不 trim）', () => {
      assert.equal(normalizePermissionId('full'), 'full');
    });

    it('前后空白会被 trim', () => {
      assert.equal(normalizePermissionId('  ask  '), 'ask');
    });
  });

  describe('shouldApply × normalize 组合（建完再切纪律）', () => {
    it('不指定时既不应用也不发命令', () => {
      const p: string | null = null;
      assert.equal(shouldApplyPermission(p), false);
      // 即使误调用 normalize 也得到空串，不会发出 `/permission ` 空命令
      assert.equal(normalizePermissionId(p), '');
    });

    it('指定时应用 + id 规范化后可拼命令', () => {
      const p: string = '  full  ';
      assert.equal(shouldApplyPermission(p), true);
      assert.equal(normalizePermissionId(p), 'full');
    });
  });
});
