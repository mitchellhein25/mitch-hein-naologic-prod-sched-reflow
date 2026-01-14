import { 
  ManufacturingOrderDocument, 
  ReflowResult, 
  WorkCenterDocument, 
  WorkOrderDocument,
  WorkOrderChange,
  WorkCenterShift,
  MaintenanceWindow
} from "./types";
import { parseDate, isAfter, isEqual } from "../utils/date-utils";
import { DateTime } from "luxon";
import { ConstraintChecker } from "./constraint-checker";

export class ReflowService {
  private constraintChecker = new ConstraintChecker();
  /**
   * 
   * @upgrade
   * - Consider extracting phase execution into a strategy pattern or pipeline for better testability
   * - Add validation for input data (null checks, empty arrays, invalid dates) before processing
   * - Consider parallel processing for independent work centers to improve performance
   * - Add metrics/logging for each phase execution time for performance monitoring
   * - Consider making the phase order configurable for different scheduling strategies
   * - Add early exit conditions if no work orders need processing
   */
  public reflow(
    workOrders: WorkOrderDocument[], 
    workCenters: WorkCenterDocument[],
    manufacturingOrders: ManufacturingOrderDocument[],
  ): ReflowResult {
    // Create a deep copy of work orders to avoid mutating the input
    const updatedWorkOrders = workOrders.map(wo => ({
      ...wo,
      data: { ...wo.data }
    }));

    // Track original dates for change detection
    const originalDates = new Map<string, { startDate: string; endDate: string }>();
    updatedWorkOrders.forEach(wo => {
      originalDates.set(wo.docId, {
        startDate: wo.data.startDate,
        endDate: wo.data.endDate
      });
    });

    // Build manufacturing orders lookup map
    const manufacturingOrdersMap = new Map<string, ManufacturingOrderDocument>();
    manufacturingOrders.forEach(mo => {
      manufacturingOrdersMap.set(mo.docId, mo);
    });

    // Build work centers lookup map
    const workCentersMap = new Map<string, WorkCenterDocument>();
    workCenters.forEach(wc => {
      workCentersMap.set(wc.docId, wc);
    });

    this.normalizeEndDatesForShifts(updatedWorkOrders, workCentersMap);

    this.resolveDueDateViolations(updatedWorkOrders, manufacturingOrdersMap, workCentersMap);

    this.resolveDependencies(updatedWorkOrders, workCentersMap);

    this.optimizeDependenciesForDueDates(updatedWorkOrders, manufacturingOrdersMap, originalDates, workCentersMap);

    this.resolveOverlaps(updatedWorkOrders, workCentersMap);

    const impossible = this.checkImpossibility(updatedWorkOrders, workCenters, manufacturingOrders);

    // Track changes
    const changes: WorkOrderChange[] = [];
    updatedWorkOrders.forEach(wo => {
      const original = originalDates.get(wo.docId);
      if (original) {
        const originalStart = parseDate(original.startDate);
        const originalEnd = parseDate(original.endDate);
        const newStart = parseDate(wo.data.startDate);
        const newEnd = parseDate(wo.data.endDate);
        
        // Only record a change if the actual DateTime values differ (not just string format)
        const startChanged = originalStart && newStart && !isEqual(originalStart, newStart);
        const endChanged = originalEnd && newEnd && !isEqual(originalEnd, newEnd);
        
        if (startChanged || endChanged) {
          changes.push({
            workOrderId: wo.docId,
            oldStartDate: original.startDate,
            newStartDate: wo.data.startDate,
            oldEndDate: original.endDate,
            newEndDate: wo.data.endDate
          });
        }
      }
    });

    // Generate explanation
    const explanation = this.generateExplanation(changes.length, updatedWorkOrders.length, impossible);

    return {
      updatedWorkOrders,
      changes,
      explanation,
      impossible
    };
  }

