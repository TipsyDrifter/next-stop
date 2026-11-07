/**
 * 商店手寫字型的下載規則（`src/lib/handFonts.ts`，第三梯 ⑩ D-主-434）。
 * 跑法：`node --test scripts/tests/hand-fonts.test.ts`（零依賴、不連網，fetch 是假的）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DOWNLOADABLE_FONTS, downloadFont, isIntact, normalizeHandFont, type DownloadableFont } from "../../src/lib/handFonts.ts";

const BODY = new TextEncoder().encode("假裝這是一個字型檔");
const FONT: DownloadableFont = {
  id: "chenyu",
  name: "測試",
  family: "T",
  bytes: BODY.byteLength,
  sha256: createHash("sha256").update(BODY).digest("hex"),
  urls: ["https://a.test/f", "https://b.test/f"],
  credit: "",
  licenseUrl: "",
};

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes.slice(0, 5));
      c.enqueue(bytes.slice(5));
      c.close();
    },
  });
}

function fakeFetch(plan: Record<string, () => Response | Promise<Response>>) {
  const called: string[] = [];
  const impl = (async (url: string) => {
    called.push(url);
    return plan[url]();
  }) as unknown as typeof fetch;
  return { impl, called };
}

describe("下載", () => {
  test("第一個來源成功：只打一次，回驗過的位元組，進度走到 1", async () => {
    const { impl, called } = fakeFetch({ "https://a.test/f": () => new Response(stream(BODY)) });
    const seen: number[] = [];
    const data = await downloadFont(FONT, (r) => seen.push(r), impl);
    assert.deepEqual(new Uint8Array(data), BODY);
    assert.deepEqual(called, ["https://a.test/f"]);
    assert.equal(seen.at(-1), 1);
  });
  test("第一個連不上 ⇒ 換備援", async () => {
    const { impl, called } = fakeFetch({
      "https://a.test/f": () => Promise.reject(new TypeError("offline")),
      "https://b.test/f": () => new Response(stream(BODY)),
    });
    assert.deepEqual(new Uint8Array(await downloadFont(FONT, () => undefined, impl)), BODY);
    assert.equal(called.length, 2);
  });
  test("404 也算這個來源失敗", async () => {
    const { impl } = fakeFetch({
      "https://a.test/f": () => new Response("nope", { status: 404 }),
      "https://b.test/f": () => new Response(stream(BODY)),
    });
    assert.deepEqual(new Uint8Array(await downloadFont(FONT, () => undefined, impl)), BODY);
  });
  test("全部連不上 ⇒ network", async () => {
    const { impl } = fakeFetch({
      "https://a.test/f": () => Promise.reject(new TypeError("offline")),
      "https://b.test/f": () => Promise.reject(new TypeError("offline")),
    });
    await assert.rejects(downloadFont(FONT, () => undefined, impl), (e) => e === "network");
  });
  test("內容被換過 ⇒ corrupt，不會回傳", async () => {
    const bad = () => new Response(stream(new TextEncoder().encode("假裝這是別的字型檔")));
    const { impl } = fakeFetch({ "https://a.test/f": bad, "https://b.test/f": bad });
    await assert.rejects(downloadFont(FONT, () => undefined, impl), (e) => e === "corrupt");
  });
  test("長度對、內容錯也擋", async () => {
    const same = new Uint8Array(BODY.byteLength).fill(65);
    assert.equal(await isIntact(FONT, same.buffer), false);
  });
});

describe("清單", () => {
  test("每個來源都釘在特定版本（換檔要改碼，不會無聲變字型）", () => {
    for (const f of DOWNLOADABLE_FONTS) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.ok(f.urls.length >= 2, `${f.id} 要有備援來源`);
      for (const u of f.urls) assert.match(u, /[/@][0-9a-f]{40}\//, u);
    }
  });
  test("設定值：不認得的一律退回芫荽", () => {
    assert.equal(normalizeHandFont("chenyu"), "chenyu");
    assert.equal(normalizeHandFont("iansui"), "iansui");
    assert.equal(normalizeHandFont(null), "iansui");
    assert.equal(normalizeHandFont("sepia"), "iansui");
  });
});
