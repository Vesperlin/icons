# Vesper Obsidian Nexus 部署与运维手册

本手册面向零基础用户，假设首轮在 Windows 设备完成初始化，随后可在 Linux 服务器绑定域名并长期运行。每一步都写明命令、可能的错误与排查方法。

## 1. 首次准备（Windows）
1. 从 [Node.js 官网](https://nodejs.org) 下载 LTS 版本并安装，勾选“添加到 PATH”。
2. 打开 `cmd`，执行 `node -v` 与 `npm -v`，看到版本号表示安装成功。
3. 在桌面创建文件夹 `vesper-nexus`，右键“在终端打开”。
4. 获取代码：
   - 直接下载压缩包：解压到 `vesper-nexus`。
   - 或使用 Git：`git clone <仓库地址> .`
5. 安装依赖：在 `vesper-nexus` 执行 `npm install`。如果提示 `403 Forbidden` 或网络错误，可改用国内镜像：
   ```bash
   npm install --registry=https://registry.npmmirror.com
   ```
6. 初始化数据库：`npm run migrate`，生成 `data/app.db` 并自动写入最高权限识别码 `Vesper`。
7. 启动开发模式：`npm start`，浏览器访问 `http://localhost:3000`。

### 常见问题
- **npm 安装报 403/网络错误**：切换镜像，如上所示；或手动下载依赖放入 `node_modules`。
- **端口被占用**：修改 `PORT` 环境变量，如 `PORT=4000 npm start`。
- **数据库无写权限**：确保 `data/` 目录可写，或设置 `DATABASE_PATH=C:\path\to\app.db`。

## 2. 部署到 Linux 服务器并绑定域名
以下示例以 Ubuntu 为例，目标是通过 Nginx 反向代理到 Node 服务，绑定自有域名并启用 HTTPS。

1. 服务器安装 Node.js（推荐 nvm 或直接下载二进制）。
2. 上传代码：
   - 使用 Git：`git clone <仓库地址> /opt/vesper-nexus`。
   - 或 SFTP 上传压缩包并解压。
3. 安装依赖并迁移数据库：
   ```bash
   cd /opt/vesper-nexus
   npm install --production
   npm run migrate
   ```
4. 配置环境变量（可写入 `/opt/vesper-nexus/.env` 或 systemd）：
   - `PORT=3000`
   - `JWT_SECRET=<自定义长随机串>`
   - `DATABASE_PATH=/opt/vesper-nexus/data/app.db`
5. 使用 `npm start` 试跑，确认日志出现 `Vesper Nexus server running on port 3000` 后按 `Ctrl+C` 退出。
6. 以 systemd 方式常驻（示例）：
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
   然后执行 `sudo systemctl daemon-reload && sudo systemctl enable --now vesper-nexus`。
7. 安装 Nginx：`sudo apt install nginx`。
8. 配置反向代理（替换你的域名）：
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
   启用并重载：`sudo nginx -t && sudo systemctl reload nginx`。
9. 启用 HTTPS（Let’s Encrypt）：
   ```bash
   sudo snap install core; sudo snap refresh core
   sudo snap install --classic certbot
   sudo ln -s /snap/bin/certbot /usr/bin/certbot
   sudo certbot --nginx -d your.domain.com
   ```
   按提示完成证书申请，证书自动续期。

### 域名与移动端访问
- 域名解析到服务器公网 IP，等待生效后即可通过 `https://your.domain.com` 访问。
- 移动端在同一网络下直接访问域名或内网地址即可，前端已自适应。

## 3. 后端接口与自动化
- 开发者识别码：`/api/developer/generate` 生成（支持 root/admin/developer），`/api/developer/revoke` 收回，`/api/developer/bind` 绑定设备。
- 用户与认证：`/api/auth/send-code` 发送验证码，`/api/auth/register` 注册，`/api/auth/login` 登录，`/api/auth/forgot` / `reset` 找回密码。
- 图标管理：`/api/icons/group` 创建分组，`/api/icons` 增删改，`/api/icons` GET 拉取。
- 知识/工具：`/api/knowledge` 增删改查。
- VIP 订单：`/api/vip/purchase` 创建订单（记录支付渠道与优惠码），`/api/vip/confirm` 由网关回调时调用，成功后自动更新用户 VIP。
- 审计与用户：`/api/audit` 获取日志，`/api/admin/users` 查看用户，`/api/admin/status` 更改状态/封禁。

## 4. 运维与备份
- 数据位于 `data/app.db`，定期复制备份即可（如 `cp data/app.db data/app.db.bak`）。
- 升级流程：
  1. `git pull` 或重新上传代码。
  2. `npm install --production`（若依赖更新）。
  3. `npm run migrate`（安全重复执行）。
  4. `sudo systemctl restart vesper-nexus`。
- 日志：systemd 下使用 `journalctl -u vesper-nexus -f`。

## 5. 故障排查
- **页面 502**：确认 Node 服务是否运行，`systemctl status vesper-nexus`；检查 Nginx 配置是否指向正确端口。
- **无法生成/绑定识别码**：数据库只读或表缺失，重新执行 `npm run migrate`；确保请求附带 Bearer Token。
- **验证码/重置验证码未返回**：开发模式会在响应中返回 `codePreview`，生产环境需配置邮箱或短信网关后替换发送逻辑。
- **支付未自动开通**：确认网关回调指向 `/api/vip/confirm` 并传递 `{ orderId, success: true }`；检查数据库写权限。

完成上述步骤后，你将获得可绑定自有域名、具备后端鉴权与自动化逻辑的 Vesper Obsidian Nexus。首次在 Windows 初始化后，后续日常运维可在手机或任意终端通过域名完成。