  /**
   * @explanation
   * Phase 0 initialization step that ensures all work order end dates accurately reflect their
   * start dates and durations when accounting for shifts and maintenance windows. This is critical
   * because input data might have end dates that don't account for pause/resume behavior. By
   * normalizing first, all subsequent phases work with accurate time calculations. Maintenance
   * work orders are skipped as they're fixed and don't participate in rescheduling.
   * 
   * @upgrade
   * - Consider parallel processing for independent work orders
   * - Add early exit if no shifts/maintenance windows exist (skip expensive calculation)
   * - Cache work center lookups to avoid repeated map access
   * - Add metrics on how many end dates actually changed during normalization
   */
  private normalizeEndDatesForShifts(
    workOrders: WorkOrderDocument[],
    workCentersMap: Map<string, WorkCenterDocument>
  ): void {
    for (const workOrder of workOrders) {
      // Skip maintenance work orders - they remain unchanged
      if (workOrder.data.isMaintenance) {
        continue;
      }

      const workCenter = this.findWorkCenter(workOrder, workCentersMap);
      const shifts = workCenter?.data.shifts || [];
      const maintenanceWindows = workCenter?.data.maintenanceWindows || [];
      
      const startDate = parseDate(workOrder.data.startDate);
      if (!startDate) {
        continue; // Skip invalid dates
      }

      const durationMinutes = workOrder.data.durationMinutes;
      const calculatedEndDate = this.calculateEndDateWithShiftsAndMaintenanceWindows(
        startDate,
        durationMinutes,
        shifts,
        maintenanceWindows
      );
      if (calculatedEndDate) {
        const newEndISO = calculatedEndDate.toISO();
        if (newEndISO) {
          workOrder.data.endDate = newEndISO;
        }
      }
    }
  }

  /**
   * @explanation
   * Phase 1 handles the highest-priority constraint: manufacturing order due dates. Work orders
   * that would complete after their due date are moved earlier. The method calculates a target
   * start date by subtracting duration from the due date, then recalculates the end date accounting
   * for shifts/maintenance to ensure accuracy. If a work order still violates its due date after
   * rescheduling, it's marked as impossible in a later phase.
   * 
   * @upgrade
   * - Consider sorting work orders by due date urgency for more efficient processing
   * - Add support for partial moves (move as early as possible even if still violates)
   * - Consider moving work orders to different work centers if available
   * - Add validation that due dates are reasonable (not in past, etc.)
   * - Consider batch processing work orders with same manufacturing order
   * - Add metrics on how many work orders were moved and by how much
   * - Early return if impossible
   */
  private resolveDueDateViolations(
    workOrders: WorkOrderDocument[],
    manufacturingOrdersMap: Map<string, ManufacturingOrderDocument>,
    workCentersMap: Map<string, WorkCenterDocument>
  ): void {
    for (const workOrder of workOrders) {
      // Skip maintenance work orders - they are not moved
      if (workOrder.data.isMaintenance) {
        continue;
      }

      const manufacturingOrder = this.findManufacturingOrder(workOrder, manufacturingOrdersMap);
      if (!manufacturingOrder) {
        continue; // Skip if manufacturing order not found
      }

      const workCenter = this.findWorkCenter(workOrder, workCentersMap);
      const shifts = workCenter?.data.shifts || [];
      const maintenanceWindows = workCenter?.data.maintenanceWindows || [];

      const dueDateStr = manufacturingOrder.data.dueDate;
      const dueDate = parseDate(dueDateStr);
      const endDate = parseDate(workOrder.data.endDate);

      if (!dueDate || !endDate) {
        continue; // Skip invalid dates
      }

      // Check if work order violates due date constraint
      if (isAfter(endDate, dueDate)) {
        // Calculate new end date (at or before due date)
        const maxEndDate = dueDate;

        // Calculate new start date based on duration (simple calculation for reverse)
        const durationMinutes = workOrder.data.durationMinutes;
        const newStartDate = maxEndDate.minus({ minutes: durationMinutes });

        // Recalculate end date accounting for shifts and maintenance windows
        const calculatedEndDate = this.calculateEndDateWithShiftsAndMaintenanceWindows(
          newStartDate,
          durationMinutes,
          shifts,
          maintenanceWindows
        );
        if (calculatedEndDate) {
          const newStartISO = newStartDate.toISO();
          const newEndISO = calculatedEndDate.toISO();
          if (newStartISO && newEndISO) {
            workOrder.data.startDate = newStartISO;
            workOrder.data.endDate = newEndISO;
          }
        }
      }
    }
  }

