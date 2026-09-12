module.exports = {
  apps: [
    {
      name: 'jubensha',
      script: 'npm',
      args: 'start',
      cwd: '/Users/hh-mini/Public/dev/jubensha',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        // 监听地址说明（安全相关；默认保持“所有接口”，以免影响局域网开黑）：
        //   next start 默认绑 0.0.0.0 → 同网段任何主机都能直连本机 3000。
        //   若这台机器只给自己用、对外统一走反向代理（Caddy/Nginx），
        //   取消下面一行的注释把服务收回本机——此时 ADMIN_TRUST_LOOPBACK=1 才真正等价于“只有本机”。
        // HOSTNAME: '127.0.0.1',
        //
        // 切勿在监听所有接口时开启 ADMIN_TRUST_LOOPBACK：Host 头由客户端控制，
        // 局域网内任意主机加一行 "Host: localhost" 即可进入管理面。
      }
    }
  ]
};
