/** 設定〈提醒〉籤（⑨）：本體兩殼共用，手機入口在 mobile/MobileMore.tsx。 */
import { ReminderSettingsBody } from "../reminders/ReminderSettingsBody";

export function RemindersTab() {
  return <ReminderSettingsBody shell="desktop" />;
}