  /**
   * @explanation
   * Phase 2 ensures that dependent work orders start after all their dependencies complete.
   * This must happen before overlap resolution because dependencies are hard constraints that
   * cannot be violated. The method uses an iterative approach to handle dependency chains
   * (A -> B -> C) where moving C might reveal that B needs to move, which then affects A.
   * It processes until no more changes occur, with a safety limit to prevent infinite loops.
   * Maintenance work orders are treated as fixed blockers.
   * 
   * @upgrade
   * - Use topological sort to process dependencies in optimal order (single pass instead of iteration)
   * - Add cycle detection to identify circular dependencies early
   * - Consider parallel processing for independent dependency chains
   * - Cache dependency end dates to avoid repeated lookups
   * - Add validation that all dependencies exist (data integrity check)
   * - Consider supporting partial dependencies (work can start when X% of dependency is complete)
   * - Add metrics on dependency chain lengths and processing time
   * - Consider early exit if no dependencies exist
   */
  private resolveDependencies(
    workOrders: WorkOrderDocument[],
    workCentersMap: Map<string, WorkCenterDocument>
  ): void {
    // Build a map of work orders by docId for efficient lookup
    const workOrdersMap = new Map<string, WorkOrderDocument>();
    for (const workOrder of workOrders) {
      workOrdersMap.set(workOrder.docId, workOrder);
    }

    // Process work orders multiple times until no changes (handles chains like A -> B -> C)
    let changed = true;
    let iterations = 0;
    const maxIterations = workOrders.length; // Safety limit to prevent infinite loops

    while (changed && iterations < maxIterations) {
      changed = false;
      iterations++;

      for (const workOrder of workOrders) {
        // Skip maintenance work orders - they are not moved
        if (workOrder.data.isMaintenance) {
          continue;
        }

        const dependsOnIds = workOrder.data.dependsOnWorkOrderIds || [];

        if (dependsOnIds.length === 0) {
          continue; // No dependencies to check
        }

        const startDate = parseDate(workOrder.data.startDate);
        const durationMinutes = workOrder.data.durationMinutes;

        if (!startDate) {
          continue; // Skip invalid dates
        }

        // Find the latest end date among all dependencies
        let latestDependencyEnd: DateTime | null = null;
        for (const dependencyId of dependsOnIds) {
          const dependencyWorkOrder = workOrdersMap.get(dependencyId);
          if (!dependencyWorkOrder) {
            continue; // Skip if dependency not found
          }

          const dependencyEndDate = parseDate(dependencyWorkOrder.data.endDate);
          if (!dependencyEndDate) {
            continue; // Skip invalid dates
          }

          if (!latestDependencyEnd || dependencyEndDate > latestDependencyEnd) {
            latestDependencyEnd = dependencyEndDate;
          }
        }

        // If we found dependencies, check if work order needs to be moved
        if (latestDependencyEnd && startDate < latestDependencyEnd) {
          // Move work order to start after all dependencies end
          const workCenter = this.findWorkCenter(workOrder, workCentersMap);
          const shifts = workCenter?.data.shifts || [];
          const maintenanceWindows = workCenter?.data.maintenanceWindows || [];
          const newStartISO = latestDependencyEnd.toISO();
          if (newStartISO) {
            workOrder.data.startDate = newStartISO;
            const newEndDate = this.calculateEndDateWithShiftsAndMaintenanceWindows(
              latestDependencyEnd,
              durationMinutes,
              shifts,
              maintenanceWindows
            );
            if (newEndDate) {
              const newEndISO = newEndDate.toISO();
              if (newEndISO) {
                workOrder.data.endDate = newEndISO;
              }
            }
            changed = true;
          }
        }
      }
    }
  }

