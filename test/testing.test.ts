import { describe, expect, it } from "vitest";

import {
  completedTestDays,
  isCheckinDay,
  isOfficialGroupUrl,
  isOfficialPlayTestUrl,
  relativeTestDay,
} from "../src/domain/testing";

describe("closed testing progress", () => {
  it("calculates a tester's independent 14-day position", () => {
    expect(relativeTestDay("2026-08-01", "2026-08-01")).toBe(1);
    expect(relativeTestDay("2026-08-01", "2026-08-14")).toBe(14);
    expect(relativeTestDay("2026-08-01", "2026-07-31")).toBe(0);
    expect(relativeTestDay("invalid", "2026-08-01")).toBe(0);
  });

  it("accepts check-ins only for days one through fourteen", () => {
    expect(isCheckinDay(1)).toBe(true);
    expect(isCheckinDay(14)).toBe(true);
    expect(isCheckinDay(0)).toBe(false);
    expect(isCheckinDay(15)).toBe(false);
  });

  it("counts unique valid days", () => {
    expect(completedTestDays([1, 1, 2, 14, 15])).toBe(3);
  });
});

describe("official link boundary", () => {
  it("accepts only Google Groups group URLs", () => {
    expect(isOfficialGroupUrl("https://groups.google.com/g/my-testers")).toBe(true);
    expect(isOfficialGroupUrl("https://groups.google.com/g/")).toBe(false);
    expect(isOfficialGroupUrl("https://groups.google.com/forum/#!forum/testers")).toBe(false);
    expect(isOfficialGroupUrl("https://evil.example/g/my-testers")).toBe(false);
  });

  it("accepts only Google Play test opt-in URLs", () => {
    expect(isOfficialPlayTestUrl("https://play.google.com/apps/testing/com.example.app")).toBe(
      true,
    );
    expect(isOfficialPlayTestUrl("https://play.google.com/apps/testing/")).toBe(false);
    expect(
      isOfficialPlayTestUrl("https://play.google.com/store/apps/details?id=com.example.app"),
    ).toBe(false);
    expect(isOfficialPlayTestUrl("https://evil.example/apps/testing/com.example.app")).toBe(false);
  });
});
