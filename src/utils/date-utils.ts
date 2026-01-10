import { DateTime } from 'luxon';

export function parseDate(isoString: string): DateTime | null {
  if (!isoString) {
    return null;
  }
  
  const dateTime = DateTime.fromISO(isoString, { zone: 'utc' });
  
  if (!dateTime.isValid) {
    return null;
  }
  
  return dateTime;
}

export function isBefore(date: DateTime, referenceDate: DateTime): boolean {
  if (!date || !referenceDate || !date.isValid || !referenceDate.isValid) {
    return false;
  }
  return date < referenceDate;
}

export function isAfter(date: DateTime, referenceDate: DateTime): boolean {
  if (!date || !referenceDate || !date.isValid || !referenceDate.isValid) {
    return false;
  }
  return date > referenceDate;
}

export function isSameOrBefore(date: DateTime, referenceDate: DateTime): boolean {
  if (!date || !referenceDate || !date.isValid || !referenceDate.isValid) {
    return false;
  }
  return date <= referenceDate;
}

export function isEqual(date: DateTime, otherDate: DateTime): boolean {
  if (!date || !otherDate || !date.isValid || !otherDate.isValid) {
    return false;
  }
  return date.equals(otherDate);
}

export function rangesOverlap(
  range1Start: DateTime,
  range1End: DateTime,
  range2Start: DateTime,
  range2End: DateTime
): boolean {
  if (!range1Start || !range1End || !range2Start || !range2End) {
    return false;
  }
  
  if (!range1Start.isValid || !range1End.isValid || !range2Start.isValid || !range2End.isValid) {
    return false;
  }
  
  return (range1Start < range2End && range1End > range2Start) || (range2Start < range1End && range2End > range1Start);
}