  /**
   * @explanation
   * Phase 2.5 is an optimization pass that moves dependencies earlier to help dependent work
   * orders meet their due dates. This is more sophisticated than Phase 1 because it considers
   * the relationship between work orders. The method iterates until no more improvements can be
   * made, handling cascading effects. It identifies the "limiting dependency" (the one ending
   * latest) and moves it earlier, but respects constraints like the dependency's own due date.
   * Maintenance dependencies are skipped as they're fixed.
   * 
   * @upgrade
   * - Consider using graph algorithms (topological sort, critical path) for better optimization
   * - Add cycle detection to prevent infinite loops in dependency chains
   * - Cache dependency relationships to avoid repeated lookups
   * - Consider moving multiple dependencies simultaneously for better results
   * - Consider partial moves when full moves aren't possible
   * - Add metrics on optimization effectiveness (how many due dates were saved)
   * - Consider making iteration limit configurable or based on problem size
   * - Return early if impossible
   */
  private optimizeDependenciesForDueDates(
    workOrders: WorkOrderDocument[],
    manufacturingOrdersMap: Map<string, ManufacturingOrderDocument>,
    originalDates: Map<string, { startDate: string; endDate: string }>,
    workCentersMap: Map<string, WorkCenterDocument>
  ): void {
    // Build a map of work orders by docId for efficient lookup
    const workOrdersMap = new Map<string, WorkOrderDocument>();
    for (const workOrder of workOrders) {
      workOrdersMap.set(workOrder.docId, workOrder);
    }

    // Iterate until no more improvements can be made
    let changed = true;
    let iterations = 0;
    const maxIterations = workOrders.length; // Safety limit

    while (changed && iterations < maxIterations) {
      changed = false;
      iterations++;

      for (const workOrder of workOrders) {
        // Skip maintenance work orders when optimizing dependencies
        if (workOrder.data.isMaintenance) {
          continue;
        }

        const dependsOnIds = workOrder.data.dependsOnWorkOrderIds || [];
        if (dependsOnIds.length === 0) {
          continue; // No dependencies to optimize
        }

        const manufacturingOrder = this.findManufacturingOrder(workOrder, manufacturingOrdersMap);
        if (!manufacturingOrder) {
          continue;
        }

        const dueDateStr = manufacturingOrder.data.dueDate;
        const dueDate = parseDate(dueDateStr);
        const endDate = parseDate(workOrder.data.endDate);
        const startDate = parseDate(workOrder.data.startDate);
        const durationMinutes = workOrder.data.durationMinutes;

        if (!dueDate || !endDate || !startDate) {
          continue;
        }

        // Check if this dependent work order violates its due date
        if (!isAfter(endDate, dueDate)) {
          continue; // No violation, skip
        }

        // Calculate target start time to meet due date
        const targetStartDate = dueDate.minus({ minutes: durationMinutes });

        // Find the latest dependency end date (skip maintenance dependencies)
        let latestDependencyEnd: DateTime | null = null;
        const dependencyWorkOrders: WorkOrderDocument[] = [];
        for (const dependencyId of dependsOnIds) {
          const dependencyWorkOrder = workOrdersMap.get(dependencyId);
          if (!dependencyWorkOrder) {
            continue;
          }

          // Skip maintenance dependencies - they cannot be moved
          if (dependencyWorkOrder.data.isMaintenance) {
            const dependencyEndDate = parseDate(dependencyWorkOrder.data.endDate);
            if (dependencyEndDate) {
              dependencyWorkOrders.push(dependencyWorkOrder);
              if (!latestDependencyEnd || dependencyEndDate > latestDependencyEnd) {
                latestDependencyEnd = dependencyEndDate;
              }
            }
            continue;
          }

          dependencyWorkOrders.push(dependencyWorkOrder);

          const dependencyEndDate = parseDate(dependencyWorkOrder.data.endDate);
          if (!dependencyEndDate) {
            continue;
          }

          if (!latestDependencyEnd || dependencyEndDate > latestDependencyEnd) {
            latestDependencyEnd = dependencyEndDate;
          }
        }

        if (!latestDependencyEnd || latestDependencyEnd <= targetStartDate) {
          continue; // Dependencies already end early enough, or impossible to meet target
        }

        // Find the dependency that ends at latestDependencyEnd (the limiting dependency)
        // Skip maintenance dependencies as they cannot be moved
        let limitingDependency: WorkOrderDocument | null = null;
        for (const dependencyWorkOrder of dependencyWorkOrders) {
          if (dependencyWorkOrder.data.isMaintenance) {
            continue; // Skip maintenance dependencies
          }
          const dependencyEndDate = parseDate(dependencyWorkOrder.data.endDate);
          if (dependencyEndDate && dependencyEndDate.equals(latestDependencyEnd)) {
            limitingDependency = dependencyWorkOrder;
            break;
          }
        }

        if (!limitingDependency) {
          continue; // Limiting dependency is a maintenance work order, cannot be moved
        }

        const dependencyManufacturingOrder = this.findManufacturingOrder(limitingDependency, manufacturingOrdersMap);
        if (!dependencyManufacturingOrder) {
          continue;
        }

        const dependencyDueDateStr = dependencyManufacturingOrder.data.dueDate;
        const dependencyDueDate = parseDate(dependencyDueDateStr);
        const dependencyEndDate = parseDate(limitingDependency.data.endDate);
        const dependencyDuration = limitingDependency.data.durationMinutes;
        if (!dependencyDueDate || !dependencyEndDate) {
          continue;
        }

        // Calculate new end date (move earlier to target start date, but not earlier than dependency's due date)
        let newDependencyEndDate = targetStartDate;
        if (isAfter(newDependencyEndDate, dependencyDueDate)) {
          // Can't end after due date, use due date as maximum end
          newDependencyEndDate = dependencyDueDate;
        }

        // Calculate new start date
        const newDependencyStartDate = newDependencyEndDate.minus({ minutes: dependencyDuration });

        // Check if the new end date would actually help (must be earlier than current dependency end)
        if (newDependencyEndDate >= dependencyEndDate) {
          continue; // Not helpful, skip
        }

        // Move the dependency earlier
        const dependencyWorkCenter = this.findWorkCenter(limitingDependency, workCentersMap);
        const dependencyShifts = dependencyWorkCenter?.data.shifts || [];
        const dependencyMaintenanceWindows = dependencyWorkCenter?.data.maintenanceWindows || [];
        const newStartISO = newDependencyStartDate.toISO();
        const calculatedEndDate = this.calculateEndDateWithShiftsAndMaintenanceWindows(
          newDependencyStartDate,
          dependencyDuration,
          dependencyShifts,
          dependencyMaintenanceWindows
        );
        const newEndISO = calculatedEndDate?.toISO();
        if (newStartISO && newEndISO) {
          limitingDependency.data.startDate = newStartISO;
          limitingDependency.data.endDate = newEndISO;
          
          // Update the dependent work order to start after the dependency ends
          // Use the dependency's actual recalculated end (calculatedEndDate) instead of newDependencyEndDate
          const workCenter = this.findWorkCenter(workOrder, workCentersMap);
          const shifts = workCenter?.data.shifts || [];
          const maintenanceWindows = workCenter?.data.maintenanceWindows || [];
          const newDependentStartISO = calculatedEndDate?.toISO();
          const newDependentEndDate = this.calculateEndDateWithShiftsAndMaintenanceWindows(
            calculatedEndDate!,
            durationMinutes,
            shifts,
            maintenanceWindows
          );
          const newDependentEndISO = newDependentEndDate?.toISO();
          
          if (newDependentStartISO && newDependentEndISO) {
            workOrder.data.startDate = newDependentStartISO;
            workOrder.data.endDate = newDependentEndISO;
          }
          
          changed = true;
        }
      }
    }
  }

