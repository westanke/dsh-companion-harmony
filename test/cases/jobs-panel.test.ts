/**
 * 后台任务面板单测 —— 覆盖三件事：
 *
 * 1. `core/JobViews.ts` 的纯解析与纯函数（状态白名单、时长文案、终态语义）；
 * 2. `HarnessViewModel` 的五个动作（开 / 关 / 清单 / 终止 / 输出展开），
 *    走 `harness-view-model.test.ts` 那一整套假依赖（同一份 rig 组件在本文件里重建）；
 * 3. 能力位守卫 `supportsJobListing` 的三种输入（有 / 无 / 未知）。
 *
 * **为什么另起一个文件**：`harness-view-model.test.ts` 已经 1000+ 行，
 * 继续往里堆会让"改一处跑全量"的反馈变慢；这套用例自成一体（只依赖 rig + JobViews）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  HarnessViewModel, HarnessState, HarnessDeps,
} from '../../entry/src/main/ets/core/HarnessViewModel.ts';
import {
  JobOutput, JobView, JobKillResult, isJobLive, killWasRequested, jobDurationText,
  JOB_STATUS_RUNNING, JOB_STATUS_STOPPING, JOB_STATUS_COMPLETED, JOB_STATUS_KILLED, JOB_STATUS_FAILED,
} from '../../entry/src/main/ets/core/JobViews.ts';
import {
  supportsJobListing, supportsArchiveListing, JOB_LIST_CAPABILITY, ARCHIVE_LIST_CAPABILITY,
} from '../../entry/src/main/ets/core/BridgeCapabilities.ts';
import { JsonAccess } from '../../entry/src/main/ets/core/JsonAccess.ts';
import { toastText } from '../../entry/src/main/ets/core/ErrorMessages.ts';
import {
  ChatSession, DeviceView, HealthView, PairingResult, DshApiException,
} from '../../entry/src/main/ets/core/Models.ts';
import {
  ConnectionCoordinator, DshClientFactory,
} from '../../entry/src/main/ets/core/ConnectionCoordinator.ts';
import {
  Credential, CredentialKind, Endpoint, Host,
} from '../../entry/src/main/ets/core/ConnectionModels.ts';
import {
  HostStore, KeyValueStore, SecretBox, CryptoBridge,
} from '../../entry/src/main/ets/core/HostStore.ts';
import { AppPreferences } from '../../entry/src/main/ets/core/AppPreferences.ts';
import { TimerBridge, DshClient } from '../../entry/src/main/ets/core/DshClient.ts';

// ---------------------------------------------------------------------------
// 最小的假平台（与 harness-view-model.test.ts 同款，按需裁剪）
// ---------------------------------------------------------------------------

class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>();

  getString(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  putString(key: string, value: string | null): void {
    if (value === null) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
  }

  remove(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

class ReverseSecretBox implements SecretBox {
  encrypt(plain: Uint8Array): Uint8Array {
    const out = new Uint8Array(plain.length);
    for (let i = 0; i < plain.length; i++) {
      out[i] = plain[plain.length - 1 - i];
    }
    return out;
  }

  decrypt(cipher: Uint8Array): Uint8Array {
    return this.encrypt(cipher);
  }
}

const nodeCrypto: CryptoBridge = {
  sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  },
};

class FakeTimers implements TimerBridge {
  schedule(): number {
    return 1;
  }

  cancel(): void {
  }
}

/** 假客户端：后台任务三条接口可按用例换返回值 / 抛错。 */
class FakeClient {
  endpoint = 'http://192.168.1.9:3090/api/v1';
  counters = { sessionJobs: 0, jobOutput: 0, killJob: 0, health: 0 };
  jobsValue: JobView[] = [];
  jobsError: Error | null = null;
  jobOutputValue: JobOutput = new JobOutput('j1', '', 0, false, null);
  /** 按 jobId 定制的输出（覆盖 `jobOutputValue`）；并发展开两条时用来区分哪条写回了。 */
  jobOutputByJob: Map<string, JobOutput> = new Map();
  jobOutputError: Error | null = null;
  killResult: JobKillResult = new JobKillResult('j1', 'requested');
  killError: Error | null = null;
  /** `killJob` 被调用时记下参数，用来证明用的是当前会话 id。 */
  killCalls: { sessionId: string; jobId: string }[] = [];

