# Vesper Obsidian Nexus 文件导航

| 文件 | 作用 | 可修改内容 |
| --- | --- | --- |
| README.md | 原始需求与全栈化说明，包含快速启动与部署提示。 | 可补充说明，但勿删需求段落。 |
| public/index.html | 前端界面：深色 UI、账户/验证码/开发者绑定、图标分组管理、知识卡片、VIP 订单、用户与审计视图。 | 可调整样式、布局、文案与前端交互逻辑。 |
| src/server.js | Express 后端：鉴权、开发者码、图标/知识 CRUD、优惠与 VIP 订单、用户与审计接口。 | 可扩展 API、校验、支付回调或安全策略。 |
| src/db.js | SQLite 初始化与迁移，注入初始 Root 识别码 `Vesper`。 | 可调整表结构、默认种子数据。 |
| DEPLOY.md | 端到端部署手册，覆盖 Windows 初始化、Linux/域名/HTTPS、运维与排障。 | 可根据环境更新命令或新增网关示例。 |
| .gitignore | 排除 `node_modules`、数据库文件等。 | 可按需添加忽略项。 |
| package.json | Node 项目配置与依赖。 | 更新依赖或脚本。 |
