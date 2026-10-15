/**
 * 出错文案的本地化表 —— 移植自原工程 `data/ErrorMessages.kt` 与各语言的 `strings.xml`
 * （`res/values/` 中文默认、`res/values-en/` 英文）中的错误文案段。
 *
 * ## 与安卓版的一处结构差异（有意的）
 *
 * 安卓那边这个文件只返回 `@StringRes` 资源 id，正文留在 `strings.xml` 里由系统按
 * 手机语言解析。鸿蒙这边把「文案表」直接放进 core，原因是 ArkTS 取资源（`$r` 加字面量
 * 资源名）只认**编译期字面量**，拿到一个运行期才确定的 key 再拼成资源名是行不通的；
 * 若坚持走资源系统，就得在 UI 里维护一张 30 多分支的 `switch` 把 key 映射成字面量
 * 资源引用，反而更难维护。
 *
 * 因此约定：**出错文案（按错误码查的那张表）在 core；界面文案（按钮、标签）走资源系统。**
 * 中英两列都在这里，英文不是占位而是可直接用的正文 —— 这就是「中文可用 + 给英文留接口」。
 * 全局界面语言由 `lang` 参数传入（原工程对应 `AppPreferences` 里的界面语言设置）。
 *
 * ## 两条不变的规矩（照抄原工程的设计）
 *
 * 1. **认不出就返回 null，绝不硬猜**。编一句像模像样的话只会把人带偏；保留服务端原文，
 *    用户至少还能搜一搜或贴给开发者。
 * 2. 多个错误码可以共用一条文案 —— 用户要看的是「我该怎么办」，不是错误码编号。
 *    74 个码里一大批是同一意思的不同分支（`PATH_NOT_DIRECTORY` / `PATH_NOT_FILE` /
 *    `WORKSPACE_PATH_NOT_DIRECTORY` 都是「路径类型不对」）。
 */

import { trimText } from './TextPredicates';

/**
 * 语言解析：取 BCP-47 的主语言子标签，`en*` 用英文，其余一律中文。
 * 与安卓的资源解析口径一致 —— `values/` 是中文默认，`values-en/` 是英文。
 * 所以 `zh-TW`、`ja`、`de` 等等都落到中文，只有 `en`、`en-GB`、`en_US` 落到英文。
 */
function isEnglish(lang: string): boolean {
  const lower: string = lang.trim().toLowerCase();
  let cut: number = lower.length;
  const dash: number = lower.indexOf('-');
  const under: number = lower.indexOf('_');
  if (dash >= 0 && dash < cut) {
    cut = dash;
  }
  if (under >= 0 && under < cut) {
    cut = under;
  }
  return lower.substring(0, cut) === 'en';
}

/** 请求体/协议/内部错误共用的兜底文案 id（需要带上原始错误码，否则「操作没能完成」等于没说）。 */
const ID_REQUEST_GENERIC: string = 'err_request_generic';

