export type ClockInSlotId = "morning" | "evening";

export type ClockInSlotConfig = {
  id: ClockInSlotId;
  label: string;
  hour: number;
  startMinute: number;
  endMinute: number;
};

// Modify the time windows here for both the scheduler and the in-page punch action.
export const CLOCK_IN_SLOTS: ClockInSlotConfig[] = [
  {
    id: "morning",
    label: "上班",
    hour: 9,
    startMinute: 1,
    endMinute: 10,
  },
  {
    id: "evening",
    label: "下班",
    hour: 18,
    startMinute: 10,
    endMinute: 20,
  },
];

export function isWithinClockInWindow(now: Date, slot: ClockInSlotConfig): boolean {
  if (now.getHours() !== slot.hour) {
    return false;
  }
  const minute = now.getMinutes();
  return minute >= slot.startMinute && minute <= slot.endMinute;
}

export function resolveActiveClockInSlot(now: Date): ClockInSlotConfig | undefined {
  return CLOCK_IN_SLOTS.find((slot) => isWithinClockInWindow(now, slot));
}
