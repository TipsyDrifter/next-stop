/**
 * Money——金額（車次①契約 §2.5-4、0-2；乙席）。
 * 內文＝`moneyText(minor, 幣別小數位, { prefix, whole })`；`code` 為真且幣別不是主幣別時尾接幣別碼小字。
 * 字＝`--font-display`、tabular-nums（樣式在 ticket.css §B `.ns-tk-money`）；顏色不分收支（0-2：語意靠前綴）。
 * 幣別小數位與主幣別旗標自己讀 store 的 `curByCode`（查不到＝2 位、當外幣）。
 */
import { moneyText, MAIN_CURRENCY, type Prefix } from "../../../domain/ticket";
import { useTicketStore } from "../../../store/ticketStore";

export interface MoneyProps {
  minor: number;
  currency: string;
  prefix?: Prefix;
  whole?: boolean;
  code?: boolean;
}

export function Money(props: MoneyProps) {
  const cur = useTicketStore((s) => s.curByCode[props.currency]);
  const decimals = cur?.decimals ?? 2;
  const isMain = cur ? cur.is_main === 1 : props.currency === MAIN_CURRENCY;
  return (
    <span className="ns-tk-money" data-currency={props.currency}>
      {moneyText(props.minor, decimals, { prefix: props.prefix, whole: props.whole })}
      {props.code && !isMain && <small className="ns-tk-code">{props.currency}</small>}
    </span>
  );
}
