# dsh-wb-desk · 资料库

**简体中文** | README 边界声明同样适用于一切宣传材料

Agent 原生产物空间：让 Agent 产出的文件不再散落在各会话工作区，而是自动归位、可管理、可继续读取加工。对标 WorkBuddy 资料库的 DSH 插件。

## 功能

- **分级写入**：Agent 新建文件免确认自动落盘；修改库内已有文件先进入持久化"待确认"队列，你在面板里接受后才覆盖原文（拒绝的内容留档可找回）
- **自动归位**：Agent 写到库外的产出，按规则归位一份副本到 `inbox/`（重名加时间戳分开保存）
- **固定修订引用**：Agent 首次读取库内文件时自动固定该时刻版本；文件随后被修改，Agent 读到的仍是固定版本并收到漂移提示；面板可一键释放
- **目录管理**：递归目录树、文本预览、全库按行搜索
- **开箱即用**：安装后自动初始化 `inbox/`、`projects/`、`archive/`（已有内容原地收编，不移动不改名）

## 明确的边界

- 无在线发布（无公网托管能力）
- 无多人实时协同编辑
- 无 RAG/向量检索（检索请用 dsh-agentic-rag 等插件）
- 不做 Office 文档在线编辑
- 无共享空间/多人协作（未来另行设计）
- 与 `dsh-wb`（WorkBuddy 桥接插件）、`dsh-desk`（桌面发行版）无任何关联，名字相邻纯属查找时的巧合

## 数据与隐私

- 文件本体是普通文件，直存 `$DSH_HOME/library/`（`DSH_WB_DESK_ROOT` 可覆盖），库外任何程序都能直接打开
- 插件元数据（待确认队列、pin 快照）收在 `library/.dsh-library/` 隐藏目录
- 拦截基于宿主 `tools/pre-execute` / `tools/post-execute` waterfall，只对 write/edit/read 类**工具调用**生效；Agent 用命令行落盘不在拦截范围内（此时以快照兜底）

## 安装

```
dsh plugin --profile desktop add github:<owner>/dsh-wb-desk
```

完整退出 DSH（含托盘后台进程）后重启生效。

## 开发

```sh
npm install --ignore-scripts
npm run build     # tsdown 编译 src/index.ts → lib/index.js；client.js 免构建直发
```

宿主改动必须重启 DSH；client.js 改动刷新页面即可。

## License

MIT
