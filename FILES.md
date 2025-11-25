# Vesper Obsidian Nexus 文件导航

| 文件 | 作用 | 可修改内容 |
| --- | --- | --- |
| README.md | 项目需求原文，保留对照。 | 可增补说明，但勿删除原始需求。 |
| 目前很少的代码.html | 主页面，包含样式、布局、脚本和所有前端逻辑（图标库、权限、开发者模式、支付/优惠演示等）。 | 可按需调整样式、数据结构、文案；更新图标数据、功能区描述或交互逻辑。 |
| DEPLOY.md | 部署与使用全流程手册，面向零基础用户。 | 可补充新的运行方式或问题排查。 |
| FILES.md | 本文件，用于快速了解目录与可变更范围。 | 根据新增文件更新表格。 |

## 关键模块速览（位于 `目前很少的代码.html` 内）
- **配置区**：顶部的 CSS 变量与 `baseIconData`、`featureBlocks`、`uiPresets` 常量，用于控制主题、初始数据与分区描述。
- **状态管理**：`state` 对象持久化至 `localStorage`，包括图标、识别码、优惠码、用户与会话。
- **渲染函数**：`renderNavigation`、`renderGrid`、`renderAuth`、`renderAdmin` 等负责更新视图。
- **权限逻辑**：`openDevVerify` 绑定设备到开发者识别码；`buildCodeManager`/`buildCouponManager`/`buildUserInspector` 提供最高权限操作入口。
- **交互与工具**：上下文菜单（复制/下载/ICO）、拖拽排序、三击删除（仅开发者）、VIP/优惠码模拟、主题切换、搜索过滤。
