# 贡献快速指引

欢迎提交问题复现、文档改进、小修复、插件，以及实际制作游戏时的反馈。
[CONTRIBUTING.md](../CONTRIBUTING.md) 是完整贡献规范；本文提供中文入口。

本工作区是本地安全源码版，先读[本地安全策略](local-security.md)。下述上游分支流程
不代表重新克隆上游即可取得本地改动；运行检查和启动仍待依赖审阅及单独授权。

## 选择任务

先搜索已有 Issue。新功能和大改动先在 Issue 中讨论，明确范围；简单修复和
文档纠错可以直接发 PR。可以关注 `good first issue` 和 `help wanted` 标签，
没有合适任务时，也可以提出你想做的改进。

## 开始开发

日常贡献从上游 `dev` 建分支，PR 的目标也是 `dev`。`main` 用于维护者发布。
Fork 仓库后，把下面的 `YOUR_USERNAME` 换成你的 GitHub 用户名：

```bash
git clone https://github.com/YOUR_USERNAME/ohmygame.git
cd ohmygame
git remote add upstream https://github.com/WhiteTowerAI/ohmygame.git
git fetch upstream
git switch --no-track -c fix/short-description upstream/dev
ELECTRON_SKIP_BINARY_DOWNLOAD=1 bun install --frozen-lockfile --ignore-scripts
```

需要 Git、Bun 1.4.2+ 和 Node.js 22.19+（包含 npm）。这一步只下载锁定依赖，
不运行 lifecycle scripts，也不安装 Electron 二进制；不能据此断言构建或启动可用。

本版不提供账号、调试身份、云发布、社区或云额度，不需要登录配置；作者遥测、
远程更新、远程插件和示例准备已停用，环境变量不能恢复。CLI、MCP、插件代码、
任意命令、项目依赖及构建/开发服务器执行等待隔离方案。静态编辑与支持的静态预览保留，
模型端点和功能兼容性需另行验证。浏览器限制不等于操作系统级网络隔离。

代码、文档和测试入口见[文档索引](README.md#where-to-change-things)。
可选配置和常见启动问题见[完整开发指南](../CONTRIBUTING.md#start-local-development)。

## 检查与 PR

纯文档改动检查链接、示例和格式，并运行 `git diff --check`。
应用行为、依赖或 CI 改动在依赖审阅并获得运行授权后，先执行聚焦检查；要求见
[验证说明](../CONTRIBUTING.md#make-and-check-your-change)：

```bash
bun run typecheck
bun run test -- test/auth.test.ts test/cloud-models.test.ts test/desktop-updater.test.ts test/desktop-update-scheduler.test.ts test/model-network-policy.test.ts test/provider-network.test.ts
bun run build:renderer
```

这些检查尚未执行，会运行下载的工具和项目配置，渲染端构建会写入 `dist/renderer`。
跳过安装脚本可能使原生工具不可用；遇错先检查，不自动补跑脚本。完整测试和
`test:node-runtime` 还涉及进程或服务启动，应另行审阅授权。云端契约属于已停用的
上游能力，不配置凭据恢复它们；在 PR 中说明实际结果和未覆盖项。CI 模板仍包含
更广检查，本轮未触发或验证。

优先扩展已有测试和文档。删除或合并测试前，按
[测试与文档精简规则](../CONTRIBUTING.md#keep-tests-and-documentation-focused)
说明由哪个测试继续覆盖。

每个 PR 聚焦一件事。分支前缀使用 `feat/`、`fix/`、`docs/`、`chore/` 或
`refactor/`；PR 标题使用 Conventional Commits，例如
`docs(contributing): clarify local setup`。

填写 PR 模板，说明改了什么、为什么改、如何验证，关联相关 Issue，并记录
尚未完成的检查。UI 改动附截图或短录屏。显式选择上游 `dev` 作为目标分支；
GitHub 在分支迁移期间仍可能默认选择 `main`。

[更新日志](../CHANGELOG.md)由维护者在准备发布时统一整理，普通 PR 无需修改。
在 PR 描述中说明用户可感知的变化，便于维护者编写发布说明。

可以先发 Draft 获取反馈，完成后标记为可评审。评审中的后续修改继续推送到
同一个贡献分支；遇到阻碍，在 PR 中说明。

安全问题请按照 [SECURITY.md](../SECURITY.md) 私下报告。贡献遵循仓库的
[Apache 2.0 许可](../LICENSE)。
