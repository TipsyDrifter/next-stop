/**
 * Money——金額（車次①契約 §2.5-4、0-2；v1.33 3B G4/G5 支援動態主幣別與一鍵隱私遮罩 `NT$ ****`）。
 * 內文＝`moneyText(minor, 幣別小數位, { prefix, whole })`；`code` 為真且幣別不是主幣別時尾接幣別碼小字。
 * 開啟隱私遮罩（或帳本鎖定中）時，統一渲染為 `NT$ ****`（或對應幣別符號＋`****`；`bareMask` 為真時僅印 `****`）。
 */
import { mainCurrencyOf, maskedMoneyText, moneyText, type Prefix } from "../../../domain/ticket";
import { isTicketAmountMasked, useTicketStore } from "../../../store/ticketStore";

export interface MoneyProps {
  minor: number;
  currency: string;
  prefix?: Prefix;
  whole?: boolean;
  code?: boolean;
  /** 呼叫端前方已自印幣別符號時，遮罩僅輸出 `****` 免重複印符號 */
  bareMask?: boolean;
}

export function Money(props: MoneyProps) {
  const cur = useTicketStore((s) => s.curByCode[props.currency]);
  const mainCode = useTicketStore((s) => mainCurrencyOf(s.curByCode).code);
  const masked = useTicketStore(isTicketAmountMasked);
  const decimals = cur?.decimals ?? 2;
  const isMain = cur ? cur.is_main === 1 : props.currency === mainCode;

  if (masked) {
    return (
      <span className="ns-tk-money is-masked" data-currency={props.currency}>
        {maskedMoneyText(props.currency, { prefix: props.prefix, withSymbol: !props.bareMask })}
      </span>
    );
  }

  return (
    <span className="ns-tk-money" data-currency={props.currency}>
      {moneyText(props.minor, decimals, { prefix: props.prefix, whole: props.whole })}
      {props.code && !isMain && <small className="ns-tk-code">{props.currency}</small>}
    </span>
  );
}