  health(): Promise<HealthView> {
    this.counters.health += 1;
    const h = new HealthView();
    h.ok = true;
    h.version = 'v';
    return Promise.resolve(h);
  }

  deviceValue: DeviceView = new DeviceView();

  constructor() {
    this.deviceValue.id = 'dev-1';
    this.deviceValue.name = 'Pixel 9';
    this.deviceValue.scopes = ['files.read', 'files.write', 'chat.read', 'chat.write', 'settings.read'];
    this.deviceValue.rootIds = ['root-1'];
  }

  device(): Promise<DeviceView> {
    return Promise.resolve(this.deviceValue);
  }

  /** 连接后置探活会读它（`ConnectionCoordinator` 的 post-probe）。 */
  currentDevice(): Promise<DeviceView> {
    return Promise.resolve(this.deviceValue);
  }

  roots(): Promise<object[]> {
    return Promise.resolve([]);
  }

  chatWorkspaces(): Promise<object[]> {
    return Promise.resolve([]);
  }

  agentPresets(): Promise<object[]> {
    return Promise.resolve([]);
  }

  permissionPresets(): Promise<object | null> {
    return Promise.resolve(null);
  }

  providerSettings(): Promise<object | null> {
    return Promise.resolve(null);
  }

  pluginInventory(): Promise<object | null> {
    return Promise.resolve(null);
  }

  settingsNamespaces(): Promise<object | null> {
    return Promise.resolve(null);
  }

  patchSettingsNamespace(_namespace: string, _ops: unknown): Promise<object | null> {
    return Promise.resolve(null);
  }

  entries(rootId: string, path: string = '', cursor: string | null = null): Promise<object> {
    return Promise.resolve({ path: '', entries: [], nextCursor: null });
  }

  trash(): Promise<object[]> {
    return Promise.resolve([]);
  }

  sessions(): Promise<ChatSession[]> {
    return Promise.resolve([]);
  }

  events(): { close(): void } {
    return { close: (): void => undefined };
  }

  sessionJobs(sessionId: string): Promise<JobView[]> {
    this.counters.sessionJobs += 1;
    if (this.jobsError !== null) {
      return Promise.reject(this.jobsError);
    }
    return Promise.resolve(this.jobsValue);
  }

  jobOutput(sessionId: string, jobId: string, from: number | null = null): Promise<JobOutput> {
    this.counters.jobOutput += 1;
    if (this.jobOutputError !== null) {
      return Promise.reject(this.jobOutputError);
    }
    if (this.jobOutputByJob.has(jobId)) {
      return Promise.resolve(this.jobOutputByJob.get(jobId) as JobOutput);
    }
    return Promise.resolve(this.jobOutputValue);
  }

  killJob(sessionId: string, jobId: string): Promise<JobKillResult> {
    this.counters.killJob += 1;
    this.killCalls.push({ sessionId, jobId });
    if (this.killError !== null) {
      return Promise.reject(this.killError);
    }
    return Promise.resolve(this.killResult);
  }
}

class FakeFactory implements DshClientFactory {
  constructor(private client: FakeClient) {
  }

  create(): DshClient {
    return this.client as unknown as DshClient;
  }
}

interface Rig {
  vm: HarnessViewModel;
  state: HarnessState;
  store: HostStore;
  client: FakeClient;
}

function makeRig(client: FakeClient): Rig {
  const storage = new MemoryStore();
  const now = (): number => 1_700_000_000_000;
  const store = new HostStore(storage, new ReverseSecretBox(), nodeCrypto, now);
  const prefs = new AppPreferences(storage);
  const factory = new FakeFactory(client);
  const timers = new FakeTimers();
  const coordinator = new ConnectionCoordinator(factory, 1500, timers, now);
  let seq = 0;
  const deps: HarnessDeps = {
    hostStore: store,
    preferences: prefs,
    coordinator,
    clientFactory: factory,
    legacyKeyValueStore: storage,
    legacySecretBox: new ReverseSecretBox(),
    now,
    newId: (): string => `id-${++seq}`,
    languageTag: (): string => 'zh-CN',
    timers,
    runOnUi: (action: () => void): void => action(),
  };
  const vm = new HarnessViewModel(deps);
  return { vm, state: vm.state, store, client };
}