/** 服务端错误码 → 文案 id。key 一律是 [normalizeErrorCode] 归一化后的形态（大写、无前缀）。 */
const ERROR_ID_BY_CODE: Record<string, string> = {
  // ———— 鉴权 · 设备 ————
  'AUTH_REQUIRED': 'err_auth_required',
  'TOKEN_INVALID': 'err_auth_required',
  'PAIRING_INVALID': 'err_pairing_invalid',
  'DEVICE_NOT_FOUND': 'err_device_not_found',
  'ROOT_FORBIDDEN': 'err_root_unusable',
  'ROOT_INVALID': 'err_root_unusable',
  'ROOT_NOT_FOUND': 'err_root_unusable',
  'SCOPE_REQUIRED': 'err_scope_missing',
  'SCOPE_INVALID': 'err_scope_missing',
  'FORBIDDEN': 'err_scope_missing',
  'ADMIN_LOOPBACK_REQUIRED': 'err_admin_loopback',
  'SETTINGS_READ_ONLY': 'err_settings_read_only',

  // ———— 路径 · 文件 ————
  'PATH_OUTSIDE_ROOT': 'err_path_outside_root',
  'PATH_OUTSIDE_ROOTS': 'err_path_outside_root',
  'PATH_NOT_FOUND': 'err_path_missing',
  'TRASH_NOT_FOUND': 'err_path_missing',
  'PATH_NOT_DIRECTORY': 'err_path_wrong_kind',
  'PATH_NOT_FILE': 'err_path_wrong_kind',
  'WORKSPACE_PATH_NOT_DIRECTORY': 'err_path_wrong_kind',
  'PATH_ALREADY_EXISTS': 'err_path_exists',
  'PATH_INVALID': 'err_path_invalid',
  'PATH_NOT_ABSOLUTE': 'err_path_invalid',
  'PATH_REQUIRED': 'err_path_invalid',
  'MOVE_INVALID': 'err_path_invalid',
  'CREATE_CONDITION_REQUIRED': 'err_path_invalid',
  'FILE_TYPE_UNSUPPORTED': 'err_path_invalid',
  'LINK_TRAVERSAL_FORBIDDEN': 'err_path_invalid',
  'ETAG_MISMATCH': 'err_file_changed',
  'ETAG_REQUIRED': 'err_file_changed',
  'COPY_VERIFY_FAILED': 'err_file_changed',
  'TRASH_VERIFY_FAILED': 'err_file_changed',
  'RESTORE_CONFLICT': 'err_file_changed',

  // ———— 会话 · 聊天 ————
  'SESSION_NOT_FOUND': 'err_session_missing',
  'WORKSPACE_NOT_FOUND': 'err_workspace_missing',
  'SESSION_FORK_OUTSIDE_ROOT': 'err_workspace_outside_root',
  'WORKSPACE_OUTSIDE_ROOT': 'err_workspace_outside_root',
  'SESSION_TITLE_INVALID': 'err_title_invalid',
  'WORKSPACE_TITLE_INVALID': 'err_title_invalid',
  'MESSAGE_EMPTY': 'err_message_empty',
  'COMMAND_NOT_FOUND': 'err_command',
  'COMMAND_INVALID': 'err_command',
  'COMMAND_FAILED': 'err_command',
  'COMMANDS_UNAVAILABLE': 'err_command',
  'APPROVAL_NOT_PENDING': 'err_approval_stale',
  'QUESTION_NOT_PENDING': 'err_question_unavailable',
  'QUESTION_NOT_ANSWERABLE': 'err_question_unavailable',
  'QUESTION_ANSWER_INVALID': 'err_question_unavailable',
  'QUESTION_REPLY_QUEUED': 'err_question_unavailable',
  'USER_QUESTIONS_UNAVAILABLE': 'err_question_unavailable',
  'RATE_LIMITED': 'err_rate_limited',
  'CURSOR_INVALID': 'err_paging',
  'RANGE_INVALID': 'err_paging',
  'NUMBER_INVALID': 'err_paging',

  // ———— 模型 · 供应商 ————
  'MODEL_UNAVAILABLE': 'err_model_unavailable',
  'MODEL_DOES_NOT_SUPPORT_IMAGES': 'err_model_no_images',
  'MODEL_SELECTION_INVALID': 'err_model_invalid',
  'MODEL_CONFIG_INVALID': 'err_model_invalid',
  'PROVIDER_BASE_URL_REQUIRED': 'err_provider',
  'PROVIDER_ID_INVALID': 'err_provider',
  'PROVIDER_MODELS_REQUIRED': 'err_provider',
  'PROVIDER_NOT_CONFIGURABLE': 'err_provider',
  'PROVIDER_NOT_FOUND': 'err_provider',
  'PROVIDER_PROTOCOL_INVALID': 'err_provider',
  'PROVIDER_REQUIRED': 'err_provider',
  'PROVIDER_EXISTS': 'err_provider',
  'CUSTOM_PROVIDERS_UNAVAILABLE': 'err_provider',
  'AGENT_PRESET_INVALID': 'err_agent_preset',

  // ———— 远程访问 · 监听 ————
  'LISTENER_HOST_INVALID': 'err_listener_invalid',
  'LISTENER_PORT_INVALID': 'err_listener_invalid',
  'LISTENER_CHANGE_PENDING': 'err_listener_pending',
  'REMOTE_ENABLED': 'err_remote_enabled',

  // ———— 账号 ————
  'ACCOUNT_SIGNED_OUT': 'err_signed_out',

  // ———— 其余（请求体 / 协议 / 内部）：给一句人话 + 附上码，便于反馈 ————
  'BODY_INVALID': ID_REQUEST_GENERIC,
  'JSON_INVALID': ID_REQUEST_GENERIC,
  'BODY_TOO_LARGE': ID_REQUEST_GENERIC,
  'METHOD_NOT_ALLOWED': ID_REQUEST_GENERIC,
  'ROUTE_NOT_FOUND': ID_REQUEST_GENERIC,
  'INTERNAL_ERROR': ID_REQUEST_GENERIC,
  'HTTP_ERROR': ID_REQUEST_GENERIC,
};

