# 微信通道稳定性与安全说明

## 已加固内容

- `/api/wechat/query` 默认不是裸接口，必须通过 `WECHAT_QUERY_TOKEN` 鉴权。
- 支持微信公众号服务器接入校验：`signature + timestamp + nonce + echostr`。
- 支持微信公众号 POST XML 消息：校验官方 SHA1 签名后返回 XML 文本消息。
- 支持自有 HTTPS 网关鉴权：`Authorization: Bearer <WECHAT_QUERY_TOKEN>` 或 `x-wechat-query-token`。
- 支持 HMAC 防篡改：开启 `WECHAT_REQUIRE_SIGNATURE=1` 后校验 `x-football-signature` 和 `x-football-timestamp`。
- 默认禁止 URL 携带 token，避免浏览器历史、代理日志、Referer 泄露。
- 默认不开放跨域；如确需微信网页调用，只允许指定 `WECHAT_CORS_ORIGIN`。
- 请求体大小限制默认 `65536 bytes`，避免异常大包攻击。
- Webhook 出站发送加入 HTTPS 校验、超时、重试和失败归档。
- 本地 outbox 同时保存最新文件和历史归档到 `data/wechat`，便于追踪失败。

## 推荐环境变量

```text
WECHAT_QUERY_TOKEN=本机随机长令牌
WECHAT_OFFICIAL_TOKEN=微信公众号后台配置的Token
WECHAT_CHANNEL_SECRET=自有网关HMAC密钥
WECHAT_REQUIRE_SIGNATURE=0
WECHAT_ALLOW_QUERY_TOKEN=0
WECHAT_WEBHOOK_URL=https://你的微信网关地址
WECHAT_TIMEOUT_MS=12000
WECHAT_RETRY_ATTEMPTS=3
WECHAT_MAX_BODY_BYTES=65536
WECHAT_CORS_ORIGIN=
```

## 微信网关调用方式

```http
POST /api/wechat/query
Authorization: Bearer <WECHAT_QUERY_TOKEN>
Content-Type: application/json

{"text":"今天竞彩推荐","date":"2026-05-15"}
```

## 公网安全建议

- 正式公网部署时建议启用 `WECHAT_REQUIRE_SIGNATURE=1`，并让微信网关按 `timestamp.body` 生成 HMAC-SHA256。
- 不建议开启 `WECHAT_ALLOW_QUERY_TOKEN=1`；只在临时调试时短期开启。
- 如果接入的是微信公众号后台，后台 Token 可单独配置为 `WECHAT_OFFICIAL_TOKEN`；未配置时会回退使用 `WECHAT_QUERY_TOKEN`。
- 每天用 `npm run wechat:check -- --date=YYYY-MM-DD` 检查通道、outbox、日报和实时数据闸门。