function sampleHost(): Host {
  return new Host('h1', '家里的电脑',
    [Endpoint.create('家庭局域网', 'http://192.168.1.9:3090', 'e1')], 'e1',
    new Credential(CredentialKind.DEVICE_TOKEN, 'tok', 'dev-1', 'Pixel 9', ['chat.read'], 1, null),
    1, 1);
}

function job(id: string, status: string, overrides: Partial<JobView> = {}): JobView {
  const v = new JobView(id, 'bash', `任务 ${id}`, null, status, null, null, 1000, null);
  Object.assign(v, overrides);
  return v;
}

/** 连好主机（必过的一步）；返回已装配的 rig。 */
async function connectedRig(client: FakeClient = new FakeClient()): Promise<Rig> {
  const rig = makeRig(client);
  rig.store.upsert(sampleHost());
  await rig.vm.connectHost('h1');
  return rig;
}

// ===========================================================================
// 1. 纯解析与纯函数
// ===========================================================================

test('isJobLive：白名单口径 —— 未知状态算「不在跑」而不是「在跑」', () => {
  assert.equal(isJobLive(JOB_STATUS_RUNNING), true);
  assert.equal(isJobLive(JOB_STATUS_STOPPING), true);
  assert.equal(isJobLive(JOB_STATUS_COMPLETED), false);
  assert.equal(isJobLive(JOB_STATUS_KILLED), false);
  assert.equal(isJobLive(JOB_STATUS_FAILED), false);
  // 将来内核多出一种状态（如 suspended）：黑名单写法会误判成存活、挂上一个按不动的
  // 「终止」按钮；白名单写法只会不显示按钮 —— 方向是安全的。
  assert.equal(isJobLive('suspended'), false);
  assert.equal(isJobLive(''), false);
});

test('JobView.fromJson：可选字段缺键 → null / 0，不抛', () => {
  const v = JobView.fromJson(JsonAccess.parse('{"id":"j1","kind":"bash","label":"x","status":"running","startedAt":7}'));
  assert.equal(v.id, 'j1');
  assert.equal(v.owner, null);
  assert.equal(v.progress, null);
  assert.equal(v.detail, null);
  assert.equal(v.finishedAt, null);
  assert.equal(v.startedAt, 7);
  assert.equal(v.isLive(), true);
});

test('JobView.fromJson：null 输入退化为全默认值', () => {
  const v = JobView.fromJson(null);
  assert.equal(v.id, '');
  assert.equal(v.status, '');
  assert.equal(v.isLive(), false);
  assert.equal(v.startedAt, 0);
});

test('JobOutput.fromJson：lossy 只在真是 true 时为 true（字符串 "true" 不算）', () => {
  assert.equal(JobOutput.fromJson(JsonAccess.parse('{"jobId":"j","text":"a","next":3,"lossy":true}')).lossy, true);
  assert.equal(JobOutput.fromJson(JsonAccess.parse('{"jobId":"j","text":"a","next":3,"lossy":"true"}')).lossy, false);
  assert.equal(JobOutput.fromJson(JsonAccess.parse('{"jobId":"j","text":"a","next":"3"}')).next, 0);
  assert.equal(JobOutput.fromJson(JsonAccess.parse('{"jobId":"j","text":"a","next":3}')).status, null);
});

test('JobKillResult.fromJson 与 killWasRequested：只有 already-finished 不算「已受理」', () => {
  const r = JobKillResult.fromJson(JsonAccess.parse('{"jobId":"j1","outcome":"already-finished"}'));
  assert.equal(r.jobId, 'j1');
  assert.equal(killWasRequested(r.outcome), false);
  assert.equal(killWasRequested('requested'), true);
  // 未知 outcome：按「已受理」处理（宁可多提示一次「已发送」，也别谎报「已经结束」）。
  assert.equal(killWasRequested('whatever'), true);
});