/** 文案正文（中文列）。key 与安卓 `strings.xml` 里的资源名一字不差，便于对照。 */
const TEXT_ZH: Record<string, string> = {
  'err_auth_required': '登录状态已失效，请重新配对这台设备',
  'err_pairing_invalid': '配对码不对，或者已经过期了',
  'err_device_not_found': '这台设备已经不在这台电脑的列表里了',
  'err_root_unusable': '这个授权目录用不了了（可能被移走或改过名）',
  'err_scope_missing': '这台设备的权限不够，做不了这个操作',
  'err_admin_loopback': '管理设置只能在电脑本机上改',
  'err_settings_read_only': '设置当前是只读的',
  'err_path_outside_root': '这个路径不在任何已授权的目录里',
  'err_path_missing': '找不到这个路径，可能已经被删了',
  'err_path_wrong_kind': '路径类型不对（文件与目录弄反了）',
  'err_path_exists': '同名文件已经存在了',
  'err_path_invalid': '这个路径不合法',
  'err_file_changed': '文件在别处被改过，重新加载再试',
  'err_session_missing': '找不到这个会话',
  'err_workspace_missing': '找不到这个工作区',
  'err_workspace_outside_root': '这个工作区不在已授权的目录里',
  'err_title_invalid': '这个名字不合法',
  'err_message_empty': '还没输入内容',
  'err_command': '这个命令没能执行',
  'err_approval_stale': '这个审批已经失效了',
  'err_question_unavailable': '这个问题现在答不了',
  'err_rate_limited': '请求太频繁，稍等一会儿再试',
  'err_paging': '翻页参数不对，刷新一下列表',
  'err_model_unavailable': '这个模型现在用不了（可能不支持当前的推理强度，或者没配置好）',
  'err_model_no_images': '当前模型看不到图片',
  'err_model_invalid': '这个模型选择不合法',
  'err_provider': '供应商配置不完整（检查地址、密钥、模型）',
  'err_agent_preset': '这个 Agent 预设不可用',
  'err_listener_invalid': '监听地址或端口不合法',
  'err_listener_pending': '监听设置正在变更，稍等一下',
  'err_remote_enabled': '要先关掉远程访问才能改这个',
  'err_signed_out': '已经退出 DeepSeek 登录，这一轮就停在这里了',
  'err_request_generic': '操作没能完成（%1$s）',
  'err_connect_all_unreachable': '连不上这台电脑，所有地址都没通（检查电脑是否开机、远程访问是否开启）',
  'err_network_timeout': '连接超时了，请检查网络后重试',
  'err_network_unreachable': '找不到服务器，请检查地址是否正确、网络是否连通',
  'err_network_refused': '连接被拒绝了，请确认远程访问已开启',
  'err_network_reset': '网络连接中断了，请重试',
  'err_network_generic': '网络请求失败了（%1$s）',
};

