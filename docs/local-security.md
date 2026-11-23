# 本地源码安全版：改造状态与验证门槛

## 2026-11-11 受控本地 Blender 工作流

新增主 Agent 专用的 `blender_status`、`run_blender` 和 `recover_blender_run`。
它们将明确列出的项目文件复制到独立任务目录，通过 macOS 系统沙箱调用固定位置的
本地 Blender，供程序化建模、清理、绑骨、动画与导出使用。普通宿主 Shell、外部
MCP、插件程序入口和全局执行开关继续关闭；其他操作系统不回退到无隔离执行。

Blender 不继承账号凭据、用户配置或环境中的模型密钥，不得联网、读取项目目录之外
的用户资料或修改原项目。输入为受检查的普通文件快照，`.blend` 自动脚本执行关闭；
显式 Python 脚本仍视为代码，隔离依赖操作系统策略而非提示词或路径约定。
任务有时间、日志和文件预算，以及 2 GiB 常驻内存采样保护；一次只运行一个本地 Blender 任务。总目录大小和内存使用由定时监测保护，并非硬磁盘或内存配额。取消或失败终止进程后保留任务结果。输出经过检查后
写入新的项目运行目录，不覆盖旧模型；GLB 再走现有解析与运行素材准备能力。

自 2026-11-19 起，主 Agent 的 Blender 任务全程无窗口运行，包括自定义脚本、GLB 回读验证和渲染。
需要查看阶段成果时，可以请 Agent 将已完成的候选展示到画布，旋转模型、播放动画并查看实际渲染图。
需要在 Blender 里检查或编辑时，可手动打开该次运行保存的 `scene.blend`。

