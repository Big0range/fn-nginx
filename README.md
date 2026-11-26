# Simple Nginx

在 fnOS 上管理一个内置 Nginx 的轻量面板：直接编辑配置、启动/停止/重载、查看负载与调整常用性能参数。

前端是单文件页面（`app/server/public/index.html`，无 CDN 依赖），后端为 Express，负责读写 `nginx.conf`、`conf.d/*.conf` 并调用内置的 Nginx 二进制。

## 功能

- **配置管理**：`conf.d/*.conf` 新建、编辑、删除；`nginx.conf` 主配置可直接编辑（不可删除）
  - Nginx 语法高亮、行号、Tab 缩进、`Ctrl/Cmd + S` 保存
  - 未保存切换文件时拦截提醒；文件名白名单校验，防路径穿越
- **进程控制**：启动 / 强制停止 / 重载（停止发送 SIGTERM，3 秒内未退出则 SIGKILL 并清理 pid 文件），顶部状态胶囊显示运行状态与 PID（6 秒轮询），并显示 Nginx 版本号
- **负载状态**：活动连接、accepts、handled、requests、Reading / Writing / Waiting、worker 数量 / CPU / 内存，可收起展开
- **性能调整**：`worker_processes`、`worker_connections`、`keepalive_timeout`、`gzip` 等 10 个指令的展示与编辑，未配置项标注 nginx 默认值

## 目录结构

```
.
├── manifest                  # fnOS 应用元信息（应用名、服务端口、依赖 nodejs_v24 等）
├── fnpack                    # 打包工具
├── cmd/                      # fnOS 生命周期脚本（main / install / uninstall / upgrade ...）
├── config/
│   ├── privilege             # 运行权限（run-as: package）
│   └── resource              # 共享目录声明
├── app/
│   ├── ui/                   # 桌面入口配置与图标
│   │   └── config            # iframe 入口，经统一网关 /app/simple-nginx 访问
│   └── server/
│       ├── app.js            # Express 入口
│       ├── routes/api.js     # 管理接口
│       ├── utils/nginx.js    # 配置解析、进程控制、负载与性能参数
│       ├── config/index.js   # 路径与环境变量统一出口
│       ├── public/index.html # 管理页面
│       └── nginx/
│           ├── sbin/nginx    # Linux x86_64 二进制
│           ├── conf/         # nginx.conf 及默认配置文件
│           ├── conf.d/       # 站点配置目录
│           └── nginx-control # 命令行启停脚本（start|stop|reload|test）
└── nginx-demo.fpk            # 打包产物示例
```

## 开发运行

```bash
cd app/server
npm install
npm start          # node ./bin/www
```

访问 `http://localhost:12400`（未设置环境变量时的默认端口）。本地未设置 `TRIM_APPDEST` 时只监听 TCP 端口，不启用统一网关。

生产环境由 fnOS 注入 `TRIM_SERVICE_PORT`，同时监听 `${TRIM_APPDEST}/app.sock`，桌面入口通过统一网关打开：`https://<NAS 域名>/app/simple-nginx`。

### 在 Windows 上开发

仓库内的 Nginx 是 Linux ELF 二进制，Windows 下无法执行，因此：

- 进程状态恒为“已停止”，启动/停止/重载会返回明确错误提示
- 版本号仍可显示（执行不了时从二进制文件内容中提取版本字符串）
- 负载数据为 `null`，页面显示 `—`
- 配置读写、性能参数编辑不受影响（只改文件，不依赖执行 Nginx）

## 访问方式（统一网关）

应用通过 fnOS 统一网关接入，不再依赖 HTTP 端口直连，因此宿主为 HTTPS 时也不会被浏览器的混合内容策略拦截：

- `app/ui/config` 声明 `gatewayPrefix: /app/simple-nginx`、`gatewaySocket: app.sock`
- 服务在 `${TRIM_APPDEST}/app.sock` 监听 Unix Socket，启动时清理残留 socket 文件并 `chmod 0666`
- 网关先校验 NAS 登录态，再把 `/app/simple-nginx/**` 原样转发到该 Socket
- 服务端统一剥掉 `/app/simple-nginx` 前缀，路由仍是 `/` 与 `/api/**`；前端按 `location.pathname` 自动补前缀
- 转发请求会带上 `X-Trim-Userid` / `X-Trim-Isadmin` / `X-Trim-Username`，当前仅依赖网关的登录校验，未做额外业务鉴权
- `protocol` 与 `port` 对网关入口无效，`app/ui/config` 中不再声明

原有 TCP 端口监听保留，便于本地开发与直连调试。

## 路径与环境变量

所有路径由 `app/server/config/index.js` 统一计算：

