/**
 * 主机维护 + 连接复核 —— 从 `HarnessViewModelConnection` 拆出。
 *
 * ## 为什么拆
 *
 * `HarnessViewModelConnection` 已逼近 900 行预算（AGENTS.md §4.2），拆分是首选手段。
 * 这里放的是一组**共同一职责**的方法：只管「已保存的主机记录怎么改」与「连接还通不通」，
 * 不碰事件流、不碰快照。留下的是连接建立与事件处理（`connectHostInternal` /
 * `connectEvents` / `loadSnapshot` / `handleEvent` 等），它们彼此互调、且依赖本层的字段。
 *
 * ## 继承位置
 *
 * `HarnessViewModelComposer` ← **本层** ← `HarnessViewModelConnection`。
 * 之所以插在中间而不是并到基类：这组方法要用 `deps.hostStore` / `deps.now()` /
 * `update()` / `active` / `connectGate`，这些都由基类与 Composer 提供；
 * 而它们**不调用** Connection 里的任何成员（`removeHost` 调用 `disconnect`，
 * 因此刻意留在 Connection）。
 */

import {
  shouldRecheckActiveConnection,
} from './ConnectionLiveness';
import {
  ActiveConnection,
} from './ConnectionCoordinator';
import {
  Credential,
  CredentialKind,
  Endpoint,
  EndpointProbe,
  Host,
} from './ConnectionModels';
import {
  normalizeEndpoint,
  stripApiSuffix,
} from './EndpointUrl';
import {
  HarnessState,
  LAST_ENDPOINT,
} from './HarnessTypes';
import {
  trimText,
} from './TextPredicates';
import {
  DshClient,
} from './DshClient';
import {
  DeviceView,
} from './Models';
import { HarnessViewModelComposer } from './HarnessViewModelComposer';

