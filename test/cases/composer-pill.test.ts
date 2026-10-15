import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComposerHint, composerHint } from '../../entry/src/main/ets/core/ComposerPill.ts';

/**
 * 单行药丸输入区里那条「看不见的规则」—— 逐条对应原工程 `ComposerPillTest.kt`。
 *
 * 「运行中回车会排队还是插话」原来是输入框下方单独一行文字，压进占位符之后那一行没了，
 * 占位符成了唯一说明。选错资源在屏幕上只是「一行小字不太对」，真机扫一眼很难发现。
 */

test('空闲时永远用普通占位符', () => {
  // 空闲时没有可插话的轮次，「繁忙时默认行为」设置不该影响占位符。
  assert.equal(composerHint(false, false), ComposerHint.IDLE);
  assert.equal(composerHint(false, true), ComposerHint.IDLE);
});

test('运行中且默认插话时用插话占位符', () => {
  assert.equal(composerHint(true, true), ComposerHint.RUNNING_STEER);
});

test('运行中且默认排队时用排队占位符', () => {
  assert.equal(composerHint(true, false), ComposerHint.RUNNING_QUEUE);
});