test('jobDurationText：存活中按 now 算，终态按 finishedAt 算', () => {
  const live = job('j1', JOB_STATUS_RUNNING, { startedAt: 0 });
  assert.equal(jobDurationText(live, 45_000), '45 s');
  assert.equal(jobDurationText(live, 192_000), '3 min 12 s');

  const done = job('j2', JOB_STATUS_COMPLETED, { startedAt: 0, finishedAt: 3_960_000 });
  // 终态不受 now 影响：拍的总时长。
  assert.equal(jobDurationText(done, 99_999_000), '1 h 6 min');
});

test('jobDurationText：时钟回拨不显示负数', () => {
  const v = job('j1', JOB_STATUS_RUNNING, { startedAt: 5_000 });
  assert.equal(jobDurationText(v, 1_000), '0 s');
});

test('supportsJobListing：能力位缺失 / 未知一律 false（不显示入口）', () => {
  assert.equal(JOB_LIST_CAPABILITY, 'job-list-v1');
  assert.equal(supportsJobListing(new Set(['job-list-v1'])), true);
  assert.equal(supportsJobListing(new Set(['approvals-v1', 'questions-v1'])), false);
  assert.equal(supportsJobListing(null), false, '读不到清单 = 未知，不显示入口');
  assert.equal(supportsJobListing(new Set()), false);
  // 归档能力位与它各认各的，不串门。
  assert.equal(supportsArchiveListing(new Set([JOB_LIST_CAPABILITY])), false);
  assert.equal(supportsJobListing(new Set([ARCHIVE_LIST_CAPABILITY])), false);
});

// ===========================================================================
// 2. 面板动作
// ===========================================================================

test('openJobsPanel：建面板状态、按会话记 owner、立刻拉一次清单', async () => {
  const rig = await connectedRig();
  rig.client.jobsValue = [job('j1', JOB_STATUS_RUNNING)];

  rig.vm.openJobsPanel('s1');
  assert.ok(rig.state.jobsPanel !== null);
  assert.equal(rig.state.jobsPanel?.sessionId, 's1');
  assert.equal(rig.state.jobsPanel?.loading, true, '打开即进 loading');

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(rig.client.counters.sessionJobs, 1);
  assert.equal(rig.state.jobsPanel?.loading, false);
  assert.equal(rig.state.jobsPanel?.jobs.length, 1);
  assert.equal(rig.state.jobsPanel?.error, null);
  rig.vm.dispose();
});

test('openJobsPanel：换会话时整体换一份，不残留上一个会话的任务', async () => {
  const rig = await connectedRig();
  rig.client.jobsValue = [job('a1', JOB_STATUS_RUNNING)];
  rig.vm.openJobsPanel('s1');
  await Promise.resolve();
  await Promise.resolve();

  rig.client.jobsValue = [job('b1', JOB_STATUS_RUNNING)];
  rig.vm.openJobsPanel('s2');
  assert.equal(rig.state.jobsPanel?.sessionId, 's2');
  assert.equal(rig.state.jobsPanel?.jobs.length, 0, '新会话先清空（还在读）');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(rig.state.jobsPanel?.jobs[0].id, 'b1');
  rig.vm.dispose();
});

test('closeJobsPanel：清状态；重复关不炸', async () => {
  const rig = await connectedRig();
  rig.vm.openJobsPanel('s1');
  await Promise.resolve();
  await Promise.resolve();
  rig.vm.closeJobsPanel();
  assert.equal(rig.state.jobsPanel, null);
  rig.vm.closeJobsPanel();
  assert.equal(rig.state.jobsPanel, null);
  rig.vm.dispose();
});

test('loadJobs 失败：亮错误、且不把面板打成「没有任务」', async () => {
  const rig = await connectedRig();
  rig.client.jobsError = new DshApiException(404, 'ROUTE_NOT_FOUND', '老插件没有这条路由');
  rig.vm.openJobsPanel('s1');
  await Promise.resolve();
  await Promise.resolve();

  const panel = rig.state.jobsPanel;
  assert.ok(panel !== null);
  assert.equal(panel.loading, false);
  assert.ok((panel.error ?? '').length > 0, '失败必须有错误文案，不能静默成空');
  assert.equal(panel.jobs.length, 0);
  rig.vm.dispose();
});

