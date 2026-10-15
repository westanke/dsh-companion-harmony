import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatQuestion, QuestionOption } from '../../entry/src/main/ets/core/Models.ts';
import {
  allAnswered, buildAnswers, isAnswered,
} from '../../entry/src/main/ets/core/QuestionAnswers.ts';

/**
 * 问答卡的两条纯逻辑 —— 逐条对应原工程 `QuestionAnswerTest.kt`。
 *
 * 为什么值得单独测：这两条规则一旦错，**表现是安静的** —— 提交按钮永远点不亮，
 * 用户只会以为卡了；答案收错了服务端也不报错，只会把错的答案记下来。
 */

function choice(id: string, ...labels: string[]): ChatQuestion {
  const q: ChatQuestion = new ChatQuestion();
  q.id = id;
  q.question = `q-${id}`;
  q.options = labels.map((label: string): QuestionOption => {
    const option: QuestionOption = new QuestionOption();
    option.label = label;
    return option;
  });
  return q;
}

function freeText(id: string): ChatQuestion {
  const q: ChatQuestion = new ChatQuestion();
  q.id = id;
  q.question = `q-${id}`;
  return q;
}

// ── isAnswered ──

test('选项题至少要选中一个', () => {
  const q: ChatQuestion = choice('q1', 'A', 'B');
  assert.equal(isAnswered(q, new Set<string>(['A']), ''), true);
  assert.equal(isAnswered(q, new Set<string>(), ''), false);
  // 有选项的题**不看** custom —— 界面也不会给它自由文本框。
  assert.equal(isAnswered(q, new Set<string>(), '我自己写'), false);
});

test('自由文本题只看 custom', () => {
  const q: ChatQuestion = freeText('q1');
  assert.equal(isAnswered(q, new Set<string>(), '写点什么'), true);
  // 全是空白不算答 —— 否则提交上去就是一个空答案。
  assert.equal(isAnswered(q, new Set<string>(), '   \n  '), false);
  assert.equal(isAnswered(q, new Set<string>(), ''), false);
});

// ── buildAnswers ──

test('每道题都按原顺序回带，id 原样保留', () => {
  const answers = buildAnswers(
    [choice('q1', 'A'), freeText('q2')],
    new Map<string, Set<string>>([['q1', new Set<string>(['A'])]]),
    new Map<string, string>([['q2', '补一句']]),
  );
  assert.deepEqual(answers.map((a) => a.id), ['q1', 'q2']);
  assert.deepEqual(answers[0].selected, ['A']);
  assert.equal(answers[1].custom, '补一句');
});

test('回传顺序按选项原顺序，不按点选顺序', () => {
  // 集合没有顺序，setOf("C","A") 只是「两个都选了」；回传必须按选项原顺序，
  // 否则同一份勾选每次提交的顺序都可能不同。
  const answers = buildAnswers(
    [choice('q1', 'A', 'B', 'C')],
    new Map<string, Set<string>>([['q1', new Set<string>(['C', 'A'])]]),
    new Map<string, string>(),
  );
  assert.deepEqual(answers[0].selected, ['A', 'C']);
});

test('不存在的选择被丢弃', () => {
  const answers = buildAnswers(
    [choice('q1', 'A')],
    new Map<string, Set<string>>([['q1', new Set<string>(['A', '幽灵选项'])]]),
    new Map<string, string>(),
  );
  assert.deepEqual(answers[0].selected, ['A']);
});

test('自由文本题带空 selected + 去首尾空白的 custom', () => {
  const answers = buildAnswers(
    [freeText('q1')],
    new Map<string, Set<string>>(),
    new Map<string, string>([['q1', '  前后都有空白  ']]),
  );
  assert.deepEqual(answers[0].selected, []);
  assert.equal(answers[0].custom, '前后都有空白');
});

test('没填自由文本时 custom 是空串（序列化时该键消失）', () => {
  // QuestionAnswer.custom 默认空串，编码时等于默认值就**不写 custom 键**。
  const answers = buildAnswers(
    [choice('q1', 'A'), freeText('q2')],
    new Map<string, Set<string>>([['q1', new Set<string>(['A'])]]),
    new Map<string, string>([['q2', '   ']]),
  );
  assert.deepEqual(answers[0].selected, ['A']);
  assert.equal(answers[1].custom, '');
  // 钉住序列化结果：空 custom 不该出现在请求体里。
  assert.equal(answers[1].toJsonString(), '{"id":"q2","selected":[]}');
});

// ── allAnswered：界面「提交」键的启用条件 ──

test('整组题都答完才算答完', () => {
  const questions: ChatQuestion[] = [choice('q1', 'A', 'B'), freeText('q2')];
  assert.equal(allAnswered(questions, new Map<string, Set<string>>([['q1', new Set<string>(['A'])]]),
    new Map<string, string>([['q2', '说明']])), true);
  // 只答了第一题 → 还不能提交。
  assert.equal(allAnswered(questions, new Map<string, Set<string>>([['q1', new Set<string>(['A'])]]),
    new Map<string, string>()), false);
  // 一道题都没有 → 也不算答完（不该点亮一个空提交）。
  assert.equal(allAnswered([], new Map<string, Set<string>>(), new Map<string, string>()), false);
});

test('缺项按「未答」处理，不抛异常', () => {
  // 界面上理论上不会出现缺项，但这种输入不该炸 —— 炸在界面里就是白屏。
  assert.equal(allAnswered([choice('q1', 'A')], new Map<string, Set<string>>(),
    new Map<string, string>()), false);
  const answers = buildAnswers([choice('q1', 'A')], new Map<string, Set<string>>(),
    new Map<string, string>());
  assert.deepEqual(answers[0].selected, []);
});
