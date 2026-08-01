export type AndroidVersion = "12" | "13" | "14" | "15" | "16" | "other";
export type DeviceKind = "chromebook" | "other" | "phone" | "tablet";

const parseDay = (day: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return Number.NaN;
  const [year, month, date] = day.split("-").map(Number);
  const timestamp = Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1);
  return new Date(timestamp).toISOString().slice(0, 10) === day ? timestamp : Number.NaN;
};

export const relativeTestDay = (optedInOn: string, today: string) => {
  const start = parseDay(optedInOn);
  const current = parseDay(today);
  if (!Number.isFinite(start) || !Number.isFinite(current)) return 0;
  return Math.floor((current - start) / 86_400_000) + 1;
};

export const isCheckinDay = (day: number) => Number.isInteger(day) && day >= 1 && day <= 14;

export const completedTestDays = (days: number[]) =>
  new Set(days.filter((day) => isCheckinDay(day))).size;

export const isOfficialGroupUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "groups.google.com" &&
      url.pathname.startsWith("/g/") &&
      url.pathname.length > 3 &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
};

export const isOfficialPlayTestUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "play.google.com" &&
      url.pathname.startsWith("/apps/testing/") &&
      url.pathname.length > 14 &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
};