  /**
   * @explanation
   * Phase 3: Resolves resource conflicts where multiple work orders are scheduled at the same work center
   * simultaneously (overlaps). This phase ensures that each work center can only handle one work order at a time,
   * which is a fundamental manufacturing constraint. The algorithm groups work orders by work center, sorts them by
   * start date (earliest first), then packs them sequentially: each work order starts when the previous one ends.
   * 
   * Maintenance work orders act as fixed blockers - they cannot be moved, so regular work orders must be scheduled
   * around them. When an overlap is detected (work order starts before previous ends), the overlapping work order is
   * moved to start immediately after the previous work order completes, and its end date is recalculated accounting
   * for shifts and maintenance windows to ensure accuracy.
   * 
   * This phase runs after due date and dependency resolution, so work orders have already been moved as early as
   * possible while respecting those constraints. Overlap resolution only moves work orders later in time, which may
   * reintroduce due date violations that were already resolved - these are detected in the final impossibility check.
   *
   * @upgrade
   * Algorithm improvements:
   * - Consider bidirectional packing (pack backwards from due dates when feasible) to better satisfy constraints
   * - Handle partial overlaps more intelligently (could start later work order earlier if it fits in gaps)
   * - Consider work order priority/importance when deciding which to move (currently always moves the later one)
   * 
   * Code structure:
   * - Extract overlap detection logic into helper method (startDate < currentEnd check repeated)
   * - Separate maintenance work order handling into dedicated helper method
   * - Consider creating WorkCenterScheduler class to encapsulate per-center scheduling logic
   */
  private resolveOverlaps(
    workOrders: WorkOrderDocument[],
    workCentersMap: Map<string, WorkCenterDocument>
  ): void {
    // Group work orders by work center
    const workOrdersByCenter = new Map<string, WorkOrderDocument[]>();
    for (const workOrder of workOrders) {
      const centerId = workOrder.data.workCenterId;
      if (!workOrdersByCenter.has(centerId)) {
        workOrdersByCenter.set(centerId, []);
      }
      workOrdersByCenter.get(centerId)!.push(workOrder);
    }

    // Resolve overlaps for each work center
    for (const centerWorkOrders of workOrdersByCenter.values()) {
      // Sort by start date (earliest first)
      centerWorkOrders.sort((a, b) => {
        const startA = parseDate(a.data.startDate);
        const startB = parseDate(b.data.startDate);
        if (!startA || !startB) return 0;
        return startA.toMillis() - startB.toMillis();
      });

      // Pack sequentially: next work order starts when previous ends
      // Maintenance work orders are fixed blockers - regular work orders must work around them
      let currentEnd: DateTime | null = null;
      for (const workOrder of centerWorkOrders) {
        const startDate = parseDate(workOrder.data.startDate);
        const endDate = parseDate(workOrder.data.endDate);
        const durationMinutes = workOrder.data.durationMinutes;

        if (!startDate || !endDate) {
          continue; // Skip invalid dates
        }

        // Maintenance work orders are fixed - they cannot be moved
        if (workOrder.data.isMaintenance) {
          // Update currentEnd to be after this maintenance work order
          // Regular work orders will start after this
          currentEnd = endDate;
          continue;
        }

        if (currentEnd === null) {
          // First regular work order - keep its times, update currentEnd for next iteration
          currentEnd = endDate;
        } else {
          // Check for overlap
          if (startDate < currentEnd) {
            // Overlap detected - move this work order to start after previous ends
            const workCenter = this.findWorkCenter(workOrder, workCentersMap);
            const shifts = workCenter?.data.shifts || [];
            const maintenanceWindows = workCenter?.data.maintenanceWindows || [];
            const newStartISO = currentEnd.toISO();
            if (newStartISO) {
              workOrder.data.startDate = newStartISO;
            }
            const calculatedEndDate = this.calculateEndDateWithShiftsAndMaintenanceWindows(
              currentEnd,
              durationMinutes,
              shifts,
              maintenanceWindows
            );
            if (calculatedEndDate) {
              currentEnd = calculatedEndDate;
              const endISO = calculatedEndDate.toISO();
              if (endISO) {
                workOrder.data.endDate = endISO;
              }
            }
          } else {
            // No overlap - keep original times, update currentEnd for next iteration
            currentEnd = endDate;
          }
        }
      }
    }
  }