/** 文案正文（英文列）。与 `res/values-en/strings.xml` 一一对应。 */
const TEXT_EN: Record<string, string> = {
  'err_auth_required': 'Your sign-in has expired — pair this device again',
  'err_pairing_invalid': 'That pairing code is wrong or has expired',
  'err_device_not_found': 'This device is no longer listed on that machine',
  'err_root_unusable': 'That authorized folder is unusable — it may have been moved or renamed',
  'err_scope_missing': 'This device doesn\'t have the permission for that action',
  'err_admin_loopback': 'Admin settings can only be changed on the machine itself',
  'err_settings_read_only': 'Settings are read-only right now',
  'err_path_outside_root': 'That path is outside every authorized folder',
  'err_path_missing': 'That path no longer exists — it may have been deleted',
  'err_path_wrong_kind': 'Wrong kind of path — a file and a folder got mixed up',
  'err_path_exists': 'Something with that name already exists',
  'err_path_invalid': 'That path is not valid',
  'err_file_changed': 'The file changed elsewhere — reload and try again',
  'err_session_missing': 'That conversation no longer exists',
  'err_workspace_missing': 'That workspace no longer exists',
  'err_workspace_outside_root': 'That workspace is outside the authorized folders',
  'err_title_invalid': 'That name is not valid',
  'err_message_empty': 'Nothing to send yet',
  'err_command': 'That command did not run',
  'err_approval_stale': 'That approval is no longer pending',
  'err_question_unavailable': 'That question can\'t be answered right now',
  'err_rate_limited': 'Too many requests — wait a moment and try again',
  'err_paging': 'Bad paging parameters — refresh the list',
  'err_model_unavailable': 'That model is unavailable — it may not support the current reasoning effort, or it isn\'t configured',
  'err_model_no_images': 'The current model can\'t see images',
  'err_model_invalid': 'That model selection is not valid',
  'err_provider': 'The provider setup is incomplete — check URL, key and models',
  'err_agent_preset': 'That agent preset is unavailable',
  'err_listener_invalid': 'That listen address or port is not valid',
  'err_listener_pending': 'A listener change is still in progress — wait a moment',
  'err_remote_enabled': 'Turn off remote access before changing this',
  'err_signed_out': 'Signed out of DeepSeek — this turn stopped here',
  'err_request_generic': 'That action didn\'t complete (%1$s)',
  'err_connect_all_unreachable': 'Can\'t reach this computer — no endpoint responded (is it on? is remote access enabled?)',
  'err_network_timeout': 'Connection timed out — check your network and try again',
  'err_network_unreachable': 'Can\'t find the server — check the address or your network',
  'err_network_refused': 'Connection refused — make sure remote access is enabled',
  'err_network_reset': 'The connection dropped — try again',
  'err_network_generic': 'Network request failed (%1$s)',
};

/**
 * 把文案 id 解析成正文。查不到时退到中文列（而不是返回空串）：两列的口径必须一致，
 * 缺一条是可修复的疏漏，不该让用户看到空白提示。
 */
function textById(id: string, lang: string): string {
  const table: Record<string, string> = isEnglish(lang) ? TEXT_EN : TEXT_ZH;
  const text: string | undefined = table[id];
  if (text === undefined) {
    const fallback: string | undefined = TEXT_ZH[id];
    return fallback === undefined ? id : fallback;
  }
  return text;
}

/** 替换文案里的 `%1$s` 占位（对齐安卓的 `getString(res, arg)`）。 */
function fillOne(template: string, arg: string): string {
  const MARK: string = '%1$s';
  const at: number = template.indexOf(MARK);
  if (at < 0) {
    return template;
  }
  return template.substring(0, at) + arg + template.substring(at + MARK.length);
}