| 变量                                | 说明                              | 生产环境                             | 本地开发                           |
| ----------------------------------- | --------------------------------- | ------------------------------------ | ---------------------------------- |
| `TRIM_PKGVAR`                       | 应用数据目录                      | 由 fnOS 注入                         | 未设置                             |
| `TRIM_APPDEST`                      | 应用安装目录                      | 由 fnOS 注入，网关 Socket 为 `$TRIM_APPDEST/app.sock` | 未设置（不启用网关） |
| `TRIM_SERVICE_PORT` / `wizard_port` | 服务端口                          | 由 fnOS 注入（对应 manifest 的 `service_port`） | 12400                    |
| `NGINX`                             | nginx 二进制                      | `$TRIM_PKGVAR/nginx/sbin/nginx`      | `app/server/nginx/sbin/nginx`      |
| `NGINX_P`                           | `-p` 前缀目录                     | `$TRIM_PKGVAR/nginx`                 | `app/server/nginx`                 |
| `NGINX_C`                           | 主配置 `-c`                       | `$TRIM_PKGVAR/nginx/conf/nginx.conf` | `app/server/nginx/conf/nginx.conf` |
| `NGINX_D`                           | 站点配置目录                      | `$TRIM_PKGVAR/nginx/conf.d`          | `app/server/nginx/conf.d`          |
| `NGINX_STUB_URL`                    | 可选，直接指定 `stub_status` 地址 | —                                    | —                                  |

> `nginx-control` 脚本使用的是 `$TRIM_APPDEST/app/server/nginx/sbin/nginx`、`$TRIM_PKGETC/nginx`、`$TRIM_PKGVAR/nginx`。部署时请保证它与管理接口实际读写的配置目录一致，否则页面里改的配置不会被真正加载。

## HTTP 接口

统一约定：错误返回非 2xx 且 `{ "message": "..." }`；JSON 响应禁用缓存。

下表为服务内部路由；经统一网关访问时实际路径为 `/app/simple-nginx` + 对应路径（例如 `/app/simple-nginx/api/status`）。

| 方法   | 路径                                       | 说明                                     |
| ------ | ------------------------------------------ | ---------------------------------------- |
| GET    | `/api/configs`                             | `conf.d` 配置列表 + 主配置元信息         |
| GET    | `/api/configs/:name`                       | 读取单个配置文件 `{ content }`           |
| PUT    | `/api/configs/:name`                       | 新建或覆盖，body `{ content }`           |
| DELETE | `/api/configs/:name`                       | 删除配置文件                             |
| GET    | `/api/main-config`                         | 读取主配置 `nginx.conf`                  |
| PUT    | `/api/main-config`                         | 保存主配置，body `{ content }`           |
| GET    | `/api/status`                              | `{ running, pid, version }`              |
| GET    | `/api/load`                                | `{ stub, process }` 负载数据             |
| GET    | `/api/performance`                         | `{ items: [{ key, value, isDefault }] }` |
| PUT    | `/api/performance`                         | body `{ values }`，写回 `nginx.conf`     |
| POST   | `/api/start` / `/api/stop` / `/api/reload` | 启动 / 强制停止 / 重载 Nginx             |

配置文件名校验规则：`[A-Za-z0-9_][A-Za-z0-9._-]*.conf`，禁止以 `.` 开头及包含 `..`。

### 性能参数写入规则

- 已存在的指令：原位替换第一次出现的值
- 缺失的指令：`worker_processes` 写入顶层，`worker_connections` 写入 `events {}`，其余写入 `http {}`
- 取值有白名单校验（`auto`/数字、`on|off`、压缩级别 `1-9`、尺寸 `1|20m|512k` 等）
- 保存后需点击“重载”才会生效

## 负载数据说明

- 连接与请求统计依赖 `stub_status`。在主配置或站点配置中添加：

```nginx
location = /nginx_status {
    stub_status;
    allow 127.0.0.1;
    deny all;
}
```

后端会自动从配置中解析 `stub_status` 所在 location 的路径与 `listen` 端口并请求 `127.0.0.1`；也可用 `NGINX_STUB_URL` 指定。未配置时对应项显示 `—`。

- worker 数量 / CPU / 内存通过 `ps` 汇总 `nginx: worker process`，仅在 Linux 下可用。

## 构建与部署

在 Linux / fnOS 环境下执行（`fnpack` 为 Linux 二进制）：

```bash
./fnpack build      # 生成 .fpk 安装包
```

- 依赖 `nodejs_v24`（`install_dep_apps`），安装后由 `cmd/install_callback` 执行 `npm install`
- 服务通过 `cmd/main` 启动，PID 记录在 `$TRIM_PKGVAR/app.pid`，日志写入 `$TRIM_PKGVAR/info.log`
- 桌面入口为 iframe，经统一网关 `/app/simple-nginx` 访问（`app/ui/config`）
