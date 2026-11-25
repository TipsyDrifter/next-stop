import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDateRangeBadge,
  formatMultiDayLabel,
  hasDateSpan,
  isFlexibleRangeTicket,
  isMultiDayTicket,
  isNonFinalMultiDay,
  isRangeCoveringDay,
  isRangeOverdue,
  isRangeTicket,
  multiDayProgress,
  normalizeDateRange,
} from "./dateRange.ts";

describe("dateRange dual-track (多日乘車日 vs 期間自由券)", () => {
  it("normalizes single, reversed, and empty date spans", () => {
    assert.deepEqual(normalizeDateRange(null, "2026-10-04"), { scheduledOn: null, scheduledEnd: null });
    assert.deepEqual(normalizeDateRange("2026-10-02", "2026-10-02"), { scheduledOn: "2026-10-02", scheduledEnd: null });
    assert.deepEqual(normalizeDateRange("2026-10-04", "2026-10-02"), {
      scheduledOn: "2026-10-02",
      scheduledEnd: "2026-10-04",
    });
  });

  it("distinguishes multi-day scheduled tickets from flexible range tickets", () => {
    const multi = { scheduled_on: "2026-10-02", scheduled_end: "2026-10-04", is_multi_day: 1 };
    const flex = { scheduled_on: "2026-10-02", scheduled_end: "2026-10-04", is_multi_day: null };
    const single = { scheduled_on: "2026-10-02", scheduled_end: null, is_multi_day: 1 };

    assert.equal(hasDateSpan(multi), true);
    assert.equal(hasDateSpan(flex), true);
    assert.equal(hasDateSpan(single), false);

    assert.equal(isMultiDayTicket(multi), true);
    assert.equal(isFlexibleRangeTicket(multi), false);
    assert.equal(isRangeTicket(multi), false);

    assert.equal(isMultiDayTicket(flex), false);
    assert.equal(isFlexibleRangeTicket(flex), true);
    assert.equal(isRangeTicket(flex), true);

    assert.equal(isMultiDayTicket(single), false);
    assert.equal(isFlexibleRangeTicket(single), false);
  });

  it("computes multi-day progress, label, and non-final day exclusion", () => {
    const trip = { scheduled_on: "2026-10-02", scheduled_end: "2026-10-04", is_multi_day: 1, status: "todo" };
    assert.deepEqual(multiDayProgress(trip.scheduled_on, trip.scheduled_end, "2026-10-02"), {
      dayIndex: 1,
      totalDays: 3,
      isLastDay: false,
    });
    assert.deepEqual(multiDayProgress(trip.scheduled_on, trip.scheduled_end, "2026-10-03"), {
      dayIndex: 2,
      totalDays: 3,
      isLastDay: false,
    });
    assert.deepEqual(multiDayProgress(trip.scheduled_on, trip.scheduled_end, "2026-10-04"), {
      dayIndex: 3,
      totalDays: 3,
      isLastDay: true,
    });
    assert.equal(multiDayProgress(trip.scheduled_on, trip.scheduled_end, "2026-10-05"), null);

    assert.equal(formatMultiDayLabel("2026-10-02", "2026-10-04", "2026-10-03"), "10/2–10/4 · 第 2/3 日");
    assert.equal(formatDateRangeBadge("2026-10-02", "2026-10-04"), "10/2–10/4");

    assert.equal(isNonFinalMultiDay(trip, "2026-10-02"), true);
    assert.equal(isNonFinalMultiDay(trip, "2026-10-03"), true);
    assert.equal(isNonFinalMultiDay(trip, "2026-10-04"), false);
    assert.equal(isNonFinalMultiDay(trip, "2026-10-05"), false);

    assert.equal(isRangeCoveringDay(trip, "2026-10-03"), true);
    assert.equal(isRangeOverdue(trip, "2026-10-04"), false);
    assert.equal(isRangeOverdue(trip, "2026-10-05"), true);
  });
});
