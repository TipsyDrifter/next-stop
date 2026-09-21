//! HLC（混合邏輯時鐘）字串——與 TS 端 `src/data/syncRepository.ts` 的 `nextHlc()` **同一格式**。
//!
//! 格式（契約 §3）：`<13位十進位毫秒><4位小寫十六進位計數>-<device_id 前 8 碼>`，共 13＋4＋1＋8＝26 字元。
//!   例：`1758153600123000a-3f9c2b1e`
//!   * 毫秒固定 13 位（到西元 2286 年都夠），計數固定 4 位 → 整串可直接用字典序比較，
//!     同毫秒同計數時 device 尾碼決勝（＝D-1.1-5「同 hlc 以 device_id 決勝」不用另寫規則）。
//!   * 產生規則：physical=now_ms；若 physical > last.ms → (physical, 0)；否則 (last.ms, last.count+1)；
//!     count 溢位 0xffff → ms+1、count 0（實務上不會發生）。
//!   * Rust 只在「啟用同步的全量快照」與 v1.1.2 的 pull 合併時產生；日常寫入的 hlc 由 TS 產生。
//!     兩端共用同一顆物理時鐘，種子都從 `MAX(hlc)`（sync_outbox ∪ sync_cells）讀，所以彼此單調。
//!
//! WP7 已填：`next()`／`parse()`／`is_valid()`（apply 前檢查遠端 op 的 hlc 形狀）＋單元測試。

/// 解析後的 HLC（比較請直接比字串；這個結構只給產生下一個用）
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Hlc {
    pub ms: u64,
    pub count: u16,
}

/// 固定長度（13＋4＋1＋8）
pub const HLC_LEN: usize = 26;

/// 形狀檢查：13 位數字＋4 位小寫 hex＋'-'＋8 字元。
pub fn is_valid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == HLC_LEN
        && b[..13].iter().all(|c| c.is_ascii_digit())
        && b[13..17].iter().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
        && b[17] == b'-'
}

/// 取前 17 碼解析成 (ms, count)；形狀不對回 None。
pub fn parse(s: &str) -> Option<Hlc> {
    if !is_valid(s) {
        return None;
    }
    let ms = s[..13].parse::<u64>().ok()?;
    let count = u16::from_str_radix(&s[13..17], 16).ok()?;
    Some(Hlc { ms, count })
}

/// 產生下一個 HLC 字串。`prev`＝本機已知最大的 hlc（可為 None）；`device_id` 取前 8 碼當尾碼。
///
/// 為什麼要吃 `prev`：Rust 端只在「啟用同步的全量快照」產 hlc，而同一台機器的 TS 端平常也在產。
/// 兩邊都從 `MAX(hlc)`（sync_outbox ∪ sync_cells）起跳，才不會因為時鐘回撥而產出比舊資料還小的 hlc
/// （小了就會被 LWW 判定為「舊」，快照整包被丟掉）。
pub fn next(prev: Option<&str>, now_ms: u64, device_id: &str) -> String {
    let last = prev.and_then(parse);
    let h = match last {
        Some(l) if now_ms <= l.ms => {
            if l.count == u16::MAX {
                Hlc { ms: l.ms + 1, count: 0 }
            } else {
                Hlc { ms: l.ms, count: l.count + 1 }
            }
        }
        _ => Hlc { ms: now_ms, count: 0 },
    };
    format(h, device_id)
}

/// 現在的毫秒（UTC epoch）。快照產 hlc 用。
pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 形狀與長度() {
        let s = next(None, 1_758_153_600_123, "3f9c2b1e-aaaa-bbbb");
        assert_eq!(s.len(), HLC_LEN);
        assert_eq!(&s[..13], "1758153600123");
        assert_eq!(&s[13..17], "0000");
        assert_eq!(&s[17..], "-3f9c2b1e");
        assert!(is_valid(&s));
    }

    #[test]
    fn 同毫秒遞增_跨毫秒歸零() {
        let a = next(None, 1_000_000_000_000, "devicexx");
        let b = next(Some(&a), 1_000_000_000_000, "devicexx");
        let c = next(Some(&b), 1_000_000_000_001, "devicexx");
        assert!(b > a, "同毫秒要靠 count 遞增");
        assert!(c > b, "跨毫秒要靠 ms 遞增");
        assert_eq!(parse(&b).unwrap().count, 1);
        assert_eq!(parse(&c).unwrap().count, 0);
    }

    #[test]
    fn 時鐘回撥不會倒退() {
        let a = next(None, 1_000_000_000_500, "devicexx");
        let b = next(Some(&a), 1_000_000_000_000, "devicexx"); // 時鐘被撥回 500ms
        assert!(b > a);
        assert_eq!(parse(&b).unwrap().ms, 1_000_000_000_500);
    }

    #[test]
    fn 字典序等於時序() {
        let mut v = vec![
            next(None, 2_000_000_000_000, "bbbbbbbb"),
            next(None, 1_000_000_000_000, "aaaaaaaa"),
            next(None, 1_000_000_000_000, "cccccccc"),
        ];
        v.sort();
        assert_eq!(parse(&v[0]).unwrap().ms, 1_000_000_000_000);
        assert!(v[0].ends_with("-aaaaaaaa"));
        assert!(v[1].ends_with("-cccccccc"));
        assert_eq!(parse(&v[2]).unwrap().ms, 2_000_000_000_000);
    }
}

/// 格式化（給 `next()` 與快照用）
pub fn format(h: Hlc, device_id: &str) -> String {
    let dev: String = device_id.chars().take(8).collect();
    format!("{:013}{:04x}-{}", h.ms, h.count, dev)
}