/**
 * 归一化错误码：内核有时给 `DSH_SESSION/MODEL_UNAVAILABLE` 这类带前缀的码，
 * 我们只认最后一段；大小写不敏感，空白去掉。空串/纯空白 → null。
 *
 * 注意 `A/B/` 这种「分隔符在末尾」的输入会归一化成**空串**（而不是 null）——
 * 这是照抄原工程 `substringAfterLast` 的行为；下游按码查表时两者结果一样，
 * 但保持一字不差，免得日后对照两边行为时多出一处需要解释的差异。
 */
export function normalizeErrorCode(code: string | null): string | null {
  if (code === null) {
    return null;
  }
  const trimmed: string = trimText(code);
  if (trimmed.length === 0) {
    return null;
  }
  const slash: number = trimmed.lastIndexOf('/');
  return (slash >= 0 ? trimmed.substring(slash + 1) : trimmed).toUpperCase();
}

/**
 * 服务端错误码 → 用户语言的句子；**认不出的码返回 null**（调用方保留原文）。
 *
 * 兜底那条（`err_request_generic`）会把**原始**错误码填进正文 —— 用原始码而不是归一化后的，
 * 是为了让用户贴给开发者的那一串和界面上看到的一字不差。
 */
export function localizedErrorText(code: string | null, lang: string): string | null {
  const normalized: string | null = normalizeErrorCode(code);
  if (normalized === null) {
    return null;
  }
  const id: string | undefined = ERROR_ID_BY_CODE[normalized];
  if (id === undefined) {
    return null;
  }
  const template: string = textById(id, lang);
  return id === ID_REQUEST_GENERIC ? fillOne(template, code === null ? '' : code) : template;
}

/**
 * 网络层失败的分类 —— 对应安卓里按**异常类型**查表的那六条文案
 * （`SocketTimeoutException` / `UnknownHostException` / `ConnectException` /
 * `SSLException`+`SocketException`+`EOFException` / 其他 `IOException`）。
 *
 * 安卓直接判异常类，鸿蒙这边 `@ohos.net.http` 抛的是错误对象（错误码为数字），
 * 平台层负责把它翻成本枚举 —— core 不认识任何平台错误码，只认这五个类别。
 */
export enum NetworkFailureKind {
  /** 超时（含连接超时与读超时）。 */
  TIMEOUT = 'timeout',
  /** 解析不了主机名 / 网络不可达。 */
  UNREACHABLE = 'unreachable',
  /** 连接被拒（对端没在监听）。 */
  REFUSED = 'refused',
  /** 连接中断（TLS 失败、socket 被重置、对端提前 EOF）。 */
  RESET = 'reset',
  /** 其余网络故障：文案里附上原始详情，便于排查。 */
  OTHER = 'other',
}

/**
 * 网络失败 → 用户语言的句子。**这组不返回 null** —— 分类已经做完了，`OTHER` 也有兜底文案，
 * 附上的原始详情仍然保留了排查价值。
 */
export function networkErrorText(kind: NetworkFailureKind, lang: string, detail: string | null = null): string {
  if (kind === NetworkFailureKind.TIMEOUT) {
    return textById('err_network_timeout', lang);
  }
  if (kind === NetworkFailureKind.UNREACHABLE) {
    return textById('err_network_unreachable', lang);
  }
  if (kind === NetworkFailureKind.REFUSED) {
    return textById('err_network_refused', lang);
  }
  if (kind === NetworkFailureKind.RESET) {
    return textById('err_network_reset', lang);
  }
  return fillOne(textById('err_network_generic', lang), detail === null ? '' : detail);
}

/**
 * 「这台电脑的所有地址都没通」—— `DshConnectionException` 专用文案。
 *
 * 它不按错误码查表，因为这不是服务端返回的码，而是客户端并发探活全部失败的结果；
 * 逐地址的失败明细在异常对象里（诊断面板会展开），这里只给一句能照做的提示。
 */
export function allEndpointsUnreachableText(lang: string): string {
  return textById('err_connect_all_unreachable', lang);
}