test('loadJobs 失败但已有旧清单：旧清单保留（不清空）', async () => {
  const rig = await connectedRig();
  rig.client.jobsValue = [job('j1', JOB_STATUS_RUNNING)];
  rig.vm.openJobsPanel('s1');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(rig.state.jobsPanel?.jobs.length, 1);

  rig.client.jobsError = new DshApiException(500, 'INTERNAL', 'boom');
  await rig.vm.loadJobs();
  assert.equal(rig.state.jobsPanel?.jobs.length, 1, '拿到的数据不能因为一次刷新失败就丢掉');
  assert.ok((rig.state.jobsPanel?.error ?? '').length > 0);
  rig.vm.dispose();
});

test('loadJobs：成功一次后 error 清零', async () => {
  const rig = await connectedRig();
  rig.client.jobsError = new DshApiException(500, 'INTERNAL', 'boom');
  rig.vm.openJobsPanel('s1');
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(rig.state.jobsPanel?.error !== null);

  rig.client.jobsError = null;
  rig.client.jobsValue = [job('j1', JOB_STATUS_RUNNING)];
  await rig.vm.loadJobs();
  assert.equal(rig.state.jobsPanel?.error, null);
  assert.equal(rig.state.jobsPanel?.jobs.length, 1);
  rig.vm.dispose();
});

test('killJob：requested → 「已发送终止请求」，并立刻刷新清单', async () => {
  const rig = await connectedRig();
  rig.client.jobsValue = [job('j1', JOB_STATUS_RUNNING)];
  rig.vm.openJobsPanel('s1');
  await Promise.resolve();
  await Promise.resolve();
  const before = rig.client.counters.sessionJobs;

  rig.client.killResult = new JobKillResult('j1', 'requested');
  await rig.vm.killJob('j1');
  assert.deepEqual(rig.client.killCalls, [{ sessionId: 's1', jobId: 'j1' }]);
  assert.equal(rig.state.jobsPanel?.killingJobId, null, '终止完必须复位（否则按钮永远灰着）');
  assert.equal(rig.state.jobsPanel?.killNotice, toastText('jobs_kill_requested', 'zh-CN'));
  assert.equal(rig.client.counters.sessionJobs, before + 1, '终止后要刷新，状态徽标才会翻');
  rig.vm.dispose();
});

test('killJob：already-finished → 「它已经结束了」，不是「已终止」', async () => {
  const rig = await connectedRig();
  rig.vm.openJobsPanel('s1');
  await Promise.resolve();
  await Promise.resolve();

  rig.client.killResult = new JobKillResult('j1', 'already-finished');
  await rig.vm.killJob('j1');
  const notice: string | null | undefined = rig.state.jobsPanel?.killNotice;
  assert.equal(notice, toastText('jobs_kill_already_finished', 'zh-CN'));
  assert.notEqual(notice, toastText('jobs_kill_requested', 'zh-CN'), '两种语义不能混成一句话');
  rig.vm.dispose();
});

test('killJob 失败：复位 killingJobId 并把错误写进 killNotice', async () => {
  const rig = await connectedRig();
  rig.vm.openJobsPanel('s1');
  await Promise.resolve();
  await Promise.resolve();
  const before = rig.client.counters.sessionJobs;

  rig.client.killError = new DshApiException(404, 'JOB_NOT_FOUND', '找不到这条任务');
  await rig.vm.killJob('zzz');
  assert.equal(rig.state.jobsPanel?.killingJobId, null);
  assert.ok((rig.state.jobsPanel?.killNotice ?? '').length > 0);
  assert.equal(rig.client.counters.sessionJobs, before, '失败就不必再多拉一次');
  rig.vm.dispose();
});

test('toggleJobOutput：展开读输出，value 原样进状态', async () => {
  const rig = await connectedRig();
  rig.vm.openJobsPanel('s1');
  await Promise.resolve();
  await Promise.resolve();

  rig.client.jobOutputValue = new JobOutput('j1', 'line 1\nline 2', 14, false, JOB_STATUS_RUNNING);
  rig.vm.toggleJobOutput('j1');
  assert.equal(rig.state.jobsPanel?.expandedJobId, 'j1');
  assert.equal(rig.state.jobsPanel?.outputLoading, true);

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(rig.state.jobsPanel?.outputLoading, false);
  assert.equal(rig.state.jobsPanel?.expandedOutput?.text, 'line 1\nline 2');
  assert.equal(rig.state.jobsPanel?.expandedOutput?.next, 14);
  rig.vm.dispose();
});

