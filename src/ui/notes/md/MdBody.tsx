/**
 * MdBody——筆記／日記閱讀態的 Markdown 排版（桌機；旅客筆記車次④契約 §5.0、§0-0 定案 0-7／D-筆-54）。
 *
 * 取代車次③的 `InlineBody`：`parseMarkdown(body, inlineSegments)` 產 AST，React 自己畫（整條線不把字串塞成 HTML；契約 §7.3 的 grep 要零命中，所以這裡不寫那個屬性名）。
 *   heading → h3／h4／h5　paragraph → p（行間 <br>）　list → ul／ol（`start`；巢狀放在 li 裡）　quote → blockquote
 *   code → pre > code（原樣）　hr → hr
 *   行內：strong／em／code（去反引號）／tag＝`TagChip.sm`（點＝荷札頁、記「回到剛才」）／url・link＝<a>（openLink 外開）
 * `*斜體*`＝著重號：em 裡的中文字下加點、拉丁字仍斜（`emRuns` 切段；D-筆-54）。
 * 小牌與連結都 `stopPropagation`：外層閱讀區點一下＝進編輯，點它們不算。連結的 Enter 也擋在這裡（否則冒泡到
 * NotesView 的鍵盤表被當成 `notes.open`，連結不開、反而進編輯）。
 * 容器 class 由呼叫端給（`.ns-notes-read.ns-notes-md`）；樣式在 notes-md.css。
 */
import { Fragment, useContext, useMemo, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { parseMarkdown, urlSegHref, type MdBlock, type MdInline } from "../../../domain/markdown";
import { inlineSegments } from "../../../domain/tags";
import type { TagBackRef } from "../../../store/tagStore";
import { useTagStore } from "../../../store/tagStore";
import { TagChip } from "../tags/TagChip";
import { openLink } from "../openLink";
import { emRuns } from "./emRuns";
import { MdTagSlot } from "./mdTagSlot"; // 手機 MobileMdBody 換小牌畫法的口（沒提供＝TagChip）
import "../notes-tags.css";
import "../notes-md.css";

export interface MdBodyProps {
  body: string;
  /** 點小牌時的「回到剛才」（點下去那一刻才算，標題可能剛改過） */
  backRef(): TagBackRef;
  /** 空白時那一行（閱讀態提示） */
  empty?: string;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();
    void openLink(href);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Enter 交給 <a> 的原生啟動（會觸發 onClick）；只是別讓它冒到頁面的鍵盤表
    if (e.key === "Enter") e.stopPropagation();
  };
  return (
    <a href={href} title={href} target="_blank" rel="noopener noreferrer" onClick={onClick} onKeyDown={onKeyDown}>
      {children}
    </a>
  );
}

function Inlines({ nodes, backRef, inEm }: { nodes: readonly MdInline[]; backRef(): TagBackRef; inEm?: boolean }) {
  const renderTag = useContext(MdTagSlot);
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.kind) {
          case "text":
            // em 裡：拉丁段斜體、其餘著重號（D-筆-54；emRuns.ts）
            if (inEm)
              return (
                <Fragment key={i}>
                  {emRuns(n.text).map((r, k) =>
                    r.latin ? (
                      <span key={k} className="lat">
                        {r.text}
                      </span>
                    ) : (
                      <Fragment key={k}>{r.text}</Fragment>
                    ),
                  )}
                </Fragment>
              );
            return <Fragment key={i}>{n.text}</Fragment>;
          case "code":
            return <code key={i}>{n.text.replace(/^(`+)([\s\S]*)\1$/, "$2")}</code>;
          case "url": {
            const href = urlSegHref(n.text);
            return href ? (
              <Link key={i} href={href}>
                {n.text}
              </Link>
            ) : (
              <Fragment key={i}>{n.text}</Fragment>
            );
          }
          case "link":
            return (
              <Link key={i} href={n.href}>
                {n.text}
              </Link>
            );
          case "tag":
            if (renderTag) return <Fragment key={i}>{renderTag(n.occ)}</Fragment>;
            return (
              <TagChip
                key={i}
                size="sm"
                name={n.occ.raw}
                title={`看 #${n.occ.name} 的清單`}
                onOpen={(e) => {
                  e.stopPropagation();
                  void useTagStore.getState().openTagPage(n.occ.key, backRef());
                }}
              />
            );
          case "strong":
            return (
              <strong key={i}>
                <Inlines nodes={n.children} backRef={backRef} inEm={inEm} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Inlines nodes={n.children} backRef={backRef} inEm />
              </em>
            );
        }
      })}
    </>
  );
}

function Lines({ lines, backRef }: { lines: readonly MdInline[][]; backRef(): TagBackRef }) {
  return (
    <>
      {lines.map((l, j) => (
        <Fragment key={j}>
          {j > 0 && <br />}
          <Inlines nodes={l} backRef={backRef} />
        </Fragment>
      ))}
    </>
  );
}

function Block({ b, backRef }: { b: MdBlock; backRef(): TagBackRef }): ReactNode {
  switch (b.type) {
    case "heading": {
      const H = b.level === 1 ? "h3" : b.level === 2 ? "h4" : "h5";
      return (
        <H>
          <Inlines nodes={b.inline} backRef={backRef} />
        </H>
      );
    }
    case "paragraph":
      return (
        <p>
          <Lines lines={b.lines} backRef={backRef} />
        </p>
      );
    case "quote":
      return (
        <blockquote>
          <Lines lines={b.lines} backRef={backRef} />
        </blockquote>
      );
    case "list": {
      const items = b.items.map((it, k) => (
        <li key={k}>
          <Inlines nodes={it.inline} backRef={backRef} />
          {it.children.map((c, ci) => (
            <Block key={ci} b={c} backRef={backRef} />
          ))}
        </li>
      ));
      return b.ordered ? <ol start={b.start !== 1 ? b.start : undefined}>{items}</ol> : <ul>{items}</ul>;
    }
    case "code":
      return (
        <pre data-lang={b.lang ?? undefined}>
          <code>{b.text}</code>
        </pre>
      );
    case "hr":
      return <hr />;
  }
}

export function MdBody({ body, backRef, empty = "（空白，點一下開始寫）" }: MdBodyProps) {
  const blocks = useMemo(() => parseMarkdown(body, inlineSegments), [body]);
  if (!blocks.length) return <p className="ph">{empty}</p>;
  return (
    <>
      {blocks.map((b, i) => (
        <Block key={i} b={b} backRef={backRef} />
      ))}
    </>
  );
}
