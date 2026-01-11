import {
  WorkOrderDocument,
  WorkCenterDocument,
  ManufacturingOrderDocument,
  WorkCenterShift,
  MaintenanceWindow
} from './types';
import {
  parseDate,
  isAfter,
  isSameOrBefore,
  rangesOverlap
} from '../utils/date-utils';
import { DateTime } from 'luxon';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class ConstraintChecker {
  validateAllWorkOrdersHaveValidDates(
    workOrders: WorkOrderDocument[]
  ): ValidationResult {
    const errors: string[] = [];

    for (const workOrder of workOrders) {
      if (!workOrder.data.startDate || !workOrder.data.endDate) {
        errors.push(`Work order ${workOrder.docId} has invalid dates`);
        continue;
      }

      const startDate = parseDate(workOrder.data.startDate);
      const endDate = parseDate(workOrder.data.endDate);

      if (!startDate || !endDate) {
        errors.push(`Work order ${workOrder.docId} has invalid date format`);
        continue;
      }

      if (isSameOrBefore(endDate, startDate)) {
        errors.push(`Work order ${workOrder.docId} has startDate >= endDate`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  validateAllWorkOrdersCompleteBeforeDueDate(
    workOrders: WorkOrderDocument[],
    manufacturingOrders: ManufacturingOrderDocument[]
  ): ValidationResult {
    const errors: string[] = [];

    const manufacturingOrdersMap = new Map(
      manufacturingOrders.map(mo => [mo.docId, mo.data.dueDate])
    );

    for (const workOrder of workOrders) {
      const dueDate = manufacturingOrdersMap.get(workOrder.data.manufacturingOrderId);
      if (!dueDate) {
        continue;
      }

      const endDate = parseDate(workOrder.data.endDate);
      const dueDateObj = parseDate(dueDate);

      if (!endDate || !dueDateObj) {
        errors.push(
          `Work order ${workOrder.docId} has invalid date format for due date validation`
        );
        continue;
      }

      if (isAfter(endDate, dueDateObj)) {
        errors.push(
          `Work order ${workOrder.docId} ends after due date (${workOrder.data.endDate} > ${dueDate})`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  validateNoWorkOrderOverlaps(
    workOrders: WorkOrderDocument[]
  ): ValidationResult {
    const errors: string[] = [];

    const workOrdersByCenter = new Map<string, WorkOrderDocument[]>();

    for (const workOrder of workOrders) {
      const centerId = workOrder.data.workCenterId;
      if (!workOrdersByCenter.has(centerId)) {
        workOrdersByCenter.set(centerId, []);
      }
      workOrdersByCenter.get(centerId)!.push(workOrder);
    }
    // TODO : Implement more efficient algo
    for (const [centerId, centerWorkOrders] of workOrdersByCenter) {
      for (let i = 0; i < centerWorkOrders.length; i++) {
        for (let j = i + 1; j < centerWorkOrders.length; j++) {
          const wo1 = centerWorkOrders[i];
          const wo2 = centerWorkOrders[j];

          const wo1Start = parseDate(wo1.data.startDate);
          const wo1End = parseDate(wo1.data.endDate);
          const wo2Start = parseDate(wo2.data.startDate);
          const wo2End = parseDate(wo2.data.endDate);

          if (!wo1Start || !wo1End || !wo2Start || !wo2End) {
            errors.push(
              `Work orders ${wo1.docId} and ${wo2.docId} have invalid dates for overlap check on work center ${centerId}`
            );
            continue;
          }

          if (rangesOverlap(wo1Start, wo1End, wo2Start, wo2End)) {
            errors.push(
              `Work orders ${wo1.docId} and ${wo2.docId} overlap on work center ${centerId}`
            );
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  validateWorkCenterAvailability(
    workOrders: WorkOrderDocument[],
    workCenters: WorkCenterDocument[]
  ): ValidationResult {
    const errors: string[] = [];

    const workCentersMap = new Map(
      workCenters.map(wc => [wc.docId, wc])
    );

    for (const workOrder of workOrders) {
      if (!workCentersMap.has(workOrder.data.workCenterId)) {
        errors.push(
          `Work order ${workOrder.docId} references non-existent work center ${workOrder.data.workCenterId}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  validateDependenciesRespected(
    workOrders: WorkOrderDocument[]
  ): ValidationResult {
    const errors: string[] = [];

    // Build a map of work orders by docId for efficient lookup
    const workOrdersMap = new Map<string, WorkOrderDocument>();
    for (const workOrder of workOrders) {
      workOrdersMap.set(workOrder.docId, workOrder);
    }

    // For each work order, validate its dependencies
    for (const workOrder of workOrders) {
      const dependsOnIds = workOrder.data.dependsOnWorkOrderIds || [];
      
      if (dependsOnIds.length === 0) {
        continue; // No dependencies to check
      }

      const workOrderStartDate = parseDate(workOrder.data.startDate);
      if (!workOrderStartDate) {
        errors.push(
          `Work order ${workOrder.docId} has invalid startDate for dependency validation`
        );
        continue;
      }

      // Check each dependency
      for (const dependencyId of dependsOnIds) {
        const dependencyWorkOrder = workOrdersMap.get(dependencyId);
        
        if (!dependencyWorkOrder) {
          errors.push(
            `Work order ${workOrder.docId} depends on non-existent work order ${dependencyId}`
          );
          continue;
        }

        const dependencyEndDate = parseDate(dependencyWorkOrder.data.endDate);
        if (!dependencyEndDate) {
          errors.push(
            `Work order ${dependencyId} (dependency of ${workOrder.docId}) has invalid endDate for dependency validation`
          );
          continue;
        }

        // Dependency constraint: dependent work order must start AFTER dependency ends
        // workOrder.startDate >= dependencyWorkOrder.endDate
        if (isAfter(dependencyEndDate, workOrderStartDate)) {
          errors.push(
            `Work order ${workOrder.docId} starts before dependency ${dependencyId} ends (${workOrder.data.startDate} < ${dependencyWorkOrder.data.endDate})`
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Find the next shift on the same day that starts after the current time
   * @param shiftsForDay - All shifts for the current day
   * @param currentTime - Current time
   * @param currentDayStart - Start of the current day
   * @param excludeShift - Optional shift to exclude from the search
   * @returns The start time of the next shift, or null if none found
   */
  private findNextShiftOnSameDay(
    shiftsForDay: WorkCenterShift[],
    currentTime: DateTime,
    currentDayStart: DateTime,
    excludeShift?: WorkCenterShift
  ): DateTime | null {
    let nextShiftStartTime: DateTime | null = null;

    for (const shift of shiftsForDay) {
      if (excludeShift && shift === excludeShift) continue;
      
      const shiftStartTime = currentDayStart.plus({ hours: shift.startHour });
      if (shiftStartTime > currentTime) {
        if (!nextShiftStartTime || shiftStartTime < nextShiftStartTime) {
          nextShiftStartTime = shiftStartTime;
        }
      }
    }

    return nextShiftStartTime;
  }

  /**
   * Move to the next day and find the earliest shift for that day
   * @param currentTime - Current time
   * @param shifts - All shifts
   * @returns The start time of the earliest shift on the next available day, or null if none found
   */
  private moveToNextDayWithShift(
    currentTime: DateTime,
    shifts: WorkCenterShift[]
  ): DateTime | null {
    let nextDay = currentTime.plus({ days: 1 }).startOf('day');
    
    for (let i = 0; i < 7; i++) {
      const nextDayOfWeek = nextDay.weekday;
      const nextDayShifts = shifts.filter(s => s.dayOfWeek === nextDayOfWeek);
      
      if (nextDayShifts.length > 0) {
        // Find the earliest shift for the next day
        const earliestShift = nextDayShifts.reduce((earliest, shift) => {
          return shift.startHour < earliest.startHour ? shift : earliest;
        });
        return nextDay.plus({ hours: earliestShift.startHour });
      }
      
      nextDay = nextDay.plus({ days: 1 });
    }
    
    return null; // No shift found in next 7 days
  }

  /**
   * Find the next available shift, checking same day first, then moving to next day
   * @param shiftsForDay - All shifts for the current day
   * @param currentTime - Current time
   * @param currentDayStart - Start of the current day
   * @param shifts - All shifts (for next day lookup)
   * @param excludeShift - Optional shift to exclude from the search
   * @returns The start time of the next available shift, or null if none found
   */
  private findNextAvailableShift(
    shiftsForDay: WorkCenterShift[],
    currentTime: DateTime,
    currentDayStart: DateTime,
    shifts: WorkCenterShift[],
    excludeShift?: WorkCenterShift
  ): DateTime | null {
    // First, try to find next shift on the same day
    const nextShiftOnSameDay = this.findNextShiftOnSameDay(
      shiftsForDay,
      currentTime,
      currentDayStart,
      excludeShift
    );

    if (nextShiftOnSameDay) {
      return nextShiftOnSameDay;
    }

    // No shift found on same day, move to next day
    return this.moveToNextDayWithShift(currentTime, shifts);
  }

  /**
   * Calculate the expected end date for a work order accounting for shift pauses
   * Work orders pause outside shift hours and resume in the next shift
   * Supports multiple shifts per day
   */
  private calculateEndDateWithShifts(
    startDate: DateTime,
    durationMinutes: number,
    shifts: WorkCenterShift[]
  ): DateTime | null {
    if (shifts.length === 0) {
      // No shifts defined, work happens continuously
      return startDate.plus({ minutes: durationMinutes });
    }

    let currentTime = startDate;
    let remainingWorkMinutes = durationMinutes;
    const maxIterations = 1000; // Safety limit to prevent infinite loops
    let iterations = 0;

    while (remainingWorkMinutes > 0 && iterations < maxIterations) {
      iterations++;

      const currentDayOfWeek = currentTime.weekday; // Luxon: 1 = Monday, 7 = Sunday
      
      // Get all shifts for the current day
      const shiftsForDay = shifts.filter(s => s.dayOfWeek === currentDayOfWeek);
      
      if (shiftsForDay.length === 0) {
        // No shifts for this day, move to next day at 00:00
        currentTime = currentTime.plus({ days: 1 }).startOf('day');
        continue;
      }

      // Find the active shift that contains currentTime
      // A shift contains currentTime if:
      // - Normal shift: startHour <= currentHour < endHour
      // - Shift spanning midnight: startHour <= currentHour OR currentHour < endHour
      let activeShift: WorkCenterShift | null = null;
      const currentDayStart = currentTime.startOf('day');

      for (const shift of shiftsForDay) {
        const shiftStart = shift.startHour;
        const shiftEnd = shift.endHour;
        const shiftStartTime = currentDayStart.plus({ hours: shiftStart });
        
        let shiftEndTime: DateTime;
        let isSpanningMidnight = false;
        
        if (shiftEnd < shiftStart) {
          // Shift spans midnight (e.g., 22-6)
          shiftEndTime = currentDayStart.plus({ days: 1 }).plus({ hours: shiftEnd });
          isSpanningMidnight = true;
        } else {
          shiftEndTime = currentDayStart.plus({ hours: shiftEnd });
        }

        // Check if currentTime is within this shift
        if (isSpanningMidnight) {
          if (currentTime >= shiftStartTime || currentTime < shiftEndTime) {
            activeShift = shift;
            break;
          }
        } else {
          if (currentTime >= shiftStartTime && currentTime < shiftEndTime) {
            activeShift = shift;
            break;
          }
        }
      }

      // If no active shift found, find the next available shift
      if (!activeShift) {
        const nextShiftStartTime = this.findNextAvailableShift(
          shiftsForDay,
          currentTime,
          currentDayStart,
          shifts
        );

        if (!nextShiftStartTime) {
          return null; // No shift found in next 7 days
        }

        currentTime = nextShiftStartTime;
        continue;
      }

      // Calculate shift end time
      const shiftStartTime = currentDayStart.plus({ hours: activeShift.startHour });
      let shiftEndTime: DateTime;
      if (activeShift.endHour < activeShift.startHour) {
        // Shift spans midnight
        shiftEndTime = currentDayStart.plus({ days: 1 }).plus({ hours: activeShift.endHour });
      } else {
        shiftEndTime = currentDayStart.plus({ hours: activeShift.endHour });
      }

      // Calculate how much work can be done in current shift
      const timeUntilShiftEnd = shiftEndTime.diff(currentTime, 'minutes').minutes;
      const workDoneThisShift = Math.min(remainingWorkMinutes, timeUntilShiftEnd);
      
      remainingWorkMinutes -= workDoneThisShift;
      currentTime = currentTime.plus({ minutes: workDoneThisShift });

      // If work is done, we're finished
      if (remainingWorkMinutes <= 0) {
        break;
      }

      // Otherwise, move to next shift
      const nextShiftStartTime = this.findNextAvailableShift(
        shiftsForDay,
        currentTime,
        currentDayStart,
        shifts,
        activeShift
      );

      if (!nextShiftStartTime) {
        return null; // No shift found in next 7 days
      }

      currentTime = nextShiftStartTime;
    }

    if (iterations >= maxIterations) {
      return null; // Unable to calculate (infinite loop prevented)
    }

    return currentTime;
  }

  /**
   * Calculate the expected end date for a work order accounting for maintenance window pauses
   * Regular work orders (isMaintenance: false) pause during maintenance windows and resume after
   * Maintenance work orders (isMaintenance: true) are not affected by maintenance windows
   */
  private calculateEndDateWithMaintenanceWindows(
    startDate: DateTime,
    durationMinutes: number,
    maintenanceWindows: MaintenanceWindow[]
  ): DateTime {
    if (maintenanceWindows.length === 0) {
      // No maintenance windows, work happens continuously
      return startDate.plus({ minutes: durationMinutes });
    }

    // Parse and sort maintenance windows by start date
    const parsedWindows: Array<{ start: DateTime; end: DateTime }> = [];
    for (const window of maintenanceWindows) {
      const windowStart = parseDate(window.startDate);
      const windowEnd = parseDate(window.endDate);
      if (windowStart && windowEnd && windowStart < windowEnd) {
        parsedWindows.push({ start: windowStart, end: windowEnd });
      }
    }

    // Sort by start date
    parsedWindows.sort((a, b) => a.start.toMillis() - b.start.toMillis());

    let currentTime = startDate;
    let remainingWorkMinutes = durationMinutes;
    const maxIterations = 1000; // Safety limit to prevent infinite loops
    let iterations = 0;

    while (remainingWorkMinutes > 0 && iterations < maxIterations) {
      iterations++;

      // Check if current time is within a maintenance window
      let activeMaintenanceWindow: { start: DateTime; end: DateTime } | null = null;
      for (const window of parsedWindows) {
        if (currentTime >= window.start && currentTime < window.end) {
          activeMaintenanceWindow = window;
          break;
        }
      }

      // If we're in a maintenance window, skip to the end of it
      if (activeMaintenanceWindow) {
        currentTime = activeMaintenanceWindow.end;
        continue;
      }

      // Find the next maintenance window that starts after current time
      let nextMaintenanceWindow: { start: DateTime; end: DateTime } | null = null;
      for (const window of parsedWindows) {
        if (window.start > currentTime) {
          nextMaintenanceWindow = window;
          break;
        }
      }

      // If there's a maintenance window coming up
      if (nextMaintenanceWindow) {
        // Calculate how much work can be done before the maintenance window starts
        const timeUntilMaintenance = nextMaintenanceWindow.start.diff(currentTime, 'minutes').minutes;
        
        if (timeUntilMaintenance <= 0) {
          // Should not happen, but handle edge case
          currentTime = nextMaintenanceWindow.end;
          continue;
        }

        const workDoneBeforeMaintenance = Math.min(remainingWorkMinutes, timeUntilMaintenance);
        remainingWorkMinutes -= workDoneBeforeMaintenance;
        currentTime = currentTime.plus({ minutes: workDoneBeforeMaintenance });

        // If work is done, we're finished
        if (remainingWorkMinutes <= 0) {
          break;
        }

        // Otherwise, pause during maintenance and resume after
        currentTime = nextMaintenanceWindow.end;
      } else {
        // No more maintenance windows, finish the remaining work
        currentTime = currentTime.plus({ minutes: remainingWorkMinutes });
        remainingWorkMinutes = 0;
      }
    }

    if (iterations >= maxIterations) {
      return startDate.plus({ minutes: durationMinutes }); // Fallback
    }

    return currentTime;
  }

  /**
   * Calculate the expected end date for a work order accounting for both shift pauses and maintenance windows
   * Work orders pause for BOTH shift boundaries AND maintenance windows
   * Priority: Check for maintenance windows first (absolute dates), then shifts
   */
  private calculateEndDateWithShiftsAndMaintenanceWindows(
    startDate: DateTime,
    durationMinutes: number,
    shifts: WorkCenterShift[],
    maintenanceWindows: MaintenanceWindow[]
  ): DateTime | null {
    // Parse and sort maintenance windows by start date
    const parsedWindows: Array<{ start: DateTime; end: DateTime }> = [];
    for (const window of maintenanceWindows) {
      const windowStart = parseDate(window.startDate);
      const windowEnd = parseDate(window.endDate);
      if (windowStart && windowEnd && windowStart < windowEnd) {
        parsedWindows.push({ start: windowStart, end: windowEnd });
      }
    }
    parsedWindows.sort((a, b) => a.start.toMillis() - b.start.toMillis());

    // If no shifts and no maintenance windows, work happens continuously
    if (shifts.length === 0 && parsedWindows.length === 0) {
      return startDate.plus({ minutes: durationMinutes });
    }

    let currentTime = startDate;
    let remainingWorkMinutes = durationMinutes;
    const maxIterations = 1000;
    let iterations = 0;

    while (remainingWorkMinutes > 0 && iterations < maxIterations) {
      iterations++;

      // First, check if current time is within a maintenance window
      let activeMaintenanceWindow: { start: DateTime; end: DateTime } | null = null;
      for (const window of parsedWindows) {
        if (currentTime >= window.start && currentTime < window.end) {
          activeMaintenanceWindow = window;
          break;
        }
      }

      // If we're in a maintenance window, skip to the end of it
      if (activeMaintenanceWindow) {
        currentTime = activeMaintenanceWindow.end;
        continue;
      }

      // If no shifts, check for next maintenance window
      if (shifts.length === 0) {
        const nextMaintenanceWindow = parsedWindows.find(w => w.start > currentTime);
        if (nextMaintenanceWindow) {
          const timeUntilMaintenance = nextMaintenanceWindow.start.diff(currentTime, 'minutes').minutes;
          if (timeUntilMaintenance > 0) {
            const workDoneBeforeMaintenance = Math.min(remainingWorkMinutes, timeUntilMaintenance);
            remainingWorkMinutes -= workDoneBeforeMaintenance;
            currentTime = currentTime.plus({ minutes: workDoneBeforeMaintenance });
            if (remainingWorkMinutes <= 0) {
              break;
            }
          }
          currentTime = nextMaintenanceWindow.end;
        } else {
          // No more maintenance windows, finish remaining work
          currentTime = currentTime.plus({ minutes: remainingWorkMinutes });
          remainingWorkMinutes = 0;
        }
        continue;
      }

      // Handle shifts (with potential maintenance windows)
      const currentDayOfWeek = currentTime.weekday;
      const shiftsForDay = shifts.filter(s => s.dayOfWeek === currentDayOfWeek);

      if (shiftsForDay.length === 0) {
        // No shifts for this day, check if we can move to next day or hit maintenance window
        const nextDay = currentTime.plus({ days: 1 }).startOf('day');
        const nextMaintenanceWindow = parsedWindows.find(w => w.start > currentTime && w.start < nextDay);
        if (nextMaintenanceWindow) {
          currentTime = nextMaintenanceWindow.end;
        } else {
          currentTime = nextDay;
        }
        continue;
      }

      // Find active shift
      let activeShift: WorkCenterShift | null = null;
      const currentDayStart = currentTime.startOf('day');

      for (const shift of shiftsForDay) {
        const shiftStartTime = currentDayStart.plus({ hours: shift.startHour });
        let shiftEndTime: DateTime;
        let isSpanningMidnight = false;

        if (shift.endHour < shift.startHour) {
          shiftEndTime = currentDayStart.plus({ days: 1 }).plus({ hours: shift.endHour });
          isSpanningMidnight = true;
        } else {
          shiftEndTime = currentDayStart.plus({ hours: shift.endHour });
        }

        if (isSpanningMidnight) {
          if (currentTime >= shiftStartTime || currentTime < shiftEndTime) {
            activeShift = shift;
            break;
          }
        } else {
          if (currentTime >= shiftStartTime && currentTime < shiftEndTime) {
            activeShift = shift;
            break;
          }
        }
      }

      if (!activeShift) {
        // No active shift, find next available shift
        const nextShiftStartTime = this.findNextAvailableShift(
          shiftsForDay,
          currentTime,
          currentDayStart,
          shifts
        );

        if (!nextShiftStartTime) {
          return null;
        }

        // Check if there's a maintenance window before the next shift
        const nextMaintenanceWindow = parsedWindows.find(w => w.start > currentTime && w.start < nextShiftStartTime);
        if (nextMaintenanceWindow) {
          currentTime = nextMaintenanceWindow.end;
        } else {
          currentTime = nextShiftStartTime;
        }
        continue;
      }

      // Calculate shift end time
      const shiftStartTime = currentDayStart.plus({ hours: activeShift.startHour });
      let shiftEndTime: DateTime;
      if (activeShift.endHour < activeShift.startHour) {
        shiftEndTime = currentDayStart.plus({ days: 1 }).plus({ hours: activeShift.endHour });
      } else {
        shiftEndTime = currentDayStart.plus({ hours: activeShift.endHour });
      }

      // Find the next maintenance window that might interrupt this shift
      const nextMaintenanceWindow = parsedWindows.find(w => w.start > currentTime && w.start < shiftEndTime);

      // Calculate available time until shift end or maintenance window, whichever comes first
      const effectiveEndTime = nextMaintenanceWindow ? nextMaintenanceWindow.start : shiftEndTime;
      const timeUntilEffectiveEnd = effectiveEndTime.diff(currentTime, 'minutes').minutes;
      const workDoneThisPeriod = Math.min(remainingWorkMinutes, timeUntilEffectiveEnd);

      remainingWorkMinutes -= workDoneThisPeriod;
      currentTime = currentTime.plus({ minutes: workDoneThisPeriod });

      if (remainingWorkMinutes <= 0) {
        break;
      }

      // If we hit a maintenance window, skip to its end
      if (nextMaintenanceWindow && currentTime >= nextMaintenanceWindow.start) {
        currentTime = nextMaintenanceWindow.end;
        continue;
      }

      // Otherwise, move to next shift
      const nextShiftStartTime = this.findNextAvailableShift(
        shiftsForDay,
        currentTime,
        currentDayStart,
        shifts,
        activeShift
      );

      if (!nextShiftStartTime) {
        return null;
      }

      // Check if there's a maintenance window before the next shift
      const maintenanceBeforeNextShift = parsedWindows.find(w => w.start > currentTime && w.start < nextShiftStartTime);
      if (maintenanceBeforeNextShift) {
        currentTime = maintenanceBeforeNextShift.end;
      } else {
        currentTime = nextShiftStartTime;
      }
    }

    if (iterations >= maxIterations) {
      return null;
    }

    return currentTime;
  }

  validateWorkOrdersRespectMaintenanceWindows(
    workOrders: WorkOrderDocument[],
    workCenters: WorkCenterDocument[]
  ): ValidationResult {
    const errors: string[] = [];

    const workCentersMap = new Map(
      workCenters.map(wc => [wc.docId, wc])
    );

    for (const workOrder of workOrders) {
      // Maintenance work orders (isMaintenance: true) are fixed and not affected by maintenance windows
      if (workOrder.data.isMaintenance) {
        continue;
      }

      const workCenter = workCentersMap.get(workOrder.data.workCenterId);
      if (!workCenter) {
        continue; // Already handled by validateWorkCenterAvailability
      }

      const shifts = workCenter.data.shifts || [];
      const maintenanceWindows = workCenter.data.maintenanceWindows || [];
      
      // If shifts also exist, skip maintenance window validation (already handled by shift validation)
      if (shifts.length > 0) {
        continue;
      }
      
      if (maintenanceWindows.length === 0) {
        continue; // No maintenance windows defined, no validation needed
      }

      const startDate = parseDate(workOrder.data.startDate);
      const endDate = parseDate(workOrder.data.endDate);
      const durationMinutes = workOrder.data.durationMinutes;

      if (!startDate || !endDate) {
        errors.push(
          `Work order ${workOrder.docId} has invalid dates for maintenance window validation`
        );
        continue;
      }

      // Calculate what the end date should be accounting for maintenance windows only
      const expectedEndDate = this.calculateEndDateWithMaintenanceWindows(
        startDate,
        durationMinutes,
        maintenanceWindows
      );

      // Verify the end date matches expected end date (within 1 minute tolerance for rounding)
      const timeDifference = Math.abs(endDate.diff(expectedEndDate, 'minutes').minutes);
      if (timeDifference > 1) {
        const expectedEndISO = expectedEndDate.toISO();
        errors.push(
          `Work order ${workOrder.docId} end date ${workOrder.data.endDate} does not match expected end date accounting for maintenance windows${expectedEndISO ? ` (expected: ${expectedEndISO})` : ''}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  validateWorkOrdersRespectShifts(
    workOrders: WorkOrderDocument[],
    workCenters: WorkCenterDocument[]
  ): ValidationResult {
    const errors: string[] = [];

    const workCentersMap = new Map(
      workCenters.map(wc => [wc.docId, wc])
    );

    for (const workOrder of workOrders) {
      // Skip maintenance work orders - they are fixed and not validated against shifts/maintenance windows
      if (workOrder.data.isMaintenance) {
        continue;
      }

      const workCenter = workCentersMap.get(workOrder.data.workCenterId);
      if (!workCenter) {
        continue; // Already handled by validateWorkCenterAvailability
      }

      const shifts = workCenter.data.shifts || [];
      const maintenanceWindows = workCenter.data.maintenanceWindows || [];
      
      if (shifts.length === 0 && maintenanceWindows.length === 0) {
        continue; // No shifts or maintenance windows defined, no validation needed
      }

      const startDate = parseDate(workOrder.data.startDate);
      const endDate = parseDate(workOrder.data.endDate);
      const durationMinutes = workOrder.data.durationMinutes;

      if (!startDate || !endDate) {
        errors.push(
          `Work order ${workOrder.docId} has invalid dates for shift validation`
        );
        continue;
      }

      // If both shifts and maintenance windows exist, use combined calculation
      // Otherwise use the appropriate single calculation
      let expectedEndDate: DateTime | null;
      if (shifts.length > 0 && maintenanceWindows.length > 0) {
        expectedEndDate = this.calculateEndDateWithShiftsAndMaintenanceWindows(
          startDate,
          durationMinutes,
          shifts,
          maintenanceWindows
        );
      } else if (shifts.length > 0) {
        expectedEndDate = this.calculateEndDateWithShifts(startDate, durationMinutes, shifts);
      } else {
        // Only maintenance windows
        expectedEndDate = this.calculateEndDateWithMaintenanceWindows(startDate, durationMinutes, maintenanceWindows);
      }

      if (!expectedEndDate) {
        errors.push(
          `Work order ${workOrder.docId} could not be scheduled within available shifts/maintenance windows (duration: ${durationMinutes} minutes)`
        );
        continue;
      }

      // Verify the end date matches expected end date (within 1 minute tolerance for rounding)
      const timeDifference = Math.abs(endDate.diff(expectedEndDate, 'minutes').minutes);
      if (timeDifference > 1) {
        const expectedEndISO = expectedEndDate.toISO();
        errors.push(
          `Work order ${workOrder.docId} end date ${workOrder.data.endDate} does not match expected end date accounting for shifts${expectedEndISO ? ` (expected: ${expectedEndISO})` : ''}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  validateAllConstraints(
    workOrders: WorkOrderDocument[],
    workCenters: WorkCenterDocument[],
    manufacturingOrders: ManufacturingOrderDocument[]
  ): ValidationResult {
    const allErrors: string[] = [];

    const result1 = this.validateAllWorkOrdersHaveValidDates(workOrders);
    allErrors.push(...result1.errors);

    const result2 = this.validateAllWorkOrdersCompleteBeforeDueDate(
      workOrders,
      manufacturingOrders
    );
    allErrors.push(...result2.errors);

    const result3 = this.validateNoWorkOrderOverlaps(workOrders);
    allErrors.push(...result3.errors);

    const result4 = this.validateWorkCenterAvailability(workOrders, workCenters);
    allErrors.push(...result4.errors);

    const result5 = this.validateDependenciesRespected(workOrders);
    allErrors.push(...result5.errors);

    const result6 = this.validateWorkOrdersRespectShifts(workOrders, workCenters);
    allErrors.push(...result6.errors);

    const result7 = this.validateWorkOrdersRespectMaintenanceWindows(workOrders, workCenters);
    allErrors.push(...result7.errors);

    return {
      valid: allErrors.length === 0,
      errors: allErrors
    };
  }
}