export class HarnessViewModelConnect extends HarnessViewModelComposer {
  /** 给某台电脑追加一个可达地址（例如新增虚拟网地址）。 */
  async addEndpoint(hostId: string, label: string, baseUrl: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      const host: Host | null = this.deps.hostStore.host(hostId);
      if (host === null) {
        return;
      }
      const normalized: string = stripApiSuffix(normalizeEndpoint(baseUrl));
      for (let i = 0; i < host.endpoints.length; i++) {
        if (host.endpoints[i].baseUrl === normalized) {
          return;
        }
      }
      const endpoint: Endpoint = Endpoint.create(label, normalized, `ep-${this.deps.newId()}`);
      const next: Host = host.copy();
      next.endpoints = host.endpoints.concat([endpoint]);
      next.updatedAt = this.deps.now();
      this.deps.hostStore.upsert(next);
      this.update((s: HarnessState): void => {
        s.hosts = this.deps.hostStore.loadHosts();
      });
    });
  }

  /** 删除某台电脑的一个地址。保留最后一个地址的行为由界面负责拦截。 */
  async removeEndpoint(hostId: string, endpointId: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      const host: Host | null = this.deps.hostStore.host(hostId);
      if (host === null) {
        return;
      }
      if (host.endpoints.length <= 1) {
        throw new Error(LAST_ENDPOINT);
      }
      const endpoints: Endpoint[] = [];
      for (let i = 0; i < host.endpoints.length; i++) {
        if (host.endpoints[i].id !== endpointId) {
          endpoints.push(host.endpoints[i]);
        }
      }
      let preferred: string | null = host.preferredEndpointId;
      if (preferred !== null) {
        let found: boolean = false;
        for (let i = 0; i < endpoints.length; i++) {
          if (endpoints[i].id === preferred) {
            found = true;
            break;
          }
        }
        if (!found) {
          preferred = null;
        }
      }
      const next: Host = host.copy();
      next.endpoints = endpoints;
      next.preferredEndpointId = preferred;
      next.updatedAt = this.deps.now();
      this.deps.hostStore.upsert(next);
      this.update((s: HarnessState): void => {
        s.hosts = this.deps.hostStore.loadHosts();
      });
    });
  }

  /** 重命名一台电脑。 */
  async renameHost(hostId: string, displayName: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      const host: Host | null = this.deps.hostStore.host(hostId);
      if (host === null) {
        return;
      }
      const next: Host = host.copy();
      next.displayName = trimText(displayName);
      next.updatedAt = this.deps.now();
      this.deps.hostStore.upsert(next);
      this.update((s: HarnessState): void => {
        s.hosts = this.deps.hostStore.loadHosts();
      });
    });
  }

  selectHost(hostId: string | null): void {
    this.update((s: HarnessState): void => {
      s.selectedHostId = hostId;
    });
  }

  /**
   * 回前台时复核「这条连接此刻还通不通」（对应源工程 `MainActivity.onResume`）。
   *
   * 为什么要这一步：熄屏/切后台期间网络可能已经没了，而 `connected` 是**历史值**
   * （「曾经连上过」）。用户在连接页看到的绿点、「进入应用」的按钮、以及按钮点下去是否重连，
   * 全都建立在「此刻还连着」这个错误假设上 —— 真机症状就是「断网了仍显示已连接」
   * 且点按钮毫无反应（源工程提交 91743f2）。
   *
   * 只在「停在场外（未进 App）+ 有活动连接 + 没在并发探活」时探一次；
   * 失败就把连接摘掉并把历史状态位一起改正 —— 界面才会回到「已断开 / 重新连接」。
   */
  recheckConnectionIfOnConnectScreen(): void {
    const connection: ActiveConnection | null = this.active;
    const st: HarnessState = this.state;
    const recheck: boolean = shouldRecheckActiveConnection(this.connectGate, st.connected,
      connection !== null, st.connecting);
    if (!recheck || connection === null) {
      return;
    }
    const probing: ActiveConnection = connection;
    const client: DshClient = probing.client;
    void client.health().then((): void => {
      // 探通了：状态位可能因为这期间的一次失败被置假，纠正回来（幂等）。
      if (this.active !== probing || this.state.connected) {
        return;
      }
      this.update((s: HarnessState): void => {
        s.connected = true;
        s.healthOk = true;
      });
    }).catch((): void => {
      // 期间用户手动重连过：`this.active` 已经换人，别拿旧连接的失败去纠正新连接。
      if (this.active !== probing) {
        return;
      }
      this.active = null;
      this.update((s: HarnessState): void => {
        s.connected = false;
        s.healthOk = false;
      });
    });
  }

  protected applyProbes(host: Host, probes: EndpointProbe[]): Host {
    let acc: Host = host;
    for (let i = 0; i < probes.length; i++) {
      const p: EndpointProbe = probes[i];
      acc = acc.withEndpointProbe(p.endpointId, p.latencyMs, p.error, this.deps.now());
    }
    return acc;
  }

  protected hostFromPairing(endpoint: string, token: string, device: DeviceView,
                          displayName: string): Host {
    const now: number = this.deps.now();
    const baseUrl: string = stripApiSuffix(normalizeEndpoint(endpoint));
    const endpointId: string = 'ep-paired';
    const hosts: Host[] = this.deps.hostStore.loadHosts();
    let existing: Host | null = null;
    for (let i = 0; i < hosts.length; i++) {
      if (hosts[i].id === `host-${device.id}`) {
        existing = hosts[i];
        break;
      }
    }
    const trimmed: string = trimText(displayName);
    // 主机名优先用用户填的设备名，其次是电脑自己报的名字（对应 Kotlin 的 orEmpty 兜底）。
    const finalName: string = trimmed.length > 0 ? trimmed : device.name;
    // `Endpoint.create` 会在 label 为空时退回 baseUrl，所以这里直接拿主机名当标签。
    const issuedAt: number = existing !== null && existing.credential !== null && existing.credential.issuedAt > 0
      ? existing.credential.issuedAt : now;
    const credential: Credential = new Credential(CredentialKind.DEVICE_TOKEN, token, device.id,
      device.name, device.scopes, issuedAt, null);
    return new Host(`host-${device.id}`, finalName,
      [Endpoint.create(finalName, baseUrl, endpointId)], endpointId, credential,
      existing !== null ? existing.createdAt : now, now);
  }
}
