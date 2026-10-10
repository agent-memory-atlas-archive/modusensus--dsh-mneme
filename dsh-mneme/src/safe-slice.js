// Issue #334：UTF-16 截断切开 emoji 代理对会留下孤立代理项（如 🔴 = D83D DD34
// 在 800 处切，D83D 留下、DD34 被切走）。DSH 把它序列化成非法 UTF-8，DeepSeek
// API 对每个请求回 400 INVALID_REQUEST——而且畸形文本随注入消息被永久写进会话
// 历史，此后**每一轮**都带着它，表现为会话从某一轮起连续 400、换话题/重启都不
// 恢复（会话级不可逆损坏）。防法是「少一个字符都行，绝不留半个」：尾字符是
// 高位代理（0xD800–0xDBFF）说明它的低位搭档被切走了，把这个高位代理整个丢掉。
// （反过来尾字符是低位代理不可能孤立——它的搭档必然紧邻在前、同在切点之内。）
// ASCII-only 的文本零开销（length 相等直接短路）。
// （原为 inject.js 模块私有；热记忆的轮次抽取同样要做正文截断，收拢成共享模块
// 以免两份实现漂移。）
export function safeSlice(text, limit) {
  const s = String(text);
  if (s.length <= limit) return s;
  let cut = s.slice(0, limit);
  const tail = cut.charCodeAt(cut.length - 1);
  if (tail >= 0xd800 && tail <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}
