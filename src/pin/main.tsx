/**
 * 桌面小窗的入口（⑬ 外部入口；契約 第三節）。為了輕，這裡以下**不准** import App、stores、`src/data`、`src/index.css`：
 * 小窗沒有 DB 權限也沒有 store，資料全靠主視窗 `ExternalAgent` 送來的快照。
 * 不包 StrictMode：只有這一棵小樹，不值得在 dev 多掛一次監聽。
 */
import ReactDOM from "react-dom/client";
import { PinApp } from "./PinApp";
import "./pin.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<PinApp />);
