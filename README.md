# FLUX Web Demo

无 Python 版 FLUX 验证码 demo，可部署到 `bennix/fluxwebdemo` 这类 Node/Vercel 仓库。

## 已实现

- `POST /api/challenge`：生成 3x3 动态字符拼图、ASCII 邻位提示和一次性 challenge。
- `POST /api/verify`：服务端判定排列、交互轨迹、session 绑定和验证按钮意图。
- 动态前端：九宫格拖拽、波纹干涉动画、字符轻微运动、通过/失败跳转页。
- 安全加固：TTL、速率限制、失败计数、一次性消费、安全响应头、中性失败响应。
- 无 Python：运行时只需要 Node.js 18+。
- 前端脚本混淆：可读源码在 `src/client/flux.client.js`，部署产物为 `public/flux.js`。
- 存储：生产推荐 Upstash Redis REST；未配置时使用加密 challenge id + 进程内存 fallback。

## 本地运行

```bash
npm start
```

打开：

```text
http://127.0.0.1:3000
```

测试：

```bash
npm test
```

构建混淆前端脚本：

```bash
npm run build
```

`npm start` 和 `npm test` 会自动先执行 build。请不要手写修改 `public/flux.js`，它是混淆后的构建产物；需要改交互逻辑时修改 `src/client/flux.client.js`。

## 关于防破解

前端混淆用于提高复制和逆向门槛，但不作为核心安全边界。FLUX 的关键安全点仍是：

- 正确排列、session 绑定、失败计数和一次性状态在服务端判定。
- 客户端只拿到 tile 图片、初始槽位、challenge id 和提示图。
- `/api/verify` 对外只返回 `pass` 或中性失败原因，不返回 exact、score、human 等内部维度。

## Vercel 部署

把本仓库推送到 GitHub 后，在 Vercel 导入 `bennix/fluxwebdemo`。

推荐环境变量：

```text
FLUX_SECRET=生成一个至少32字节的随机密钥
UPSTASH_REDIS_REST_URL=https://你的-upstash-url
UPSTASH_REDIS_REST_TOKEN=你的-upstash-token
```

如果没有 Redis REST，demo 仍可运行，但 serverless 多实例下的一次性消费和失败计数只能在同一实例内可靠；生产环境请配置 Redis。

## API 兼容性

挑战响应保留：

```json
{
  "challenge_id": "...",
  "expires_in": 180,
  "hint_images": [],
  "tiles": []
}
```

验证响应只返回：

```json
{ "pass": true }
```

或：

```json
{ "pass": false, "reason": "verification_failed" }
```

内部判定字段不会返回给客户端。