test('toggleJobOutput：再点一次收起，并清掉已读的那份', async () => {
  const rig = await connectedRig();
  rig.vm.openJobsPanel('s1');
  await Promise.resolve();
  await Promise.resolve();

  rig.client.jobOutputValue = new JobOutput('j1', 'x', 1, false, null);
  rig.vm.toggleJobOutput('j1');
  await Promise.resolve();
  await Promise.resolve();
  rig.vm.toggleJobOutput('j1');
  assert.equal(rig.state.jobsPanel?.expandedJobId, null);
  assert.equal(rig.state.jobsPanel?.expandedOutput, null, '收起要清内容，避免残留下一条的');
  rig.vm.dispose();
});

test('toggleJobOutput：换一条展开时，旧那条的返回结果不会写回（不自己弹开）', async () => {
  const rig = await connectedRig();
  rig.vm.openJobsPanel('s1');
  await Promise.resolve();
  await Promise.resolve();

  // 两条各有各的输出：这样「谁写回的」一目了然。
  rig.client.jobOutputByJob.set('j1', new JobOutput('j1', '第一条的输出', 5, false, null));
  rig.client.jobOutputByJob.set('j2', new JobOutput('j2', '第二条的输出', 7, false, null));
  rig.vm.toggleJobOutput('j1');
  // 还没等 j1 的响应落地，用户点开 j2。
  rig.vm.toggleJobOutput('j2');
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(rig.state.jobsPanel?.expandedJobId, 'j2', '展开的仍是用户最后点的那条');
  assert.equal(rig.state.jobsPanel?.expandedOutput?.text, '第二条的输出', 'j1 的迟到结果不许写回');
  rig.vm.dispose();
});

test('toggleJobOutput：读输出失败也当一段输出展示（别留空白像没反应）', async () => {
  const rig = await connectedRig();
  rig.vm.openJobsPanel('s1');
  await Promise.resolve();
  await Promise.resolve();

  rig.client.jobOutputError = new DshApiException(410, 'JOB_GONE', '任务已被回收');
  rig.vm.toggleJobOutput('j1');
  await Promise.resolve();
  await Promise.resolve();
  const out = rig.state.jobsPanel?.expandedOutput;
  assert.ok(out !== null);
  assert.ok((out?.text ?? '').length > 0, '错误文案本身就是要展示的内容');
  assert.equal(out?.lossy, false, '这不是「被留存策略吃掉的字节」，别误报不完整');
  rig.vm.dispose();
});

test('refresh 后展开状态存活（expandedJobId 不因刷新被清）', async () => {
  const rig = await connectedRig();
  rig.client.jobsValue = [job('j1', JOB_STATUS_RUNNING)];
  rig.vm.openJobsPanel('s1');
  await Promise.resolve();
  await Promise.resolve();

  rig.client.jobOutputValue = new JobOutput('j1', 'out', 3, false, null);
  rig.vm.toggleJobOutput('j1');
  await Promise.resolve();
  await Promise.resolve();

  await rig.vm.loadJobs();
  assert.equal(rig.state.jobsPanel?.expandedJobId, 'j1', '刷新不该把用户展开的那条收回去');
  assert.equal(rig.state.jobsPanel?.jobs.length, 1);
  rig.vm.dispose();
});

test('面板关着时动作直接返回（不建状态、不发请求）', async () => {
  const rig = await connectedRig();
  await rig.vm.loadJobs();
  await rig.vm.killJob('j1');
  rig.vm.toggleJobOutput('j1');
  assert.equal(rig.client.counters.sessionJobs, 0);
  assert.equal(rig.client.counters.killJob, 0);
  assert.equal(rig.client.counters.jobOutput, 0);
  assert.equal(rig.state.jobsPanel, null);
  rig.vm.dispose();
});

test('HarnessState 默认不含后台任务面板（jobsPanel 为 null）', () => {
  assert.equal(new HarnessState().jobsPanel, null);
});