/**
 * 网络层异常的**唯一**载体 —— 对应安卓里 IOException 家族那七八个异常类型。
 *
 * 安卓的 `messageOf` 用 `when (error)` 逐个类型判（超时 / 找不到主机 / 连接被拒 /
 * TLS 失败 / socket 重置 / 提前 EOF / 其它 IO），鸿蒙这边 `@ohos.net.http` 抛的是
 * **带数字错误码的错误对象**，core 不认识那些数字。分工是：**平台层把数字码翻成
 * [NetworkFailureKind] 再抛本异常**，ViewModel 只认 `instanceof NetworkException`
 * 一条分支（七个 `when` 分支就此收敛成一条，这是有意的简化）。
 *
 * `detail` 保留原始详情（网络库的原文），`OTHER` 类文案会把它附在句子后面，
 * 与安卓 `err_network_generic` 带 `error.message` 的口径一致。
 */
export class NetworkException extends Error {
  readonly kind: NetworkFailureKind;
  readonly detail: string | null;

  constructor(kind: NetworkFailureKind, detail: string | null = null) {
    super(detail === null ? kind : `${kind}: ${detail}`);
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * 送出去的提示 / 界面兜底码文案（中文列）。
 *
 * 与错误码表（`TEXT_ZH`）刻意分成两张表：那张按**服务端错误码**查、这张按 **key** 查，
 * 两张表的生命周期与来源都不同（错误码表跟服务端协议走，这张跟界面动作走）。
 *
 * key 与安卓 `strings.xml` 的资源名一字不差，便于逐条对照。
 * 结尾那六个（`FILE_TOO_LARGE` 等）是**界面兜底码**：原工程里这些码是直接塞进
 * `HarnessUiState.error` 的（如 `error = "BINARY_FILE"`），由界面按码取文案；
 * 这里两侧都留一份，界面按码查即可，VM 不替它翻译（保持与安卓一字不差的行为）。
 */
const TOAST_ZH: Record<string, string> = {
  'send_failed_restore': '消息没能发出去（%1$s），附件与文字已经还回输入框',
  'send_failed_auth': '发送失败：登录状态已失效，请重新配对这台设备',
  'send_failed_too_large': '发送失败：内容太大了，去掉一些附件再试',
  'send_failed_body': '发送失败：请求体不被接受，换个方式再试',
  'attachment_image_too_large': '这张图太大了（上限 %1$s），压一压再试',
  'attachment_file_too_large': '这个文件太大了（上限 %1$s），换个小一点的',
  'attachment_file_rejected': '服务端拒绝了这次上传：文件超出它的上限',
  'attachment_upload_unsupported': '服务端插件版本太旧，还不支持上传附件，请先升级插件',
  'attachment_read_failed': '读取这个文件失败了，换一个再试',
  'attachment_fail_outside_roots': '看不到这个文件：它不在任何已授权的目录里',
  'attachment_fail_auth': '看不到这张图：登录状态已失效，重新配对后就能显示',
  'attachment_fail_scope': '看不到这张图：这台设备没有读文件的权限',
  'attachment_fail_missing': '这张图已经不在了（可能被清理过）',
  'attachment_fail_other': '取图失败（%1$s）',
  'plugins_write_permission_required': '这台设备没有改设置的权限，改不了插件',
  'plugins_toggle_saved': '已保存，重启 DSH 后生效',
  'answer_already_queued': '这组答案已经在队列里了',
  'answer_not_pending': '这个问题已经不用答了',
  'answer_no_write': '这台设备没有回复问题的权限',
  'answer_failed': '提交答案失败（%1$s）',
  // 终局失败帧那一句「标题」的兜底：纯逻辑层拿到的是资源 key（见 ChatTurnFailure.titleKey），
  // VM 在「本地化命中不了、服务端原文又是空的」时要用它兜一句人话。
  'turn_stopped_title': '任务已停止',
  'turn_failed_title': '本轮运行失败',
  // 界面兜底码（原工程直接写进 error 字段的那些常量）。
  'FILE_TOO_LARGE': '文件太大，无法完整预览',
  'BINARY_FILE': '这个文件不是文本，看不了内容',
  'PLUGIN_TOO_OLD': '服务端插件版本太旧，请先升级插件',
  'CONFIG_INVALID': '这段配置无法识别（可能粘错了或没粘全）',
  'LAST_ENDPOINT': '每台电脑至少要留一个地址',
  'COMMAND_FAILED': '这个命令没能执行',
};

/** 送出去的提示 / 界面兜底码文案（英文列）。与安卓 `res/values-en/` 的资源正文对应。 */
const TOAST_EN: Record<string, string> = {
  'send_failed_restore': 'That message didn\'t go out (%1$s); your attachments and text are back in the composer',
  'send_failed_auth': 'Send failed: your sign-in has expired — pair this device again',
  'send_failed_too_large': 'Send failed: it was too large — remove some attachments and try again',
  'send_failed_body': 'Send failed: the request body was rejected — try again differently',
  'attachment_image_too_large': 'That image is too large (limit %1$s) — shrink it and try again',
  'attachment_file_too_large': 'That file is too large (limit %1$s) — pick a smaller one',
  'attachment_file_rejected': 'The server rejected that upload — the file is over its own limit',
  'attachment_upload_unsupported': 'The server plugin is too old to accept uploads — update it first',
  'attachment_read_failed': 'Couldn\'t read that file — try another one',
  'attachment_fail_outside_roots': 'Can\'t show that file: it is outside every authorized folder',
  'attachment_fail_auth': 'Can\'t show this image: your sign-in expired — pair again and it will load',
  'attachment_fail_scope': 'Can\'t show this image: this device lacks file-read permission',
  'attachment_fail_missing': 'That image is gone — it may have been cleaned up',
  'attachment_fail_other': 'Couldn\'t load that image (%1$s)',
  'plugins_write_permission_required': 'This device can\'t change settings, so plugins can\'t be toggled',
  'plugins_toggle_saved': 'Saved — restart DSH for it to take effect',
  'answer_already_queued': 'Those answers are already queued',
  'answer_not_pending': 'That question no longer needs an answer',
  'answer_no_write': 'This device isn\'t allowed to answer questions',
  'answer_failed': 'Couldn\'t submit the answers (%1$s)',
  'turn_stopped_title': 'Task stopped',
  'turn_failed_title': 'This turn failed',
  'FILE_TOO_LARGE': 'That file is too large to preview',
  'BINARY_FILE': 'That file isn\'t text — its content can\'t be shown',
  'PLUGIN_TOO_OLD': 'The server plugin is too old — update it first',
  'CONFIG_INVALID': 'That configuration can\'t be read — it may be mistyped or truncated',
  'LAST_ENDPOINT': 'Each machine needs at least one address',
  'COMMAND_FAILED': 'That command did not run',
};

/**
 * 提示文案 —— 替代安卓的 `appString(R.string.xxx)`（等价于 `getString(res, arg)`）。
 *
 * 与 [localizedErrorText] 的分工：那个按**服务端错误码**查，这个按**调用点写死的 key** 查。
 * `arg` 非 null 时替换正文里的 `%1$s` 占位（对齐安卓的 `getString(res, arg)`）；
 * 查不到 key 时退到中文列，仍查不到就原样返回 key —— 与 [textById] 同一口径，
 * 缺一条是可修复的疏漏，不该让用户看到空白。
 */
export function toastText(key: string, lang: string, arg: string | null = null): string {
  const table: Record<string, string> = isEnglish(lang) ? TOAST_EN : TOAST_ZH;
  const text: string | undefined = table[key];
  let template: string;
  if (text === undefined) {
    const fallback: string | undefined = TOAST_ZH[key];
    template = fallback === undefined ? key : fallback;
  } else {
    template = text;
  }
  return arg === null ? template : fillOne(template, arg);
}