  /**
   * @explanation
   * Final validation step that determines if the schedule is impossible (constraints cannot
   * be satisfied). After all rescheduling phases complete, uses ConstraintChecker's comprehensive
   * validation to check all constraints: due dates, overlaps, dependencies, shifts, maintenance
   * windows, and work center availability. If any constraints are still violated after all phases,
   * the schedule is impossible. Work orders can be moved earlier than their original start date
   * if needed to satisfy constraints.
   * 
   * Also checks for fundamental impossibilities like due dates that occur before the original
   * start date, which indicates the schedule was impossible from the beginning (work cannot
   * start in the past to meet a past due date).
   * 
   * @upgrade
   * - Return detailed impossibility reasons (which work orders, which constraints) instead of just boolean
   * - Consider checking for other impossibility scenarios (e.g., dependency cycles, resource conflicts)
   * - Add suggestions for how to make impossible schedules possible (e.g., extend due dates, add resources)
   * - Consider partial feasibility (some work orders possible, others not)
   * - Add metrics on how close to impossible the schedule is (slack time, etc.)
   * - Consider making impossibility checks configurable (strict vs. lenient)
   */
  private checkImpossibility(
    workOrders: WorkOrderDocument[],
    workCenters: WorkCenterDocument[],
    manufacturingOrders: ManufacturingOrderDocument[]
  ): boolean {
    // Use constraint checker to validate all constraints
    const validation = this.constraintChecker.validateAllConstraints(
      workOrders,
      workCenters,
      manufacturingOrders
    );
    
    // If any constraints are violated after all phases, schedule is impossible
    return !validation.valid;
  }

