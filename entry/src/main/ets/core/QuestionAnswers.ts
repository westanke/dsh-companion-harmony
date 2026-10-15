/**
 * 待答问题卡片的两个纯函数 —— 移植自原工程 `ui/ChatScreen.kt` 里那两个
 * `internal fun`（对应上游的 `QuestionAnswerTest`）。
 *
 * 为什么从界面里抠出来单测：
 *
 * - [isAnswered] 是提交按钮启用条件对**所有题取与**的结果。其中「没有选项的题只看
 *   自由文本」这条最容易在改动里被漏掉 —— 漏了的表现是按钮永远点不亮，
 *   而界面上不会报任何错。
 * - [buildAnswers] 决定请求体里带什么。两条规则都有沉默失败面：选项顺序被点选顺序
 *   污染，或者没选项的题把 `custom` 漏掉（服务端会收到一道空答案）。
 */

import { ChatQuestion, QuestionAnswer } from './Models';
import { isNotBlank } from './TextPredicates';

/**
 * 一道题算不算答完了：有选项的要选中至少一个，没选项的要自由文本非空。
 *
 * 选项题**不检查**选中的 label 是否真在选项里 —— 界面只会从选项里产生选择，
 * 多一层校验只会多一个「按理说不会发生」的分支。
 */
export function isAnswered(question: ChatQuestion, selected: Set<string>, custom: string): boolean {
  if (question.options.length === 0) {
    return isNotBlank(custom);
  }
  return selected.size > 0;
}

/**
 * 把界面上的勾选与输入收成请求体。
 *
 * 两条规则：
 * - 有选项的题只带 `selected`，并**按选项原顺序**过滤 —— 用户点选的先后顺序不该影响请求体；
 * - 没选项的题只带 `custom`（去掉首尾空白），`selected` 给空数组。
 *
 * 顺序与 `questions` 一致，`id` 原样回带。
 */
export function buildAnswers(questions: ChatQuestion[], selectedById: Map<string, Set<string>>,
  customById: Map<string, string>): QuestionAnswer[] {
  const out: QuestionAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const question: ChatQuestion = questions[i];
    if (question.options.length === 0) {
      const custom: string | undefined = customById.get(question.id);
      const text: string = custom === undefined ? '' : custom.trim();
      out.push(QuestionAnswer.create(question.id, [], text));
      continue;
    }
    const picked: Set<string> | undefined = selectedById.get(question.id);
    const selected: string[] = [];
    for (let j = 0; j < question.options.length; j++) {
      const label: string = question.options[j].label;
      if (picked !== undefined && picked.has(label)) {
        selected.push(label);
      }
    }
    out.push(QuestionAnswer.create(question.id, selected));
  }
  return out;
}

/** 一道题是否已经答完 —— 从整组题的角度看（界面上「提交」键的启用条件）。 */
export function allAnswered(questions: ChatQuestion[], selectedById: Map<string, Set<string>>,
  customById: Map<string, string>): boolean {
  if (questions.length === 0) {
    return false;
  }
  for (let i = 0; i < questions.length; i++) {
    const question: ChatQuestion = questions[i];
    const picked: Set<string> | undefined = selectedById.get(question.id);
    const custom: string | undefined = customById.get(question.id);
    const answered: boolean = isAnswered(question, picked === undefined ? new Set<string>() : picked,
      custom === undefined ? '' : custom);
    if (!answered) {
      return false;
    }
  }
  return true;
}
