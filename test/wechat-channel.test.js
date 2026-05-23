import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import test from "node:test";
import { getWechatConfig, handleOfficialHandshake, handleWechatQuery, verifyWechatRequest } from "../src/wechat-channel.js";

const env = {
  WECHAT_QUERY_TOKEN: "wechat-query-token-for-test-123456",
  WECHAT_CHANNEL_SECRET: "wechat-channel-secret-for-test-123456",
  WECHAT_OFFICIAL_TOKEN: "wechat-official-token-for-test",
  WECHAT_REQUIRE_SIGNATURE: "0",
  WECHAT_ALLOW_QUERY_TOKEN: "0"
};

test("微信自有网关必须通过令牌鉴权", () => {
  const url = new URL("http://localhost/api/wechat/query");
  const config = getWechatConfig(env);
  assert.equal(verifyWechatRequest({ method: "POST", url, headers: { authorization: `Bearer ${env.WECHAT_QUERY_TOKEN}` }, rawBody: "{}" }, config).ok, true);
  assert.equal(verifyWechatRequest({ method: "POST", url, headers: { authorization: "Bearer wrong-token" }, rawBody: "{}" }, config).status, 401);
});

test("微信自有网关支持 HMAC 防篡改", () => {
  const url = new URL("http://localhost/api/wechat/query");
  const rawBody = JSON.stringify({ text: "通道状态", date: "2026-05-15" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", env.WECHAT_CHANNEL_SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
  const result = verifyWechatRequest(
    {
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${env.WECHAT_QUERY_TOKEN}`,
        "x-football-timestamp": timestamp,
        "x-football-signature": signature
      },
      rawBody
    },
    getWechatConfig({ ...env, WECHAT_REQUIRE_SIGNATURE: "1" })
  );
  assert.equal(result.ok, true);
  assert.equal(result.mode, "bearer+hmac");
});

test("微信公众号服务器握手校验 signature", () => {
  const timestamp = "1715731200";
  const nonce = "abc123";
  const signature = createHash("sha1").update([env.WECHAT_OFFICIAL_TOKEN, timestamp, nonce].sort().join("")).digest("hex");
  const url = new URL(`http://localhost/api/wechat/query?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=hello`);
  const result = handleOfficialHandshake(url, getWechatConfig(env));
  assert.equal(result.status, 200);
  assert.equal(result.body, "hello");
});

test("微信公众号 XML 消息校验后返回 XML 文本", async () => {
  const timestamp = "1715731200";
  const nonce = "xml123";
  const signature = createHash("sha1").update([env.WECHAT_OFFICIAL_TOKEN, timestamp, nonce].sort().join("")).digest("hex");
  const url = new URL(`http://localhost/api/wechat/query?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`);
  const rawBody = [
    "<xml>",
    "<ToUserName><![CDATA[official-account]]></ToUserName>",
    "<FromUserName><![CDATA[user-openid]]></FromUserName>",
    "<MsgType><![CDATA[text]]></MsgType>",
    "<Content><![CDATA[通道状态]]></Content>",
    "</xml>"
  ].join("");
  const result = await handleWechatQuery({ method: "POST", url, headers: {}, rawBody }, env);
  assert.equal(result.status, 200);
  assert.equal(result.contentType, "application/xml; charset=utf-8");
  assert.match(result.body, /<xml>/);
  assert.match(result.body, /微信通道/);
});