  /**
   * @explanation
   * Simple utility that generates a human-readable explanation of the reflow results. Provides
   * three basic states: impossible schedule, no changes needed, or X of Y work orders rescheduled.
   * This gives users immediate feedback about what happened. The explanation is intentionally
   * concise to keep the result object lightweight, but could be extended with more details.
   * 
   * @upgrade
   * - Include summary statistics (total time saved, average move distance, etc.)
   * - Add information about which constraints were resolved (due dates, dependencies, overlaps)
   * - Consider structured explanation object instead of string for programmatic access
   * - Add warnings for edge cases (e.g., "moved but still close to due date")
   * - Consider internationalization support for multi-language explanations
   * - Add explanation of why schedule is impossible (which constraints conflict)
   */
  private generateExplanation(changeCount: number, totalWorkOrders: number, impossible: boolean): string {
    if (impossible) {
      return "Schedule is impossible: constraints cannot be satisfied even after rescheduling.";
    }

    if (changeCount === 0) {
      return "No changes needed. All work orders already satisfy constraints.";
    }

    return `Rescheduled ${changeCount} of ${totalWorkOrders} work orders to satisfy constraints.`;
  }

  /**
   * @upgrade
   * - Add logging/warning when manufacturing order is not found (could indicate data integrity issue)
   */
  private findManufacturingOrder(
    workOrder: WorkOrderDocument,
    manufacturingOrdersMap: Map<string, ManufacturingOrderDocument>
  ): ManufacturingOrderDocument | null {
    const manufacturingOrderId = workOrder.data.manufacturingOrderId;
    return manufacturingOrdersMap.get(manufacturingOrderId) || null;
  }

  /**
   * @upgrade
   * - Add logging/warning when work center is not found
   */
  private findWorkCenter(
    workOrder: WorkOrderDocument,
    workCentersMap: Map<string, WorkCenterDocument>
  ): WorkCenterDocument | null {
    const workCenterId = workOrder.data.workCenterId;
    return workCentersMap.get(workCenterId) || null;
  }

