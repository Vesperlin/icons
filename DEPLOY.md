# Vesper Obsidian Nexus 部署与运维手册

本手册汇总了前期讨论中“全功能、可绑定自有域名、具备后端鉴权与自动化”的全部要求，并融入了可能来自主干分支的说明，以减少合并冲突。
请按章节顺序执行，遇到差异时以本文件为准，不需要再人工合并。

## 1. 首次准备（Windows）
1. 从 [Node.js 官网](https://nodejs.org) 下载 LTS 版本并安装，勾选“添加到 PATH”。
2. 在 `cmd` 执行 `node -v` 与 `npm -v`，出现版本号即安装成功。
3. 创建项目目录（如 `vesper-nexus`），将仓库代码放入其中（下载压缩包或 `git clone <仓库地址> .`）。
4. 处理依赖安装（详见下方“npm 403”说明）：
   ```bash
   npm install --registry=https://registry.npmmirror.com
   ```
5. 初始化数据库：`npm run migrate`，生成 `data/app.db` 并自动写入最高权限识别码 `Vesper`。
6. 启动开发模式：`npm start`，浏览器访问 `http://localhost:3000`。

### npm registry 403 的原因与解决
- **原因**：国内网络对 `https://registry.npmjs.org` 有时返回 403/网络重置；或企业代理/安全软件阻止外部请求。
- **解决**：
  - 临时：为本次安装指定镜像（上文命令）。
  - 永久：`npm config set registry https://registry.npmmirror.com`。
  - 若依赖私有包，可在 `.npmrc` 单独声明官方源，只对私有作用：
    ```bash
    npm config set @scope:registry https://registry.npmjs.org
    ```
  - 这类 403 仅影响依赖下载，切换镜像即可，不会影响运行逻辑。

### 常见问题
- **端口被占用**：设置 `PORT=4000 npm start`。
- **数据库无写权限**：确保 `data/` 可写，或通过 `DATABASE_PATH` 指定路径。

## 2. 部署到 Linux 并绑定域名/HTTPS
1. 安装 Node.js（可用 nvm 或官方二进制）。
2. 获取代码：`git clone <仓库地址> /opt/vesper-nexus` 或上传压缩包解压。
3. 安装依赖与迁移：
   ```bash
   cd /opt/vesper-nexus
   npm install --production --registry=https://registry.npmmirror.com
   npm run migrate
   ```
4. 配置环境变量（可写入 `.env` 或 systemd）：
   - `PORT=3000`
   - `JWT_SECRET=<长随机串>`
   - `DATABASE_PATH=/opt/vesper-nexus/data/app.db`
5. 试运行：`npm start`，看到日志 `Vesper Nexus server running on port 3000` 后 Ctrl+C 退出。
6. systemd 常驻示例：
   ```ini
   # /etc/systemd/system/vesper-nexus.service
   [Unit]
   Description=Vesper Obsidian Nexus
   After=network.target

   [Service]
   WorkingDirectory=/opt/vesper-nexus
   Environment=PORT=3000
   Environment=JWT_SECRET=change-me
   Environment=DATABASE_PATH=/opt/vesper-nexus/data/app.db
   ExecStart=/usr/bin/node src/server.js
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```
   执行 `sudo systemctl daemon-reload && sudo systemctl enable --now vesper-nexus`。
7. Nginx 反代：
   ```nginx
   server {
     listen 80;
     server_name your.domain.com;

     location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     }
   }
   ```
   `sudo nginx -t && sudo systemctl reload nginx`。
8. HTTPS：
   ```bash
   sudo snap install core; sudo snap refresh core
   sudo snap install --classic certbot
   sudo ln -s /snap/bin/certbot /usr/bin/certbot
   sudo certbot --nginx -d your.domain.com
   ```

### 域名与移动端访问
- 域名解析到公网 IP 后即可通过 `https://your.domain.com` 访问。
- 前端响应式，手机/平板可直接使用。

## 3. 后端接口与自动化（总览）
- 认证：`/api/auth/send-code`、`/register`、`/login`、`/forgot`/`reset`。
- 开发者码：`/api/developer/generate`、`/revoke`、`/bind`（root/admin/developer 层级）。
- 图标与知识：`/api/icons`、`/api/icons/group`、`/api/knowledge` CRUD。
- VIP/优惠：`/api/vip/purchase` 创建订单，`/api/vip/confirm` 网关回调自动升级；优惠码在订单内验证。
- 云盘/文件：`/api/files/upload`、`/api/files`（列表/删除）。
- 剪藏/工具箱/搜索：`/api/clips`、`/api/tools`、`/api/search`。
- 笔记/博客：`/api/notes`、`/api/posts`。
- 审计与管理：`/api/audit`、`/api/admin/users`、`/api/admin/status`。

## 4. 运维与备份
- 数据：`data/app.db`，定期 `cp data/app.db data/app.db.bak`。
- 升级：`git pull` → `npm install --production --registry=https://registry.npmmirror.com` → `npm run migrate` → `sudo systemctl restart vesper-nexus`。
- 日志：`journalctl -u vesper-nexus -f`。

## 5. 故障排查
- **页面 502**：确认 Node 服务与 Nginx 反代指向正确端口。
- **生成/绑定识别码失败**：数据库只读或请求缺少 Bearer Token，重新迁移或补充认证头。
- **验证码未返回**：开发模式响应含 `codePreview`，生产需接入邮箱/短信网关后替换发送逻辑。
- **支付未自动开通**：确认网关回调 `/api/vip/confirm` 传入 `{ orderId, success: true }`，且数据库可写。

完成后即可获得可绑定自域名、具备后端鉴权与自动化逻辑的 Vesper Obsidian Nexus。
