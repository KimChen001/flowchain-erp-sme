import test from "node:test";
import assert from "node:assert/strict";
import { buildSignInEmail } from "../mail/sign-in-email.mjs";

const link = "https://flowchain.example/sign-in/confirm?token=abc_DEF-123";
const cjk = /[㐀-鿿]/;

test("the English sign-in email names the workspace, links once, and says when it expires", () => {
  const email = buildSignInEmail({ language: "en-US", workspaceName: "Acme Supply", link });
  assert.equal(email.subject, "Your FlowChain sign-in link");
  for (const body of [email.text, email.html]) {
    assert.match(body, /Acme Supply/);
    assert.match(body, /expires in 15 minutes/);
    assert.match(body, /If you didn(’|'|&#39;)t request this/);
    assert.doesNotMatch(body, cjk);
  }
  assert.ok(email.text.includes(link));
  assert.ok(email.html.includes(`href="${link}"`), "the button links to the confirm page");
  assert.equal(email.html.split(`href="${link}"`).length - 1, 2, "a button and the plain link");
  assert.match(email.html, /<html lang="en-US">/);
  assert.match(email.html, />Sign in to Acme Supply</);
});

test("the Chinese preference gets a Chinese sign-in email with the same link", () => {
  const email = buildSignInEmail({ language: "zh-CN", workspaceName: "华东仓", link });
  assert.equal(email.subject, "你的 FlowChain 登录链接");
  assert.ok(email.text.includes(link));
  assert.ok(email.html.includes(`href="${link}"`));
  assert.match(email.text, /15 分钟/);
  assert.match(email.text, /华东仓/);
  assert.match(email.html, /<html lang="zh-CN">/);
});

test("the email falls back to English and escapes workspace names in HTML", () => {
  const email = buildSignInEmail({ language: "fr-FR", workspaceName: `<script>alert("x")</script> & Co`, link });
  assert.equal(email.subject, "Your FlowChain sign-in link");
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; Co/);
  assert.match(email.text, /<script>alert\("x"\)<\/script> & Co/, "plain text is not HTML-escaped");
  const unnamed = buildSignInEmail({ language: "en-US", workspaceName: "", link });
  assert.match(unnamed.text, /Sign in to your FlowChain workspace/);
});