  /**
   * @explanation
   * Finds the earliest shift on the current day that starts after the given time. This is used
   * when work needs to pause and resume within the same day. The method iterates through all
   * shifts for the day, filters out excluded shifts, and returns the earliest valid shift start time.
   * This supports scenarios where multiple shifts exist per day (e.g., morning and afternoon shifts).
   * 
   * @upgrade
   * - Consider pre-sorting shifts by start hour to avoid full iteration
   * - Add validation that shifts don't overlap (data integrity check)
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
   * @explanation
   * When no shifts are available on the current day, this method searches forward up to 7 days
   * to find the next day with available shifts. It then returns the start time of the earliest
   * shift on that day. The 7-day limit prevents infinite loops while covering a full week cycle.
   * This handles scenarios where work centers have irregular schedules (e.g., only open weekdays).
   * 
   * @upgrade
   * - Make the search limit configurable or based on shift pattern analysis
   * - Cache shift patterns to avoid repeated calculations
   * - Consider returning an error/status instead of null when no shifts found
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
        const earliestShift = nextDayShifts.reduce((earliest, shift) => {
          return shift.startHour < earliest.startHour ? shift : earliest;
        });
        return nextDay.plus({ hours: earliestShift.startHour });
      }
      
      nextDay = nextDay.plus({ days: 1 });
    }
    
    return null;
  }

  /**
   * @explanation
   * High-level helper that coordinates finding the next available shift by first checking the
   * same day (more efficient), then falling back to searching future days.
   * 
   * @upgrade
   * - Consider caching results for common queries (same day, same time patterns)
   * - Add early exit if no shifts exist at all (avoid unnecessary iteration)
   * - Consider returning a Shift object instead of just DateTime for more context
   * - Add unit tests for edge cases (no shifts, all shifts excluded, etc.)
   */
  private findNextAvailableShift(
    shiftsForDay: WorkCenterShift[],
    currentTime: DateTime,
    currentDayStart: DateTime,
    shifts: WorkCenterShift[],
    excludeShift?: WorkCenterShift
  ): DateTime | null {
    const nextShiftOnSameDay = this.findNextShiftOnSameDay(
      shiftsForDay,
      currentTime,
      currentDayStart,
      excludeShift
    );

    if (nextShiftOnSameDay) {
      return nextShiftOnSameDay;
    }

    return this.moveToNextDayWithShift(currentTime, shifts);
  }

  /**
   * @explanation
   * Calculates the end date for work that must respect both shift schedules and maintenance windows.
   * Work progresses only during active shift hours and pauses during maintenance windows, handling
   * both constraints simultaneously. The algorithm iterates through time, advancing the current time
   * while tracking remaining work minutes. At each step, it:
   * 1. Checks if currently within a maintenance window (absolute constraint) - if so, skips to window end
   * 2. Finds the active shift for the current time, if any
   * 3. Calculates work done until the next constraint (shift end or maintenance window start, whichever comes first)
   * 4. Handles transitions between shifts, accounting for maintenance windows that may occur between shifts
   * 
   * Maintenance windows take precedence as absolute time blocks that pause work regardless of shifts.
   * The method handles complex scenarios: maintenance windows interrupting active shifts, maintenance
   * windows between shift periods, midnight-spanning shifts, multiple shifts per day, and days with no shifts.
   * Returns null if work cannot be completed (e.g., no available shifts or iteration limit exceeded).
   *
   * @upgrade
   * Performance optimizations:
   * - Cache parsed maintenance windows at a higher level (work center or service level) to avoid
   *   repeated parsing on every method call
   * - Pre-compute merged unavailable time periods (shifts + maintenance) as intervals for O(1) lookups
   * - Extract helper method for "find next maintenance window in range" to reduce code duplication
   * 
   * Code structure improvements:
   * - Extract shift time calculation logic (start/end time, midnight-spanning) into reusable helper method
   * - Separate maintenance window handling into dedicated method for cleaner separation of concerns
   * - Extract maintenance window lookup logic into helper methods (findActiveWindow, findNextWindowInRange)
   * - Consider creating a TimeConstraintResolver class to handle shift+maintenance logic independently
   * 
   * Functionality enhancements:
   * - Support recurring maintenance windows (e.g., "every Monday 2-4pm") in addition to absolute dates
   * - Make maxIterations configurable or calculate based on duration/constraint density
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
}