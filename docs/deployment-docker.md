# Docker Compose 部署

项目使用 Next.js standalone 输出，Compose 启动时先执行数据库迁移，再启动 Node 服务。PostgreSQL 数据保存在命名卷 `postgres-data` 中。

## 配置并启动

```bash
mkdir -p .e2e
cp docker.env.example .e2e/docker.env
```

编辑 `.e2e/docker.env`，为 `POSTGRES_PASSWORD`、`SECRET_MASTER_KEY` 和 `ADMIN_TOKEN` 分别设置独立的随机值。不要把这个文件提交到 Git。`APP_PORT` 是宿主机端口；默认 3000，若已有服务占用，设置为 3100、3110 或 3120。

```bash
docker compose --env-file .e2e/docker.env up -d --build
docker compose --env-file .e2e/docker.env ps
```

Compose 的应用容器使用 `DATABASE_URL` 连接同一 Compose 项目内的 PostgreSQL。健康检查请求 `/api/health`。数据库健康后，应用会运行 `prisma migrate deploy`，成功后才启动 `server.js`。管理员口令和加密主密钥由 env 文件注入；`local.app.json` 不复制到镜像。

## 导入剧本与验证

管理员 API 使用 `ADMIN_TOKEN` 导入剧本。可用受控脚本或管理界面导入项目自带剧本，随后将 R1 的 `SMOKE_BASE` 指向 `http://127.0.0.1:<APP_PORT>`。无模型环境下，R1 应在 15 分钟内到达 ENDED，且 `voteResult` 非空。

## 更新与数据持久化

```bash
docker compose --env-file .e2e/docker.env down
docker compose --env-file .e2e/docker.env up -d --build
```

停启不会删除 `postgres-data`。仅在明确要销毁部署数据时才使用 `docker compose down -v`。

## 检查镜像

```bash
docker image ls jubensha-app
docker history jubensha-app:latest
docker run --rm jubensha-app:latest ls -la /app
```

镜像应小于 400 MB；镜像历史和 `/app` 内都不应包含 `.env`、`.e2e/docker.env` 或 `local.*.json`。`.dockerignore` 已排除这些本地配置和密钥文件。