这是本地 Blender 的专用受控能力，不改变 Tripo 的请求恢复、防重复付费和旧项目
模型选择。默认由主 Agent 核对尺寸、多视图、初模、关节分区、变形和动画，
修正问题后再将最终候选交给用户验收。用户可以指定阶段查看进度或确认。修复若需改变指定造型，或产生未授权的额外费用，先说明选择并等待用户决定。
完整入口、支持范围和交付路径见 [3D 工作流](3d-providers.md#controlled-local-blender-workflow)。

Blender 也可用 `sourceAssetId` 接收已绑定到当前项目的 GLB 或 FBX 原件。宿主核对项目绑定和内容摘要后才交给 Blender。后续步骤从保留的场景继承制作要求，并在执行前核对场景快照。最终候选经过内置导出、GLB 回读和本轮渲染图复核后，可送到画布供用户验收。

## 2026-11-09 受控 Qoder 主 Agent（第一阶段）

Qoder 的本地接入范围见[编码 Agent](coding-agents.md#local-secure-edition-controlled-qoder-first-stage)。仅设置页与现有会话模型选择器提供可选入口，默认关闭，不加入首次设置流程；不切换旧会话、不迁移项目默认、不改变 Kunpo 凭据、素材模型或画布文案路由。主 Agent 与素材文案默认值的项目级解耦不在本阶段静默处理。

固定审查的 macOS arm64 安装为 SDK `1.0.59` 和配套原生 CLI `1.1.83`，分别置于 `.runtime/qoder-sdk/1.0.59/` 与 `.runtime/qoder-cli/1.1.83/`，未改变根依赖。启动前静态核对安装文件，不执行候选程序或登录 shell，不使用 SDK 默认安装器或自动下载运行时。独立受管 helper 使用最小环境、专用 `HOME` 与 `QODER_CONFIG_DIR`；不继承用户配置、外部 MCP、Skills、插件、环境凭据或 Kunpo Key。全局本地执行开关保持关闭，仅现有受控项目工具可回调宿主；原生文件、命令、网络、子 Agent 等工具不开放。实际工具表或 MCP 状态不匹配时，在发送提示前拒绝。

“准备登录命令”只返回并展示专用命令，由用户自行运行；应用未代为执行、打开登录页面或导入既有登录。用户完成认证后仍需重新检查、显式启用并选择会话模型。审批、卷恢复、取消、调用归属和素材未知结果防重继续使用共享服务，不能用 Qoder 的权限、文件回退或重试绕过。

后续启动链核查补充：CLI 的 `skills: []` 会话白名单不阻止内建 `imagegen` 技能被发现，helper 另设 `settings.skills.enabled: false`，并继续要求实际技能目录为空；素材仍只能走 Kunpo。MCP 状态严格校验带命名空间的完整工具名。固定真实 SDK 经 helper 的真实 stdio 与本地假 daemon 已覆盖初始化、隐式规划控制、模型策略、权限/hook、工具回传，以及越界工具、技能和非法控制帧的拒绝；未替换 `sdk.query`，测试进程阻断 Node 网络 API、Worker 和非白名单子进程，专用临时配置无账号及凭据。此项不冒充真实 CLI 的 OS 沙箱或真实推理验收。校验失败在 SDK 迭代器清理前保留，避免被关闭错误覆盖；界面只接收有限错误分类、阶段和失配边界，不传原 SDK 错误或认证数据。旧 Qoder 上下文按新启动策略从共享记录重建。

实际 `active-tools` 拒绝的进一步核查确认：CLI 在 full/lazy MCP 模式都会额外注入 `mcp_list`、`mcp_get`、`mcp_call`，三者不属于 `--tools` 控制的内建工具集合。helper 通过精确 `disallowedTools` 拒绝这三个通用入口；原生 deny 规则会将其从 active 工具及模型声明排除。工具表仍精确要求仅有会话的受控项目工具，不能把额外入口当作可接受元数据。SDK 协议模拟同步包含原生默认注入和 deny 筛选，避免只把 `tools/list` 直接当成最终工具表。

原生 daemon 还会在每个用户回合开始前再次发送完整初始化快照。helper 对每份快照重新核验同一 session、目录、工具表和权限；仅通过复检的同会话快照可继续，不重复绑定会话、释放输入或清空调用关联与结果缓存。输入后边界变化仍中止并保留结果，错误不能声称“提示词未发送”。真实 SDK 本地协议回归包含每回合快照、跨会话及工具表变更拒绝，以及快照前后同调用 ID 防重。

固定 SDK 与原生 CLI 已在全新临时配置、macOS 全网络拒绝沙箱中完成无认证 daemon 握手与缓存模型查询；IPv4/IPv6 连接均被拒绝，没有发送提示词或虚构凭据。会话初始化明确要求先认证。后续只读检查用户已登录尝试的既有日志，确认会话和 MCP 成功启动、提示词发送前被本地工具校验关闭：CLI 固有的三个 Agent 目录元数据被误认作执行权限。修复仅接受固定版本已核实的目录名称，实际工具表继续精确匹配，原生 Agent 权限与 hook 均拒绝；应用入口同时补齐既有受控文件工具，写锁内再次核对恢复审核、图片读取遵循模型能力。原生初始化形状与真实应用工厂的模拟回归覆盖上述路径，旧 Qoder 工具上下文下次从共享记录重建；错误分类不再一概指向重新登录。修复阶段未读取凭据、重登、重试或请求真实模型及素材。模拟不能代替真实推理、媒体及当前更新后应用的验收。检查过的 Qoder 账号与模型目录暂存进程内，重启应用后需再检查。真实端到端流程及商业分发条款仍待确认；SDK 不按 MIT/Apache 授权推定。下方 Codex 和历史阶段记录保留各自范围。

## 2026-11-08 受控 Codex 主 Agent

可选 Codex 主 Agent 的当前限制和登录步骤见[编码 Agent](coding-agents.md#local-secure-edition-controlled-codex)。本节优先于下方关于所有原生 CLI 均停用的历史记录。macOS Codex 的 CLI 与独立运行器更新后会重新核验发行者签名，并以临时配置通过本地隔离测试。通过的版本可在私有 app-server 入口中使用独立的登录与配置。全局执行开关仍关闭，项目操作经过受控工具。

2026-11-09 的工具桥兼容修复仅启用固定哈希的独立 Code Mode V8 运行器，禁止进程内回退。嵌套工具只提供 `ohmygame` 命名空间；原生 `functions`、`collaboration`、`web`、`clock` 命名空间被排除，V8 无 Node、文件、进程或网络 API。全局执行开关及既有文件权限保持不变。真实 CLI 的本地模拟已覆盖读写、模拟 Kunpo 素材回填、模拟试玩、规划写入拒绝和取消后的延迟写入拒绝；真实素材服务与实际试玩仍需后续验收。


当前完整检查与启动方式见 [人工验收前检查](pre-acceptance-check.md) 和 [启动与人工清单](manual-acceptance.md)，下方保留阶段历史。

本地安全版已停用联网搜索。设置页显示停用状态，有旧搜索密钥时可主动清除。旧联网搜索配置接口返回 HTTP 410，历史会话中的搜索记录仍可查看。

## 2026-11-06 游戏运行素材传输

普通源码继续使用单文件 2 MiB、合计 8 MiB 的预算。支持
`runtimeMediaVersion: 1` 的本地预览虚拟机为已接入游戏的媒体单独分配单文件
32 MiB、合计 64 MiB。首次准备分块传送，后续准备核对内容，只上传更改的素材。
新登记的画布候选素材保留在项目中供编辑器使用，主 Agent 可显式选用并复制到游戏目录。
路径、私有文件、敏感内容、文件数、项目卷容量及变更回传检查继续执行。
文件位置和构建产物回传条件见[预览与素材预算](preview-runtime.md)。

本机已用临时项目通过真实 VM 构建和浏览器播放验证。项目含一段 3,947,174 字节的
原始 MP4 及一份约 5 MiB 的 WAV。构建回传的两份素材逐字节等同原件。
只改动播放脚本后，两次准备的输入从 9,194,255 字节降至 4,195 字节；
浏览器播放原片至 4.064 秒末尾，分辨率 1280×720，共 97 帧。验收完成后已移除临时项目卷。

支持 `buildMediaVersion: 1` 的虚拟机还能分块回传构建期间新编码的媒体，原样复制
和新编码的媒体合计最多 64 MiB，单文件最多 32 MiB。宿主验证文件内容及传输完整性
后才替换现有构建。实机验收中，构建脚本使用原片的帧图和单声道音频，生成了
4,225,604 字节的 H.264 视频及 2,469,644 字节的双声道 WAV。回传后的解码画面
与音频采样比对通过；Chrome 完整播放了 4 秒、48 帧。另一次构建含超限脚本，
回传被拒后，原成品保持完整。

## 2026-11-03 项目执行存储生命周期（源码，待独立维护启用）

协议 2 源码实现删除前的任务阻断与卷回收、未回传修改保护、完整卷休眠/恢复及恢复界面。八个限制改为常驻名额，总镜像逻辑预算为 4GiB（至多十六个完整卷），身份和操作记录也有上限。旧 guest 与未经审计的身份范围会拒绝执行；不自动升级、创建批准账本或清理账号。本次不重启或更改真实 VM，下方旧批次的验收不能代表新协议已完成真实验收。约束、启用门槛和恢复见 [执行存储生命周期](isolated-storage-lifecycle.md)。

## 2026-10-28 Kunpo 适配接续

已接入内置 Kunpo 统一凭据、按功能分组的项目模型列表及首选 Agent/媒体协议；新项目快照首选，旧项目与已有显式选择不自动迁移。当前验证使用假 Key、模拟上游及临时本机网页，没有真实模型调用。具体型号、可用/候选边界与本批验证记录见 [Kunpo 本地适配交付](kunpo-local.md)。下方历史批次中的“媒体尚未实现”不再代表当前源码状态；真实账号权限、质量、费用及私有后台行为仍未验收。原作者服务与高权限旁路没有恢复。

Library、原始工作区媒体与宿主静态预览在发送任何字节前分块复制并完整检查私有快照，再从同一受检只读副本发送 Range；不再按文件大小分配整块宿主 Buffer。快照在写入内容前已解除目录链接，完整扫描、源身份稳定检查和摘要通过后才能发送；新 Library 记录绑定内容 SHA-256，旧记录不自动补写或冒称历史完整性已验证。已登记 Key 命中返回 403，Range/HEAD 不能绕过完整检查；硬链接、读取期间变化、原有真实路径、隐藏路径及 no-follow 边界继续生效。工作区与静态展示仅将 MP4/WebM、WAV/MP3/OGG、GLB 的受检读取上限分别对齐至 256/200/100 MiB，其他文件仍为 64 MiB；Library 原有 200 MiB 读取档保留，视频对齐既有生成 256 MiB 档。生成、上传、FBX 转换、隔离运行和回传预算没有随之扩大。这是已登记值的检查，不代表识别任意未知凭据；动态开发代理也未获得这一整文件扫描保证。

派生快照缓存与恢复／卷空间 promise 共用真实磁盘及 inode 核算，最多 512 MiB、32 项、两路扫描、64 个待处理读取，空闲 60 秒回收，并保留 2 GiB 磁盘余量。未知空间账本、容量不足或缓存被活跃请求占满时拒绝分配，不清除项目或未决恢复记录。HTTP 使用 no-store 和快照 ETag，策略新增受保护值后缓存失效；已发送字节无法撤回。

桌面主编辑器的音视频和 GLB 可先鉴权 HEAD 获取内容摘要，再以绑定该摘要的原生 URL 读取。main process 仅对当前精确主 frame、当前 daemon、两条受检媒体路由、GET/HEAD 的有效请求补鉴权头；子页面、其他窗口、缺失 frame、预取和重定向不获得自动权限。摘要不是访问令牌，URL／cookie／service worker 不携带 Bearer；跨范围源变化返回 409。仅编辑器 media-src 增加 loopback 媒体来源，daemon 鉴权、Origin 和完整扫描不变。浏览器开发模式、旧桌面、图片、私有模型资源和 Canvas FBX 独立预览仍使用 Blob。大 GLB 仍需完整解析，原生播放器也有自身缓冲；不能将这些改动当作全部编解码、seek、显存或目标设备帧率验收。画布视口门控保留选中／播放中资源；可见画布模型显式启用缓慢旋转和已有片段播放，离开实际视口或文档隐藏时暂停，图库缩略图仍默认静态；视频剪辑仅在用户展开后读取完整源，且与预览摘要绑定。具体合同与未覆盖项见[受检媒体读取](preview-runtime.md#checked-media-reads)。

GLB 的 daemon NodeIO 检查／朝向转换／拆分资源边界与 renderer 的 `model-viewer` 不同：Library／工作区原始快照只建立对应容器、摘要、身份及已知敏感字节检查，手动保留原件不等于已通过 daemon parser 或渲染验收。浏览器仍经 Blob／native URL 加载完整模型；其 glTF loader、纹理解码、GPU 分配和独立 FBX parser 不在新的 daemon reader-allocation 预算之内。不得把该预算写成全 App GLB 预览保护或 FPS／显存保证。

`use_canvas_asset` 在写入前复用完整集合投影检查，逐路径使用当前已核实合同：旧代／v2 单文件 32 MiB，v3 的受支持 AV／GLB 可为 64 MiB、栅格仍为 32 MiB，累计仍为对应的 64／128 MiB；复制成功不等于已证明来宾空间、构建或运行性能。仅可信执行分支的纯预算预检拒绝具有 `runtime_media_budget` 无副作用回执；未知库存、权限、完整性及写入开始后的错误不扩大可纠正范围。原件、旧代合同和用户卷不自动迁移，也不因预览读取上限更大而扩大隔离预算。主 Agent 的处理方式见[画布媒体合同](canvas-agent.md)。

## 当前第三阶段：受控 Linux 命令与源码回传

隔离命令经 `systemd-run --expand-environment=no` 原样传到来宾 Bash，防止服务管理器在 Bash 之前替换脚本里的 `${...}`、`$VAR` 或 `$$`。这不开放宿主命令、网络或新增权限。代码内的控制器修复需按现有来宾组件流程加载后才生效；模拟控制面测试不等于真实 VM 验收。

登记 VM 的项目已提供 `isolated_shell`，宿主 Pi bash/PowerShell、原生编码 CLI、MCP/插件仍未开放。命令只在无宿主挂载、无凭据、无外网的固定容量工作副本中执行；默认 60 秒、最多 120 秒、命令 32000 字符。后台后代随命令结束清理，服务器应走受管 preview/game_use。

只有成功命令才回传非私有源码新增/修改；删除、链接、超限或敏感值返回一律拒绝。源码总量 8MiB/2000 文件、单文件 2MiB。宿主快照与回传时全树 hash/权限校验，配合同应用 HTTP 和 Agent write/edit 的写锁；冲突拒绝整批回传。发布不覆盖已有目标，原件保留在项目存储的 `isolated-changes/` 恢复目录。旧 version-2 发布账本保留原 32MiB 预算；新 version-3 发布按完整的 512MiB 恢复封套及下述持久空间承诺准入，不自动清理用户原件。只回传普通权限及受限执行位，不复制 setuid/ACL 等权限扩展。

这不是全局文件系统事务：同 OS 用户的外部程序不受应用锁约束。原件先保留、目标以不覆盖方式发布，失败保留恢复材料；外部程序持有旧 inode 继续写入时，应检查恢复目录，不能声称能锁住任意宿主进程。当前只验收自建项目，不建议直接迁入真实业务工程或 Key。

不同项目任务使用不同来宾 UID，防止相同 UID 下通过 `/proc` 接触另一项目；它们均无登录能力和 capability。取消通过已知任务 ID、root 私有取消标记/启动锁和 systemd 整组停止处理，仍有租约/PID1 超时兜底。实际 Agent 的修改→回传→动态试玩、并发冲突拒绝和正式 turn cancel 接口已通过，取消任务的主进程与 detached 后代均消失。最终选定回归 39 通过、16 跳过；真实 VM 的 8 项 Shell 场景及 2 项实际会话场景单列，不把统计混加为全仓通过。

以下阶段二与历史批次记录保留其范围；完整三阶段矩阵和证据索引见同一份研究报告的最新版本。

## 当前接续状态：专用 VM 硬容量卷与公共锁定 npm Web 工作流

以下历史批次记录保留其当时的验证边界；本节是当前状态。源码版已通过真实 Electron 静态及动态 Web 的自动 `game_use` 打开、点击、按键、触摸、截图、关闭验收。动态路径使用专用 Lima 2.2.1 / Ubuntu 24.04 arm64 VM，未制作发行包，未调用真实模型。阶段二的可写宿主挂载已移除，依赖准备已接入可信控制面。

- `src/daemon/isolated-project-execution.ts` 是可选后端；无私有注册文件时，原来的默认拒绝继续生效。后端仅接受本仓库 `.runtime/local-execution/{test-data,manual-data}/projects` 两个固定真实目录，拒绝目录符号链接逃出根；不会把 `.data`、宿主 HOME 或业务项目挂进 VM。
- 数据目录与 `PI_CODING_AGENT_DIR` 必须保持配套。注册文件为数据目录下的 `isolated-execution.json`，0600、当前用户所有、非链接，内容为 `{"version":1,"projectsDirectory":"<专用 projects 目录的真实绝对路径>"}`。测试目录不自动启动 VM；人工目录需桌面启动器传入本轮非秘密 UUID `OHMYGAME_LOCAL_LAUNCH_ID`，首次受控任务才在排他锁下启动已存在的固定 `omg` 实例，不安装、创建或重新配置 VM。
- 人工 VM 的租约是 `.runtime/local-execution/manual-vm.lock/owner.json`（目录 0700、回执 0600），记录启动器 UUID、daemon/父进程 PID、会话 UUID 与 `starting/owned` 状态。正常关闭先确认 guest 任务取消，再只停止本 daemon 启动的 VM；借用原本运行的 VM 不取得停止所有权。停止失败保留回执，不能声称清理完成；桌面控制器仅可匹配本轮 UUID、确认 daemon 已退出后做固定实例清理，不能接管未知或其他会话的租约。
- 主 Agent 的 `read_workflow_guide` 按项目类型和组件开关读取内置 Game Studio、Web Game Studio、Three.js World 和 Blender 的制作说明。它只返回应用随附的文本，Blender 编辑源文件和导出仍需外部 Blender。已有原生引擎绑定的项目可以进行普通对话和文件审阅。
- 网页游戏需要 Three.js 时，先沿用项目内已正常工作的版本。缺少运行库的新旧项目都可由主 Agent 调用 `prepare_three_runtime`，从应用自带的 `three@0.172.0` 准备浏览器模块，无需联网。工具在项目启动目录内准备 `vendor/ohmygame-three-0.172.0/` 并返回相对工作区的 `modulePath` 和 `gltfLoaderPath`。已有该版本基础运行库的项目可再次调用，为原目录补齐同版本加载器。从游戏脚本按相对位置导入 `addons/GLTFLoader.js` 的 `GLTFLoader` 和 `three.module.js` 的 `AnimationMixer`，即可加载普通 glTF/GLB 并播放其动画。自定义构建需把整个目录（含 `addons/`、`three.core.js`、许可证与来源记录）按原相对位置带入产物。迁移曾安装失败的项目时，还须核对引用、构建脚本、依赖清单和锁文件，保留其他依赖及其所需的 `three` 条目。
- 仅支持精确版本的公共 npm v3 lock，暂不支持 workspaces；选定的单个包可位于项目根或受限 `startupDirectory` 子目录，依赖准备、预览、构建与产物回传使用同一包目录。后续源码准备只保留当前源码仍声明的普通包根的 `node_modules`（最多八处、共用原项目硬容量），Shell 回传在所有层级排除依赖和生成目录。控制面只下载 `registry.npmjs.org` 的精确 tarball URL，不携 Key、不跟随重定向，核验 SHA512；来宾检查包身份、展开上限、链接及安装脚本，再离线 cache add/ci。真实验收使用 `is-number@7.0.0`；Git/任意 URL、私有 registry/凭据、安装生命周期、Bun/pnpm 均未开放。每包 4MiB、依赖传输总量 8MiB、最多 32 包，控制面缓存 64MiB。
- daemon 只启动固定校验的 Lima，向来宾传项目 ID、相对目录、受限模式和端口，不传 API Key、宿主环境或真实 HOME。来宾任务由 root 控制面交给无特权 `omgjob`，systemd cgroup 收容后代，独立网络命名空间，项目外主机挂载和其他项目缓存不可见。
- 每任务配置 1GiB 内存、无 swap、128 tasks、50% CPU、单文件 64MiB；安装/构建 120 秒、预览 900 秒。最多两项任务、八条代理连接；日志 512KiB、读取背压限时、心跳租约及 PID1 超时独立失败关闭。CPU/内存为配置读回，没有进行耗尽攻击。
- 预览代理固定到任务的私有端口，剥离认证/Key headers，已注册 Key 出现在 URL 时拒绝。关闭连接、启动失败和控制器故障须回收任务。认证后的 `POST /projects/:projectId/build` 返回本地输出相对目录，不发布或上传；尚无新增 GUI 构建按钮。
- **工作区总容量已改为硬边界：**来宾 ext4 固定卷每项目 256MiB、最多 8 个，源码、依赖、缓存、产物共用该容量及 inode 上限；无宿主挂载。每任务 `/tmp`、`/var/tmp` 各为 32MiB 私有 tmpfs。24MiB 小卷和 32MiB 临时目录均实测 ENOSPC。源码和产物传输分别最多 8MiB/2000 文件、单文件 2MiB，拒链接、私有路径、已知 Key；宿主生成目录按完整有界结果替换，避免多轮积累。未泛化至任意业务目录，真实 Key 仍未验收。
- 源码传输前先做只读元数据预算检查：报告符合路径规则的源码总字节数、文件数、各项超额及最多五个最大文件（已知敏感路径脱敏）。遍历最多 4000 个目录项；到达上限只报告下界，不声称清单完整。检查不读取超大文件内容，也不代替实际传输的敏感内容和文件变更校验。超限时应把原件保留在执行工作区外，使用更小的工作副本并更新引用，不删除原件、不任意跳过源码、不放宽隔离预算。
- 新兼容操作可显式协商 `sourceManifestVersion: 1`，并把 `captureVersion: 3` 与 `sourceBaseManifestId` 绑定；capture 3 增加源码语义合同，仍使用 capture-2 二进制帧，不升级旧 0/1/2 代。完整清单按路径记录 source／media、解码后字节数、SHA-256 和受限执行位，宿主／guest 独立重算清单及变化摘要；`sourceBaselineManifest`、`sourceManifest`、`sourceDelta`、`sourceResultManifestId` 缺失或不一致即拒绝。review 的 `sourceRawDelta`／`sourcePreparedDelta` 是整文件变化前后内容字节，不是 wire 大小，也不授予媒体复制、图片审批或发布权限。累计项目集合、首次 seed、变化前后、实际 wanted 媒体字节与 JSON UTF-8 控制头须分列；同 SHA 不同路径仍各计预算。源码 prepare 仍 full inline base64、解码总量 8MiB，只有媒体 payload 按 wanted 路径传输；即使不上传媒体，宿主仍检查当前媒体集合。source 2/8MiB、media 32/64MiB、共享 2000 文件、VM 256MiB 及恢复 512MiB 限额均未改变，旧 larger-profile 候选仅设计／模拟；独立的受控中档版本 2 见下文，既有用户卷不自动迁移。此合同的离线 helper 测量与实际磁盘复制范围见[执行存储生命周期](isolated-storage-lifecycle.md#complete-source-manifests-and-change-accounting)，不能当作真实 VM、网络、视频解码、目标 GPU 或 FPS 验收。
- 隔离工具的真实阶段与原任务、调用、operation、generation 和快照绑定，详见[Agent 中断恢复](agent-errors.md#automatic-continuation-after-an-interruption)。仅可信分支证明的提交前预算拒绝可用新调用纠正；已执行、产物保留、回传或清理不确定均不重放。命令未提交不表示预览未暂停或 VM 未唤醒。
- 版本 1 图片回传仍保留 512KiB 候选上限及匹配的检查规则。新代可显式协商 `captureVersion: 2`、图片策略 2 和兼容的检查／review 能力，静态 PNG/JPEG/WebP 候选按 32MiB／32MP 门限流式检查；存在候选即进入整批 review／approval，命令成功不等于图片获批。旧 0/1 代不就地升级，已验证原媒体精确复制仍按原合同。`recoveryValidation: metadata-only` 只说明可尝试恢复，不能保证完整解码、透明度、冲突及空间检查通过。此改动需更新宿主及已审阅 guest 组件，不自行安装、重启或迁移既有卷。
- 保留静态图片的 v2 review／准备路径默认 identity、保原尺寸和像素，缩图须明确 `maxEdge`。原件、工作版和发布备份纳入完整恢复封套；宿主用私有、带品牌的已验证 artifact 引用发布，不将大图伪装为普通 base64 源码或已验证媒体复制。确认丢失只能核验原事务，不能提交替代恢复；保全更改与原命令成功分别记录。停用的卷不是文件丢失，普通状态查询不启动 VM。此路径不自动处理旧代，也不扩大视频、音频、3D 或构建产物的完整合同，详见[执行存储生命周期](isolated-storage-lifecycle.md)。
- 主 Agent 可在保存 review 后用 `recover_isolated_changes` 的 `read_image`，仅传 action、reviewId、已列图片 path、raw／working variant 和精确 SHA。当前模型须已验证支持图片；只读宿主保存的 PNG/JPEG/WebP artifact，不启动／挂载 VM，不改原件、working、review 回执或项目。显示代理有独立 source／display 摘要、尺寸和 isProxy 标记；`freshGuest:false`／`adoptionApproved:false` 明确它不是当前 guest 核验、审批、完整分辨率画质验收或模型已理解图片的回执，也不清未知状态、发布、ACK 或释放承诺。大小、排队和取消边界见[保留图读取](isolated-storage-lifecycle.md#controlled-review-and-adoption-of-a-legacy-batch)。
- 新 version-3 发布为完整事务保留 512MiB 恢复封套，计入 raw／working、前后独立副本与 staging、`3M + J + E` 元数据（M 为有界最大 manifest，J 为 review，E 为 32MiB 条目余量）；计划版本化限制 32,768 条目，磁盘准入另考虑实际分配单元。宿主按文件系统串行记入私有、持久空间承诺，扣除同 daemon 的其他承诺，并保留 1GiB 宿主空闲余量；发布前复查。它不是 OS 空间预留，不保证其他 daemon／外部写者或物理断电下的余量与原子性。旧 pending 发布只复用原 reservation 和精确代／快照，不能新建承诺洗掉未知状态。坏流隔离在私有 incoming 暂存，完整校验前不转为正式 artifact 或 ACK。
- 启动会恢复被跳过的损坏项目卡片固定目录中的空间承诺；未知、损坏或不一致的账本阻断新分配，即使应用仍可进入只读检查。超时或空 restore 不会清除此状态，不自动删除 promise、重放命令、发布、审批、ACK 或模型请求。当前原生上下文为 `controlled-codex-v12`／`controlled-qoder-v11`，旧工具上下文仅在下一用户回合按共享历史重建，旧回执、审批与代合同不升级，不重放旧回合或工具调用，也不因更新自动请求模型。这些源码及离线回归不能冒充新制品的实机验收。
- 主 Agent 可在既有 `recover_isolated_changes` 工具中调用 `capacity`，只传 action，读取当前宿主容量诊断；当前报告不建立来宾可用空间，停止、不完整或不可用的 guest 数据仍是 unknown。该动作不调用 inspect／review、不启动 VM、不选择恢复代、不清未知状态或释放 ledger，也不授权恢复。缺少 callback 时明确 unavailable，不回退执行。容量元数据不能当作“已读图片”或“整批获批”；后续仍走原 inspect／review／完整审批。未来容量 profile 仅为设计／模拟，不由此启用、更改画质默认或扩大权限。
- 独立 `capacity-128-v2` 由已核实的 guest 能力、原生单次容量／保留旧卷确认及真实空间准入控制，支持累计媒体 128MiB／项目卷 512MiB／源码恢复 1GiB；只对明确创建或迁移的新合同生效。旧代、未决恢复、旧卷与备份均保留，不自动升级或清理。单文件32MiB、单窗64MiB和真实变化回传64MiB保持独立；完整 seed 提交前不得运行。宿主持久化原 plan／authorization ID，未知响应只查原记录，不重复制；断点复制、过期授权回收及自动回滚尚不支持，必须保留并停下。新旧卷和备份按逻辑容量分别计入原4GiB总额，宿主和guest的磁盘余量／inode／并发预留、恢复历史与全部事务峰值分别核查；仅支持已验证在同一真实设备上的固定VM backing文件与宿主控制存储。容量不是画质默认或性能证明，详见[版本化受控中档](isolated-storage-lifecycle.md#controlled-medium-profile-version-2)。
- 独立 `capacity-128-media64-v3` 需精确版本协商和单次原生审批，仅允许新卷或旧256MiB卷显式迁移；已有512MiB卷不支持同容量改档，未知状态不推断为无卷。AV/GLB白名单单文件64MiB，栅格图仍32MiB；累计128MiB、单窗／真实变化回传64MiB、卷512MiB及恢复1GiB不变。已检seed与精确副本采用有界流式完整校验；未知的大媒体改写继续保留并阻断，不能借用图片审批。旧卷和旧代不升级，不自动恢复或重放；传输通过不等于编解码、显存或帧率通过，详见[v3合同](isolated-storage-lifecycle.md#controlled-avglb-profile-version-3)。同容量合同切换仅有[未来设计](isolated-storage-lifecycle.md#future-same-size-contract-migration-design-only)，尚未实现。
- 候选 `capacity-64-v1`、`capacity-128-v1`、`capacity-256-v1` 分别描述累计媒体／卷容量 64/256MiB、128/512MiB、256MiB/1GiB，均为 `runtimeEnabled: false`；新 core 的离线校验不等于当前 guest 可使用大档位。source 2/8MiB、媒体单文件 32MiB、单次媒体传输 64MiB、宿主恢复 512MiB 不变，旧卷与 pending promise 不自动升级。候选 v2 manifest 将完整 profile／limits 绑定进 digest，不能替换现行 `current-64` 合同。主 Agent 须按完整内容、依赖、构建／暂存峰值及容量证据选最小足够档位，缺测量即 unknown；其他已登记卷尚可增长的部分不能默认为零，源／目标／保留备份都按各自逻辑卷容量计费。普通文件模拟仅使用自建临时树，物理峰值 480MiB、最多 9000 文件，未触及 512MiB／12000 文件／2GiB 空闲的实验边界；真实候选 seed helper 已在离线暂存中验证 1/2/4 个 64MiB 窗口，不代表 guest prepare、发布或运行已启用。allocated blocks／inode／复制峰值和 worker 自报 RSS 不能冒充 ext4 实卷、真实迁移、Linux cgroup、显存或 FPS 验收；同时 RSS 采样受限未完成。方法与单样本结果见[执行存储生命周期](isolated-storage-lifecycle.md)。
- 主 Agent 可用 `recover_isolated_changes` 的 `plan_capacity` 动作和固定 `profileId` 比较候选；结果始终无授权且不可迁移，不写项目设置、不发起审批，也不清除旧任务的未知结果。Canvas 排除项、旧卷几何、inode 和依赖／构建峰值缺证据时仍为 unknown；已知 dirty、未完成转换及任务会阻断。这些 v1 候选不提供迁移授权；另行实现的版本 2 中档走独立原生审批，不能由此 proposal 升级。
- 主 Agent 也可仅用 `plan_first_allocation` 比较已观察的工作区元数据与真实 `current-64`、`capacity-128-v2` 和 `capacity-128-media64-v3` 合同；v1 模拟档不是运行档。按扩展名分类的文件大小不等于内容校验，扫描不完整及 Canvas 排除项保持未知；未来素材、解码内存、显存和帧率不得冒称实测。无卷不证明项目为新建，结果不选择或分配卷、不启动 VM、不批准迁移，也不更改默认；真实 guest 能力、空间、inode、并发预留和原生审批仍须另行核验。
- 独立迁移 core 只在新建 `local-fixture` 私有账本与普通 sparse file 中验收：完整复制／校验逻辑 256MiB 前缀到逻辑 512MiB 目标，保留原件，按两者合计 768MiB 逻辑容量计费；实际物理峰值约 260.02MiB。原 ID 再核验未重写目标，JSON 授权、克隆 plan 及 `controlled-backend` 均拒绝。该最终单样本不等于 ext4 扩容、真实项目迁移或跨进程 stale lease 恢复；新进程仅能按精确持久授权只读核验原结果，保留 stale lease 及承诺，不按时间移除或重用。core 对中断复制续跑和自动回滚明确返回 unsupported，新档运行时仍禁用。复制、seed 暂存、预算提案和迁移 core 是独立证据，不能拼成一次真实准入运行。
- daemon 的 GLB inspect／朝向转换／资源拆分使用单槽可取消 worker：encoded 100MiB、JSON 8MiB、逐引用 reader 派生分配 128MiB（accessor、sparse 和嵌入图片编码字节）。caller 原输入、worker 传入副本、JSON／V8 等另计；256MiB heap 仅额外止损，不能写成 external ArrayBuffer、整进程 RSS 或 GPU hard limit。未知 codec／extension／layout 明确 unsupported，保留原件，不掉扩展、不启用无界 writer／转换 fallback、不自动重生；拆分仍守 source 2／8MiB。此边界不覆盖 browser model-viewer、纹理解码、GPU 或 FBX parser；解析出的三角形、skin／texture 标记与 clip 元数据不是视觉、播放或 FPS 验收。精确限制、单次技术测量及本地结果保全见[本地模型检查](canvas-agent.md#local-model-inspection-and-retained-results)。
- Meshy 已停用：生成、重贴图、减面、绑骨、动画、目录、余额、轮询、远程恢复与产物下载均不再提供；可识别的 Meshy provider／model ID、协议和 endpoint（含旧自定义连接）也不能借旧 Key 或 preset 启用。无法据客户端信息识别完全不透明代理的下游身份，不声称覆盖任意隐藏 relay。旧资产、节点选择、任务、回执和私有缓存保留，不自动改选、重生或删除凭据；本地 GLB 读取／准备仍走既有项目、格式和资源边界。仅已有持久 ToolRun／runId 的本地产物可在原工具／context 一致且既有权限与完整性校验通过时读取／交付；原始 task ID／receipt 不授权远程 poll／download／submit，缺失缓存不承诺找回。Kunpo Tripo 保留，新工作流须明确选择可用连接；支持的预设动画请求最多五个不同动作。此次停用不向已提交任务发起取消，也不自动重试。先前通用 GLB parser／本地增量合并的离线测试仅保留其历史技术范围，不再代表活跃 Meshy batch 能力或服务已接通，详见[3D 当前边界](3d-providers.md)与[本地模型检查](canvas-agent.md#local-model-inspection-and-retained-results)。
- 通用 Shell、原生 CLI、MCP、插件执行仍关闭；作者登录、Cloud、Community、遥测和更新继续退役。浏览器/游戏不在 VM 工作进程的网络命名空间内；Lima 控制面及原生二进制也不是 Node/Chromium 请求钩子的完整观测对象。

最新记录为研究目录 `OhMyGame-VM动态试玩恢复验收-20261027.md`。当前专项测试 34 项通过、16 项旧宿主执行测试跳过；依赖逻辑测试使用文件回调，真实 npm/后代隔离和动态试玩另有 VM/Electron 证据，不能混作全仓通过。

本批修改基于 `42d7e21e396d9adef7a79081416d9cf3b1a97663`（`v0.0.0-beta.4.14`），日期 2026-10-27。修改尚未提交或发布；本批类型检查、334 项模拟/隔离测试和 renderer 构建已完成，真实应用验收尚未进行。官方发行包、作者私有 Cloud 服务和这份本地源码是不同的验证对象；官方安装包不包含本批改动。

当前目标是无需产品账号的本地工作台。原作者账号、Cloud、社区及遥测已经按本地版契约退役；高权限执行框架保留，等待独立隔离方案后恢复。未来飞书身份认证属于另一在线版的边界，本批没有实现登录服务。

## 已改的五类边界

| 范围 | 本批代码行为 | 主要入口 |
| --- | --- | --- |
| 产品登录与作者服务 | renderer 不再初始化 Supabase/session/OAuth；Cloud、Community、远程发布在 daemon 返回 410；客户端底层无传输，不模拟成功 | `src/renderer/auth.tsx`、`src/daemon/cloud-models.ts`、`src/daemon/publish/client.ts`、`src/daemon/app.ts` |
| 遥测与供应链外联 | 删除运行时 PostHog/Sentry、sourcemap 上传插件及自动更新实现；远程 examples/preinstalled prepare 关闭；发布 workflow 不上传、不发布 | `src/desktop/bootstrap.cts`、`src/desktop/main.ts`、`src/desktop/updater.ts`、`vite.config.ts`、`.github/workflows/` |
| 本地 HTTP、IPC 和预览 | 真实 listener 必须有随机 token 且固定 loopback；Host/Origin 检查与认证分别实施；Vite 服务端读 0600 descriptor 注入 Bearer；预览 realpath 后重新验证隐藏路径；特权 IPC 验证主框架和页面 | `src/shared/local-security.ts`、`src/daemon/runtime-descriptor.ts`、`src/daemon/preview-static.ts`、`src/desktop/window.ts` |
| 模型与密钥 | 远程控制面仅允许代码内固定的 Kunpo `llm.ziy.cc` 路径；显式 loopback 模型端点可用；禁跨域重定向；产物下载独立且无 Key/调用方 headers；SDK 改用纯字面量 Key 存储，不解析旧命令、OAuth、环境凭据 | `src/shared/provider-endpoint.ts`、`src/daemon/provider-network.ts`、`src/daemon/local-model-runtime.ts` |
| Agent、文件与导出 | Shell/native CLI/MCP/plugin 执行及任意构建暂禁；Agent 仅注册受控文件和业务工具；文件/私有根/链接校验，Git 最小环境；项目复制、导出排除常见凭据和 daemon 数据 | `src/daemon/local-execution-policy.ts`、`src/daemon/agent-local-files.ts`、`src/shared/private-project-paths.ts`、`src/daemon/project-archive.ts` |

旧 Cloud/遥测/更新环境变量、旧保存设置和按钮入口不能重新启用退役服务。必要版权声明、许可证和静态上游链接保留；手动打开外链属于用户动作，不能与后台请求混为一谈。

## 现在保留什么，哪些暂时不可用

- 保留项目管理、本地文件/画布/素材编辑、受控 Agent 编程与规划、静态 HTML/JS/CSS 预览、截图和 `game_use` 的框架。它们仍需运行验收，不能把“代码保留”当成“已验证可用”。
- 原作者产品登录、Cloud 配额/同步、Community 分享/上传/发布、作者自动更新和目录搜索不提供于本地安全版。
- Shell、PowerShell、原生编码 CLI、插件/MCP 执行、项目依赖安装、package scripts、动态开发服务和任意构建命令暂时拒绝。依赖这些动作的自动编码、构建/打包与动态预览会受影响；原驱动代码保留供未来隔离恢复，不能用环境变量绕过。
- 模型仅启用已核对可经自定义 fetch 的 `openai-completions`、`openai-responses`、`anthropic-messages`。模型元数据不再透传任意 `headers`、`apiKey` 命令、OAuth、SDK 扩展、`compat` 或采样配置。其他协议及特殊兼容参数需要后续单独适配。
- `local-api-keys.json` 是新的 daemon 私有存储，按字面量读写、文件 0600；不迁移 SDK `auth.json`。仅保存 Key 的新自定义连接可以配置；原厂默认 API 地址拒绝，旧登录方式不能连接。
- Kunpo **完整媒体协议适配尚未完成**。图片/视频/3D/音乐/音效/TTS 框架保留，但不能据支持列表声称都能调用。需要鉴权的产物接口、外部 CDN 结果、任务恢复及供应商特有字段必须独立验证；不支持时明确报错。
- 携密钥的 SSE 每条响应最多接收 32 MiB。收到响应头后，连续 180 秒没有收到任何字节才会触发本地空闲超时。每批非空数据（包括服务商心跳）都会重新计时，持续返回数据的响应可以超过 180 秒。整条响应通过跨片段凭据检查后才交给 SDK 显示文本或执行工具。取消会中止本地接收和上游连接，主 Agent 不自动重发该请求。
- 预览资源默认只允许本地同源；远程 CDN、跨端口资源、外部弹窗和下载受限，可能影响已有游戏。

## 已完成的准备与静态核对

已下载并核验官方 Darwin arm64 Bun 1.4.2，ZIP SHA256：

`90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f`

工具位于 `/tmp/ohmygame-toolchain-1.4.2.Y8Qg2W/bin/bun`。隔离配置下使用 `--no-env-file install --frozen-lockfile --ignore-scripts`、官方 npm registry 安装成功（731 packages，退出码 0）。安装前后 `package.json`、`bun.lock` 和两份剩余 patch 相同；没有执行依赖生命周期，没有下载 Electron，也没有生成 `dist`。证据保存在该临时工具目录的 `commands.txt`、`install.log`、`install-result.json`、`dependency-manifest.json` 和 `lifecycle-entries.json`。

对已下载 Pi 1.3.0 进行了只读核对。`pi-telemetry` 实现是 NOOP/内存记录器，未发现其导入自动上传；不能仅按包名判恶意。与此同时，SDK AuthStorage 和 provider 配置确实支持 `!command` 凭据/headers，因此本批在 create 前替换存储、`modelsPath:null`，并重建安全 Provider，移除旧解析链、环境探测和自动目录刷新。

已补写认证/恶意 Origin/Host、preview symlink、执行策略、字面量凭据、Key canary、无 header 产物下载、SSE 大小/取消、导出凭据过滤、退役服务环境变量无效等测试。旧在线私有发布契约与高权限执行成功契约保留为明确 skip，便于未来独立版本恢复；这类 skip 不能算通过。

使用独立临时 HOME/配置/PI 数据、最小环境和假 Key，在明确授权后完成：

| 检查 | 最终结果 | 证据 |
| --- | --- | --- |
| TypeScript `--noEmit` | 退出 0 | `typecheck-final.log` |
| 安全/协议/文件/IPC 模拟与隔离测试 | 29 文件，334 项通过，无跳过 | `security-tests-final.log` |
| renderer 主构建 | 退出 0 | `renderer-build-1.log` |
| renderer sandbox 构建 | 退出 0 | `renderer-sandbox-build-1.log` |
| manifest/lock | dependencies、devDependencies、optionalDependencies 对应一致 | `verification-summary.json` |
| 最终文本 diff 检查 | 退出 0 | `diff-check.log` |

日志目录：`/tmp/ohmygame-security-verification.RxCsXI/`。首次类型检查的两个类型错误（安全模型元数据返回类型、MCP 测试参数）已修复。首次 preview 的 14 项测试被执行沙箱拒绝 loopback 监听，未视作代码通过；具体申请获准后重跑 14/14 通过，最后统一批次亦通过。renderer 有原有大小警告，未作为构建失败。没有启动正式服务、真实桌面应用或 Electron，没有调用模型或使用真实 Key。临时 HTTP listener 仅用于测试且已结束；专用 Bun 进程核对未发现残留。

## 复现与下一阶段边界

实际执行的完整隔离环境和四条命令保存在日志目录 `commands.json`。直接调用项目专用 Bun 与本地 TypeScript/Vitest/Vite 入口，没有调用通用安装、发布或启动脚本；Vitest `--maxWorkers=1`。两个构建写入 `dist/renderer`，没有 sourcemap，没有下载 Electron。脚本禁用安装后，锁文件与两份 patch 的哈希仍不变。

本批 334 项包括 auth、Cloud/publish client 退役、updater、provider-network、local-model-runtime、日志、项目私有根、复制与导出、静态预览、假 Key 公共 JSON、鉴权、桌面 IPC/试玩 mock，以及 9 套媒体协议 mock。网络采用 fake transport 或测试专用 loopback；没有向 Kunpo/原厂/作者发送模型请求。SDK 和依赖测试期间实际执行了部分代码，这不等于已审完所有依赖或证明零外联。

未运行完整测试集。旧 Tripo 后半集成测试、其他原厂默认端点/旧成功路径可能仍需适配新拒绝策略，不能声称全仓绿色。82 个高权限旧成功契约注册记录的 skip 清单在 `/tmp/ohmygame-agent-legacy-skips.json`（含 suite/参数化声明，不是展开后的测试数）；私有 Cloud 发布契约另行停用。它们未计入 334 项通过。

后续需单独审查完整测试、host/player 构建、Node runtime、真正桌面/浏览器预览、打包二进制与模型供应商协议。不得因本批构建成功而自动运行 lifecycle、下载 Electron 或开启高权限功能。

运行验收必须检查：无需登录；启动/空闲/项目/目录/失败/退出及重启均无作者域名请求；旧 telemetry 环境变量无效；假 Key 不出现在 renderer JSON/SSE、错误、日志、诊断 ZIP 或项目导出；未认证/恶意 Host/Origin/WS/IPC 拒绝；隐藏文件和链接拒绝；取消与超时不留后台任务。先用 canary，不使用真实 Key。

## 尚不能下的结论

- “绝对安全”或“已观测作者请求为零”尚不能成立。当前是源码断链和默认拒绝设计，需要运行时拦截记录来验证。
- HTTP/CSP/Electron 请求钩子不等于 OS 网络沙箱。WebRTC 的 ICE/STUN、同 OS 账号恶意进程、并发文件替换及浏览器/原生依赖缺陷仍需独立边界；Vite 代理也不隔离能伪造请求头的本机进程。
- 文件策略按常见名称/目录排除，可能排除普通 `key/auth/token` 文件，不能识别正常源码、画布或用户提示中手写的任意秘密。选中发送给模型的代码/参考图本来就是模型输入，使用前仍需检查项目内容。
- 上游服务及它返回的文件仍须信任。精确脱敏可阻断已知明文 Key/常见转义及受测 delta 组合，不能证明压缩、加密或隐写内容绝无秘密。模型控制面和同源产物策略不证明 Kunpo 私有后台的行为。
- daemon 与 desktop 是独立进程，离线 fallback 不能自动获知从未传入主进程的历史裸 Key。旧诊断文件仍需按当前已知值脱敏和人工审查。
- 依赖仅下载和重点静态审读，未逐行审完全部依赖，也未验证官方二进制、编译后产物、签名、私有 Cloud、真实 Kunpo 账户能力或价格。本批没有操作系统级网络隔离和在线认证。

上线或投入真实 Key 前，至少完成上述检查、依赖执行审查和新制品网络观测；高权限功能只能在能限制凭据、文件和网络的受控隔离环境中恢复。

## 2026-10-27 真实网页验收追加

使用隔离 HOME/数据、Bun 1.4.2、真实 daemon/Vite、受支持的任务浏览器及 loopback 假模型，实际完成无需登录进入、创建/打开项目、Agent 文件写入、静态预览和计数点击、画布保存/CAS、假 Key 拆分回传拒绝、鉴权与 Host/Origin/WebSocket/符号链接拒绝及项目/诊断导出。

该轮修复 Vite 动态端口转发，并允许只读返回 native runtimes 的硬禁用状态，避免引导界面因 403 中断。写操作/登录/执行仍拒绝。项目导出增加对进程内已注册凭据及常见转义形式的内容拒绝；它在生成 ZIP 前检查文件，以有界流尾处理跨块 Key。普通名称中的未知秘密、尚未注册的历史 Key 及并发外部文件替换仍不是已解决的范围。

本轮没有重跑此前 334 项；仅运行相关回归 43 项，全部通过，类型检查和 renderer 构建通过。对实际进程网络 API、浏览器资源/请求事件和两个 PID 的 socket 快照进行观测，未记录非 loopback 尝试。监测本身限制外联，且不覆盖所有原生/UDP/WebRTC/子进程路径，不能推广为无监测运行时的绝对零外联。

完整小型记录位于研究目录 `OhMyGame-真实网页启动与外联验收-42d7e21-20261027.md`。日志在 `/tmp/ohmygame-live-acceptance.MJQsHG/`。现有 Node 22.13.0 低于项目要求，Electron 未下载/启动，`game_use` 的桌面路径和正式 Node/Electron 制品仍需独立批准及验收；暂不据此建议接入真实 Key。

## 本地图片工程副本（源码，需重启 daemon 后启用）

Agent 的 `generate_image` 先将原始字节按 SHA-256 保留在应用数据目录的
`image-recovery/<projectId>/image-originals/`，不放入执行工作区，再用本地 Sharp 校验工程副本。
默认 identity，保留原始字节、尺寸和像素；不默认缩到 1024px／512KiB，也不自动升画质。
只有明确 `maxEdge` 才缩图，且不放大、不失败后降档重试；PNG／WebP 在显式准备时保留透明通道，JPEG 显式准备使用 quality 90。不按图像内容或“图标／背景”类别分配尺寸。
不支持动画、多页或高位深输入，输入与工作副本各限 32MiB、解码限制 32MP，单个保留原件上限 64MiB。
工程副本记录与原图 hash 关联，准备记录留在私有 `image-preparations/`。
该恢复目录独立于 `projects/<projectId>/`；显式项目删除保留原件、provenance 和事务 payload。
释放 promise 需对应发布已 terminal、无活跃资源拥有者且身份和持久记录逐项匹配；source intent
另需本次真实来宾退役回执提供 `sourceRetired: true`，不能仅凭旧历史或本地删除意图清除。
只有 local-image intent 的项目可在无 VM 的本地删除流程中按相同核验释放该 intent。
旧项目目录内的原件仍会阻止删除、要求先独立保全。这不是全应用备份或永久可恢复保证。

审批展示编码字节、尺寸／像素数、RGBA8 解码／基础纹理及完整 mip 链（含基础层）估算，
解码门限不是设备预算，实际显存、目标设备兼容性和 FPS 未实测。
真实目标 WebGL 环境可用时，仅在现有受控 `game_use`／项目 instrumentation 内读取
`MAX_TEXTURE_SIZE` 并核对 atlas 宽高；上限是能力值，不是性能预算或推荐尺寸。
拆 atlas 还需核帧映射、anchors、透明边缘／padding，并测 batching、draw calls、帧时间，
不能仅凭纹理字节数判断。缺目标设备或 FPS 目标时询问用户或标为候选；没有真实环境就明确未测。

`optimize_image_asset` 不调用模型或 VM，可在 VM 源码预算阻塞时执行。
旧素材可用 `paths` 一次选择至多 16 个同格式原位替换；先核验并保存所有原图，
再按预计结果分别检查符合路径及内容规则的运行媒体（32MiB／文件、64MiB／媒体集合）
和普通源码（2MiB／文件、8MiB／源码总量），并保留共享的 2000 文件及遍历项上限。
大图不再因被误算为普通源码而默认缩小；这也不允许任意二进制改名成为运行媒体。
原件、工作版、前后备份、暂存及账本还须通过完整 512MiB 恢复事务与宿主余量准入，
不是仅检查最后输出文件大小，也不是全应用统一磁盘配额。
本批接入空间账本的本地入口为 `ProjectManager` 的图片优化、生成图工作副本和启用图片准备的
导入路径。它们将真实 `data/image-recovery/<projectId>/` anchor 与工作区绑定，
与隔离源码恢复共用本 daemon 按文件系统设备计量的持久 promise、完整 space plan 和余量复查。
恢复目录与工作区跨文件系统时，在改动工程文件前拒绝；这不等于此前没有读取或创建私有元数据。
嵌套准备复用当前品牌 token，原 ID／identity no-op 不新建一个替代恢复来清除未知状态。
本地发布结果未知或未 terminal 时保留原 intent，不靠超时释放，也不自动重分类旧 source 历史。
启动的独立 cold loader 扫描应用图片恢复目录，不只依赖成功载入的项目列表；损坏项目卡片若仍有
promise，会 latch 新分配阻断。没有 promise 的 orphan 目录保持原状，不重建工作区或补造承诺。
未知或损坏账本仍要求检查，不能通过重启或空 restore 清除。上述范围不覆盖全部 Library、缓存、
其他媒体路径或所有应用写入，不是全应用磁盘配额。
目标不足以满足预算时不修改工程文件；可明确选择 256、512、1024、1536、2048px
重新进行本地准备。生成阶段若准备失败会返回保留的 `originalId`，可用该 ID 和
新 `destination` 重试，不应重复付费生成。替换前重新校验源文件，普通失败回滚已写副本；
检测到其他写入者改变文件时停止，保留原图供恢复。不绕过符号链接、已知凭据或私有路径限制。
生成图结果进入本地工作副本队列时，取消信号从 Agent 工具贯穿到准备和发布；排队后、解码及
发布边界重新检查，不因等待结束就继续替已取消任务写入。它不证明上游请求未执行或未计费。
现有运行中的项目不会因源码更新而自动迁移；本次单元测试不代表真实 VM 或视觉验收。

完整静态图片校验与显式工作图变换共享本 daemon 的单槽解码队列，准备、审批及发布
通过同一 full validator 重新校验时也使用该队列。它限制这些路径同时进行的完整像素工作，
不表示全部 Sharp 线程、元数据读取、聊天参考图、缩略图、浏览器或其他视觉路径全局串行。
本次 CPU 性能记录使用 M5 Pro 上的合成图片、每组独立 worker 内多次串行默认准备，
测得的是该本机流程耗时与进程峰值 RSS；其中包含 TypeScript runtime 及重复准备开销，
不是纯解码分配或所有输入的最坏界限，也不是目标设备、GPU 显存或游戏 FPS 实测。
