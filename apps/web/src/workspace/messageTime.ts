const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "long",
  day: "numeric",
  year: "numeric",
});
const fullFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "long",
});

export function messageTime(createdAt: string) {
  const date = new Date(createdAt);

  if (Number.isNaN(date.getTime())) return null;

  // Group by the viewer's calendar day, not the UTC day stored by the server.
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

  return {
    day,
    dateTime: date.toISOString(),
    label: timeFormat.format(date),
    dayLabel: dateFormat.format(date),
    fullLabel: fullFormat.format(date),
  };
}
