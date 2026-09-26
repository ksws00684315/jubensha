# HTTPS 部署检查

`next start` 和 PM2 只负责应用进程，不负责 TLS。生产环境必须由 Caddy、Nginx 或云负载均衡终止 HTTPS，并将请求转发到本机 `3000` 端口。

上线前检查：

1. DNS 的 A/AAAA 记录指向实际反向代理；代理配置的域名必须是 `jubensha.river0413.top`。
2. 证书 SAN 包含完整域名，代理使用完整证书链（fullchain），不是只配置 leaf certificate。
3. 从一台没有访问过本站的浏览器验证首次访问，不应出现“连接不安全”或证书机构错误。
4. 用命令检查证书链和有效期：

   ```bash
   openssl s_client -connect jubensha.river0413.top:443 -servername jubensha.river0413.top -showcerts </dev/null
   openssl s_client -connect jubensha.river0413.top:443 -servername jubensha.river0413.top </dev/null 2>/dev/null | openssl x509 -noout -issuer -subject -dates -ext subjectAltName
   ```

5. 配置证书自动续期，并在到期前 14 天告警；续期后 reload 反向代理，不要重启正在运行的 Node 进程作为唯一方案。
6. 证书更新后再次用桌面端、移动端和无痕窗口访问游戏页，确认 SSE、API 和静态资源都保持 HTTPS，页面没有混合内容。

示例 Caddy 配置：

```caddyfile
jubensha.river0413.top {
  reverse_proxy 127.0.0.1:3000
}
```

证书仍然由实际部署环境负责申请和续期；仓库内的 PM2 配置不应自行添加私钥或证书文件。
