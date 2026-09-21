/**
 * 印章家族的對外門面（M3 ② · E4）。
 * import 本模組即完成朱肉 defs 掛載（./defs 的模組級 ensureStampDefs()）。
 * 樣式（styles/stamps.css）由 src/index.css 集中 import——見該檔檔頭的注入順序說明。
 */
import "./defs";

export { ensureStampDefs } from "./defs";
export {
  SealDone,
  RectSeal,
  SealStopover,
  SealSuspended,
  SealLate,
  SealCarryOver,
  PunchNick,
  DateSeal,
  TimeSeal,
  StationStamp,
} from "./Stamps";
export type {
  StampTone,
  SealDoneProps,
  RectSealProps,
  DateSealProps,
  TimeSealProps,
  StationStampProps,
} from "./Stamps";
