/**
 * store-only zip 產生器（資料匯出 §4）。跑法：`node --test scripts/tests/store-zip.test.ts`。
 *
 * 重點是「真的被標準工具解開」：用系統的 `tar -xf`（Windows 10+ 的 bsdtar、macOS、多數 Linux 都吃 zip）解到暫存夾，
 * 再逐檔比對內容與中文檔名；不是只拿自己寫的 parser 讀自己寫的檔。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildStoreZip, crc32 } from "../../src/domain/storeZip.ts";

// Windows：PATH 上排前面的可能是 Git Bash 的 GNU tar（不吃 zip，還會把 C: 當成主機名），所以直接指系統的 bsdtar
const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

const enc = new TextEncoder();
const bytesOf = (s: string) => enc.encode(s);

/** 遞迴列出資料夾下所有檔（相對路徑、正斜線） */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

describe("crc32", () => {
  test("標準測資 123456789 → CBF43926", () => {
    assert.equal(crc32(bytesOf("123456789")), 0xcbf43926);
  });
  test("空資料 → 0", () => {
    assert.equal(crc32(new Uint8Array(0)), 0);
  });
});

describe("buildStoreZip 結構", () => {
  test("同樣輸入產出同樣位元組；檔名 UTF-8 旗標（bit 11）有設", () => {
    const files = [{ path: "任務/車票.csv", bytes: bytesOf("a") }];
    const a = buildStoreZip(files);
    const b = buildStoreZip(files);
    assert.deepEqual(a, b);
    const dv = new DataView(a.buffer, a.byteOffset, a.byteLength);
    assert.equal(dv.getUint32(0, true), 0x04034b50);
    assert.equal(dv.getUint16(6, true) & 0x0800, 0x0800);
    assert.equal(dv.getUint16(8, true), 0, "method 0＝store");
  });

  test("空清單也是合法 zip（只有結尾記錄）", () => {
    const z = buildStoreZip([]);
    assert.equal(z.length, 22);
    assert.equal(new DataView(z.buffer).getUint32(0, true), 0x06054b50);
  });

  test("不合法路徑會丟錯", () => {
    assert.throws(() => buildStoreZip([{ path: "", bytes: new Uint8Array(0) }]));
    assert.throws(() => buildStoreZip([{ path: "../x.csv", bytes: new Uint8Array(0) }]));
    assert.throws(() => buildStoreZip([{ path: "a//b.csv", bytes: new Uint8Array(0) }]));
    assert.throws(() => buildStoreZip([{ path: "dir/", bytes: new Uint8Array(0) }]));
  });

  test("反斜線換成正斜線、開頭斜線去掉", () => {
    const z = buildStoreZip([{ path: "\\a\\b.csv", bytes: bytesOf("x") }]);
    assert.ok(Buffer.from(z).includes(Buffer.from("a/b.csv")));
  });
});

describe("用系統 tar 真的解開", () => {
  test("中文檔名、子資料夾、BOM／CRLF 內容、空檔、較大檔都原樣還原", () => {
    const big = new Uint8Array(300_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const csv = "﻿欄A,欄B\r\n\"含,逗號\",第二欄\r\n";
    const files = [
      { path: "任務/車票.csv", bytes: bytesOf(csv) },
      { path: "任務/路線.csv", bytes: bytesOf("﻿幹線,路線\r\n") },
      { path: "售票口/帳目.csv", bytes: bytesOf("日期,金額\r\n2026-11-04,-120\r\n") },
      { path: "readme 空白 檔名.txt", bytes: bytesOf("你好") },
      { path: "空檔.csv", bytes: new Uint8Array(0) },
      { path: "大檔.bin", bytes: big },
    ];
    const work = mkdtempSync(path.join(tmpdir(), "ns-zip-"));
    try {
      const zipPath = path.join(work, "t.zip");
      writeFileSync(zipPath, buildStoreZip(files));
      const outDir = path.join(work, "out");
      mkdirSync(outDir);
      const r = spawnSync(TAR, ["-xf", zipPath, "-C", outDir], { encoding: "utf8" });
      assert.equal(r.status, 0, `tar 解壓失敗：${r.stderr || r.error}`);

      assert.deepEqual(
        walk(outDir),
        files.map((f) => f.path).sort(),
        "解出來的檔名（含中文、子資料夾）要和輸入一樣",
      );
      for (const f of files) {
        const got = readFileSync(path.join(outDir, ...f.path.split("/")));
        assert.ok(Buffer.from(f.bytes).equals(got), `${f.path} 內容不一樣`);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
