import {
  WorkOrderDocument,
  WorkCenterDocument,
  ManufacturingOrderDocument,
  WorkCenterShift
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

  validateWorkOrdersRespectShifts(
    workOrders: WorkOrderDocument[],
    workCenters: WorkCenterDocument[]
  ): ValidationResult {
    const errors: string[] = [];

    const workCentersMap = new Map(
      workCenters.map(wc => [wc.docId, wc])
    );

    for (const workOrder of workOrders) {
      const workCenter = workCentersMap.get(workOrder.data.workCenterId);
      if (!workCenter) {
        continue; // Already handled by validateWorkCenterAvailability
      }

      const shifts = workCenter.data.shifts || [];
      if (shifts.length === 0) {
        continue; // No shifts defined, no validation needed
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

      // Calculate what the end date should be accounting for shifts
      const expectedEndDate = this.calculateEndDateWithShifts(startDate, durationMinutes, shifts);

      if (!expectedEndDate) {
        errors.push(
          `Work order ${workOrder.docId} could not be scheduled within available shifts (duration: ${durationMinutes} minutes)`
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

    return {
      valid: allErrors.length === 0,
      errors: allErrors
    };
  }
}
