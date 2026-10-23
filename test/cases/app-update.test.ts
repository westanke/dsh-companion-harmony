/**
 * AppUpdate 纯函数用例 —— 版本比较 + 渠道分流。
 *
 * 核心纪律：
 * 1. 语义化版本正确比较（主/次/修三级 + 预发布标签）
 * 2. zh* → Gitee，其他 → GitHub
 * 3. 格式宽容：前缀 v/V/version、短格式 1.0、预发布标签
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UpdateChannel, channelForLanguage, compareVersions, isUpdateAvailable, releasePageUrl,
} from '../../entry/src/main/ets/core/AppUpdate';

describe('AppUpdate', () => {

  describe('compareVersions 语义化版本比较', () => {

    it('主版本不同', () => {
      assert.ok(compareVersions('2.0.0', '1.0.0') > 0);
      assert.ok(compareVersions('1.0.0', '2.0.0') < 0);
    });

    it('次版本不同', () => {
      assert.ok(compareVersions('1.2.0', '1.1.0') > 0);
      assert.ok(compareVersions('1.1.0', '1.2.0') < 0);
    });

    it('修订号不同', () => {
      assert.ok(compareVersions('1.0.2', '1.0.1') > 0);
      assert.ok(compareVersions('1.0.1', '1.0.2') < 0);
    });

    it('相等', () => {
      assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
    });

    it('预发布标签 < 正式版', () => {
      assert.ok(compareVersions('1.0.0', '1.0.0-beta') > 0);
      assert.ok(compareVersions('1.0.0-alpha', '1.0.0') < 0);
    });

    it('同为预发布或正式版相等', () => {
      assert.equal(compareVersions('1.0.0-beta', '1.0.0-alpha'), 0);
    });

    it('前缀 v / V / version 宽容', () => {
      assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
      assert.equal(compareVersions('V1.2.3', '1.2.3'), 0);
      assert.equal(compareVersions('version1.2.3', '1.2.3'), 0);
    });

    it('短格式 1.0 补 patch=0', () => {
      assert.equal(compareVersions('1.0', '1.0.0'), 0);
      assert.ok(compareVersions('1.0', '1.0.1') < 0);
    });
  });

  describe('isUpdateAvailable', () => {

    it('有新版 → true', () => {
      assert.equal(isUpdateAvailable('1.0.0', '1.1.0'), true);
    });

    it('同版 → false', () => {
      assert.equal(isUpdateAvailable('1.0.0', '1.0.0'), false);
    });

    it('更旧版 → false', () => {
      assert.equal(isUpdateAvailable('2.0.0', '1.0.0'), false);
    });

    it('预发布标签不算更新（正式版 > 预发布）', () => {
      assert.equal(isUpdateAvailable('1.0.0', '1.0.0-beta'), false);
    });
  });

  describe('channelForLanguage 渠道分流', () => {

    it('zh-CN → Gitee', () => {
      assert.equal(channelForLanguage('zh-CN'), UpdateChannel.GITEE);
    });

    it('zh-TW → Gitee', () => {
      assert.equal(channelForLanguage('zh-TW'), UpdateChannel.GITEE);
    });

    it('zh-HK → Gitee', () => {
      assert.equal(channelForLanguage('zh-HK'), UpdateChannel.GITEE);
    });

    it('zh → Gitee', () => {
      assert.equal(channelForLanguage('zh'), UpdateChannel.GITEE);
    });

    it('en-US → GitHub', () => {
      assert.equal(channelForLanguage('en-US'), UpdateChannel.GITHUB);
    });

    it('ja-JP → GitHub', () => {
      assert.equal(channelForLanguage('ja-JP'), UpdateChannel.GITHUB);
    });

    it('ko-KR → GitHub', () => {
      assert.equal(channelForLanguage('ko-KR'), UpdateChannel.GITHUB);
    });

    it('null → GitHub（默认更广泛可用）', () => {
      assert.equal(channelForLanguage(null), UpdateChannel.GITHUB);
    });
  });

  describe('releasePageUrl', () => {

    it('Gitee → gitee.com/westanke', () => {
      const url: string = releasePageUrl(UpdateChannel.GITEE);
      assert.ok(url.includes('gitee.com'));
      assert.ok(url.includes('/westanke/'));
    });

    it('GitHub → github.com/westanke', () => {
      const url: string = releasePageUrl(UpdateChannel.GITHUB);
      assert.ok(url.includes('github.com'));
      assert.ok(url.includes('/westanke/'));
    });
  });
});
